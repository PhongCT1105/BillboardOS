import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { joinCompanies, modules, signedInCustomer, signedInOperator, type TestClient, quoteFor, holdFor } from "./test.setup";
import { embedUrl, hasCreative, parseOEmbed, parseWatchPage, parseYouTubeUrl, oembedUrl } from "./lib/youtube";
import { REVIEW_ACTOR } from "./lib/creativeReview";
import { creativeReady } from "./lib/sale";

const START = Date.UTC(2026, 9, 25, 16, 7);
const MIN = 60_000;
const ID = "dQw4w9WgXcQ";

let oembedCalls: string[] = [];
let oembedResponse: () => Response = () => new Response("{}", { status: 500 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  oembedCalls = [];
  oembedResponse = () =>
    Response.json({
      type: "video",
      provider_name: "YouTube",
      title: "LaunchKit in 30 seconds",
      author_name: "LaunchKit",
      author_url: "https://www.youtube.com/@launchkit",
      thumbnail_url: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://www.youtube.com/oembed")) {
        oembedCalls.push(url);
        return oembedResponse();
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

describe("parseYouTubeUrl", () => {
  test.each([
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}&t=10s&list=PL123`],
    [`http://m.youtube.com/watch?feature=share&v=${ID}`],
    [`youtube.com/watch?v=${ID}`],
    [`https://youtu.be/${ID}`],
    [`https://youtu.be/${ID}?si=abcDEF`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://www.youtube.com/embed/${ID}?autoplay=1`],
    [`https://www.youtube-nocookie.com/embed/${ID}`],
    [`https://www.youtube.com/live/${ID}`],
    [`  https://www.youtube.com/watch?v=${ID}  `],
  ])("accepts %s", (input) => {
    expect(parseYouTubeUrl(input)).toEqual({ ok: true, videoId: ID, url: `https://www.youtube.com/watch?v=${ID}` });
  });

  test.each([
    [""],
    ["not a url at all"],
    ["https://vimeo.com/123456"],
    [`https://youtube.com.evil.test/watch?v=${ID}`],
    [`https://evil.test/youtube.com/watch?v=${ID}`],
    [`javascript:alert('${ID}')`],
    [`ftp://www.youtube.com/watch?v=${ID}`],
    [`https://user:pw@www.youtube.com/watch?v=${ID}`],
    ["https://www.youtube.com/watch?v=short"],
    [`https://www.youtube.com/watch?v=${ID}x`],
    ["https://www.youtube.com/watch?v=dQw4w9WgXc!"],
    ["https://www.youtube.com/channel/UC1234567890"],
    ["https://youtu.be/"],
    [`https://youtu.be/${ID}/extra`],
    [`https://www.youtube-nocookie.com/shorts/${ID}`],
    [`https://www.youtube.com/${"a".repeat(2100)}`],
  ])("rejects %s", (input) => {
    const r = parseYouTubeUrl(input);
    expect(r.ok).toBe(false);
  });

  test("embed URL is the official privacy-enhanced player, muted, looped, no controls", () => {
    const u = new URL(embedUrl(ID));
    expect(u.origin).toBe("https://www.youtube-nocookie.com");
    expect(u.pathname).toBe(`/embed/${ID}`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      autoplay: "1",
      mute: "1",
      loop: "1",
      playlist: ID,
      controls: "0",
      playsinline: "1",
      enablejsapi: "1",
    });
    expect(() => embedUrl("bad")).toThrow();
    expect(oembedUrl(ID)).toBe(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ID}`)}&format=json`);
  });

  test("parseOEmbed validates the untrusted JSON", () => {
    const good = { type: "video", title: " Hi\u0007 ", author_name: "Chan", thumbnail_url: "https://i.ytimg.com/vi/x/hq.jpg" };
    expect(parseOEmbed(good)).toEqual({ title: "Hi", author: "Chan", authorUrl: null, thumbnailUrl: "https://i.ytimg.com/vi/x/hq.jpg" });
    expect(parseOEmbed({ ...good, thumbnail_url: "https://evil.test/x.jpg" })).toBeNull();
    expect(parseOEmbed({ ...good, type: "rich" })).toBeNull();
    expect(parseOEmbed({ ...good, title: 5 })).toBeNull();
    expect(parseOEmbed({ ...good, author_name: "" })).toBeNull();
    expect(parseOEmbed(null)).toBeNull();
    expect(parseOEmbed({ ...good, author_url: "https://evil.test/@x" })?.authorUrl).toBeNull();
  });

  test("parseWatchPage reads the full description and keywords, untrusted and bounded", () => {
    const html = `<html><head><meta name="description" content="Short &amp; cut off"><meta name="keywords" content="api, Developer Tools, , launch">
      <script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"${ID}","shortDescription":"Ship APIs in minutes.\\nBuilt for founders \\u0026 devs.","keywords":["api","devtools"]}};</script></head></html>`;
    expect(parseWatchPage(html)).toEqual({
      description: "Ship APIs in minutes. Built for founders & devs.",
      keywords: ["api", "devtools"],
    });
    // Falls back to the meta tags when the player JSON is missing.
    const meta = `<meta name="description" content="Short &amp; cut off"><meta name="keywords" content="api, Developer Tools, , launch">`;
    expect(parseWatchPage(meta)).toEqual({ description: "Short & cut off", keywords: ["api", "developer tools", "launch"] });
    expect(parseWatchPage("<html>consent wall</html>")).toEqual({ description: null, keywords: [] });
    const long = parseWatchPage(`"shortDescription":"${"a".repeat(5000)}"`);
    expect(long.description?.length).toBe(1500);
  });

  test("hasCreative: a file or a YouTube link", () => {
    expect(hasCreative({})).toBe(false);
    expect(hasCreative({ creativeContentType: "youtube" })).toBe(true);
    expect(hasCreative({ creativeStorageId: "x", creativeContentType: "image/png" })).toBe(true);
  });
});

/** A host workspace, and LaunchKit (one customer) with an active campaign. */
async function world() {
  const t = convexTest(schema, modules);
  const host = await signedInOperator(t, "host@venue.test");
  const workspaceId = await t.run(async (ctx) => (await ctx.db.query("workspaces").first())!._id);
  const advertiserId = await t.run(async (ctx) =>
    ctx.db.insert("advertisers", { displayName: "LaunchKit", paymentTerms: "prepay", website: "https://launchkit.dev" }),
  );
  const customer = await signedInCustomer(t, advertiserId, "buyer@launchkit.test");
  const campaignId = await customer.mutation(api.campaigns.create, {
    brief: "Launch week for our developer API platform",
    budgetMinor: 5000,
    targetAudience: { software: 0.6, startups: 0.4 },
  });
  return { t, host, workspaceId, advertiserId, customer, campaignId };
}

async function flush(t: TestClient) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("creatives.attachYouTube", () => {
  test("stores the link, fetches oEmbed, then the review agent approves it and the research agent reads the company", async () => {
    const { t, host, workspaceId, advertiserId, customer, campaignId } = await world();
    const r = await customer.mutation(api.creatives.attachYouTube, { campaignId, url: `https://youtu.be/${ID}?si=x` });
    expect(r).toEqual({ campaignId, creativeStatus: "pending_review", videoId: ID });

    const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
    expect(campaign).toMatchObject({ creativeContentType: "youtube", creativeStatus: "pending_review" });
    expect(campaign?.creativeStorageId).toBeUndefined();
    const before = await t.run(async (ctx) => ctx.db.query("youtubeCreatives").first());
    expect(before).toMatchObject({ videoId: ID, url: `https://www.youtube.com/watch?v=${ID}`, oembedStatus: "pending" });

    await flush(t);
    expect(oembedCalls).toEqual([oembedUrl(ID)]);
    const row = await t.run(async (ctx) => ctx.db.query("youtubeCreatives").first());
    expect(row).toMatchObject({ title: "LaunchKit in 30 seconds", author: "LaunchKit", oembedStatus: "ok" });

    // Review agent: safe, nothing blocked, auto-approve on by default.
    const approvals = await t.run(async (ctx) => ctx.db.query("creativeApprovals").collect());
    expect(approvals).toEqual([expect.objectContaining({ campaignId, workspaceId, approvedBy: REVIEW_ACTOR })]);
    const ready = await host.query(api.creatives.readyForWorkspace, {});
    expect(ready).toEqual([
      expect.objectContaining({
        campaignId,
        contentType: "youtube",
        youtubeVideoId: ID,
        creativeTitle: "LaunchKit in 30 seconds",
        creativeUrl: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`,
        ready: true,
        approvedBy: REVIEW_ACTOR,
      }),
    ]);
    expect(ready[0].agentNote).toMatch(/^Approved by creative review agent: /);

    // The research agent read the company (rules here: no Claude key in tests).
    const research = await t.run(async (ctx) => ctx.db.query("companyResearch").withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId)).unique());
    expect(research).toMatchObject({ method: "rules", priceFactor: 1 });
  });

  test("an approved YouTube ad is ready to sell: it has no storage file", async () => {
    const { t, workspaceId, customer, campaignId } = await world();
    await customer.mutation(api.creatives.attachYouTube, { campaignId, url: `https://youtu.be/${ID}` });
    await flush(t);
    const ready = await t.run(async (ctx) => creativeReady(ctx, (await ctx.db.get(campaignId))!, workspaceId));
    expect(ready).toBe(true);
  });

  test("invalid links, other companies and approved creatives are refused", async () => {
    const { t, customer, campaignId } = await world();
    expect(await errorCode(customer.mutation(api.creatives.attachYouTube, { campaignId, url: "https://vimeo.com/1" }))).toBe("INVALID_INPUT");

    const otherId = await t.run(async (ctx) => ctx.db.insert("advertisers", { displayName: "Rivet", paymentTerms: "prepay" }));
    const rival = await signedInCustomer(t, otherId, "buyer@rivet.test");
    expect(await errorCode(rival.mutation(api.creatives.attachYouTube, { campaignId, url: `https://youtu.be/${ID}` }))).toBe(
      "NOT_COMPANY_MEMBER",
    );

    await t.run(async (ctx) => ctx.db.patch(campaignId, { creativeStatus: "approved" }));
    expect(await errorCode(customer.mutation(api.creatives.attachYouTube, { campaignId, url: `https://youtu.be/${ID}` }))).toBe(
      "CREATIVE_LOCKED",
    );
  });

  test("oEmbed failure is recorded and the creative is still reviewed", async () => {
    const { t, customer, campaignId } = await world();
    oembedResponse = () => new Response("Not Found", { status: 404 });
    await customer.mutation(api.creatives.attachYouTube, { campaignId, url: `https://www.youtube.com/shorts/${ID}` });
    await flush(t);
    const row = await t.run(async (ctx) => ctx.db.query("youtubeCreatives").first());
    expect(row).toMatchObject({ oembedStatus: "failed", oembedError: "video not found or private" });
    expect(row?.title).toBeUndefined();
    const reviews = await t.run(async (ctx) => ctx.db.query("creativeReviews").collect());
    expect(reviews).toHaveLength(1);
  });

  test("a garbage oEmbed body is rejected", async () => {
    const { t, customer, campaignId } = await world();
    oembedResponse = () => Response.json({ title: "x", author_name: "y", thumbnail_url: "https://evil.test/a.jpg" });
    await customer.mutation(api.creatives.attachYouTube, { campaignId, url: `https://youtu.be/${ID}` });
    await flush(t);
    const row = await t.run(async (ctx) => ctx.db.query("youtubeCreatives").first());
    expect(row).toMatchObject({ oembedStatus: "failed", thumbnailUrl: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg` });
  });

  test("an uploaded file replaces the YouTube link (and its approvals)", async () => {
    const { t, customer, campaignId } = await world();
    await customer.mutation(api.creatives.attachYouTube, { campaignId, url: `https://youtu.be/${ID}` });
    await flush(t);
    expect(await t.run(async (ctx) => ctx.db.query("creativeApprovals").collect())).toHaveLength(1);

    const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["png"], { type: "image/png" })));
    await customer.mutation(api.creatives.attach, { campaignId, storageId, contentType: "image/png" });
    expect(await t.run(async (ctx) => ctx.db.query("youtubeCreatives").collect())).toEqual([]);
    expect(await t.run(async (ctx) => ctx.db.query("creativeApprovals").collect())).toEqual([]);
    const campaign = await t.run(async (ctx) => ctx.db.get(campaignId));
    expect(campaign).toMatchObject({ creativeStorageId: storageId, creativeContentType: "image/png" });

    // And back: the link replaces the file, which is deleted.
    await customer.mutation(api.creatives.attachYouTube, { campaignId, url: `https://youtu.be/${ID}` });
    expect(await t.run(async (ctx) => ctx.db.system.get(storageId))).toBeNull();
  });
});

describe("player with a YouTube creative", () => {
  /** Seeded screen + Golden Gate Coffee booked on its first slot with a verified x402 payment, creative = YouTube. */
  async function playing() {
    const t = await signedInOperator(convexTest(schema, modules));
    const seed = await t.mutation(internal.seed.demo, {});
    await joinCompanies(t);
    const slots = await t.query(api.slots.listForBillboard, { billboardId: seed.billboardId, from: START, to: START + 24 * 60 * MIN });
    const slot = slots[0];
    const q = await quoteFor(t, { campaignId: seed.campaignId, slotIds: [slot._id] });
    const hold = await holdFor(t, q, "yt1", "buyer");
    const tx = `0x${"ab".repeat(32)}`;
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
    await t.mutation(api.creatives.attachYouTube, { campaignId: seed.campaignId, url: `https://www.youtube.com/watch?v=${ID}` });
    await t.mutation(api.creatives.review, { campaignId: seed.campaignId, decision: "approved", reason: "ok" });
    return { t, seed, slot, bookingId: result.bookingId, tx };
  }

  test("nowPlaying and readyCreatives carry the video id; playback receipts work", async () => {
    const { t, seed, slot, bookingId } = await playing();
    const view = await t.query(api.player.nowPlaying, { billboardId: seed.billboardId, atMinute: slot.startAt + 2 * MIN });
    expect(view.current).toMatchObject({
      state: "scheduled",
      contentType: "youtube",
      youtubeVideoId: ID,
      creativeUrl: `https://www.youtube.com/watch?v=${ID}`,
    });

    await t.run(async (ctx) =>
      ctx.db.insert("creativeApprovals", { campaignId: seed.campaignId, workspaceId: slot.workspaceId!, approvedBy: "operator:x", approvedAt: START }),
    );
    const ready = await t.query(api.player.readyCreatives, { billboardId: seed.billboardId });
    expect(ready).toEqual([
      { campaignId: seed.campaignId, url: `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`, contentType: "youtube", youtubeVideoId: ID },
    ]);

    vi.setSystemTime(slot.startAt + MIN);
    const receipt = await t.mutation(api.player.recordPlayback, { slotId: slot._id, bookingId, status: "played" });
    expect(receipt).toMatchObject({ slotState: "played", replayed: false });
    const event = await t.run(async (ctx) => ctx.db.get(receipt.playbackEventId));
    expect(event).toMatchObject({ contentType: "youtube", status: "played" });
    expect(event?.storageId).toBeUndefined();
  });

  test("screenState names the winner's YouTube creative; paid only with a real tx hash", async () => {
    const { t, seed, slot, tx } = await playing();
    const workspaceId = slot.workspaceId!;
    const issued = await t.mutation(internal.agentKeys.issueForCompany, {
      company: "Golden Gate Coffee Co.",
      name: "agent",
      budgetCapMinor: 10_000,
      scopes: ["hold", "pay", "bid"],
    });
    await t.run(async (ctx) => {
      const roundId = await ctx.db.insert("rounds", {
        workspaceId,
        billboardId: seed.billboardId,
        slotId: slot._id,
        spotStartAt: slot.startAt,
        spotEndAt: slot.endAt,
        trigger: "sell_now",
        status: "paid",
        floorMinor: 25,
        askingMinor: 70,
        signals: [],
        crowd: null,
        eventName: null,
        invitedCount: 1,
        closesAt: START,
        priceMinor: 90,
        paymentTx: tx,
        paymentNetwork: "eip155:84532",
        createdAt: START,
      });
      const bidId = await ctx.db.insert("roundBids", {
        roundId,
        advertiserId: seed.advertiserIds[0],
        campaignId: seed.campaignId,
        agentKeyId: issued.agentKeyId,
        match: null,
        amountMinor: 90,
        status: "won",
      });
      await ctx.db.patch(roundId, { winnerBidId: bidId });
    });
    const screen = await t.query(api.player.screenState, { billboardId: seed.billboardId });
    expect(screen.mode).toBe("playing");
    expect(screen.nowPlaying).toMatchObject({
      wonAtMinor: 90,
      txShort: "0xabab…abab",
      creative: { provider: "youtube", youtubeVideoId: ID, title: null },
    });
  });
});

describe("research hook", () => {
  test("attaching a file creative also has the research agent read the company", async () => {
    const { t, customer, advertiserId, campaignId } = await world();
    const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["png"], { type: "image/png" })));
    await customer.mutation(api.creatives.attach, { campaignId, storageId, contentType: "image/png" });
    await flush(t);
    const research = await t.run(async (ctx) => ctx.db.query("companyResearch").withIndex("by_advertiser", (q) => q.eq("advertiserId", advertiserId as Id<"advertisers">)).unique());
    expect(research).toMatchObject({ method: "rules", audienceTags: { software: 0.6, startups: 0.4 } });
  });
});
