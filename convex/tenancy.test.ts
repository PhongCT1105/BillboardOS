import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  joinCompanies,
  modules,
  signedInCustomer,
  signedInOperator,
  signedInUser,
  type TestClient,
} from "./test.setup";
import { PLATFORM_AUDIT_TYPES, TENANT_TABLES } from "./migrations";

// 09:07 PDT; slots[8] airs 11:15 local (2 h out).
const START = Date.UTC(2026, 9, 25, 16, 7);
const MIN = 60_000;

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

/**
 * Two hosts and two customers:
 *  - hostA: owner of "Moscone Media" (seeded screen, finance fixture)
 *  - hostB: owner of "Mission Screens" with its own screen
 *  - custA: Golden Gate Coffee (seeded campaign); custB: Bay Robotics
 */
async function marketplace() {
  const anon = convexTest(schema, modules);
  const hostA = await signedInOperator(anon, "a@moscone.test");
  const seed = await hostA.mutation(internal.seed.demo, {});
  await hostA.mutation(internal.seed.finance, {});
  const hostB = await signedInOperator(anon, "b@mission.test", "Mission Screens");
  const billboardB = await hostB.mutation(api.billboards.create, {
    name: "Mission Street Screen",
    city: "San Francisco",
    locationLabel: "Mission St & 16th",
    utcOffsetMinutes: -420,
    baseRateMinor: 3000,
    reserveFloorMinor: 1500,
  });
  const workspaceA = (await anon.run(async (ctx) => (await ctx.db.get(seed.billboardId))!.workspaceId!))!;
  const workspaceB = (await anon.run(async (ctx) => (await ctx.db.get(billboardB))!.workspaceId!))!;
  const custA = await signedInCustomer(anon, seed.advertiserIds[0], "buyer@goldengate.test");
  const custB = await signedInCustomer(anon, seed.advertiserIds[1], "buyer@bayrobotics.test");
  const campaignB = await custB.mutation(api.campaigns.create, { brief: "Robot demo day", budgetMinor: 100_000 });
  const slotsA = await anon.query(api.slots.listForBillboard, {
    billboardId: seed.billboardId,
    from: START,
    to: START + 24 * 60 * MIN,
  });
  return { anon, hostA, hostB, custA, custB, seed, billboardB, workspaceA, workspaceB, campaignA: seed.campaignId, campaignB, slotsA };
}

describe("accounts and onboarding", () => {
  test("account type is chosen once; hosts create workspaces, customers create companies", async () => {
    const t = convexTest(schema, modules);
    const user = await signedInUser(t, "new@host.test");
    expect(await t.query(api.accounts.me, {})).toBeNull();
    expect(await user.query(api.accounts.me, {})).toMatchObject({ accountType: null, workspaces: [], companies: [] });
    expect(await errorCode(user.mutation(api.workspaces.create, { name: "Mine", city: "SF" }))).toBe("HOST_ONLY");

    await user.mutation(api.accounts.setAccountType, { accountType: "host" });
    expect(await errorCode(user.mutation(api.accounts.setAccountType, { accountType: "customer" }))).toBe("ACCOUNT_TYPE_SET");
    expect(await errorCode(user.mutation(api.accounts.createCompany, { name: "Nope" }))).toBe("CUSTOMER_ONLY");
    const ws = await user.mutation(api.workspaces.create, { name: "Dogpatch Displays", city: "San Francisco" });
    const me = (await user.query(api.accounts.me, {}))!;
    expect(me).toMatchObject({ accountType: "host", activeWorkspaceId: ws });
    expect(me.workspaces).toEqual([{ workspaceId: ws, name: "Dogpatch Displays", city: "San Francisco", role: "owner" }]);

    // Payout address: owner only, validated.
    expect(
      await errorCode(user.mutation(api.workspaces.setPayoutAddress, { workspaceId: ws, payoutAddress: "0x123" })),
    ).toBe("INVALID_INPUT");
    await user.mutation(api.workspaces.setPayoutAddress, {
      workspaceId: ws,
      payoutAddress: "0x1111111111111111111111111111111111111111",
    });
    expect((await user.query(api.workspaces.get, {})).payoutAddress).toBe("0x1111111111111111111111111111111111111111");

    // Invite: owner only, existing users only.
    const teammate = await signedInUser(t, "mate@host.test");
    expect(await errorCode(user.mutation(api.workspaces.invite, { workspaceId: ws, email: "ghost@host.test" }))).toBe(
      "USER_NOT_FOUND",
    );
    await user.mutation(api.workspaces.invite, { workspaceId: ws, email: "MATE@host.test" });
    expect(
      await errorCode(teammate.mutation(api.workspaces.invite, { workspaceId: ws, email: "new@host.test" })),
    ).toBe("OWNER_ONLY");
    expect(
      await errorCode(teammate.mutation(api.workspaces.setPayoutAddress, { workspaceId: ws, payoutAddress: null })),
    ).toBe("OWNER_ONLY");
    expect((await teammate.query(api.workspaces.get, {})).myRole).toBe("operator");

    const buyer = await signedInUser(t, "buyer@new.test");
    await buyer.mutation(api.accounts.setAccountType, { accountType: "customer" });
    const company = await buyer.mutation(api.accounts.createCompany, { name: "New Brand", website: "https://new.example", size: "11-50" });
    expect((await buyer.query(api.accounts.me, {}))!.companies).toEqual([{ advertiserId: company, displayName: "New Brand", role: "owner" }]);
    expect(await errorCode(buyer.mutation(api.accounts.createCompany, { name: "New Brand" }))).toBe("NAME_TAKEN");
  });

  test("no account gets operator rights by default (the first-account rule is gone)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.seed.demo, {});
    const first = await signedInUser(t, "first@anyone.test");
    expect(await errorCode(first.query(api.audit.recent, {}))).toBe("NO_WORKSPACE");
    expect(await errorCode(first.query(api.dashboard.summary, {}))).toBe("NO_WORKSPACE");
  });
});

