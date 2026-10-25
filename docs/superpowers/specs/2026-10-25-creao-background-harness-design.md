# CREAO background harness + full sponsor network

Date: 2026-10-25 · Status: drafted from product conversation; awaiting partner approval  
Coordination: this session (CREAO / invite / price) · sibling session (Convex durable jobs / reactive ops)

## Intent

Make CREAO the **background business harness** that keeps deal quality high, while Convex remains the **fast dealer** for each live window. Seed the **full official Cal Hacks 13.0 sponsor company pool**, but each billboard only invites the **top 10 vibe matches**. When companies keep losing or rejecting price, Invite CREAO re-ranks and rotates someone else in from that same official pool, then runs the same enrichment path used for today’s ten.

Remove CREAO and the product still sells (formula + Bitdeer/rules + code who-wins). What dies is accuracy and revenue quality: stale brand factors, wrong invites, weaker matching.

## Goals

- Full official Cal Hacks **company** sponsor network seeded (campaign + YouTube creative + buyer agent + knowledge/research enrichment), not only the current ten.
- Per billboard: invite at most **10** best matches to the current screen/audience schema.
- **Price CREAO**: background-only; tunes brand/price factors for the next windows. Does not invite.
- **Invite CREAO**: background-only; triggers when companies constantly lose / reject price; re-ranks the official pool and rotates the active ten.
- New/rotated companies **auto-enter** the next eligible rounds after enrichment completes (same desk as the original seed: knowledge → company research → creative path → price factor).
- Fast path unchanged in ownership: host price formula, host counter rules, buyer Bitdeer-or-rules, highest agreed wins, x402/holds in Convex.

## Non-goals

- CREAO does not bid, counter, hold, or pay inside the ~30s window.
- Open-web companies are **not** auto-invited into live rounds. Agency desk may draft outreach emails only (never auto-send); official pool stays Cal Hacks sponsors with usable creatives.
- Replacing Sales/Revenue rehearsal as the live dealer (left out of the live path; rehearsal panel may remain as a demo artifact).
- Changing Coinbase x402 settlement or live round clock.

## Anti-goals

- Holding a live request open waiting for a CREAO run.
- Letting an agent start itself in a credit loop.
- Implying seeded/rotated sponsors signed up or paid BillboardOS (keep simulated labels).

## Constraints

- CREAO API Trigger runs take **minutes**; design async + webhooks/polling; keys server-side only.
- Live rounds must not call vector search; knowledge retrieval is background/context assembly only (existing company-knowledge design).
- Credits: orchestrator (Convex) starts agents; cap runs; no agent→agent self-start.
- Official YouTube creatives preferred (oEmbed-checked), mirroring `convex/fixtures/sponsors.ts`.

## Architecture (decided)

```text
[Full official sponsor pool] --seed/enrich--> Convex tables
        ^                                      |
        |                                      v
 Invite CREAO (bg)  <--- chronic lose/reject --- live rounds (fast)
        |                                      ^
        +--> rotate top-10 roster --------------+
                                               |
 Price CREAO (bg) --> companyResearch.priceFactor / brand inputs
                                               |
 Company Research / Screen Audience / Creative Safety (existing bg)
        --> tags, summaries, creative gates the fast path already reads
```

### Roles

| Seat | Owns | Does not own |
|---|---|---|
| Price CREAO | Background refresh of price/brand factors | Invites, bids, settlement |
| Invite CREAO | Active-10 roster per billboard; rotate on chronic lose/reject; pull next best from full official pool | In-window pricing or negotiation |
| Company Research / Screen Audience / Creative Safety | Enrichment desk (existing) | Deals |
| Convex fast harness | Invite list consumption, windowPrice, counters, Bitdeer buyer assist, winner, hold/pay | Multi-minute strategy |

### Pool definition (decided: **full**)

Include **all official Cal Hacks 13.0 company sponsors** that can plausibly act as advertisers:

**Already seeded (10):** Anthropic, Coinbase, Convex, Microsoft, Fetch.ai, CREAO, Capital One, Apify, Cartesia, Bright Data.

**Add at minimum (from Anchors, Golden Bear, and prize/tool tracks):** Annapurna Labs, Spacetime, Hyphenate, Visa, Supercell, Bitdeer AI, CRS, Moss, Factory, Armadin, Meta, Figma, Notability, Mana, SpaceXSI, Elastic, Atlassian.

**Also include** other named company sponsors on the official Devpost/guide roster when a usable public YouTube (or equivalent demo creative) exists. **MLH co-prize brands** (Gemini/Solana/Tiger Data/Vultr/Snowflake/GoDaddy Registry) are in the full-pool intent when they are distinct advertiser entities with a usable creative; skip pure swag/fellowship entries with no brand advertising surface.

Builder call if a specific name has no oEmbed-safe creative: park them in the pool as `enrichment: blocked` and never invite until a creative exists — do not invent fake ads.

### Invite / rotate rules (decided)

- Ranking input: current billboard audience schema (tags/summary) vs company research/target audience; reuse existing match scoring where possible.
- Active set size: **10** per billboard.
- Rotate trigger: company **constantly losing** deals and/or **constantly rejecting** bid price (exact streak thresholds = builder call with sensible defaults, e.g. N consecutive losses or rejects in a windowed lookback).
- On rotate: drop chronic loser from active ten → Invite CREAO selects next-best not currently active → ensure campaign/creative/agent exist → run enrichment like seed → auto-eligible for subsequent rounds (not mid-window injection).

### Price CREAO (decided)

- Runs on cadence and/or after closed windows.
- Writes only fields the fast path already trusts (e.g. `companyResearch.priceFactor` and related brand inputs).
- Never changes invite roster.

## Coordination with sibling Convex session

Sibling session owns deepening Convex (durable workflows/jobs, reactive status, tables as the CREAO↔sale contract). This design requires that session to:

1. Persist **network membership** (full pool) vs **active invite roster** (top 10 per billboard).
2. Record **lose/reject streaks** from round outcomes for Invite CREAO triggers.
3. Own **durable background jobs** that start Price CREAO / Invite CREAO and write results into those tables.
4. Keep UI as `useQuery` on job/roster status — no browser-orchestrated CREAO.

This session / CREAO track owns agent prompts, tools (including vector-search context assembly), and run wiring once env IDs exist.

## What’s left to the builder

- Exact schema fields for roster, streaks, job status.
- Streak thresholds and ranking formula weights.
- Fixture expansion: YouTube URLs, budgets, summaries for each added sponsor.
- CREAO saved-agent creation + env keys for Price and Invite roles.
- Cron/cadence numbers and credit caps.
- Whether Opportunity Strategy prompt is retired or reused as Invite CREAO.

## Evidence / demo story

- Show full network seeded; one billboard’s active ten highlighted.
- Run windows; force or show chronic reject/lose → Invite CREAO rotates a new official sponsor in → enrichment runs → next window includes them.
- Show Price CREAO updating a factor between windows.
- Pitch line: “Remove CREAO and we still clear the window — but the desk goes blind and revenue quality collapses.”

## Sources

- Product conversation 2026-10-25 (this transcript + sibling Convex deep-dive session).
- Existing: `docs/architecture/creao-live-workflow.md`, `docs/sponsors/creao.md`, `convex/fixtures/sponsors.ts`, `docs/competition/sponsor-tracks.md`, Cal Hacks 13.0 Devpost prize list.
