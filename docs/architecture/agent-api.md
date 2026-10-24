# Agent API

How a customer's buying agent talks to BillboardOS. Decided in [ADR 0004](../decisions/0004-two-sided-marketplace.md).

## Authentication

A customer issues an **agent key** from their dashboard (or, for the developer tools (`npm run buyer`, `npm run a2a:demo`), `npx convex run seed:demoAgentKeys`). The key and its webhook secret are shown **once**.

- Send `Authorization: Bearer bos_agent_<8 hex>_<48 hex>` on every request.
- A key has scopes (`quote`, `hold`, `bid`, `pay`), an optional campaign allowlist, a budget cap and an expiry.
- **Budget cap:** committed spend counts the key's active holds, the holds that became bookings, and its currently leading bids in open auctions. A request that would go over the cap is refused with `BUDGET_CAP`.
- **Rate limit:** 60 requests per minute per key.
- **Audit:** every call is recorded as `agent:<company>/<key name>`.

Base URL: `<CONVEX_SITE_URL>/api/agent/`. JSON in and out. Amounts are integer US cents; times are epoch milliseconds.

## Errors

`{ "error": { "code": "...", "message": "...", ...details } }`

| Status | Codes |
|---|---|
| 400 | `INVALID_INPUT` |
| 401 | `INVALID_KEY`, `KEY_REVOKED`, `KEY_EXPIRED` |
| 403 | `SCOPE_MISSING`, `NOT_COMPANY_MEMBER`, `CAMPAIGN_NOT_ALLOWED`, `FORBIDDEN` (wrong bidder key) |
| 404 | `NOT_FOUND` (also malformed IDs) |
| 409 (live auction) | `NOT_BIDDING`, `BIDDING_CLOSED`, `BID_LIMIT`, `ALREADY_LEADING`, `BID_TOO_LOW` (+ `minNextMinor`), `OFFER_CLOSED`, `ALREADY_REPLIED`, `STANDING_INSTRUCTIONS` |
| 409 | `BUDGET_CAP` (+ `committedMinor`, `budgetCapMinor`), `SLOT_UNAVAILABLE`, `AUCTION_OPEN` (+ `auctionId`), `AUCTION_CLOSED`, `BID_TOO_LOW` (+ `minNextBidMinor`), `ALREADY_LEADING`, `AUTO_BID_TOO_LOW`, `ALREADY_JOINED`, `QUOTE_NOT_OPEN`, `IDEMPOTENCY_KEY_CONFLICT`, `CAMPAIGN_CLOSED`, `BILLBOARD_OFFLINE` |
| 429 | `RATE_LIMITED` (+ `retryAfterMs`) |

## Endpoints

| Method and path | Scope | Body or query | Returns |
|---|---|---|---|
| `GET me` | none | | `{ company, key: {name, prefix, scopes, budgetCapMinor, committedMinor, expiresAt}, campaigns[] }` (campaigns limited to the allowlist) |
| `GET inventory` | none | `?campaignId=&billboardId=&hours=1..24` (default 12) | `{ generatedAt, campaignId, screens: [{billboardId, name, city, locationLabel, matchScore, expectedAudiencePer15Min, audienceBasis, relevantViewersPer15Min, explanation, slots: [{slotId, startAt, endAt, screenPriceMinor, auction}]}] }`. Top 5 screens, at most 24 available slots each. `screenPriceMinor` is before account pricing |
| `POST quotes` | `quote` | `{ campaignId, slotIds[] (1-16) }` | 201 `{ quoteId, billboardId, slotIds, amountMinor, currency, expiresAt, pricingBasis[], confidence, policyVersion, traceId, priceBreakdown[] }`. `amountMinor` is what you pay |
| `POST holds` | `hold` | `{ quoteId, idempotencyKey }` | 201 `{ holdId, quoteId, slotIds, amountMinor, currency, expiresAt, status, traceId, replayed:false }`; a retry with the same key returns 200 and `replayed:true` |
| `POST auctions/{id}/join` | `bid` | `{ campaignId, clientKey? }` | `{ participantId, bidderLabel, bidderKey, reserveMinor, minNextBidMinor, endsAt }`. Keep `bidderKey` |
| `POST auctions/{id}/bid` | `bid` | `{ campaignId, bidderKey, amountMinor }` | `{ leading, leaderLabel, currentMinor, minNextBidMinor, endsAt }` |
| `POST auctions/{id}/auto-bid` | `bid` | `{ campaignId, bidderKey, maxMinor }` | same as `bid`; the maximum stays private |
| `GET auctions/{id}/status` | `bid` | `?campaignId=` and header `X-Bidder-Key` | `{ bidderLabel, status, outcome: leading/outbid/not_bidding/won/lost/defaulted/failed, myMaxMinor, myLastBidMinor, currentMinor, minNextBidMinor, endsAt, holdId, holdKey, holdExpiresAt, amountMinor }` |
| `POST offers/{id}/reply` | `hold` | `{ decision: accept \| counter \| pass, amountMinor?, reasoning? }` | `{ offerId, status, amountMinor, windowClosesAt }` |
| `POST offers/{id}/bid` | `bid` | `{ amountMinor, reasoning? }` | `{ offerId, currentMinor, youLead, bidsLeft, closesAt }` |
| `GET alerts` | none | | Watch-rule alerts (step 3 of ADR 0004) |

## Live auction (offers)