describe("host isolation", () => {
  test("host B can't read host A's finance, approvals, audit or dashboard", async () => {
    const m = await marketplace();
    await m.hostA.mutation(internal.reconciliation.run, {});
    // A sees its own data...
    expect((await m.hostA.query(api.finance.bankFeed, {})).length).toBe(7);
    expect((await m.hostA.query(api.finance.openExceptions, {})).length).toBeGreaterThan(0);
    expect((await m.hostA.query(api.approvals.pending, {})).length).toBeGreaterThan(0);
    // ...B sees none of it through its own workspace...
    expect(await m.hostB.query(api.finance.bankFeed, {})).toEqual([]);
    expect(await m.hostB.query(api.finance.openExceptions, {})).toEqual([]);
    expect(await m.hostB.query(api.finance.receivables, {})).toEqual([]);
    expect(await m.hostB.query(api.approvals.pending, {})).toEqual([]);
    expect(await m.hostB.query(api.collections.tasks, {})).toEqual([]);
    const auditB = await m.hostB.query(api.audit.recent, {});
    expect(auditB.every((e) => e.workspaceId === m.workspaceB)).toBe(true);
    const dashB = await m.hostB.query(api.dashboard.summary, {});
    expect(dashB.billboards.map((b) => b.billboardId)).toEqual([m.billboardB]);
    // ...and can't ask for A's workspace explicitly.
    for (const call of [
      m.hostB.query(api.finance.bankFeed, { workspaceId: m.workspaceA }),
      m.hostB.query(api.finance.openExceptions, { workspaceId: m.workspaceA }),
      m.hostB.query(api.approvals.pending, { workspaceId: m.workspaceA }),
      m.hostB.query(api.audit.recent, { workspaceId: m.workspaceA }),
      m.hostB.query(api.dashboard.summary, { workspaceId: m.workspaceA }),
      m.hostB.query(api.collections.tasks, { workspaceId: m.workspaceA }),
      m.hostB.query(api.valuation.list, { workspaceId: m.workspaceA }),
      m.hostB.mutation(api.finance.runReconciliation, { workspaceId: m.workspaceA }),
    ]) {
      expect(await errorCode(call)).toBe("NOT_WORKSPACE_MEMBER");
    }
    expect((await m.hostB.query(api.billboards.mine, {})).map((b) => b._id)).toEqual([m.billboardB]);
  });

  test("host B can't change host A's screens, auctions, holds or approvals", async () => {
    const m = await marketplace();
    const bb = m.seed.billboardId;
    const slot = m.slotsA[8]._id;
    expect(await errorCode(m.hostB.mutation(api.billboards.setAudienceBaseline, { billboardId: bb, peoplePer15Min: 5 }))).toBe(
      "NOT_WORKSPACE_MEMBER",
    );
    expect(
      await errorCode(m.hostB.mutation(api.billboards.setAudienceTags, { billboardId: bb, audienceTags: { finance: 1 } })),
    ).toBe("NOT_WORKSPACE_MEMBER");
    expect(
      await errorCode(
        m.hostB.mutation(api.audience.addArrivals, { billboardId: bb, arrivals: 1, peakInView: 1, confidence: 1, source: "camera" }),
      ),
    ).toBe("NOT_WORKSPACE_MEMBER");
    expect(await errorCode(m.hostB.mutation(api.auctions.open, { slotIds: [slot] }))).toBe("NOT_WORKSPACE_MEMBER");

    const q = await m.custA.mutation(api.quotes.create, { campaignId: m.campaignA, slotIds: [slot] });
    const hold = await m.custA.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "hA", actor: "web" });
    expect(await errorCode(m.hostB.mutation(api.payments.recordManual, { holdId: hold.holdId, note: "x" }))).toBe(
      "NOT_WORKSPACE_MEMBER",
    );
    await expect(m.hostA.mutation(api.payments.recordManual, { holdId: hold.holdId, note: "ok" })).resolves.toMatchObject({
      outcome: "booked",
    });

    const inv = (await m.anon.run(async (ctx) => ctx.db.query("invoices").withIndex("by_number", (x) => x.eq("number", "INV-1013")).unique()))!;
    expect(
      await errorCode(
        m.hostB.mutation(api.approvals.request, { action: "write_off", subjectId: inv._id, amountMinor: 100, reason: "x" }),
      ),
    ).toBe("NOT_WORKSPACE_MEMBER");
    const req = await m.hostA.mutation(api.approvals.request, { action: "write_off", subjectId: inv._id, amountMinor: 100, reason: "x" });
    expect(
      await errorCode(m.hostB.mutation(api.approvals.decide, { approvalId: req.approvalId, decision: "approved", note: "" })),
    ).toBe("NOT_WORKSPACE_MEMBER");

    // Creative review: only hosts the campaign actually quoted.
    const storageId = await m.anon.run(async (ctx) => ctx.storage.store(new Blob(["x"], { type: "image/png" })));
    await m.custA.mutation(api.creatives.attach, { campaignId: m.campaignA, storageId, contentType: "image/png" });
    expect(await m.hostB.query(api.creatives.pendingReview, {})).toEqual([]);
    expect(
      await errorCode(m.hostB.mutation(api.creatives.review, { campaignId: m.campaignA, decision: "approved", reason: "x" })),
    ).toBe("NOT_WORKSPACE_MEMBER");
    expect((await m.hostA.query(api.creatives.pendingReview, {})).map((r) => r.campaignId)).toEqual([m.campaignA]);
  });

  test("separation of duties is per workspace; company overrides are per workspace", async () => {
    const m = await marketplace();
    const controllerA = await signedInOperator(m.anon, "controller@moscone.test");
    const inv = (await m.anon.run(async (ctx) => ctx.db.query("invoices").withIndex("by_number", (x) => x.eq("number", "INV-1013")).unique()))!;
    const req = await m.hostA.mutation(api.approvals.request, { action: "write_off", subjectId: inv._id, amountMinor: 500, reason: "goodwill" });
    expect(
      await errorCode(m.hostA.mutation(api.approvals.decide, { approvalId: req.approvalId, decision: "approved", note: "" })),
    ).toBe("SOD_VIOLATION");
    const r = await controllerA.mutation(api.approvals.decide, { approvalId: req.approvalId, decision: "approved", note: "ok" });
    expect(r.status).toBe("approved");

    // Host B pins Golden Gate at x1.5 in ITS workspace (after Golden Gate quoted B); host A's quotes don't change.
    const slotsB0 = await m.anon.query(api.slots.listForBillboard, { billboardId: m.billboardB, from: START, to: START + 24 * 60 * MIN });
    await m.custA.mutation(api.quotes.create, { campaignId: m.campaignA, slotIds: [slotsB0[7]._id] });
    await m.hostB.mutation(api.valuation.override, { advertiserId: m.seed.advertiserIds[0], multiplier: 1.5, reason: "B only" });
    const qa = await m.custA.mutation(api.quotes.create, { campaignId: m.campaignA, slotIds: [m.slotsA[8]._id] });
    expect(qa.amountMinor).toBe(qa.priceBreakdown[0].screenMinor);
    const slotsB = await m.anon.query(api.slots.listForBillboard, { billboardId: m.billboardB, from: START, to: START + 24 * 60 * MIN });
    const qb = await m.custA.mutation(api.quotes.create, { campaignId: m.campaignA, slotIds: [slotsB[8]._id] });
    expect(qb.amountMinor).toBe(Math.round(qb.priceBreakdown[0].screenMinor * 1.5));
    const listA = await m.hostA.query(api.valuation.list, {});
    expect(listA.find((x) => x.advertiserId === m.seed.advertiserIds[0])?.assessment?.method).not.toBe("override");
  });
});

