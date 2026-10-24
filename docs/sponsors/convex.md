# Convex — Best Use of Convex

| | |
|---|---|
| **Type** | **Tool required.** Convex as the real backend. |
| **Prize** | $5,000 cash to the winning team |
| **Our target** | **P1** — our backend per [ADR 0002](../decisions/0002-sponsor-native-stack.md) |
| **Rules status** | Only the guide's one-line description; no external rules page. Ask at the workshop ("Build Your Backend with Convex"). |
| **Sources** | [Official guide] printed p. 16 |

## What the guide says

"The reactive backend platform that keeps up with you and your agents. Database, functions, workflow, sync, search, file storage, and more. All TypeScript, zero glue."

No criteria are listed. Expect judges to reward using several of those features meaningfully rather than as CRUD storage.

## How BillboardOS fits (proposed)

| Convex feature | Use |
|---|---|
| Mutations (serializable transactions) | Atomic slot hold and booking confirmation; no double booking |
| Scheduler | Hold expiry |
| Crons | Collections runs, nightly reconciliation |
| Live queries (sync) | Operator console, advertiser portal and billboard player update instantly |
| File storage | Ad creatives |
| HTTP actions | x402 purchase endpoint, CREAO webhooks, Nessie sync |
| Actions | Calls to Claude, CRS, CREAO |
| Workflow component | Durable multi-step booking and collections processes |
| Search | Audit trail and advertiser lookup |

## Evidence checklist

- [ ] Show two browsers racing for the same slot; only one hold succeeds.
- [ ] Show the billboard screen changing instantly from a live query.
- [ ] README lists which Convex features are used and why.
