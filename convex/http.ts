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

export default http;
