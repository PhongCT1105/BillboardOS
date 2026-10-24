# Coinbase builder feedback (running log)

The Coinbase Payment Agents submission requires: biggest blocker, how we worked around it, and the one missing Coinbase capability we most want. Add entries as we hit them.

## Biggest blocker

The Express payment middleware settles **after** the route handler runs. Our handler needs the settlement transaction hash to record the booking, and must re-check that the hold is still valid between verification and settlement. There is no documented way to do either.

**Workaround:** we call `x402HTTPResourceServer.processHTTPRequest`, `processSettlement` and the cancellation dispatcher directly (found by reading the middleware source). Order: verify → re-check hold → settle → record booking with the tx hash.

## Missing capability we most want

A supported hook between verify and settle: "check business state, then either settle or cancel without settling", which the middleware respects.

## Other notes

- Dynamic per-request pricing works (`price: (ctx) => ...` and `unpaidResponseBody` exist in the types) but isn't in the quickstart. We subclassed `ExpressAdapter` to pass looked-up data into the price function.
- The buyer quickstart doesn't say the wallet secret is a separate portal artifact from the API key.
- The SDK reads `CDP_X402_SERVER_ENVIRONMENT` / `CDP_X402_CLIENT_ENVIRONMENT`, not the names we guessed; we pass the environment explicitly.
- `@coinbase/cdp-sdk` lists `@x402/*` as optional peer dependencies, so the install command must name every package.
- The faucet's per-claim USDC amount is small compared with realistic prices, which makes realistic test purchases awkward.

## What worked well

- `CdpX402Client` spend limits (per-payment cap, network allowlist) map directly onto an advertiser agent's budget.
- `createX402Server` added bazaar, gas sponsoring and builder-code extensions automatically; the bazaar entry exposed `pathParams.holdId` correctly.
