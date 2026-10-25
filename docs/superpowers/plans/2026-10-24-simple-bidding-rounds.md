# Simple Bidding Rounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live-moment sale with a five-stage round (start → price → invite → bid → close, then pay → play) that always reaches an outcome within seconds, whatever data exists.

**Architecture:**
- **Pure rules** in `convex/lib/rounds.ts`: price signals, asking price, bid strategy, close outcome.
- **Stages** in `convex/rounds.ts`: Convex internal mutations, plus public queries and mutations for the presenter and advertisers.
- **Webhooks** in `convex/roundDelivery.ts`. Agents answer over `POST /api/agent/rounds/{id}/bid`.
- **Reused as is:** quotes, `takeHold`, the x402 purchase route, `companyAgentsNode.pay` and booking conversion.
- **Switched to rounds:** the player's `screenState` and the presenter page, which read rounds instead of moments.

**Tech Stack:** Convex 1.44 (TypeScript), convex-test + Vitest, React + Tailwind.

**Spec:** `docs/superpowers/specs/2026-10-24-simple-bidding-rounds-design.md`

## Global Constraints

- Read `convex/_generated/ai/guidelines.md` before touching `convex/`. Every query is bounded with `.take(n)` or `.withIndex`; there's no `.collect()` and no `.filter()` on unbounded tables.
- Money is integer cents (`…Minor`), USD.
- `ROUND_CLOSE_MS = 5_000`; `CAMERA_COOLDOWN_MS = 60_000`; `AUTO_SELL_GAP_MS = 120_000`; `PAY_WINDOW_MS = 60_000` (reuse from `lib/moment`); `MAX_INVITES = 20`; `DEFAULT_USUAL_IN_VIEW = 3`; `CROWD_MAX = 3`; `EVENT_FACTOR = 1.2`.
- Floor = `billboard.reserveFloorMinor`. No bid below the floor counts.
- Shown as paid only with a 0x…64-hex settlement transaction hash (`isTxHash` in `lib/momentHooks.ts`).
- Every round ends with an `outcome` sentence. There's a scheduled hard close at `closesAt`, and closing is idempotent.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Two agents answer in the same instant**, so both `submitBid` calls see "all answered". `closeRound` must be idempotent: the second call is a no-op once `status !== "bidding"`. Test: `closeRound` called twice → one hold, one `round_won` delivery.
2. **The spot is sold between invitation and close** (for example by `sellNow` from the autopilot), so `takeHold` throws `SLOT_UNAVAILABLE`. The round must end `unsold` with "Spot was sold elsewhere", not hang in `bidding`. Test in Task 4.
3. **An agent bids after the round closed**: `ROUND_CLOSED` error, and nothing changes. Test in Task 2.
4. **The winner's key was revoked between bid and award** (the agent was reconfigured). Skip to the next bid at that bid's own amount. Test in Task 4.
5. **The camera fires a burst of arrivals**: only one round, enforced by the open-round check plus the cooldown. Test in Task 5 (S10).

---

### Task 1: Pure round rules

**Files:**
- Create: `convex/lib/rounds.ts`
- Test: `convex/roundsRules.test.ts`

**Interfaces:**
- Produces:
  - the constants above;
  - `type PriceSignal = { key: "crowd" | "event"; factor: number | null; reason: string }`
  - `priceSignals(i: { peakInView: number | null; usualInView: number | undefined; eventName: string | null }): PriceSignal[]`. Always returns both keys, in the order crowd, event; `factor: null` when the data is missing.
  - `askingPrice(floorMinor: number, signals: PriceSignal[]): number`: floor × the product of the non-null factors, `Math.round`.
  - `type BidContext = { floorMinor: number; askingMinor: number; match: number | null; crowd: number | null; maxPerSpotMinor: number; budgetLeftMinor: number; balanceMinor: number | null }`
  - `type BidDecision = { amountMinor: number | null; reasoning: string }`
  - `type BidStrategy = (c: BidContext) => BidDecision`
  - `ruleBasedStrategy: BidStrategy`
  - `type ClosingBid = { id: string; amountMinor: number; answeredAt: number }`
  - `closeOutcome(bids: ClosingBid[], askingMinor: number, floorMinor: number): { kind: "unsold" } | { kind: "sold"; winnerId: string; runnerUpId: string | null; priceMinor: number }`

