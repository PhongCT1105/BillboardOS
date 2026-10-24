/**
 * Two competing buyer agents in a live BillboardOS auction (ADR 0003).
 *
 *   npm run auction:demo -- [--slot <slotId>] [--no-pay] [--server <url>]
 *
 * Golden Gate Coffee (local walk-in brand) and Nvidia (global brand, GTC week)
 * both want the same Moscone slot. Each agent:
 *   1. ranks screens with billboards.recommend (audience match x expected audience),
 *   2. quotes the slot; two buyers on one slot make it "hot", so the seller
 *      agent closes posted sales and opens an ascending auction,
 *   3. values the slot as  relevant viewers x value per relevant viewer,
 *      sets a private auto-bid maximum = min(valuation, max bid per slot, budget),
 *   4. Nvidia starts cautious and raises its maximum once after being outbid.
 * The winner gets a hold at the clearing price and pays over x402 when a CDP
 * wallet and the x402 server are configured; otherwise the script stops at
 * the hold and says so.
 *
 * Agents use only PUBLIC Convex functions (they are not operators). The
 * reasoning text is deterministic; `narrate()` is the hook where a Claude
 * call can write it (numbers always stay computed by code).
 */
import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { CdpX402Client } from "@coinbase/cdp-sdk/x402";
import { wrapFetchWithPayment } from "@x402/fetch";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { agentApi, AgentApiError, centsToAtomic, centsToUsd, env, presence, requireEnv } from "./lib.ts";

// ---------------------------------------------------------------- config

const argv = process.argv.slice(2);
const argValue = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const NO_PAY = argv.includes("--no-pay");
const SERVER = (argValue("server") ?? `http://localhost:${env("X402_SERVER_PORT") ?? 4021}`).replace(/\/$/, "");
const NETWORK = env("X402_NETWORK") ?? "eip155:84532";
const POLL_MS = 1500;
/** Auction (2 min) + soft-close cap (3 min) + payment window (5 min) + margin must fit before air time. */
const MIN_LEAD_MS = 20 * 60_000;

type AgentSpec = {
  name: string;
  advertiser: string;
  /**
   * How much a relevant viewer is worth to this brand, as a multiple of the
   * going rate per viewer implied by the screen's posted price.
   */
  brandValueIndex: number;
  brandStory: string;
  maxBidPerSlotMinor: number;
  /** Start below the full valuation and raise once if outbid. */
  openingShareOfValuation: number;
  wallet: string;
  /** Env var holding this agent's key (issued by its company; `npx convex run seed:demoAgentKeys`). */
  keyEnv: string;
};

const AGENTS: AgentSpec[] = [
  {
    name: "Coffee agent",
    advertiser: "Golden Gate Coffee Co.",
    brandValueIndex: 1.8,
    brandStory: "a local cafe two blocks away converts walk-by viewers into same-day visits",
    maxBidPerSlotMinor: 15_000,
    openingShareOfValuation: 1,
    wallet: env("AUCTION_COFFEE_WALLET") ?? "auction-coffee-agent",
    keyEnv: "AUCTION_COFFEE_AGENT_KEY",
  },
  {
    name: "Nvidia agent",
    advertiser: "Nvidia",
    brandValueIndex: 3.2,
    brandStory: "a global brand buying developer awareness during GTC week, where one memorable impression is worth a lot",
    maxBidPerSlotMinor: 40_000,
    openingShareOfValuation: 0.7,
    wallet: env("AUCTION_NVIDIA_WALLET") ?? env("BUYER_WALLET_NAME") ?? "advertiser-agent-1",
    keyEnv: "AUCTION_NVIDIA_AGENT_KEY",
  },
];

