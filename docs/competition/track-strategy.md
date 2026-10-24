# Sponsor-track strategy for BillboardOS

This page is **our proposal**, not an official sponsor assessment. Maximize a **single cohesive working product**, not the number of APIs mentioned.

| Priority | Track | BillboardOS feature that could meet it | Minimum convincing proof | Risk |
|---|---|---|---|---|
| P0 | Hyphenate finance | Receivables/payment ops + booking reconciliation and exception handling | Two or more collaborating finance roles, messy ledger case, decision log, escalation and live recovery | Need genuine autonomous finance rather than a generic sales chatbot |
| P0 | Coinbase x402 | Machine buyer pays x402-protected inventory booking endpoint | Real payment-required response, supported buyer payment, verified proof, idempotent booking | Network/wallet setup; separate sponsor track eligibility not yet confirmed |
| P1 | CRS | Advertiser risk verification informs permitted terms/review | Actual sandbox request using supplied identities; meaningful downstream decision | Available endpoint may not fit business-verification scenario |
| P1 | CREAO One-Person Company | Owner monitors AI-led quotes, sales, booking and billing | One operator controls complete multi-agent loop | Must meet sponsor's separate eligibility |
| P1 | Microsoft | Production-minded end-to-end agent product | Useful measurable task, explicit safety gates and working demo | Scope creep |
| P2 | Convex | Live inventory availability, holds, transaction events and dashboard | Demonstrably real-time shared state, not ordinary CRUD | Backend rework |
| P2 | Visa | Advertiser campaign shopping flow | Complete useful checkout with trust controls | May not match consumer-shopping intent |
| P2 | Factory Droid SDK | Bounded automated remediation / operations | SDK does visible work triggered during running demo | SDK adds engineering overhead |
| P2 | CREAO Disruptor / Team Empowerment | Autonomous physical-media commerce / review queue | Working roles and outcomes | Shared prize pool, inspect requirements |
| P3 | Apify / Bright Data | Public advertiser prospecting / event signals | Real live public data materially powers product | Scraping reliability; Bright Data demo forbids mocks |
| P3 | Cartesia / Moss / Fetch.ai | Core voice or distinct agent integration | Demonstrate real product usage | Unnecessary unless central to experience |

## Recommended entry plan

**Primary narrative:** 'BillboardOS hires an autonomous billboard revenue-operations team.' Give the judges the seats it fills: *inventory/pricing analyst*, *accounts receivable and payment reconciliation clerk*, and *campaign operations coordinator*.

**Memorable demo failure case:** Two advertiser agents want the same screen/time slot; another invoice shows a missing payment receipt. The system creates a temporary hold, blocks double allocation, verifies payment before confirmation and escalates mismatched receipts with an auditable trace. Show the economic consequence, not just a conversation transcript.

**Sponsor integrations are gated:** implement core deterministic booking/payment state machine first; enable only sponsor API integrations the team has keys for and can demonstrate honestly. Do not imply a mock CRS or x402 endpoint qualifies.

## Evidence checklist

- [ ] Hyphenate: role description, limited permissions, audit trail, exception case, live scenario
- [ ] Coinbase: genuine x402-compatible payment exchange and verification + booking transition
- [ ] CRS: real sandbox query with documented test identity + traceable risk decision
- [ ] CREAO: agent carries out business action, not just recommendation
- [ ] Microsoft: measurable usefulness, end-to-end flow, responsible design and production path
- [ ] Judge-facing: clear 'real / simulated / pending' status table

For the **complete guide-stated sponsor catalog**, see [sponsor tracks](sponsor-tracks.md).
