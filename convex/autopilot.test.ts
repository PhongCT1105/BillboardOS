import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules, signedInOperator, type TestClient } from "./test.setup";
import { ensureUpcomingSlots } from "./lib/inventory";
import { confidenceFor, forecastSlot, type ForecastInput } from "./lib/forecast";
import {
  AUCTION_LEAD_MS,
  FIRST_LOOK_MS,
  LIVE_HANDOFF_MS,
  bandOf,
  decideInterest,
  firstLookApplies,
  forwardPrice,
  shouldRenotify,
  slotLabel,
} from "./lib/autopilot";

// Sunday 2026-10-25, 09:07 PDT.
const START = Date.UTC(2026, 9, 25, 16, 7);
const SITE = "https://site.test";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const STANDING = { maxPricePerSpotMinor: 150, minRelevantViewers: 3, dailyBudgetMinor: 500 };

let current: TestClient | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
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
  delete process.env.CONVEX_SITE_URL;
  current = null;
});

// ---------------------------------------------------------------- pure rules

const baseInput = (over: Partial<ForecastInput> = {}): ForecastInput => ({
  slotStartAt: START + 3 * HOUR,
  slotEndAt: START + 3 * HOUR + 15 * MINUTE,
  now: START,
  utcOffsetMinutes: -420,
  normalTrafficPer15: 40,
  camera: [],
  events: [],
  screenTags: { startups: 0.5, software: 0.5 },
  ...over,
});

describe("forecast", () => {
  test("monotonic in events: an overlapping event never lowers the forecast, a stronger one raises it", () => {
    const none = forecastSlot(baseInput());
    const event = { name: "Startup Demo Day", startsAt: START + 2 * HOUR, endsAt: START + 5 * HOUR, upliftMultiplier: 1.3, confidence: 1 };
    const one = forecastSlot(baseInput({ events: [event] }));
    const stronger = forecastSlot(baseInput({ events: [event, { ...event, name: "Keynote", upliftMultiplier: 1.5 }] }));
    const elsewhere = forecastSlot(baseInput({ events: [{ ...event, startsAt: START + 6 * HOUR, endsAt: START + 7 * HOUR }] }));
    expect(one.expectedPeople).toBeGreaterThan(none.expectedPeople);
    expect(stronger.expectedPeople).toBeGreaterThan(one.expectedPeople);
    expect(elsewhere.expectedPeople).toBe(none.expectedPeople);
    expect(one.eventName).toBe("Startup Demo Day");
    expect(one.reasoning).toContain("Startup Demo Day ×1.30");
  });

  test("monotonic in crowd: a bigger recent camera count raises the near forecast, and fades further out", () => {
    const history = Array.from({ length: 8 }, (_, i) => ({ bucketStart: START - (i + 2) * HOUR, peakInView: 10 }));
    const near = (people: number) =>
      forecastSlot(
        baseInput({
          slotStartAt: START + 30 * MINUTE,
          slotEndAt: START + 45 * MINUTE,
          camera: [...history, { bucketStart: START - 10 * MINUTE, peakInView: people }],
        }),
      );
    const counts = [0, 5, 10, 20, 40].map((p) => near(p).expectedPeople);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    expect(counts[4]).toBeGreaterThan(counts[2]);
    // 8 h out the trend no longer matters.
    const far = (people: number) =>
      forecastSlot(baseInput({ slotStartAt: START + 8 * HOUR, slotEndAt: START + 8 * HOUR + 15 * MINUTE, camera: [...history, { bucketStart: START - 10 * MINUTE, peakInView: people }] }));
    expect(far(40).trendFactor).toBe(1);
  });

  test("confidence falls the further ahead it looks", () => {
    expect(confidenceFor(0)).toBe(0.9);
    expect(confidenceFor(2 * HOUR)).toBeLessThan(confidenceFor(30 * MINUTE));
    expect(confidenceFor(12 * HOUR)).toBeLessThan(confidenceFor(2 * HOUR));
    expect(confidenceFor(48 * HOUR)).toBe(0.3);
  });

  test("without a day of camera history the host's normal traffic sets the level", () => {
    const f = forecastSlot(baseInput());
    expect(f.normalSource).toBe("host");
    expect(f.normalInView).toBe(4); // 40 per 15 min x 0.1
  });
});

