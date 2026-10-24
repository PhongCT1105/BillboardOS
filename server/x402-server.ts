/**
 * BillboardOS x402 payment server, and each host workspace's seller agent
 * (ADR 0005).
 *
 * Paid routes (Base Sepolia test USDC via the CDP Facilitator; payTo = the
 * host workspace's payout address, else this server's default receiver):
 *   POST /purchases/:holdId                              hold amount (legacy, any host)
 *   POST /a2a/hosts/:workspaceId/purchases/:holdId       hold amount (hold must belong to that host)
 *   GET  /a2a/hosts/:workspaceId/reports/audience?billboardId=   $0.05 (X402_REPORT_PRICE_USD)
 * Free seller-agent routes (agent key required except the card):
 *   GET  /a2a/hosts/:workspaceId/agent.json
 *   POST /a2a/hosts/:workspaceId/negotiations                     { campaignId, slotIds[], amountMinor?, reasoning? }
 *   GET  /a2a/hosts/:workspaceId/negotiations/:id
 *   POST /a2a/hosts/:workspaceId/negotiations/:id/messages        { kind: offer|accept|reject, amountMinor?, reasoning? }
 *
 * Order of operations for every paid request (we drive the official
 * `x402HTTPResourceServer` ourselves instead of the Express middleware,
 * because the middleware settles AFTER the handler and we need the
 * settlement tx hash BEFORE recording anything):
 *
 *   0. agent key            -> Authorization: Bearer bos_agent_... checked by Convex; 401/403 otherwise
 *   1. look up the thing    -> hold / screen; 404 unknown, 409 not payable (no challenge issued)
 *   2. processHTTPRequest   -> 402 challenge, or facilitator VERIFY of the signed payload
 *   3. re-check             -> hold still payable at that amount / report still producible; else cancel (no money moves)
 *   4. processSettlement    -> facilitator SETTLE onchain; failure = nothing recorded
 *   5. record in Convex     -> payment (externalRef = tx hash) or data sale (txHash), both idempotent
 *   6. respond
 *
 * Run: npm run server
 */