const say = (who: string, msg: string) => console.log(`  ${who.padEnd(13)} ${msg}`);
const section = (title: string) => console.log(`\n== ${title}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (msg: string): never => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof AgentApiError ? error.code : undefined;
}

/**
 * Hook for Claude-written reasoning. Today: deterministic text so the demo
 * runs without ANTHROPIC_API_KEY. The numbers passed in are already final.
 */
function narrate(lines: string[]): string[] {
  return lines;
}

// ---------------------------------------------------------------- setup

const convex = new ConvexHttpClient(requireEnv("CONVEX_URL", "public Convex API URL"));
console.log("BillboardOS auction demo: two buyer agents, one hot slot (TEST FUNDS ONLY)");
console.log(`  ANTHROPIC_API_KEY ${presence("ANTHROPIC_API_KEY")} (reasoning is deterministic either way; narrate() is the Claude hook)`);

type Agent = AgentSpec & {
  /** Agent API client with this agent's key; acts only for its own company. */
  api: ReturnType<typeof agentApi>;
  key: string;
  campaignId: Id<"campaigns">;
  budgetMinor: number;
  bidderKey: string;
  valuationMinor: number;
  maxMinor: number;
  raised: boolean;
};
type Me = { company: { displayName: string }; key: { name: string; prefix: string; budgetCapMinor: number }; campaigns: { campaignId: string; status: string; budgetMinor: number }[] };
type Screen = {
  billboardId: Id<"billboards">;
  name: string;
  explanation: string;
  matchScore: number | null;
  expectedAudiencePer15Min: number;
  audienceBasis: "measured" | "normal_traffic";
};
const siteUrl = requireEnv("CONVEX_SITE_URL", "Convex HTTP actions base URL (agent API)");
const agents: Agent[] = [];
for (const spec of AGENTS) {
  const key = requireEnv(spec.keyEnv, `${spec.advertiser}'s agent key (npx convex run seed:demoAgentKeys)`);
  const client = agentApi(siteUrl, key);
  let me: Me;
  try {
    me = await client.get<Me>("me");
  } catch (error) {
    fail(`${spec.name}: agent key rejected (${errorText(error)}). Issue fresh demo keys: npx convex run seed:demoAgentKeys`);
  }
  me = me!;
  if (me.company.displayName !== spec.advertiser) fail(`${spec.keyEnv} belongs to ${me.company.displayName}, expected ${spec.advertiser}`);
  const c = me.campaigns.find((x) => x.status === "active" || x.status === "draft");
  if (!c) fail(`No active campaign for ${spec.advertiser}. Run: npm run seed`);
  say(spec.name, `agent key "${me.key.name}" (${me.key.prefix}) for ${me.company.displayName}, cap ${centsToUsd(me.key.budgetCapMinor)}`);
  agents.push({
    ...spec,
    api: client,
    key,
    campaignId: c!.campaignId as Id<"campaigns">,
    budgetMinor: Math.min(c!.budgetMinor, me.key.budgetCapMinor),
    bidderKey: `${randomUUID()}${randomUUID()}`.replace(/-/g, ""),
    valuationMinor: 0,
    maxMinor: 0,
    raised: false,
  });
}

type BidOutcome = { leading: boolean; leaderLabel: string | null; currentMinor: number; minNextBidMinor: number; endsAt: number };
type MyStatus = {
  bidderLabel: string;
  outcome: "leading" | "outbid" | "not_bidding" | "won" | "lost" | "defaulted" | "failed";
  minNextBidMinor: number;
  holdId: Id<"holds"> | null;
  holdExpiresAt: number | null;
  amountMinor: number | null;
};

// ---------------------------------------------------------------- 1. screens

section("1. Each agent ranks screens for its audience");
const recs = new Map<string, Screen[]>();
for (const a of agents) {
  const rows = (await a.api.get<{ screens: Screen[] }>(`inventory?campaignId=${a.campaignId}&hours=1`)).screens;
  recs.set(a.name, rows);
  const top = rows[0];
  if (!top) fail("No billboards. Run: npm run seed");
  say(a.name, `${top.name}: ${top.explanation}`);
}
const billboardId = recs.get(agents[0].name)![0].billboardId;

// ---------------------------------------------------------------- 2. slot

section("2. Both agents want the same slot");
let slotId = argValue("slot") as Id<"slots"> | undefined;
if (!slotId) {
  const now = Date.now();
  const slots = await convex.query(api.slots.listForBillboard, { billboardId, from: now + MIN_LEAD_MS, to: now + 6 * 3600_000 });
  const candidates = slots.filter((s) => s.state === "available");
  for (const s of candidates) {
    const existing = await convex.query(api.auctions.forSlot, { slotId: s._id });
    if (!existing || existing.status === "failed" || existing.status === "open") {
      slotId = s._id;
      break;
    }
  }
}
if (!slotId) fail("No available slot at least 20 minutes out.");
console.log(`  slot ${slotId}`);

for (const a of agents) {
  try {
    const q = await a.api.post<{ amountMinor: number }>("quotes", { campaignId: a.campaignId, slotIds: [slotId!] });
    say(a.name, `posted quote ${centsToUsd(q.amountMinor)}`);
  } catch (error) {
    say(a.name, errorCode(error) === "AUCTION_OPEN" ? "slot is already being auctioned" : `quote failed: ${errorText(error)}`);
  }
}

