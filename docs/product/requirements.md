# MVP product requirements

Status: **proposed engineering specification**, subject to team approval.

## P0 acceptance criteria

| ID | Requirement | Demonstrable acceptance test |
|---|---|---|
| P0-01 | Register at least one display with available time slots | Show screen ID, location label, slot time, duration and status |
| P0-02 | Accept a campaign brief (form + optional document upload) | Extract budget, city, audience goal, creative, duration and constraints; request clarification for missing data |
| P0-03 | Estimate context-driven price | Price changes predictably when measured footfall changes; operator floor respected |
| P0-04 | Quote against available slots | Quote has price, currency, slot IDs, expiry and provenance |
| P0-05 | Enforce exclusive slot holds | Two buyers cannot hold or confirm the same time range concurrently |
| P0-06 | Require verified payment before confirmation | False/replayed/expired payment never confirms booking |
| P0-07 | Schedule an approved creative | After paid booking, on-device screen plays the right asset during a scheduled demo time |
| P0-08 | Record playback receipt | Receipt contains booking, device, timestamp, asset hash and status; don't call it measured audience reach |
| P0-09 | Operator overview | See available/held/confirmed slots, sales, payment exceptions and activity log |
| P0-10 | Audit agent actions | Every state-changing agent tool call has actor, input IDs, decision reason, result and timestamp |

## P1 if core is stable

- Real x402 payment through the sponsor-supported environment.
- CRS sandbox risk screening, **only using appropriate provided test identities and supported endpoints**.
- Advertiser/billboard agents exchanging constrained quotes and counteroffers.
- Live push updates to dashboard (Convex or equivalent).
- Human review for out-of-policy prices, unclear payment or unsafe creatives.

## P2 / stretch

- Public-web prospecting, CRM/email, multi-screen bundles, seasonal demand forecasting, live voice interaction.
- Multi-city synthetic inventory with explicit simulation disclosure.

## Non-functional rules

- Fail closed on unverified payment, out-of-bounds price and conflicting inventory.
- Make payment webhooks/events idempotent.
- Retain no raw camera feed by default; use aggregate counts and privacy-safe source metadata.
- Test playback without internet where practical.
- Isolate external services behind adapters; a sponsor sandbox outage must not corrupt booking state.
- Store API keys server-side only; use sandbox/test wallets and capped spend.

## Definition of done

Successful judge flow: real sensor reading (or explicitly labeled simulation), reproducible quote, safe hold, verified checkout (or separately labeled mock), booked inventory, visible screen change, auditable receipt and updated owner dashboard. All limitations disclosed.
