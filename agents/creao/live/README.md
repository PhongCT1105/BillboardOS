# CREAO agents for the BillboardOS pipeline

Source-controlled creation prompts for the CREAO agents that belong in the **existing team / sponsor workspace**. Create them there (not as one-off personal chats), then wire UUID + `capi_` keys into Convex.

The older [Sales and Revenue agents](../README.md) stay a separate fictional rehearsal and are **not** on the live deal path.

| Agent to create | Prompt | BillboardOS trigger | Result |
| --- | --- | --- | --- |
| BillboardOS Company Research | [company-research.md](company-research.md) | Advertiser created or ad changes | Company summary, audience tags and price factor |
| BillboardOS Screen Audience | [screen-audience.md](screen-audience.md) | Screen setup and hourly refresh | Audience mix and summary |
| BillboardOS Creative Safety | [creative-safety.md](creative-safety.md) | Creative submitted | Content finding for host policy |
| BillboardOS Price Refine | [price-refine.md](price-refine.md) | Price harness (hourly / stale brands) | Updated `priceFactor` only |
| BillboardOS Invite Rotate | [invite-rotate.md](invite-rotate.md) | Cool-down opens a roster hole | Prefer/demote weights for next invites |
| BillboardOS Opportunity Strategy | [opportunity-strategy.md](opportunity-strategy.md) | Future background planning stage | Advisory campaign ranking (no live trigger yet) |

Company Research, Screen Audience and Creative Safety replace the three current Claude jobs once configured. **Price Refine** and **Invite Rotate** are the CREAO half of the background harnesses: Convex still closes every ~30s deal; CREAO only refreshes accuracy and who sits in the top-10 invite set. A CREAO run can take minutes, so no CREAO agent runs inside the live bidding window. The eight-second buyer decision remains on Bitdeer/rules.

## Create and connect in the existing workspace

1. Open each prompt above in a separate CREAO chat. Supply the whole prompt as the creation instruction, exercise it with its matching [fictional example](examples), inspect the result, then use **Create Agent**. Use the exact agent name in the table and one required **text** input called `request_json`. Set the JSON artifact title specified by the prompt. The backend also accepts a complete JSON object in the run's `result.text` field.
2. Open the existing team workspace's **Agents** section and add each saved agent with **+ Add** if it was created in a personal space. Record its UUID from the agent page.
3. On each new agent's detail page, create an app-scoped `capi_` key. An old Sales or Revenue key cannot run a new agent. Store the UUID/key pairs on the shared Convex deployment as below. Never commit keys or put them in browser code.
4. Configure **one role at a time** and test with a fictional entity or safe development data before enabling it on the shared app. Unconfigured roles leave Convex on its rules / Claude fallback (or skip optional prefs for Invite).

```dotenv
CREAO_COMPANY_RESEARCH_AGENT_ID=
CREAO_COMPANY_RESEARCH_API_KEY=
CREAO_SCREEN_AUDIENCE_AGENT_ID=
CREAO_SCREEN_AUDIENCE_API_KEY=
CREAO_CREATIVE_SAFETY_AGENT_ID=
CREAO_CREATIVE_SAFETY_API_KEY=
CREAO_PRICE_REFINE_AGENT_ID=
CREAO_PRICE_REFINE_API_KEY=
CREAO_INVITE_ROTATE_AGENT_ID=
CREAO_INVITE_ROTATE_API_KEY=
CREAO_OPPORTUNITY_STRATEGY_AGENT_ID=
CREAO_OPPORTUNITY_STRATEGY_API_KEY=
```

Integrations live in `convex/researchNode.ts`, `convex/creativeReviewNode.ts`, `convex/priceHarness.ts`, `convex/inviteHarness.ts`, with the private CREAO runner in `convex/creaoLive.ts`. All outcomes remain in the current Convex data model; no CREAO agent can book a slot, place a bid or charge a wallet.

## Status

- Prompts for all six roles are ready for teammates to create in the CREAO workspace.
- **No IDs or keys are in the repository.** Create the agents in CREAO, then set env on the deployment.
- Price / Invite harnesses run in Convex either way; CREAO improves refine + rotate when configured.
- Keep Sales/Revenue rehearsal as simulated; do not present it as the live pipeline.

CREAO references: [saved agents](https://docs.creao.ai/features/agents), [workspaces](https://docs.creao.ai/features/workspaces), [API Trigger and key scopes](https://docs.creao.ai/pro/api-trigger).
