import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { joinCompanies, modules, signedInCustomer, signedInOperator } from "./test.setup";
import {
  DEFAULT_POLICY,
  REVIEW_ACTOR,
  decideForWorkspace,
  heuristicVerdict,
  parseVerdict,
} from "./lib/creativeReview";

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

describe("review rules", () => {
  test("heuristic finds sensitive categories by whole word", () => {
    expect(heuristicVerdict({ texts: ["Casino night at the pier"], describe: "x" })).toMatchObject({ safe: true, categories: ["gambling"] });
    expect(heuristicVerdict({ texts: ["Craft beer tasting"], describe: "x" }).categories).toEqual(["alcohol"]);
    expect(heuristicVerdict({ texts: ["NSFW stuff"], describe: "x" }).safe).toBe(false);
    // No substring matches: "Ginger" is not gin, "slots" (screen slots) and "candidate" are not flagged.
    expect(heuristicVerdict({ texts: ["Ginger tea; book slots; hire a candidate"], describe: "x" }).categories).not.toContain("alcohol");
    expect(heuristicVerdict({ texts: ["Book slots near Moscone"], describe: "x" }).categories).toEqual([]);
    expect(heuristicVerdict({ texts: ["Developer launch"], knowledgeCategory: "tobacco", describe: "x" }).categories).toContain("tobacco");
  });

  test("policy decides per workspace", () => {
    const safe = { safe: true, categories: ["ai"], reason: "fine", method: "heuristic" as const };
    expect(decideForWorkspace(safe, DEFAULT_POLICY).verdict).toBe("approved");
    expect(decideForWorkspace(safe, { autoApprove: false, blockedCategories: [] }).verdict).toBe("held");
    expect(decideForWorkspace({ ...safe, categories: ["alcohol"] }, DEFAULT_POLICY)).toMatchObject({ verdict: "flagged" });
    expect(decideForWorkspace({ ...safe, categories: ["alcohol"] }, { autoApprove: true, blockedCategories: [] }).verdict).toBe("approved");
    expect(decideForWorkspace({ ...safe, safe: false }, { autoApprove: true, blockedCategories: [] }).verdict).toBe("flagged");
  });

  test("parseVerdict validates untrusted model output", () => {
    expect(parseVerdict({ safe: true, categories: ["Alcohol", "made-up", "ai"], reason: " ok " })).toEqual({ safe: true, categories: ["alcohol", "ai"], reason: "ok" });
    expect(parseVerdict({ safe: "yes", categories: [], reason: "x" })).toBeNull();
    expect(parseVerdict({ safe: true, categories: [], reason: "" })).toBeNull();
  });
});

/** Two host workspaces (A: Moscone Media, B: Pier Screens) and one customer company. */
async function world(brief = "Launch week for our developer API platform") {
  const t = convexTest(schema, modules);
  const hostA = await signedInOperator(t, "owner@a.test");
  const operatorA = await signedInOperator(t, "ops@a.test");
  const hostB = await signedInOperator(t, "owner@b.test", "Pier Screens");
  const [wsA, wsB] = await t.run(async (ctx) => {
    const a = await ctx.db.query("workspaces").withIndex("by_name", (q) => q.eq("name", "Moscone Media")).first();
    const b = await ctx.db.query("workspaces").withIndex("by_name", (q) => q.eq("name", "Pier Screens")).first();
    return [a!._id, b!._id];
  });
  const advertiserId = await t.run(async (ctx) => ctx.db.insert("advertisers", { displayName: "LaunchKit", paymentTerms: "prepay" }));
  const customer = await signedInCustomer(t, advertiserId, "buyer@launchkit.test");
  const campaignId = await t.run(async (ctx) =>
    ctx.db.insert("campaigns", {
      advertiserId,
      brief,
      budgetMinor: 5000,
      currency: "USD",
      status: "active",
      creativeStatus: "none",
      targetAudience: { software: 1 },
    }),
  );
  async function upload() {
    const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["png"], { type: "image/png" })));
    await customer.mutation(api.creatives.attach, { campaignId, storageId, contentType: "image/png" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    return storageId;
  }
  async function approvals() {
    return await t.run(async (ctx) =>
      ctx.db
        .query("creativeApprovals")
        .withIndex("by_campaign", (q) => q.eq("campaignId", campaignId))
        .take(10),
    );
  }
  return { t, hostA, operatorA, hostB, wsA, wsB, advertiserId, customer, campaignId, upload, approvals };
}

function approvedIn(rows: { workspaceId: Id<"workspaces">; approvedBy: string }[]) {
  return rows.map((r) => [r.workspaceId, r.approvedBy]);
}

