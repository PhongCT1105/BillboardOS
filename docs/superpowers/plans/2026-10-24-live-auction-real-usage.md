# Live Auction for Real Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the live moment into a real, fast, bounded live auction among real advertiser accounts' server-run agents, with real x402 payments on Base Sepolia, one auction at a time across the host's screens, and no simulated, scripted or manual paths.

**Architecture:**
- **Pricing and agent rules** are pure functions in `convex/lib/` (`livePrice.ts`, `liveAuction.ts`, `companyAgent.ts`), unit-tested on their own.
- **The moment** (`convex/moments.ts`) keeps detection and announcing. The post-announce lifecycle moves to a new `convex/liveAuction.ts`: join window → auction, sale, negotiation or no takers → award → pay deadline → queue release.
- **Company agents** replace the seeded demo agents. They are the same signed-webhook pattern, run by our server per advertiser (`convex/companyAgents.ts`, `convex/companyAgentsNode.ts`), each with its own CDP wallet.
- **The UI:** the player becomes the 3-state display (with optional camera), the Live moment page becomes the presenter page, and the customer dashboard gets the agent setup page and live feed.

**Tech Stack:** Convex (queries, mutations, actions, scheduler, HTTP actions), convex-test + vitest, React 19 + Tailwind 4, `@coinbase/cdp-sdk` (`CdpX402Client`, `evm.getOrCreateAccount`, `evm.requestFaucet`, `evm.listTokenBalances`, account `transfer`), `@x402/fetch`.

**Spec:** `docs/superpowers/specs/2026-10-24-live-auction-real-usage-design.md`

## Global Constraints

- Read `convex/_generated/ai/guidelines.md` before writing Convex code. Every public and internal function has `args` and `returns` validators.
- Network is Base Sepolia, `eip155:84532`. Test USDC only. All amounts are integer cents (`...Minor`). Convert to USDC atomic units with the existing `centsToAtomic`.
- **Nothing on the demo path may be simulated, scripted, rehearsed or manual.**
  - A payment counts as paid only with a settlement transaction hash.
  - Crowd counts come only from audience rows with `source: "camera"`.
- **Legacy schema values stay** in validators so dev history validates: `paymentMode "rehearsal"`, trigger `"simulated"`, audience source `"simulated"`, provider `"manual"`, the `demoAgents` table, the workspace fields `rehearsalSettlement` and `momentCooldownMs`, and `flashOffers.simulatedAgent`. No code path may write them. Mark each one with a `/** Legacy: ... never written. */` comment.
- **Ads** are at most 30 s (`AD_SECONDS = 30`).
- **Pricing values:**

  | Value | Setting |
  |---|---|
  | Starting CPM | `$5` (`500`) |
  | Default published minimum | `$0.25` (`25`) |
  | Opening price | about 60% of value |
  | Minimum step | `max(5%, $0.05)` |

- **Auction timing values:**

  | Value | Setting |
  |---|---|
  | Join window | `2 s` |
  | Bidding | `12 s` |
  | Late bid (in the last `3 s`) | adds `3 s`, at most `2` times |
  | Max bids per company per auction | `5` |
  | Negotiation | at most `4` rounds, total time cap `18 s` |
  | Re-offer | after `20 s`, `15%` lower, then holds at the minimum |
  | Next spot goes on sale | `60 s` before the paid spot ends |
  | Pay window | `60 s` |

- **One live auction or negotiation per host workspace at a time.** Other screens queue in first-come order.
- The camera counts people only. Nothing identifies or profiles individuals.
- Run before every commit: `npm run typecheck` and `npm test`. Both must pass.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The winning company's wallet can't cover its bid.** The agent must not bid above its cached on-chain balance, and a winner whose payment fails goes to the runner-up. Tested in Task 3 (`agentCap`) and Task 7.
2. **The camera stopped sending, or its last reading is old.** No announcement may run on a reading older than 15 minutes. Tested in Task 5.
3. **Two bids land at the same moment.** The second, now too low, is rejected with `BID_TOO_LOW` rather than both "leading". Tested in Task 6.
4. **A company has two approved campaigns on this host.** It still gets exactly one offer per announcement. Tested in Task 5.
5. **An advertiser turns their agent off mid-auction.** Its key is revoked, so its later bids are refused. Tested in Task 7.

---

### Task 1: Live pricing rules (pure)

**Files:**
- Create: `convex/lib/livePrice.ts`
- Test: `convex/livePrice.test.ts`

**Interfaces:**
- Produces:
  - `AD_SECONDS = 30`, `DEFAULT_CPM_MINOR = 500`, `DEFAULT_LIVE_MINIMUM_MINOR = 25`, `OPENING_SHARE = 0.6`, `IDLE_STEP = 0.9`, `MAX_IDLE_PERIODS = 5`, `LARGE_CROWD = 25`, `START_DISCOUNT = 0.1`, `REOFFER_STEP = 0.85`, `MAX_JITTER = 0.03`, `MIN_SALES_FOR_REF = 5`
  - `type LivePriceInput = { peopleInView: number; spotMs: number; cpmRefMinor: number; bestMatch: number; idleMs: number; msUntilStart: number; reofferRound: number; minimumMinor: number; jitter: number }`
  - `type LivePrice = { valueMinor: number; openingMinor: number; minimumMinor: number; plays: number; impressions: number; relevance: number; why: string }`
  - `livePrice(input: LivePriceInput): LivePrice`
  - `referenceCpm(sales: { amountMinor: number; impressions: number }[], startingCpmMinor: number): number`

