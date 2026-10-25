import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules, signedInOperator, joinCompanies, type TestClient } from "./test.setup";
import { FIXTURE_AS_OF, FIXTURE_BANK_LINES } from "./fixtures/financeFixture";
import { COLLECTION_ANSWERS, INGEST_ANSWER, LINE_ANSWERS } from "./fixtures/financeAnswerKey";
import { AR_DEBOUNCE_MS, STRAGGLER_AGE_MS } from "./financeAutopilot";

type T = TestClient;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_AS_OF);
});
afterEach(() => {
  vi.useRealTimers();
});

const RUN_AR = "financeAutopilot:runArClerk";
/** convex-test nudges the clock forward a few ms per write; compare times within 0.5 s. */
const near = (ms: number) => expect.closeTo(ms, -3);

async function workspaceNamed(t: T, name: string): Promise<Id<"workspaces">> {
  return (await t.run(async (ctx) =>
    ctx.db
      .query("workspaces")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first(),
  ))!._id;
}

/** AR clerk jobs in the scheduler, with their state and target workspace. */
async function arJobs(t: T) {
  const jobs = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs
    .filter((j) => j.name === RUN_AR)
    .map((j) => ({
      state: j.state.kind,
      scheduledTime: j.scheduledTime,
      workspaceId: (j.args[0] as { workspaceId: Id<"workspaces"> }).workspaceId,
      trigger: (j.args[0] as { trigger: string }).trigger,
    }));
}

async function unmatchedCount(t: T, workspaceId: Id<"workspaces">) {
  return await t.run(async (ctx) =>
    (
      await ctx.db
        .query("bankTransactions")
        .withIndex("by_workspace_and_status_and_postedAt", (q) =>
          q.eq("workspaceId", workspaceId).eq("status", "unmatched"),
        )
        .collect()
    ).length,
  );
}

/** Seeded finance world with the fixture bank lines removed (invoices only). */
async function invoicesOnly() {
  const t = await signedInOperator(convexTest(schema, modules));
  await t.mutation(internal.seed.finance, {});
  await joinCompanies(t);
  await t.run(async (ctx) => {
    for (const line of await ctx.db.query("bankTransactions").collect()) await ctx.db.delete(line._id);
  });
  const workspaceId = await workspaceNamed(t, "Moscone Media");
  return { t, workspaceId };
}

const extraLine = (externalId: string, amountMinor = 1234) => ({
  source: "nessie" as const,
  externalId,
  amountMinor,
  postedAt: FIXTURE_AS_OF,
  payerName: "UNKNOWN PAYER LLC",
  memo: "",
});

