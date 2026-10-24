# Live auction for real usage: design

Date: 2026-10-24 · Status: approved by the team on 2026-10-24 · Builds on ADR 0003 (pricing and bidding), ADR 0005 (agent-to-agent x402) and ADR 0006 (live moment)

## Intent

BillboardOS has been built quickly by a small team without much hands-on testing. Several parts of the demo are fake: a "simulate crowd" button, three scripted customer agents, a rehearsal payment switch and a manual "mark paid" button. No real payment has ever settled.

This change makes the demo honest and real: the four teammates use the product as real users, the crowd is counted by a real camera, companies' agents really compete, and every payment is a real x402 transaction on Base Sepolia (Coinbase's test network, test USDC). Nothing on the demo path is simulated.

The hero moment, in the team's words: one machine has the advertiser's video loaded; another machine belongs to a competing company, so the audience sees agents bid; both wait for an announcement. The third machine, the main display, announces that it is available now, shares what it knows about the people at the event (from the camera and the event), explains the price, and the two companies bid against each other for the spot. Then the display keeps the LED screen as busy as possible.

Later (not now): anyone signs up on a phone; a host registers many kinds of screens (Arduino LED panel, laptop, phone); many companies bid at very dynamic prices.

## The demo, concretely

| Machine | Who | What it shows |
|---|---|---|
| A | Advertiser teammate 1 (company 1) | Their agent's live feed: the announcement, the price reasoning, each bid, the win and the payment link. No clicks during the auction. |
| B | Advertiser teammate 2 (company 2) | Same, for the competing company. |
| C | The host's main display (LED screen) | The 3 display states below. Has a camera pointed at the room. |
| Presenter laptop | The host (Phong) | The live moment page for judges: stopwatch, reasoning, every bid with timestamps, payment link, the host's devices. |

**Success on demo day:** teammates stand in front of Machine C's camera; the LED announces an open spot; two real advertiser accounts bid against each other for 12–18 seconds; the winner pays with a real Base Sepolia transaction; the ad plays. Detection to first frame is under 30 seconds, with nobody clicking during the auction.

## Goals

1. Remove every simulated, scripted or manual path from the demo flow (list under "Removals").
2. One host account with many screens; many advertiser accounts, each with its own server-run bidding agent and its own wallet.
3. A host-side pricing agent that sets the opening price and a published minimum, and explains the price.
4. A live auction, fast and bounded, that can sell the current slot. With one interested company it negotiates; with none it re-offers lower.
5. The main display shows the auction to the room and never sits blank.
6. Real x402 payments from each company's wallet to the host's receiving wallet, provable with a transaction hash.

## Non-goals (later)

- Several hosts with separate accounts and payouts.
- People bringing their own wallets (Coinbase Wallet / MetaMask) or paying by hand on the website.
- Arduino screens. An Arduino can drive an LED panel but not play video; that is a separate piece.
- Mainnet (real dollars).

## Anti-goals (it fails even if it "works" if...)

- Anything on the demo path is fake: a simulated crowd, a scripted customer, a rehearsal or manual payment, or a "paid" status without a settlement transaction hash.
- Bidding opens so high on an idle screen that nobody bids and the screen sits empty.
- The camera identifies or profiles individuals. It counts people only (existing on-device MediaPipe detection, aggregate counts).
- The auction drags: if bidding takes more than about 20 seconds, the room loses interest.

## Accounts, wallets and agents

**Host.** One host account for now, which is the agency selling screen time. It owns many screens: the LED display, a laptop, a phone. Each device opens its screen link (the existing player and sensor pages) and runs as one of the host's screens. Any screen with a camera counts people with the existing sensor page. The first account on a fresh deployment becomes the operator; that must be Phong.

**Advertisers.** Many accounts, one per company. Each company has:

