# Company Knowledge Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Curate ten cited company profiles, index their evidence with Bitdeer `BAAI/bge-m3`, and make bounded Convex retrieval context available for future CREAO agents.

**Architecture:** A deterministic seed upserts curated `knowledgeCards` and source passages for the ten simulated sponsor accounts. A background Convex action embeds changed passages and a separate action performs vector search, hydrates citations, and builds an agent context; live rounds continue to use their existing structured fields.

**Tech Stack:** Convex TypeScript, Bitdeer `POST /v1/embeddings`, `BAAI/bge-m3` (1024 dimensions), Convex vector search, Vitest/convex-test.

**Spec:** `docs/superpowers/specs/2026-10-24-company-knowledge-pipeline-design.md`

## Global Constraints

- Read `convex/_generated/ai/guidelines.md` before editing Convex code.
- Keep public company facts separate from simulated sponsor campaign budgets, preferences, wallets, and payments.
- No vector search, embedding call, or CREAO run in the live round transaction or its buyer response.
- Do not mutate production data while building or verifying this pipeline.
- Cap query results and agent context; include source URLs and observed dates.

## Review Focus

- Existing `knowledgeCards` rows for unrelated advertisers survive the sponsor seed.
- A changed passage invalidates its prior embedding; an unchanged passage does not duplicate it.
- Missing Bitdeer key or service failure leaves readable source data and returns an explicit indexing status.
- Wrong-size or non-finite vectors never enter the Convex vector index.
- Retrieval never returns a superseded passage or a passage from the wrong advertiser when filtered.

---

### Task 1: Curated company corpus and idempotent seed

**Files:**
- Create: `convex/fixtures/companyKnowledge.ts` — ten source-cited profiles and passages.
- Modify: `convex/schemaParts/knowledge.ts` — `curated` method; source passage table/index; optional 1024-number embedding and vector index.
- Modify: `convex/schema.ts` — include the source passage table.
- Create: `convex/companyKnowledge.ts` — internal seed and bounded read functions.
- Test: `convex/companyKnowledge.test.ts`.

**Interfaces:**
- `COMPANY_KNOWLEDGE`: `readonly` ten entries keyed by exact sponsor name; each has summary/category/stage/audienceTags and at least two public source passages with key/title/url/text/verifiedAt.
- `internal.companyKnowledge.seedSponsors({})`: `{ profiles: number, passages: number, changed: number }`, upserting only the ten sponsor advertisers already present.
- `internal.companyKnowledge.context({ advertiserId })`: curated card plus at most eight active passages and the current `companyResearch` row, without private wallet or payment fields.

- [ ] **Step 1: Write failing tests** proving ten unique profiles, official HTTPS source URLs, stable seed twice, changed content invalidates the embedding, and unrelated cards survive.
- [ ] **Step 2: Run** `npm test -- convex/companyKnowledge.test.ts`; expect failures for missing implementation.
- [ ] **Step 3: Implement** the seed and schema. Hash source text, use advertiser + passage key to upsert, mark superseded rows inactive, and leave the existing live `companyResearch` rows untouched.
- [ ] **Step 4: Run** the focused test and `npm run typecheck`; expect success.
- [ ] **Step 5: Commit** only Task 1 files after review.

### Task 2: Bitdeer embedding lifecycle

**Files:**
- Create: `convex/lib/bitdeerEmbedding.ts` — response validation and input construction.
- Create: `convex/companyKnowledgeEmbedding.ts` — background action and save mutation.
- Modify: `convex/convex.config.ts` only if an additional typed environment variable is needed; reuse `BITDEER_API_KEY`.
- Test: `convex/bitdeerEmbedding.test.ts`, `convex/companyKnowledge.test.ts`.

**Interfaces:**
- `embedTexts(texts: string[], key: string): Promise<number[][]>` calls `BAAI/bge-m3`; each vector is exactly 1024 finite floats.
- `internal.companyKnowledgeEmbedding.indexMissing({ limit?: number })`: bounded count of embedded/failed/remaining passages; no automatic retry of an in-flight call.
- `internal.companyKnowledgeEmbedding.save({ passageId, contentHash, vector, model })`: compare-and-set by content hash, so late results cannot index changed text.

- [ ] **Step 1: Write failing tests** for valid batch, HTTP failure, malformed count, 1023 dimensions, NaN/Infinity, and stale hash result.
- [ ] **Step 2: Run** focused tests; expect failures.
- [ ] **Step 3: Implement** bounded Bitdeer requests in an action, input/response validation, and stale-safe embedding writes.
- [ ] **Step 4: Run** focused tests and `npm run typecheck`; expect success.
- [ ] **Step 5: Commit** Task 2 files after review.

### Task 3: Vector retrieval and CREAO-ready context

**Files:**
- Create: `convex/companyKnowledgeSearch.ts` — internal vector search action and bounded cited context.
- Test: `convex/companyKnowledgeSearch.test.ts` or a local Convex smoke test if `convex-test` cannot emulate vector search.
- Modify: `README.md` — data status, ingestion/indexing commands, and clear simulated sponsor label.

**Interfaces:**
- `internal.companyKnowledgeSearch.search({ query, advertiserId?, limit? })`: at most eight active cited passages with score, title, URL, verified date, and source kind; embed the query with the same model.
- `internal.companyKnowledgeSearch.agentContext({ advertiserId, question })`: structured card + `companyResearch` projection + at most five retrieved citations, bounded to a documented size. The next CREAO integration consumes this result without reading raw vectors.

- [ ] **Step 1: Write failing tests** or smoke assertions for same-company filter, empty index, stale passage exclusion, citation fields, input bounds, and missing Bitdeer key.
- [ ] **Step 2: Run** the focused verification; expect failures.
- [ ] **Step 3: Implement** action-only vector search and a bounded context builder; keep exact-ID profile retrieval separate from semantic search.
- [ ] **Step 4: Run** focused verification, `npm run typecheck`, and `npm test`; expect success.
- [ ] **Step 5: On the development deployment only**, run the curated seed and indexer if `BITDEER_API_KEY` is available; verify ten profiles and a cited query result. Report explicitly if credentials or network prevent the live smoke check.
- [ ] **Step 6: Commit** Task 3 and documentation files after review.