- [ ] **Step 1: Write the failing tests** in `convex/roundsRules.test.ts`:

```ts
test("signals: missing data is listed, never blocks", () => {
  const s = priceSignals({ peakInView: null, usualInView: undefined, eventName: null });
  expect(s.map((x) => [x.key, x.factor])).toEqual([["crowd", null], ["event", null]]);
  expect(s[0].reason).toMatch(/no camera/i);
  expect(askingPrice(100, s)).toBe(100);
});
test("crowd: in view now ÷ usual, clamped 1×–3×; event 1.2×", () => {
  expect(priceSignals({ peakInView: 6, usualInView: undefined, eventName: null })[0].factor).toBe(2);
  expect(priceSignals({ peakInView: 1, usualInView: 3, eventName: null })[0].factor).toBe(1);
  expect(priceSignals({ peakInView: 30, usualInView: 3, eventName: null })[0].factor).toBe(3);
  const s = priceSignals({ peakInView: 6, usualInView: 3, eventName: "Demo Day" });
  expect(askingPrice(100, s)).toBe(240);
});
test("rule-based agent: worth = asking × (0.8 + 0.7 × match), capped, null match = 0.5", () => {
  const c = { floorMinor: 100, askingMinor: 200, match: null, crowd: null, maxPerSpotMinor: 1000, budgetLeftMinor: 1000, balanceMinor: 1000 };
  expect(ruleBasedStrategy(c).amountMinor).toBe(230);
  expect(ruleBasedStrategy({ ...c, match: 1 }).amountMinor).toBe(300);
  expect(ruleBasedStrategy({ ...c, maxPerSpotMinor: 150 }).amountMinor).toBe(150); // below asking, above floor: still bids
  expect(ruleBasedStrategy({ ...c, maxPerSpotMinor: 50 })).toMatchObject({ amountMinor: null, reasoning: expect.stringMatching(/floor/) });
  expect(ruleBasedStrategy({ ...c, balanceMinor: null })).toMatchObject({ amountMinor: null, reasoning: expect.stringMatching(/wallet/i) });
});
test("close: 0 unsold; 1 pays min(bid, asking); 2+ second price +1¢, within [floor, own bid]; tie → earlier", () => {
  expect(closeOutcome([], 200, 100)).toEqual({ kind: "unsold" });
  expect(closeOutcome([{ id: "a", amountMinor: 150, answeredAt: 1 }], 200, 100)).toEqual({ kind: "sold", winnerId: "a", runnerUpId: null, priceMinor: 150 });
  expect(closeOutcome([{ id: "a", amountMinor: 300, answeredAt: 1 }], 200, 100).priceMinor).toBe(200);
  const two = closeOutcome([{ id: "a", amountMinor: 300, answeredAt: 2 }, { id: "b", amountMinor: 180, answeredAt: 1 }], 200, 100);
  expect(two).toEqual({ kind: "sold", winnerId: "a", runnerUpId: "b", priceMinor: 181 });
  expect(closeOutcome([{ id: "a", amountMinor: 200, answeredAt: 2 }, { id: "b", amountMinor: 200, answeredAt: 1 }], 200, 100))
    .toMatchObject({ winnerId: "b", priceMinor: 200 });
});
```

- [ ] **Step 2: Run** `npx vitest run convex/roundsRules.test.ts`. Expected: FAIL, because the module isn't there yet.
- [ ] **Step 3: Implement `convex/lib/rounds.ts`**:
  - Each reason is one plain sentence: "6 people in view, usually 3: ×2.00", "No camera: crowd not counted", "Demo Day on now: ×1.20", "No event".
  - The strategy's reasoning names worth, match % (or "match unknown"), and the limit that capped it.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: pure rules for simple bidding rounds`.

### Task 2: Rounds tables, start, invite, bid, close (server only)

