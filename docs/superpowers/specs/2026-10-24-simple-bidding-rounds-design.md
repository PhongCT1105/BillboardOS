# Simple bidding rounds: a sale that always runs

**Date:** 2026-10-24
**Status:** Ready for approval
**Replaces, on the demo path:** the live moment in [ADR 0006](../../decisions/0006-live-moment-30-seconds.md) and the [live auction design](2026-10-24-live-auction-real-usage-design.md) (`convex/moments.ts`, `convex/liveAuction.ts`)

## Why

In the proof of concept, a sale never finished on the website. The current live sale chains about ten hard gates, and any one of them silently stops it:

- a camera count above the screen's target;
- a non-empty screen audience profile;
- an audience match of at least 30%;
- a reach target;
- a known wallet balance;
- a 2 s join window;
- an ascending auction with extensions;
- negotiation and counters;
- re-offers;
- a one-auction-per-host queue.

In testing:
- a screen created before the starter-audience fix had no profile, so every company matched 0% and every agent passed;
- with no camera connected, no sale ever started.

The team wants the core loop to work first: **agents get an offer, reason, bid, and the deal closes quickly**. Camera and audience data only make the price smarter. They never decide whether a sale happens.

## Goals

1. **One clear pipeline.** A round runs through five named stages: start, price, invite, bid, close. Payment and playback follow. Each stage is a small, separately tested function.
2. **Every signal is optional.** Missing camera data, a missing audience profile or a missing knowledge card falls back to a neutral default and is said so in the reasoning. Nothing blocks.
3. **Quick close.** A round closes as soon as every invited agent has answered, or after 5 s at most. With one bidder or none, it doesn't wait.
4. **Real agent interaction.** Agents get a signed webhook and answer over the public agent API, as today. The built-in company agents and any external agent use the same path.
5. **Easy to extend.** Price signals and agent bidding strategies are plug-ins: a list of functions and an interface. A Claude bidding strategy, new price signals or a richer auction can be added later without touching the pipeline.
6. **Clear test scenarios.** The scenarios below are fixed, and each one is an automated test.

## Non-goals (for this step)

- The 12-hour forward autopilot (ADR 0007 §1) and advertiser forward booking. They stay as they are and are untouched.
- Negotiation, counter-offers, multi-round ascending bidding, bid extensions and the cross-screen queue.
- Claude deciding bids. The strategy interface allows it later.
- Removing the old moment code. The demo path stops calling it; deleting it is a later cleanup.

## Anti-goals (failure even if it "works")

- A sale that silently doesn't happen. Every round ends in an outcome with a sentence explaining it: sold, unsold or payment failed.
- An ad shown as paid without a settlement transaction hash. The honesty rule from ADR 0006 stays.
- A round that can stay open. Every round has a hard end.
- Hidden behavior: the presenter page shows every price factor and every bid with its reason.

## The pipeline

```
start → price → invite → bid → close → pay → play
```

### 1. Start

A round sells **only the spot on air now**: the rest of the current slot if it has at least 3 minutes left and is available, otherwise the next slot if it starts within 3 minutes and is available. If neither qualifies (sold, or nothing starting soon), the trigger does nothing. Rounds never sell further ahead, so they don't overlap the 12-hour autopilot.

Three triggers:

- **Camera:** new arrivals on a screen with a camera. This replaces `scheduleDetect` in `audience.ts`. There's no crowd threshold, but there's a **60 s cooldown** per screen after a round ends, so a steady stream of arrivals doesn't restart rounds back to back.
- **Sell now:** the host presses "Sell now" for a screen on the presenter page (`#/moment`). It ignores the cooldown.
- **Auto-sell when idle:** a cron every minute starts a round on each online screen of a workspace that turned it on. It's **off by default**, with a toggle on the presenter page. Each screen gets at most one round per 2 minutes. It's off by default because every sale spends real testnet USDC, and the faucet gives the whole project about 10 USDC a day.

