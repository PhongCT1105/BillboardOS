/**
 * BillboardOS x402 payment server.
 *
 * Sells exclusive billboard holds over x402 (Base Sepolia test USDC via the
 * CDP Facilitator). `POST /purchases/:holdId` is priced per request at the
 * hold's amount, read live from Convex.
 *
 * Order of operations for a paid request (we drive the official
 * `x402HTTPResourceServer` ourselves instead of using the Express middleware,
 * because the middleware settles AFTER the handler and we need the settlement
 * tx hash BEFORE recording the payment):
 *
 *   0. agent key            -> Authorization: Bearer bos_agent_... with the "pay" scope for the
 *                              hold's company (checked by Convex); 401/403 otherwise
 *   1. look up hold         -> 404 unknown, 409 not payable (no challenge issued)
 *   2. processHTTPRequest   -> 402 challenge, or facilitator VERIFY of the signed payload
 *   3. re-check hold        -> 409 and cancel (no money moves) if it lapsed
 *   4. processSettlement    -> facilitator SETTLE onchain; failure = no payment reported
 *   5. report to Convex     -> POST /internal/payments/verified (externalRef = tx hash)
 *   6. respond              -> 200 booked | 409 finance exception (money moved, recorded)
 *
 * Run: npm run server
 */
import express, { type Request, type Response } from "express";
import cors from "cors";
import { createX402Server, type X402Server } from "@coinbase/cdp-sdk/x402";
import { ExpressAdapter } from "@x402/express";
import type {
  HTTPRequestContext,
  HTTPResponseInstructions,
  RouteConfig,
} from "@x402/core/server";
import {
  atomicToCents,
  centsToUsd,
  env,
  explorerTxUrl,
  presence,
  requireEnv,
} from "./lib.ts";

// ---------------------------------------------------------------- config

const PORT = Number(env("X402_SERVER_PORT") ?? 4021);
const NETWORK = (env("X402_NETWORK") ?? "eip155:84532") as `${string}:${string}`;
const ENVIRONMENT = env("X402_ENVIRONMENT") === "production" ? "production" : "development";
const CONVEX_SITE_URL = requireEnv("CONVEX_SITE_URL", "Convex HTTP actions base URL").replace(/\/$/, "");
const INTERNAL_API_SECRET = requireEnv("INTERNAL_API_SECRET", "bearer token for Convex /internal routes");
requireEnv("CDP_API_KEY_ID", "authenticates the CDP x402 facilitator");
requireEnv("CDP_API_KEY_SECRET", "authenticates the CDP x402 facilitator");
const PAY_TO = env("X402_PAY_TO");
const RECEIVER_WALLET_NAME = env("X402_RECEIVER_WALLET_NAME") ?? "billboardos-operator";
const CORS_ORIGIN = env("X402_CORS_ORIGIN") ?? "http://localhost:5173";
const ROUTE = "POST /purchases/:holdId";

if (ENVIRONMENT !== "development" || NETWORK !== "eip155:84532") {
  console.warn(
    `[x402] WARNING environment=${ENVIRONMENT} network=${NETWORK}. This demo is meant for Base Sepolia test funds only.`,
  );
}

// ---------------------------------------------------------------- logging

function log(traceId: string, step: string, data: Record<string, unknown> = {}): void {
  const fields = Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  console.log(`${new Date().toISOString()} [x402] trace=${traceId} ${step}${fields ? ` ${fields}` : ""}`);
}

// ---------------------------------------------------------------- Convex internal API

type HoldForPayment = {
  holdId: string;
  quoteId: string;
  amountMinor: number;
  currency: "USD";
  expiresAt: number;
  status: "active" | "released" | "expired" | "converted";
  payable: boolean;
  /** Present once Convex exposes it; otherwise we trace by hold id. */
  traceId?: string;
  /** The hold's workspace payout address (null -> this server's default payTo). */
  payTo?: string | null;
};

type AgentPayCheck =
  | { ok: true; actor: string; agentKeyId: string }
  | { ok: false; status: number; code: string; message: string };

