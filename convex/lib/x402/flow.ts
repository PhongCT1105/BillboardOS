"use node";
/**
 * The x402 paid-request flow, framework-agnostic (ADR 0005/0006). Used by the
 * Convex node action that serves the payment endpoints; no Node or Convex
 * imports, so it is testable with a fake facilitator.
 *
 * Order of operations for every paid request:
 *   1. caller already checked the agent key and looked up what is being sold
 *   2. processHTTPRequest -> 402 challenge, or facilitator VERIFY of the signed payload
 *   3. recheck            -> still OK to take this exact amount? else cancel (no money moves)
 *   4. processSettlement  -> facilitator SETTLE onchain; failure = nothing recorded
 *   5. record             -> payment / data sale (idempotent on the tx hash)
 */
import type {
  HTTPAdapter,
  HTTPRequestContext,
  HTTPResponseInstructions,
  RouteConfig,
  x402HTTPResourceServer,
} from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { atomicToCents, centsToUsd, explorerTxUrl } from "./money";

export const ROUTE_PURCHASE = "POST /purchases/:holdId";
export const ROUTE_HOST_PURCHASE = "POST /a2a/hosts/:workspaceId/purchases/:holdId";
export const ROUTE_REPORT = "GET /a2a/hosts/:workspaceId/reports/audience";

/** A request, serializable so an HTTP action can hand it to a node action. */
export type PlainRequest = { method: string; url: string; headers: Record<string, string> };

/** What one paid request costs and who gets paid, decided before the challenge. */
export type Charge = { amountMinor: number; payTo: string | null; unpaid: Record<string, unknown> };

/** Plain response the HTTP action turns into a Response. */
export type PlainResponse = { status: number; headers: Record<string, string>; body: unknown };

export type Settled = {
  transaction: string;
  network: string;
  payer?: string;
  payTo: string;
  asset: string;
  amountAtomic: string;
  amountMinor: number;
  explorer?: string;
};

export type Engine = Pick<x402HTTPResourceServer, "processHTTPRequest" | "processSettlement">;

/** HTTPAdapter over a PlainRequest that also carries the charge for dynamic price / payTo. */
export class ChargeAdapter implements HTTPAdapter {
  private readonly url: URL;
  private readonly lower: Record<string, string>;
  constructor(
    readonly request: PlainRequest,
    readonly charge: Charge,
    readonly defaultPayTo: string,
  ) {
    this.url = new URL(request.url);
    this.lower = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
  }
  getHeader(name: string) {
    return this.lower[name.toLowerCase()];
  }
  getMethod() {
    return this.request.method.toUpperCase();
  }
  getPath() {
    return this.url.pathname;
  }
  getUrl() {
    return this.url.toString();
  }
  getAcceptHeader() {
    return this.lower["accept"] ?? "application/json";
  }
  getUserAgent() {
    return this.lower["user-agent"] ?? "";
  }
  getQueryParams() {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of this.url.searchParams) {
      const prev = out[k];
      out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
    return out;
  }
  getQueryParam(name: string) {
    const all = this.url.searchParams.getAll(name);
    return all.length === 0 ? undefined : all.length === 1 ? all[0] : all;
  }
}

function chargeOf(context: HTTPRequestContext): ChargeAdapter {
  const adapter = context.adapter;
  if (!(adapter instanceof ChargeAdapter)) throw new Error("paid route invoked without a charge");
  return adapter;
}

function paidRoute(network: `${string}:${string}`, description: string, bazaar: Record<string, unknown>, tags: string[]): RouteConfig {
  return {
    accepts: {
      scheme: "exact",
      network,
      // Per request: the host workspace's payout address (customer agents pay the host), else the default.
      payTo: (context: HTTPRequestContext) => {
        const a = chargeOf(context);
        return a.charge.payTo ?? a.defaultPayTo;
      },
      // Per request price in USD cents -> "$12.34" (string math, no floats).
      price: (context: HTTPRequestContext) => centsToUsd(chargeOf(context).charge.amountMinor),
      maxTimeoutSeconds: 300,
    },
    description,
    mimeType: "application/json",
    serviceName: "BillboardOS",
    tags,
    unpaidResponseBody: (context: HTTPRequestContext) => ({ contentType: "application/json", body: chargeOf(context).charge.unpaid }),
    extensions: bazaar,
  };
}

