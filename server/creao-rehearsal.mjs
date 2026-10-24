/** Local server orchestration: real CREAO calls, explicitly synthetic business data. */
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
};
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function main() {
  const input = await read(resolve(option("input") || "agents/creao/rehearsal-sales.json"));
  assert(input.snapshot?.mode === "rehearsal", "This orchestration is for explicitly simulated rehearsals only.");
  const directory = resolve(option("directory") || `.creao-runs/rehearsal-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  console.log(`Rehearsal directory: ${directory}`);

  async function stage(name, role, request) {
    const requestPath = resolve(directory, `${name}.request.json`);
    const outputPath = resolve(directory, `${name}.result.json`);
    const startedPath = resolve(directory, `${name}.started`);
    const sameRequest = (previous) => JSON.stringify(previous) === JSON.stringify(request);
    const validateIdentity = (result) => {
      assert(result?.schemaVersion === 1 && result.role === role && result.traceId === request.traceId && result.snapshotId === request.snapshot.id, `${name}: output identity does not match its request.`);
      if (role === "sales") assert(result.phase === request.phase, `${name}: Sales returned the wrong phase.`);
      return result;
    };
    let cached;
    try { cached = await read(outputPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (cached) {
      assert(sameRequest(await read(requestPath)), `${name}: cached output belongs to a different request. Choose a new directory.`);
      console.log(`${name}: reusing completed result`);
      return validateIdentity(cached);
    }
    let started = false;
    try { await access(startedPath); started = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    assert(!started, `${name} was already started. Resume its run with creao:run --agent ${role} --run-id <logged-run-id> --output "${outputPath}" before rerunning this directory.`);
    await save(requestPath, request);
    await writeFile(startedPath, new Date().toISOString(), { flag: "wx" });
    await new Promise((accept, reject) => {
      const child = spawn(process.execPath, ["--env-file-if-exists=.env", "server/creao-first-run.mjs", "--agent", role, "--input", requestPath, "--output", outputPath], { stdio: "inherit", shell: false });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? accept() : reject(new Error(`${name} stopped with exit code ${code}; no automatic retry.`)));
    });
    return validateIdentity(await read(outputPath));
  }

  const sales = await stage("01-sales", "sales", input);
  assert(sales.status === "qualified" && sales.selected?.length, "Sales did not qualify any buyers; inspect its blockers.");
  const revenueRequest = { schemaVersion: 1, traceId: input.traceId, snapshot: input.snapshot, salesResult: sales };
  const revenue = await stage("02-revenue", "revenue", revenueRequest);
  assert(revenue.status === "proposed" && revenue.plans?.length, "Revenue did not propose a plan; inspect its blockers.");
  const selected = new Set(sales.selected.map((item) => item.campaignId));
  const slots = new Map(input.snapshot.slots.map((slot) => [slot.id, slot]));
  for (const plan of revenue.plans) {
    assert(plan.campaignIds.every((id) => selected.has(id)), "Revenue added an unqualified campaign.");
    for (const id of plan.slotIds) {
      assert(slots.has(id), "Revenue invented a slot ID.");
      if (plan.mode === "auction") assert(plan.reserveMinor === slots.get(id).screenPriceMinor, "Revenue changed the shared auction reserve.");
    }
  }
  const outreach = await stage("03-outreach", "sales", { ...input, phase: "prepare_outreach", revenuePlan: revenue });
  assert(outreach.status === "prepared_only", "Expected prepared-only offers, not a delivery claim.");
  assert(outreach.blockers?.some((blocker) => (typeof blocker === "string" ? blocker : blocker?.id) === "seller_write_api_not_connected"), "Missing explicit live-execution blocker.");
  const report = { mode: "rehearsal", traceId: input.traceId, snapshotId: input.snapshot.id, selectedCampaigns: [...selected], plans: revenue.plans.length, preparedOffers: outreach.offers?.length ?? 0, deliveredOffers: 0, directory };
  await save(resolve(directory, "summary.json"), report);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
