# Proposed data model and API surface

This is a logical schema, not an implemented database migration. Use UTC timestamps, explicit currency/network and integer monetary units.

```mermaid
erDiagram
  ADVERTISER ||--o{ CAMPAIGN : owns
  CAMPAIGN ||--o{ QUOTE : receives
  BILLBOARD ||--o{ SLOT : offers
  QUOTE ||--|{ QUOTE_SLOT : contains
  SLOT ||--o{ QUOTE_SLOT : quoted_as
  QUOTE ||--o| HOLD : accepted_as
  HOLD ||--o| BOOKING : finalized_as
  BOOKING ||--o{ PAYMENT_EVENT : has
  BOOKING ||--o{ PLAYBACK_EVENT : produces
  BILLBOARD ||--o{ AUDIENCE_AGGREGATE : emits
  CAMPAIGN ||--o{ AGENT_EVENT : traces
  ADVERTISER {
    uuid advertiser_id PK
    string display_name
  }
  CAMPAIGN {
    uuid campaign_id PK
    uuid advertiser_id FK
    string target_locations
    int budget_minor
    string currency
  }
  BILLBOARD {
    uuid billboard_id PK
    string location_label
    string device_status
  }
  SLOT {
    uuid slot_id PK
    uuid billboard_id FK
    timestamp start_utc
    timestamp end_utc
    string state
    int version
  }
  QUOTE {
    uuid quote_id PK
    uuid campaign_id FK
    int amount_minor
    timestamp expires_at
  }
  QUOTE_SLOT {
    uuid quote_id FK
    uuid slot_id FK
  }
  HOLD {
    uuid hold_id PK
    uuid quote_id FK
    timestamp expires_at
    string status
  }
  BOOKING {
    uuid booking_id PK
    uuid hold_id FK
    string status
  }
  PAYMENT_EVENT {
    uuid event_id PK
    uuid booking_id FK
    string provider_reference
    int amount_minor
    string status
  }
  PLAYBACK_EVENT {
    uuid event_id PK
    uuid booking_id FK
    timestamp observed_at
    string creative_hash
  }
  AUDIENCE_AGGREGATE {
    uuid aggregate_id PK
    uuid billboard_id FK
    timestamp bucket_start
    int count_estimate
  }
  AGENT_EVENT {
    uuid event_id PK
    uuid campaign_id FK
    string actor
    string type
  }
```

**Model note:** `PAYMENT_EVENT.booking_id` must support payment-before-confirmation by initially linking to `hold_id` or a purchase intent. Final migrations should enforce this and avoid requiring a confirmed booking to store an incoming payment event.

## Suggested routes

| Method | Route | Purpose | Policy |
|---|---|---|---|
| POST | `/api/campaigns` | Create and validate advertiser campaign | authenticated advertiser |
| GET | `/api/billboards` | List location inventory | public filtered view |
| GET | `/api/slots?billboard_id=…` | Available slots | no hidden reservations |
| POST | `/api/quotes` | Deterministic quote, optional agent explanation | seller price policy |
| POST | `/api/quotes/:id/holds` | Exclusive TTL hold | atomic, idempotent |
| POST | `/api/purchases/:holdId` | Protected checkout / x402 route | quote + network + amount validation |
| POST | `/api/payments/notifications` | Provider event handling | signature + idempotency |
| POST | `/api/bookings/:id/approve-creative` | Approve assets | operator only |
| GET | `/api/dashboard` | Owner revenue/occupancy and exceptions | operator |
| POST | `/api/devices/:id/playback` | Append delivery receipts | device authentication |

## Agent event types

`brief.parsed`, `inventory.queried`, `quote.proposed`, `counteroffer.received`, `policy.evaluated`, `slot.held`, `hold.expired`, `payment.verification_requested`, `payment.confirmed`, `booking.confirmed`, `creative.approved`, `playback.observed`, `finance.exception_opened`, `operator.approved`.

## Contract test examples

- Two simultaneous holds for the same slot result in exactly one success.
- Replaying confirmed payment proof does not create a second booking.
- Incorrect currency/amount rejects payment and prevents scheduling.
- Video/creative cannot publish before approval.
- Missing sensor data falls back to baseline pricing labeled low confidence.
