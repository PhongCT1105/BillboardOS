# Handoff: create Price Refine + Invite Rotate on CREAO

**PR:** https://github.com/PhongCT1105/BillboardOS/pull/13  
**Branch:** `feat/creao-price-invite-network`  
**Audience:** teammate with access to the shared CREAO **team / sponsor workspace**  
**Goal:** create two saved CREAO agents, smoke-test them, wire UUID + `capi_` keys into Convex. Do **not** build new BillboardOS product features unless something in the prompts is broken.

---

## Context (read once)

BillboardOS already sells spots in ~30s on Convex (Bitdeer/rules for buyer turns). CREAO is **background only**.

These two agents are new, same pattern as Company Research / Screen Audience / Creative Safety:

| Agent (exact name) | Prompt file | Example input | Artifact title | Convex env |
| --- | --- | --- | --- | --- |
| BillboardOS Price Refine | `agents/creao/live/price-refine.md` | `examples/price-refine.json` | `price-refine-result.json` | `CREAO_PRICE_REFINE_AGENT_ID` + `CREAO_PRICE_REFINE_API_KEY` |
| BillboardOS Invite Rotate | `agents/creao/live/invite-rotate.md` | `examples/invite-rotate.json` | `invite-rotate-result.json` | `CREAO_INVITE_ROTATE_AGENT_ID` + `CREAO_INVITE_ROTATE_API_KEY` |

Convex already calls them from `convex/priceHarness.ts` and `convex/inviteHarness.ts` via `convex/creaoLive.ts`. Until env is set, harnesses keep working with fallbacks.

**Out of scope for this handoff**

- Sales / Revenue rehearsal agents (demo only; not live deals)
- Opportunity Strategy (prompt exists; no live trigger yet — skip unless asked)
- Sending email, bidding, booking, or payments from CREAO

---

## Paste this into CREAO (or give to an agent helping you)

```text
You are helping create two BillboardOS CREAO agents in the EXISTING team/sponsor workspace (not a personal-only space).

For EACH agent below:
1. Open a new CREAO chat in the team workspace.
2. Paste the FULL contents of the prompt file as the creation instruction.
3. Add one required text input named exactly: request_json
4. Run a smoke test using the matching examples/*.json as request_json.
5. Confirm the output is valid JSON with schemaVersion: 1, the correct role string, matching traceId, and the required fields.
6. Save with Create Agent using the EXACT agent name.
7. Set the JSON result artifact title exactly as specified.
8. If the agent was created outside the team space, add it to the team workspace Agents list with + Add.
9. On the agent detail page, create a new app-scoped capi_ API key (do not reuse Sales/Revenue or other agents' keys).
10. Record: agent display name, UUID, artifact title, and that a capi_ key was created (paste the key only into Convex env — never into git, Slack, or the PR).

Agent A — BillboardOS Price Refine
- Prompt: agents/creao/live/price-refine.md
- Example: agents/creao/live/examples/price-refine.json
- Artifact title: price-refine-result.json
- role in result JSON must be: "price_refine"
- status: "refined" or "needs_input"
- priceFactor must be a number in [0.8, 1.5]
- Must NOT invent campaigns, invites, bids, bookings, or payments

Agent B — BillboardOS Invite Rotate
- Prompt: agents/creao/live/invite-rotate.md
- Example: agents/creao/live/examples/invite-rotate.json
- Artifact title: invite-rotate-result.json
- role in result JSON must be: "invite_rotate"
- status: "rotated" or "needs_input"
- prefs: array of { advertiserId, weight (-10..10), reason } using ONLY advertiserIds from the input
- Must NOT invent advertisers, clear cool-downs, contact buyers, or send email

When both agents pass the smoke test, reply with a short checklist:

### Done
- [ ] Price Refine UUID: <uuid>
- [ ] Invite Rotate UUID: <uuid>
- [ ] Both agents are in the team workspace Agents list
- [ ] Each has its own capi_ key (stored only in Convex env, not in chat)
- [ ] Example runs returned valid JSON artifacts / result.text

### Convex env to set (operator with deploy access)
npx convex env set CREAO_PRICE_REFINE_AGENT_ID <uuid>
npx convex env set CREAO_PRICE_REFINE_API_KEY capi_...
npx convex env set CREAO_INVITE_ROTATE_AGENT_ID <uuid>
npx convex env set CREAO_INVITE_ROTATE_API_KEY capi_...

### Optional verify after env is set
- Host console CREAO roster should show price_refine and invite_rotate as configured
- Price harness / invite cool-down can call CREAO; if unset, fallbacks still work

Do not commit secrets. Do not create Sales/Revenue as live agents. Stop after the two agents are created and documented.
```

---

## Human checklist (same work, shorter)

1. Pull PR #13 / branch `feat/creao-price-invite-network`.
2. Create **Price Refine** and **Invite Rotate** in the **team** CREAO workspace from the prompt files above.
3. Smoke-test with the example JSON files.
4. Create a fresh `capi_` key per agent.
5. Give Phong (or whoever has Convex access) the two UUIDs; set keys via `npx convex env set` on the shared deployment — **never commit them**.
6. Reply in the PR or Slack with the Done checklist (UUIDs only, no keys).

## Docs / references

- Pipeline overview: `agents/creao/live/README.md`
- Design: `docs/superpowers/specs/2026-10-25-creao-background-harness-design.md`
- CREAO: [agents](https://docs.creao.ai/features/agents) · [workspaces](https://docs.creao.ai/features/workspaces) · [API Trigger](https://docs.creao.ai/pro/api-trigger)