describe("customer isolation", () => {
  test("customer B can't see or act on customer A's campaigns, quotes, holds or bids", async () => {
    const m = await marketplace();
    expect((await m.custA.query(api.campaigns.list, {})).map((c) => c._id)).toEqual([m.campaignA]);
    expect((await m.custB.query(api.campaigns.list, {})).map((c) => c._id)).toEqual([m.campaignB]);
    expect(await errorCode(m.custB.query(api.campaigns.list, { advertiserId: m.seed.advertiserIds[0] }))).toBe("NOT_COMPANY_MEMBER");
    expect(
      await errorCode(m.custB.mutation(api.campaigns.create, { advertiserId: m.seed.advertiserIds[0], brief: "x", budgetMinor: 100 })),
    ).toBe("NOT_COMPANY_MEMBER");
    const slot = m.slotsA[8]._id;
    expect(await errorCode(m.custB.mutation(api.quotes.create, { campaignId: m.campaignA, slotIds: [slot] }))).toBe("NOT_COMPANY_MEMBER");

    const q = await m.custA.mutation(api.quotes.create, { campaignId: m.campaignA, slotIds: [slot] });
    expect(await errorCode(m.custB.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "steal", actor: "x" }))).toBe(
      "NOT_COMPANY_MEMBER",
    );
    const hold = await m.custA.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "mine-1", actor: "web" });
    expect(await errorCode(m.custB.mutation(api.holds.release, { holdId: hold.holdId, idempotencyKey: "mine-1" }))).toBe(
      "NOT_COMPANY_MEMBER",
    );
    expect(await errorCode(m.custB.mutation(api.bookings.confirmOnTerms, { holdId: hold.holdId, idempotencyKey: "mine-1" }))).toBe(
      "NOT_COMPANY_MEMBER",
    );
    const storageId = await m.anon.run(async (ctx) => ctx.storage.store(new Blob(["x"], { type: "image/png" })));
    expect(
      await errorCode(m.custB.mutation(api.creatives.attach, { campaignId: m.campaignA, storageId, contentType: "image/png" })),
    ).toBe("NOT_COMPANY_MEMBER");

    const { auctionId } = await m.hostA.mutation(api.auctions.open, { slotIds: [m.slotsA[10]._id] });
    const joinA = await m.custA.mutation(api.auctions.join, { auctionId, campaignId: m.campaignA });
    expect(await errorCode(m.custB.mutation(api.auctions.join, { auctionId, campaignId: m.campaignA }))).toBe("NOT_COMPANY_MEMBER");
    // Even holding A's bidder key, B can't bid or read status as A.
    const asA = { auctionId, campaignId: m.campaignA, bidderKey: joinA.bidderKey };
    expect(await errorCode(m.custB.mutation(api.auctions.bid, { ...asA, amountMinor: 9000 }))).toBe("NOT_COMPANY_MEMBER");
    expect(await errorCode(m.custB.mutation(api.auctions.setAutoBid, { ...asA, maxMinor: 9000 }))).toBe("NOT_COMPANY_MEMBER");
    expect(await errorCode(m.custB.query(api.auctions.myStatus, asA))).toBe("NOT_COMPANY_MEMBER");
    await expect(m.custA.mutation(api.auctions.bid, { ...asA, amountMinor: 9000 })).resolves.toMatchObject({ leading: true });
  });

  test("customer actions need sign-in; marketplace browsing stays public", async () => {
    const m = await marketplace();
    const { anon } = m;
    expect(await errorCode(anon.query(api.campaigns.list, {}))).toBe("UNAUTHENTICATED");
    expect(await errorCode(anon.mutation(api.quotes.create, { campaignId: m.campaignA, slotIds: [m.slotsA[8]._id] }))).toBe(
      "UNAUTHENTICATED",
    );
    expect(await errorCode(anon.mutation(api.creatives.generateUploadUrl, {}))).toBe("UNAUTHENTICATED");
    const hostOnly = await signedInUser(anon, "nobody@nowhere.test");
    expect(await errorCode(hostOnly.mutation(api.campaigns.create, { brief: "x", budgetMinor: 100 }))).toBe("NO_COMPANY");

    expect((await anon.query(api.billboards.list, {})).length).toBe(2);
    expect((await anon.query(api.billboards.recommend, { targetAudience: { software: 1 } })).length).toBe(2);
    await expect(anon.query(api.auctions.live, {})).resolves.toBeDefined();
    await expect(anon.query(api.player.nowPlaying, { billboardId: m.billboardB, atMinute: START })).resolves.toBeDefined();
  });
});