describe("autopilot rules", () => {
  test("horizon bands", () => {
    expect(bandOf(0)).toBe("live");
    expect(bandOf(14 * MINUTE)).toBe("live");
    expect(bandOf(15 * MINUTE)).toBe("ahead");
    expect(bandOf(119 * MINUTE)).toBe("ahead");
    expect(bandOf(2 * HOUR)).toBe("early");
    expect(bandOf(12 * HOUR)).toBe("early");
    expect(bandOf(12 * HOUR + 1)).toBe("beyond");
  });

  test("decay toward the floor never goes under it, and falls as the slot nears", () => {
    for (const floor of [1, 25, 100, 400]) {
      for (const value of [0, 10, 100, 1_000, 10_000]) {
        let last = Infinity;
        for (let ms = 2 * HOUR; ms >= LIVE_HANDOFF_MS; ms -= 5 * MINUTE) {
          const p = forwardPrice({ band: "ahead", valueMinor: value, floorMinor: floor, msUntilStart: ms, interested: 1 }).priceMinor;
          expect(p).toBeGreaterThanOrEqual(floor);
          expect(p).toBeLessThanOrEqual(last);
          last = p;
        }
        const early = forwardPrice({ band: "early", valueMinor: value, floorMinor: floor, msUntilStart: 5 * HOUR, interested: 0 }).priceMinor;
        expect(early).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  test("early booking sits under the forecast price and rises with demand", () => {
    const ahead = forwardPrice({ band: "ahead", valueMinor: 200, floorMinor: 25, msUntilStart: 2 * HOUR, interested: 1 }).priceMinor;
    const early1 = forwardPrice({ band: "early", valueMinor: 200, floorMinor: 25, msUntilStart: 5 * HOUR, interested: 1 }).priceMinor;
    const early3 = forwardPrice({ band: "early", valueMinor: 200, floorMinor: 25, msUntilStart: 5 * HOUR, interested: 3 }).priceMinor;
    expect(ahead).toBe(150);
    expect(early1).toBe(135);
    expect(early3).toBeGreaterThan(early1);
  });

  test("first look, contention and re-notify thresholds", () => {
    expect(firstLookApplies({ targets: 2, msUntilStart: AUCTION_LEAD_MS + FIRST_LOOK_MS })).toBe(true);
    expect(firstLookApplies({ targets: 1, msUntilStart: 5 * HOUR })).toBe(false);
    expect(firstLookApplies({ targets: 3, msUntilStart: AUCTION_LEAD_MS })).toBe(false);
    expect(decideInterest(0)).toBe("keep_open");
    expect(decideInterest(1)).toBe("hold");
    expect(decideInterest(2)).toBe("auction");
    expect(shouldRenotify(undefined, 100)).toBe(true);
    expect(shouldRenotify(100, 95)).toBe(false);
    expect(shouldRenotify(100, 90)).toBe(true);
    expect(slotLabel(Date.UTC(2026, 9, 26, 0, 0), Date.UTC(2026, 9, 26, 0, 15), -420)).toBe("5:00–5:15 PM");
  });
});

// ---------------------------------------------------------------- the plan, on a database

async function world() {
  const t = convexTest(schema, modules);
  current = t;
  const host = await signedInOperator(t, "host@venue.test");
  const workspaceId = await t.run(async (ctx) => (await ctx.db.query("workspaces").withIndex("by_name", (q) => q.eq("name", "Moscone Media")).first())!._id);

  async function addScreen(wsId: Id<"workspaces">, name: string): Promise<Id<"billboards">> {
    return await t.run(async (ctx) => {
      const id = await ctx.db.insert("billboards", {
        workspaceId: wsId,
        name,
        city: "San Francisco",
        locationLabel: `${name} at the venue`,
        utcOffsetMinutes: -420,
        reserveFloorMinor: 25,
        baseRateMinor: 30,
        deviceStatus: "online",
        audienceBaselinePerBucket: 100,
        audienceTags: { startups: 0.5, software: 0.3, tourists: 0.2 },
      });
      await ensureUpcomingSlots(ctx, id, Date.now());
      return id;
    });
  }

  async function addCompany(name: string, approveAt: TestClient = host) {
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
        targetAudience: { startups: 1 },
      });
    });
    await approveAt.mutation(api.creatives.setReady, { campaignId, ready: true });
    const issued = await t.mutation(internal.agentKeys.issueForCompany, {
      company: name,
      name: `${name} agent`,
      budgetCapMinor: 10_000,
      scopes: ["hold", "pay", "bid"],
    });
    await t.run(async (ctx) => ctx.db.patch(issued.agentKeyId, { webhookUrl: `https://agent.test/${slug}`, standing: STANDING }));
    return { name, advertiserId, campaignId, agentKeyId: issued.agentKeyId, key: issued.key };
  }

  const screen = await addScreen(workspaceId, "LED");
  const nvidia = await addCompany("Nvidia");
  const launchKit = await addCompany("LaunchKit");

  const plan = (wsId: Id<"workspaces"> = workspaceId) => t.mutation(internal.autopilot.plan, { workspaceId: wsId, reason: "test" });
  const offers = (billboardId: Id<"billboards"> = screen) =>
    t.run(async (ctx) =>
      ctx.db
        .query("forwardOffers")
        .withIndex("by_billboard_and_slotStartAt", (q) => q.eq("billboardId", billboardId))
        .take(500),
    );
  const logLines = () =>
    t.run(async (ctx) =>
      ctx.db
        .query("autopilotLog")
        .withIndex("by_workspace_and_at", (q) => q.eq("workspaceId", workspaceId))
        .take(500),
    );
  const slotsOf = (billboardId: Id<"billboards"> = screen) =>
    t.run(async (ctx) =>
      ctx.db
        .query("slots")
        .withIndex("by_billboard_and_startAt", (q) => q.eq("billboardId", billboardId))
        .take(100),
    );
  return { t, host, workspaceId, screen, nvidia, launchKit, plan, offers, logLines, slotsOf, addScreen, addCompany };
}

