/** Server-side smoke test for the two saved CREAO agents. No business writes. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
};
const role = option("agent");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const origin = "https://agent.creao.ai";

async function main() {
  if (role !== "sales" && role !== "revenue") throw new Error("Use --agent sales or --agent revenue.");
  let runId = option("run-id");
  let request;
  if (!runId) {
    const inputPath = option("input");
    if (!inputPath) throw new Error("Use --input <JSON file> or --run-id <existing run UUID>.");
    const raw = await readFile(resolve(inputPath), "utf8");
    if (Buffer.byteLength(raw) > 200_000) throw new Error("Input exceeds 200 KB.");
    request = JSON.parse(raw);
    if (!object(request) || request.schemaVersion !== 1 || typeof request.traceId !== "string" || !object(request.snapshot)) {
      throw new Error("Input needs schemaVersion: 1, traceId, and a snapshot object.");
    }
    if (role === "sales" && !["qualify", "prepare_outreach"].includes(request.phase)) {
      throw new Error("Sales phase must be qualify or prepare_outreach.");
    }
    if (role === "revenue" && (!object(request.salesResult) || request.salesResult.role !== "sales")) {
      throw new Error("Revenue requires the actual Sales output in salesResult.");
    }
    if (role === "sales" && request.phase === "prepare_outreach" && !object(request.revenuePlan)) {
      throw new Error("prepare_outreach requires the actual revenuePlan.");
    }
    if (args.includes("--check-input")) {
      console.log(`Valid ${role} request (${request.snapshot.mode ?? "unspecified"}). No API call made.`);
      return;
    }
  } else if (!uuid.test(runId)) {
    throw new Error("--run-id must be a UUID from a previous CREAO response.");
  }

  const prefix = `CREAO_${role.toUpperCase()}`;
  const agentId = process.env[`${prefix}_AGENT_ID`]?.trim();
  const key = (process.env[`${prefix}_API_KEY`] || process.env.CREAO_API_KEY)?.trim();
  if (!agentId || !uuid.test(agentId)) throw new Error(`Set ${prefix}_AGENT_ID to the saved agent's UUID in .env.`);
  if (!key?.startsWith("capi_")) throw new Error(`Set ${prefix}_API_KEY or CREAO_API_KEY to a permitted capi_ key in .env.`);

  const runsUrl = `${origin}/api/v1/apps/${agentId}/runs`;
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      redirect: "error",
      headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const value = await res.json().catch(() => null);
    if (!res.ok) {
      // Do not echo arbitrary response bodies: they could contain credentials or private inputs.
      const code = typeof value?.error === "string" && /^[A-Z0-9_]{1,80}$/.test(value.error) ? ` (${value.error})` : "";
      throw new Error(`CREAO returned HTTP ${res.status}${code}. Check the agent page and its API key.`);
    }
    if (!object(value)) throw new Error("CREAO returned a non-object JSON response.");
    return value;
  }

  async function resultJson(run) {
    // CREAO may wrap the chat reply in a dashboard. The explicit JSON artifact
    // is the machine contract; never scrape values from its prose or HTML.
    const matches = (run.result?.artifacts ?? []).filter((item) => item.title === `${role}-result.json` && item.type === "application/json");
    if (matches.length > 1) throw new Error("Run has multiple result artifacts; resolve the ambiguity in CREAO.");
    if (matches.length === 1) {
      const artifact = matches[0];
      const url = new URL(artifact.url);
      if (url.origin !== origin || url.pathname !== `/api/v1/runs/${runId}/artifacts/download` || url.searchParams.get("artifactId") !== artifact.id) {
        throw new Error("Result artifact URL does not match the verified CREAO run.");
      }
      let response = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      if (response.status === 302) {
        const location = response.headers.get("location");
        if (!location) throw new Error("CREAO artifact redirect has no destination.");
        const target = new URL(location);
        if (target.protocol !== "https:" || target.username || target.password) throw new Error("Invalid artifact storage URL.");
        // No Authorization header is forwarded to the signed storage URL.
        response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(30_000) });
      }
      if (!response.ok) throw new Error(`Result artifact download returned HTTP ${response.status}.`);
      if (Number(response.headers.get("content-length")) > 1_000_000) throw new Error("Result artifact exceeds 1 MB.");
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 1_000_000) throw new Error("Result artifact exceeds 1 MB.");
      try { return JSON.parse(raw); } catch { throw new Error("Result artifact is not valid JSON."); }
    }
    for (const candidate of [run.result?.text, run.result?.chatText]) {
      if (typeof candidate !== "string") continue;
      try {
        const parsed = JSON.parse(candidate.trim());
        if (parsed?.schemaVersion === 1 && parsed.role === role) return parsed;
      } catch { /* Try the other documented text field; never parse prose fragments. */ }
    }
    throw new Error(`Run ${runId} has no valid ${role}-result.json artifact or JSON result. Refine the saved agent.`);
  }

  const outDir = resolve(".creao-runs");
  await mkdir(outDir, { recursive: true });
  if (!runId) {
    let created;
    try {
      created = await api("POST", runsUrl, { inputs: { request_json: JSON.stringify(request) } });
    } catch (error) {
      throw new Error(`${error.message} The POST was not retried. Check CREAO Sessions before starting another run.`);
    }
    if (typeof created.id !== "string" || !uuid.test(created.id)) {
      throw new Error("Start response did not contain a valid run UUID. Check CREAO Sessions before retrying.");
    }
    runId = created.id;
    await writeFile(resolve(outDir, `${runId}.json`), JSON.stringify({ role, agentId, runId, status: created.status }, null, 2));
    console.log(`Started ${role} run ${runId}. Resume with --agent ${role} --run-id ${runId}.`);
  }

  const deadline = Date.now() + 20 * 60_000;
  let previousStatus;
  let transientErrors = 0;
  while (Date.now() < deadline) {
    let run;
    try {
      run = await api("GET", `${runsUrl}/${runId}`);
      transientErrors = 0;
    } catch (error) {
      if (++transientErrors >= 3) throw new Error(`${error.message} Resume existing run ${runId}; do not create another.`);
      await new Promise((r) => setTimeout(r, 10_000));
      continue;
    }
    if (run.status !== previousStatus) console.log(`${role}: ${run.status}`);
    previousStatus = run.status;
    await writeFile(resolve(outDir, `${runId}.json`), JSON.stringify({ role, agentId, runId, ...run }, null, 2));
    if (run.status === "completed") {
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { result = await resultJson(run); break; } catch (error) {
          const transient = error.name === "TimeoutError" || error.message === "fetch failed" || /download returned HTTP 5\d\d/.test(error.message);
          if (!transient || attempt === 2) throw error;
          console.log("Retrying read-only result download; no new agent run is being created.");
          await new Promise((r) => setTimeout(r, (attempt + 1) * 1500));
        }
      }
      if (!object(result) || result.schemaVersion !== 1 || result.role !== role) {
        throw new Error(`Run ${runId} returned the wrong result schema/role. Inspect the saved output.`);
      }
      if (request && (result.traceId !== request.traceId || result.snapshotId !== request.snapshot.id)) {
        throw new Error(`Run ${runId} returned mismatched trace/snapshot IDs.`);
      }
      const resultFile = resolve(outDir, `${runId}.result.json`);
      await writeFile(resultFile, JSON.stringify(result, null, 2));
      if (option("output")) await writeFile(resolve(option("output")), JSON.stringify(result, null, 2));
      console.log(`Completed. Result saved to ${resultFile}. No live offer or payment was submitted by this runner.`);
      return;
    }
    if (["failed", "cancelled"].includes(run.status)) throw new Error(`Run ${runId} ${run.status}; inspect its CREAO session for details.`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`Stopped polling after 20 minutes. The remote run may still be active. Resume using --run-id ${runId}.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
