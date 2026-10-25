/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules, registerBackendComponents, signedInCustomer, signedInOperator, type TestClient } from "./test.setup";
import { closeRoundCore, startRoundCore } from "./rounds";
import { REJECT_STREAK_THRESHOLD } from "./lib/inviteRoster";

const START = Date.UTC(2026, 9, 25, 16, 7);
const SITE = "https://site.test";
const SECRET = "test-internal-secret-0123456789";
const STANDING = { maxPricePerSpotMinor: 500, minRelevantViewers: 1, dailyBudgetMinor: 1000 };
const WINDOW = 30_000;

let current: TestClient | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  process.env.INTERNAL_API_SECRET = SECRET;
  process.env.CONVEX_SITE_URL = SITE;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(SITE) && current) return await current.fetch(url.slice(SITE.length), init);
      if (url.startsWith("https://agent.test/")) return new Response("ok", { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.INTERNAL_API_SECRET;
  delete process.env.CONVEX_SITE_URL;
  current = null;
});

describe("invite cool-down rotation", () => {
  test("three price rejects cool a company out so the next-best enters", async () => {
    const t = convexTest(schema, modules);
    registerBackendComponents(t);
    current = t;
    const host = await signedInOperator(t, "host@venue.test");
    const workspaceId = await t.run(async (ctx) => {
      const ws = (await ctx.db.query("workspaces").withIndex("by_name", (q) => q.eq("name", "Moscone Media")).first())!;
      // Keep the test in control of when rounds start (no pay-deadline auto-chain).
      await ctx.db.patch(ws._id, { autoSellRounds: false });
      return ws._id;
    });

    const led = await t.run(async (ctx) => {
      const id = await ctx.db.insert("billboards", {
        workspaceId,
        name: "LED",
        city: "San Francisco",
        locationLabel: "Lobby",
        utcOffsetMinutes: -420,
        reserveFloorMinor: 100,
        baseRateMinor: 100,
        deviceStatus: "online",
        audienceTags: { startups: 0.5, software: 0.5 },
      });
      const deviceId = await ctx.db.insert("screenDevices", {
        deviceKeyHash: "cool-test",
        pairingCode: "COOL01",
        codeExpiresAt: 0,
        billboardId: id,
        utcOffsetMinutes: -420,
        lastSeenAt: Date.now(),
        createdAt: Date.now(),
      });
      await ctx.db.patch(id, { deviceId });
      return id;
    });

    async function addCompany(name: string, factor: number) {
      const slug = name.toLowerCase();
      const advertiserId = await t.run(async (ctx) => ctx.db.insert("advertisers", { displayName: name, paymentTerms: "prepay" }));
      const campaignId = await t.run(async (ctx) => {
        const storageId = await ctx.storage.store(new Blob(["<svg/>"], { type: "image/svg+xml" }));
        return await ctx.db.insert("campaigns", {
          advertiserId,
          brief: `${name} launch`,
          budgetMinor: 100_000,
          currency: "USD",
          status: "active",
          creativeStatus: "pending_review",
          creativeStorageId: storageId,
          creativeContentType: "image/svg+xml",
          creativeSubmittedAt: Date.now(),
          targetAudience: { startups: 1 },
        });
      });
      await host.mutation(api.creatives.setReady, { campaignId, ready: true });
      const issued = await t.mutation(internal.agentKeys.issueForCompany, {
        company: name,
        name: `${name} agent`,
        budgetCapMinor: 10_000,
        scopes: ["hold", "pay", "bid"],
      });
      await t.run(async (ctx) => {
        await ctx.db.patch(issued.agentKeyId, { webhookUrl: `https://agent.test/${slug}`, standing: STANDING });
        await ctx.db.insert("companyResearch", {
          advertiserId,
          summary: name,
          category: "test",
          audienceTags: { startups: 1 },
          priceFactor: factor,
          reasoning: "test",
          sources: [],
          method: "rules",
          researchedAt: Date.now(),
        });
      });
      await signedInCustomer(t, advertiserId, `buyer@${slug}.test`);
      return { name, advertiserId, key: issued.key };
    }

    const alpha = await addCompany("AlphaSoft", 1.5);
    const beta = await addCompany("BetaSoft", 1.2);
    // Spare company that stays eligible after Alpha cools (never invited until then if we only had two — keep three, Gamma also accepts).
    const gamma = await addCompany("GammaSoft", 1.0);

    async function invitedNames(roundId: Id<"rounds">) {
      return await t.run(async (ctx) => {
        const bids = await ctx.db.query("roundBids").withIndex("by_round", (q) => q.eq("roundId", roundId)).take(20);
        const names: string[] = [];
        for (const b of bids) names.push((await ctx.db.get(b.advertiserId))!.displayName);
        return names;
      });
    }

    async function clearBidding() {
      await t.run(async (ctx) => {
        const last = await ctx.db
          .query("rounds")
          .withIndex("by_billboard_and_createdAt", (q) => q.eq("billboardId", led))
          .order("desc")
          .first();
        if (last?.status === "bidding") await closeRoundCore(ctx, last._id);
      });
    }

    for (let i = 0; i < REJECT_STREAK_THRESHOLD; i++) {
      await clearBidding();
      const roundId = (await t.run(async (ctx) => startRoundCore(ctx, led, "sell_now")))!;
      expect(await invitedNames(roundId)).toEqual(expect.arrayContaining(["AlphaSoft", "BetaSoft", "GammaSoft"]));
      // Only Alpha rejects; Beta and Gamma accept so their reject streaks reset.
      await t.mutation(internal.rounds.submitBid, { token: alpha.key, roundId, amountMinor: null, reasoning: "too expensive" });
      const offers = await t.run(async (ctx) => {
        const b = await ctx.db.query("roundBids").withIndex("by_round", (q) => q.eq("roundId", roundId)).take(10);
        return {
          beta: b.find((x) => x.advertiserId === beta.advertiserId)!.offerMinor ?? 100,
          gamma: b.find((x) => x.advertiserId === gamma.advertiserId)!.offerMinor ?? 100,
        };
      });
      await t.mutation(internal.rounds.submitBid, { token: beta.key, roundId, amountMinor: offers.beta, reasoning: "take it" });
      await t.mutation(internal.rounds.submitBid, { token: gamma.key, roundId, amountMinor: offers.gamma, reasoning: "take it" });
      await t.run(async (ctx) => closeRoundCore(ctx, roundId));
      // Drop pay-deadline / delivery jobs so they don't open extra rounds that burn reject streaks.
      await t.run(async (ctx) => {
        for (const s of await ctx.db.system.query("_scheduled_functions").take(50)) {
          if (s.state.kind === "pending") await ctx.scheduler.cancel(s._id);
        }
      });
      vi.advanceTimersByTime(WINDOW + 100);
    }

    const cooled = await t.run(async (ctx) =>
      ctx.db
        .query("inviteStats")
        .withIndex("by_billboard_and_advertiser", (q) => q.eq("billboardId", led).eq("advertiserId", alpha.advertiserId))
        .unique(),
    );
    expect(cooled?.rejectStreak).toBe(REJECT_STREAK_THRESHOLD);
    expect(cooled?.cooledUntilAt).toBeGreaterThan(Date.now());

    await clearBidding();
    const nextId = (await t.run(async (ctx) => startRoundCore(ctx, led, "sell_now")))!;
    const nextNames = await invitedNames(nextId);
    expect(nextNames).not.toContain("AlphaSoft");
    expect(nextNames).toEqual(expect.arrayContaining(["BetaSoft", "GammaSoft"]));
  });
});