**Files:**
- Create: `convex/schemaParts/rounds.ts`, `convex/rounds.ts`
- Modify: `convex/schema.ts`. Spread `roundTables`, and add the audit literals `round.started`, `round.awarded`, `round.paid`, `round.unsold`. Add `usualInView: v.optional(v.number())` to `billboardFields` and `autoSellRounds: v.optional(v.boolean())` to the workspace fields.
- Test: `convex/rounds.test.ts`. Build the world helper by copying the setup pattern in `convex/liveAuction.test.ts`: a host workspace, a billboard with slots, two companies, each with an approved campaign and an agent key that has a webhook, standing limits and the `bid` and `pay` scopes. Stub `fetch` to accept webhooks.

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - **Tables:**
    - `rounds`: `workspaceId, billboardId, slotId, spotStartAt, spotEndAt, trigger ("camera"|"sell_now"|"timer"), status ("bidding"|"awarded"|"paid"|"unsold"), floorMinor, askingMinor, signals: PriceSignal[], crowd: number|null, invitedCount, closesAt, closedAt?, winnerBidId?, runnerUpBidId?, priceMinor?, holdId?, paymentTx?, paymentNetwork?, outcome?, createdAt`. Indexes: `by_billboard_and_createdAt`, `by_workspace_and_createdAt`, `by_hold`.
    - `roundBids`: `roundId, advertiserId, campaignId, agentKeyId, match: number|null, amountMinor: number|null, reasoning?, answeredAt?, status ("invited"|"bid"|"passed"|"won"|"lost"|"defaulted")`. Indexes: `by_round`, `by_advertiser_and_round`.
  - **`startRoundCore(ctx: MutationCtx, billboardId, trigger): Promise<Id<"rounds"> | null>`.** Returns null when:
    - the screen isn't found;
    - there's an open round (`bidding`/`awarded`) on the screen;
    - the trigger is `camera` and the last round ended less than 60 s ago;
    - there's no on-air spot (spot rule in the spec §1).

    Otherwise it inserts the round, invites, and schedules `internal.rounds.closeRound` at `closesAt`. With 0 invited, it closes immediately as unsold with "No company agents with an approved ad and budget."
  - **`submitBid` internal mutation** `{ token: string, roundId: string, amountMinor: number | null, reasoning?: string }` → `{ status: "bid" | "passed" }`.
    - Errors: `NOT_FOUND`, `NOT_INVITED`, `ROUND_CLOSED`, `BELOW_FLOOR`, `OVER_LIMIT` (`replyAllowed` + `assertWithinBudget`).
    - Answering again replaces the earlier answer.
    - When every invited bid is answered, it calls `closeRoundCore`.
  - **`closeRound` internal mutation** `{ roundId }` and **`closeRoundCore(ctx, roundId)`**:
    - Idempotent.
    - Unsold: patches `status`, `closedAt`, `outcome`. The outcome lists the pass reasons.
    - Sold: calls `awardCore(ctx, round, bidId, priceMinor)`. Task 4 implements it; in this task it only patches `status: "awarded"`, `winnerBidId`, `runnerUpBidId`, `priceMinor` and `outcome`.

- [ ] **Step 1: Write the failing tests:**
  - **S1:** two bids, 300 and 180 → awarded at 181; the winner is the 300 bidder.
  - **S2:** one invited → it bids 150 → awarded immediately (no timer advance), price `min(150, asking)`.
  - **S3:** no qualifying company → `unsold` at start, with the outcome text above.
  - **S4:** both pass → unsold; the outcome contains both reasons.
  - **S6:** billboard without `audienceTags` → the bid row has `match: null` and is still invited.
  - **S7:** one answers, the clock advances 5 s, the scheduled close fires → awarded to the one who answered.
  - **S10 (part):** a second `startRoundCore` while one is open → `null`.
  - **S11:** bid over `maxPricePerSpotMinor` → `OVER_LIMIT`; a later valid bid is accepted.
  - **Review Focus 1:** `closeRoundCore` twice → same result, one award.
  - **Review Focus 3:** a bid after close → `ROUND_CLOSED`.
