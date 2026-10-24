import { convexTest, type TestConvex } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules } from "./test.setup";
import { FIXTURE_AS_OF, FIXTURE_BANK_LINES } from "./fixtures/financeFixture";
import {
  COLLECTION_ANSWERS,
  INGEST_ANSWER,
  INVOICE_ANSWERS,
  LINE_ANSWERS,
} from "./fixtures/financeAnswerKey";
import { normalizeName, parseInvoiceNumbers, reconcileLine } from "./lib/reconcile";
import { chooseTone, DAY_MS } from "./lib/collections";

type T = TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_AS_OF);
});
afterEach(() => {
  vi.useRealTimers();
});

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConvexError) return (error.data as { code: string }).code;
    throw error;
  }
  throw new Error("expected promise to reject");
}

async function seededAndReconciled() {
  const t = convexTest(schema, modules);
  const seed = await t.mutation(internal.seed.finance, {});
  const summary = await t.mutation(internal.reconciliation.run, {});
  return { t, seed, summary };
}

async function lineByExternalId(t: T, externalId: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("bankTransactions")
      .withIndex("by_source_and_externalId", (q) => q.eq("source", "fixture").eq("externalId", externalId))
      .unique(),
  );
}

async function invoiceByNumber(t: T, number: string) {
  return (await t.run(async (ctx) =>
    ctx.db
      .query("invoices")
      .withIndex("by_number", (q) => q.eq("number", number))
      .unique(),
  ))!;
}

const balance = (i: { amountMinor: number; paidMinor: number; adjustmentMinor: number; writtenOffMinor: number }) =>
  i.amountMinor - i.paidMinor - i.adjustmentMinor - i.writtenOffMinor;

/** Assert every bank line and invoice matches the answer key (after a reconciliation run). */
async function assertReconciledMatchesAnswerKey(t: T) {
  const adjustedInvoices = new Map<string, number>();
  for (const [externalId, expected] of Object.entries(LINE_ANSWERS)) {
    const line = (await lineByExternalId(t, externalId))!;
    const actual = await t.run(async (ctx) => {
      const apps = await ctx.db
        .query("paymentApplications")
        .withIndex("by_bankTransaction", (q) => q.eq("bankTransactionId", line._id))
        .collect();
      const exceptions = await ctx.db
        .query("financeExceptions")
        .withIndex("by_bankTransaction", (q) => q.eq("bankTransactionId", line._id))
        .collect();
      const approvals = await ctx.db
        .query("approvals")
        .withIndex("by_subject", (q) => q.eq("subjectId", line._id))
        .collect();
      const num = async (id: Id<"invoices"> | undefined) => (id ? (await ctx.db.get(id))!.number : null);
      return {
        status: line.status,
        rule: line.rule,
        applications: await Promise.all(
          apps.map(async (a) => ({ invoice: (await num(a.invoiceId))!, amountMinor: a.amountMinor, appliedBy: a.appliedBy })),
        ),
        exceptions: await Promise.all(
          exceptions.map(async (e) => ({
            kind: e.kind,
            invoice: await num(e.invoiceId),
            expectedMinor: e.expectedMinor,
            observedMinor: e.observedMinor,
          })),
        ),
        approvals: approvals.map((a) => ({ action: a.action, amountMinor: a.amountMinor, requestedBy: a.requestedBy })),
      };
    });

    const label = `${externalId} (${expected.planted})`;
    expect(actual.status, label).toBe(expected.status);
    expect(actual.rule, label).toBe(expected.rule);
    expect(actual.applications.map(({ invoice, amountMinor }) => ({ invoice, amountMinor })), label).toEqual(
      expected.applications,
    );
    expect(actual.applications.every((a) => a.appliedBy === "agent:ar"), label).toBe(true);
    expect(actual.exceptions, label).toEqual(expected.exceptions);
    expect(actual.approvals.map(({ action, amountMinor }) => ({ action, amountMinor })), label).toEqual(
      expected.approvalsRequested,
    );
    expect(actual.approvals.every((a) => a.requestedBy === "agent:ar"), label).toBe(true);
    for (const adj of expected.adjustments) adjustedInvoices.set(adj.invoice, adj.amountMinor);
  }

  for (const [number, expected] of Object.entries(INVOICE_ANSWERS)) {
    const inv = await invoiceByNumber(t, number);
    expect({ status: inv.status, balanceMinor: balance(inv) }, number).toEqual(expected);
    expect(inv.adjustmentMinor, `${number} adjustment`).toBe(adjustedInvoices.get(number) ?? 0);
  }
}