Rules:
- One open round per screen at a time. Other screens are independent; there's no host-wide queue.
- A trigger that hits a screen with an open round, or that's within the camera cooldown, does nothing.
- Only **online** screens get auto-sell rounds (the player heartbeat already sets `deviceStatus`).

### 2. Price: the asking price, from optional signals

There are two numbers:

- **Floor:** the least the host accepts. It's the screen's existing `reserveFloorMinor` ($1.00 on a new starter screen); no new field. **No bid below the floor counts.**
- **Asking price:** `asking = floor × Π(signal factors)`, rounded to cents. It's what the host thinks the spot is worth right now. Agents use it to value the spot, but they may bid anywhere from the floor up. Signals therefore make the price stronger without ever making a sale impossible.

**Signals:** an ordered list of pure functions. Each returns `{ factor, reason }`, or `null` when its data is missing. A missing signal is listed, for example "no camera: crowd not counted", so the omission is visible.

- **Crowd:** `peakInView` of the screen's **current** 15-minute audience bucket (the `audienceAggregates` row whose `bucketStart` is the current bucket), divided by the screen's usual number of people in view. That's a new optional field, `usualInView`, defaulting to 3. The factor is clamped to 1×–3×. No row for the current bucket → `null`. Old fields such as `audienceBaselinePerBucket` keep their meaning; `pricing.ts` and `autopilot.ts` are untouched.
- **Event:** a current host-entered event → 1.2×. None → `null`.

The result and every reason are stored on the round. Adding a signal later means adding one function to the list.

### 3. Invite

Invited: every company that has **all** of these:
- an enabled company agent, or an active agent key with a webhook and the `bid` and `pay` scopes;
- an active campaign whose ad is ready on this host (`creativeReady`);
- daily budget left.

**One key and one campaign per company:**
- **Key:** the company's built-in agent key if the agent is enabled; otherwise its newest active key with a webhook and those scopes.
- **Campaign:** the built-in agent's campaign if it's ready on this host; otherwise the company's newest ready campaign that the chosen key may act for.

The chosen key's limits, webhook and campaign are fixed on the `roundBids` row at invitation time. That campaign's ad is what plays.

Each invitation carries:
- screen name and location;
- slot end time;
- the floor and the asking price;
- the price reasons;
- the crowd count (or `null`);
- the company's **audience match**, computed as today but `null` when the screen or the company has no profile;
- the close time;
- a `bid` link.

If nobody qualifies, the round ends **unsold** right away with the reason: "No company agents with an approved ad and budget."

### 4. Bid: one sealed answer per agent

- Each agent answers once with `POST /api/agent/rounds/{roundId}/bid`, body `{ amountMinor | null, reasoning }`. `null` means pass. A second answer replaces the first until the round closes.
- The server checks each bid against the key's standing limits:
  - per-spot max;
  - daily budget left;
  - `assertWithinBudget`.

  A bid over a limit is rejected with a clear error, and the agent may answer again.
- A bid below the floor is rejected.

**Built-in company agents** use a `BidStrategy`: a pure function from an invitation plus company context to `{ amountMinor | null, reasoning }`.

The first strategy is **rule-based**:
- **Worth to me** = `asking × (0.8 + 0.7 × match)`. When match is `null`, use 0.5, which gives 1.15× the asking price.
- **Bid** = the lowest of: worth to me, max per spot, budget left today, wallet balance.
- **Pass** if the bid is below the floor, or if the wallet balance has never been read. Each pass gives its reason.
- The reasoning is one sentence, for example: "Worth $0.92 to me (72% audience match, 12 people); bidding $0.92, within my $1.50 limit."

The built-in agents answer from the existing V8 fast path (`companyAgentsAct.ts`), with no artificial delay, so a round with only built-in agents closes in about a second.

### 5. Close

