# Sponsors we're targeting

One page per sponsor, each with the same layout so people and coding agents can find requirements quickly:

1. **Summary table:** tool required vs concept track, prizes, our priority, how complete the rules are, sources.
2. **Requirements and judging criteria**, quoted or closely paraphrased from the sponsor's own material.
3. **Platform constraints** that affect the architecture.
4. **How BillboardOS fits:** our proposal, not a sponsor requirement.
5. **Evidence checklist** for the demo and Devpost.
6. **Open questions.**

Rules come from the official guide, sponsor pages and files in `docs/original/`. Re-check before submitting; sponsors update them.

## Overview

| Sponsor | Track(s) | Type | Our priority | Rules status |
|---|---|---|---|---|
| [Hyphenate](hyphenate.md) | Autonomous Systems for Finance | Concept | **P0** (primary narrative) | Complete |
| [Coinbase](coinbase-x402.md) | Payment Agents · Trading Agents (choose one) | Tool | **P0** — **decided: Payment Agents** | Complete |
| [CREAO](creao.md) | AI-First Disruptor · One-Person Company · Team Empowerment | Tool | **P1** — **decided: One-Person Company** | Home tab only; Tech Stack tab pending |
| [CRS](crs.md) | Financial Intelligence Challenge | Tool | P1 | Good; endpoint list arrives by email |
| [Convex](convex.md) | Best Use of Convex | Tool | P1 | One-line description only |
| [Capital One](capital-one-nessie.md) | Best Use of Nessie | Tool | P1 | Criteria only; API docs not captured |
| [Anthropic](anthropic.md) | Anthropic track | Tool + concept | P1 | Guide text |
| [Microsoft](microsoft.md) | Built for the Real World · Customer Impact | Concept | P1 | Guide text |
| [Fetch.ai](fetch-ai.md) | Best Use of Fetch.ai | Tool | P2 | Complete |

**Tool** means the product must use the sponsor's technology live in the demo. **Concept** means judges score the problem and execution, whatever the stack.

Sponsors we aren't targeting, and why, are listed in [ADR 0002](../decisions/0002-sponsor-native-stack.md#tracks-deliberately-not-targeted). The full guide catalog is in [sponsor tracks](../competition/sponsor-tracks.md).

## Shared Devpost checklist

- [ ] Whether Devpost limits how many sponsor tracks one project can enter.
- [ ] A **real / simulated / pending** table in the README (Hyphenate requires it; it helps every track).
- [ ] README links: CREAO run share link + agent IDs; Fetch.ai agent names, addresses and badges.
- [ ] No API keys in the repo, browser code or screen recordings.
