# Capital One — Best Use of Nessie

| | |
|---|---|
| **Type** | **Tool required.** Use the Nessie API. |
| **Prize** | $300 Giftogram per person on the winning team |
| **Our target** | **P1** — the bank in our finance story |
| **Rules status** | Only the guide's criteria; no external rules page |
| **Sources** | [Official guide] printed p. 10 · [nessieisreal.com](https://nessieisreal.com) |

## Judging criteria

Completeness · Creativity · Complexity.

## API

- Base URL: `https://api.nessieisreal.com` (answers over HTTPS as of 2026-10-24; plain HTTP times out).
- The docs site renders with JavaScript, so key signup and the endpoint list weren't captured. Nessie is a mock banking API (customers, accounts, deposits, transfers, bills, purchases); **verify endpoints at signup.**

## How BillboardOS fits (proposed)

Nessie is the operator's **bank**. Advertisers on invoice terms pay by deposit or transfer into the operator's Nessie account. Planted short, late and bundled payments make the bank disagree with the ledger and the contract, which is what [Hyphenate](hyphenate.md) asks for. The AR agent matches Nessie transactions to Convex invoices.

In the real-vs-simulated table, label Nessie as a **simulated bank**.

## Evidence checklist

- [ ] Live Nessie calls during the demo (deposits read, not hard-coded).
- [ ] At least one mismatch caught and explained from Nessie data.