describe("planted errors reproduce the answer key exactly", () => {
  test("ingest, reconciliation, invoices and collections", async () => {
    const { t, seed, summary } = await seededAndReconciled();

    // Ingest: the re-delivered line is dropped.
    expect(FIXTURE_BANK_LINES).toHaveLength(INGEST_ANSWER.rawLines);
    expect(seed.bankLinesInserted).toBe(INGEST_ANSWER.inserted);
    expect(seed.bankLinesDuplicate).toEqual(INGEST_ANSWER.duplicatesIgnored);

    // Every line processed, in posting order.
    expect(summary.processed).toBe(Object.keys(LINE_ANSWERS).length);
    expect(summary.lines.map((l) => l.externalId)).toEqual(Object.keys(LINE_ANSWERS));

    await assertReconciledMatchesAnswerKey(t);

    // Collections seat at the same "now".
    const plan = await t.mutation(internal.collections.plan, { asOf: FIXTURE_AS_OF });
    expect(plan.tasksCreated).toBe(Object.keys(COLLECTION_ANSWERS).length);
    expect(plan.escalationsRequested).toBe(1);
    const tasks = await t.query(api.collections.tasks, {});
    const byInvoice = Object.fromEntries(
      tasks.map((task) => [task.invoiceNumber, { tone: task.tone, daysOverdue: task.daysOverdue }]),
    );
    expect(byInvoice).toEqual(
      Object.fromEntries(
        Object.entries(COLLECTION_ANSWERS).map(([n, a]) => [n, { tone: a.tone, daysOverdue: a.daysOverdue }]),
      ),
    );
    const preview = await t.query(api.collections.dueForFollowUp, { asOf: FIXTURE_AS_OF });
    for (const row of preview) {
      expect(row.priorLateCount, row.number).toBe(COLLECTION_ANSWERS[row.number].priorLateCount);
      expect(row.hasOpenTask).toBe(true);
    }
    const sunsetFirm = tasks.find((x) => x.invoiceNumber === "INV-1013")!;
    expect(sunsetFirm.reason).toContain("INV-1002 paid 22 days late");
    expect(sunsetFirm.reason).toContain("INV-1005 paid 20 days late");
    const harbor = tasks.find((x) => x.invoiceNumber === "INV-1015")!;
    expect(harbor.reason).toContain("First time late");

    const pending = await t.query(api.approvals.pending, {});
    expect(pending.map((a) => [a.action, a.requestedBy]).sort()).toEqual(
      [
        ["escalate_collection", "agent:collections"],
        ["refund", "agent:ar"],
      ].sort(),
    );

    // Everything is idempotent.
    expect((await t.mutation(internal.seed.finance, {})).invoicesCreated).toBe(0);
    expect((await t.mutation(api.finance.runReconciliation, {})).processed).toBe(0);
    expect((await t.mutation(internal.collections.plan, { asOf: FIXTURE_AS_OF })).tasksCreated).toBe(0);
  });

  test("console queries reflect the reconciled state", async () => {
    const { t } = await seededAndReconciled();
    const feed = await t.query(api.finance.bankFeed, {});
    expect(feed).toHaveLength(7);
    const bundled = feed.find((l) => l.externalId === "fx-bank-001")!;
    expect(bundled.source).toBe("fixture");
    expect(bundled.applications.map((a) => a.invoiceNumber)).toEqual(["INV-1010", "INV-1011"]);
    expect(bundled.advertiserName).toBe("Mission Bikes");
    const dup = feed.find((l) => l.externalId === "fx-bank-006")!;
    expect(dup.duplicateOfExternalId).toBe("fx-bank-005");
    expect(dup.openExceptionKinds).toEqual(["duplicate_payment"]);
    const over = feed.find((l) => l.externalId === "fx-bank-004")!;
    expect(over.unappliedMinor).toBe(3000);

    const receivables = await t.query(api.finance.receivables, { asOf: FIXTURE_AS_OF });
    expect(receivables.map((r) => r.number)).toEqual(["INV-1008", "INV-1012", "INV-1013", "INV-1015"]);
    const r1012 = receivables.find((r) => r.number === "INV-1012")!;
    expect(r1012).toMatchObject({ balanceMinor: 4000, daysOverdue: 8, status: "partially_paid", advertiserName: "Sunset Records", source: "fixture" });

    const open = await t.query(api.finance.openExceptions, {});
    expect(open.map((e) => e.kind).sort()).toEqual(
      ["duplicate_payment", "overpayment", "short_payment", "unidentified_payment"],
    );
  });
});

