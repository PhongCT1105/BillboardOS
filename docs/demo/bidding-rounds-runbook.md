# Bidding rounds: two-device demo

The simple sale from the [bidding rounds design](../superpowers/specs/2026-10-24-simple-bidding-rounds-design.md):

```
start → price → invite → one sealed bid per agent → close (≤ 5 s) → pay → play
```

A camera is optional. Without one, the host presses **Sell now**.

Site (dev deployment): https://lovable-cricket-727.convex.site

## Before the demo

1. **Host first** (screen laptop). Sign in with **one-click demo host**. Auto-setup creates a workspace and a screen with a $1.00 floor.
2. Open the screen's player in its own tab: `#/player/<billboard id>`.
   - The id is in the devices list on `#/moment`.
   - Add `?camera=1` to count people. Then a crowd raises the asking price, and someone walking up starts a round on its own.
3. **Two marketers**, each on their own device, sign in with **one-click demo advertiser**. Then on **Campaign setup**:
   - paste the company's YouTube ad;
   - set the slider to about **$5 a day**, so the agent bids up to $1.50 a spot;
   - press **Start my agent**.
4. Wait for "What your agent learned" to show **Approved for screens**.
5. **Fund both wallets.** On the host's `#/moment`, under top-ups, top up both companies. This sends $2.00 each from the operator wallet. The faucet gives the whole project only about 10 USDC a day, so don't rely on advertiser self top-ups.

## Run

1. On `#/moment`, press **Sell now**.
2. Within about a second, both agents' sealed bids appear, each with its reasoning, for example "Worth $1.15 to me (50% audience match); bidding $1.15". The round closes as soon as both have answered.
3. The winner pays the runner-up's bid + $0.01. The payment settles over x402 on Base Sepolia, and the Basescan link appears.
4. The screen switches from "settling" to "playing", and the winner's YouTube ad plays.
5. Each marketer's **Your agent** page lists the round: its bid, its reason, and whether it won.

**Auto-sell when idle** (the toggle on `#/moment`) starts a round on each idle online screen every 2 minutes. It's off by default because every sale spends testnet USDC.

## What each outcome means

| Outcome sentence | Why | Fix |
|---|---|---|
| "No company agents with an approved ad and budget." | No agent is on, no ad is approved for this host, or no budget is left today | Marketers press **Start my agent**; check "Approved for screens"; raise the slider |
| "Unsold: no bid at or above the $1.00 floor. …" | Every agent passed; each reason is listed | Usually "Wallet balance not read yet" (wait a few seconds after setup), or a per-spot limit under the floor (raise the slider) |
| "Payment failed: …'s payment failed: …" | The winner's wallet couldn't pay, and nobody was left to take the spot | Top up the wallet on `#/moment`. "no CDP keys" means the deployment's Coinbase env vars are missing |
| "… gets the spot at its $X bid (…'s payment failed: …)" | The winner didn't pay, so the runner-up took the spot at its own bid | Nothing to do; top up the first wallet for next time |
| "Spot was sold elsewhere." | The spot was booked between the start and the close | Press **Sell now** again; it sells the next spot |
| **Sell now** says "Nothing on air to sell…" | The current spot is sold or has under 3 minutes left, and the next isn't free | Wait for the next quarter hour |
| **Sell now** says "A round is already running…" | A round is open or waiting for payment (up to 60 s) | Wait for it to finish |