- [ ] **Step 2: Run** `npx vitest run convex/rounds.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Invite selection** (spec §3): the built-in agent key first (`companyAgents` row enabled), else the newest active key with a webhook and the `bid`+`pay` scopes.
    - Campaign: the built-in agent's campaign if `creativeReady` on this workspace, else the newest ready one the key may act for.
    - Budget left: `standing.dailyBudgetMinor − spentTodayForAdvertiserMinor > 0`.
    - Candidate companies come from `creativeApprovals` `by_workspace_and_campaign` for this workspace (bounded `.take(100)`), as `autopilot.loadCompanies` does.
    - Match: `campaignFit` / `matchScore` from `lib/match` when both the screen and the campaign have tags, else `null`.
  - **Crowd:** `peakInView` of the `audienceAggregates` row at the current 15-minute `bucketStart` (index `by_billboard_and_bucketStart`).
  - **Event:** the screen's current event, as `moments.detectCore` finds it.
  - **Delivery:** schedules `internal.roundDelivery.deliver({ bidId, event: "round_offer" })` per bid. Task 3 creates `roundDelivery`. Until then, add a stub `deliver` internal action that returns null.
- [ ] **Step 4: Run** the tests. Expected: PASS. Then run `npx vitest run` to confirm the suite is still green.
- [ ] **Step 5: Commit** `feat: bidding rounds start, invite, sealed bids and quick close`.

### Task 3: Agents talk to rounds (webhooks, HTTP, built-in agent)

**Files:**
- Create or replace: `convex/roundDelivery.ts`. Mirror `momentDelivery.ts`: `loadForDelivery` query → signed POST with 2 attempts → `recordDelivery`.
- Modify: `convex/http.ts`. Inside the existing `/api/agent/` POST handler, before the 404, add `/^rounds\/([^/]+)\/bid$/`:
  - `amountMinor` is a number or `null`, read via the existing `num`/`str` helpers; `null` or missing means pass;
  - it calls `internal.rounds.submitBid`.
- Modify: `convex/companyAgentsAct.ts`:
  - `round_offer` → `ruleBasedStrategy` with `{ floorMinor, askingMinor, match: payload.audienceMatch ?? null, crowd, maxPerSpotMinor: standing.maxPricePerSpotMinor, budgetLeftMinor: standing.dailyBudgetMinor − me.spentTodayMinor, balanceMinor: me.balanceMinor }` → POST `links.bid` with `{ amountMinor, reasoning }` → log;
  - `round_won` → schedule `companyAgentsNode.pay` (same payload fields as `flash_won`: `holdId`, `amountMinor`, `purchaseUrl`);
  - `round_lost` → log.
- Modify: `convex/lib/companyAgent.ts` `AgentPayload`. Add `roundId`, `floorMinor`, `askingMinor`, `crowd`, and `links.bid`, which is already there.
- Test: extend `convex/rounds.test.ts`.

**Interfaces:**
- Consumes: Task 2 (`submitBid`, `roundBids`).
- Produces:
  - **Webhook events:** `"round_offer" | "round_won" | "round_lost"`, with header `X-BillboardOS-Event`.
  - **`round_offer` payload:** `{ type, roundId, advertiserId, campaignId, screen: { billboardId, name, locationLabel }, spotEndAt, floorMinor, askingMinor, signals, crowd, audienceMatch, closesAt, standingInstructions, links: { base, bid: "/api/agent/rounds/{roundId}/bid" } }`
  - **`round_won` payload:** `{ type, roundId, holdId, amountMinor, payBy, purchaseUrl: "{site}/a2a/hosts/{workspaceId}/purchases/{holdId}" }`

- [ ] **Step 1: Write the failing tests:**
  - **S9:** the stubbed fetch receives a signed `round_offer` for each invited key, with `links.bid` set. An HTTP `POST /api/agent/rounds/{id}/bid` through `t.fetch` with a bearer key → `{ status: "bid" }`.
  - A `null` body amount → `passed`.
  - The built-in handler: `companyAgentsAct.act` with a `round_offer` payload and `fetch` stubbed to capture the POST → the body is `{ amountMinor: 230, reasoning: … }` for asking 200, match null and generous limits.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** as described.
- [ ] **Step 4: Run** `npx vitest run`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: agents get round offers by webhook and bid over the agent API`.

### Task 4: Award, pay, runner-up

