import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules, signedInOperator, signedInUser, type TestClient } from "./test.setup";
import { ensureFirstOperator } from "./lib/operator";

const START = Date.UTC(2026, 9, 25, 16, 7);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
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

async function world() {
  const anon = convexTest(schema, modules);
  const op = await signedInOperator(anon, "ops@billboardos.test");
  const seed = await op.mutation(internal.seed.demo, {});
  await op.mutation(internal.seed.finance, {});
  const slots = await anon.query(api.slots.listForBillboard, {
    billboardId: seed.billboardId,
    from: START,
    to: START + 24 * 3600_000,
  });
  const q = await anon.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[0]._id] });
  const hold = await anon.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "k", actor: "buyer" });
  const invoiceId = (await op.run(async (ctx) =>
    ctx.db.query("invoices").withIndex("by_number", (x) => x.eq("number", "INV-1013")).unique(),
  ))!._id;
  return { anon, op, seed, slots, hold, invoiceId };
}

/** Every operator-only function, with valid args. */
function operatorCalls(w: Awaited<ReturnType<typeof world>>) {
  const b = w.seed.billboardId;
  return {
    "payments.recordManual": (c: TestClient) => c.mutation(api.payments.recordManual, { holdId: w.hold.holdId, note: "x" }),
    "creatives.review": (c: TestClient) =>
      c.mutation(api.creatives.review, { campaignId: w.seed.campaignId, decision: "approved", reason: "ok" }),
    "creatives.pendingReview": (c: TestClient) => c.query(api.creatives.pendingReview, {}),
    "billboards.setAudienceBaseline": (c: TestClient) =>
      c.mutation(api.billboards.setAudienceBaseline, { billboardId: b, peoplePer15Min: 50 }),
    "finance.runReconciliation": (c: TestClient) => c.mutation(api.finance.runReconciliation, {}),
    "finance.openExceptions": (c: TestClient) => c.query(api.finance.openExceptions, {}),
    "finance.receivables": (c: TestClient) => c.query(api.finance.receivables, {}),
    "finance.bankFeed": (c: TestClient) => c.query(api.finance.bankFeed, {}),
    "approvals.request": (c: TestClient) =>
      c.mutation(api.approvals.request, { action: "write_off", subjectId: w.invoiceId, amountMinor: 100, reason: "r" }),
    "approvals.pending": (c: TestClient) => c.query(api.approvals.pending, {}),
    "collections.dueForFollowUp": (c: TestClient) => c.query(api.collections.dueForFollowUp, {}),
    "collections.tasks": (c: TestClient) => c.query(api.collections.tasks, {}),
    "audit.recent": (c: TestClient) => c.query(api.audit.recent, {}),
    "audit.forTrace": (c: TestClient) => c.query(api.audit.forTrace, { traceId: "x" }),
    "dashboard.summary": (c: TestClient) => c.query(api.dashboard.summary, {}),
    "audience.addArrivals": (c: TestClient) =>
      c.mutation(api.audience.addArrivals, { billboardId: b, arrivals: 1, peakInView: 1, confidence: 0.5, source: "camera" }),
    "audience.record": (c: TestClient) =>
      c.mutation(api.audience.record, { billboardId: b, countEstimate: 1, confidence: 0.5, source: "camera" }),
    "operators.list": (c: TestClient) => c.query(api.operators.list, {}),
    "operators.grant": (c: TestClient) => c.mutation(api.operators.grant, { email: "ops@billboardos.test" }),
  };
}