The round closes at the **earlier** of: every invited agent has answered, or 5 s after the invitations went out (`ROUND_CLOSE_MS = 5_000`). A scheduled `closeRound` at the deadline is the hard end; closing is idempotent.

| Valid bids at close | Outcome |
|---|---|
| 0 | **Unsold**, with every agent's pass reason. There's no reprice: agents already bid down to the floor if they can, so a lower asking price wouldn't produce a bid. |
| 1 | That company **wins at its bid or the asking price, whichever is lower** (never below the floor). |
| 2+ | The highest bid wins and **pays the runner-up's bid plus $0.01**, never more than its own bid and never less than the floor (second price). A tie goes to the earlier bid. |

The winner gets a hold at the price it pays. The existing `takeHold` with `inProgressMinRemainingMs` covers the rest of the current slot, as the live moment does today.

### 6. Pay

- The winner's agent gets a `round_won` webhook with the x402 purchase URL. Built-in agents pay with `companyAgentsNode.pay`, the existing CDP wallet and x402 route.
- **Pay deadline: 60 s.** Reuse the "still settling" recheck from `liveAuction.payDeadline` so a payment that's in flight is never charged twice.
- If the payment fails or the deadline passes, the **runner-up** gets the spot at its own bid. If there's no runner-up, the round ends **unsold (payment failed)** with the reason.

### 7. Play

A paid hold becomes a booking through the existing payment conversion. The player then plays the creative (file or YouTube), as it does today for paid live spots.

## Data

The new tables live in `convex/schemaParts/rounds.ts`.

**`rounds`:** one per round.
- `workspaceId`, `billboardId`, `slotId`
- `trigger`: `"camera" | "sell_now" | "timer"`
- `status`: `"bidding" | "awarded" | "paid" | "unsold"`
- `floorMinor`, `askingMinor`
- `signals`: array of `{ key, factor | null, reason }`
- `crowd`: `number | null`
- `invitedCount`, `closesAt`, `closedAt`
- `winnerBidId`, `runnerUpBidId`, `priceMinor`, `holdId`, `paymentTx`
- `outcome`: a sentence
- `createdAt`

Indexes:
- `by_billboard_and_createdAt`: the latest round per screen, and "one open round".
- `by_workspace_and_createdAt`: the presenter page.

**`roundBids`:** one per invited company.
- `roundId`, `advertiserId`, `campaignId`, `agentKeyId`
- `match`: `number | null`
- `amountMinor`: `number | null`
- `reasoning`, `answeredAt`
- `status`: `"invited" | "bid" | "passed" | "rejected" | "won" | "lost"`

Index: `by_round`. At most 20 invitations per round; that bounds every read.

The old `moments` and `flashOffers` tables stay but aren't written on the demo path.

## Code layout

- **`convex/lib/rounds.ts`:** everything that decides, as pure functions with no Convex calls:
  - `priceSignals` (the list);
  - `askingPrice`;
  - `ruleBasedStrategy`, which implements `BidStrategy`;
  - `closeOutcome(bids, asking, floor)`;
  - `secondPrice`.
- **`convex/rounds.ts`:** the stages as internal mutations, plus the public queries and mutations:
  - `startRound` (the core every trigger calls);
  - `submitBid`;
  - `closeRound`;
  - `payDeadline`;
  - `sellNow` (host, public);
  - `live` (presenter page);
  - `myRounds` (advertiser feed).
- **`convex/roundDelivery.ts`:** signed webhooks (`round_offer`, `round_won`, `round_lost`), mirroring `momentDelivery.ts`.
- **`convex/http.ts`:** the `POST /api/agent/rounds/{id}/bid` route.
- **`convex/crons.ts`:** the idle timer.
- **Triggers:** `audience.ts` (camera) and `events.ts` (event start) call `startRound` instead of `scheduleDetect`.

