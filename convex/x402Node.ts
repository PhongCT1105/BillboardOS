"use node";
/**
 * x402 payment endpoints, node half (ADR 0006: one OS server). The HTTP
 * actions in http.ts check the agent key and look up what's being sold, then
 * call these actions, which run the shared flow (lib/x402/flow.ts): challenge
 * or facilitator verify -> re-check -> settle -> record.
 */
import { ConvexError, v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { runPaidFlow, type Charge, type PlainResponse, type Settled } from "./lib/x402/flow";
import { getEngine } from "./lib/x402/cdpEngine";
import { holdLockKey } from "./lib/paymentLock";

const plainRequest = v.object({ method: v.string(), url: v.string(), headers: v.record(v.string(), v.string()) });
const chargeArg = v.object({ amountMinor: v.number(), payTo: v.union(v.string(), v.null()), unpaid: v.any() });
const plainResponse = v.object({ status: v.number(), headers: v.record(v.string(), v.string()), body: v.any() });

const LOCK_TTL_MS = 2 * 60_000;

function logger(traceId: string) {
  return (step: string, data: Record<string, unknown> = {}) => {
    const fields = Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([k, value]) => `${k}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
    console.log(`[x402] trace=${traceId} ${step}${fields ? ` ${fields}` : ""}`);
  };
}

const hasPayment = (headers: Record<string, string>) =>
  Object.keys(headers).some((k) => ["payment-signature", "x-payment"].includes(k.toLowerCase()));

/** Run `fn` holding the lock for `key` when the request carries a payment; else just run it. */
async function withLock(ctx: ActionCtx, key: string, paid: boolean, fn: () => Promise<PlainResponse>): Promise<PlainResponse> {
  if (!paid) return await fn();
  const lockId: Id<"paymentLocks"> | null = await ctx.runMutation(internal.paymentLocks.acquire, { key, ttlMs: LOCK_TTL_MS });
  if (!lockId) return { status: 409, headers: {}, body: { error: "PURCHASE_IN_PROGRESS" } };
  try {
    return await fn();
  } finally {
    await ctx.runMutation(internal.paymentLocks.release, { lockId });
  }
}

async function engineOrError(traceId: string) {
  try {
    return await getEngine();
  } catch (error) {
    logger(traceId)("engine.unavailable", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

const unavailable: PlainResponse = {
  status: 503,
  headers: {},
  body: { error: "PAYMENTS_UNAVAILABLE", message: "x402 payments are not configured on this deployment" },
};

/** Retry a recording mutation: money has already moved, and recording is idempotent on the tx hash. */
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      last = error;
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  throw last;
}

/** POST /purchases/{holdId} and /a2a/hosts/{workspaceId}/purchases/{holdId}: pay a hold. */
export const payHold = internalAction({
  args: { request: plainRequest, holdId: v.id("holds"), traceId: v.string(), charge: chargeArg },
  returns: plainResponse,
  handler: async (ctx, args): Promise<PlainResponse> => {
    const log = logger(args.traceId);
    const handle = await engineOrError(args.traceId);
    if (!handle) return unavailable;
    return await withLock(ctx, holdLockKey(args.holdId), hasPayment(args.request.headers), () =>
      runPaidFlow(handle.engine, {
        request: args.request,
        charge: args.charge as Charge,
        defaultPayTo: handle.defaultPayTo,
        log,
        recheck: async (amountMinor) => {
          const fresh = await ctx.runQuery(internal.holds.getForPayment, { holdId: args.holdId });
          if (!fresh || !fresh.payable || fresh.amountMinor !== amountMinor) {
            return {
              ok: false,
              status: 409,
              body: { error: "HOLD_NOT_PAYABLE", holdId: args.holdId, status: fresh?.status ?? "missing", message: "Hold is no longer payable." },
            };
          }
          return { ok: true };
        },
        record: async (settled: Settled) => {
          const externalRef = settled.transaction || `x402:${settled.payer ?? "unknown"}:${args.holdId}`;
          const outcome = await retry(() =>
            ctx.runMutation(internal.payments.recordVerified, {
              holdId: args.holdId,
              provider: "x402",
              externalRef,
              amountMinor: settled.amountMinor,
              asset: "USDC",
              network: settled.network,
              idempotencyKey: `x402:${externalRef}`,
            }),
          );
          log(`convex.${outcome.outcome}`, outcome);
          const payment = { provider: "x402", ...settled };
          const body = { ...outcome, holdId: args.holdId, traceId: args.traceId, payment };
          // Booked -> 200. Money moved but not booked -> 409 with the finance exception. Rejected -> 500 (operator).
          return { status: outcome.outcome === "booked" ? 200 : outcome.outcome === "exception" ? 409 : 500, body };
        },
      }),
    );
  },
});

const STATUS_FOR_CODE: Record<string, number> = { INVALID_KEY: 401, KEY_REVOKED: 401, KEY_EXPIRED: 401, NOT_FOUND: 404, RATE_LIMITED: 429 };

/** GET /a2a/hosts/{workspaceId}/reports/audience?billboardId=: the seller agent's paid data product. */
export const payReport = internalAction({
  args: {
    request: plainRequest,
    agentKey: v.string(),
    agentKeyId: v.id("agentKeys"),
    workspaceId: v.string(),
    billboardId: v.string(),
    charge: chargeArg,
  },
  returns: plainResponse,
  handler: async (ctx, args): Promise<PlainResponse> => {
    const traceId = `report:${args.workspaceId}:${args.billboardId}`;
    const log = logger(traceId);
    const handle = await engineOrError(traceId);
    if (!handle) return unavailable;
    let report: unknown = null;
    return await withLock(ctx, `report:${args.agentKeyId}:${args.billboardId}`, hasPayment(args.request.headers), () =>
      runPaidFlow(handle.engine, {
        request: args.request,
        charge: args.charge as Charge,
        defaultPayTo: handle.defaultPayTo,
        log,
        // Price unchanged, key still valid, and the report can be produced: only then settle.
        recheck: async (amountMinor) => {
          if (amountMinor !== args.charge.amountMinor) {
            return { ok: false, status: 409, body: { error: "PRICE_CHANGED", message: "The report price changed." } };
          }
          try {
            await ctx.runMutation(internal.a2a.authorizeReport, { token: args.agentKey, workspaceId: args.workspaceId, billboardId: args.billboardId });
            report = await ctx.runQuery(internal.a2a.audienceReport, { workspaceId: args.workspaceId, billboardId: args.billboardId });
          } catch (error) {
            const data = error instanceof ConvexError ? (error.data as { code?: string; message?: string }) : null;
            return {
              ok: false,
              status: data?.code ? (STATUS_FOR_CODE[data.code] ?? 403) : 503,
              body: { error: data?.code ?? "REPORT_UNAVAILABLE", message: data?.message ?? "Report unavailable" },
            };
          }
          return { ok: true };
        },
        record: async (settled: Settled) => {
          const sale = await retry(() =>
            ctx.runMutation(internal.a2a.recordDataSale, {
              token: args.agentKey,
              workspaceId: args.workspaceId,
              billboardId: args.billboardId,
              amountMinor: settled.amountMinor,
              txHash: settled.transaction,
              network: settled.network,
              payer: settled.payer,
            }),
          );
          log("convex.data_sale_recorded", sale);
          return { status: 200, body: { report, dataSaleId: sale.dataSaleId, payment: { provider: "x402", ...settled } } };
        },
      }),
    );
  },
});