describe("segregation of duties", () => {
  test("agents and requesters cannot approve; a controller can, and the exception resolves", async () => {
    const { t } = await seededAndReconciled();
    const [refund] = await t.query(api.approvals.pending, {}).then((rows) => rows.filter((a) => a.action === "refund"));

    expect(
      await errorCode(t.mutation(api.approvals.decide, { approvalId: refund._id, approvedBy: "agent:controller-bot", decision: "approved", note: "" })),
    ).toBe("AGENT_CANNOT_APPROVE");
    expect(
      await errorCode(t.mutation(api.approvals.decide, { approvalId: refund._id, approvedBy: "agent:ar", decision: "approved", note: "" })),
    ).toBe("AGENT_CANNOT_APPROVE");

    const writeOff = await t.mutation(api.approvals.request, {
      action: "write_off",
      subjectId: (await invoiceByNumber(t, "INV-1012"))._id,
      amountMinor: 4000,
      requestedBy: "maria.ar",
      reason: "Sunset disputes $40 of the listening party; small balance",
      financeExceptionId: (await t.query(api.finance.openExceptions, {})).find((e) => e.kind === "short_payment")!._id,
    });
    expect(
      await errorCode(t.mutation(api.approvals.decide, { approvalId: writeOff.approvalId, approvedBy: "Maria.AR", decision: "approved", note: "" })),
    ).toBe("SOD_VIOLATION");

    const decided = await t.mutation(api.approvals.decide, {
      approvalId: writeOff.approvalId,
      approvedBy: "controller",
      decision: "approved",
      note: "OK, under policy",
    });
    expect(decided.status).toBe("approved");
    expect(decided.executionResult).toContain("Wrote off $40.00 on INV-1012");
    const inv = await invoiceByNumber(t, "INV-1012");
    expect(inv.status).toBe("written_off");
    expect(balance(inv)).toBe(0);

    const refundDone = await t.mutation(api.approvals.decide, {
      approvalId: refund._id,
      approvedBy: "controller",
      decision: "approved",
      note: "Refund the $30",
    });
    expect(refundDone.executionResult).toContain("Refund of $30.00");
    const line = (await lineByExternalId(t, "fx-bank-004"))!;
    expect(line.refundedMinor).toBe(3000);
    expect(line.status).toBe("matched");

    const open = await t.query(api.finance.openExceptions, {});
    expect(open.map((e) => e.kind).sort()).toEqual(["duplicate_payment", "unidentified_payment"]);
    const resolved = await t.run(async (ctx) =>
      ctx.db.query("financeExceptions").withIndex("by_status", (q) => q.eq("status", "resolved")).collect(),
    );
    expect(resolved.every((e) => e.resolvedBy === "controller")).toBe(true);
    // Short-payment collection task closes with the invoice.
    const tasks = await t.query(api.collections.tasks, {});
    expect(tasks.filter((x) => x.invoiceNumber === "INV-1012")).toHaveLength(0);

    expect(
      await errorCode(t.mutation(api.approvals.decide, { approvalId: refund._id, approvedBy: "cfo", decision: "approved", note: "" })),
    ).toBe("NOT_PENDING");
  });

  test("manual match of an unidentified payment, and a stale approval is skipped", async () => {
    const { t } = await seededAndReconciled();
    const line = (await lineByExternalId(t, "fx-bank-007"))!;
    const inv1013 = await invoiceByNumber(t, "INV-1013");
    const exception = (await t.query(api.finance.openExceptions, {})).find((e) => e.kind === "unidentified_payment")!;

    // A write-off of the full balance is requested and left waiting...
    const staleWriteOff = await t.mutation(api.approvals.request, {
      action: "write_off",
      subjectId: inv1013._id,
      amountMinor: 30000,
      requestedBy: "agent:collections",
      reason: "Uncollectible?",
    });

    expect(
      await errorCode(
        t.mutation(api.approvals.request, {
          action: "apply_manual_match",
          subjectId: line._id,
          amountMinor: 27500,
          requestedBy: "maria.ar",
          reason: "missing invoiceId",
        }),
      ),
    ).toBe("INVALID_INPUT");

    const match = await t.mutation(api.approvals.request, {
      action: "apply_manual_match",
      subjectId: line._id,
      invoiceId: inv1013._id,
      amountMinor: 27500,
      requestedBy: "maria.ar",
      reason: "J Smith Consulting is Sunset Records' agency (confirmed by phone)",
      financeExceptionId: exception._id,
    });
    const r = await t.mutation(api.approvals.decide, {
      approvalId: match.approvalId,
      approvedBy: "controller",
      decision: "approved",
      note: "Agency confirmed",
    });
    expect(r.executionResult).toContain("Applied $275.00 from fx-bank-007 to INV-1013");
    const after = await invoiceByNumber(t, "INV-1013");
    expect(after.status).toBe("partially_paid");
    expect(balance(after)).toBe(2500);
    const lineAfter = (await lineByExternalId(t, "fx-bank-007"))!;
    expect(lineAfter.status).toBe("matched");
    const apps = await t.run(async (ctx) =>
      ctx.db.query("paymentApplications").withIndex("by_bankTransaction", (q) => q.eq("bankTransactionId", line._id)).collect(),
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ rule: "manual_match", appliedBy: "maria.ar (approved by controller)" });

    // ...and when the controller finally approves it, the balance has changed: skipped, not executed.
    const late = await t.mutation(api.approvals.decide, {
      approvalId: staleWriteOff.approvalId,
      approvedBy: "controller",
      decision: "approved",
      note: "fine",
    });
    expect(late.executionResult).toMatch(/^Skipped: state changed/);
    expect((await invoiceByNumber(t, "INV-1013")).writtenOffMinor).toBe(0);
  });

  test("controller says no to an escalation -> collections falls back to firm", async () => {
    const { t } = await seededAndReconciled();
    await t.mutation(internal.collections.plan, { asOf: FIXTURE_AS_OF });
    const escalation = (await t.query(api.approvals.pending, {})).find((a) => a.action === "escalate_collection")!;
    expect(escalation.subjectLabel).toContain("INV-1008");

    expect(
      await errorCode(t.mutation(api.approvals.decide, { approvalId: escalation._id, approvedBy: "controller", decision: "rejected", note: "" })),
    ).toBe("INVALID_INPUT");
    const r = await t.mutation(api.approvals.decide, {
      approvalId: escalation._id,
      approvedBy: "controller",
      decision: "rejected",
      note: "Sunset is renegotiating; give them a week",
    });
    expect(r.status).toBe("rejected");
    expect(r.executionResult).toContain("firm reminder for INV-1008");

    const tasks = (await t.query(api.collections.tasks, {})).filter((x) => x.invoiceNumber === "INV-1008");
    expect(tasks.map((x) => [x.tone, x.status]).sort()).toEqual(
      [
        ["escalate_to_controller", "resolved"],
        ["firm", "planned"],
      ].sort(),
    );
    // Re-planning does not re-escalate a declined escalation.
    const again = await t.mutation(internal.collections.plan, { asOf: FIXTURE_AS_OF + 2 * DAY_MS });
    expect(again.escalationsRequested).toBe(0);
  });
});

