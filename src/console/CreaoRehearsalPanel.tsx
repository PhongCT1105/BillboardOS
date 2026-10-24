import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import rehearsalRequest from "../../agents/creao/rehearsal-sales.json";

type JsonObject = Record<string, unknown>;
type Role = "sales" | "revenue";
type Phase = "qualify" | "prepare_outreach";

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(label + " returned an invalid JSON result.");
  return value;
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function CreaoRehearsalPanel() {
  const startRun = useAction(api.creao.startRun);
  const getRun = useAction(api.creao.getRun);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<JsonObject | null>(null);

  async function runStage(role: Role, request: JsonObject, name: string): Promise<JsonObject> {
    const snapshot = requireObject(request.snapshot, name + " request snapshot");
    if (typeof request.traceId !== "string" || typeof snapshot.id !== "string") {
      throw new Error(name + " request is missing traceId or snapshot.id.");
    }
    const phase = role === "sales" && (request.phase === "qualify" || request.phase === "prepare_outreach")
      ? request.phase as Phase
      : null;

    setStage(name + ": starting");
    // The start action is deliberately called once. If its response is lost, check CREAO Sessions before retrying.
    const started = await startRun({ role, requestJson: JSON.stringify(request) });
    const deadline = Date.now() + 20 * 60_000;

    while (Date.now() < deadline) {
      const current = await getRun({
        role,
        runId: started.runId,
        traceId: request.traceId,
        snapshotId: snapshot.id,
        phase,
      });
      setStage(name + ": " + current.status);
      if (current.status === "completed") return requireObject(current.result, name);
      if (current.status === "failed" || current.status === "cancelled" || current.status === "invalid_result") {
        throw new Error(current.error ?? (name + " failed in CREAO."));
      }
      await wait(5_000);
    }
    throw new Error(name + " is still running. Check CREAO Sessions before starting another run.");
  }

  function validateRevenue(sales: JsonObject, revenue: JsonObject, request: JsonObject) {
    if (sales.status !== "qualified" || !Array.isArray(sales.selected) || sales.selected.length === 0) {
      throw new Error("Sales did not return qualified campaigns; Revenue was not started.");
    }
    if (revenue.status !== "proposed" || !Array.isArray(revenue.plans) || revenue.plans.length === 0) {
      throw new Error("Revenue did not return a pricing plan.");
    }

    const selectedIds = new Set(
      sales.selected.filter(isObject).map((item) => item.campaignId).filter((id): id is string => typeof id === "string"),
    );
    const snapshot = requireObject(request.snapshot, "Rehearsal");
    const slots = Array.isArray(snapshot.slots) ? snapshot.slots.filter(isObject) : [];
    const slotsById = new Map(slots.filter((slot) => typeof slot.id === "string").map((slot) => [slot.id as string, slot]));

    for (const rawPlan of revenue.plans) {
      const plan = requireObject(rawPlan, "Revenue plan");
      if (!Array.isArray(plan.campaignIds) || !plan.campaignIds.every((id) => typeof id === "string" && selectedIds.has(id))) {
        throw new Error("Revenue included a campaign that Sales did not qualify.");
      }
      if (!Array.isArray(plan.slotIds) || !plan.slotIds.every((id) => typeof id === "string" && slotsById.has(id))) {
        throw new Error("Revenue included a slot outside the supplied snapshot.");
      }
      if (plan.mode === "auction") {
        if (typeof plan.reserveMinor !== "number" || !Number.isInteger(plan.reserveMinor)) {
          throw new Error("Revenue returned an invalid auction reserve.");
        }
        for (const slotId of plan.slotIds as string[]) {
          if (slotsById.get(slotId)?.screenPriceMinor !== plan.reserveMinor) {
            throw new Error("Revenue changed the common auction reserve.");
          }
        }
      }
    }
  }

  async function runRehearsal() {
    setBusy(true);
    setError(null);
    setReport(null);
    setStage("Starting");
    try {
      const request = rehearsalRequest as JsonObject;
      const sales = await runStage("sales", request, "Sales qualification");
      const revenueRequest: JsonObject = {
        schemaVersion: 1,
        traceId: request.traceId,
        snapshot: request.snapshot,
        salesResult: sales,
      };
      const revenue = await runStage("revenue", revenueRequest, "Revenue pricing");
      validateRevenue(sales, revenue, request);

      const outreachRequest: JsonObject = {
        ...request,
        phase: "prepare_outreach",
        revenuePlan: revenue,
      };
      const outreach = await runStage("sales", outreachRequest, "Sales offer preparation");
      const blockers = Array.isArray(outreach.blockers) ? outreach.blockers : [];
      const hasNoDeliveryBlocker = blockers.some((item) => isObject(item)
        ? item.id === "seller_write_api_not_connected"
        : item === "seller_write_api_not_connected");
      if (outreach.status !== "prepared_only" || !hasNoDeliveryBlocker) {
        throw new Error("Sales did not confirm that offers were prepared only and not delivered.");
      }

      const selected = Array.isArray(sales.selected)
        ? sales.selected.filter(isObject).map((item) => item.campaignId).filter((id): id is string => typeof id === "string")
        : [];
      setReport({
        mode: "SIMULATED rehearsal",
        traceId: request.traceId,
        snapshotId: requireObject(request.snapshot, "Rehearsal").id,
        selectedCampaigns: selected,
        pricingPlans: (revenue.plans as unknown[]).length,
        preparedOffers: Array.isArray(outreach.offers) ? outreach.offers.length : 0,
        deliveredOffers: 0,
        results: { sales, revenue, outreach },
      });
      setStage("Complete");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "CREAO rehearsal failed.");
      setStage("Stopped");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="creao-rehearsal-heading" className="rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 id="creao-rehearsal-heading" className="text-lg font-semibold">CREAO agent rehearsal</h2>
            <span className="rounded-full border border-line px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted">SIMULATED</span>
          </div>
          <p className="mt-1 max-w-[75ch] text-sm text-muted">
            Runs Sales qualification → Revenue pricing → Sales offer preparation using the included fictional snapshot.
            No buyer is contacted and no inventory or payment is changed.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void runRehearsal()}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-50"
        >
          {busy ? "Running agents…" : "Run CREAO rehearsal"}
        </button>
      </div>

      <p className="mt-3 text-xs text-muted" role="status">Status: {stage}</p>
      {error && <p className="mt-3 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">{error}</p>}
      {report && (
        <details className="mt-4 rounded-lg border border-line bg-canvas p-3">
          <summary className="cursor-pointer text-sm font-medium">View run summary and agent outputs</summary>
          <pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-xs text-muted">
            {JSON.stringify(report, null, 2)}
          </pre>
        </details>
      )}
    </section>
  );
}
