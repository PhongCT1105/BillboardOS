# Live moment runbook (production)

The hero demo from [ADR 0006](../decisions/0006-live-moment-30-seconds.md), run for real: a person stands in front of the LED screen's camera, the screen announces a spot, two companies' agents bid with their own wallets, the winner pays over x402 on Base Sepolia, and the ad plays on the screen. Nothing in this path is simulated: no fake crowd, no scripted agents, no rehearsal payments.

Everything is testnet money. Use placeholders below; never paste real keys into chat, tickets or this file.

## 1. Production deploy

1. Deploy the Convex backend to production:
   ```bash
   npx convex deploy
   ```
2. Set the production environment. Convex does not read `.env`.
   ```bash
   npx convex env set --prod CDP_API_KEY_ID "<your key id>"
   npx convex env set --prod CDP_API_KEY_SECRET "<your key secret>"
   npx convex env set --prod CDP_WALLET_SECRET "<your wallet secret>"
   npx convex env set --prod X402_PAY_TO "<operator wallet address 0x...>"
   npx convex env set --prod INTERNAL_API_SECRET "$(openssl rand -hex 32)"
   npx convex env set --prod X402_NETWORK eip155:84532
   npx convex env set --prod SITE_URL "https://<deployment>.convex.site"
   ```
   Do not set `COMPANY_AGENT_DELAY_MS` in production (tests only).
3. Build and publish the website:
   ```bash
   npm run deploy:prod
   ```
4. Check the site opens at `https://<deployment>.convex.site`.

## 2. Host setup (Phong first)

1. **Phong signs up first.** The first account on a deployment becomes the operator, so nobody else signs up before this step.
2. Create the workspace for the host.
3. Create the venue with the two screens. If you want the seeded screen and slots, run `npx convex run seed:liveVenue --prod`. Otherwise add them by hand: a screen named **LED** and a screen named **Phone**.
4. Open `#/moment` (the presenter page). For each screen, set live pricing: **minimum $0.25, CPM $5**.
5. Add the real event happening at the venue (name, start, end) on the presenter page. It is labeled as entered by the host.

## 3. Advertisers

1. Two people sign up as advertisers, each on their own laptop.
2. Each uploads an ad (creative) for a campaign.
3. Each opens `#/customer/agent`, sets up the company agent (limits, wallet, standing instructions) and turns it on. Turning it on creates the company's own CDP wallet.
4. The host approves both ads (operator console, creative approvals).

## 4. Fund the wallets

The CDP faucet gives **1 USDC per claim and 10 USDC per rolling 24 hours per project**. A spot costs about $1, so money has to recycle: winners pay the operator wallet, and the host tops companies back up from it.

1. Get Base Sepolia ETH and USDC for the operator address (`X402_PAY_TO`) from the Coinbase CDP faucet in the CDP portal, or the Faucet API. ETH is for gas on top-up transfers.
2. On `#/moment`, top up each company. A top-up sends $2.00 from the operator wallet. If the operator wallet is short, it falls back to the faucet.
3. Confirm each company's balance shows on the presenter page and on its `#/customer/agent` page before going on.

## 5. Devices

| Device | Open | Notes |
|---|---|---|
| LED laptop | `#/player/<LED billboard id>?camera=1` | Allow the camera. It counts people on the device and sends counts only |
| Phone | `#/player/<Phone billboard id>?camera=1` | Allow the camera. Hold it so it faces the audience |
| Presenter | `#/moment` | Devices, queue, live bids, top-ups |
| Each advertiser laptop | `#/customer/agent` | Shows the agent's live feed and wallet |

The ids are in the presenter page's devices list.

## 6. Run

1. Check the presenter page shows both screens online and both companies funded.
2. Stand in front of the LED camera, so the count reaches the screen's target.
3. Expected on the LED screen: it announces the spot with the live price, the two agents join, a 12 s auction runs on the presenter page and on the advertiser feeds (late bids extend it by 3 s, at most twice), the screen shows settling, then the winner's ad plays.
4. Expected on the phone: the lost spot is queued for it and sold next, as its own announce, auction and sale.
5. Narrate from the presenter page: the price reasoning, each bid with its reason, the x402 transaction link. A payment is shown as paid only with a settlement transaction hash.

If a spot does not sell, the screen re-offers it lower after a pause, never below the minimum.

## 7. The faucet limit

10 USDC per day per project is the whole budget. Each rehearsal moves about $1 from a company to the operator wallet.

1. After each run, top up the companies that spent, from the operator wallet (`#/moment`).
2. A company can be topped up 5 times per UTC day.
3. If the operator wallet runs short, the top-up falls back to the faucet, which counts against the 10 USDC.
4. Do the first full rehearsal the day before, and keep some of the day's faucet allowance for the demo.

## Troubleshooting

- **No announce:** the camera count is below the target, or the screen is already in a moment. Check the presenter page.
- **A company never bids:** its agent is off, its wallet balance is below its bid, or a standing instruction refuses the price. Its feed says which.
- **Payment blocked:** the winner's wallet is empty or CDP keys are missing. The screen says so. Nothing is shown as paid.
- **Logs:** `npx convex logs --prod`.

## Developer tools (not part of the demo)

`npm run buyer` and `npm run a2a:demo` run a real x402 buyer from a laptop, using keys from `npx convex run seed:demoAgentKeys`. They are for testing the agent API and are not used on demo day. See [Agent API](../architecture/agent-api.md).

## Honesty labels

- **Audience:** real on-device person counts from the screen's camera.
- **Event:** entered by the host (the `seed:liveVenue` event is labeled "(seeded)").
- **Companies:** real sign-ups with their own agents and wallets. The money is testnet USDC.
- **Payments:** shown as paid only with a settlement transaction hash.