describe("booking on terms", () => {
  test("net15 advertiser gets a booking + invoice; prepay is refused", async () => {
    const t = convexTest(schema, modules);
    const seed = await t.mutation(internal.seed.demo, {});
    const slots = await t.query(api.slots.listForBillboard, {
      billboardId: seed.billboardId,
      from: FIXTURE_AS_OF,
      to: FIXTURE_AS_OF + DAY_MS,
    });
    const bayRobotics = seed.advertiserIds[1];
    const campaignId = await t.mutation(api.campaigns.create, {
      advertiserId: bayRobotics,
      brief: "Robot demo day",
      budgetMinor: 50_000,
    });
    const q = await t.mutation(api.quotes.create, { campaignId, slotIds: [slots[0]._id] });
    const hold = await t.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "terms-1", actor: "buyer" });

    expect(
      await errorCode(t.mutation(api.bookings.confirmOnTerms, { holdId: hold.holdId, idempotencyKey: "wrong" })),
    ).toBe("FORBIDDEN");
    const booked = await t.mutation(api.bookings.confirmOnTerms, { holdId: hold.holdId, idempotencyKey: "terms-1" });
    expect(booked).toMatchObject({
      invoiceNumber: "INV-1100",
      amountMinor: q.amountMinor,
      bookingStatus: "confirmed",
      replayed: false,
    });
    expect(booked.dueAt - booked.issuedAt).toBe(15 * DAY_MS);
    const again = await t.mutation(api.bookings.confirmOnTerms, { holdId: hold.holdId, idempotencyKey: "terms-1" });
    expect(again).toEqual({ ...booked, replayed: true });

    const state = await t.run(async (ctx) => ({
      slot: await ctx.db.get(slots[0]._id),
      booking: await ctx.db.get(booked.bookingId),
      invoice: await ctx.db.get(booked.invoiceId),
    }));
    expect(state.slot?.state).toBe("booked");
    expect(state.booking?.paymentId).toBeUndefined();
    expect(state.booking?.invoiceId).toBe(booked.invoiceId);
    expect(state.invoice).toMatchObject({ status: "open", source: "booking", advertiserId: bayRobotics });

    // A verified payment for the same hold is now a duplicate, never a second booking.
    const pay = await t.mutation(internal.payments.recordVerified, {
      holdId: hold.holdId,
      provider: "x402",
      externalRef: "0xlate",
      amountMinor: q.amountMinor,
      asset: "USDC",
      idempotencyKey: "p",
    });
    expect(pay.outcome === "exception" && pay.kind).toBe("duplicate_payment");

    // Prepay advertiser (Golden Gate Coffee, demo campaign) cannot book on terms.
    const q2 = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[1]._id] });
    const hold2 = await t.mutation(api.holds.create, { quoteId: q2.quoteId, idempotencyKey: "terms-2", actor: "buyer" });
    expect(
      await errorCode(t.mutation(api.bookings.confirmOnTerms, { holdId: hold2.holdId, idempotencyKey: "terms-2" })),
    ).toBe("TERMS_NOT_ALLOWED");
  });

  test("x402 payment after hold expiry -> AR files a refund request; controller approves", async () => {
    const t = convexTest(schema, modules);
    const seed = await t.mutation(internal.seed.demo, {});
    const slots = await t.query(api.slots.listForBillboard, {
      billboardId: seed.billboardId,
      from: FIXTURE_AS_OF,
      to: FIXTURE_AS_OF + DAY_MS,
    });
    const q = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[0]._id] });
    const hold = await t.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "late", actor: "buyer" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const pay = await t.mutation(internal.payments.recordVerified, {
      holdId: hold.holdId,
      provider: "x402",
      externalRef: "0xexpired",
      amountMinor: q.amountMinor,
      asset: "USDC",
      idempotencyKey: "late-pay",
    });
    expect(pay.outcome).toBe("exception");

    const summary = await t.mutation(api.finance.runReconciliation, {});
    expect(summary.approvalsRequested).toBe(1);
    const [refund] = await t.query(api.approvals.pending, {});
    expect(refund).toMatchObject({ action: "refund", subjectKind: "payment", requestedBy: "agent:ar", amountMinor: q.amountMinor });
    // Idempotent: a second run doesn't file another.
    expect((await t.mutation(api.finance.runReconciliation, {})).approvalsRequested).toBe(0);

    const r = await t.mutation(api.approvals.decide, { approvalId: refund._id, approvedBy: "controller", decision: "approved", note: "Refund buyer agent" });
    expect(r.executionResult).toContain("Refund of");
    if (pay.outcome !== "exception") throw new Error("unreachable");
    const payment = await t.run(async (ctx) => ctx.db.get(pay.paymentId));
    expect(payment?.status).toBe("refunded");
    expect(await t.query(api.finance.openExceptions, {})).toHaveLength(0);
  });
});