/** Ask Convex whether this agent key may pay this hold ("pay" scope, same company). */
async function verifyAgentKey(agentKey: string, holdId: string): Promise<AgentPayCheck> {
  const res = await fetch(`${CONVEX_SITE_URL}/internal/agent-keys/verify-payment`, {
    method: "POST",
    headers: convexHeaders,
    body: JSON.stringify({ agentKey, holdId }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    actor?: string;
    agentKeyId?: string;
    error?: { code?: string; message?: string };
  };
  if (res.ok && body.actor && body.agentKeyId) return { ok: true, actor: body.actor, agentKeyId: body.agentKeyId };
  if (res.status >= 500) throw new Error(`Convex verify-payment -> HTTP ${res.status}`);
  return {
    ok: false,
    status: res.status === 404 ? 404 : res.status === 401 ? 401 : 403,
    code: body.error?.code ?? `HTTP_${res.status}`,
    message: body.error?.message ?? "Agent key not allowed to pay this hold",
  };
}

type RecordVerifiedResult =
  | { outcome: "booked"; paymentId: string; bookingId: string; replayed: boolean }
  | {
      outcome: "exception";
      paymentId: string;
      financeExceptionId: string;
      kind: string;
      replayed: boolean;
    }
  | { outcome: "rejected"; code: string; message: string };

const convexHeaders = {
  Authorization: `Bearer ${INTERNAL_API_SECRET}`,
  "Content-Type": "application/json",
};

async function fetchHold(holdId: string): Promise<HoldForPayment | null> {
  const res = await fetch(
    `${CONVEX_SITE_URL}/internal/holds?holdId=${encodeURIComponent(holdId)}`,
    { headers: convexHeaders },
  );
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`Convex GET /internal/holds -> HTTP ${res.status}`);
  return (await res.json()) as HoldForPayment;
}

/**
 * Report a settled payment. Retries transport errors / 5xx because money has
 * already moved; safe since Convex is idempotent on externalRef.
 */
async function reportVerifiedPayment(body: {
  holdId: string;
  externalRef: string;
  amountMinor: number;
  asset: string;
  network: string;
  idempotencyKey: string;
}): Promise<{ status: number; result: RecordVerifiedResult }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${CONVEX_SITE_URL}/internal/payments/verified`, {
        method: "POST",
        headers: convexHeaders,
        body: JSON.stringify({ ...body, provider: "x402" }),
      });
      if (res.status >= 500) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return { status: res.status, result: (await res.json()) as RecordVerifiedResult };
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error(`Convex /internal/payments/verified failed after retries: ${String(lastError)}`);
}

const traceOf = (hold: HoldForPayment | null, holdId: string) =>
  hold?.traceId ?? `hold:${holdId}`;

// ---------------------------------------------------------------- x402 server

/** Fallback receiver for holds whose workspace has no payout address (set after the server is built). */
let defaultPayTo = PAY_TO ?? "";

/** Carries the hold looked up for this request into the dynamic price function. */
class HoldRequestAdapter extends ExpressAdapter {
  constructor(
    req: Request,
    readonly hold: HoldForPayment,
  ) {
    super(req);
  }
}

const route: RouteConfig = {
  accepts: {
    scheme: "exact",
    network: NETWORK,
    // Per request: the hold's workspace payout address (ADR 0004: customer agents pay the host),
    // else X402_PAY_TO / the provisioned CDP receiver wallet.
    payTo: (context: HTTPRequestContext) => {
      const adapter = context.adapter;
      const hold = adapter instanceof HoldRequestAdapter ? adapter.hold : null;
      return hold?.payTo ?? defaultPayTo;
    },
    // Per-request price: exactly the hold's amount (USD cents -> "$12.34" -> USDC atomic, string math).
    price: (context: HTTPRequestContext) => {
      const adapter = context.adapter;
      if (!(adapter instanceof HoldRequestAdapter)) {
        throw new Error("purchase route invoked without a hold lookup");
      }
      return centsToUsd(adapter.hold.amountMinor);
    },
    maxTimeoutSeconds: 300,
  },
  description: "Exclusive BillboardOS airtime hold: pay the quoted amount to confirm the booking",
  mimeType: "application/json",
  // Human/agent-readable 402 body alongside the PAYMENT-REQUIRED header.
  unpaidResponseBody: (context: HTTPRequestContext) => {
    const hold = (context.adapter as HoldRequestAdapter).hold;
    return {
      contentType: "application/json",
      body: {
        holdId: hold.holdId,
        amountMinor: hold.amountMinor,
        price: centsToUsd(hold.amountMinor),
        asset: "USDC",
        network: NETWORK,
        expiresAt: hold.expiresAt,
      },
    };
  },
};

async function buildX402Server(): Promise<X402Server> {
  if (PAY_TO) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) {
      console.error("X402_PAY_TO must be a 0x-prefixed 20-byte EVM address.");
      process.exit(1);
    }
    return createX402Server({
      environment: ENVIRONMENT,
      payToConfig: { type: "address", evm: PAY_TO as `0x${string}` },
      routes: { [ROUTE]: route },
    });
  }
  if (env("CDP_WALLET_SECRET")) {
    // Fallback from the CDP seller quickstart: provision (or reuse) a CDP
    // API Key Wallet as the receiving address.
    return createX402Server({
      environment: ENVIRONMENT,
      payToConfig: { type: "eoa", accountName: RECEIVER_WALLET_NAME },
      routes: { [ROUTE]: route },
    });
  }
  console.error(
    [
      "No receiving address configured. Set ONE of these in .env:",
      "  X402_PAY_TO=0x...            # operator's Base Sepolia address, or",
      `  CDP_WALLET_SECRET=...        # lets CDP provision wallet "${RECEIVER_WALLET_NAME}" as payTo`,
    ].join("\n"),
  );
  process.exit(1);
}

