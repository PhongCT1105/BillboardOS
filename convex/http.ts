import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { env, httpAction, type ActionCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { auth } from "./auth";
import { buildAgentCard } from "./lib/x402/agentCard";
import { centsToUsd, decimalToCents } from "./lib/x402/money";

/**
 * Internal HTTP surface for the Express x402 payment server.
 * Every route requires `Authorization: Bearer <INTERNAL_API_SECRET>`.
 */
const http = httpRouter();

// Convex Auth (operator sign-in): OAuth/JWKS discovery routes.
auth.addHttpRoutes(http);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Length-independent constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Returns an error Response if the request is not authorized, else null. */
function checkAuth(request: Request): Response | null {
  const secret = env.INTERNAL_API_SECRET;
  if (!secret) {
    // Fail closed: never accept payment reports without a configured secret.
    return json(503, { error: "INTERNAL_API_SECRET not configured" });
  }
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match || !safeEqual(match[1], secret)) {
    return json(401, { error: "unauthorized" });
  }
  return null;
}

const PROVIDERS = ["x402", "nessie"] as const;
type Provider = (typeof PROVIDERS)[number];

function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * POST /internal/payments/verified
 * Body: { holdId, provider, externalRef, amountMinor, asset, network?, idempotencyKey }
 * 200 -> { outcome: "booked" | "exception", ... }  (payment recorded; replays return the original)
 * 400 / 404 -> { outcome: "rejected", code, message } (nothing recorded)
 */
http.route({
  path: "/internal/payments/verified",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = checkAuth(request);
    if (denied) return denied;

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await request.json();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return json(400, { outcome: "rejected", code: "INVALID_INPUT", message: "Body must be a JSON object" });
    }

    const { holdId, provider, externalRef, amountMinor, asset, network, idempotencyKey } = body;
    if (
      typeof holdId !== "string" ||
      !isProvider(provider) ||
      typeof externalRef !== "string" ||
      typeof amountMinor !== "number" ||
      typeof asset !== "string" ||
      (network !== undefined && network !== null && typeof network !== "string") ||
      typeof idempotencyKey !== "string"
    ) {
      return json(400, {
        outcome: "rejected",
        code: "INVALID_INPUT",
        message:
          "Expected { holdId: string, provider: x402|nessie, externalRef: string, amountMinor: integer, asset: string, network?: string, idempotencyKey: string }",
      });
    }

    try {
      const result = await ctx.runMutation(internal.payments.recordVerified, {
        holdId,
        provider,
        externalRef,
        amountMinor,
        asset,
        network: typeof network === "string" ? network : undefined,
        idempotencyKey,
      });
      if (result.outcome === "rejected") {
        return json(result.code === "HOLD_NOT_FOUND" ? 404 : 400, result);
      }
      return json(200, result);
    } catch (error) {
      if (error instanceof ConvexError) {
        return json(400, { outcome: "rejected", code: "INVALID_INPUT", message: String(error.data) });
      }
      console.error("recordVerified failed", error);
      return json(500, { error: "internal error" });
    }
  }),
});

/**
 * GET /internal/holds?holdId=<id>
 * What the payment server needs to issue x402 payment requirements.
 */
http.route({
  path: "/internal/holds",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const denied = checkAuth(request);
    if (denied) return denied;
    const holdId = new URL(request.url).searchParams.get("holdId");
    if (!holdId || holdId.length > 64) {
      return json(400, { error: "holdId query parameter required" });
    }
    const hold = await ctx.runQuery(internal.holds.getForPayment, { holdId });
    if (!hold) return json(404, { error: "hold not found" });
    return json(200, hold);
  }),
});

// ---------------------------------------------------------------------------
// Agent API (ADR 0004): Authorization: Bearer bos_agent_..., JSON in/out,
// errors as { error: { code, message, ...details } }.
// ---------------------------------------------------------------------------

