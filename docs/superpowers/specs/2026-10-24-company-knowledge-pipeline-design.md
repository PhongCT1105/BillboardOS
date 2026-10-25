# Company knowledge pipeline

Date: 2026-10-24 · Status: approved in conversation after scope correction

## Intent

Enrich the ten simulated sponsor advertisers with current, cited company facts. Store source passages in Convex, embed them through Bitdeer `BAAI/bge-m3`, and retrieve relevant passages through Convex vector search. Give future CREAO agents a bounded, cited company context that they can use for research, audience interpretation, and creative review. Keep the live sale and Coinbase x402 path unchanged.

## Current state

- The ten sponsors in `convex/fixtures/sponsors.ts` have short summaries, YouTube creatives, manually chosen audience tags, and simulated budgets. `sponsors:seed` creates their campaigns and schedules Claude research.
- In the development deployment, all ten have `companyResearch` rows marked `claude`, and none has a `knowledgeCards` row. `companyResearch` drives round matching and brand value. The current code does not write `knowledgeCards`; creative review's lookup there therefore adds no category for these ten.
- No embeddings, vector index, or semantic retrieval exist. Bitdeer is currently called only for short buyer decisions when configured.

## Approaches

| Approach | Benefit | Limit |
|---|---|---|
| Structured company rows only | Lowest change; rounds already use them | Cannot retrieve source evidence; does not use the requested embedding model |
| **Structured rows plus embedded source passages** | Facts stay auditable and retrieval is reusable by CREAO | Needs ingestion, embedding lifecycle, and one vector index |
| Put all knowledge inside CREAO | Agent-visible | Duplicates Convex state and cannot directly serve the live round |

**Chosen:** structured rows plus embedded source passages. `companyResearch` remains the fast projection used by live rounds. Vector search supports background research and context assembly; it never runs during a sale.

## Data contract

For each of the ten companies, curate a small profile from official current public sources: what it sells, who it serves, product/category terms, and relevant creative metadata. Store the compact structured profile in `knowledgeCards` with a new `curated` method so creative review can use its category. Store each source as a compact passage with URL, title, retrieved/verified date, content hash, advertiser ID, and source kind. Keep externally sourced facts distinct from inferences and from project-created budget, campaign preference, wallet, and payment fields. Do not imply that a real sponsor signed up or paid BillboardOS.

Source ingestion is idempotent by advertiser + URL + passage key. A changed passage supersedes its older version. The embedding record stores model ID, source hash, embedded time, and a `1024`-number vector; reject a response with another dimension, non-finite values, or the wrong count. Use `BAAI/bge-m3` for both documents and queries. Add a Convex vector index filtered by advertiser ID where useful. An embedding outage leaves source passages readable and never blocks a round.

For a known company, retrieve its structured profile by advertiser ID first. For a free-form question, embed the query in an action, search the source vectors, hydrate a bounded top-K set, drop stale/superseded passages, and return excerpts with URLs and timestamps. Similarity is for locating evidence, not for deciding audience percentages or a price factor.

The context builder for future CREAO agents returns the structured `companyResearch` row, the curated profile, relevant cited passages, creative metadata, and clear provenance labels. It has a fixed size limit. CREAO agent runs, IDs, and new-workspace credentials are a later wiring step once that workspace exists. The old Sales and Revenue rehearsal IDs and keys are not used.

## Boundaries and verification

- No new source scraping in the live sale; research, embedding, and retrieval are background/operator actions.
- No change to round pricing, bidder limits, holds, wallet funding, or Coinbase x402 settlement.
- Sponsor budgets and campaigns remain labeled simulated; public-source facts carry citations and a verified date.
- Tests prove idempotent ingestion, version replacement, vector validation, company filtering, citation-rich retrieval, empty retrieval, and fallback when Bitdeer is unavailable.
- A development smoke check shows all ten curated profiles, indexed embeddings, and a meaningful query result. Production data is not changed by the seed without an explicit deployment decision.

## Deferred

San Francisco versus New York screen comparisons, new screen fixtures, city restriction enforcement, CREAO saved-agent creation, and CREAO runtime cutover are separate follow-up work. This phase prepares context for those agents without changing the current direct Claude calls.

## Sources

- [Bitdeer Cal Hacks starter pack](https://www.bitdeer.ai/en/blog/bitdeer-ai-starter-pack-for-cal-hacks-13-0/), [embedding API](https://developers.bitdeer.ai/docs/api/bitdeer-llm/inference/create-embeddings), and [BAAI model card](https://huggingface.co/BAAI/bge-m3): model and vector dimension.
- [Convex vector search](https://docs.convex.dev/search/vector-search): action-only search and fixed-dimension vector index.
- [CREAO API Trigger](https://docs.creao.ai/pro/api-trigger): future asynchronous agent runs with server-side credentials.