describe("tenancy migration", () => {
  test("backfills every table from the record it points at, makes legacy operators owners, and is idempotent", async () => {
    const t = convexTest(schema, modules);
    const op = await signedInOperator(t, "seed-runner@moscone.test");
    const seed = await op.mutation(internal.seed.demo, {});
    await op.mutation(internal.seed.finance, {});
    await joinCompanies(op);
    // Produce rows in many tables: quote, hold, manual payment, booking, auction, reconciliation, collections.
    const slots = await t.query(api.slots.listForBillboard, { billboardId: seed.billboardId, from: START, to: START + 24 * 60 * MIN });
    const q = await op.mutation(api.quotes.create, { campaignId: seed.campaignId, slotIds: [slots[8]._id] });
    const h = await op.mutation(api.holds.create, { quoteId: q.quoteId, idempotencyKey: "m1", actor: "web" });
    await op.mutation(api.payments.recordManual, { holdId: h.holdId, note: "pre-migration" });
    await op.mutation(api.auctions.open, { slotIds: [slots[12]._id] });
    await op.mutation(internal.reconciliation.run, {});
    await op.mutation(internal.collections.plan, {});

    // A second, already-tenanted workspace whose legacy children must follow their billboard.
    const other = await signedInOperator(t, "b@mission.test", "Mission Screens");
    const billboardB = await other.mutation(api.billboards.create, {
      name: "Mission Street Screen",
      city: "San Francisco",
      locationLabel: "Mission St",
      utcOffsetMinutes: -420,
      baseRateMinor: 3000,
      reserveFloorMinor: 1500,
    });

    // Simulate pre-ADR-0004 data: strip workspaceId everywhere except billboard B; add a legacy operator.
    const legacyUser = await t.run(async (ctx) => {
      for (const table of TENANT_TABLES) {
        for (const doc of await ctx.db.query(table).take(2000)) {
          if (table === "billboards" && doc._id === billboardB) continue;
          await ctx.db.patch(doc._id, { workspaceId: undefined } as never);
        }
      }
      const userId = await ctx.db.insert("users", { email: "legacy@operator.test" });
      await ctx.db.insert("operators", { userId, email: "legacy@operator.test", grantedBy: "system:first-user" });
      return userId;
    });

    const first = await t.action(internal.migrations.run, {});
    expect(first.ownersAdded).toBe(1);
    expect(first.tables.reduce((s, x) => s + x.patched, 0)).toBeGreaterThan(100);

    const result = await t.run(async (ctx) => {
      const missing: string[] = [];
      for (const table of TENANT_TABLES) {
        const rows = await ctx.db.query(table).take(5000);
        const unassigned = rows.filter(
          (r) =>
            !(r as { workspaceId?: Id<"workspaces"> }).workspaceId &&
            !(table === "auditEvents" && PLATFORM_AUDIT_TYPES.has((r as { type: string }).type)),
        );
        if (unassigned.length > 0) missing.push(table);
      }
      const slotsB = await ctx.db
        .query("slots")
        .withIndex("by_billboard_and_startAt", (x) => x.eq("billboardId", billboardB))
        .take(5);
      const member = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_and_user", (x) => x.eq("workspaceId", first.workspaceId).eq("userId", legacyUser))
        .unique();
      const profile = await ctx.db.query("profiles").withIndex("by_userId", (x) => x.eq("userId", legacyUser)).unique();
      return { missing, slotsB, member, profile };
    });
    expect(result.missing).toEqual([]);
    const workspaceB = (await t.run(async (ctx) => (await ctx.db.get(billboardB))!.workspaceId))!;
    expect(result.slotsB.every((s) => s.workspaceId === workspaceB)).toBe(true);
    expect(result.member?.role).toBe("owner");
    expect(result.profile).toMatchObject({ accountType: "host", activeWorkspaceId: first.workspaceId });

    // Idempotent.
    const second = await t.action(internal.migrations.run, {});
    expect(second.ownersAdded).toBe(0);
    expect(second.tables.every((x) => x.patched === 0)).toBe(true);

    // The migrated legacy operator can now use the console.
    const legacy = t.withIdentity({ subject: `${legacyUser}|s` });
    expect((await legacy.query(api.finance.bankFeed, {})).length).toBe(7);
  });
});

export type { TestClient };
