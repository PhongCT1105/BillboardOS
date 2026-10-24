# Implementation roadmap and workstreams

The official guide requires all **project builds** to begin during the event (printed p. 7). This documentation is planning, not proof of a pre-built submission. Follow event rules when implementing and submitting.

## Phase 0 — alignment

- [ ] Agree on demo city/advertiser and specific problem.
- [ ] Confirm primary sponsor track(s) and read their full external rules.
- [ ] Acquire webcam, monitor, Wi-Fi, approved API sandbox credentials and test wallet where applicable.
- [ ] Define team owners, interfaces and fallback modes.
- [ ] Clarify what is original guide content vs user sketches vs proposed design.

## Phase 1 — reliable backbone (P0)

- [ ] Display + timeslot model with unique slot inventory.
- [ ] Campaign upload and brief parsing.
- [ ] Aggregate sensor input (or **visibly labeled simulation fallback**).
- [ ] Deterministic price calculator with policy floor and explainable features.
- [ ] Quote → time-limited hold → confirmed booking transaction.
- [ ] Screen player and playback receipt.
- [ ] Operator dashboard with simple timeline.

## Phase 2 — autonomy and money (P0/P1)

- [ ] Orchestrator and policy-bounded tools with trace IDs.
- [ ] Seller pricing/negotiation agent constrained by reserve price.
- [ ] Real sandbox x402 flow if keys and implementation are available.
- [ ] Payment reconciliation agent + duplicate/late/mismatch cases.
- [ ] CRS sandbox call with official test identities if endpoint genuinely fits.

## Phase 3 — differentiation

- [ ] Advertiser buyer agent, constrained to budget, negotiating with billboard seller.
- [ ] Multi-screen scheduling and packages.
- [ ] Live public demand signals or prospecting, only if sponsor rules allow.
- [ ] Active monitoring, fallback and human review paths.

## Parallel workstreams

| Stream | Deliverable | First cross-team interface |
|---|---|---|
| Hardware/CV | Local people-count aggregates + device player | `POST /api/audience/aggregates`; schedule JSON |
| Product/frontend | Buyer brief + owner dashboard | Quote/booking API + event journal |
| Backend/finance | Inventory, holds, payments, reconciliation | Atomic hold + payment state machine |
| Agent orchestration | Brief parser, pricing explanation, negotiation | Typed agent event/tool envelope |

For a 3-person team, combine frontend/product with display, while backend/finance and agent orchestration each own a stream. Do not assign names until agreed.

## Milestones that matter more than line count

1. Screen changes when a manually confirmed booking is scheduled.
2. Payment never falsely confirms a booking.
3. Two conflicting buyers can't both book the same slot.
4. A real agent handles a messy exception and explains its actions.
5. Sponsor APIs that are claimed actually run during judging.

## Demo rehearsal gate

Prepare the **2-minute** live flow, 30-second recovery path, a screenshot/video fallback clearly labeled as such, and a list showing **real vs mocked** components. No slide-only claimed integration.