import express, { type Request, type Response } from "express";
import cors from "cors";
import { createX402Server, type X402Server } from "@coinbase/cdp-sdk/x402";
import { ExpressAdapter } from "@x402/express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { HTTPRequestContext, HTTPResponseInstructions, RouteConfig } from "@x402/core/server";
import { atomicToCents, centsToUsd, decimalToCents, env, explorerTxUrl, presence, requireEnv } from "./lib.ts";

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
const PUBLIC_URL = (env("X402_PUBLIC_URL") ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const REPORT_PRICE_MINOR = decimalToCents(env("X402_REPORT_PRICE_USD") ?? "0.05");

const ROUTE_PURCHASE = "POST /purchases/:holdId";
const ROUTE_HOST_PURCHASE = "POST /a2a/hosts/:workspaceId/purchases/:holdId";
const ROUTE_REPORT = "GET /a2a/hosts/:workspaceId/reports/audience";

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

const convexHeaders = {
  Authorization: `Bearer ${INTERNAL_API_SECRET}`,
  "Content-Type": "application/json",
};

type ConvexError = { code?: string; message?: string } & Record<string, unknown>;
type ConvexReply<T> = { ok: true; status: number; body: T } | { ok: false; status: number; error: ConvexError };

/** Call Convex /internal/*; 5xx and transport errors throw (caller answers 502). */
async function convex<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ConvexReply<T>> {
  const res = await fetch(`${CONVEX_SITE_URL}${path}`, {
    method,
    headers: convexHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status >= 500) throw new Error(`Convex ${method} ${path.split("?")[0]} -> HTTP ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as T & { error?: ConvexError | string };
  if (res.ok) return { ok: true, status: res.status, body: json };
  const err = typeof json.error === "string" ? { code: json.error } : (json.error ?? {});
  return { ok: false, status: res.status, error: err };
}

type HoldForPayment = {
  holdId: string;
  quoteId: string;
  amountMinor: number;
  currency: "USD";
  expiresAt: number;
  status: "active" | "released" | "expired" | "converted";
  payable: boolean;
  traceId?: string;
  /** The hold's workspace payout address (null -> this server's default payTo). */
  payTo?: string | null;
  workspaceId?: string | null;
};

type AgentPayCheck =
  | { ok: true; actor: string; agentKeyId: string }
  | { ok: false; status: number; code: string; message: string };

/** Ask Convex whether this agent key may pay this hold ("pay" scope, same company). */
async function verifyAgentKey(agentKey: string, holdId: string): Promise<AgentPayCheck> {
  const r = await convex<{ actor: string; agentKeyId: string }>("POST", "/internal/agent-keys/verify-payment", { agentKey, holdId });
  if (r.ok) return { ok: true, actor: r.body.actor, agentKeyId: r.body.agentKeyId };
  return {
    ok: false,
    status: r.status === 404 ? 404 : r.status === 401 ? 401 : 403,
    code: r.error.code ?? `HTTP_${r.status}`,
    message: r.error.message ?? "Agent key not allowed to pay this hold",
  };
}

type RecordVerifiedResult =
  | { outcome: "booked"; paymentId: string; bookingId: string; replayed: boolean }
  | { outcome: "exception"; paymentId: string; financeExceptionId: string; kind: string; replayed: boolean }
  | { outcome: "rejected"; code: string; message: string };

async function fetchHold(holdId: string): Promise<HoldForPayment | null> {
  const res = await fetch(`${CONVEX_SITE_URL}/internal/holds?holdId=${encodeURIComponent(holdId)}`, { headers: convexHeaders });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`Convex GET /internal/holds -> HTTP ${res.status}`);
  return (await res.json()) as HoldForPayment;
}

/** Retry transport errors / 5xx after money moved; safe because Convex is idempotent on the key. */
async function postWithRetry<T>(path: string, body: unknown): Promise<{ status: number; result: T }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${CONVEX_SITE_URL}${path}`, { method: "POST", headers: convexHeaders, body: JSON.stringify(body) });
      if (res.status >= 500) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return { status: res.status, result: (await res.json()) as T };
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error(`Convex ${path} failed after retries: ${String(lastError)}`);
}

// ---------------------------------------------------------------- x402 server

/** Fallback receiver for workspaces without a payout address (set after the server is built). */
let defaultPayTo = PAY_TO ?? "";

/** What one paid request costs and who gets paid, decided before the challenge. */
type Charge = {
  amountMinor: number;
  payTo: string | null;
  unpaid: Record<string, unknown>;
};

/** Carries the per-request charge into the route's dynamic price / payTo / 402 body. */
class ChargeAdapter extends ExpressAdapter {
  constructor(
    req: Request,
    readonly charge: Charge,
  ) {
    super(req);
  }
}

function chargeOf(context: HTTPRequestContext): Charge {
  const adapter = context.adapter;
  if (!(adapter instanceof ChargeAdapter)) throw new Error("paid route invoked without a charge");
  return adapter.charge;
}

function paidRoute(description: string, bazaar: Record<string, unknown>, tags: string[]): RouteConfig {
  return {
    accepts: {
      scheme: "exact",
      network: NETWORK,
      // Per request: the host workspace's payout address (customer agents pay the host), else the default.
      payTo: (context: HTTPRequestContext) => chargeOf(context).payTo ?? defaultPayTo,
      // Per request price in USD cents -> "$12.34" (string math, no floats).
      price: (context: HTTPRequestContext) => centsToUsd(chargeOf(context).amountMinor),
      maxTimeoutSeconds: 300,
    },
    description,
    mimeType: "application/json",
    serviceName: "BillboardOS",
    tags,
    unpaidResponseBody: (context: HTTPRequestContext) => ({ contentType: "application/json", body: chargeOf(context).unpaid }),
    extensions: bazaar,
  };
}

const holdBazaar = declareDiscoveryExtension({
  bodyType: "json",
  input: {},
  pathParams: { holdId: "hold id from an agreed negotiation or POST /api/agent/holds" },
  output: { example: { outcome: "booked", holdId: "…", bookingId: "…", payment: { transaction: "0x…" } } },
});

const routes: Record<string, RouteConfig> = {
  [ROUTE_PURCHASE]: paidRoute(
    "Exclusive BillboardOS airtime hold: pay the quoted amount to confirm the booking",
    holdBazaar,
    ["advertising", "billboard", "dooh"],
  ),
  [ROUTE_HOST_PURCHASE]: paidRoute(
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
    "Audience report for one screen: trailing 2h crowd, peak in view, audience mix, upcoming events, recent clearing prices (aggregate only, no personal data)",
    declareDiscoveryExtension({
      input: { billboardId: "screen id from the host's agent.json" },
      inputSchema: { properties: { billboardId: { type: "string" } }, required: ["billboardId"] },
      pathParams: { workspaceId: "host workspace id" },
      output: { example: { billboard: { name: "Moscone West Screen" }, crowd: { averagePer15Min: 140, peakInView: 22 }, upcomingEvents: [], recentClearingPrices: [] } },
    }),
    ["data", "audience", "advertising", "agent-to-agent"],
  ),
};

async function buildX402Server(): Promise<X402Server> {
  if (PAY_TO) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) {
      console.error("X402_PAY_TO must be a 0x-prefixed 20-byte EVM address.");
      process.exit(1);
    }
    return createX402Server({ environment: ENVIRONMENT, payToConfig: { type: "address", evm: PAY_TO as `0x${string}` }, routes });
  }
  if (env("CDP_WALLET_SECRET")) {
    // Fallback from the CDP seller quickstart: provision (or reuse) a CDP API Key Wallet as the receiver.
    return createX402Server({ environment: ENVIRONMENT, payToConfig: { type: "eoa", accountName: RECEIVER_WALLET_NAME }, routes });
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

type Settled = {
  transaction: string;
  network: string;
  payer?: string;
  payTo: string;
  asset: string;
  amountAtomic: string;
  amountMinor: number;
  explorer?: string;
};

/**
 * Shared paid-request flow: challenge or verify, re-check, settle, then hand
 * the settlement to `record`. Nothing is recorded unless settlement succeeded.
 */
async function runPaid(
  req: Request,
  res: Response,
  opts: {
    traceId: string;
    charge: Charge;
    paymentHeader: string | undefined;
    /** Step 3: still OK to take this exact amount? Return an error body to cancel (no money moves). */
    recheck: (amountMinor: number) => Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }>;
    /** Step 5-6: record and respond. Called only after a successful settlement. */
    record: (settled: Settled) => Promise<void>;
  },
): Promise<void> {
  const { traceId, charge, paymentHeader } = opts;
  const context: HTTPRequestContext = {
    adapter: new ChargeAdapter(req, charge),
    path: req.path,
    decodedPath: decodeURIComponent(req.path),
    method: req.method,
    paymentHeader,
  };

  // 2. Challenge or verify (CDP facilitator /verify).
  const result = await x402.processHTTPRequest(context);
  if (result.type === "no-payment-required") throw new Error("route unexpectedly not protected");
  if (result.type === "payment-error") {
    if (paymentHeader) {
      const body = result.response.body as { error?: string } | undefined;
      log(traceId, "verify.failed", { status: result.response.status, reason: body?.error });
    } else {
      log(traceId, "challenge.issued", {
        amountMinor: charge.amountMinor,
        price: centsToUsd(charge.amountMinor),
        network: NETWORK,
        payTo: charge.payTo ?? defaultPayTo,
      });
    }
    sendInstructions(res, result.response);
    return;
  }

  const { paymentPayload, paymentRequirements, declaredExtensions, cancellationDispatcher } = result;
  const payer = (paymentPayload.payload as { authorization?: { from?: string } }).authorization?.from ?? undefined;
  log(traceId, "verify.ok", { payer, amountAtomic: paymentRequirements.amount, asset: paymentRequirements.asset, network: paymentRequirements.network });

  let amountMinor: number;
  try {
    amountMinor = atomicToCents(paymentRequirements.amount);
  } catch (error) {
    await cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: 409 });
    log(traceId, "amount.invalid", { error: String(error) });
    res.status(409).json({ error: "AMOUNT_NOT_WHOLE_CENTS", amountAtomic: paymentRequirements.amount });
    return;
  }

  // 3. Re-check right before settling. If anything changed, no money moves.
  const check = await opts.recheck(amountMinor);
  if (!check.ok) {
    await cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus: check.status });
    log(traceId, "settle.skipped_recheck_failed", check.body);
    res.status(check.status).json({ ...check.body, message: `${String(check.body.message ?? "")} Payment was verified but NOT settled; no funds moved.`.trim() });
    return;
  }

  // 4. Settle onchain (CDP facilitator /settle).
  log(traceId, "settle.start");
  const settle = await x402.processSettlement(paymentPayload, paymentRequirements, declaredExtensions, { request: context });
  if (!settle.success) {
    log(traceId, "settle.failed", { reason: settle.errorReason, message: settle.errorMessage });
    sendInstructions(res, settle.response);
    return; // Never record a payment that did not settle.
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

  await opts.record({
    transaction: tx,
    network: settle.network,
    payer: settle.payer ?? payer,
    payTo: paymentRequirements.payTo,
    asset: paymentRequirements.asset,
    amountAtomic: settledAtomic,
    amountMinor: settledMinor,
    explorer,
  });
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
app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    network: NETWORK,
    environment: ENVIRONMENT,
    payTo,
    payToSource: PAY_TO ? "X402_PAY_TO" : `cdp-wallet:${RECEIVER_WALLET_NAME}`,
    convex: CONVEX_SITE_URL,
    reportPrice: centsToUsd(REPORT_PRICE_MINOR),
  });
});