**Files:**
- Modify: `convex/rounds.ts`:
  - `awardCore`;
  - `payDeadline` internal mutation;
  - `paymentFailed` internal mutation `{ holdId, reason }`.
- Create: `convex/lib/roundHooks.ts`, with `onRoundPaid(ctx, holdId, bookingId, payment)`, which mirrors `onMomentPaid` without the moment-only parts.
- Modify: `convex/payments.ts:312`. Call `onRoundPaid` next to `onMomentPaid`. At `:295`, treat a round found `by_hold` like `liveMoment` (booking kind `"auction"`, duration `spotEndAt − spotStartAt`).
- Modify: `convex/companyAgentsNode.ts` `pay` → `blocked()` also runs `internal.rounds.paymentFailed`.
- Test: `convex/rounds.test.ts`.

**Interfaces:**
- **`awardCore(ctx, round, bidId, priceMinor): Promise<boolean>`**:
  - quote + `takeHold`, as `liveAuction.award` does: `inProgressMinRemainingMs: 60_000`, `ttlMs: 3 * 60_000`, idempotency key `round:${roundId}:${bidId}`;
  - patches the round to `awarded` with `holdId`;
  - bid statuses: winner `won`, others `lost`;
  - delivers `round_won` and `round_lost`;
  - schedules `payDeadline` at +`PAY_WINDOW_MS`;
  - returns false when the key is inactive (try the next bid).
- **`payDeadline({ roundId })`**:
  - paid → no-op;
  - hold active and `lockHeld(ctx, holdLockKey(hold))` → recheck in 20 s while `hold.expiresAt` hasn't passed;
  - otherwise default.
- **Default:**
  - release the hold (`endHold … "released"`);
  - mark the bid `defaulted`;
  - award the runner-up **at its own bid**;
  - if there's no runner-up, end `unsold` with "Payment failed: {reason}".
- **`onRoundPaid`:** `status: "paid"`, `paymentTx` only when `isTxHash`, `paymentNetwork`, outcome "Paid $X over x402".

- [ ] **Step 1: Write the failing tests:**
  - **S8:** `paymentFailed` for the winner's hold → the runner-up is awarded at its own bid; with no runner-up → `unsold`, and the outcome starts with "Payment failed".
  - The pay deadline passes with the hold still active and no lock → same as S8.
  - Settling a payment with a 0x… hash through the existing x402 settle path used in `liveAuction.test.ts` → round `paid`, `paymentTx` set, a booking exists for the slot.
  - **Review Focus 2:** the slot is booked before close → `unsold`, "Spot was sold elsewhere".
  - **Review Focus 4:** the winner's key is revoked before close → the runner-up wins.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: round winner pays over x402; runner-up on default`.

### Task 5: Triggers (camera, Sell now, auto-sell) and cutover

**Files:**
- Modify: `convex/audience.ts:69` and `:145`. Replace `scheduleDetect(ctx, billboardId, "arrivals")` with `await startRoundCore(ctx, billboardId, "camera")`.
- Modify: `convex/events.ts:60`. Replace it with `startRoundCore(ctx, billboardId, "camera")`.
- Modify: `convex/rounds.ts`:
  - `sellNow` mutation `{ billboardId }`: workspace member; ignores the cooldown; returns `{ roundId: Id<"rounds"> | null, reason: string | null }`.
  - `setAutoSell` mutation `{ enabled: boolean }`: owner or operator of the active workspace.
  - `autoSellTick` internal mutation: for workspaces with `autoSellRounds`, each `online` screen whose last round started more than `AUTO_SELL_GAP_MS` ago → `startRoundCore(…, "timer")`. Bounded: 50 workspaces, 20 screens each.
- Modify: `convex/crons.ts`. Add `crons.interval("auto-sell rounds", { minutes: 1 }, internal.rounds.autoSellTick, {})`.
- Test: `convex/rounds.test.ts`.