section("3. Seller agent: two buyers on one slot makes it hot");
let auction = await convex.query(api.auctions.forSlot, { slotId: slotId! });
for (let i = 0; i < 10 && (!auction || auction.status !== "open"); i++) {
  await sleep(1000);
  auction = await convex.query(api.auctions.forSlot, { slotId: slotId! });
}
if (!auction || auction.status !== "open") {
  fail("No auction opened (the slot may not be hot). An operator can open one from the console's slot board, then rerun with --slot.");
}
const auctionId = auction!.auctionId;
console.log(`  auction ${auctionId}: ${auction!.openReason}`);
console.log(`  reserve ${centsToUsd(auction!.reserveMinor)} (the screen price; same for every bidder), closes in ${Math.round((auction!.endsAt - Date.now()) / 1000)} s`);

// ---------------------------------------------------------------- 3. valuations

section("4. Valuations: relevant viewers x value per relevant viewer");
for (const a of agents) {
  const rec = recs.get(a.name)!.find((r) => r.billboardId === billboardId)!;
  const viewers = rec.expectedAudiencePer15Min * auction!.slots.length;
  const match = rec.matchScore ?? 0.5;
  const relevant = viewers * match;
  // Going rate per viewer implied by the seller's reserve; the brand index says what a relevant viewer is worth to us.
  const marketPerViewer = auction!.reserveMinor / Math.max(1, viewers);
  const valuePerRelevantViewer = marketPerViewer * a.brandValueIndex;
  a.valuationMinor = Math.round(relevant * valuePerRelevantViewer);
  const cap = Math.min(a.valuationMinor, a.maxBidPerSlotMinor * auction!.slots.length, a.budgetMinor);
  a.maxMinor = Math.max(auction!.reserveMinor, Math.round(cap * a.openingShareOfValuation));
  for (const line of narrate([
    `${viewers} people per 15 min (${rec.audienceBasis === "measured" ? "camera" : "normal traffic"}) x ${Math.round(match * 100)}% audience match = ${relevant.toFixed(1)} relevant viewers`,
    `worth ${centsToUsd(Math.max(1, Math.round(valuePerRelevantViewer)))} each to us (${a.brandValueIndex}x the going rate: ${a.brandStory})`,
    `valuation ${centsToUsd(a.valuationMinor)}; capped by max bid ${centsToUsd(a.maxBidPerSlotMinor)} and budget ${centsToUsd(a.budgetMinor)}`,
    a.openingShareOfValuation < 1
      ? `opening auto-bid max ${centsToUsd(a.maxMinor)} (${Math.round(a.openingShareOfValuation * 100)}% of valuation; raise later only if outbid)`
      : `auto-bid max ${centsToUsd(a.maxMinor)}`,
  ])) {
    say(a.name, line);
  }
}

// ---------------------------------------------------------------- 4. bidding

section("5. Bidding (proxy bids raise each agent one step at a time, up to its private max)");
for (const a of agents) {
  const joined = await a.api.post<{ bidderLabel: string }>(`auctions/${auctionId}/join`, { campaignId: a.campaignId, clientKey: a.bidderKey });
  say(a.name, `joined as ${joined.bidderLabel}`);
}
for (const a of agents) {
  try {
    const r = await a.api.post<BidOutcome>(`auctions/${auctionId}/auto-bid`, { campaignId: a.campaignId, bidderKey: a.bidderKey, maxMinor: a.maxMinor });
    say(a.name, `auto-bid set; ${r.leading ? "leading" : `outbid, ${r.leaderLabel} leads`} at ${centsToUsd(r.currentMinor)}`);
  } catch (error) {
    say(a.name, `could not set auto-bid: ${errorText(error)}`);
  }
}

// Watch until close; Nvidia may raise once after reasoning about the competition.
let lastPrice = -1;
for (;;) {
  const view = await convex.query(api.auctions.forSlot, { slotId: slotId! });
  if (!view) fail("Auction disappeared");
  if (view!.currentMinor !== lastPrice) {
    lastPrice = view!.currentMinor;
    console.log(`  board        ${view!.leaderLabel ?? "no leader"} at ${centsToUsd(view!.currentMinor)} · ${Math.max(0, Math.round((view!.endsAt - Date.now()) / 1000))} s left`);
  }
  if (view!.status !== "open") break;
  for (const a of agents) {
    if (a.raised || a.openingShareOfValuation >= 1) continue;
    const mine = await a.api.get<MyStatus>(`auctions/${auctionId}/status?campaignId=${a.campaignId}`, { "X-Bidder-Key": a.bidderKey });
    if (mine.outcome !== "outbid") continue;
    const full = Math.min(a.valuationMinor, a.maxBidPerSlotMinor * view!.slots.length, a.budgetMinor);
    a.raised = true;
    if (full < mine.minNextBidMinor) {
      for (const line of narrate([`outbid at ${centsToUsd(view!.currentMinor)}; my full valuation ${centsToUsd(full)} is below the next bid. Stopping.`])) say(a.name, line);
      continue;
    }
    for (const line of narrate([
      `outbid at ${centsToUsd(view!.currentMinor)}. The competitor values this crowd too, but my full valuation ${centsToUsd(full)} still clears it.`,
      `raising my max once to ${centsToUsd(full)}; I won't chase beyond my valuation.`,
    ])) {
      say(a.name, line);
    }
    try {
      const r = await a.api.post<BidOutcome>(`auctions/${auctionId}/auto-bid`, { campaignId: a.campaignId, bidderKey: a.bidderKey, maxMinor: full });
      a.maxMinor = full;
      say(a.name, `${r.leading ? "now leading" : "still outbid"} at ${centsToUsd(r.currentMinor)}`);
    } catch (error) {
      say(a.name, `raise refused: ${errorText(error)}`);
    }
  }
  await sleep(POLL_MS);
}