const ID_RE = /^[a-z0-9]{1,64}$/i;
const agentKeyOf = (req: Request) => /^Bearer (bos_agent_\S+)$/.exec(req.header("authorization") ?? "")?.[1] ?? null;
const paymentHeaderOf = (req: Request) => req.header("payment-signature") ?? req.header("x-payment");

/** In-process lock: one paid attempt per resource at a time (avoids double settle). */
const inFlight = new Set<string>();

async function withLock(key: string, paid: boolean, res: Response, traceId: string, fn: () => Promise<void>) {
  if (paid) {
    if (inFlight.has(key)) {
      log(traceId, "purchase.in_progress");
      res.status(409).json({ error: "PURCHASE_IN_PROGRESS" });
      return;
    }
    inFlight.add(key);
  }
  try {
    await fn();
  } catch (error) {
    log(traceId, "error", { error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) res.status(500).json({ error: "INTERNAL_ERROR", traceId });
  } finally {
    if (paid) inFlight.delete(key);
  }
}

// ---------------------------------------------------------------- purchases (hold amount)

async function handlePurchase(req: Request, res: Response, holdId: string, workspaceId: string | null): Promise<void> {
  if (!ID_RE.test(holdId) || (workspaceId !== null && !ID_RE.test(workspaceId))) {
    res.status(404).json({ error: "HOLD_NOT_FOUND", holdId });
    return;
  }
  // 0. Agent key: only the hold's company (with the "pay" scope) may pay.
  //    x402 uses PAYMENT-SIGNATURE / X-PAYMENT, so Authorization is free for the key.
  const agentKey = agentKeyOf(req);
  if (!agentKey) {
    res.status(401).json({ error: "AGENT_KEY_REQUIRED", message: "Send Authorization: Bearer <agent key with the pay scope>" });
    return;
  }
  let keyCheck: AgentPayCheck;
  try {
    keyCheck = await verifyAgentKey(agentKey, holdId);
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
  const traceId = hold?.traceId ?? `hold:${holdId}`;
  const paymentHeader = paymentHeaderOf(req);
  log(traceId, "request", { holdId, workspaceId: workspaceId ?? undefined, paid: Boolean(paymentHeader), agent: keyCheck.actor });

  if (!hold || (workspaceId !== null && hold.workspaceId !== workspaceId)) {
    log(traceId, "hold.not_found");
    res.status(404).json({ error: "HOLD_NOT_FOUND", holdId, message: workspaceId ? "No such hold at this host" : undefined });
    return;
  }
  if (!hold.payable) {
    log(traceId, "hold.not_payable", { status: hold.status, expiresAt: hold.expiresAt });
    res.status(409).json({
      error: "HOLD_NOT_PAYABLE",
      holdId,
      status: hold.status,
      expiresAt: hold.expiresAt,
      message: hold.status === "active" ? "Hold has expired; request a new quote and hold." : `Hold is ${hold.status}; nothing to pay.`,
    });
    return;
  }
  if (hold.currency !== "USD" || !Number.isSafeInteger(hold.amountMinor) || hold.amountMinor <= 0) {
    log(traceId, "hold.unpriceable", { currency: hold.currency, amountMinor: hold.amountMinor });
    res.status(409).json({ error: "HOLD_NOT_PRICEABLE", holdId });
    return;
  }

  const h = hold;
  await withLock(`hold:${holdId}`, Boolean(paymentHeader), res, traceId, () =>
    runPaid(req, res, {
      traceId,
      paymentHeader,
      charge: {
        amountMinor: h.amountMinor,
        payTo: h.payTo ?? null,
        unpaid: { holdId: h.holdId, amountMinor: h.amountMinor, price: centsToUsd(h.amountMinor), asset: "USDC", network: NETWORK, expiresAt: h.expiresAt },
      },
      recheck: async (amountMinor) => {
        const fresh = await fetchHold(holdId);
        if (!fresh || !fresh.payable || fresh.amountMinor !== amountMinor) {
          return { ok: false, status: 409, body: { error: "HOLD_NOT_PAYABLE", holdId, status: fresh?.status ?? "missing", message: "Hold is no longer payable." } };
        }
        return { ok: true };
      },
      record: async (settled) => {
        // 5. Report to Convex. externalRef = settlement tx hash (replay-safe).
        const externalRef = settled.transaction || `x402:${settled.payer ?? "unknown"}:${holdId}`;
        const { status, result: outcome } = await postWithRetry<RecordVerifiedResult>("/internal/payments/verified", {
          holdId,
          externalRef,
          amountMinor: settled.amountMinor,
          asset: "USDC",
          network: settled.network,
          idempotencyKey: `x402:${externalRef}`,
          provider: "x402",
        });
        log(traceId, `convex.${outcome.outcome}`, { httpStatus: status, ...outcome });
        const payment = { provider: "x402", ...settled };
        // 6. Respond.
        if (outcome.outcome === "booked") res.status(200).json({ ...outcome, holdId, traceId, payment });
        else if (outcome.outcome === "exception") res.status(409).json({ ...outcome, holdId, traceId, payment });
        else res.status(500).json({ ...outcome, holdId, traceId, payment });
      },
    }),
  );
}

app.post("/purchases/:holdId", (req: Request<{ holdId: string }>, res: Response) => handlePurchase(req, res, req.params.holdId, null));
app.post("/a2a/hosts/:workspaceId/purchases/:holdId", (req: Request<{ workspaceId: string; holdId: string }>, res: Response) =>
  handlePurchase(req, res, req.params.holdId, req.params.workspaceId),
);

// ---------------------------------------------------------------- seller agent: card (free)

type AgentCardData = {
  workspaceId: string;
  name: string;
  city: string;
  payoutAddress: string | null;
  negotiation: { maxRounds: number; offerValiditySeconds: number };
  screens: { billboardId: string; name: string; city: string; locationLabel: string; online: boolean; baseRateMinor: number; audienceTags: Record<string, number> | null }[];
};

function relay(res: Response, status: number, error: ConvexError) {
  res.status(status).json({ error: { code: error.code ?? `HTTP_${status}`, message: error.message ?? "Request failed", ...error } });
}

app.get("/a2a/hosts/:workspaceId/agent.json", async (req: Request<{ workspaceId: string }>, res: Response) => {
  const workspaceId = req.params.workspaceId;
  if (!ID_RE.test(workspaceId)) return relay(res, 404, { code: "NOT_FOUND", message: "Host not found" });
  try {
    const r = await convex<AgentCardData>("GET", `/internal/a2a/agent-card?workspaceId=${encodeURIComponent(workspaceId)}`);
    if (!r.ok) return relay(res, r.status, r.error);
    const card = r.body;
    const base = `${PUBLIC_URL}/a2a/hosts/${workspaceId}`;
    res.json({
      schema: "billboardos.agent-card/v1",
      name: `${card.name} seller agent`,
      description: `Sells screen time and audience data for ${card.name} (${card.city}) on BillboardOS. Negotiates with buyer agents; every payment is x402.`,
      host: { workspaceId: card.workspaceId, name: card.name, city: card.city },
      payment: {
        protocol: "x402",
        scheme: "exact",
        network: NETWORK,
        asset: "USDC",
        payTo: card.payoutAddress ?? defaultPayTo,
      },
      auth: { type: "bearer", description: "BillboardOS agent key (bos_agent_...) for everything except this card" },
      negotiation: {
        maxRounds: card.negotiation.maxRounds,
        offerValiditySeconds: card.negotiation.offerValiditySeconds,
        messages: ["offer {amountMinor, reasoning}", "accept", "reject {reasoning}"],
        notes: "Slots are not held while negotiating; an accepted deal creates a 5-minute hold to pay over x402. Hot slots (live auction) are not negotiable.",
      },
      services: [
        { id: "agent-card", method: "GET", url: `${base}/agent.json`, price: "free" },
        { id: "audience-report", method: "GET", url: `${base}/reports/audience?billboardId={billboardId}`, price: centsToUsd(REPORT_PRICE_MINOR), paid: "x402", scope: "any agent key" },
        { id: "negotiate", method: "POST", url: `${base}/negotiations`, price: "free", scope: "quote + hold", body: { campaignId: "string", slotIds: ["string"], amountMinor: "optional opening offer (US cents)", reasoning: "optional" } },
        { id: "negotiation-message", method: "POST", url: `${base}/negotiations/{negotiationId}/messages`, price: "free", body: { kind: "offer | accept | reject", amountMinor: "for offers", reasoning: "optional" } },
        { id: "purchase", method: "POST", url: `${base}/purchases/{holdId}`, price: "hold amount", paid: "x402", scope: "pay" },
      ],
      screens: card.screens,
    });
  } catch (error) {
    log(`host:${workspaceId}`, "agent_card.failed", { error: String(error) });
    res.status(502).json({ error: { code: "CONVEX_UNAVAILABLE", message: "Try again" } });
  }
});

// ---------------------------------------------------------------- seller agent: audience report (x402)

type ReportAuth = { agentKeyId: string; advertiserId: string; actor: string; billboardId: string; payTo: string | null };

app.get("/a2a/hosts/:workspaceId/reports/audience", async (req: Request<{ workspaceId: string }>, res: Response) => {
  const workspaceId = req.params.workspaceId;
  const billboardId = typeof req.query.billboardId === "string" ? req.query.billboardId : "";
  const traceId = `report:${workspaceId}:${billboardId}`;
  if (!ID_RE.test(workspaceId) || !ID_RE.test(billboardId)) {
    return relay(res, 404, { code: "NOT_FOUND", message: "Send ?billboardId= for one of this host's screens" });
  }
  // 0. Agent key (any scope) and 1. the screen belongs to this host.
  const agentKey = agentKeyOf(req);
  if (!agentKey) return relay(res, 401, { code: "AGENT_KEY_REQUIRED", message: "Send Authorization: Bearer <agent key>" });
  let auth: ReportAuth;
  try {
    const r = await convex<ReportAuth>("POST", "/internal/a2a/reports/authorize", { agentKey, workspaceId, billboardId });
    if (!r.ok) {
      log(traceId, "report.refused", { code: r.error.code });
      return relay(res, r.status, r.error);
    }
    auth = r.body;
  } catch (error) {
    log(traceId, "report.authorize_failed", { error: String(error) });
    return res.status(502).json({ error: { code: "CONVEX_UNAVAILABLE", message: "Try again" } });
  }
  const paymentHeader = paymentHeaderOf(req);
  log(traceId, "request", { paid: Boolean(paymentHeader), agent: auth.actor });

  let report: Record<string, unknown> | null = null;
  await withLock(`report:${auth.agentKeyId}:${billboardId}`, Boolean(paymentHeader), res, traceId, () =>
    runPaid(req, res, {
      traceId,
      paymentHeader,
      charge: {
        amountMinor: REPORT_PRICE_MINOR,
        payTo: auth.payTo,
        unpaid: {
          product: "audience_report",
          billboardId,
          amountMinor: REPORT_PRICE_MINOR,
          price: centsToUsd(REPORT_PRICE_MINOR),
          asset: "USDC",
          network: NETWORK,
          contents: ["trailing 2h crowd", "peak in view", "audience mix", "upcoming events", "recent clearing prices"],
        },
      },
      // 3. Price unchanged, key still valid, and the report can be produced: only then settle.
      recheck: async (amountMinor) => {
        if (amountMinor !== REPORT_PRICE_MINOR) {
          return { ok: false, status: 409, body: { error: "PRICE_CHANGED", message: `Report costs ${centsToUsd(REPORT_PRICE_MINOR)}.` } };
        }
        const again = await convex<ReportAuth>("POST", "/internal/a2a/reports/authorize", { agentKey, workspaceId, billboardId });
        if (!again.ok) return { ok: false, status: again.status, body: { error: again.error.code ?? "REFUSED", message: again.error.message ?? "" } };
        const r = await convex<Record<string, unknown>>(
          "GET",
          `/internal/a2a/reports/audience?workspaceId=${encodeURIComponent(workspaceId)}&billboardId=${encodeURIComponent(billboardId)}`,
        );
        if (!r.ok) return { ok: false, status: r.status, body: { error: r.error.code ?? "REPORT_UNAVAILABLE", message: r.error.message ?? "" } };
        report = r.body;
        return { ok: true };
      },
      // 5. Record the data sale (idempotent on tx hash), 6. deliver the report.
      record: async (settled) => {
        const { status, result } = await postWithRetry<{ dataSaleId?: string; replayed?: boolean; error?: ConvexError }>("/internal/a2a/data-sales", {
          agentKey,
          workspaceId,
          billboardId,
          amountMinor: settled.amountMinor,
          txHash: settled.transaction,
          network: settled.network,
          payer: settled.payer,
        });
        log(traceId, status === 200 ? "convex.data_sale_recorded" : "convex.data_sale_failed", { httpStatus: status, ...result });
        res.status(200).json({
          report,
          dataSaleId: result.dataSaleId ?? null,
          payment: { provider: "x402", ...settled },
        });
      },
    }),
  );
});

// ---------------------------------------------------------------- seller agent: negotiations (free, agent key)

async function proxyNegotiation(req: Request, res: Response, path: string, body: Record<string, unknown>, okStatus = 200) {
  const agentKey = agentKeyOf(req);
  if (!agentKey) return relay(res, 401, { code: "AGENT_KEY_REQUIRED", message: "Send Authorization: Bearer <agent key>" });
  try {
    const r = await convex<Record<string, unknown>>("POST", path, { ...body, agentKey });
    if (!r.ok) return relay(res, r.status, r.error);
    res.status(okStatus).json(r.body);
  } catch (error) {
    log(`a2a:${path}`, "negotiation.proxy_failed", { error: String(error) });
    res.status(502).json({ error: { code: "CONVEX_UNAVAILABLE", message: "Try again" } });
  }
}

const bodyOf = (req: Request) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {});

app.post("/a2a/hosts/:workspaceId/negotiations", (req: Request<{ workspaceId: string }>, res: Response) => {
  const b = bodyOf(req);
  return proxyNegotiation(
    req,
    res,
    "/internal/a2a/negotiations",
    { workspaceId: req.params.workspaceId, campaignId: b.campaignId, slotIds: b.slotIds, amountMinor: b.amountMinor, reasoning: b.reasoning },
    201,
  );
});

app.get("/a2a/hosts/:workspaceId/negotiations/:id", (req: Request<{ workspaceId: string; id: string }>, res: Response) =>
  proxyNegotiation(req, res, "/internal/a2a/negotiations/get", { workspaceId: req.params.workspaceId, negotiationId: req.params.id }),
);

app.post("/a2a/hosts/:workspaceId/negotiations/:id/messages", (req: Request<{ workspaceId: string; id: string }>, res: Response) => {
  const b = bodyOf(req);
  return proxyNegotiation(req, res, "/internal/a2a/negotiations/messages", {
    workspaceId: req.params.workspaceId,
    negotiationId: req.params.id,
    kind: b.kind,
    amountMinor: b.amountMinor,
    reasoning: b.reasoning,
  });
});

app.listen(PORT, () => {
  console.log(
    [
      `BillboardOS x402 server on http://localhost:${PORT}`,
      `  paid         ${ROUTE_PURCHASE} (hold amount)`,
      `               ${ROUTE_HOST_PURCHASE} (hold amount, hold must belong to the host)`,
      `               ${ROUTE_REPORT} (${centsToUsd(REPORT_PRICE_MINOR)})`,
      `  free         GET /a2a/hosts/:workspaceId/agent.json, negotiations (agent key)`,
      `  network      ${NETWORK} (${ENVIRONMENT})`,
      `  payTo        workspace payout address, else ${payTo} (${PAY_TO ? "X402_PAY_TO" : `CDP wallet "${RECEIVER_WALLET_NAME}"`})`,
      `  facilitator  CDP (CDP_API_KEY_ID ${presence("CDP_API_KEY_ID")}, CDP_API_KEY_SECRET ${presence("CDP_API_KEY_SECRET")})`,
      `  convex       ${CONVEX_SITE_URL}`,
      `  public url   ${PUBLIC_URL} (X402_PUBLIC_URL)`,
      `  cors         ${CORS_ORIGIN}`,
    ].join("\n"),
  );
});
