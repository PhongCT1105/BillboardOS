# Live moment runbook

The hero demo from [ADR 0006](../decisions/0006-live-moment-30-seconds.md): a crowd forms, the host's seller agent sends flash offers to matching customers, their agents reply, the winner pays over x402, and the ad plays.

## Setup (once per deployment)

1. **Payments** (skip to rehearse without keys). Set on the Convex deployment:
   ```bash
   npx convex env set CDP_API_KEY_ID "..."
   npx convex env set CDP_API_KEY_SECRET "..."
   npx convex env set CDP_WALLET_SECRET "..."
   npx convex env set X402_PAY_TO 0x...        # or set Moscone's payout address in Workspace -> Payouts
   ```
   `INTERNAL_API_SECRET` must also be set (it encrypts the demo agents' keys).
2. **Seed the demo world:** three simulated customer agents (LaunchKit, Nvidia, Golden Gate Coffee), their creatives approved for Moscone Media, agent keys with standing instructions, and the seeded "Startup Demo Day" event:
   ```bash
   npx convex run seed:demoMoment
   # testnet-friendly prices:
   npx convex run seed:demoMoment '{"baseRateMinor":300,"reserveFloorMinor":100}'
   ```
3. **Fund the demo agents' wallets** with Base Sepolia test USDC (needs the CDP keys; wait about 10 s):
   ```bash
   npx convex run demoAgentsNode:fundWallets
   ```
4. **Publish the website:** `npm run deploy:web`. If the upload fails with EPIPE, run `npx @convex-dev/static-hosting upload -j 1`.
5. **Operator account:** sign up on the site as a host, then `npx convex run seed:addDemoOwner '{"email":"<you>"}'`.

## On stage

| Device | Open |
|---|---|
| Presenter screen | `https://<deployment>.convex.site/#/moment` (Live moment) |
| Billboard display | `#/player/<billboardId>` ("Open screen" in the nav) |
| Optional: camera laptop | `#/sensor/<billboardId>` |

1. **Payment mode.**
   - **Without payment keys:** turn **rehearsal settlement** ON in Live moment → settings. Payments then show as "REHEARSAL (simulated)".
   - **With keys:** leave it OFF.
2. **Show the setup:** Workspace → Ready creatives (3 ready), and a customer's Agent keys → standing instructions.
3. **Start the moment:** press **Simulate crowd** (labeled simulated), or let the camera count real people. Do it with **at least 3 minutes left in the current 15-minute slot**, so the spot plays immediately instead of waiting for the next slot.
4. **Narrate:**
   - **The reasoning:** "30 people… Startup Demo Day… ~21 relevant viewers."
   - **The offers:** to LaunchKit and Nvidia (Golden Gate's max is under the floor).
   - **The decision:** LaunchKit accepts, Nvidia counters, LaunchKit wins.
   - **The payment:** the Basescan link, or the REHEARSAL label.
   - **The screen:** the ad appears and the stopwatch stops.
5. **Before the next run:** wait out the 10-minute cooldown or the end of the sold spot.

## Measured on dev (rehearsal settlement)

| Step | Time from detection |
|---|---|
| Detected, priced, 2 offers sent | 0.0 s |
| LaunchKit accepts | 2.4 s |
| Nvidia counters, window closes early, LaunchKit wins, hold placed | 2.9 s |
| Winner webhook delivered | 3.2 s |
| Payment recorded (rehearsal), scheduled | 3.6 s |
| First frame | 15.4 s (the spot was the next slot, about 12 s away) |

With at least 3 minutes left in the current slot, expect about 4–6 s on rehearsal. Real x402 adds about 3–8 s of verify and settle on testnet.

## Honesty labels

- **Crowd:** simulated crowd buckets are labeled "SIMULATED".
- **Event:** the event is labeled "(seeded)".
- **Customer agents:** the three demo customer agents are labeled "simulated customer agent". They still use real signed webhooks, the real agent API and real x402 routes.
- **Payments:** a payment is shown as paid only with a settlement transaction hash. Rehearsal payments are labeled "REHEARSAL (simulated)".