- [ ] **Step 1: Write the failing tests:**
  - **S5:** an audience reading with `peakInView: 6` in the current bucket → the round's crowd signal factor is 2 and the asking price is 2× the floor; an agent with max per spot below the asking price still wins.
  - **S10:** a camera trigger within 60 s of a round ending → no round; `sellNow` at the same moment → a round.
  - **S12:** `autoSellTick` with the toggle off → no rounds; on → one per online screen; run again 1 min later → none.
  - **Review Focus 5:** three camera arrivals in a row → exactly one round.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Leave `moments.ts` untouched apart from the unused import cleanup the typechecker asks for.
- [ ] **Step 4: Run** `npx vitest run`. Old live-moment tests that drive `scheduleDetect` through `audience.ts` may now fail. Repoint each one at `internal.moments.detectFor` directly; that keeps them as tests of the dormant code. Expected: all PASS.
- [ ] **Step 5: Commit** `feat: camera, sell-now and auto-sell start bidding rounds`.

### Task 6: Screens and pages show rounds

**Files:**
- Modify: `convex/player.ts` `screenState`. Build the existing return shape from the latest round of the billboard (`by_billboard_and_createdAt`, desc, first):
  - `bidding` → `mode: "auction"`, `ladder` from `roundBids` with `status: "bid"`, `closesAt`, `openingMinor: askingMinor`, `minimumMinor: floorMinor`, `why`: the signal reasons joined with " · ", `peopleInView: crowd`;
  - `awarded` → `"settling"`;
  - `paid` → `"playing"` with `nowPlaying` (company, `wonAtMinor: priceMinor`, tx short and URL via `explorerTxUrl`, the creative, as the moment branch builds it today);
  - `unsold` or none → `"your_ad_here"`.

  `PlayerPage.tsx` stays unchanged.
- Modify: `convex/rounds.ts`:
  - `live` query `{ workspaceId?: Id<"workspaces"> }` → `{ autoSell: boolean; screens: { billboardId, name, online, round: RoundView | null }[] }`. `RoundView` is the round fields plus `bids: { company, amountMinor, reasoning, status }[]`.
  - `myRounds` query `{ limit?: number }` → the company's last 10 `roundBids` with screen name, round status, outcome, its amount, reasoning and status.
- Create: `src/moment/RoundsPanel.tsx`. Per screen:
  - a **Sell now** button;
  - the latest round: floor, asking and signal reasons, the bids as they arrive (company, amount or "passed", reasoning), a countdown to `closesAt`, the outcome, and the tx link.

  At the top: the **Auto-sell when idle** toggle.
- Modify: `src/moment/MomentPage.tsx`. Render `RoundsPanel` in place of `MomentStage`/`Waiting`/`History`. Keep `Devices`, `EventPanel`, `PricingPanel` and `TopUpPanel`.
- Modify: `src/customer/AgentFeed.tsx`. Add a "Rounds" list from `rounds.myRounds` above the existing feed.
- Test: `convex/rounds.test.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `player.screenState` during bidding → `mode: "auction"` with 2 ladder rows; after paid with a tx hash → `"playing"` with `nowPlaying.creative.provider` `"youtube"` for a YouTube campaign;
  - `rounds.live` returns the bids with reasoning;
  - `myRounds` only returns the caller's company rows.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the queries, then the two UI components.
- [ ] **Step 4: Verify.** Run `npx vitest run` and `npm run typecheck`, and `npm run build` must succeed.
- [ ] **Step 5: Commit** `feat: player, presenter and advertiser feed show bidding rounds`.

### Task 7: Ship to the dev deployment and write the demo script

**Files:**
- Create: `docs/demo/bidding-rounds-runbook.md`. The two-device script:
  1. host signs in first and opens `#/player/<id>` (camera optional);
  2. two marketers paste their videos and set $5 a day;
  3. the host tops up both wallets on `#/moment`;
  4. Sell now → bids appear with reasons → winner pays → video plays.

  Add a "what each outcome means" table, mapping each outcome sentence to its fix.

- [ ] **Step 1: Deploy.** Run `npx convex dev --once`, then `npm run deploy:web`. Expected: "Convex functions ready" and "Upload complete".
- [ ] **Step 2: Smoke test.** Run `npx convex run rounds:autoSellTick` on dev. Expected: no error. Check `npx convex data rounds --limit 3`.
- [ ] **Step 3: Commit** `docs: bidding rounds demo runbook`, and push the branch.
