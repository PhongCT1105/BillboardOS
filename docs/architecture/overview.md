# System architecture

**Status:** Proposed architecture, not implemented. Keep execution deterministic and agent reasoning bounded.

> The logical components below map onto sponsor tools (Convex, Coinbase x402, Capital One Nessie, CRS, Claude, Fetch.ai) in [ADR 0002](../decisions/0002-sponsor-native-stack.md).

## Component map

```mermaid
flowchart TB
  subgraph UI[Web clients]
    Buyer[Advertiser portal]
    Owner[Operator console]
  end
  subgraph Control[Backend / transactional control]
    API[Authenticated API]
    Orch[Agent orchestrator]
    Policy[Policy and approval gate]
    Inventory[Inventory / quote / hold service]
    Finance[Payment / ledger / reconciliation service]
    Scheduler[Scheduler and playback receipt service]
    DB[(Transactional store and audit log)]
  end
  subgraph AgentTools[Bounded agent roles]
    Campaign[Campaign matching]
    Audience[Audience analysis]
    Price[Pricing / proposal]
    Negotiate[Sales negotiation]
    Risk[Risk review]
    Ops[Ad operations]
  end
  subgraph Integrations[External adapters]
    PSP[x402 payment/facilitator]
    CRS[CRS sandbox optional]
    Event[Events, weather and public context]
  end
  subgraph Edge[Physical layer]
    Camera[Camera/sensors]
    EdgeCount[On-device aggregate counter]
    Display[Display player]
  end
  Buyer --> API
  Owner --> API
  API --> Orch
  Orch --> Campaign & Audience & Price & Negotiate & Risk & Ops
  Orch --> Policy
  Policy --> Inventory & Finance & Scheduler
  Inventory <--> DB
  Finance <--> DB
  Scheduler <--> DB
  Finance <--> PSP
  Risk <--> CRS
  Audience <--> Event
  Camera --> EdgeCount --> API
  Scheduler --> Display
  Display -->|playback receipt| API
```

## Why split agents from services?

Agents may **propose** quotes, ask for evidence and choose next actions. They must not directly mutate inventory or declare payments settled. Deterministic services enforce price floors, timestamps, role permissions, uniqueness constraints, approval policy and payment proof. This is the auditable autonomy Hyphenate-style judging asks for.

## Critical sequence

```mermaid
sequenceDiagram
  participant B as Buyer
  participant A as Campaign/Pricing agents
  participant I as Inventory
  participant P as Payments (x402 adapter)
  participant D as Display
  participant O as Operator
  B->>A: Brief, budget, targeting
  A->>I: Search sellable slots
  I-->>A: Available slots + version
  A-->>B: Quote + expiry
  B->>I: Accept quote and request hold
  I-->>B: Hold ID + expiry
  B->>P: Pay for hold / protected endpoint
  P-->>I: Verified payment proof (idempotent)
  alt Valid and hold active
    I->>I: Atomically confirm booking
    I->>D: Publish approved schedule
    D-->>O: Playback receipt and status
  else Expired, collision or invalid payment
    I-->>O: Create review/refund/reconciliation task
  end
```

## Deployment boundaries

- **Browser:** campaign brief, quotes, negotiation UI, owner approvals and audit timeline.
- **Server:** authentication, API contracts, state transitions, wallet/payment verification and policy execution.
- **Database:** single source of truth for slots, holds, bookings, payment attempts, journal, creative assets and events.
- **Edge:** sensor aggregator and scheduled ad player. Process images locally when feasible.
- **External adapters:** sponsor APIs separately deployable/configurable, using mocks only in labeled development modes.

## Failure scenarios

- **Double claim:** unique/serialized hold per timeslot; buyer two sees unavailability.
- **Payment replay:** check chain/receipt/facilitator result, nonce/idempotency and amount/currency.
- **Expired hold after payment:** record exception; never silently book a different slot or discard funds.
- **CRS unavailable:** policy routes to manual review rather than inventing clearance.
- **Screen offline:** queue intended schedule, mark delivery unverified, report issue.
- **LLM hallucination:** quote numbers come from validated deterministic pricing function, not free-form text.

See [agents](agents.md), [payments/risk](payments-and-risk.md), [data model](data-model.md) and [requirements](../product/requirements.md).