describe("operator-only functions", () => {
  test("signed out -> UNAUTHENTICATED, signed in but not operator -> NOT_OPERATOR, operator -> ok", async () => {
    const w = await world();
    const stranger = await signedInUser(w.anon);
    for (const [name, call] of Object.entries(operatorCalls(w))) {
      expect(await errorCode(call(w.anon)), `${name} signed out`).toBe("UNAUTHENTICATED");
      expect(await errorCode(call(stranger)), `${name} non-operator`).toBe("NOT_OPERATOR");
    }
    for (const [name, call] of Object.entries(operatorCalls(w))) {
      if (name === "creatives.review") continue; // needs a pending creative; covered in lifecycle tests
      await expect(call(w.op), name).resolves.toBeDefined();
    }
  });

  test("advertiser, player and payment-server paths stay public", async () => {
    const w = await world();
    const { anon } = w;
    await expect(anon.query(api.billboards.list, {})).resolves.toHaveLength(1);
    await expect(anon.query(api.campaigns.list, {})).resolves.toBeDefined();
    const campaignId = await anon.mutation(api.campaigns.create, {
      advertiserId: w.seed.advertiserIds[1],
      brief: "public brief",
      budgetMinor: 1000,
    });
    expect(campaignId).toBeDefined();
    await expect(anon.mutation(api.creatives.generateUploadUrl, {})).resolves.toEqual(expect.any(String));
    await expect(
      anon.query(api.player.nowPlaying, { billboardId: w.seed.billboardId, atMinute: START }),
    ).resolves.toMatchObject({ billboard: { name: "Moscone West Screen" } });
    await expect(
      anon.mutation(api.holds.release, { holdId: w.hold.holdId, idempotencyKey: "k" }),
    ).resolves.toMatchObject({ status: "released" });
    await expect(anon.query(api.audience.recentForBillboard, { billboardId: w.seed.billboardId })).resolves.toEqual([]);
    expect(await anon.query(api.operators.me, {})).toBeNull();
  });

  test("manual payment and baseline changes record the operator identity", async () => {
    const w = await world();
    await w.op.mutation(api.payments.recordManual, { holdId: w.hold.holdId, note: "demo" });
    await w.op.mutation(api.billboards.setAudienceBaseline, { billboardId: w.seed.billboardId, peoplePer15Min: 40 });
    const events = await w.op.query(api.audit.recent, {});
    expect(events.find((e) => e.type === "payment.confirmed")?.actor).toBe("operator:ops@billboardos.test");
    expect(events.find((e) => e.type === "billboard.baseline_changed")?.actor).toBe("operator:ops@billboardos.test");
  });
});

describe("approvals use session identities", () => {
  test("requester and approver are recorded from the session; self-approval is blocked", async () => {
    const w = await world();
    const ctrl = await signedInOperator(w.anon, "controller@billboardos.test");
    const req = await w.op.mutation(api.approvals.request, {
      action: "write_off",
      subjectId: w.invoiceId,
      amountMinor: 500,
      reason: "goodwill",
    });
    const pending = await ctrl.query(api.approvals.pending, {});
    expect(pending.find((a) => a._id === req.approvalId)?.requestedBy).toBe("operator:ops@billboardos.test");

    expect(
      await errorCode(w.op.mutation(api.approvals.decide, { approvalId: req.approvalId, decision: "approved", note: "" })),
    ).toBe("SOD_VIOLATION");
    const r = await ctrl.mutation(api.approvals.decide, { approvalId: req.approvalId, decision: "approved", note: "ok" });
    expect(r.status).toBe("approved");
    const approval = await w.op.run(async (ctx) => ctx.db.get(req.approvalId));
    expect(approval).toMatchObject({
      requestedBy: "operator:ops@billboardos.test",
      decidedBy: "operator:controller@billboardos.test",
    });
  });
});

describe("operators", () => {
  test("first account becomes operator; later accounts need a grant", async () => {
    const t = convexTest(schema, modules);
    const first = await t.run(async (ctx) => ctx.db.insert("users", { email: "first@billboardos.test" }));
    const second = await t.run(async (ctx) => ctx.db.insert("users", { email: "second@billboardos.test" }));
    expect(await t.run(async (ctx) => ensureFirstOperator(ctx, first))).toBe(true);
    expect(await t.run(async (ctx) => ensureFirstOperator(ctx, second))).toBe(false);

    const firstClient = t.withIdentity({ subject: `${first}|s1` });
    const secondClient = t.withIdentity({ subject: `${second}|s2` });
    expect(await firstClient.query(api.operators.me, {})).toMatchObject({ email: "first@billboardos.test", isOperator: true });
    expect(await secondClient.query(api.operators.me, {})).toMatchObject({ isOperator: false });
    expect(await errorCode(secondClient.query(api.audit.recent, {}))).toBe("NOT_OPERATOR");

    expect(await errorCode(secondClient.mutation(api.operators.grant, { email: "second@billboardos.test" }))).toBe(
      "NOT_OPERATOR",
    );
    expect(await errorCode(firstClient.mutation(api.operators.grant, { email: "nobody@billboardos.test" }))).toBe(
      "USER_NOT_FOUND",
    );
    const g = await firstClient.mutation(api.operators.grant, { email: "  Second@BillboardOS.test " });
    expect(g).toMatchObject({ userId: second as Id<"users">, alreadyOperator: false });
    await expect(secondClient.query(api.audit.recent, {})).resolves.toBeDefined();
    const ops = await firstClient.query(api.operators.list, {});
    expect(ops.map((o) => [o.email, o.grantedBy])).toEqual([
      ["first@billboardos.test", "system:first-user"],
      ["second@billboardos.test", "operator:first@billboardos.test"],
    ]);
  });
});