// ---------------------------------------------------------------- 5. result

section("6. Result");
let final = (await convex.query(api.auctions.forSlot, { slotId: slotId! }))!;
for (let i = 0; i < 10 && final.status === "open"; i++) {
  await sleep(1000);
  final = (await convex.query(api.auctions.forSlot, { slotId: slotId! }))!;
}
console.log(`  status ${final.status}${final.outcomeNote ? ` (${final.outcomeNote})` : ""}`);
console.log("  ladder (newest first):");
for (const b of final.ladder) console.log(`    ${b.bidderLabel.padEnd(9)} ${centsToUsd(b.amountMinor).padStart(9)}${b.isAuto ? "  auto" : ""}`);

let winner: { agent: Agent; holdId: Id<"holds">; amountMinor: number; expiresAt: number } | null = null;
for (const a of agents) {
  const mine = await a.api.get<MyStatus>(`auctions/${auctionId}/status?campaignId=${a.campaignId}`, { "X-Bidder-Key": a.bidderKey });
  say(a.name, `${mine.bidderLabel}: ${mine.outcome}${mine.outcome === "won" && mine.amountMinor !== null ? ` at ${centsToUsd(mine.amountMinor)}` : ""}`);
  if (mine.outcome === "won" && mine.holdId && mine.amountMinor !== null && mine.holdExpiresAt) {
    winner = { agent: a, holdId: mine.holdId, amountMinor: mine.amountMinor, expiresAt: mine.holdExpiresAt };
  }
}
if (!winner) {
  console.log("\nNo winner (no bid reached the reserve).");
  process.exit(0);
}
const w = winner!;
console.log(`\n  ${w.agent.name} holds the slot at ${centsToUsd(w.amountMinor)} until ${new Date(w.expiresAt).toISOString()} (hold ${w.holdId}).`);

// ---------------------------------------------------------------- 6. pay

if (NO_PAY || !env("CDP_WALLET_SECRET")) {
  console.log(
    NO_PAY
      ? "  --no-pay: stopping at the hold."
      : "  CDP_WALLET_SECRET is not set, so the agent can't sign an x402 payment. Stopping at the hold.",
  );
  console.log("  The operator can record a simulated manual payment from the console; if nobody pays, the runner-up is offered the slot.");
  process.exit(0);
}

section(`7. ${w.agent.name} pays ${centsToUsd(w.amountMinor)} over x402`);
const purchaseUrl = `${SERVER}/purchases/${w.holdId}`;
const client = new CdpX402Client({
  environment: env("X402_ENVIRONMENT") === "production" ? "production" : "development",
  walletConfig: { type: "eoa", accountName: w.agent.wallet },
  spendControls: {
    maxAmountPerPayment: { atomic: centsToAtomic(w.amountMinor) },
    allowedNetworks: [NETWORK as `${string}:${string}`],
  },
});
const fetchWithPayment = wrapFetchWithPayment(globalThis.fetch, client);
try {
  // The agent key proves this agent may pay for its company (x402 itself uses PAYMENT-SIGNATURE).
  const res = await fetchWithPayment(purchaseUrl, { method: "POST", headers: { Authorization: `Bearer ${w.agent.key}` } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  console.log(`  HTTP ${res.status} ${JSON.stringify(body)}`);
  if (res.status === 200 && body.outcome === "booked") {
    console.log(`\n✓ ${w.agent.name} booked the slot at the clearing price ${centsToUsd(w.amountMinor)}; the auction is settled.`);
    process.exit(0);
  }
  fail("Payment did not book the slot (see the finance exceptions in the console).");
} catch (error) {
  fail(`x402 payment failed: ${errorText(error)}. Is the x402 server running (npm run server) and the wallet funded (npm run buyer -- --faucet)?`);
}