**The formula** (this is the only algorithm the tests don't fully pin down):

```
plays       = max(1, floor(spotMs / 30_000))
impressions = peopleInView × plays
relevance   = clamp(0.7 + 0.8 × bestMatch, 0.7, 1.5)
valueMinor  = round(impressions × cpmRefMinor / 1000 × relevance)
large       = peopleInView >= LARGE_CROWD
idleFactor  = large ? 1 : 0.9 ^ min(5, floor(idleMs / 15 min))
startFactor = large ? 1 : 1 − 0.1 × (1 − min(1, msUntilStart / 15 min))
raw         = round(valueMinor × 0.6 × idleFactor × startFactor × 0.85 ^ reofferRound × (1 + clamp(jitter, −0.03, 0.03)))
openingMinor = valueMinor <= minimumMinor ? minimumMinor : max(minimumMinor, min(valueMinor, raw))
```

The `why` text is exactly:

```
`${people} people × ${plays} plays at ${usd(cpm)} per 1,000 views × ${relevance.toFixed(2)} fit ≈ ${usd(value)}; idle ${idleMin} min; bidding opens at ${usd(opening)} (minimum ${usd(minimum)})`
```

When `reofferRound > 0`, append `; re-offer ${round}`. Here `usd(m)` is `$${(m/100).toFixed(2)}` and `idleMin = Math.floor(idleMs / 60_000)`.

For `referenceCpm`: if fewer than 5 sales have `impressions > 0`, return `startingCpmMinor`. Otherwise return the median of `round(amountMinor × 1000 / impressions)` over the last 20 such sales, in array order, oldest first.

- [ ] **Step 1: Write the failing tests** in `convex/livePrice.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { livePrice, referenceCpm } from "./lib/livePrice";

const base = { peopleInView: 10, spotMs: 12 * 60_000, cpmRefMinor: 500, bestMatch: 0.375, idleMs: 0, msUntilStart: 15 * 60_000, reofferRound: 0, minimumMinor: 25, jitter: 0 };

describe("livePrice", () => {
  test("worked example: 10 people x 24 plays at $5 CPM = $1.20, opens at 60%", () => {
    const p = livePrice(base);
    expect(p.plays).toBe(24);
    expect(p.impressions).toBe(240);
    expect(p.relevance).toBe(1);
    expect(p.valueMinor).toBe(120);
    expect(p.openingMinor).toBe(72);
    expect(p.why).toBe("10 people × 24 plays at $5.00 per 1,000 views × 1.00 fit ≈ $1.20; idle 0 min; bidding opens at $0.72 (minimum $0.25)");
  });
  test("spot starting now is 10% cheaper; each idle 15 min is 10% cheaper, at most 5 periods", () => {
    expect(livePrice({ ...base, msUntilStart: 0 }).openingMinor).toBe(65);
    expect(livePrice({ ...base, idleMs: 30 * 60_000 }).openingMinor).toBe(58);
    expect(livePrice({ ...base, idleMs: 10 * 60 * 60_000 }).openingMinor).toBe(livePrice({ ...base, idleMs: 75 * 60_000 }).openingMinor);
  });
  test("a large crowd pauses the idle and start discounts", () => {
    const p = livePrice({ ...base, peopleInView: 25, idleMs: 60 * 60_000, msUntilStart: 0 });
    expect(p.openingMinor).toBe(Math.round(p.valueMinor * 0.6));
  });
  test("re-offers step down 15% and never go below the minimum", () => {
    expect(livePrice({ ...base, reofferRound: 1 }).openingMinor).toBe(61);
    expect(livePrice({ ...base, reofferRound: 20 }).openingMinor).toBe(25);
    expect(livePrice({ ...base, reofferRound: 1 }).why).toContain("; re-offer 1");
  });
  test("value below the minimum opens at the minimum; opening never exceeds value", () => {
    expect(livePrice({ ...base, peopleInView: 1 }).openingMinor).toBe(25);
    expect(livePrice({ ...base, jitter: 0.5 }).openingMinor).toBe(74); // jitter clamped to +3%
  });
  test("relevance is clamped to 0.7..1.5", () => {
    expect(livePrice({ ...base, bestMatch: 0 }).relevance).toBe(0.7);
    expect(livePrice({ ...base, bestMatch: 1 }).relevance).toBe(1.5);
  });
});

describe("referenceCpm", () => {
  test("starting rate until 5 sales, then the median implied CPM", () => {
    const sale = (amountMinor: number) => ({ amountMinor, impressions: 200 });
    expect(referenceCpm([sale(100), sale(100)], 500)).toBe(500);
    expect(referenceCpm([sale(100), sale(120), sale(140), sale(160), sale(180)], 500)).toBe(700);
    expect(referenceCpm([sale(100), { amountMinor: 999, impressions: 0 }], 500)).toBe(500);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run convex/livePrice.test.ts`. Expected: FAIL, because `./lib/livePrice` doesn't exist yet.
- [ ] **Step 3: Implement** `convex/lib/livePrice.ts` with the constants, types and formula above.
- [ ] **Step 4: Run** `npx vitest run convex/livePrice.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `git add convex/lib/livePrice.ts convex/livePrice.test.ts && git commit -m "feat: live pricing rules for the host pricing agent"`

### Task 2: Live auction rules (pure)

**Files:**
- Create: `convex/lib/liveAuction.ts`
- Test: `convex/liveAuctionRules.test.ts`

**Interfaces:**
- Consumes: `increment`, `IncrementRule` from `convex/lib/auction.ts`.
- Produces:
  - Constants: `LIVE_INCREMENT: IncrementRule = { percentBps: 500, minMinor: 5 }`, `JOIN_WINDOW_MS = 2_000`, `BIDDING_MS = 12_000`, `EXTENSION_MS = 3_000`, `MAX_EXTENSIONS = 2`, `MAX_BIDS_PER_COMPANY = 5`, `REOFFER_DELAY_MS = 20_000`, `NEXT_SPOT_LEAD_MS = 60_000`, `NEGOTIATION_MAX_ROUNDS = 4`, `NEGOTIATION_TIME_CAP_MS = 18_000`.
  - `minNextLiveBid(s: { leaderMinor: number | null; openingMinor: number }): number`. Returns the opening price when there is no leader, otherwise `leader + increment(leader, LIVE_INCREMENT)`.
  - `extendLive(s: { now: number; closesAt: number; extensions: number }): { closesAt: number; extensions: number }`.
  - `type JoinReply = { offerId: string; status: "accepted" | "countered" | "passed" | "sent" | "expired"; amountMinor: number | null; repliedAt: number | null }`
  - `joinOutcome(replies: JoinReply[]): { kind: "auction"; participantIds: string[] } | { kind: "sale"; offerId: string; amountMinor: number } | { kind: "negotiation"; offerId: string; amountMinor: number } | { kind: "none" }`
  - `checkBid(s: { phase: string; now: number; closesAt: number; bidCount: number; isLeader: boolean; amountMinor: number; minNextMinor: number }): "NOT_BIDDING" | "BIDDING_CLOSED" | "BID_LIMIT" | "ALREADY_LEADING" | "BID_TOO_LOW" | null`. Checks run in that order. `phase` must be `"bidding"`.

**Rules for `joinOutcome`:**
- 2 or more `accepted` → `auction`. Participants are all `accepted` and `countered` offers.
- Exactly 1 `accepted` → `sale` at its amount.
- 0 `accepted` and 1 or more `countered` → `negotiation` with the highest counter (ties go to the earliest `repliedAt`).
- Otherwise → `none`.

- [ ] **Step 1: Write the failing tests** in `convex/liveAuctionRules.test.ts`. They should cover:
  - `minNextLiveBid({leaderMinor:null, openingMinor:72})` is 72; with leader 72 it is 77; with leader 77 it is 82; with leader 200 it is 210.
  - `extendLive`:
    - `{now: 10_000, closesAt: 12_000, extensions: 0}` → `{closesAt: 15_000, extensions: 1}`
    - `{now: 10_000, closesAt: 14_000, extensions: 0}` is unchanged (more than 3 s left)
    - `{extensions: 2}` is unchanged
  - `joinOutcome`:
    - two accepted plus one countered → auction with 3 participants
    - one accepted plus one countered → sale at the accepted amount
    - counters 40 and 55 → negotiation with the 55 offer
    - two counters of 55 → the earlier `repliedAt` wins
    - all passed → `none`
  - `checkBid`:
    - each error code in order, for example `bidCount: 5` → `BID_LIMIT` and `amountMinor: 76, minNextMinor: 77` → `BID_TOO_LOW`
    - a valid bid → `null`
- [ ] **Step 2: Run** `npx vitest run convex/liveAuctionRules.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `convex/lib/liveAuction.ts` per the Interfaces block.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: live auction rules (5¢ steps, 12 s + two 3 s extensions, join outcomes)`

### Task 3: Company agent tactics (pure)

**Files:**
- Create: `convex/lib/companyAgent.ts`
- Test: `convex/companyAgentRules.test.ts`

**Interfaces:**
- Produces:
  - `agentCap(i: { valueMinor: number; matchScore: number; maxPerSpotMinor: number; budgetLeftMinor: number; balanceMinor: number }): number` = `max(0, min(round(valueMinor × (0.5 + matchScore)), maxPerSpotMinor, budgetLeftMinor, balanceMinor))`.
  - `onAnnounce(i: { openingMinor: number; minimumMinor: number; relevantViewers: number; minRelevantViewers: number; cap: number }): { decision: "accept" | "counter" | "pass"; amountMinor?: number; reasoning: string }`:
    - pass if `relevantViewers < minRelevantViewers`;
    - accept if `cap >= openingMinor`;
    - counter at `max(minimumMinor, round(cap × 0.8))` if `cap >= minimumMinor`;
    - otherwise pass.
  - `onUpdate(i: { youLead: boolean; bidsLeft: number; minNextMinor: number; cap: number }): { bidMinor: number } | null`. Bids `minNextMinor` when not leading, with bids left, and `minNextMinor <= cap`.
  - `onCounter(i: { sellerMinor: number; lastOfferMinor: number; cap: number }): { decision: "accept" | "counter" | "pass"; amountMinor?: number; reasoning: string }`:
    - accept if `sellerMinor <= cap`;
    - otherwise counter at `min(cap, round(lastOfferMinor + (sellerMinor − lastOfferMinor) × 0.5))` if that is above `lastOfferMinor`;
    - otherwise pass.
  - `bidDelayMs(rand: number): number` = `300 + floor(clamp(rand,0,1) × 700)`.

- [ ] **Step 1: Write the failing tests** in `convex/companyAgentRules.test.ts`:
  - `agentCap` with value 120, match 0.5 → 120; with `maxPerSpotMinor` 150 → 120; with `balanceMinor` 50 → 50 (Review Focus 1); with `budgetLeftMinor` 0 → 0.
  - `onAnnounce`:
    - opening 72, cap 120 → accept
    - cap 50, minimum 25 → counter 40
    - cap 20 → pass
    - `relevantViewers` 2 with min 3 → pass, and the reasoning contains "under my minimum of 3"
  - `onUpdate`:
    - leading → null
    - `bidsLeft` 0 → null
    - minNext 82, cap 81 → null
    - minNext 82, cap 120 → `{bidMinor: 82}`
  - `onCounter`:
    - seller 61, cap 70 → accept
    - seller 61, last 40, cap 55 → counter 51
    - seller 61, last 55, cap 55 → pass
  - `bidDelayMs`: 0 → 300, 1 → 1000.
- [ ] **Step 2: Run** `npx vitest run convex/companyAgentRules.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `convex/lib/companyAgent.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: fast rule-based company agent tactics`

### Task 4: Schema and settings for the live auction

**Files:**
- Modify: `convex/schema.ts`. Covers `momentTrigger`, `momentStatus`, `paymentMode`, `momentFields`, `flashOfferFields`, `standingInstructions`, the billboard fields (around line 343), `audienceSource`, and the new tables `momentBids` and `companyAgents`.
- Modify: `convex/lib/moment.ts`: settings and the `Standing` type.
- Modify: `convex/moments.ts`: `settingsView`, `settings`, `updateSettings`, `setStanding`.
- Test: `convex/liveAuction.test.ts` (new; later tasks add to it).

**Interfaces:**
- Produces, schema:
  - `momentTrigger` adds `"queue" | "reoffer" | "next_spot"`.
  - `momentStatus` adds `"bidding" | "negotiating"`.
  - New optional `momentFields`:
    - pricing: `valueMinor`, `peopleInView`, `plays`, `impressions`, `priceWhy`;
    - bidding: `leaderOfferId: v.id("flashOffers")`, `currentMinor`, `biddingClosesAt`, `hardClosesAt`, `extensions`;
    - re-offers: `reofferRound`;
    - negotiation: `sellerMinor`, `negotiationOfferId: v.id("flashOffers")`, `negotiationRound`.
    - `priceMinor` now means the opening price and `floorMinor` the published minimum; update their doc comments.
  - `flashOfferFields` adds optional `bidCount` and `lastBidMinor`, and `simulatedAgent` becomes `v.optional(v.boolean())` (legacy).
  - `standingInstructions.policy` becomes optional (legacy).
  - Billboards add optional `cpmMinor` and `saleQueuedAt`.
  - New table `momentBids`: `{ momentId: v.id("moments"), offerId: v.id("flashOffers"), advertiserId: v.id("advertisers"), kind: v.union(v.literal("bid"), v.literal("buyer_offer"), v.literal("seller_counter")), amountMinor: v.number(), at: v.number(), reasoning: v.optional(v.string()) }`, with index `by_moment` on `["momentId", "at"]`.
  - New table `companyAgents`: `{ advertiserId, campaignId: v.id("campaigns"), agentKeyId: v.id("agentKeys"), keyCiphertext, keyIv, walletName: v.string(), walletAddress: v.optional(v.string()), balanceMinor: v.optional(v.number()), balanceAt: v.optional(v.number()), enabled: v.boolean(), topUpDay: v.optional(v.string()), topUpCount: v.optional(v.number()), lastAction: v.optional(v.string()), lastActionAt: v.optional(v.number()) }`, with index `by_advertiser`.
- Produces, settings:
  - `MomentSettings = { enabled: boolean; minPeopleInView: number; joinWindowMs: number; minMatch: number }`, with defaults `{ true, 1, 2_000, 0.3 }`.
  - Limits: `minPeopleInView` 1..10000 (integer), `joinWindowMs` 1000..10000, `minMatch` 0..1.
  - `momentSettingsOf(ws)` reads the new optional workspace field `momentMinPeopleInView` and reuses `momentResponseWindowMs` as the join window. `momentCooldownMs` and `rehearsalSettlement` are no longer read.
  - `Standing.policy` and `counterRatio` become optional. `validateStanding` stops requiring `counterRatio`, and `standingCovers` treats only `policy === "pass"` as a refusal.
  - `settingsView` becomes `{ enabled, minPeopleInView, joinWindowSeconds, minMatch }`.

- [ ] **Step 1: Write the failing test** in `convex/liveAuction.test.ts`: `test("settings defaults: 1 person in view, 2 s join window, no cooldown or rehearsal")`. It calls `api.moments.settings` as a fresh operator and asserts `{ enabled: true, minPeopleInView: 1, joinWindowSeconds: 2, minMatch: 0.3 }`. Copy the test bootstrap (fake timers, `INTERNAL_API_SECRET`, `CONVEX_SITE_URL`, `fetch` stub routing `SITE` to `t.fetch` and returning 200 for `https://agent.test/*`) from `convex/moments.test.ts:17-52`.
- [ ] **Step 2: Run** `npx vitest run convex/liveAuction.test.ts`. Expected: FAIL (wrong settings shape).
- [ ] **Step 3: Implement** the schema and settings changes above. Add the legacy comments. Fix any type errors this causes in `moments.ts`, `demoAgentsNode.ts` and `lib/moment.ts` callers without changing behaviour; they are removed in later tasks.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS. The old `moments.test.ts` may need its settings assertions updated to the new shape; nothing else.
- [ ] **Step 5: Commit:** `feat: schema and settings for the live auction`

### Task 5: Announce: camera-only, live price, reach targets, queue and re-offer

**Files:**
- Modify: `convex/moments.ts`:
  - replace the body of `detectCore`, and keep the name as the entry point;
  - update `findTargets`;
  - delete `simulateCrowd`;
  - keep `detectFor` and `scheduleDetect`.
- Modify: `convex/lib/moment.ts`. Delete `detect()` and `Detection`; keep `audienceMix` and `campaignFit`.
- Modify: `convex/lib/momentHooks.ts`. In `onMomentPaid`, schedule `internal.moments.detectFor` with trigger `"next_spot"` at `max(now, moment.spotEndAt − NEXT_SPOT_LEAD_MS)`.
- Delete: `convex/moments.test.ts`. Its surviving pure cases (`rankReplies`, crypto round-trip) move into `convex/liveAuction.test.ts`.
- Test: `convex/liveAuction.test.ts`.

**Interfaces:**
- Consumes: `livePrice`, `referenceCpm`, `DEFAULT_CPM_MINOR`, `DEFAULT_LIVE_MINIMUM_MINOR` (Task 1); `JOIN_WINDOW_MS`, `REOFFER_DELAY_MS`, `NEXT_SPOT_LEAD_MS` (Task 2); the Task 4 schema.
- Produces:
  - `detectCore(ctx, billboardId, trigger): Promise<{ momentId: Id<"moments"> | null; reason: string }>`, with the same signature.
  - `export async function workspaceBusy(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<boolean>`. True if any of the 20 most recent moments for the workspace (index `by_workspace`) has status `offering`, `bidding`, `negotiating` or `awarded`.
  - `export async function latestCameraReading(ctx: QueryCtx, billboardId: Id<"billboards">, now: number): Promise<{ peopleInView: number; bucketStart: number } | null>`. Uses the newest `audienceAggregates` row with `source === "camera"` and `bucketStart >= now − 15 min`; `peopleInView` is that row's `peakInView`.
  - Each moment schedules `internal.liveAuction.closeJoin` at `startedAt + joinWindowMs`. Task 6 creates it, so in this task add a stub `closeJoin` internal mutation in a new `convex/liveAuction.ts` that only records a `window_closed` step.

**Announce algorithm, in order** (each early return gives a reason string):
1. The screen must be online and the workspace enabled.
2. If `workspaceBusy`, set `billboard.saleQueuedAt = billboard.saleQueuedAt ?? now` and return `"queued"`.
3. If the latest moment on this screen is `paid` or `playing` and `spotEndAt − now > NEXT_SPOT_LEAD_MS`, return `"playing"`.
4. Get `latestCameraReading`. If it is null or below `settings.minPeopleInView`, return.
5. Run `pickSpot` (unchanged).
6. Price the spot:
   - `idleMs` = `now − (spotEndAt of the latest moment on this screen with paidMinor set)`, or `now − billboard._creationTime` if there is none.
   - `msUntilStart = max(0, slot.startAt − now)`.
   - `reofferRound` = the previous round + 1 if the latest moment on this screen is `no_takers` for the same `slotId`, otherwise 0.
   - `cpmRefMinor = referenceCpm(...)`, taken from the last 20 moments on this screen with `paidMinor` and `impressions`, starting from `billboard.cpmMinor ?? DEFAULT_CPM_MINOR`.
   - `minimumMinor = billboard.reserveFloorMinor`.
7. Run `findTargets`:
   - the floor is `minimumMinor`;
   - each campaign's `relevantViewers = round(peopleInView × matchScore)` and is checked against `standing.minRelevantViewers`;
   - the agent key must also have the `bid` scope, alongside `hold` and `pay`;
   - the `demoAgents` lookup is removed;
   - `bestMatch` = the highest target `matchScore` (0 if there are no targets).
8. Run `livePrice` with `jitter = (Math.random() × 2 − 1) × 0.03`.
9. Insert the moment with the pricing fields:
   - `priceMinor = openingMinor`, `floorMinor = minimumMinor`, `crowd = peopleInView`;
   - `reasoning` and `priceWhy = why`;
   - `crowdSource "camera"`.
10. With **no targets:** set status `no_takers`. If `openingMinor > minimumMinor`, schedule `detectFor` with trigger `"reoffer"` at `now + REOFFER_DELAY_MS`.
11. With **targets:** set status `offering` and `offerClosesAt = now + joinWindowMs`. Insert the offers (`priceMinor = openingMinor`, no `simulatedAgent`), plus the alerts and `flash_offer` deliveries as today. Schedule `closeJoin`.

When the moment ends in `no_takers` or `failed`, or reaches `paid`, call `releaseWorkspace` (Task 6). In this task, only `no_takers` with no targets exists: call a stub `releaseWorkspace` exported from `convex/liveAuction.ts`.

- [ ] **Step 1: Write a test fixture and failing tests** in `convex/liveAuction.test.ts`.

  The fixture `liveWorld()` sets up:
  - a host operator with screen "LED" (`reserveFloorMinor: 25`, `baseRateMinor: 300`, `audienceTags: { startups: 0.5, software: 0.3, tourists: 0.2 }`, online, with slots);
  - two customer companies "LaunchKit" and "Rivet", each with an active campaign (`targetAudience: { startups: 1 }`), an uploaded creative and a host approval;
  - for each company, an agent key issued with scopes `hold`, `pay` and `bid`, `webhookUrl: "https://agent.test/<company>"`, and standing `{ maxPricePerSpotMinor: 150, minRelevantViewers: 3, dailyBudgetMinor: 500 }`;
  - a `camera(people)` helper that calls `api.audience.addArrivals` as the host with `{ arrivals: people, peakInView: people, confidence: 1, source: "camera" }`.

  Tests:
  - `"announce: camera people in view, live price and why, one offer per company"`:
    - after `camera(10)` and running scheduled functions, there is one moment with status `offering`, `peopleInView` 10 and `valueMinor > 0`;
    - `priceWhy` contains `"10 people ×"`;
    - there are 2 `flashOffers`.
    - Then give LaunchKit a second approved campaign, call `camera(10)` on a new slot, and assert still 2 offers (Review Focus 4).
  - `"reach target: a company needing more matching people gets no offer"`. Set Rivet's `minRelevantViewers` to 50. One offer.
  - `"simulated and stale readings never announce"`:
    - insert an `audienceAggregates` row with `source: "simulated"` through `t.run` → no moment;
    - `camera(10)`, then advance the clock 16 min and trigger `detectFor` → no new moment (Review Focus 2).
  - `"one auction at a time per host: the second screen queues"`. Add a second screen "Phone". `camera(10)` on LED, then on Phone → Phone's `saleQueuedAt` is set and Phone has no moment.
  - `"no takers: re-offer about 15% lower after 20 s, then hold at the minimum"`:
    - revoke both keys, `camera(10)`, and check for a `no_takers` moment;
    - advance 20 s, run scheduled functions, and expect a second moment with `reofferRound: 1` and `priceMinor` between `floor(first × 0.85 × 0.97)` and `ceil(first × 0.85 × 1.03)`;
    - loop until `priceMinor === 25`, then assert no further `detectFor` is scheduled.
  - `"simulateCrowd is gone"`: `expect((api.moments as Record<string, unknown>).simulateCrowd).toBeUndefined()`.
- [ ] **Step 2: Run** `npx vitest run convex/liveAuction.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the announce algorithm, the `findTargets` changes, the `momentHooks` next-spot scheduling, the stubs, and the deletions above.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: announce on real camera counts with live pricing, reach targets, queue and re-offers`

### Task 6: Join, bidding, sale, negotiation, award and queue release

**Files:**
- Modify: `convex/liveAuction.ts`. Replace the stubs with the full lifecycle, and move `award`, `closeCore`→`closeJoin` and `payDeadline` here from `moments.ts`.
- Modify: `convex/moments.ts`. `reply` handles the `offering` and `negotiating` phases. Delete the old `close` and `payDeadline`.
- Modify: `convex/momentDelivery.ts`. Add the events `auction_started`, `auction_update` and `negotiation_counter`, and add `valueMinor`, `openingMinor`, `minimumMinor` and `why` to `flash_offer`.
- Modify: `convex/http.ts`. Add `POST /api/agent/offers/{id}/bid`.
- Modify: `convex/lib/momentHooks.ts`. `onMomentPaid` calls `releaseWorkspace`.
- Test: `convex/liveAuction.test.ts`.

**Interfaces:**
- Consumes: Task 2 (`joinOutcome`, `minNextLiveBid`, `extendLive`, `checkBid`, constants); `sellerRespond` from `convex/lib/negotiation.ts`; `takeHold`, `endHold`, `assertWithinBudget`, `replyAllowed`, `spentTodayMinor`.
- Produces:
  - `internal.liveAuction.closeJoin({ momentId }) → null`. Runs `joinOutcome` on the offers.
    - **auction:** status `bidding`; `biddingClosesAt = now + BIDDING_MS`; `hardClosesAt = biddingClosesAt + MAX_EXTENSIONS × EXTENSION_MS`; `extensions: 0`; deliver `auction_started` to each participant; schedule `closeBidding` at `biddingClosesAt`.
    - **sale:** award at the opening price.
    - **negotiation:** status `negotiating`; `sellerMinor = priceMinor`; `negotiationOfferId`; `negotiationRound: 1`. Respond to the buyer's counter with `sellerRespond({ floorMinor, sellerMinor, bestBuyerMinor: null, round: 1, maxRounds: NEGOTIATION_MAX_ROUNDS }, counter)`. Record a `momentBids` row for the buyer offer and for the seller counter. Deliver `negotiation_counter`. Schedule `closeNegotiation` at `startedAt + NEGOTIATION_TIME_CAP_MS`.
    - **none:** status `no_takers`; schedule a re-offer as in Task 5; call `releaseWorkspace`.
  - `internal.liveAuction.placeBid({ token: v.string(), offerId: v.string(), amountMinor: v.number(), reasoning: v.optional(v.string()) }) → { offerId, currentMinor, youLead: boolean, bidsLeft, closesAt }`.
    - Authenticate with scope `"bid"` and check `checkBid`. The ConvexError codes are the `checkBid` codes plus `NOT_FOUND`.
    - Enforce `replyAllowed` and `assertWithinBudget`.
    - Insert a `momentBids` row.
    - Patch the offer: `bidCount + 1`, `lastBidMinor`, and `replyAmountMinor = amount`.
    - Patch the moment: `currentMinor`, `leaderOfferId`, and `extendLive`. When `closesAt` moves, schedule another `closeBidding` at the new time.
    - Deliver `auction_update` to every participant.
  - `internal.liveAuction.closeBidding({ momentId }) → null`. Does nothing if `now < biddingClosesAt` or the status isn't `bidding`. With a leader → award at `currentMinor`; with no bids → `no_takers` + re-offer + `releaseWorkspace`.
  - `internal.liveAuction.closeNegotiation({ momentId }) → null`. If still `negotiating`, set `no_takers` + re-offer + `releaseWorkspace`.
  - `export async function negotiationReply(ctx: MutationCtx, moment: Doc<"moments">, offer: Doc<"flashOffers">, decision: "accept" | "counter" | "pass", amountMinor: number | undefined, reasoning: string | undefined): Promise<void>`:
    - accept → award at `sellerMinor`;
    - counter → `sellerRespond` with `round = negotiationRound + 1`; accept → award, counter → deliver the next counter, reject → `no_takers`;
    - pass → `no_takers`.
  - `internal.liveAuction.payDeadline({ momentId, offerId })`. Same behaviour as today. Runner-up ranking uses `replyAmountMinor` at or above `floorMinor`.
  - `export async function releaseWorkspace(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void>`. Finds the online billboard in the workspace with the smallest `saleQueuedAt`, clears its `saleQueuedAt`, and schedules `detectFor` with trigger `"queue"` immediately.
  - `award(ctx, moment, exclude)`, called on `paymentBlocked` or a failed hold, calls `releaseWorkspace` when it marks the moment `failed`.

**Webhook payloads** (`momentDelivery.loadForDelivery`; the shared `common` part is unchanged):
- `auction_started`: `{ type, ...common, openingMinor, minNextMinor, closesAt, bidsLeft: 5, participants: number, links: { bid: "/api/agent/offers/{id}/bid" } }`
- `auction_update`: `{ type, ...common, currentMinor, youLead, minNextMinor, closesAt, bidsLeft, lastBidBy: "you" | "another company" }`
- `negotiation_counter`: `{ type, ...common, sellerMinor, round, roundsLeft, respondBy, links: { reply } }`
- `flash_offer` adds `valueMinor`, `openingMinor` (= `priceMinor`), `minimumMinor` and `why`.

**HTTP:** in `agentPost` (`convex/http.ts:294`), match `^offers/([^/]+)/bid$`. Require `amountMinor` (a number). Call `internal.liveAuction.placeBid` and map ConvexError codes to HTTP statuses the same way the reply route does.

- [ ] **Step 1: Write the failing tests** in `convex/liveAuction.test.ts`, using `liveWorld()` and `t.fetch` against `/api/agent/offers/{id}/reply` and `/bid` with each company's bearer key:
  - `"two companies: auction rises in 5¢ steps, highest bid wins and gets a hold"`:
    - `camera(10)`, then both companies reply `accept`;
    - after the join window, the status is `bidding`;
    - bids go LaunchKit 72 (the opening price), Rivet 77, LaunchKit 82;
    - advance past `biddingClosesAt` and run scheduled functions;
    - the status is `awarded`, the winner offer is LaunchKit's, and the hold amount is 82;
    - `momentBids` has 3 rows of kind `bid`.
  - `"bid rules: too low, sixth bid, leader can't raise, closed"`:
    - assert HTTP 4xx with the codes `BID_TOO_LOW`, `BID_LIMIT`, `ALREADY_LEADING` and `BIDDING_CLOSED`;
    - also send two identical bids of 77 back to back from Rivet and LaunchKit: the second is `BID_TOO_LOW` (Review Focus 3).
  - `"late bids extend by 3 s, at most twice"`. Bid at `biddingClosesAt − 1000` three times in turn; `biddingClosesAt` moves exactly twice, by 3000 each time.
  - `"exactly one taker: sold at the opening price without bidding"`. LaunchKit accepts and Rivet passes → `awarded` at `priceMinor`, with no `bidding` phase.
  - `"only counters: negotiation never goes below the minimum"`:
    - LaunchKit counters 40 and Rivet passes;
    - the status is `negotiating`, and the seller's counter is `72 − round((72 − 40) × 0.35) = 61`;
    - LaunchKit counters 55 → the seller counters `61 − round((61 − 55) × 0.25) = 59`;
    - LaunchKit accepts → `awarded` at 59.
    - In a separate run, LaunchKit counters 40, 41, 42 and then 20. The fourth offer is the final round, and 20 is below the 25 minimum, so the result is `no_takers`.
  - `"winner who doesn't pay in 60 s: runner-up at its last bid"`. After the auction above, advance 60 s → Rivet is `won` with a hold amount of 77, and a `winner_default` exception exists.
  - `"the queue drains when the host is free"`. The Phone screen is queued during the LED auction. When the LED moment reaches `no_takers` (both companies pass), Phone gets a moment with trigger `"queue"`.
- [ ] **Step 2: Run** `npx vitest run convex/liveAuction.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the Interfaces block.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: live auction lifecycle: join, bidding, negotiation, award, queue`

### Task 7: Company agents run by our server, each with its own wallet

**Files:**
- Create: `convex/companyAgents.ts` (queries and mutations).
- Create: `convex/companyAgentsNode.ts` (`"use node"`: wallet calls, payment and acting).
- Modify: `convex/http.ts`. Add `POST /company-agents/{advertiserId}/webhook`, copied from the `/demo-agents/` route at `convex/http.ts:670-697` but calling `internal.companyAgents.verifyWebhook` and `internal.companyAgents.enqueue`.
- Modify: `convex/liveAuction.ts`. On payment failure, call the existing `award(…, exclude)` path. There is no rehearsal.
- Test: `convex/liveAuction.test.ts`.

**Interfaces:**
- Consumes: Task 3 tactics; `encryptSecret` / `decryptSecret` (`convex/lib/demoCrypto.ts`); `internal.agentKeys.issueForCompany` and `revokeByPrefix`; `signWebhook`; the x402 pay code in `convex/demoAgentsNode.ts:68-111`, moved here.
- Produces:
  - `api.companyAgents.setup({ campaignId: v.id("campaigns"), targetAudience: audienceTags, minRelevantViewers: v.number(), maxPerSpotMinor: v.number(), dailyBudgetMinor: v.number() }) → { agentId: v.id("companyAgents") }`:
    - allowed for a customer who belongs to the campaign's company;
    - validates with `validateTags` and `validateStanding`;
    - patches `campaign.targetAudience`;
    - revokes any previous key, then issues a new key with scopes `["quote","hold","bid","pay"]`, `webhookUrl = ${CONVEX_SITE_URL}/company-agents/${advertiserId}/webhook`, and standing `{ maxPricePerSpotMinor, minRelevantViewers, dailyBudgetMinor }`;
    - stores the key encrypted; `walletName = "co-" + advertiserId`; `enabled: true`;
    - schedules `internal.companyAgentsNode.ensureWallet`.
  - `api.companyAgents.setEnabled({ enabled: v.boolean() }) → null`. Disabling revokes the key; enabling issues a fresh one, as in `setup`.
  - `api.companyAgents.mine({}) → null | { enabled, campaignId, targetAudience, standing, walletAddress, balanceMinor, spentTodayMinor, lastAction }`
  - `api.companyAgents.feed({ limit: v.optional(v.number()) }) → Array<{ at: number; kind: "announce" | "bid" | "rival_bid" | "counter" | "won" | "lost" | "paid" | "blocked"; text: string; amountMinor?: number; txUrl?: string }>`. Built from this company's `flashOffers` (index `by_advertiser`, newest 10), their moments' `momentBids` and steps. Rival bids say "Another company".
  - `api.companyAgents.requestTopUp({}) → null`. Allowed 5 per UTC day per company (`topUpDay` / `topUpCount`). Schedules `topUp` with `amountMinor: 200`.
  - Internal: `forAct`, `logAction`, `enqueue`, `verifyWebhook` (same shapes as the `demoAgents` ones), and `setWallet({ advertiserId, walletAddress, balanceMinor })`.
  - Node actions:
    - `ensureWallet({ advertiserId })`:
      - without the CDP env, log `"no CDP keys"`;
      - otherwise `getOrCreateAccount({ name: walletName })`;
      - if the USDC balance is under 100, claim the USDC faucet once;
      - save the address and balance.
    - `refreshBalance({ advertiserId })`: reads `evm.listTokenBalances` for USDC (as in `server/buyer-agent.ts:93-108`) and saves it as cents.
    - `topUp({ advertiserId, amountMinor })`:
      - the operator account is `X402_RECEIVER_WALLET_NAME || "billboardos-operator"`;
      - if its USDC is at least `amountMinor`: when its ETH is below 0.00002, claim the ETH faucet; then `operator.transfer({ to, amount: BigInt(amountMinor) * 10_000n, token: "usdc", network: "base-sepolia" })`;
      - otherwise claim the USDC faucet to the company wallet;
      - in both cases, `refreshBalance`.
    - `act({ advertiserId, payload })`:
      - `flash_offer` → `onAnnounce` with `cap = agentCap({ valueMinor, matchScore: payload.audienceMatch, maxPerSpotMinor, budgetLeftMinor: dailyBudget − spentToday, balanceMinor: cached ?? 0 })` → POST reply;
      - `auction_started` / `auction_update` → `onUpdate`, wait `bidDelayMs(Math.random())` (0 when `COMPANY_AGENT_DELAY_MS === "0"`), then POST bid;
      - `negotiation_counter` → `onCounter` → POST reply;
      - `flash_won` → pay over x402 from `walletName`; on success, `refreshBalance`; on failure, call `internal.moments.paymentBlocked` (Task 8 strips its rehearsal branch);
      - `flash_lost` → log.

- [ ] **Step 1: Write the failing tests** in `convex/liveAuction.test.ts`. Set `COMPANY_AGENT_DELAY_MS = "0"` and leave the CDP env unset. Add a `liveWorldWithAgents()` variant that sets up both companies through `api.companyAgents.setup`.
  - `"setup issues an encrypted key with standing and our webhook, and sets the profile"`:
    - the `agentKeys` row has `webhookUrl` ending in `/company-agents/<id>/webhook` and the standing values;
    - `companyAgents.keyCiphertext` doesn't contain the plaintext key;
    - the campaign's `targetAudience` is updated.
  - `"the company webhook rejects a bad signature"`: HTTP 401.
  - `"two company agents run a real auction end to end, then payment without CDP keys is blocked, never paid"`:
    - set both agents' `balanceMinor` to 500 through `t.run`, then `camera(10)`;
    - run scheduled functions and timers to completion;
    - `momentBids` has at least 2 bids, and each company has at most 5;
    - the moment's `paymentBlocked` is set; it never reaches `paid`; there is no `payments` row; the moment ends `failed` after the runner-up also fails.
  - `"an agent never bids above its wallet balance"`. LaunchKit `balanceMinor: 50` → it counters, never accepts; its bids are never above 50 (Review Focus 1).
  - `"turning an agent off mid-auction refuses its later bids"`. During `bidding`, `setEnabled(false)` for Rivet → a direct bid with Rivet's old key returns 401 (Review Focus 5).
  - `"top up is limited to 5 per day"`. The sixth `requestTopUp` throws `RATE_LIMITED`.
- [ ] **Step 2: Run** `npx vitest run convex/liveAuction.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces block.
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: server-run company agents with their own Base Sepolia wallets`

### Task 8: Remove simulated, scripted and manual paths

**Files:**
- Modify `convex/payments.ts`: delete `recordManual`.
- Modify `convex/http.ts`: remove `manual` from the provider list at line 51, and delete the `/demo-agents/` route.
- Modify `convex/moments.ts`: delete `setRehearsalSettlement`; strip the rehearsal branch from `paymentBlocked`, which now only records the block and returns `null`.
- Modify `convex/lib/momentHooks.ts`: delete `isRehearsalRef`, and stop writing `paymentMode: "rehearsal"`.
- Delete `convex/demoAgents.ts` and `convex/demoAgentsNode.ts`, and remove the agent part of `seed:demoMoment` (rename it to `seed:liveVenue`; it keeps only the screen, slots and event setup).
- Delete `server/auction-agents.ts` and the `auction:demo` script in `package.json`.
- Modify `src/console/SlotBoard.tsx`: remove the "Record manual payment" button.
- Modify `src/sensor/SensorPage.tsx`: remove "Add 10 simulated arrivals" and its copy.
- Modify `src/moment/MomentPage.tsx`: remove simulate, the rehearsal badge, the toggle and the labels. Task 13 rewrites this page; here only remove what no longer compiles.
- Modify `src/book/checkout.tsx:104`: delete the simulated-payment sentence.
- Modify `src/book/BookPage.tsx:877`: label legacy rows "Legacy manual record".
- Modify `src/customer/NegotiationsPanel.tsx:43-56`: remove the simulated and rehearsal labels.
- Modify `convex/audience.ts`: `addArrivals` and `record` reject `source: "simulated"` with `INVALID_INPUT`.
- Test: `convex/liveAuction.test.ts`; update `convex/x402.test.ts` and `convex/lifecycle.test.ts` where they used `recordManual`, so they settle through the x402 test engine instead.

- [ ] **Step 1: Write the failing test** `"no simulated, rehearsal or manual path remains"`:
  - `api.payments.recordManual`, `api.moments.setRehearsalSettlement` and `api.moments.simulateCrowd` are undefined;
  - `api.audience.addArrivals` with `source: "simulated"` throws `INVALID_INPUT`;
  - `POST /demo-agents/x/webhook` is 404;
  - the module map from `convex/test.setup.ts` has no `demoAgents` key.
- [ ] **Step 2: Run** `npx vitest run convex/liveAuction.test.ts`. Expected: FAIL.
- [ ] **Step 3: Remove** everything listed under Files. Then search the repo: `grep -rn -i "rehears\|simulat\|recordManual\|demoAgents" convex src server --include=*.ts --include=*.tsx`. The only hits should be legacy schema comments, the `source === "simulated"` rejection, and history display of legacy rows.
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit:** `refactor: remove simulated crowds, scripted agents, rehearsal and manual payments`

### Task 9: Price history counts partial spots correctly

**Files:**
- Modify: `convex/lib/marketHistory.ts` (`recordSaleHistory` gains `coveredMs?: number`) and `convex/payments.ts:296`.
- Test: `convex/pricingHarness.test.ts`.

**Interfaces:**
- `recordSaleHistory(ctx, booking, kind, now, coveredMs?: number)`. When `coveredMs` is given and under `SLOT_MS`, `unitPriceMinor = round(amount × SLOT_MS / coveredMs / slotCount)`, the full-slot equivalent.
- In `applyVerifiedPayment`, find the moment by hold (index `by_hold`). If one exists, pass `coveredMs = spotEndAt − spotStartAt` and `kind: "auction"`. Also patch the moment's `paidMinor` (already done) and leave `impressions` alone, since Task 5 sets it.

- [ ] **Step 1: Write the failing test** `"a 5-minute live sale is recorded as its 15-minute equivalent"`. Record a booking of 100¢ with `coveredMs = 5 min` → `priceHistory.unitPriceMinor` is 300.
- [ ] **Step 2: Run** `npx vitest run convex/pricingHarness.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `fix: normalise partial-slot sales in price history`

### Task 10: Host controls: live pricing and the real event

**Files:**
- Modify: `convex/billboards.ts`. Add `setLivePricing`.
- Modify: `convex/events.ts`. Add a public `create`.
- Modify: `convex/schema.ts` (`eventSource`).
- Test: `convex/liveAuction.test.ts`.

**Interfaces:**
- `api.billboards.setLivePricing({ billboardId, minimumMinor: v.number(), cpmMinor: v.number() }) → null`:
  - workspace members only;
  - `minimumMinor` is an integer from 1 to `baseRateMinor`, and is written to `reserveFloorMinor`;
  - `cpmMinor` is an integer from 50 to 100000;
  - writes an audit event.
- `api.events.create({ billboardId, name: v.string(), startsAt: v.number(), endsAt: v.number(), audienceTags }) → { eventId }`:
  - workspace members only; reuses the internal insert path at `convex/events.ts:64`;
  - add the literal `"host"` to `eventSource` in `convex/schema.ts` and use it as the `source`;
  - announcing (Task 5) reads it through `liveEvents`.

- [ ] **Step 1: Write failing tests:**
  - `"host sets the published minimum and starting CPM"`: after `setLivePricing(30, 800)`, the next announcement's `floorMinor` is 30 and its `priceWhy` contains `"$8.00 per 1,000 views"`.
  - A customer calling it gets `FORBIDDEN`.
  - `"host enters the real event"`: `events.create` with tags `{ startups: 1 }` raises the next moment's best match.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run typecheck && npm test`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: host sets live pricing and enters the real event`

### Task 11: Advertiser agent setup and live feed (UI)

**Files:**
- Create: `src/customer/AgentSetupPanel.tsx`, `src/customer/AgentFeed.tsx`, `src/lib/segments.ts`.
- Modify: `src/customer/CustomerPage.tsx`. Add an "Agent" tab (`#/customer/agent`) and make it the first tab.

**Interfaces:**
- Consumes: `api.companyAgents.setup`, `setEnabled`, `mine`, `feed` and `requestTopUp`; `api.campaigns.list`.
- `src/lib/segments.ts` exports `SEGMENTS: { key: string; label: string }[]`:
  `[{startups,"Startup founders"},{software,"Developers"},{investors,"Investors"},{students,"Students"},{tourists,"Tourists"},{office,"Office workers"},{families,"Families"}]`.
  Selected chips become `targetAudience` with equal weights.

**Layout** (matches `.superpowers/brainstorm/*/content/advertiser-agent-setup.html`):
- **Setup panel, in four numbered sections:**
  1. Your ad: a campaign picker showing creative status and "approved by host" when it is ready.
  2. Ideal customer profile: chips.
  3. Reach target: a number, default 3.
  4. Spending limits: max per spot and daily budget in dollars; the wallet's short address and `balanceMinor` as USDC; a "Top up" button.
  Below them, a "Turn agent on" / "Turn agent off" button.
- **Feed panel:**
  - "Agent: ON/OFF" with today's spend as a bar against the daily budget;
  - a newest-first list from `feed`, with timestamps to 0.1 s;
  - colour per kind: you are blue, rivals amber, wins green;
  - a Basescan link when `txUrl` is set.

- [ ] **Step 1:** Implement both panels and the tab.
- [ ] **Step 2: Run** `npm run typecheck && npm run build`. Expected: PASS.
- [ ] **Step 3: Verify in the browser** against the dev deployment:
  - sign in as a customer, open `#/customer/agent`, set the four sections, and turn the agent on;
  - `mine` shows a wallet address within about 10 s if the CDP keys are set on dev; otherwise it shows "no CDP keys".
- [ ] **Step 4: Commit:** `feat: advertiser agent setup and live feed`

### Task 12: The display: three states, optional camera

**Files:**
- Modify: `convex/player.ts`. Add `screenState`.
- Modify: `src/player/PlayerPage.tsx`. Add the three states, and run the camera when `?camera=1`.
- Modify: `src/App.tsx:23`. Pass the query string through to the player route.

**Interfaces:**
- `api.player.screenState({ billboardId }) → { mode: "announce" | "auction" | "negotiation" | "playing" | "your_ad_here"; screenName: string; minutesLeft: number; peopleInView: number | null; eventName: string | null; openingMinor: number | null; minimumMinor: number | null; why: string | null; closesAt: number | null; ladder: { company: string; amountMinor: number; at: number; leading: boolean }[]; nowPlaying: null | { company: string; wonAtMinor: number; txShort: string | null; txUrl: string | null } }`.
  - It is public (the player is public). Company names appear on the ladder because the room sees them.
  - The mode comes from the latest moment on this screen:
    - `offering` → `announce`
    - `bidding` → `auction`
    - `negotiating` → `negotiation`
    - `paid` or `playing` within the spot → `playing`
    - otherwise → `your_ad_here`, with the last opening price.
- `PlayerPage`:
  - keeps today's creative playback and preloading for the `playing` state;
  - adds the strip "Sponsored · {company} · won at $X · paid on Base · {txShort}";
  - in the `auction` state shows a "LIVE AUCTION" badge, the ladder (leader highlighted) and a countdown to `closesAt` that visibly jumps when it extends;
  - with `?camera=1`, mounts `useArrivalCounter` (from `src/sensor/useArrivalCounter.ts`) and sends `api.audience.addArrivals` with `source: "camera"` every window, like `SensorPage.tsx:30-47`. A phone can then be both a screen and a camera. Sending needs a host sign-in; when signed out, show a small "sign in to count" note in a corner.

- [ ] **Step 1: Write a failing test** in `convex/liveAuction.test.ts`: `"screenState follows the moment: announce → auction (ladder) → playing"`. Assert `mode` and `ladder.length` at each phase of the Task 6 auction scenario.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the query, then the page.
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run build`. Expected: PASS. Then open `#/player/<id>?camera=1` on dev and confirm the camera counts arrive (`audience.recentForBillboard`).
- [ ] **Step 5: Commit:** `feat: display shows announce, live auction and playing states; optional camera`

### Task 13: Presenter page and host top-ups

**Files:**
- Modify: `convex/moments.ts` (the `live` query and `momentView`).
- Rewrite: `src/moment/MomentPage.tsx`.

**Interfaces:**
- `api.moments.live`:
  - adds `devices: { billboardId, name, online: boolean, peopleInView: number | null, mode: <screenState mode> }[]` for all workspace screens;
  - adds `queue: { billboardId, name, queuedAt }[]`;
  - adds to the current moment `valueMinor`, `priceWhy`, `bids` (`momentBids` rows with company names), `extensions` and `biddingClosesAt`;
  - drops the rehearsal fields.
- **The page, top to bottom:**
  1. Device list and queue.
  2. The stopwatch from detection to first frame.
  3. Price reasoning (`priceWhy`).
  4. Timeline of joins, bids, counters, award and payment, timestamped to 0.1 s.
  5. Payment card: Basescan link, or "Payment blocked: {reason}".
  6. A settings panel (`minPeopleInView`, `joinWindowSeconds`, `minMatch`).
  7. Live pricing (`setLivePricing`) and "Add event" (`events.create`).
  8. A "Top up a company" control: a list of companies with `companyAgents` rows, wallet balance, and a button that calls `api.companyAgents.requestTopUp` on the host's behalf. Add a host variant `api.companyAgents.hostTopUp({ advertiserId })` with the same daily limit, restricted to workspace members.

- [ ] **Step 1: Write a failing test:** `"presenter view lists devices, queue and bids"`. During the Task 6 auction with Phone queued, `live` returns 2 devices, a queue of length 1, and bids of length at least 2.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the query, `hostTopUp` and the page.
- [ ] **Step 4: Run** `npm run typecheck && npm test && npm run build`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat: presenter page with devices, queue, bids and top-ups`

### Task 14: Docs, environment and production runbook

**Files:**
- Modify `README.md` ("What's real and what's simulated" table, dev commands).
- Rewrite `docs/demo/live-moment-runbook.md`.
- Modify `.env.example`: drop `AUCTION_*` and `BUYER_AGENT_KEY` from the demo section, and add `COMPANY_AGENT_DELAY_MS` (tests only).
- Modify `docs/architecture/agent-api.md`: the bid route and the new webhook events.

The runbook must contain, in order:
1. Production deploy:
   - `npx convex deploy`;
   - `npx convex env set --prod` for `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`, `X402_PAY_TO`, `INTERNAL_API_SECRET` (`openssl rand -hex 32`), `X402_NETWORK=eip155:84532` and `SITE_URL`;
   - `npm run deploy:prod`.
2. Phong signs up first, which makes Phong the operator. Then create the workspace, add screens "LED" and "Phone", set live pricing (minimum $0.25, CPM $5), and add the real event.
3. Two advertisers sign up, upload ads and set up their agents. The host approves the ads.
4. Fund the operator wallet: the ETH and USDC faucets for `X402_PAY_TO`. Top up each company.
5. Devices:
   - LED laptop: `#/player/<LED>?camera=1`;
   - phone: `#/player/<Phone>?camera=1`;
   - presenter: `#/moment`;
   - advertiser laptops: `#/customer/agent`.
6. Run: stand in front of the LED camera. Expected: an auction, then the phone's sale.
7. The faucet limit is 10 USDC per day per project. Recycle money with the top-up.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2: Run** `npm run typecheck && npm test && npm run build`. Expected: PASS.
- [ ] **Step 3: Commit:** `docs: real-usage live auction runbook and agent API`