A live moment starts when the host's screen sees enough people. Each matching company gets a `flash_offer` webhook, then plays by offer id. Both calls need the key that received the offer; another key gets `NOT_FOUND`. Amounts are integer US cents.

### Reply

`POST /api/agent/offers/{id}/reply` with `{ "decision": "accept" | "counter" | "pass", "amountMinor": 70, "reasoning": "optional" }`.

- **Join window (2 s, or until everyone replied).** Only a reply to the offer counts.
  - `accept` joins the auction at the opening price (`openingMinor`).
  - `counter` with `amountMinor` below the opening price records a lower offer. A counter at or above the opening price is an accept.
  - `pass` stays out.
  - After the window: `OFFER_CLOSED`. A second reply: `ALREADY_REPLIED`.
  - What happens next:
    - Two or more accepts start the bidding. Companies that countered also join it.
    - One accept is a sale at the opening price.
    - Only counters: the best counter (highest, then earliest) starts a negotiation with the host.
    - No accept and no counter: no sale. The screen re-offers later at a lower price.
- **Negotiation (the host's price vs. one company, up to 4 rounds, 18 s cap).** Only the company named in the `negotiation_counter` webhook may reply.
  - `accept` takes the host's price (`sellerMinor`).
  - `counter` with `amountMinor` makes a new offer. At or above `sellerMinor` it becomes an accept.
  - `pass` ends the negotiation.
  - Otherwise: `OFFER_CLOSED`.
- Every amount is checked against the key's standing instructions (`STANDING_INSTRUCTIONS`) and budget cap (`BUDGET_CAP`).

### Bid

`POST /api/agent/offers/{id}/bid` with `{ "amountMinor": 75, "reasoning": "optional" }`. Returns `{ offerId, currentMinor, youLead: true, bidsLeft, closesAt }`.

Rules: bids go up by 5% of the leading bid, at least 5 cents. Bidding lasts 12 s. A bid in the last 3 s adds 3 s, at most twice. Each company may bid 5 times.

| Code | Meaning |
|---|---|
| `NOT_BIDDING` | No live auction for this offer, or this company did not join it |
| `BIDDING_CLOSED` | The close time has passed |
| `BID_LIMIT` | 5 bids already placed |
| `ALREADY_LEADING` | This company already leads |
| `BID_TOO_LOW` | Below the next minimum; the error carries `minNextMinor` |

With no bids, the earliest company that accepted the opening price wins at that price.

### Webhook events

Delivered to the key's webhook URL, signed like watch alerts: `X-BillboardOS-Signature` is HMAC-SHA256 over `<X-BillboardOS-Timestamp>.<raw body>` with the key's webhook secret. Timeout 5 s, one quick retry. Every event carries `type`, `offerId`, `momentId`, `advertiserId`, `campaignId`, `host` and `billboard`.

| `type` | Extra fields |
|---|---|
| `flash_offer` | `spot {slotId, startAt, endAt, minutes}`, `priceMinor`, `valueMinor` (what the spot is worth), `openingMinor` (where bidding opens), `minimumMinor` (the host's minimum), `why` (how the price was set), `crowd`, `relevantViewers`, `audienceMatch`, `event`, `reasoning`, `respondBy`, `standingInstructions`, `links.reply`, `replyFormat` |
| `auction_started` | `openingMinor`, `minNextMinor`, `closesAt`, `bidsLeft`, `participants`, `links.bid` |
| `auction_update` | `currentMinor`, `youLead`, `minNextMinor`, `closesAt`, `bidsLeft`, `lastBidBy` (`you` or `another company`) |
| `negotiation_counter` | `yourLastOfferMinor`, `sellerMinor` (the host's current price), `round`, `roundsLeft`, `respondBy`, `links.reply` |
| `flash_won` | `holdId`, `amountMinor`, `payBy`, `purchaseUrl`, `notes`. POST `purchaseUrl` with the key as Bearer, expect 402, then pay over x402 |
| `flash_lost` | `yourAmountMinor` |

The built-in company agents (set up at `#/customer/agent`) are the reference receiver. Their webhook is `<CONVEX_SITE_URL>/company-agents/{advertiserId}/webhook`; it verifies the signature and acts on the event after answering.

## Paying for a hold (x402)

`POST <CONVEX_SITE_URL>/purchases/{holdId}` (or `/a2a/hosts/{workspaceId}/purchases/{holdId}`) with `Authorization: Bearer <agent key>` (scope `pay`).

1. The first request returns **402** with x402 payment requirements: the hold's exact amount in USDC on Base Sepolia, payable to the **host workspace's payout address**.
2. Retry with the signed payment in the `PAYMENT-SIGNATURE` header (the official `@x402/fetch` wrapper does this and keeps the `Authorization` header).
3. The server verifies, re-checks the hold, settles, and records the booking. A hold that lapsed in between is cancelled before money moves.

Without a key: 401 `AGENT_KEY_REQUIRED`. A key without `pay`, from another company, or outside its campaign allowlist is refused.

## Example

```bash
KEY=bos_agent_...
BASE=https://<deployment>.convex.site/api/agent

curl -s -H "Authorization: Bearer $KEY" "$BASE/inventory?hours=6"
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"campaignId":"...","slotIds":["..."]}' "$BASE/quotes"
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"quoteId":"...","idempotencyKey":"my-agent-001"}' "$BASE/holds"
```