function sendInstructions(res: Response, response: HTTPResponseInstructions): void {
  res.status(response.status);
  for (const [key, value] of Object.entries(response.headers)) res.setHeader(key, value);
  if (response.isHtml) res.send(response.body);
  else res.json(response.body ?? {});
}

// ---------------------------------------------------------------- app

const x402 = await buildX402Server();
const payTo = x402.payToEvmAddress ?? PAY_TO;
defaultPayTo = payTo ?? "";

const app = express();
app.use(
  cors({
    origin: CORS_ORIGIN,
    allowedHeaders: ["Content-Type", "Authorization", "PAYMENT-SIGNATURE", "X-PAYMENT"],
    exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"],
  }),
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    network: NETWORK,
    environment: ENVIRONMENT,
    payTo,
    payToSource: PAY_TO ? "X402_PAY_TO" : `cdp-wallet:${RECEIVER_WALLET_NAME}`,
    convex: CONVEX_SITE_URL,
  });
});

/** In-process lock: one purchase attempt per hold at a time (avoids double settle). */
const inFlight = new Set<string>();

app.post("/purchases/:holdId", async (req: Request<{ holdId: string }>, res: Response) => {
  const holdId = req.params.holdId;
  if (!/^[a-z0-9]{1,64}$/i.test(holdId)) {
    res.status(404).json({ error: "HOLD_NOT_FOUND", holdId });
    return;
  }

  // 0. Agent key: only the hold's company (with the "pay" scope) may pay.
  //    x402 uses PAYMENT-SIGNATURE / X-PAYMENT, so Authorization is free for the key.
  const auth = /^Bearer (bos_agent_\S+)$/.exec(req.header("authorization") ?? "");
  if (!auth) {
    res.status(401).json({ error: "AGENT_KEY_REQUIRED", message: "Send Authorization: Bearer <agent key with the pay scope>" });
    return;
  }
  let keyCheck: AgentPayCheck;
  try {
    keyCheck = await verifyAgentKey(auth[1], holdId);
  } catch (error) {
    log(`hold:${holdId}`, "agent_key.check_failed", { error: String(error) });
    res.status(502).json({ error: "CONVEX_UNAVAILABLE" });
    return;
  }
  if (!keyCheck.ok) {
    log(`hold:${holdId}`, "agent_key.refused", { code: keyCheck.code });
    res.status(keyCheck.status).json({ error: keyCheck.code, message: keyCheck.message });
    return;
  }

  // 1. Hold lookup (before any payment is requested).
  let hold: HoldForPayment | null;
  try {
    hold = await fetchHold(holdId);
  } catch (error) {
    log(`hold:${holdId}`, "hold.lookup_failed", { error: String(error) });
    res.status(502).json({ error: "CONVEX_UNAVAILABLE" });
    return;
  }
  const traceId = traceOf(hold, holdId);
  const paymentHeader = req.header("payment-signature") ?? req.header("x-payment");
  log(traceId, "request", { holdId, paid: Boolean(paymentHeader), agent: keyCheck.actor });

  if (!hold) {
    log(traceId, "hold.not_found");
    res.status(404).json({ error: "HOLD_NOT_FOUND", holdId });
    return;
  }
  if (!hold.payable) {
    log(traceId, "hold.not_payable", { status: hold.status, expiresAt: hold.expiresAt });
    res.status(409).json({
      error: "HOLD_NOT_PAYABLE",
      holdId,
      status: hold.status,
      expiresAt: hold.expiresAt,
      message:
        hold.status === "active"
          ? "Hold has expired; request a new quote and hold."
          : `Hold is ${hold.status}; nothing to pay.`,
    });
    return;
  }
  if (hold.currency !== "USD" || !Number.isSafeInteger(hold.amountMinor) || hold.amountMinor <= 0) {
    log(traceId, "hold.unpriceable", { currency: hold.currency, amountMinor: hold.amountMinor });
    res.status(409).json({ error: "HOLD_NOT_PRICEABLE", holdId });
    return;
  }

  if (paymentHeader) {
    if (inFlight.has(holdId)) {
      log(traceId, "purchase.in_progress");
      res.status(409).json({ error: "PURCHASE_IN_PROGRESS", holdId });
      return;
    }
    inFlight.add(holdId);
  }
  try {
    await purchase(req, res, hold, traceId, paymentHeader);
  } catch (error) {
    log(traceId, "error", { error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) res.status(500).json({ error: "INTERNAL_ERROR", traceId });
  } finally {
    if (paymentHeader) inFlight.delete(holdId);
  }
});

async function purchase(
  req: Request,
  res: Response,
  hold: HoldForPayment,
  traceId: string,
  paymentHeader: string | undefined,
): Promise<void> {
  const holdId = hold.holdId;
  const context: HTTPRequestContext = {
    adapter: new HoldRequestAdapter(req, hold),
    path: req.path,
    decodedPath: decodeURIComponent(req.path),
    method: req.method,
    paymentHeader,
  };

  // 2. Challenge or verify (CDP facilitator /verify).
  const result = await x402.processHTTPRequest(context);
  if (result.type === "no-payment-required") {
    throw new Error("route unexpectedly not protected");
  }
  if (result.type === "payment-error") {
    if (paymentHeader) {
      const body = result.response.body as { error?: string } | undefined;
      log(traceId, "verify.failed", { status: result.response.status, reason: body?.error });
    } else {
      log(traceId, "challenge.issued", {
        amountMinor: hold.amountMinor,
        price: centsToUsd(hold.amountMinor),
        network: NETWORK,
        payTo: hold.payTo ?? defaultPayTo,
      });
    }
    sendInstructions(res, result.response);
    return;
  }

  const { paymentPayload, paymentRequirements, declaredExtensions, cancellationDispatcher } = result;
  const payer =
    (paymentPayload.payload as { authorization?: { from?: string } }).authorization?.from ?? undefined;
  log(traceId, "verify.ok", {
    payer,
    amountAtomic: paymentRequirements.amount,
    asset: paymentRequirements.asset,
    network: paymentRequirements.network,
  });

  // Amount sanity before money moves: must be whole cents and equal the hold.
  let amountMinor: number;
  try {
    amountMinor = atomicToCents(paymentRequirements.amount);
  } catch (error) {
    await cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: 409 });
    log(traceId, "amount.invalid", { error: String(error) });
    res.status(409).json({ error: "AMOUNT_NOT_WHOLE_CENTS", amountAtomic: paymentRequirements.amount });
    return;
  }

  // 3. Re-check the hold right before settling. If it lapsed, no money moves.
  const fresh = await fetchHold(holdId);
  if (!fresh || !fresh.payable || fresh.amountMinor !== amountMinor) {
    await cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: 409 });
    log(traceId, "settle.skipped_hold_lapsed", {
      status: fresh?.status,
      heldAmountMinor: fresh?.amountMinor,
      amountMinor,
    });
    res.status(409).json({
      error: "HOLD_NOT_PAYABLE",
      holdId,
      status: fresh?.status ?? "missing",
      message: "Hold is no longer payable. Payment was verified but NOT settled; no funds moved.",
    });
    return;
  }

  // 4. Settle onchain (CDP facilitator /settle).
  log(traceId, "settle.start");
  const settle = await x402.processSettlement(
    paymentPayload,
    paymentRequirements,
    declaredExtensions,
    { request: context },
  );
  if (!settle.success) {
    log(traceId, "settle.failed", { reason: settle.errorReason, message: settle.errorMessage });
    sendInstructions(res, settle.response);
    return; // Do NOT report a payment that did not settle.
  }
  for (const [key, value] of Object.entries(settle.headers)) res.setHeader(key, value);
  const tx = settle.transaction;
  const settledAtomic = settle.amount ?? paymentRequirements.amount;
  const explorer = explorerTxUrl(settle.network, tx);
  log(traceId, "settle.ok", { tx, payer: settle.payer ?? payer, network: settle.network, explorer });

  let settledMinor: number;
  try {
    settledMinor = atomicToCents(settledAtomic);
  } catch (error) {
    // Money moved but cannot be expressed in cents: never round. Operator must reconcile.
    log(traceId, "report.blocked_non_integer_cents", { tx, settledAtomic, error: String(error) });
    res.status(500).json({
      error: "SETTLED_AMOUNT_NOT_WHOLE_CENTS",
      transaction: tx,
      settledAtomic,
      message: "Payment settled but could not be recorded; operator reconciliation required.",
    });
    return;
  }

  // 5. Report to Convex. externalRef = settlement tx hash (replay-safe).
  const externalRef = tx || `x402:${settle.payer ?? payer ?? "unknown"}:${holdId}`;
  const { status, result: outcome } = await reportVerifiedPayment({
    holdId,
    externalRef,
    amountMinor: settledMinor,
    asset: "USDC",
    network: settle.network,
    idempotencyKey: `x402:${externalRef}`,
  });
  log(traceId, `convex.${outcome.outcome}`, { httpStatus: status, ...outcome });

  const payment = {
    provider: "x402",
    transaction: tx,
    network: settle.network,
    payer: settle.payer ?? payer,
    payTo: paymentRequirements.payTo,
    asset: paymentRequirements.asset,
    amountAtomic: settledAtomic,
    amountMinor: settledMinor,
    explorer,
  };

  // 6. Respond.
  if (outcome.outcome === "booked") {
    res.status(200).json({ ...outcome, holdId, traceId, payment });
  } else if (outcome.outcome === "exception") {
    // Money moved; the finance exception records it for operator review.
    res.status(409).json({ ...outcome, holdId, traceId, payment });
  } else {
    // Settled but Convex rejected the report: should not happen; needs an operator.
    res.status(500).json({ ...outcome, holdId, traceId, payment });
  }
}

app.listen(PORT, () => {
  console.log(
    [
      `BillboardOS x402 server on http://localhost:${PORT}`,
      `  route        ${ROUTE} (dynamic price = hold amount)`,
      `  network      ${NETWORK} (${ENVIRONMENT})`,
      `  payTo        ${payTo} (${PAY_TO ? "X402_PAY_TO" : `CDP wallet "${RECEIVER_WALLET_NAME}"`})`,
      `  facilitator  CDP (CDP_API_KEY_ID ${presence("CDP_API_KEY_ID")}, CDP_API_KEY_SECRET ${presence("CDP_API_KEY_SECRET")})`,
      `  convex       ${CONVEX_SITE_URL}`,
      `  cors         ${CORS_ORIGIN}`,
    ].join("\n"),
  );
});
