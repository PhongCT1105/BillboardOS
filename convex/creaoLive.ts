import { v } from "convex/values";
import { env, internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { creaoRateLimiter } from "./creaoLimits";

const ORIGIN = "https://agent.creao.ai";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INPUT_BYTES = 200_000;
const MAX_RESULT_BYTES = 1_000_000;
const MAX_RUN_MS = 4 * 60_000;
const roleValidator = v.union(
  v.literal("company_research"),
  v.literal("screen_audience"),
  v.literal("creative_safety"),
  v.literal("price_refine"),
  v.literal("invite_rotate"),
  v.literal("opportunity_strategy"),
);
type Role =
  | "company_research"
  | "screen_audience"
  | "creative_safety"
  | "price_refine"
  | "invite_rotate"
  | "opportunity_strategy";
type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configuration(role: Role): { agentId: string; key: string } | null {
  const values = {
    company_research: [env.CREAO_COMPANY_RESEARCH_AGENT_ID, env.CREAO_COMPANY_RESEARCH_API_KEY],
    screen_audience: [env.CREAO_SCREEN_AUDIENCE_AGENT_ID, env.CREAO_SCREEN_AUDIENCE_API_KEY],
    creative_safety: [env.CREAO_CREATIVE_SAFETY_AGENT_ID, env.CREAO_CREATIVE_SAFETY_API_KEY],
    price_refine: [env.CREAO_PRICE_REFINE_AGENT_ID, env.CREAO_PRICE_REFINE_API_KEY],
    invite_rotate: [env.CREAO_INVITE_ROTATE_AGENT_ID, env.CREAO_INVITE_ROTATE_API_KEY],
    opportunity_strategy: [env.CREAO_OPPORTUNITY_STRATEGY_AGENT_ID, env.CREAO_OPPORTUNITY_STRATEGY_API_KEY],
  }[role];
  const [agentId, key] = values;
  if (!agentId && !key) return null;
  if (!agentId || !UUID.test(agentId) || !key?.startsWith("capi_")) {
    throw new Error(`CREAO ${role} needs a saved agent UUID and its app-scoped capi_ key`);
  }
  return { agentId, key };
}

async function json(url: string, key: string, method: "GET" | "POST", body?: unknown): Promise<JsonObject> {
  const response = await fetch(url, {
    method,
    redirect: "error",
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`CREAO returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!object(value)) throw new Error("CREAO returned an invalid response");
  return value;
}

async function resultOf(run: JsonObject, role: Role, runId: string, key: string): Promise<JsonObject> {
  const result = object(run.result) ? run.result : {};
  const title = `${role.replaceAll("_", "-")}-result.json`;
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  const matches = artifacts.filter((item) => object(item) && item.title === title && item.type === "application/json");
  if (matches.length > 1) throw new Error("CREAO returned duplicate result artifacts");
  if (matches.length === 1) {
    const artifact = matches[0] as JsonObject;
    if (typeof artifact.url !== "string" || typeof artifact.id !== "string") throw new Error("CREAO artifact is incomplete");
    const url = new URL(artifact.url);
    if (url.origin !== ORIGIN || url.pathname !== `/api/v1/runs/${runId}/artifacts/download` || url.searchParams.get("artifactId") !== artifact.id) {
      throw new Error("CREAO artifact does not belong to this run");
    }
    let response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, redirect: "manual", signal: AbortSignal.timeout(25_000) });
    if (response.status === 302) {
      const location = response.headers.get("location");
      if (!location) throw new Error("CREAO artifact redirect has no destination");
      const signed = new URL(location);
      if (signed.protocol !== "https:" || signed.username || signed.password) throw new Error("CREAO artifact redirect is invalid");
      response = await fetch(signed, { redirect: "error", signal: AbortSignal.timeout(25_000) });
    }
    if (!response.ok) throw new Error(`CREAO artifact returned HTTP ${response.status}`);
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_RESULT_BYTES) throw new Error("CREAO result exceeds 1 MB");
    const parsed: unknown = JSON.parse(raw);
    if (object(parsed)) return parsed;
  }
  for (const candidate of [result.text, result.chatText]) {
    if (typeof candidate !== "string" || new TextEncoder().encode(candidate).byteLength > MAX_RESULT_BYTES) continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (object(parsed)) return parsed;
    } catch { /* Require a complete JSON object, not prose. */ }
  }
  throw new Error(`CREAO completed without ${title}`);
}

/** Consume one CREAO start credit (mutations only — transactional with rate limiter). */
export const consumeStart = internalMutation({
  args: {},
  returns: v.object({ ok: v.boolean(), retryAfter: v.optional(v.number()) }),
  handler: async (ctx) => {
    const status = await creaoRateLimiter.limit(ctx, "creaoStart", { throws: false });
    return status.ok ? { ok: true } : { ok: false, retryAfter: status.retryAfter };
  },
});

/** One background job. A missing role configuration leaves the existing provider in place. */
export const run = internalAction({
  args: { role: roleValidator, requestJson: v.string() },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { role, requestJson }): Promise<JsonObject | null> => {
    const config = configuration(role);
    if (!config) return null;
    const budget = await ctx.runMutation(internal.creaoLive.consumeStart, {});
    if (!budget.ok) throw new Error(`CREAO rate-limited${budget.retryAfter ? ` for ${budget.retryAfter}ms` : ""}`);
    if (new TextEncoder().encode(requestJson).byteLength > MAX_INPUT_BYTES) throw new Error("CREAO input exceeds 200 KB");
    const request: unknown = JSON.parse(requestJson);
    if (!object(request) || request.schemaVersion !== 1 || typeof request.traceId !== "string") throw new Error("Invalid CREAO request");
    const url = `${ORIGIN}/api/v1/apps/${config.agentId}/runs`;
    const created = await json(url, config.key, "POST", { inputs: { request_json: requestJson } });
    if (typeof created.id !== "string" || !UUID.test(created.id)) throw new Error("CREAO did not return a run ID");
    const deadline = Date.now() + MAX_RUN_MS;
    while (Date.now() < deadline) {
      const status = await json(`${url}/${created.id}`, config.key, "GET");
      if (status.status === "failed" || status.status === "cancelled") throw new Error(`CREAO run ${status.status}`);
      if (status.status === "completed") {
        const result = await resultOf(status, role, created.id, config.key);
        if (result.schemaVersion !== 1 || result.role !== role || result.traceId !== request.traceId) {
          throw new Error("CREAO result identity does not match this request");
        }
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    throw new Error(`CREAO run ${created.id} exceeded four minutes; inspect it before retrying`);
  },
});