/** The three paid routes with Bazaar discovery metadata. */
export function paidRoutes(network: `${string}:${string}`): Record<string, RouteConfig> {
  return {
    [ROUTE_PURCHASE]: paidRoute(
      network,
      "Exclusive BillboardOS airtime hold: pay the quoted amount to confirm the booking",
      declareDiscoveryExtension({
        bodyType: "json",
        input: {},
        pathParams: { holdId: "hold id from an agreed negotiation or POST /api/agent/holds" },
        output: { example: { outcome: "booked", holdId: "…", bookingId: "…", payment: { transaction: "0x…" } } },
      }),
      ["advertising", "billboard", "dooh"],
    ),
    [ROUTE_HOST_PURCHASE]: paidRoute(
      network,
      "Pay a host's seller agent for an agreed airtime hold (BillboardOS)",
      declareDiscoveryExtension({
        bodyType: "json",
        input: {},
        pathParams: { workspaceId: "host workspace id", holdId: "hold id from the agreement" },
        output: { example: { outcome: "booked", holdId: "…", bookingId: "…" } },
      }),
      ["advertising", "billboard", "agent-to-agent"],
    ),
    [ROUTE_REPORT]: paidRoute(
      network,
      "Audience report for one screen: trailing 2h crowd, peak in view, audience mix, upcoming events, recent clearing prices (aggregate only, no personal data)",
      declareDiscoveryExtension({
        input: { billboardId: "screen id from the host's agent.json" },
        inputSchema: { properties: { billboardId: { type: "string" } }, required: ["billboardId"] },
        pathParams: { workspaceId: "host workspace id" },
        output: {
          example: {
            billboard: { name: "Moscone West Screen" },
            crowd: { averagePer15Min: 140, peakInView: 22 },
            upcomingEvents: [],
            recentClearingPrices: [],
          },
        },
      }),
      ["data", "audience", "advertising", "agent-to-agent"],
    ),
  };
}

function fromInstructions(r: HTTPResponseInstructions): PlainResponse {
  return { status: r.status, headers: { ...r.headers }, body: r.body ?? {} };
}

export type Recheck = (amountMinor: number) => Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }>;
export type Record_ = (settled: Settled) => Promise<{ status: number; body: unknown }>;

export type FlowLog = (step: string, data?: Record<string, unknown>) => void;

/**
 * Challenge or verify, re-check, settle, record. Nothing is recorded unless
 * settlement succeeded; a failed re-check cancels the verified payment.
 */
export async function runPaidFlow(
  engine: Engine,
  opts: {
    request: PlainRequest;
    charge: Charge;
    defaultPayTo: string;
    recheck: Recheck;
    record: Record_;
    log?: FlowLog;
  },
): Promise<PlainResponse> {
  const log = opts.log ?? (() => undefined);
  const adapter = new ChargeAdapter(opts.request, opts.charge, opts.defaultPayTo);
  const paymentHeader = adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment");
  const path = adapter.getPath();
  const context: HTTPRequestContext = { adapter, path, decodedPath: decodeURIComponent(path), method: adapter.getMethod(), paymentHeader };

  // 2. Challenge or verify.
  const result = await engine.processHTTPRequest(context);
  if (result.type === "no-payment-required") throw new Error("route unexpectedly not protected");
  if (result.type === "payment-error") {
    log(paymentHeader ? "verify.failed" : "challenge.issued", {
      status: result.response.status,
      amountMinor: opts.charge.amountMinor,
      payTo: opts.charge.payTo ?? opts.defaultPayTo,
    });
    return fromInstructions(result.response);
  }
  const { paymentPayload, paymentRequirements, declaredExtensions, cancellationDispatcher } = result;
  const payer = (paymentPayload.payload as { authorization?: { from?: string } }).authorization?.from ?? undefined;
  log("verify.ok", { payer, amountAtomic: paymentRequirements.amount, network: paymentRequirements.network });

  let amountMinor: number;
  try {
    amountMinor = atomicToCents(paymentRequirements.amount);
  } catch {
    await cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: 409 });
    return { status: 409, headers: {}, body: { error: "AMOUNT_NOT_WHOLE_CENTS", amountAtomic: paymentRequirements.amount } };
  }

  // 3. Re-check right before settling. If anything changed, no money moves.
  const check = await opts.recheck(amountMinor);
  if (!check.ok) {
    await cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: check.status });
    log("settle.skipped_recheck_failed", check.body);
    return {
      status: check.status,
      headers: {},
      body: { ...check.body, message: `${String(check.body.message ?? "")} Payment was verified but NOT settled; no funds moved.`.trim() },
    };
  }

  // 4. Settle onchain.
  const settle = await engine.processSettlement(paymentPayload, paymentRequirements, declaredExtensions, { request: context });
  if (!settle.success) {
    log("settle.failed", { reason: settle.errorReason, message: settle.errorMessage });
    return fromInstructions(settle.response); // Never record a payment that did not settle.
  }
  const tx = settle.transaction;
  const settledAtomic = settle.amount ?? paymentRequirements.amount;
  log("settle.ok", { tx, network: settle.network });
  let settledMinor: number;
  try {
    settledMinor = atomicToCents(settledAtomic);
  } catch {
    // Money moved but cannot be expressed in cents: never round. Operator must reconcile.
    return {
      status: 500,
      headers: { ...settle.headers },
      body: { error: "SETTLED_AMOUNT_NOT_WHOLE_CENTS", transaction: tx, settledAtomic, message: "Payment settled but could not be recorded; operator reconciliation required." },
    };
  }

  // 5. Record (idempotent on the tx hash) and respond; PAYMENT-RESPONSE echoes the settlement.
  const recorded = await opts.record({
    transaction: tx,
    network: settle.network,
    payer: settle.payer ?? payer,
    payTo: paymentRequirements.payTo,
    asset: paymentRequirements.asset,
    amountAtomic: settledAtomic,
    amountMinor: settledMinor,
    explorer: explorerTxUrl(settle.network, tx),
  });
  return { status: recorded.status, headers: { ...settle.headers }, body: recorded.body };
}