- an ad video, approved once by the host (existing creative approval);
- a **bidding agent that runs on our server**, set up on the website and then bidding on its own (generalise today's `demoAgents` mechanism: an encrypted agent key, signed webhooks, the real agent API and the real x402 route; drop the "simulated" labels and the seeding);
- **its own wallet** in the operator's CDP project, created automatically when the agent is first turned on, named per advertiser, and funded with faucet test USDC (the same calls as `demoAgentsNode:fundWallets`).

**Funding ("we are the main payer").** All advertiser wallets live in Phong's CDP project.

The CDP faucet gives **1 USDC per claim and at most 10 USDC per rolling 24 hours**. That limit applies per address and per CDP user, so the whole project gets about 10 USDC a day ([CDP faucet limits](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/faucets/request-funds-on-evm-test-networks)).

So the money circulates:

- Winning bids pay into the host's receiving wallet (`billboardos-operator`).
- The operator's **top up** action sends real USDC transfers from that wallet back to advertiser wallets. The faucet covers the shortfall, and Base Sepolia ETH for gas comes from the faucet too.
- The operator wallet never pays a bid on an advertiser's behalf. Every payment comes from the winning company's own wallet.
- An agent's cap also respects its on-chain USDC balance, so it never wins what it can't pay for.

**Advertiser setup** (approved mockup: `.superpowers/brainstorm/.../advertiser-agent-setup.html`). The advertiser decides four things:

1. **Ad video.** Must be approved by the host before the company can win.
2. **Ideal customer profile.** Audience types chosen from the same tag vocabulary the screens and events use (`campaign.targetAudience`).
3. **Reach target.** Only bid when at least N matching people are in front of the screen (`minRelevantViewers`).
4. **Spending limits.** A max per spot and a daily budget (`maxPricePerSpotMinor`, `dailyBudgetMinor`, enforced server-side as today). The page shows the wallet balance and a top-up link.

Bidding tactics are not exposed. The agent follows simple, fast rules (below). The `policy` and `counterRatio` fields of today's standing instructions are no longer needed for the auction.

**Advertiser's live view** (right half of the same mockup): a feed of the announcement with the price reasoning, each bid by them and by the competitor ("bid 3 of 5"), the close, and the win with the Basescan link. It also shows today's spend against the daily budget.

## Host pricing agent

The host sets two numbers per screen:

- the **minimum it will ever accept**, published to bidders and never undercut (this is today's `reserveFloorMinor`);
- a **starting rate per 1,000 views** (CPM).

After that, the agent learns from real clearing prices. These rules are based on research summarised in the appendix.

- **Value estimate:** `V = people in view × plays in the spot ÷ 1000 × CPM_ref × relevance`.
  - `people in view` = the camera's **current in-view count** (`peakInView` for the latest bucket), not trailing 15-minute arrivals.
  - `plays in the spot` = the spot length ÷ the ad length. Ads are limited to 30 s, so a 12-minute spot is 24 plays.
  - `CPM_ref` = the median CPM of the screen's recent sales, or the host's starting rate until there are about 5 sales. The starting rate defaults to **$5**.
  - `relevance` (about 0.7–1.5) is how well the crowd fits the bidders' profiles, from the event and screen tags.
- **Worked example (the scale we target):** 10 people in view × 24 plays ÷ 1000 × $5 × 1.0 = **$1.20**. Bidding opens at **$0.70**, the published minimum defaults to **$0.25**, and a winning price lands around $0.90–1.20. A demo spot costs about $1, so roughly 10 rehearsals a day fit the faucet and recycling budget.
- **Opening price:** about **60% of V**, never above it. With only 2–5 bidders, opening too high costs far more than opening too low, and competition raises the price.
- **Idle discount:** the longer the screen has had no paid ad, and the closer the spot is to starting, the lower the opening price, down to the published minimum and never below. A large crowd pauses the discount. Add a little randomness so agents can't time it exactly. A hard floor plus demand-driven decay is the defence against agents learning to wait for discounts.
- **The "why":** every announcement carries a one-line explanation, for example "10 people × 24 plays at $5 per 1,000 views ≈ $1.20; idle 6 min; bidding opens at $0.70". It is shown on the display, to bidders and on the presenter page. (The mockups show older example numbers; the layout is what was approved.)
- **Fix while here:** flash and partial-slot sales are written to `priceHistory` at the pro-rata amount but normalised as a full slot (`payments.ts:296`, `screenPrice.ts:138-141`). That drags the market stage down, so normalise by the time actually sold.

Company-specific pricing multipliers (`companyAssessments`) do not apply to the live auction. Competition sets the price.

Real prices at this scale are small: a room of about 10 people makes a 12-minute spot worth around $1. These are realistic small-venue prices, not scaled down.

## The live moment, start to finish

1. **When to sell.** The screen tries to sell whenever an unsold spot is coming up and at least one advertiser's conditions could be met. This follows "keep the screen as busy as possible".
   - The crowd threshold moves to each advertiser's own reach target, which defaults to **3 matching people**, since the demo crowd is the four teammates plus whoever is in the room.
   - The workspace detection threshold defaults to **1 person in view**. There is no cooldown between a sold spot and selling the next one.
   - A crowd change re-prices a pending re-offer.
   - Counts come only from the real camera (and event changes, as today).
2. **Pick the spot.** Use the rest of the current 15-minute slot if at least 3 minutes remain, otherwise the next free slot (today's `pickSpot`). When a paid spot is playing, the next spot goes on sale about 1 minute before it ends.
3. **Price and announce.** The pricing agent computes V, the opening price and the minimum. The display shows "available for the next N minutes" (state 1). Every advertiser whose profile, reach target, approved ad and limits fit is notified through a signed webhook. Notify each company once, whichever campaign fits best (today's targeting rules).
4. **Branch on how many companies join within about 2 seconds:**
   - **Two or more: live auction.**
     - Bidding rises from the opening price. Each bid must beat the current price by at least **max(5%, $0.05)** (a new parameter on the increment logic in `lib/auction.ts`; the existing $1 minimum suits the larger scheduled auctions).
     - Each company may bid **at most 5 times**.
     - Bidding runs for **12 seconds**. A bid in the last 3 seconds adds 3 seconds, **at most twice**, so bidding lasts at most 18 s.
     - With about 1 s to announce, 2 s to join, up to 18 s of bidding and a few seconds of x402 settlement, detection to first frame stays under the team's **30-second goal** even with late bids.
     - The highest bid wins, and bids are not capped at the opening price. This is the key change from today's flash offers, which cap everyone at the ask.
   - **Exactly one: negotiation.** The host and the company go back and forth for at most 4 rounds within the same time cap. The host concedes on today's schedule (`lib/negotiation.ts` `sellerRespond`), never below the published minimum.
   - **None: re-offer.** After a pause of about 20 s, the screen announces again at an opening price about 15% lower, never below the minimum.
     - At the minimum it stops stepping down and holds a standing offer. Any advertiser whose conditions become met, for example because the crowd grows, can take it at once.
     - Between offers it shows "Your ad here" with the price.
5. **Award and pay.** The winner gets a hold and pays through the real x402 route from its own wallet within 60 seconds. The settlement transaction hash is recorded. If the winner fails to pay, the next-best bidder is offered the spot at their last bid if that is at or above the minimum (today's winner-default path, applied here).
6. **Play.** The ad plays for the rest of the spot. Before the spot ends, the screen starts selling the next one so there is no dead air.

**How company agents bid** (server-run, fast, rule-based, no slow reasoning):

- Each company has a private value cap = min(max per spot, remaining daily budget, its own value estimate from the announcement × profile match).
- It enters if the opening price is at or below that cap and the reach target is met.
- When outbid, it raises by the minimum step, with a small random delay of 0.3–1 s so bids land visibly, while the next bid stays within its cap and it has bids left.
- It must reply within 1 second of each event.

The builder chooses the exact tactics within these limits.

**Not reused as-is:** the existing ascending auction (`convex/auctions.ts`). It cannot sell a slot starting within about 11 minutes, and its 5-minute hold does not fit the 60-second pay window. Reuse its pure helpers (`increment`, `extendForSoftClose`, `resolveProxy`) where they fit. Whether the live auction becomes a new mode of `auctions` or a new state of `moments` is the builder's call.

## Many screens, one auction at a time (team decision)

Approved mockup: `.superpowers/brainstorm/.../devices-on-stage.html`.

- **Every screen sells its own spots**, but the host account runs **only one live auction (or negotiation) at a time**.
- A screen with an unsold spot joins a per-host queue, in first-come order. Each auction takes about 15 s.
- So each company is in at most one auction and has at most one payment in flight. Budgets and wallets cannot be double-spent, and no parallel-auction logic is needed.
- A screen waiting in the queue shows "Your ad here" with its price.

**For the demo:**

| Device | Role |
|---|---|
| Screen 1: main LED display | Laptop with a webcam. The hero auction, with both companies competing. |
| Screen 2: a phone | Plays ads on its own screen, and its front camera counts people. With fewer people in view, its price is lower and usually only one company qualifies, which shows the negotiation path. |
| Presenter laptop | Lists the host's screens (online, camera count, now playing) and the auction queue. |

Later screens (an Arduino panel, more phones) join the same queue with no new rules. Parallel auctions across many screens are a later concern.

**Demo run (about 1 minute):**

1. The LED announces; the two companies bid; the winner pays; the ad plays on the LED.
2. The phone announces next; one company qualifies, negotiates and pays; the ad plays on the phone.
3. The presenter laptop shows two screens, two prices and two real transactions.

## The display (Machine C)

Approved mockup: `.superpowers/brainstorm/.../display-states.html`. The room sees the auction on the LED itself; the team chose this deliberately for the showcase. The display has three states:

1. **Announce** (about 1 s): "This screen is available for the next 12 minutes". It shows the camera crowd count, the event, the opening price and "advertisers' agents notified". Between re-offers it shows "Your ad here" with the price.
2. **Live auction** (12–18 s): a "LIVE AUCTION" badge, the bid ladder with company names, the leader highlighted, a countdown that visibly extends on late bids, and the "why" line.
3. **Playing:** the ad fills the screen. A thin strip at the bottom shows "Sponsored · company · won at $X · paid on Base · tx". Near the end, it moves on to announcing the next spot.

Approved ads stay preloaded so playback starts as soon as payment settles (existing preloading).

**Presenter page** (today's live moment page, extended):
- the stopwatch from detection to first frame;
- the pricing agent's reasoning;
- every bid and negotiation round with timestamps;
- the payment link;
- a list of the host's devices, showing which are online and which is live.

## Removals

Remove these from the code and the UI, not just hide them:

1. `payments.recordManual` and the SlotBoard "mark paid" button, plus `manual` in the HTTP provider enum.
2. Rehearsal settlement: `moments.paymentBlocked`'s rehearsal path, `setRehearsalSettlement`, the workspace `rehearsalSettlement` flag, the REHEARSAL badge and `paymentMode "rehearsal"`. If payment fails, the moment says so honestly and moves to the runner-up.
3. Simulated crowds: `moments.simulateCrowd`, the sensor page's "Add 10 simulated arrivals", the "simulated" moment trigger and the `source: "simulated"` audience path.
4. Scripted customers: the seeded LaunchKit / Nvidia / Golden Gate demo agents (`seed:demoMoment`'s agents and `flashOffers.simulatedAgent`), and `server/auction-agents.ts`. Real advertiser accounts replace them.
5. Book page copy that offers a simulated manual payment (`BookPage.tsx:302`).

Existing rows in the dev database keep their history. Schema values that only old rows use stay in the validators, marked as legacy: `paymentMode "rehearsal"`, trigger `"simulated"`, audience source `"simulated"` and payment provider `"manual"`. Every code path that writes them is removed, so nothing new can produce them. Production starts clean.

**Out of scope for this change** (separate areas, unchanged):
- the finance module's fixture bank feed (Hyphenate track);
- the deterministic narration stubs;
- the developer scripts `npm run buyer` and `npm run a2a:demo`, which are real x402 calls from a laptop and stay as developer tools outside the demo path.

## Deployment and setup

- **Production:** deploy the Convex deployment and website. Set the CDP keys, `X402_PAY_TO` (the existing `billboardos-operator` wallet or a new one) and `INTERNAL_API_SECRET` with `--prod`.
- **Seed only the host's real setup:** the venue, screens, slot inventory and the event. Seed no customers.
- **Sign-up order:** Phong signs up first and becomes the operator. The two advertiser teammates sign up as advertisers, upload ads, set up agents (which creates and funds their wallets), and the host approves their ads.

## Measurement

- The presenter page records each step's time from detection: announce, first bid, close, hold, settled, first frame.
- Payments count only with a settlement tx hash.
- Target: first frame within 30 s when the spot is the current slot.

## Left to the builder

- Data model for the live auction (new mode of `auctions`, a new state in `moments`, or a new table).
- Exact agent tactics within the stated limits.
- How the display and the advertiser feeds subscribe to updates (Convex reactive queries are the obvious choice).
- The exact idle-discount curve and pause, within the stated rules.
- Tests: every rule above (increments, 5-bid cap, soft close, hard cap, 1-bidder negotiation, 0-bidder re-offer, minimum never undercut, winner default) should have unit tests, like the existing auction and negotiation suites.

## Calls made by Claude, not the team (check these)

- Bidding opens at about 60% of the value estimate, with the decay rules above. This comes from the research; the team said "don't start too high when idle".
- Price scale: $5 starting CPM, $0.25 default minimum, 30 s ads, value from people in view. A spot costs about $1.
- Minimum step max(5%, $0.05); 12 s of bidding plus at most two 3 s extensions; up to 4 negotiation rounds.
- Selling whenever a spot is unsold: per-advertiser reach targets (default 3) replace the crowd threshold; no cooldown; re-offers step 15% down every ~20 s and then hold at the minimum.
- Funding: payments recycle from the operator wallet back to advertisers by real transfers, plus the faucet. The operator never pays a bid, and agent caps respect on-chain balance.
- Legacy schema values stay so dev history validates; nothing can write them.
- About a 2 s window to join before choosing between auction, negotiation and re-offer.
- Advertisers don't see bidding tactics; they set only limits and targets.
- Company pricing multipliers don't apply to live auctions.
- `npm run buyer` and `a2a:demo` stay as developer tools; the finance fixture feed is out of scope.
- Production starts clean; dev keeps its history.

## Appendix: pricing research (summary)

- **Price should fall as an unsold slot nears its start.** In optimal dynamic pricing for perishable stock, price falls as time runs out (Gallego & van Ryzin, 1994).
- **Reserve prices matter most with few bidders, and overshooting costs more than undershooting.** In Yahoo's field experiment, reserves earned about +10% where there were fewer than about 5.5 bidders, and most of the gain came from going halfway to the theoretical optimum (Ostrovsky & Schwarz).
- **One more bidder is worth more than a perfect reserve** (Bulow–Klemperer).
- **Last-second bidding:** fixed end times invite it, and soft closes curb it (Roth & Ockenfels).
- **Typical DOOH CPMs** are about $5–25; premium venues run $40–100+ (AdQuick, vendor data).
- **Strategic waiting:** buyers who learn that prices always fall will wait. Commit to a hard floor and tie discounts to demand.