const STATUS_FOR_CODE: Record<string, number> = {
  INVALID_KEY: 401,
  KEY_REVOKED: 401,
  KEY_EXPIRED: 401,
  SCOPE_MISSING: 403,
  NOT_COMPANY_MEMBER: 403,
  CAMPAIGN_NOT_ALLOWED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INVALID_INPUT: 400,
  BUDGET_CAP: 409,
  BUDGET_EXCEEDED: 409,
  SLOT_UNAVAILABLE: 409,
  AUCTION_OPEN: 409,
  AUCTION_CLOSED: 409,
  BID_TOO_LOW: 409,
  ALREADY_LEADING: 409,
  AUTO_BID_TOO_LOW: 409,
  ALREADY_JOINED: 409,
  QUOTE_NOT_OPEN: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  CAMPAIGN_CLOSED: 409,
  BILLBOARD_OFFLINE: 409,
  NEGOTIATION_CLOSED: 409,
  MAX_ROUNDS: 409,
  OFFER_CLOSED: 409,
  NOT_BIDDING: 409,
  BIDDING_CLOSED: 409,
  BID_LIMIT: 409,
  ALREADY_REPLIED: 409,
  STANDING_INSTRUCTIONS: 409,
};

function agentError(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { error: { code, message, ...extra } });
}

/** Map a thrown error to a structured HTTP response (never leaks internals). */
function errorResponse(error: unknown): Response {
  if (error instanceof ConvexError) {
    const data = error.data as { code?: string; message?: string } & Record<string, unknown>;
    const code = typeof data === "object" && data?.code ? data.code : "BAD_REQUEST";
    const { code: _c, message, ...extra } = typeof data === "object" && data ? data : { message: String(data) };
    return agentError(STATUS_FOR_CODE[code] ?? 400, code, String(message ?? code), extra);
  }
  console.error("agent API error", error);
  return agentError(500, "INTERNAL", "Internal error");
}