describe("creative review agent", () => {
  test("a safe upload is approved for every host by the agent, with the reason shown", async () => {
    const w = await world();
    await w.upload();
    expect(approvedIn(await w.approvals())).toEqual(
      expect.arrayContaining([
        [w.wsA, REVIEW_ACTOR],
        [w.wsB, REVIEW_ACTOR],
      ]),
    );
    const reviews = await w.hostA.query(api.creativeReview.forWorkspace, {});
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ campaignId: w.campaignId, advertiserName: "LaunchKit", verdict: "approved", method: "heuristic" });
    expect(reviews[0].label).toMatch(/^Approved by creative review agent: Text check/);
    expect(await w.hostA.query(api.creativeReview.forCampaign, { campaignId: w.campaignId })).toMatchObject({ verdict: "approved" });

    const ready = await w.hostA.query(api.creatives.readyForWorkspace, {});
    expect(ready[0]).toMatchObject({ campaignId: w.campaignId, ready: true, approvedBy: REVIEW_ACTOR });
    expect(ready[0].agentNote).toMatch(/^Approved by creative review agent/);

    const audit = await w.t.run(async (ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_subject", (q) => q.eq("subjectId", w.campaignId))
        .take(50),
    );
    const agentEvents = audit.filter((e) => e.actor === REVIEW_ACTOR && e.type === "creative.ready");
    expect(agentEvents.map((e) => e.workspaceId).sort()).toEqual([w.wsA, w.wsB].sort());
    expect(agentEvents[0].reason).toMatch(/^Approved by creative review agent: /);

    const mine = await w.customer.query(api.creativeReview.forMyCampaign, { campaignId: w.campaignId });
    expect(mine.map((r) => r.verdict)).toEqual(["approved", "approved"]);
  });

  test("a blocked category is flagged and left pending for the host, who can override", async () => {
    const w = await world("Craft beer tasting at our brewery");
    await w.upload();
    expect(await w.approvals()).toEqual([]);
    const [review] = await w.hostA.query(api.creativeReview.forWorkspace, {});
    expect(review).toMatchObject({ verdict: "flagged", categories: ["alcohol"] });
    expect(review.label).toMatch(/^Flagged by creative review agent: Flagged: alcohol is blocked on your screens/);
    const ready = await w.hostA.query(api.creatives.readyForWorkspace, {});
    expect(ready[0]).toMatchObject({ ready: false });
    expect(ready[0].agentNote).toMatch(/^Flagged by creative review agent/);

    // The host overrides: approved by hand, and the agent keeps out of it from now on.
    await w.hostA.mutation(api.creatives.setReady, { campaignId: w.campaignId, ready: true });
    expect(approvedIn(await w.approvals())).toEqual([[w.wsA, "operator:owner@a.test"]]);
    await w.hostA.mutation(api.creativeReview.setPolicy, { autoApprove: true, blockedCategories: ["alcohol"] });
    expect(approvedIn(await w.approvals())).toEqual([[w.wsA, "operator:owner@a.test"]]);
    expect((await w.hostA.query(api.creativeReview.forCampaign, { campaignId: w.campaignId }))?.verdict).toBe("skipped");

    // Host B unblocks alcohol: the earlier verdict is re-applied without a new review.
    await w.hostB.mutation(api.creativeReview.setPolicy, { autoApprove: true, blockedCategories: ["gambling"] });
    expect(approvedIn(await w.approvals())).toEqual(
      expect.arrayContaining([
        [w.wsA, "operator:owner@a.test"],
        [w.wsB, REVIEW_ACTOR],
      ]),
    );
  });

  test("auto-approve off holds it for the host; turning it on approves; the agent's approval can be withdrawn by policy", async () => {
    const w = await world();
    expect(await w.hostA.query(api.creativeReview.policy, {})).toEqual({ ...DEFAULT_POLICY, isDefault: true });
    await w.hostA.mutation(api.creativeReview.setPolicy, { autoApprove: false, blockedCategories: [" Alcohol ", "alcohol", "gambling"] });
    expect(await w.hostA.query(api.creativeReview.policy, {})).toEqual({ autoApprove: false, blockedCategories: ["alcohol", "gambling"], isDefault: false });
    await w.upload();
    // Isolation: A holds, B (default policy) approves.
    expect(approvedIn(await w.approvals())).toEqual([[w.wsB, REVIEW_ACTOR]]);
    const [held] = await w.hostA.query(api.creativeReview.forWorkspace, {});
    expect(held.verdict).toBe("held");
    expect(held.label).toMatch(/^Waiting for you/);

    await w.hostA.mutation(api.creativeReview.setPolicy, { autoApprove: true, blockedCategories: [] });
    expect(approvedIn(await w.approvals())).toEqual(expect.arrayContaining([[w.wsA, REVIEW_ACTOR]]));

    // Blocking the company's category later withdraws only the agent's own approval.
    await w.hostA.mutation(api.creativeReview.setPolicy, { autoApprove: true, blockedCategories: ["developer tools"] });
    expect(approvedIn(await w.approvals())).toEqual([[w.wsB, REVIEW_ACTOR]]);
  });

  test("only owners change the policy; customers and other hosts see nothing of it", async () => {
    const w = await world();
    expect(await errorCode(w.operatorA.mutation(api.creativeReview.setPolicy, { autoApprove: false, blockedCategories: [] }))).toBe("OWNER_ONLY");
    expect(await errorCode(w.customer.mutation(api.creativeReview.setPolicy, { autoApprove: false, blockedCategories: [] }))).toBe("NO_WORKSPACE");
    expect(await errorCode(w.hostB.query(api.creativeReview.policy, { workspaceId: w.wsA }))).toBe("NOT_WORKSPACE_MEMBER");
    expect(await errorCode(w.hostB.query(api.creativeReview.forWorkspace, { workspaceId: w.wsA }))).toBe("NOT_WORKSPACE_MEMBER");
    expect(await errorCode(w.hostA.query(api.creativeReview.forMyCampaign, { campaignId: w.campaignId }))).toBe("NOT_COMPANY_MEMBER");
    const otherCompany = await w.t.run(async (ctx) => ctx.db.insert("advertisers", { displayName: "Rivet", paymentTerms: "prepay" }));
    const rival = await signedInCustomer(w.t, otherCompany, "buyer@rivet.test");
    expect(await errorCode(rival.query(api.creativeReview.forMyCampaign, { campaignId: w.campaignId }))).toBe("NOT_COMPANY_MEMBER");
  });

  test("a new upload clears every approval and is reviewed again; stale verdicts are dropped", async () => {
    const w = await world();
    const first = await w.upload();
    expect(await w.approvals()).toHaveLength(2);
    // A verdict for the old file arriving late changes nothing.
    const storageId = await w.t.run(async (ctx) => ctx.storage.store(new Blob(["png2"], { type: "image/png" })));
    await w.customer.mutation(api.creatives.attach, { campaignId: w.campaignId, storageId, contentType: "image/png" });
    expect(await w.approvals()).toEqual([]);
    const late = await w.t.mutation(internal.creativeReview.applyVerdict, {
      campaignId: w.campaignId,
      creativeRef: `storage:${first}`,
      safe: true,
      categories: [],
      reason: "old",
      method: "heuristic",
    });
    expect(late.stale).toBe(true);
    expect(await w.approvals()).toEqual([]);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await w.approvals()).toHaveLength(2);
  });

  test("a new workspace gets earlier verdicts applied without a new review", async () => {
    const w = await world();
    await w.upload();
    const hostC = await signedInOperator(w.t, "owner@c.test", "Ferry Building");
    const wsC = await w.t.run(async (ctx) => (await ctx.db.query("workspaces").withIndex("by_name", (q) => q.eq("name", "Ferry Building")).first())!._id);
    const r = await w.t.mutation(internal.creativeReview.reviewForNewWorkspace, { workspaceId: wsC });
    expect(r).toEqual({ applied: 1, scheduled: 0 });
    expect((await hostC.query(api.creativeReview.forWorkspace, {}))[0]).toMatchObject({ verdict: "approved" });
    expect(approvedIn(await w.approvals())).toEqual(expect.arrayContaining([[wsC, REVIEW_ACTOR]]));
  });

  test("agent approval schedules this workspace's confirmed bookings", async () => {
    const t = await signedInOperator(convexTest(schema, modules));
    const seed = await t.mutation(internal.seed.demo, {});
    await joinCompanies(t);
    const slots = await t.query(api.slots.listForBillboard, { billboardId: seed.billboardId, from: START, to: START + 86_400_000 });
    const q = await t.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[0]._id] });
    const hold = await t.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "cr1", actor: "buyer" });
    const tx = `0x${"cd".repeat(32)}`;
    const result = await t.mutation(internal.payments.recordVerified, {
      holdId: hold.holdId,
      provider: "x402",
      externalRef: tx,
      amountMinor: hold.amountMinor,
      asset: "USDC",
      network: "eip155:84532",
      idempotencyKey: `x402:${tx}`,
    });
    if (result.outcome !== "booked") throw new Error(`expected booked, got ${result.outcome}`);
    const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["png"], { type: "image/png" })));
    await t.mutation(api.creatives.attach, { campaignId: seed.campaignId, storageId, contentType: "image/png" });
    expect((await t.run(async (ctx) => ctx.db.get(result.bookingId)))?.status).toBe("confirmed");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const [booking, slot] = await t.run(async (ctx) => [await ctx.db.get(result.bookingId), await ctx.db.get(slots[0]._id)] as const);
    expect(booking?.status).toBe("scheduled");
    expect(slot?.state).toBe("scheduled");
  });
});