const openOf = (offers: Doc<"forwardOffers">[]) => offers.filter((o) => o.status === "open");

describe("plan", () => {
  test("offers the next 12 hours by band, leaves the current spot to the live auction, and tells fitting companies", async () => {
    const w = await world();
    const result = await w.plan();
    expect(result.skipped).toBeNull();
    const open = openOf(await w.offers());
    const now = Date.now();
    expect(open.length).toBeGreaterThan(40);
    // Nothing under 15 minutes out (that's the live auction's), nothing past 12 h.
    for (const o of open) {
      expect(o.slotStartAt - now).toBeGreaterThanOrEqual(LIVE_HANDOFF_MS);
      expect(o.slotStartAt - now).toBeLessThanOrEqual(12 * HOUR);
      expect(o.band).toBe(bandOf(o.slotStartAt - now));
      expect(o.priceMinor).toBeGreaterThanOrEqual(o.floorMinor);
    }
    const ahead = open.filter((o) => o.band === "ahead");
    expect(ahead.length).toBeGreaterThan(0);
    expect(ahead[0].targets.map((x) => x.company).sort()).toEqual(["LaunchKit", "Nvidia"]);
    // The nearest offers went out now (with a first look: two companies fit), the rest on later runs.
    expect(ahead[0].notifiedPriceMinor).toBe(ahead[0].priceMinor);
    expect(ahead[0].firstLookUntil! - now).toBeGreaterThanOrEqual(FIRST_LOOK_MS);
    expect(ahead[0].firstLookUntil! - now).toBeLessThan(FIRST_LOOK_MS + 1_000);
    const payload = await w.t.query(internal.autopilotDelivery.loadForDelivery, { offerId: ahead[0]._id, advertiserId: w.nvidia.advertiserId, event: "forward_offer" });
    expect(payload.ok).toBe(true);
    if (payload.ok) {
      const body = payload.payload as { type: string; priceMinor: number; forecast: { expectedPeople: number }; links: { accept: string } };
      expect(body.type).toBe("forward_offer");
      expect(body.priceMinor).toBe(ahead[0].priceMinor);
      expect(body.forecast.expectedPeople).toBeGreaterThan(0);
      expect(body.links.accept).toBe(`/api/autopilot/offers/${ahead[0]._id}/accept`);
    }
    const lines = await w.logLines();
    expect(lines.some((l) => l.kind === "offer" && /offered to (Nvidia and LaunchKit|LaunchKit and Nvidia) at \$/.test(l.text))).toBe(true);
    // A second run is idempotent: no duplicate offers.
    await w.plan();
    expect(openOf(await w.offers()).length).toBe(open.length);
  });

  test("an unsold slot's price decays toward the floor as it nears, then is handed to the live auction", async () => {
    const w = await world();
    await w.plan();
    const now = Date.now();
    const target = openOf(await w.offers()).find((o) => o.band === "ahead" && o.slotStartAt - now > HOUR)!;
    const first = target.priceMinor;
    vi.setSystemTime(target.slotStartAt - 20 * MINUTE);
    await w.plan();
    const later = (await w.t.run(async (ctx) => ctx.db.get(target._id)))!;
    expect(later.status).toBe("open");
    expect(later.priceMinor).toBeLessThan(first);
    expect(later.priceMinor).toBeGreaterThanOrEqual(later.floorMinor);
    vi.setSystemTime(target.slotStartAt - 10 * MINUTE);
    await w.plan();
    const handed = (await w.t.run(async (ctx) => ctx.db.get(target._id)))!;
    expect(handed.status).toBe("expired");
    expect(handed.closedReason).toBe("handed to the live auction");
    expect((await w.logLines()).some((l) => l.kind === "handoff" && l.offerId === target._id)).toBe(true);
  });

  test("one yes after the first look: accept takes a hold at the offer price with the x402 purchase URL", async () => {
    const w = await world();
    await w.plan();
    const offer = openOf(await w.offers()).find((o) => o.band === "ahead")!;
    // During the first look a yes is registered, not held.
    const pending = await w.t.mutation(internal.autopilot.acceptForwardOffer, { offerId: offer._id, advertiserId: w.nvidia.advertiserId, campaignId: w.nvidia.campaignId });
    expect(pending.status).toBe("pending");
    vi.setSystemTime(offer.firstLookUntil! + 1);
    await w.t.mutation(internal.autopilot.decideOffer, { offerId: offer._id });
    const after = (await w.t.run(async (ctx) => ctx.db.get(offer._id)))!;
    expect(after.status).toBe("accepted");
    expect(after.acceptedBy?.advertiserId).toBe(w.nvidia.advertiserId);
    const hold = (await w.t.run(async (ctx) => ctx.db.get(after.acceptedBy!.holdId)))!;
    expect(hold.amountMinor).toBe(offer.priceMinor);
    expect(hold.agentKeyId).toBe(w.nvidia.agentKeyId);
    const slot = (await w.t.run(async (ctx) => ctx.db.get(offer.slotIds[0])))!;
    expect(slot.state).toBe("held");
    const won = await w.t.query(internal.autopilotDelivery.loadForDelivery, { offerId: offer._id, advertiserId: w.nvidia.advertiserId, event: "forward_won" });
    expect(won.ok && (won.payload as { purchaseUrl: string }).purchaseUrl).toBe(`${SITE}/a2a/hosts/${w.workspaceId}/purchases/${hold._id}`);

    // Outside a first look, accept holds at once (here: an early-band offer after its first look ended with no yes).
    const early = openOf(await w.offers()).find((o) => o.band === "early")!;
    await w.t.mutation(internal.autopilot.decideOffer, { offerId: early._id });
    const held = await w.t.mutation(internal.autopilot.acceptForwardOffer, { offerId: early._id, advertiserId: w.launchKit.advertiserId, campaignId: w.launchKit.campaignId });
    expect(held.status).toBe("held");
    if (held.status === "held") {
      expect(held.amountMinor).toBe(early.priceMinor);
      expect(held.purchaseUrl).toBe(`${SITE}/a2a/hosts/${w.workspaceId}/purchases/${held.holdId}`);
    }
    // The slot is gone: a second taker is refused, and the plan doesn't re-offer it.
    await expect(
      w.t.mutation(internal.autopilot.acceptForwardOffer, { offerId: early._id, advertiserId: w.nvidia.advertiserId, campaignId: w.nvidia.campaignId }),
    ).rejects.toThrow(/OFFER_CLOSED|accepted/);
    await w.plan();
    expect(openOf(await w.offers()).some((o) => o.slotIds[0] === early.slotIds[0])).toBe(false);
  });

  test("contention: two companies want the same slot, so a scheduled ascending auction opens (no button)", async () => {
    const w = await world();
    await w.plan();
    const offer = openOf(await w.offers()).find((o) => o.band === "ahead" && o.slotStartAt - Date.now() > 30 * MINUTE)!;
    for (const c of [w.nvidia, w.launchKit]) {
      const r = await w.t.mutation(internal.autopilot.acceptForwardOffer, { offerId: offer._id, advertiserId: c.advertiserId, campaignId: c.campaignId });
      expect(r.status).toBe("pending");
    }
    vi.setSystemTime(offer.firstLookUntil! + 1);
    await w.t.mutation(internal.autopilot.decideOffer, { offerId: offer._id });
    const closed = (await w.t.run(async (ctx) => ctx.db.get(offer._id)))!;
    expect(closed.status).toBe("withdrawn");
    // The scheduled openIfHot sees two buyers within 10 minutes and opens the auction.
    const opened = await w.t.mutation(internal.auctions.openIfHot, { slotId: offer.slotIds[0] });
    expect(opened.opened).toBe(true);
    expect(opened.reasons.join(" ")).toMatch(/2 buyers are competing/);
    await w.t.mutation(internal.autopilot.afterAuction, { offerId: offer._id });
    expect((await w.t.run(async (ctx) => ctx.db.get(offer._id)))!.auctionId).toBe(opened.auctionId);
    expect((await w.logLines()).filter((l) => l.kind === "auction").length).toBe(2);
    // The slot is in auction now: the plan leaves it alone.
    await w.plan();
    expect(openOf(await w.offers()).some((o) => o.slotIds[0] === offer.slotIds[0])).toBe(false);
  });

  test("a company outside its limits is not offered the slot and can't take it", async () => {
    const w = await world();
    await w.t.run(async (ctx) => ctx.db.patch(w.launchKit.agentKeyId, { standing: { ...STANDING, maxPricePerSpotMinor: 26 } }));
    await w.plan();
    const offer = openOf(await w.offers()).find((o) => o.band === "early" && o.priceMinor > 26)!;
    expect(offer.targets.map((x) => x.company)).toEqual(["Nvidia"]);
    expect(offer.firstLookUntil).toBeUndefined();
    await expect(
      w.t.mutation(internal.autopilot.acceptForwardOffer, { offerId: offer._id, advertiserId: w.launchKit.advertiserId, campaignId: w.launchKit.campaignId }),
    ).rejects.toThrow(/STANDING_INSTRUCTIONS|max/);
  });

  test("expired offers can't be taken", async () => {
    const w = await world();
    await w.plan();
    const offer = openOf(await w.offers()).find((o) => o.band === "early")!;
    vi.setSystemTime(offer.expiresAt + 1);
    await expect(
      w.t.mutation(internal.autopilot.acceptForwardOffer, { offerId: offer._id, advertiserId: w.nvidia.advertiserId, campaignId: w.nvidia.campaignId }),
    ).rejects.toThrow(/OFFER_CLOSED|expired/);
    // The next plan closes it and offers the slot again in its new band.
    await w.plan();
    const again = (await w.offers()).filter((o) => o.slotIds[0] === offer.slotIds[0]);
    expect(again.find((o) => o._id === offer._id)!.status).toBe("expired");
    expect(again.some((o) => o.status === "open" && o.band === "ahead")).toBe(true);
  });

  test("isolation: another host's plan never offers to companies approved elsewhere, and their offers can't be taken", async () => {
    const w = await world();
    const other = await signedInOperator(w.t, "owner@other.test", "Other Venue");
    const otherWs = await w.t.run(async (ctx) => (await ctx.db.query("workspaces").withIndex("by_name", (q) => q.eq("name", "Other Venue")).first())!._id);
    const otherScreen = await w.addScreen(otherWs, "Lobby");
    await w.plan(otherWs);
    const theirs = openOf(await w.offers(otherScreen));
    expect(theirs.length).toBeGreaterThan(0);
    for (const o of theirs) expect(o.targets).toEqual([]);
    expect(openOf(await w.offers()).length).toBe(0); // the first host's screen wasn't touched
    await expect(
      w.t.mutation(internal.autopilot.acceptForwardOffer, { offerId: theirs[0]._id, advertiserId: w.nvidia.advertiserId, campaignId: w.nvidia.campaignId }),
    ).rejects.toThrow(/CREATIVE_NOT_READY|approved/);
    // Each host sees only its own autopilot.
    const mine = await other.query(api.autopilot.status, { atMinute: Date.now() });
    expect(mine.log.every((l) => l.billboardId === null || l.billboardId === otherScreen)).toBe(true);
  });

  test("pause stops everything: open offers withdrawn, no planning, no taking; only the owner can pause", async () => {
    const w = await world();
    await w.plan();
    const offer = openOf(await w.offers())[0];
    const operator = await signedInOperator(w.t, "ops2@venue.test");
    await expect(operator.mutation(api.autopilot.setEnabled, { enabled: false })).rejects.toThrow(/OWNER_ONLY|owner/);
    await w.host.mutation(api.autopilot.setEnabled, { enabled: false });
    expect(openOf(await w.offers())).toEqual([]);
    expect((await w.plan()).skipped).toBe("paused");
    expect(openOf(await w.offers())).toEqual([]);
    await expect(
      w.t.mutation(internal.autopilot.acceptForwardOffer, { offerId: offer._id, advertiserId: w.nvidia.advertiserId, campaignId: w.nvidia.campaignId }),
    ).rejects.toThrow(/OFFER_CLOSED|withdrawn/);
    expect(await w.t.mutation(internal.autopilot.planAll, {})).toBe(0);
    const status = await w.host.query(api.autopilot.status, { atMinute: Date.now() });
    expect(status.enabled).toBe(false);
    expect(status.doing).toMatch(/^Paused/);
    // Back on: it plans again.
    await w.host.mutation(api.autopilot.setEnabled, { enabled: true });
    expect((await w.plan()).skipped).toBeNull();
    expect(openOf(await w.offers()).length).toBeGreaterThan(0);
  });

  test("owner's sell-now offers a slot at once, at or above the floor, first come first served", async () => {
    const w = await world();
    const slot = (await w.slotsOf()).find((s) => s.startAt - Date.now() > 3 * HOUR)!;
    const operator = await signedInOperator(w.t, "ops3@venue.test");
    await expect(operator.mutation(api.autopilot.sellNow, { slotId: slot._id })).rejects.toThrow(/OWNER_ONLY|owner/);
    const r = await w.host.mutation(api.autopilot.sellNow, { slotId: slot._id });
    expect(r.companies).toBe(2);
    const offer = (await w.t.run(async (ctx) => ctx.db.get(r.offerId)))!;
    expect(offer.override).toBe(true);
    expect(offer.priceMinor).toBeGreaterThanOrEqual(offer.floorMinor);
    expect(offer.firstLookUntil).toBeUndefined();
    const held = await w.t.mutation(internal.autopilot.acceptForwardOffer, { offerId: r.offerId, advertiserId: w.launchKit.advertiserId, campaignId: w.launchKit.campaignId });
    expect(held.status).toBe("held");
  });

  test("external agents accept over HTTP with their key", async () => {
    const w = await world();
    await w.plan();
    const offer = openOf(await w.offers()).find((o) => o.band === "early")!;
    vi.setSystemTime(Date.now() + FIRST_LOOK_MS + 1);
    await w.t.mutation(internal.autopilot.decideOffer, { offerId: offer._id });
    const res = await w.t.fetch(`/api/autopilot/offers/${offer._id}/accept`, { method: "POST", headers: { Authorization: `Bearer ${w.nvidia.key}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; amountMinor: number; purchaseUrl: string };
    expect(body.status).toBe("held");
    expect(body.amountMinor).toBe(offer.priceMinor);
    const bad = await w.t.fetch(`/api/autopilot/offers/${offer._id}/accept`, { method: "POST" });
    expect(bad.status).toBe(401);
  });

  test("the host's slot outlook shows past, now and future with forecast and booker", async () => {
    const w = await world();
    await w.plan();
    const now = Date.now();
    const from = Math.floor(now / (15 * MINUTE)) * 15 * MINUTE - HOUR;
    const view = await w.host.query(api.autopilot.outlook, { billboardId: w.screen, from, to: from + 13 * HOUR, atMinute: now });
    expect(view.isHost).toBe(true);
    const future = view.slots.filter((s) => s.startAt > now + LIVE_HANDOFF_MS);
    expect(future.length).toBeGreaterThan(0);
    for (const s of future) {
      expect(s.priceMinor).not.toBeNull();
      expect(s.expectedPeople).not.toBeNull();
    }
    const anon = await w.t.query(api.autopilot.outlook, { billboardId: w.screen, from, to: from + 13 * HOUR, atMinute: now });
    expect(anon.isHost).toBe(false);
    expect(anon.slots.every((s) => s.reasoning === null && s.bookedBy === null)).toBe(true);
  });
});

