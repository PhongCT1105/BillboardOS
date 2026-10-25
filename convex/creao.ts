import { v } from "convex/values";
import { action, env } from "./_generated/server";

const roleValidator = v.union(v.literal("sales"), v.literal("revenue"));
const phaseValidator = v.union(v.literal("qualify"), v.literal("prepare_outreach"));
const CREAO_ORIGIN = "https://agent.creao.ai";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INPUT_BYTES = 200_000;
const MAX_RESULT_BYTES = 1_000_000;

type Role = "sales" | "revenue";
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configFor(role: Role) {
  const agentId = role === "sales" ? env.CREAO_SALES_AGENT_ID : env.CREAO_REVENUE_AGENT_ID;
  const key = role === "sales" ? env.CREAO_SALES_API_KEY : env.CREAO_REVENUE_API_KEY;
  const baseUrl = (env.CREAO_API_BASE_URL || CREAO_ORIGIN).replace(/\/+$/, "");

  if (!agentId || !UUID.test(agentId)) throw new Error("The CREAO " + role + " agent ID is not configured.");
  if (!key?.startsWith("capi_")) throw new Error("The CREAO " + role + " server key is not configured.");
  try {
    if (new URL(baseUrl).origin !== CREAO_ORIGIN) throw new Error("CREAO API URL must use agent.creao.ai.");
  } catch {
    throw new Error("The CREAO API URL is invalid.");
  }

  return { agentId, key, baseUrl };
}

function validateRequest(role: Role, requestJson: string): JsonObject {
  if (new TextEncoder().encode(requestJson).byteLength > MAX_INPUT_BYTES) {
    throw new Error("CREAO input exceeds 200 KB.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(requestJson);
  } catch {
    throw new Error("request_json must contain valid JSON.");
  }
  if (!isObject(parsed) || parsed.schemaVersion !== 1 || typeof parsed.traceId !== "string" || !isObject(parsed.snapshot)) {
    throw new Error("request_json needs schemaVersion: 1, traceId, and a snapshot object.");
  }
  if (typeof parsed.snapshot.id !== "string") throw new Error("snapshot.id is required.");

  if (role === "sales") {
    if (parsed.phase !== "qualify" && parsed.phase !== "prepare_outreach") {
      throw new Error("Sales phase must be qualify or prepare_outreach.");
    }
    if (parsed.phase === "prepare_outreach" && !isObject(parsed.revenuePlan)) {
      throw new Error("Sales prepare_outreach requires a revenuePlan.");
    }
  } else {
    const salesResult = parsed.salesResult;
    if (
      !isObject(salesResult) ||
      salesResult.role !== "sales" ||
      salesResult.traceId !== parsed.traceId ||
      salesResult.snapshotId !== parsed.snapshot.id
    ) {
      throw new Error("Revenue requires the matching Sales result in salesResult.");
    }
  }

  return parsed;
}

async function creaoJson(url: string, key: string, method: "GET" | "POST", body?: unknown): Promise<JsonObject> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      redirect: "error",
      headers: {
        Authorization: "Bearer " + key,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new Error("Could not reach CREAO. Try again shortly.");
  }

  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = isObject(value) && typeof value.error === "string" && /^[A-Z0-9_]{1,80}$/.test(value.error)
      ? " (" + value.error + ")"
      : "";
    throw new Error("CREAO returned HTTP " + response.status + code + ". Check the saved agent and server key.");
  }
  if (!isObject(value)) throw new Error("CREAO returned an invalid response.");
  return value;
}