describe("bank ingest", () => {
  test("idempotent per source + externalId", async () => {
    const t = convexTest(schema, modules);
    const line = { source: "nessie" as const, externalId: "n-1", amountMinor: 1000, postedAt: FIXTURE_AS_OF, payerName: "X", memo: "" };
    const first = await t.mutation(internal.bank.ingest, { lines: [line, line] });
    expect(first).toMatchObject({ inserted: 1, duplicates: ["n-1"] });
    // Same id from a different source is a different line.
    const other = await t.mutation(internal.bank.ingest, { lines: [{ ...line, source: "fixture" }] });
    expect(other.inserted).toBe(1);
    expect(
      await errorCode(t.mutation(internal.bank.ingest, { lines: [{ ...line, externalId: "n-2", amountMinor: 0 }] })),
    ).toBe("INVALID_INPUT");
  });
});

describe("reconcile engine (pure)", () => {
  const payers = [
    { id: "a1", displayName: "Mission Bikes", aliases: ["MISSION BICYCLE CO"] },
    { id: "a2", displayName: "Sunset Records", aliases: [] },
  ];
  const inv = (id: string, number: string, advertiserId: string, balanceMinor: number, dueDay: number) => ({
    id,
    number,
    advertiserId,
    balanceMinor,
    dueAt: Date.UTC(2026, 9, dueDay),
  });
  const line = (amountMinor: number, payerName: string, memo = "") => ({
    id: "b1",
    externalId: "x-1",
    amountMinor,
    postedAt: Date.UTC(2026, 9, 22),
    payerName,
    memo,
  });

  test("helpers normalize names and invoice references", () => {
    expect(normalizeName("Harbor Dental Group")).toBe(normalizeName("HARBOR DENTAL GRP, LLC"));
    expect(parseInvoiceNumbers("pay inv#1010, INV 1011 and INV-1010")).toEqual(["INV-1010", "INV-1011"]);
  });

  test("bundle without memo reference is found by exact subset", () => {
    const d = reconcileLine({
      line: line(45000, "Mission Bicycle Co."),
      payers,
      referencedInvoices: [],
      payerOpenInvoices: [inv("i1", "INV-1001", "a1", 30000, 1), inv("i2", "INV-1002", "a1", 20000, 2), inv("i3", "INV-1003", "a1", 15000, 3)],
      priorLines: [],
    });
    expect(d.rule).toBe("payer_bundle_exact");
    expect(d.applications.map((a) => a.invoiceNumber)).toEqual(["INV-1001", "INV-1003"]);
    expect(d.outcome).toBe("matched");
  });

  test("bank payer that does not own the cited invoice is held for review", () => {
    const d = reconcileLine({
      line: line(30000, "SUNSET RECORDS", "INV-1001"),
      payers,
      referencedInvoices: [inv("i1", "INV-1001", "a1", 30000, 1)],
      payerOpenInvoices: [],
      priorLines: [],
    });
    expect(d.outcome).toBe("needs_review");
    expect(d.exceptions[0].kind).toBe("unidentified_payment");
    expect(d.applications).toHaveLength(0);
  });

  test("known payer with nothing owed -> overpayment, nothing applied", () => {
    const d = reconcileLine({ line: line(500, "Sunset Records"), payers, referencedInvoices: [], payerOpenInvoices: [], priorLines: [] });
    expect(d.rule).toBe("no_open_invoices");
    expect(d.exceptions[0]).toMatchObject({ kind: "overpayment", expectedMinor: 0, observedMinor: 500 });
  });

  test("open-balance allocation is oldest first", () => {
    const d = reconcileLine({
      line: line(35000, "Mission Bikes"),
      payers,
      referencedInvoices: [],
      payerOpenInvoices: [inv("i2", "INV-1002", "a1", 20000, 9), inv("i1", "INV-1001", "a1", 30000, 1)],
      priorLines: [],
    });
    expect(d.rule).toBe("payer_open_balance");
    expect(d.applications.map((a) => [a.invoiceNumber, a.amountMinor])).toEqual([
      ["INV-1001", 30000],
      ["INV-1002", 5000],
    ]);
    expect(d.exceptions[0]).toMatchObject({ kind: "short_payment", invoiceId: "i2" });
  });

  test("collections tone uses history", () => {
    const due = Date.UTC(2026, 9, 10);
    const asOf = due + 5 * DAY_MS;
    const late = { number: "INV-9", dueAt: due - 40 * DAY_MS, paidAt: due - 30 * DAY_MS };
    expect(chooseTone({ invoiceNumber: "INV-1", dueAt: due, asOf, history: [] }).tone).toBe("friendly");
    expect(chooseTone({ invoiceNumber: "INV-1", dueAt: due, asOf: due + DAY_MS, history: [] }).tone).toBeNull();
    expect(chooseTone({ invoiceNumber: "INV-1", dueAt: due, asOf: due + DAY_MS, history: [late] }).tone).toBe("firm");
    expect(chooseTone({ invoiceNumber: "INV-1", dueAt: due, asOf: due + 21 * DAY_MS, history: [] }).tone).toBe(
      "escalate_to_controller",
    );
  });
});

