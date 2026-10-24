# Hyphenate — The Hyphenated Enterprise: Autonomous Systems for Finance

| | |
|---|---|
| **Type** | **Concept track.** "Models and frameworks. Use whatever you like." |
| **Prizes** | $8,000 / $5,000 / $3,000 for 1st–3rd; expedited interview process for the top 5 |
| **Our target** | **P0 — primary narrative** |
| **Rules status** | Full track PDF read |
| **Sources** | `docs/original/CalHacks_Hyphenate_Track.pdf` · [Official guide] printed p. 13 · [hyphenate.ai](https://hyphenate.ai) |

## The brief

"Build the system a finance team would bring on board." Pick a company and **one corner of its finance team**: a few seats that work closely together, like the accountant who applies customer payments and the person who chases the late ones. Build the autonomous system you'd hire to fill them, **and the company it works in**: the software it uses, the people it answers to, and the mistakes hiding in its data. Be imaginative about the company, strict about how it works underneath.

## What makes it hard (what judges look for)

| Difficulty | What it means for us |
|---|---|
| **Sources that disagree** — bank, ledger and contract each tell a slightly different story; know which to trust and say why. | x402 receipts, Nessie bank deposits and booking contracts disagree in planted cases. |
| **Time** — what happened in March should change what the system does in June. | Payment history per advertiser changes terms and collections tone; past disputes are remembered. |
| **Working with others** — approvers are busy, colleagues hand work over half done, the controller sometimes says no. | Controller approval queue; the system handles a "no" and a delayed answer. |
| **Limits** — no one gets access to everything; whoever requests a payment can't approve it. | Role-scoped tools; the agent that requests a refund can't approve it. |
| **Explainable and accountable** — every call traces back to the data, rule or person behind it. | Append-only audit trail with evidence pointers for every decision. |

## Relevant sample workflow

The track lists ten finance functions. Ours is **Accounts Receivable**: "Invoices go out with the right sales tax, payments come back short, late or bundled together, and someone decides who to chase, how hard, and when a dispute needs a person." **Cash & Treasury** matching (every bank transaction matched to what it pays for) is a close second.

## Judging — four questions

| Question | What it means |
|---|---|
| **Is it real enough?** | Realistic data, a messy problem, and proof that it works. |
| **Would you hire it?** | For which seats, and would it earn them: limited access, a clean record of its work, and knowing when to ask? |
| **Did we see something new?** | A company, problem or approach not made autonomous before. |
| **The moment** | When it catches what others missed, recovers from something going wrong, or defends a decision when questioned. |

## What to submit

- [ ] A **demo video that opens with the moment**.
- [ ] A **live demo** at judging, running for real. Judges may ask us to try **a scenario of their own**.
- [ ] **One line** on the seats the system fills.
- [ ] **Proof it works:** what's real, what's simulated, and how we know — a test set, **planted errors with an answer key**, or a benchmark score.

## Key concepts the system must embody

Double-entry bookkeeping · general ledger · chart of accounts · journal entries (dated, with a reason) · subledgers rolling into the GL · system of record per data type · reconciliation (explain every difference) · period close (locked entries) · materiality thresholds · internal controls · **segregation of duties** · audit trail (who, what, when, why) · controller sign-off.

## Resources Hyphenate suggests

- **Sandboxes:** Stripe, Increase, Lago, Odoo, ERPNext
- **Ledgers:** Formance Ledger, Blnk, TigerBeetle, Beancount and Fava
- **Mocks:** Mockoon, Prism, stripe-mock
- **Data:** SEC EDGAR, public GitHub repositories
- **Benchmarks:** AccountingBench, APEX-Accounting, Finance Agent Benchmark, DABstep, BenchRec, Invoice Sandbox Benchmark
- **People:** "A model can play the approver, the colleague or the auditor."

## How BillboardOS fits (proposed)

**Seats line (draft):** "BillboardOS fills the accounts-receivable clerk and collections specialist seats for a digital billboard operator, reporting to a human controller."

- The company: a small billboard operator with screens in SF (plus seeded history for Times Square and Seattle).
- Its software: Convex ledger and booking system, x402 for agent payments, Nessie as the bank, CRS for credit, CREAO agents for collections outreach.
- Its people: the operator/controller (human), possibly a model playing an auditor who questions a decision.
- Its mistakes: planted short, late, bundled and duplicate payments, plus a payment against an expired hold, with an answer key.
- The moment: see [ADR 0002](../decisions/0002-sponsor-native-stack.md#the-hyphenate-moment-revised).

## Open questions

- [ ] Do we need a model-played auditor to "defend a decision when questioned" live?
- [ ] How many months of seeded history make the "Time" dimension convincing?
