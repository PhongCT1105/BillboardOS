import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules, registerBackendComponents, signedInOperator } from "./test.setup";
import { ensureUpcomingSlots } from "./lib/inventory";
import { startRoundCore } from "./rounds";
import { creativeReady } from "./lib/sale";
import { SPONSORS } from "./fixtures/sponsors";

beforeEach(() => {
  vi.useFakeTimers();
  process.env.INTERNAL_API_SECRET = "test-internal-secret-0123456789";
  process.env.CONVEX_SITE_URL = "https://site.test";
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.INTERNAL_API_SECRET;
  delete process.env.CONVEX_SITE_URL;
});

describe("sponsors.seed", () => {
  test("network sponsors each get a YouTube or poster creative ready on any host and an agent that is on; running seed again changes nothing", async () => {
    const t = convexTest(schema, modules);
    registerBackendComponents(t);
    const first = await t.mutation(internal.sponsors.seed, {});
    expect(first.created).toHaveLength(SPONSORS.length);
    const rows = await t.run(async (ctx) => {
      const agents = await ctx.db.query("companyAgents").take(SPONSORS.length + 5);
      const campaigns = await ctx.db.query("campaigns").take(SPONSORS.length + 5);
      const ready = [];
      for (const c of campaigns) ready.push(await creativeReady(ctx, c, undefined));
      const keys = await ctx.db.query("agentKeys").take(SPONSORS.length + 5);
      return { agents, ready, keys };
    });
    expect(rows.agents).toHaveLength(SPONSORS.length);
    expect(rows.agents.every((a) => a.enabled)).toBe(true);
    expect(rows.ready.every(Boolean)).toBe(true);
    expect(rows.keys.every((k) => k.webhookUrl?.startsWith("https://site.test/company-agents/") && k.standing)).toBe(true);
    expect((await t.mutation(internal.sponsors.seed, {})).existing).toHaveLength(SPONSORS.length);
  });

  test("a host's sale invites the sponsors (their ads are approved for every host), and they show up in its top-up list", async () => {
    const t = convexTest(schema, modules);
    registerBackendComponents(t);
    vi.setSystemTime(Date.UTC(2026, 9, 25, 16, 7));
    await t.mutation(internal.sponsors.seed, {});
    const host = await signedInOperator(t, "host@venue.test");
    const workspaceId = await t.run(async (ctx) => (await ctx.db.query("workspaces").first())!._id);
    const screen = await t.run(async (ctx) => {
      const id = await ctx.db.insert("billboards", {
        workspaceId,
        name: "Lobby",
        city: "San Francisco",
        locationLabel: "Moscone West",
        utcOffsetMinutes: -420,
        reserveFloorMinor: 5,
        baseRateMinor: 5,
        deviceStatus: "online",
        audienceTags: { software: 0.5, startups: 0.3, students: 0.2 },
      });
      await ensureUpcomingSlots(ctx, id, Date.now());
      return id;
    });
    const roundId = (await t.run(async (ctx) => startRoundCore(ctx, screen, "sell_now")))!;
    const invited = await t.run(async (ctx) => ctx.db.query("roundBids").withIndex("by_round", (q) => q.eq("roundId", roundId)).take(20));
    const names = await t.run(async (ctx) => Promise.all(invited.map(async (b) => (await ctx.db.get(b.advertiserId))!.displayName)));
    expect(names).toEqual(expect.arrayContaining(["Anthropic", "Convex", "Apify"]));
    expect(names).not.toContain("Capital One"); // a travel-card ad: its buyers aren't this crowd
    expect((await host.query(api.companyAgents.hostList, {})).map((c) => c.company)).toEqual(expect.arrayContaining(["Anthropic", "Capital One"]));
  });
});