describe("demo reset", () => {
  async function snapshot(t: T) {
    return await t.run(async (ctx) => {
      const lines = await ctx.db.query("bankTransactions").collect();
      const invoices = await ctx.db.query("invoices").collect();
      return {
        lines: lines
          .map((l) => ({ externalId: l.externalId, status: l.status, appliedMinor: l.appliedMinor, amountMinor: l.amountMinor }))
          .sort((a, b) => a.externalId.localeCompare(b.externalId)),
        invoices: invoices
          .map(({ _id, _creationTime, ...rest }) => rest)
          .sort((a, b) => a.number.localeCompare(b.number)),
        applications: (await ctx.db.query("paymentApplications").collect()).length,
        exceptions: (await ctx.db.query("financeExceptions").collect()).length,
        approvals: (await ctx.db.query("approvals").collect()).length,
        tasks: (await ctx.db.query("collectionTasks").collect()).length,
      };
    });
  }

  test("reset after a full run restores the exact pre-run state; answer key passes again", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.finance, {});
    const before = await snapshot(t);
    expect(before.lines.every((l) => l.status === "unmatched")).toBe(true);

    // Full rehearsal: reconcile, a judge scenario line, approvals, collections.
    await t.mutation(internal.seed.addScenarioBankLine, { payerName: "Sunset Records", amountMinor: 30000, memo: "INV-1013" });
    await t.mutation(api.finance.runReconciliation, {});
    await t.mutation(internal.collections.plan, { asOf: FIXTURE_AS_OF });
    const refund = (await t.query(api.approvals.pending, {})).find((a) => a.action === "refund")!;
    await t.mutation(api.approvals.decide, { approvalId: refund._id, approvedBy: "controller", decision: "approved", note: "ok" });
    const unidentified = (await lineByExternalId(t, "fx-bank-007"))!;
    const match = await t.mutation(api.approvals.request, {
      action: "apply_manual_match",
      subjectId: unidentified._id,
      invoiceId: (await invoiceByNumber(t, "INV-1015"))._id,
      amountMinor: 20000,
      requestedBy: "maria.ar",
      reason: "agency",
    });
    await t.mutation(api.approvals.decide, { approvalId: match.approvalId, approvedBy: "controller", decision: "approved", note: "ok" });
    const auditBefore = (await t.run(async (ctx) => ctx.db.query("auditEvents").collect())).length;

    const reset = await t.mutation(internal.seed.resetFinanceDemo, {});
    expect(reset.bankLinesRemoved).toBe(8); // 7 fixture lines + 1 scenario line
    expect(reset.bankLinesReingested).toBe(7);
    expect(reset.invoicesRestored).toBe(16);

    const after = await snapshot(t);
    expect(after).toEqual(before);
    // History is append-only: nothing deleted, one demo.reset appended (plus ingest events).
    const audit = await t.run(async (ctx) => ctx.db.query("auditEvents").collect());
    expect(audit.length).toBeGreaterThan(auditBefore);
    expect(audit.filter((e) => e.type === "demo.reset")).toHaveLength(1);

    // The moment can be replayed and still matches the answer key.
    const summary = await t.mutation(api.finance.runReconciliation, {});
    expect(summary.lines.map((l) => l.externalId)).toEqual(Object.keys(LINE_ANSWERS));
    await assertReconciledMatchesAnswerKey(t);

    // Reset is idempotent.
    await t.mutation(internal.seed.resetFinanceDemo, {});
    await t.mutation(internal.seed.resetFinanceDemo, {});
    expect(await snapshot(t)).toEqual(before);
  });

  test("reset leaves non-fixture payments, exceptions and approvals untouched", async () => {
    const t = convexTest(schema, modules);
    const seed = await t.mutation(internal.seed.demo, {});
    await t.mutation(internal.seed.finance, {});
    const slots = await t.query(api.slots.listForBillboard, {
      billboardId: seed.billboardId,
      from: FIXTURE_AS_OF,
      to: FIXTURE_AS_OF + DAY_MS,
    });
    // A real booking paid via x402, and a late x402 payment that became an exception.
    const q1 = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[0]._id] });
    const h1 = await t.mutation(api.holds.create, { quoteId: q1.quoteId, idempotencyKey: "real-1", actor: "buyer" });
    const booked = await t.mutation(internal.payments.recordVerified, {
      holdId: h1.holdId, provider: "x402", externalRef: "0xreal", amountMinor: q1.amountMinor, asset: "USDC", idempotencyKey: "r1",
    });
    const q2 = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[1]._id] });
    const h2 = await t.mutation(api.holds.create, { quoteId: q2.quoteId, idempotencyKey: "real-2", actor: "buyer" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const late = await t.mutation(internal.payments.recordVerified, {
      holdId: h2.holdId, provider: "x402", externalRef: "0xlate", amountMinor: q2.amountMinor, asset: "USDC", idempotencyKey: "r2",
    });
    expect(booked.outcome).toBe("booked");
    expect(late.outcome).toBe("exception");
    await t.mutation(api.finance.runReconciliation, {}); // files the x402 refund request too

    const nonFixture = async () =>
      t.run(async (ctx) => ({
        payments: await ctx.db.query("payments").collect(),
        bookings: await ctx.db.query("bookings").collect(),
        exceptions: (await ctx.db.query("financeExceptions").collect()).filter((e) => e.paymentId),
        approvals: (await ctx.db.query("approvals").collect()).filter((a) => a.subjectKind === "payment"),
      }));
    const before = await nonFixture();
    expect(before.exceptions).toHaveLength(1);
    expect(before.approvals).toHaveLength(1);

    await t.mutation(internal.seed.resetFinanceDemo, {});
    expect(await nonFixture()).toEqual(before);
  });

  test("resetBookingDemo releases active holds but keeps bookings", async () => {
    const t = convexTest(schema, modules);
    const seed = await t.mutation(internal.seed.demo, {});
    const slots = await t.query(api.slots.listForBillboard, {
      billboardId: seed.billboardId,
      from: FIXTURE_AS_OF,
      to: FIXTURE_AS_OF + DAY_MS,
    });
    const q1 = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[0]._id] });
    const h1 = await t.mutation(api.holds.create, { quoteId: q1.quoteId, idempotencyKey: "b1", actor: "buyer" });
    await t.mutation(api.payments.recordManual, { holdId: h1.holdId, note: "demo" });
    const q2 = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[1]._id, slots[2]._id] });
    await t.mutation(api.holds.create, { quoteId: q2.quoteId, idempotencyKey: "b2", actor: "buyer" });

    const r = await t.mutation(internal.seed.resetBookingDemo, {});
    expect(r.holdsReleased).toBe(1);
    const state = await t.run(async (ctx) => ({
      s0: await ctx.db.get(slots[0]._id),
      s1: await ctx.db.get(slots[1]._id),
      s2: await ctx.db.get(slots[2]._id),
      bookings: await ctx.db.query("bookings").collect(),
    }));
    expect(state.s0?.state).toBe("booked");
    expect(state.s1?.state).toBe("available");
    expect(state.s2?.state).toBe("available");
    expect(state.bookings).toHaveLength(1);
  });

  test("addScenarioBankLine validates and reconciles live", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.finance, {});
    expect(
      await errorCode(t.mutation(internal.seed.addScenarioBankLine, { payerName: "", amountMinor: 100, memo: "" })),
    ).toBe("INVALID_INPUT");
    expect(
      await errorCode(t.mutation(internal.seed.addScenarioBankLine, { payerName: "X", amountMinor: 1.5, memo: "" })),
    ).toBe("INVALID_INPUT");
    const added = await t.mutation(internal.seed.addScenarioBankLine, {
      payerName: "Harbor Dental Grp",
      amountMinor: 20000,
      memo: "",
    });
    expect(added.externalId).toMatch(/^fx-scenario-/);
    const summary = await t.mutation(api.finance.runReconciliation, {});
    const line = summary.lines.find((l) => l.externalId === added.externalId)!;
    // Harbor owes INV-1014 ($350) and INV-1015 ($200); $200 exactly matches INV-1015.
    expect(line).toMatchObject({ status: "matched", rule: "payer_exact_amount" });
  });
});