function bearer(request: Request): string | null {
  const match = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
  return match ? match[1].trim() : null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    return agentError(400, "INVALID_INPUT", "Body must be a JSON object");
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function missing(fields: string[]): Response {
  return agentError(400, "INVALID_INPUT", `Required: ${fields.join(", ")}`);
}

const agentGet = httpAction(async (ctx, request) => {
  const token = bearer(request);
  if (!token) return agentError(401, "INVALID_KEY", "Send Authorization: Bearer <agent key>");
  const path = new URL(request.url).pathname.replace(/^\/api\/agent\//, "").replace(/\/$/, "");
  try {
    if (path === "me") return json(200, await ctx.runMutation(internal.agentApi.me, { token }));
    return agentError(404, "NOT_FOUND", `No agent endpoint GET /api/agent/${path}`);
  } catch (error) {
    return errorResponse(error);
  }
});

const agentPost = httpAction(async (ctx, request) => {
  const token = bearer(request);
  if (!token) return agentError(401, "INVALID_KEY", "Send Authorization: Bearer <agent key>");
  const path = new URL(request.url).pathname.replace(/^\/api\/agent\//, "").replace(/\/$/, "");
  const body = await readJson(request);
  if (body instanceof Response) return body;
  try {
    const roundBid = /^rounds\/([^/]+)\/bid$/.exec(path);
    if (roundBid) {
      // An offer in whole cents (at or above the host's price accepts, below it counters), or null (or nothing) to pass.
      const amountMinor = body.amountMinor === null || body.amountMinor === undefined ? null : num(body.amountMinor);
      if (amountMinor === undefined) return missing(["amountMinor (number, or null to pass)"]);
      return json(
        200,
        await ctx.runMutation(internal.rounds.submitBid, { token, roundId: roundBid[1], amountMinor, reasoning: str(body.reasoning) }),
      );
    }
    return agentError(404, "NOT_FOUND", `No agent endpoint POST /api/agent/${path}`);
  } catch (error) {
    return errorResponse(error);
  }
});

/**
 * Seller agent back end for the x402 server (ADR 0005). Bearer
 * INTERNAL_API_SECRET; the buyer's agent key travels in the body/query as
 * `agentKey` and is checked here. Errors as { error: { code, message } }.
 *
 *   GET  /internal/a2a/agent-card?workspaceId=
 *   POST /internal/a2a/reports/authorize   { agentKey, workspaceId, billboardId }
 *   GET  /internal/a2a/reports/audience?workspaceId=&billboardId=
 *   POST /internal/a2a/data-sales          { agentKey, workspaceId, billboardId, amountMinor, txHash, network, payer? }
 */
const a2aGet = httpAction(async (ctx, request) => {
  const denied = checkAuth(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/internal\/a2a\//, "").replace(/\/$/, "");
  const q = url.searchParams;
  try {
    const workspaceId = q.get("workspaceId");
    if (!workspaceId) return missing(["workspaceId"]);
    if (path === "agent-card") return json(200, await ctx.runQuery(internal.a2a.agentCard, { workspaceId }));
    if (path === "reports/audience") {
      const billboardId = q.get("billboardId");
      if (!billboardId) return missing(["billboardId"]);
      return json(200, await ctx.runQuery(internal.a2a.audienceReport, { workspaceId, billboardId }));
    }
    return agentError(404, "NOT_FOUND", `No endpoint GET /internal/a2a/${path}`);
  } catch (error) {
    return errorResponse(error);
  }
});

const a2aPost = httpAction(async (ctx, request) => {
  const denied = checkAuth(request);
  if (denied) return denied;
  const path = new URL(request.url).pathname.replace(/^\/internal\/a2a\//, "").replace(/\/$/, "");
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const token = str(body.agentKey);
  const workspaceId = str(body.workspaceId);
  if (!token || !workspaceId) return missing(["agentKey", "workspaceId"]);
  try {
    if (path === "reports/authorize") {
      const billboardId = str(body.billboardId);
      if (!billboardId) return missing(["billboardId"]);
      return json(200, await ctx.runMutation(internal.a2a.authorizeReport, { token, workspaceId, billboardId }));
    }
    if (path === "data-sales") {
      const billboardId = str(body.billboardId);
      const amountMinor = num(body.amountMinor);
      const txHash = str(body.txHash);
      const network = str(body.network);
      if (!billboardId || amountMinor === undefined || !txHash || !network) {
        return missing(["billboardId", "amountMinor", "txHash", "network"]);
      }
      return json(
        200,
        await ctx.runMutation(internal.a2a.recordDataSale, { token, workspaceId, billboardId, amountMinor, txHash, network, payer: str(body.payer) }),
      );
    }
    return agentError(404, "NOT_FOUND", `No endpoint POST /internal/a2a/${path}`);
  } catch (error) {
    return errorResponse(error);
  }
});

http.route({ pathPrefix: "/internal/a2a/", method: "GET", handler: a2aGet });
http.route({ pathPrefix: "/internal/a2a/", method: "POST", handler: a2aPost });

// ---------------------------------------------------------------------------
// x402 payment endpoints and seller agents, served by Convex (ADR 0006: one
// OS server). Same contracts as the retired Express server:
//   POST /purchases/{holdId}                                 x402, hold amount (any host)
//   POST /a2a/hosts/{workspaceId}/purchases/{holdId}         x402, hold amount (hold must be that host's)
//   GET  /a2a/hosts/{workspaceId}/reports/audience?billboardId=  x402, X402_REPORT_PRICE_USD (default $0.05)
//   GET  /a2a/hosts/{workspaceId}/agent.json                 free
// This file checks keys and looks things up; x402Node.ts (node) challenges,
// verifies with the CDP facilitator, re-checks, settles and records.
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9]{1,64}$/i;
const X402_NETWORK = () => process.env.X402_NETWORK || "eip155:84532";

function reportPriceMinor(): number {
  try {
    return decimalToCents(process.env.X402_REPORT_PRICE_USD || "0.05");
  } catch {
    return 5;
  }
}

function agentKeyOf(request: Request): string | null {
  return /^Bearer (bos_agent_\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1] ?? null;
}

/** Serializable copy of the request for the node action (only what x402 reads). */
function plainRequest(request: Request) {
  const headers: Record<string, string> = {};
  for (const name of ["payment-signature", "x-payment", "accept", "user-agent", "content-type"]) {
    const value = request.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { method: request.method, url: request.url, headers };
}

function fromPlain(r: { status: number; headers: Record<string, string>; body: unknown }): Response {
  return new Response(JSON.stringify(r.body ?? {}), {
    status: r.status,
    headers: { "Content-Type": "application/json", "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE", ...r.headers },
  });
}

async function payForHold(ctx: ActionCtx, request: Request, holdId: string, workspaceId: string | null): Promise<Response> {
  if (!ID_RE.test(holdId) || (workspaceId !== null && !ID_RE.test(workspaceId))) {
    return json(404, { error: "HOLD_NOT_FOUND", holdId });
  }
  // 0. Agent key: only the hold's company, with the "pay" scope. x402 uses
  //    PAYMENT-SIGNATURE / X-PAYMENT, so Authorization is free for the key.
  const agentKey = agentKeyOf(request);
  if (!agentKey) return json(401, { error: "AGENT_KEY_REQUIRED", message: "Send Authorization: Bearer <agent key with the pay scope>" });
  let actor: string;
  try {
    actor = (await ctx.runMutation(internal.agentApi.verifyPayment, { token: agentKey, holdId })).actor;
  } catch (error) {
    if (error instanceof ConvexError) {
      const data = error.data as { code?: string; message?: string };
      const status = STATUS_FOR_CODE[data.code ?? ""] ?? 403;
      return json(status === 404 ? 404 : status === 401 ? 401 : 403, { error: data.code ?? "FORBIDDEN", message: data.message ?? "Agent key not allowed to pay this hold" });
    }
    throw error;
  }
  // 1. Hold lookup, before any payment is requested.
  const hold = await ctx.runQuery(internal.holds.getForPayment, { holdId });
  if (!hold || (workspaceId !== null && hold.workspaceId !== workspaceId)) {
    return json(404, { error: "HOLD_NOT_FOUND", holdId, ...(workspaceId ? { message: "No such hold at this host" } : {}) });
  }
  if (!hold.payable) {
    return json(409, {
      error: "HOLD_NOT_PAYABLE",
      holdId,
      status: hold.status,
      expiresAt: hold.expiresAt,
      message: hold.status === "active" ? "Hold has expired; request a new quote and hold." : `Hold is ${hold.status}; nothing to pay.`,
    });
  }
  if (hold.currency !== "USD" || !Number.isSafeInteger(hold.amountMinor) || hold.amountMinor <= 0) {
    return json(409, { error: "HOLD_NOT_PRICEABLE", holdId });
  }
  const signed = Boolean(plainRequest(request).headers["payment-signature"] ?? plainRequest(request).headers["x-payment"]);
  console.log(`[x402] trace=${hold.traceId} request holdId=${holdId} agent=${actor} paid=${signed}`);
  const result = await ctx.runAction(internal.x402Node.payHold, {
    request: plainRequest(request),
    holdId: hold.holdId,
    traceId: hold.traceId,
    charge: {
      amountMinor: hold.amountMinor,
      payTo: hold.payTo,
      unpaid: { holdId: hold.holdId, amountMinor: hold.amountMinor, price: centsToUsd(hold.amountMinor), asset: "USDC", network: X402_NETWORK(), expiresAt: hold.expiresAt },
    },
  });
  return fromPlain(result);
}

const legacyPurchase = httpAction(async (ctx, request) => {
  const holdId = new URL(request.url).pathname.replace(/^\/purchases\//, "").replace(/\/$/, "");
  try {
    return await payForHold(ctx, request, holdId, null);
  } catch (error) {
    console.error("purchase failed", error);
    return json(500, { error: "INTERNAL_ERROR" });
  }
});

const hostsGet = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const m = /^\/a2a\/hosts\/([^/]+)\/(.+?)\/?$/.exec(url.pathname);
  if (!m || !ID_RE.test(m[1])) return agentError(404, "NOT_FOUND", "Host not found");
  const [, workspaceId, rest] = m;
  try {
    if (rest === "agent.json") {
      const card = await ctx.runQuery(internal.a2a.agentCard, { workspaceId });
      return json(
        200,
        buildAgentCard(card, {
          baseUrl: process.env.CONVEX_SITE_URL ?? url.origin,
          network: X402_NETWORK(),
          defaultPayTo: process.env.X402_PAY_TO?.trim() || null,
          reportPriceMinor: reportPriceMinor(),
        }),
      );
    }
    if (rest === "reports/audience") {
      const billboardId = url.searchParams.get("billboardId") ?? "";
      if (!ID_RE.test(billboardId)) return agentError(404, "NOT_FOUND", "Send ?billboardId= for one of this host's screens");
      // 0. Agent key (any scope) and 1. the screen belongs to this host.
      const agentKey = agentKeyOf(request);
      if (!agentKey) return agentError(401, "AGENT_KEY_REQUIRED", "Send Authorization: Bearer <agent key>");
      const auth = await ctx.runMutation(internal.a2a.authorizeReport, { token: agentKey, workspaceId, billboardId });
      const price = reportPriceMinor();
      const result = await ctx.runAction(internal.x402Node.payReport, {
        request: plainRequest(request),
        agentKey,
        agentKeyId: auth.agentKeyId,
        workspaceId,
        billboardId,
        charge: {
          amountMinor: price,
          payTo: auth.payTo,
          unpaid: {
            product: "audience_report",
            billboardId,
            amountMinor: price,
            price: centsToUsd(price),
            asset: "USDC",
            network: X402_NETWORK(),
            contents: ["trailing 2h crowd", "peak in view", "audience mix", "upcoming events", "recent clearing prices"],
          },
        },
      });
      return fromPlain(result);
    }
    return agentError(404, "NOT_FOUND", `No endpoint GET ${url.pathname}`);
  } catch (error) {
    return errorResponse(error);
  }
});

const hostsPost = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const m = /^\/a2a\/hosts\/([^/]+)\/(.+?)\/?$/.exec(url.pathname);
  if (!m || !ID_RE.test(m[1])) return agentError(404, "NOT_FOUND", "Host not found");
  const [, workspaceId, rest] = m;
  try {
    const purchase = /^purchases\/([^/]+)$/.exec(rest);
    if (purchase) return await payForHold(ctx, request, purchase[1], workspaceId);
    return agentError(404, "NOT_FOUND", `No endpoint POST ${url.pathname}`);
  } catch (error) {
    return errorResponse(error);
  }
});

http.route({ pathPrefix: "/purchases/", method: "POST", handler: legacyPurchase });

/**
 * POST /company-agents/{advertiserId}/webhook: the webhook receiver of the
 * company agents our server runs. Verifies the signature like any external
 * receiver, then lets the agent act asynchronously.
 */
http.route({
  pathPrefix: "/company-agents/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const m = /^\/company-agents\/([^/]+)\/webhook\/?$/.exec(new URL(request.url).pathname);
    if (!m) return json(404, { error: "not found" });
    const body = await request.text();
    if (body.length > 64 * 1024) return json(413, { error: "too large" });
    const verified = await ctx.runQuery(internal.companyAgents.verifyWebhook, {
      advertiserId: m[1],
      timestamp: request.headers.get("X-BillboardOS-Timestamp") ?? "",
      signature: request.headers.get("X-BillboardOS-Signature") ?? "",
      body,
    });
    if (!verified.ok) return json(401, { error: verified.reason });
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return json(400, { error: "body is not JSON" });
    }
    await ctx.runMutation(internal.companyAgents.enqueue, { advertiserId: verified.advertiserId, payload });
    return json(200, { ok: true });
  }),
});
http.route({ pathPrefix: "/a2a/hosts/", method: "GET", handler: hostsGet });
http.route({ pathPrefix: "/a2a/hosts/", method: "POST", handler: hostsPost });

