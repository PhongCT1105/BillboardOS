# Open design decisions

Use this file as a lightweight decision queue. Document outcomes under `docs/decisions/`.

| Question | Suggested default | Owner / status |
|---|---|---|
| Who is the first buyer? | Tech-event advertiser near SF | Team / open |
| Physical MVP | One laptop webcam + HDMI screen | Hardware / open |
| Real measurements | Aggregate pedestrian counts with no face retention | CV / open |
| Display runtime | Browser-based fullscreen player polling signed schedule | Platform / open |
| Data backend | TypeScript API plus Postgres, or Convex if track chosen | Backend / open |
| LLM orchestration | One bounded orchestrator delegating specialized tasks | Agents / open |
| Actual x402 sponsor environment | Validate docs, network, wallet, asset, facilitator and test balance | Finance / open |
| Risk screening | Confirm CRS sandbox entities and legal scope | Finance / open |
| Creative review | Operator must approve before publication in MVP | Operations / open |
| Multi-agent purchase | Constrained offer-counteroffer protocol, max rounds and policy floors | Agent team / open |
| Live prospecting | Defer until proof of booking and playback works | Growth / open |
| How to preserve official guide and audio | Upload with appropriate permissions; avoid publishing private audio | Team / open |
| Unclear image/audio details | Human review before adding as accepted decisions | Team / open |

## Decision log convention

For major changes add `docs/decisions/000N-short-name.md` containing: context, decision, alternatives, consequences, implementation status, and date.
