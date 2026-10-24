# Payments, booking and risk controls

**Implementation design proposal.** The exact Coinbase x402 sponsor setup, CRS product capabilities, chains, supported currencies and endpoints must be checked against official sponsor documentation. This document describes responsibilities, **not a verified integration**.

## Payment and slot booking (logical flow)

```mermaid
sequenceDiagram
  autonumber
  participant Buyer as Advertiser or buyer agent
  participant API as BillboardOS booking API
  participant DB as Inventory / finance database
  participant x402 as x402 middleware / facilitator
  participant Screen as Billboard scheduler
  Buyer->>API: POST /quotes/{id}/holds
  API->>DB: Atomic hold slot with expiry
  DB-->>API: Hold ID and current version
  API-->>Buyer: Hold confirmation
  Buyer->>API: Request protected purchase endpoint
  API-->>Buyer: HTTP 402 payment requirements (when applicable)
  Buyer->>API: Retry with signed payment payload
  API->>x402: Verify payment requirements / proof
  x402-->>API: Verified / settled response
  API->>DB: Idempotent payment event + confirm held inventory
  alt Payment and hold valid
    DB-->>API: Booking confirmed
    API->>Screen: Schedule approved creative
    Screen-->>API: Playback proof
    API-->>Buyer: Booking receipt + status
  else Invalid, expired or conflicting
    DB-->>API: Review / reconciliation exception
    API-->>Buyer: Pending or failed with reason
  end
```

**Important x402 distinction:** In a typical x402 exchange, the **resource server** announces payment terms (HTTP 402); a compatible **client** supplies a signed payment payload and retries; the **server** verifies/settles via a facilitator or chain-supporting implementation. Exact header names, settlement semantics and SDK behavior depend on the version adopted. Coinbase/x402 does **not** implement business negotiation or quote matching for us.

## State machines

### Inventory

```mermaid
stateDiagram-v2
  [*] --> AVAILABLE
  AVAILABLE --> HELD: atomic hold
  HELD --> AVAILABLE: expiry or cancel
  HELD --> BOOKED: verified payment and valid hold
  BOOKED --> SCHEDULED: creative approved
  SCHEDULED --> PLAYED: observed playback receipt
  SCHEDULED --> FAILED_DELIVERY: device failure
```

### Payment

```mermaid
stateDiagram-v2
  [*] --> INITIATED
  INITIATED --> PAYMENT_REQUIRED
  PAYMENT_REQUIRED --> VERIFYING: signed proof received
  VERIFYING --> CONFIRMED: verified/settled
  VERIFYING --> FAILED: proof invalid
  CONFIRMED --> RECONCILED: amount and booking matched
  CONFIRMED --> EXCEPTION: booking conflict / late payment
  EXCEPTION --> RECONCILED: authorized resolution
```

## Ledger and exception conditions

Record an append-only payment journal: `event_id`, `booking_id`, `quote_id`, `hold_id`, `external_payment_id`, `status`, `amount_minor`, `asset/currency`, `observed_at`, `idempotency_key`, `evidence_pointer`. Track **expected revenue** separately from **collected cash**; do not treat invoice creation as payment settlement.

A refund (if applicable) is a separate, authorized compensating transaction. Payment succeeded after hold expiry = exception, never quietly ignore. Duplicate webhook = one outcome. Price mismatch = manual review.

## Risk/CRS boundary

```mermaid
flowchart TD
  A[Advertiser onboarding] --> B{Use permitted CRS sandbox data?}
  B -->|Available / relevant| C[CRS adapter: test identity query]
  B -->|Unavailable| D[Manual / basic payment terms]
  C --> E[Evaluate returned signals within policy]
  E --> F{Decision}
  F -->|low concern| G[Standard upfront checkout]
  F -->|uncertain| H[Require operator review]
  F -->|verified concern| I[Hold pending authorized decision]
  D --> G
  G --> P[Verified checkout]
  H --> O[Operator approval]
  O --> P
```

Never use credit score alone as proof of fraud. Never submit real identities to a hackathon sandbox. A CRS category named 'business verification' is **not confirmed** as an available endpoint for this team.

## Security requirements

- Keys in environment/secrets manager, not browser or Git.
- Session-authenticated booking API, quote expiry, typed amounts, currency and network.
- Amounts in smallest units (integer) and reconciliation after confirmation.
- Human approvals for credit-policy exceptions, unverified creative and nonstandard refunds.
- No raw face storage by default; handle payment metadata according to provider docs.
