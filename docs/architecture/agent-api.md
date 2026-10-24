# Agent API

How a customer's buying agent talks to BillboardOS. Decided in [ADR 0004](../decisions/0004-two-sided-marketplace.md).

## Authentication

A customer issues an **agent key** from their dashboard (or, for the demo, `npx convex run seed:demoAgentKeys`). The key and its webhook secret are shown **once**.

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
| `GET alerts` | none | | Watch-rule alerts (step 3 of ADR 0004) |

## Paying for a hold (x402)

`POST <x402 server>/purchases/{holdId}` with `Authorization: Bearer <agent key>` (scope `pay`).

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