async function artifactResult(run: JsonObject, role: Role, runId: string, key: string, baseUrl: string): Promise<JsonObject> {
  const result = isObject(run.result) ? run.result : {};
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  const expectedTitle = role + "-result.json";
  const matches = artifacts.filter((item) => isObject(item) && item.title === expectedTitle && item.type === "application/json");
  if (matches.length > 1) throw new Error("CREAO returned multiple result artifacts.");

  if (matches.length === 1) {
    const artifact = matches[0] as JsonObject;
    if (typeof artifact.url !== "string" || typeof artifact.id !== "string") {
      throw new Error("CREAO returned an incomplete result artifact.");
    }
    let artifactUrl: URL;
    try {
      artifactUrl = new URL(artifact.url);
    } catch {
      throw new Error("CREAO returned an invalid result artifact URL.");
    }
    const expectedPath = "/api/v1/runs/" + runId + "/artifacts/download";
    if (
      artifactUrl.origin !== new URL(baseUrl).origin ||
      artifactUrl.pathname !== expectedPath ||
      artifactUrl.searchParams.get("artifactId") !== artifact.id
    ) {
      throw new Error("CREAO result artifact did not match this run.");
    }

    let response = await fetch(artifactUrl, {
      headers: { Authorization: "Bearer " + key },
      redirect: "manual",
      signal: AbortSignal.timeout(25_000),
    });
    if (response.status === 302) {
      const location = response.headers.get("location");
      if (!location) throw new Error("CREAO artifact redirect has no destination.");
      let storageUrl: URL;
      try {
        storageUrl = new URL(location);
      } catch {
        throw new Error("CREAO artifact redirect is invalid.");
      }
      if (storageUrl.protocol !== "https:" || storageUrl.username || storageUrl.password) {
        throw new Error("CREAO artifact redirect must use HTTPS.");
      }
      // The CREAO bearer key is deliberately not forwarded to signed storage URLs.
      response = await fetch(storageUrl, { redirect: "error", signal: AbortSignal.timeout(25_000) });
    }
    if (!response.ok) throw new Error("CREAO result download returned HTTP " + response.status + ".");
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_RESULT_BYTES) throw new Error("CREAO result exceeds 1 MB.");
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObject(parsed)) return parsed;
    } catch {
      // Fall through to the explicit JSON result fields below.
    }
  }

  for (const candidate of [result.text, result.chatText]) {
    if (typeof candidate !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (isObject(parsed)) return parsed;
    } catch {
      // Only accept a complete JSON response, never a scraped prose fragment.
    }
  }
  throw new Error("CREAO completed without a machine-readable " + expectedTitle + " result.");
}

export const startRun = action({
  args: { role: roleValidator, requestJson: v.string() },
  returns: v.object({ runId: v.string(), status: v.string() }),
  handler: async (_ctx, args) => {
    const request = validateRequest(args.role, args.requestJson);
    const { agentId, key, baseUrl } = configFor(args.role);
    const runsUrl = baseUrl + "/api/v1/apps/" + agentId + "/runs";
    const created = await creaoJson(runsUrl, key, "POST", {
      inputs: { request_json: JSON.stringify(request) },
    });
    if (typeof created.id !== "string" || !UUID.test(created.id)) {
      throw new Error("CREAO did not return a valid run ID. Check Sessions before starting another run.");
    }
    return { runId: created.id, status: typeof created.status === "string" ? created.status : "queued" };
  },
});

export const getRun = action({
  args: {
    role: roleValidator,
    runId: v.string(),
    traceId: v.string(),
    snapshotId: v.string(),
    phase: v.union(phaseValidator, v.null()),
  },
  returns: v.object({
    runId: v.string(),
    status: v.string(),
    result: v.any(),
    error: v.union(v.string(), v.null()),
  }),
  handler: async (_ctx, args) => {
    if (!UUID.test(args.runId)) throw new Error("runId must be a CREAO run UUID.");
    const { agentId, key, baseUrl } = configFor(args.role);
    const run = await creaoJson(
      baseUrl + "/api/v1/apps/" + agentId + "/runs/" + args.runId,
      key,
      "GET",
    );
    const status = typeof run.status === "string" ? run.status : "unknown";
    if (status === "failed" || status === "cancelled") {
      return { runId: args.runId, status, result: null, error: "The CREAO run " + status + ". Inspect it in CREAO." };
    }
    if (status !== "completed") return { runId: args.runId, status, result: null, error: null };

    try {
      const result = await artifactResult(run, args.role, args.runId, key, baseUrl);
      if (
        result.schemaVersion !== 1 ||
        result.role !== args.role ||
        result.traceId !== args.traceId ||
        result.snapshotId !== args.snapshotId ||
        (args.role === "sales" && result.phase !== args.phase)
      ) {
        throw new Error("CREAO result identity did not match this request.");
      }
      return { runId: args.runId, status, result, error: null };
    } catch (error) {
      return {
        runId: args.runId,
        status: "invalid_result",
        result: null,
        error: error instanceof Error ? error.message : "CREAO returned an invalid result.",
      };
    }
  },
});
