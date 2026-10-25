# Four CREAO agents for the BillboardOS pipeline

These are the source-controlled creation prompts for the next four CREAO agents. Create them in the **existing team workspace**. The two older [Sales and Revenue agents](../README.md) are a separate fictional rehearsal.

| Agent to create | Prompt | BillboardOS trigger | Result |
| --- | --- | --- | --- |
| BillboardOS Company Research | [company-research.md](company-research.md) | Advertiser created or ad changes | Company summary, audience tags and price factor |
| BillboardOS Screen Audience | [screen-audience.md](screen-audience.md) | Screen setup and hourly refresh | Audience mix and summary |
| BillboardOS Creative Safety | [creative-safety.md](creative-safety.md) | Creative submitted | Content finding for host policy |
| BillboardOS Opportunity Strategy | [opportunity-strategy.md](opportunity-strategy.md) | Future background planning stage | Advisory campaign ranking |

The first three replace the three current Claude jobs once their agent IDs and keys are configured on the shared Convex deployment. The fourth has **no live trigger yet**: it does not replace a Claude call, and no strategy recommendation is applied to sales. The eight-second buyer decision remains on Bitdeer/rules. A CREAO run can take minutes, so no CREAO agent runs in that live bidding window.

## Create and connect in the existing workspace

1. Open each prompt above in a separate CREAO chat. Supply the whole prompt as the creation instruction, exercise it with its matching [fictional example](examples), inspect the result, then use **Create Agent**. Use the exact agent name in the table and one required **text** input called `request_json`. Set the JSON artifact title specified by the prompt. The backend also accepts a complete JSON object in the run's `result.text` field. The Creative Safety example deliberately omits media and should return `needs_input`.
2. Open the existing team workspace's **Agents** section and add each saved agent with **+ Add** if it was created in a personal space. Record its UUID from the agent page. Workspace membership and permission to create/add agents must be checked in CREAO by a signed-in teammate.
3. On each new agent's detail page, create an app-scoped `capi_` key. An old Sales or Revenue key cannot run a new agent. Store the four new UUID/key pairs in the shared Convex deployment as below. Never commit keys or put them in browser code. An account-level `cr_sk_` key uses a different API path and is not accepted by this integration.
4. Configure **one role at a time** and test with a fictional entity or safe development data before enabling it on the shared app. A configured CREAO role runs first; company and screen jobs use rules if the run fails. A creative review failure holds the ad for host inspection. An unconfigured role continues through its current Claude/rules path. Creative Safety never approves when its agent reports `needs_input`.

```dotenv
CREAO_COMPANY_RESEARCH_AGENT_ID=
CREAO_COMPANY_RESEARCH_API_KEY=
CREAO_SCREEN_AUDIENCE_AGENT_ID=
CREAO_SCREEN_AUDIENCE_API_KEY=
CREAO_CREATIVE_SAFETY_AGENT_ID=
CREAO_CREATIVE_SAFETY_API_KEY=
CREAO_OPPORTUNITY_STRATEGY_AGENT_ID=
CREAO_OPPORTUNITY_STRATEGY_API_KEY=
```

The Opportunity Strategy values are reserved for its later planning hook; setting them alone does not start runs. The three active integrations live in `convex/researchNode.ts` and `convex/creativeReviewNode.ts`, with the private CREAO runner in `convex/creaoLive.ts`. The runner authenticates server-side, polls an async run, checks the result's role and trace, and accepts only the named JSON artifact or a complete JSON `result.text`. Company, screen and creative identifiers are checked again before results are stored. Creative approval still goes through the host workspace policy. All outcomes remain in the current Convex data model; no CREAO agent can book a slot, place a bid or charge a wallet.

The Company Research input includes a bounded, cited card from `companyKnowledgeSearch:agentContext`, which uses the ten curated sponsor profiles and Bitdeer `BAAI/bge-m3` retrieval when available. Campaign briefs and ad metadata are labeled simulated. Screen Audience uses place, local time and events; camera measurements remain the source for actual people counts. Creative Safety receives the current creative URL and metadata, and its `creativeRef` must match the current upload before any policy decision applies.

## Status as of 2026-10-24

- The four prompts are ready for teammates to create. **No IDs or keys for these four agents are in the repository.** Their creation and a successful live API run have not been verified here.
- The first three code paths are connected but inactive until their own CREAO UUID/key pairs are set on the deployment. The fourth remains an advisory design.
- Keep the older Sales/Revenue rehearsal while demonstrating it as simulated; do not present it as the live pipeline.

CREAO references: [saved agents](https://docs.creao.ai/features/agents), [workspaces](https://docs.creao.ai/features/workspaces), [API Trigger and key scopes](https://docs.creao.ai/pro/api-trigger).