describe("AR clerk on autopilot", () => {
  test("bank ingest schedules a run that reproduces the answer key and hands off, with no click", async () => {
    const { t, workspaceId } = await invoicesOnly();

    const ingest = await t.mutation(internal.bank.ingest, { workspaceId, lines: FIXTURE_BANK_LINES });
    expect(ingest.inserted).toBe(INGEST_ANSWER.inserted);
    expect(ingest.duplicates).toEqual(INGEST_ANSWER.duplicatesIgnored);
    expect(await arJobs(t)).toEqual([
      { state: "pending", scheduledTime: near(FIXTURE_AS_OF), workspaceId, trigger: "new bank lines arrived" },
    ]);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await unmatchedCount(t, workspaceId)).toBe(0);
    for (const [externalId, expected] of Object.entries(LINE_ANSWERS)) {
      const line = await t.run(async (ctx) =>
        ctx.db
          .query("bankTransactions")
          .withIndex("by_source_and_externalId", (q) => q.eq("source", "fixture").eq("externalId", externalId))
          .unique(),
      );
      expect(line?.status, externalId).toBe(expected.status);
      expect(line?.rule, externalId).toBe(expected.rule);
      expect(line?.appliedMinor, externalId).toBe(expected.applications.reduce((s, a) => s + a.amountMinor, 0));
    }

    // Audited as the AR seat, with the reason it woke up.
    const audit = await t.query(api.audit.recent, {});
    const handoff = audit.find((e) => e.type === "reconciliation.handoff")!;
    expect(handoff.actor).toBe("agent:ar");
    expect(handoff.reason).toContain("new bank lines arrived");
    expect(audit.filter((e) => e.type === "reconciliation.applied").every((e) => e.actor === "agent:ar")).toBe(true);

    // Hand-off: collections re-planned on the new balances.
    const tasks = await t.query(api.collections.tasks, {});
    expect(tasks.map((x) => x.invoiceNumber).sort()).toEqual(Object.keys(COLLECTION_ANSWERS).sort());

    // Status line for the Finance page.
    const status = await t.query(api.financeAutopilot.status, {});
    expect(status.lastRunAt).toEqual(near(FIXTURE_AS_OF));
    expect(status.lastProcessed).toBe(INGEST_ANSWER.inserted);
    expect(status.pendingRunAt).toBeNull();
    expect(status.canReconcileNow).toBe(true);
    expect(status.activity.some((e) => e.type === "reconciliation.handoff")).toBe(true);
    expect(status.activity.some((e) => e.type === "collection.planned")).toBe(true);
  });

  test("a burst of ingests yields one run; a late arrival gets one trailing run", async () => {
    const { t, workspaceId } = await invoicesOnly();

    for (const id of ["burst-1", "burst-2", "burst-3"]) {
      await t.mutation(internal.bank.ingest, { workspaceId, lines: [extraLine(id, 1000 + id.length)] });
    }
    // Re-delivery of an existing line inserts nothing and schedules nothing.
    await t.mutation(internal.bank.ingest, { workspaceId, lines: [extraLine("burst-1", 1007)] });
    expect(await arJobs(t)).toHaveLength(1);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await unmatchedCount(t, workspaceId)).toBe(0);
    const ran = (await arJobs(t)).filter((j) => j.state === "success");
    expect(ran).toHaveLength(1);
    const runAt = Date.now();

    // Arrives right after the run: scheduled AR_DEBOUNCE_MS after it, not immediately.
    await t.mutation(internal.bank.ingest, { workspaceId, lines: [extraLine("late-1", 2001)] });
    await t.mutation(internal.bank.ingest, { workspaceId, lines: [extraLine("late-2", 2002)] });
    const pending = (await arJobs(t)).filter((j) => j.state === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].scheduledTime).toEqual(near(runAt + AR_DEBOUNCE_MS));
    expect((await t.query(api.financeAutopilot.status, {})).pendingRunAt).toEqual(near(runAt + AR_DEBOUNCE_MS));

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await unmatchedCount(t, workspaceId)).toBe(0);
    expect((await arJobs(t)).filter((j) => j.state === "success")).toHaveLength(2);
  });

  test("tick picks up stragglers older than a minute and leaves fresh lines to the ingest path", async () => {
    const t = await signedInOperator(convexTest(schema, modules));
    await t.mutation(internal.seed.finance, {}); // fixture lines via the seed: no ingest trigger
    await joinCompanies(t);
    const workspaceId = await workspaceNamed(t, "Moscone Media");
    expect(await arJobs(t)).toHaveLength(0);

    // Fresh lines: not a straggler yet.
    expect((await t.mutation(internal.financeAutopilot.tick, {})).arRunsScheduled).toBe(0);

    vi.setSystemTime(FIXTURE_AS_OF + STRAGGLER_AGE_MS + 1_000);
    expect((await t.mutation(internal.financeAutopilot.tick, {})).arRunsScheduled).toBe(1);
    // Already pending: a second tick doesn't stack another run.
    expect((await t.mutation(internal.financeAutopilot.tick, {})).arRunsScheduled).toBe(0);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await unmatchedCount(t, workspaceId)).toBe(0);
    const handoff = (await t.query(api.audit.recent, {})).find((e) => e.type === "reconciliation.handoff")!;
    expect(handoff.reason).toContain("unmatched bank lines waiting over a minute");

    // Nothing left: the next tick is a no-op.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect((await t.mutation(internal.financeAutopilot.tick, {})).arRunsScheduled).toBe(0);
  });

  test("tick re-plans collections only when an invoice has just become overdue", async () => {
    const { t, workspaceId } = await invoicesOnly();
    await t.mutation(internal.financeAutopilot.tick, {}); // baseline tick
    expect((await t.mutation(internal.financeAutopilot.tick, {})).collectionsReplanned).toBe(0);

    // An open invoice falls due two minutes from now.
    const dueAt = Date.now() + 2 * 60_000;
    await t.run(async (ctx) => {
      const inv = (await ctx.db
        .query("invoices")
        .withIndex("by_workspace_and_status_and_dueAt", (q) => q.eq("workspaceId", workspaceId).eq("status", "open"))
        .first())!;
      await ctx.db.patch(inv._id, { dueAt });
    });
    vi.setSystemTime(dueAt + 3 * 60_000);
    expect((await t.mutation(internal.financeAutopilot.tick, {})).collectionsReplanned).toBe(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.query(api.collections.tasks, {})).length).toBeGreaterThan(0);

    // Same invoice is not "newly" overdue on the next tick.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect((await t.mutation(internal.financeAutopilot.tick, {})).collectionsReplanned).toBe(0);
  });

  test("workspaces are isolated: one host's ingest never runs or touches another's lines", async () => {
    const { t, workspaceId: a } = await invoicesOnly();
    const hostB = await signedInOperator(t, "b@otherhost.test", "Other Host");
    const b = await workspaceNamed(t, "Other Host");
    await t.run(async (ctx) => {
      await ctx.db.insert("bankTransactions", { ...extraLine("b-1", 4321), workspaceId: b, status: "unmatched", appliedMinor: 0 });
    });

    await t.mutation(internal.bank.ingest, { workspaceId: a, lines: [extraLine("a-1", 1111)] });
    expect((await arJobs(t)).map((j) => j.workspaceId)).toEqual([a]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await unmatchedCount(t, a)).toBe(0);
    expect(await unmatchedCount(t, b)).toBe(1);
    const statusB = await hostB.query(api.financeAutopilot.status, {});
    expect(statusB.lastRunAt).toBeNull();
    expect(statusB.activity).toHaveLength(0);
    expect((await t.query(api.financeAutopilot.status, {})).lastRunAt).toEqual(near(FIXTURE_AS_OF));

    // B's own ingest schedules B's run independently (A's debounce doesn't apply).
    await t.mutation(internal.bank.ingest, { workspaceId: b, lines: [extraLine("b-2", 4322)] });
    const pendingB = (await arJobs(t)).filter((j) => j.state === "pending");
    expect(pendingB).toEqual([expect.objectContaining({ workspaceId: b, scheduledTime: near(FIXTURE_AS_OF) })]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await unmatchedCount(t, b)).toBe(0);

    // Status is members-only and per workspace.
    await expect(hostB.query(api.financeAutopilot.status, { workspaceId: a })).rejects.toThrow();
  });

  test("Reconcile now is offered to the owner only and updates the status line", async () => {
    const { t, workspaceId } = await invoicesOnly();
    const operator = await signedInOperator(t, "second@billboardos.test");
    expect((await operator.query(api.financeAutopilot.status, {})).canReconcileNow).toBe(false);

    await t.run(async (ctx) => {
      await ctx.db.insert("bankTransactions", { ...extraLine("m-1", 999), workspaceId, status: "unmatched", appliedMinor: 0 });
    });
    const summary = await t.mutation(api.finance.runReconciliation, {});
    expect(summary.processed).toBe(1);
    const status = await t.query(api.financeAutopilot.status, {});
    expect(status).toMatchObject({ lastRunAt: near(FIXTURE_AS_OF), lastProcessed: 1, canReconcileNow: true });
  });
});