http.route({ pathPrefix: "/api/agent/", method: "GET", handler: agentGet });
http.route({ pathPrefix: "/api/agent/", method: "POST", handler: agentPost });

/**
 * POST /internal/agent-keys/verify-payment (bearer INTERNAL_API_SECRET)
 * Body: { agentKey, holdId } -> 200 { agentKeyId, advertiserId, actor, holdId } or { error }.
 * The x402 server calls this before issuing a 402 challenge or settling.
 */
http.route({
  path: "/internal/agent-keys/verify-payment",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const denied = checkAuth(request);
    if (denied) return denied;
    const body = await readJson(request);
    if (body instanceof Response) return body;
    const agentKey = str(body.agentKey);
    const holdId = str(body.holdId);
    if (!agentKey || !holdId) return missing(["agentKey", "holdId"]);
    try {
      return json(200, await ctx.runMutation(internal.agentApi.verifyPayment, { token: agentKey, holdId }));
    } catch (error) {
      return errorResponse(error);
    }
  }),
});

// Website (Vite build uploaded by `npm run deploy:web`): everything not matched
// above. Registered last; exact and longer-prefix app routes win. SPA fallback
// serves index.html for client routes (the app uses hash routes anyway).
registerStaticRoutes(http, components.staticHosting);

export default http;
