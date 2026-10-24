import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { env, httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";

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

const PROVIDERS = ["x402", "nessie", "manual"] as const;
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
          "Expected { holdId: string, provider: x402|nessie|manual, externalRef: string, amountMinor: integer, asset: string, network?: string, idempotencyKey: string }",
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
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/agent\//, "").replace(/\/$/, "");
  const q = url.searchParams;
  try {
    if (path === "me") return json(200, await ctx.runMutation(internal.agentApi.me, { token }));
    if (path === "inventory") {
      const hours = q.get("hours");
      return json(
        200,
        await ctx.runMutation(internal.agentApi.inventory, {
          token,
          campaignId: q.get("campaignId") ?? undefined,
          billboardId: q.get("billboardId") ?? undefined,
          hours: hours === null ? undefined : Number(hours),
        }),
      );
    }
    if (path === "alerts") {
      const since = q.get("since");
      const limit = q.get("limit");
      return json(
        200,
        await ctx.runMutation(internal.agentApi.alerts, {
          token,
          since: since === null ? undefined : Number(since),
          limit: limit === null ? undefined : Number(limit),
        }),
      );
    }
    const status = /^auctions\/([^/]+)\/status$/.exec(path);
    if (status) {
      const campaignId = q.get("campaignId");
      const bidderKey = request.headers.get("X-Bidder-Key") ?? q.get("bidderKey");
      if (!campaignId || !bidderKey) return missing(["campaignId (query)", "X-Bidder-Key (header)"]);
      return json(
        200,
        await ctx.runMutation(internal.agentApi.auctionStatus, { token, auctionId: status[1], campaignId, bidderKey }),
      );
    }
    return agentError(404, "NOT_FOUND", `No agent endpoint GET /api/agent/${path}`);
  } catch (error) {
    return errorResponse(error);
  }
});

const agentPost = httpAction(async (ctx, request) => {
  const token = bearer(request);
  if (!token) return agentError(401, "INVALID_KEY", "Send Authorization: Bearer <agent key>");
  const path = new URL(request.url).pathname.replace(/^\/api\/agent\//, "").replace(/\/$/, "");
  const ack = /^alerts\/([^/]+)\/ack$/.exec(path);
  if (ack) {
    try {
      return json(200, await ctx.runMutation(internal.agentApi.ackAlert, { token, alertId: ack[1] }));
    } catch (error) {
      return errorResponse(error);
    }
  }
  const body = await readJson(request);
  if (body instanceof Response) return body;
  try {
    if (path === "quotes") {
      const campaignId = str(body.campaignId);
      const slotIds = Array.isArray(body.slotIds) && body.slotIds.every((x) => typeof x === "string") ? (body.slotIds as string[]) : undefined;
      if (!campaignId || !slotIds) return missing(["campaignId", "slotIds[]"]);
      return json(201, await ctx.runMutation(internal.agentApi.quote, { token, campaignId, slotIds }));
    }
    if (path === "holds") {
      const quoteId = str(body.quoteId);
      const idempotencyKey = str(body.idempotencyKey);
      if (!quoteId || !idempotencyKey) return missing(["quoteId", "idempotencyKey"]);
      const result = await ctx.runMutation(internal.agentApi.hold, { token, quoteId, idempotencyKey });
      return json(result.replayed ? 200 : 201, result);
    }
    const action = /^auctions\/([^/]+)\/(join|bid|auto-bid)$/.exec(path);
    if (action) {
      const [, auctionId, verb] = action;
      const campaignId = str(body.campaignId);
      if (!campaignId) return missing(["campaignId"]);
      if (verb === "join") {
        return json(
          200,
          await ctx.runMutation(internal.agentApi.auctionJoin, { token, auctionId, campaignId, clientKey: str(body.clientKey) }),
        );
      }
      const bidderKey = str(body.bidderKey);
      if (verb === "bid") {
        const amountMinor = num(body.amountMinor);
        if (!bidderKey || amountMinor === undefined) return missing(["campaignId", "bidderKey", "amountMinor"]);
        return json(200, await ctx.runMutation(internal.agentApi.auctionBid, { token, auctionId, campaignId, bidderKey, amountMinor }));
      }
      const maxMinor = num(body.maxMinor);
      if (!bidderKey || maxMinor === undefined) return missing(["campaignId", "bidderKey", "maxMinor"]);
      return json(200, await ctx.runMutation(internal.agentApi.auctionAutoBid, { token, auctionId, campaignId, bidderKey, maxMinor }));
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
 *   POST /internal/a2a/negotiations        { agentKey, workspaceId, campaignId, slotIds[], amountMinor?, reasoning? }
 *   POST /internal/a2a/negotiations/get    { agentKey, workspaceId, negotiationId }
 *   POST /internal/a2a/negotiations/messages { agentKey, workspaceId, negotiationId, kind, amountMinor?, reasoning? }
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
    if (path === "negotiations") {
      const campaignId = str(body.campaignId);
      const slotIds = Array.isArray(body.slotIds) && body.slotIds.every((x) => typeof x === "string") ? (body.slotIds as string[]) : undefined;
      if (!campaignId || !slotIds) return missing(["campaignId", "slotIds[]"]);
      if (body.amountMinor !== undefined && num(body.amountMinor) === undefined) return missing(["amountMinor (number)"]);
      return json(
        201,
        await ctx.runMutation(internal.negotiations.open, {
          token,
          workspaceId,
          campaignId,
          slotIds,
          amountMinor: num(body.amountMinor),
          reasoning: str(body.reasoning),
        }),
      );
    }
    const negotiationId = str(body.negotiationId);
    if (path === "negotiations/get") {
      if (!negotiationId) return missing(["negotiationId"]);
      return json(200, await ctx.runMutation(internal.negotiations.get, { token, workspaceId, negotiationId }));
    }
    if (path === "negotiations/messages") {
      const kind = str(body.kind);
      if (!negotiationId || (kind !== "offer" && kind !== "accept" && kind !== "reject")) {
        return missing(["negotiationId", "kind (offer | accept | reject)"]);
      }
      if (body.amountMinor !== undefined && num(body.amountMinor) === undefined) return missing(["amountMinor (number)"]);
      return json(
        200,
        await ctx.runMutation(internal.negotiations.post, {
          token,
          workspaceId,
          negotiationId,
          kind,
          amountMinor: num(body.amountMinor),
          reasoning: str(body.reasoning),
        }),
      );
    }
    return agentError(404, "NOT_FOUND", `No endpoint POST /internal/a2a/${path}`);
  } catch (error) {
    return errorResponse(error);
  }
});

http.route({ pathPrefix: "/internal/a2a/", method: "GET", handler: a2aGet });
http.route({ pathPrefix: "/internal/a2a/", method: "POST", handler: a2aPost });

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

export default http;