**Cutover, no flag:** the triggers, the player and the presenter page switch to rounds everywhere. The player's live display (`player.screenState`) reads the latest round instead of the latest moment. The old moment functions stay in the codebase, uncalled, for a later cleanup. Keeping both paths alive behind a flag would double the player and presenter work for no demo benefit.

## UI

- **Presenter page (`#/moment`):** per screen, a "Sell now" button and the current or last round:
  - an "Auto-sell when idle" toggle (off by default);
  - floor and asking price, with each signal's reason;
  - each invited company with its bid and reasoning, appearing as it arrives;
  - a countdown to close;
  - the outcome sentence;
  - the payment transaction link.

  The old moment panels are replaced.
- **Player:** while a round is bidding, the screen shows "Selling this spot · $X" with the bidder count. When the round is paid, it plays the ad. Showing paid requires a transaction hash.
- **Advertiser "Your agent" page:** the live feed lists each round the company was invited to, with its bid, reasoning and result.

## Test scenarios (each is an automated test)

| # | Setup | Expected |
|---|---|---|
| S1 | No camera, two companies, Sell now | Asking = floor; both bid; the higher wins and pays the runner-up's bid + $0.01; outcome sentence names both |
| S2 | One company | Closes as soon as it answers; wins at the lower of its bid and the asking price |
| S3 | No companies qualify | Unsold at once, with the reason |
| S4 | Two companies both pass (e.g. per-spot max below the floor) | Unsold at close, listing both reasons |
| S5 | Camera: 6 in view now, usual 3 | Crowd factor 2×, its reason stored; asking price doubles; agents capped below it still bid at their max, and the spot sells |
| S6 | Screen with no audience profile | Match `null`, agents value at 0.5 match, a sale still happens |
| S7 | One agent never answers | Round closes at 5 s with the other's bid |
| S8 | Winner's payment fails | Runner-up gets the spot at its own bid; with no runner-up → unsold (payment failed) |
| S9 | External agent with its own key | Gets the webhook, bids over HTTP, can win and pay over x402 |
| S10 | Trigger while a round is open, within the camera cooldown, or with the on-air spot already sold | No round |
| S12 | Auto-sell off (the default) | The cron starts nothing; turning it on starts one round per idle online screen, at most one per 2 minutes |
| S11 | Bid above the agent's per-spot max or budget | Rejected with the reason; the agent can bid again |

A manual demo script in `docs/demo/` covers the two-device flow: a host screen, two marketers, Sell now, the winner's video plays.

## Calls made by Claude (check these)

- **Built-in agents bid by rules**, not by Claude, so rounds stay fast and tests are deterministic. `BidStrategy` is the seam for a Claude strategy later.
- **Sealed single answers with second price**, instead of the ascending auction. Agents bid their real maximum, it closes in one exchange, and it's easy to explain on stage.
- **Close timing:** at most 5 s, and early when everyone has answered.
- **Floor vs asking:** signals raise the asking price; bids count from the existing `reserveFloorMinor`. A busy crowd makes the price stronger, but agents with low limits can still win.
- **No bids:** unsold with reasons, no reprice.
- **Triggers:** camera (any arrival, 60 s cooldown), host Sell now, and auto-sell when idle (off by default, a presenter-page toggle) so testnet USDC isn't drained.
- **Rounds sell only the spot on air now**, never further ahead.
- **Crowd signal:** people in view now (`peakInView` of the current bucket) ÷ a new `usualInView` (default 3), clamped 1×–3×.
- **One key and one campaign per company:** the built-in agent's first, else the newest qualifying ones.
- **Hard cutover:** the player and presenter read rounds; the old moment code stays, uncalled.
- **Unknown audience match** counts as 0.5. Match only scales value and never filters invitations.
- **A wallet balance that has never been read** means the built-in agent passes and says why.
- **New tables (`rounds`, `roundBids`)** instead of reusing `moments`/`flashOffers`, so the new pipeline isn't tangled with the old statuses. The old code stays in place, unused on the demo path.
