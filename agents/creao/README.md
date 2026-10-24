# BillboardOS on CREAO

Target: **Best One-Person Company**. Two separately saved agents hand off structured work:

`Sales qualification → Revenue strategy → Sales offer preparation → BillboardOS execution`

## Current setup status

- Both agents were created on 2026-10-24 under the owner's CREAO account, in Quang's team. The UI shows **Pro Plus**. Sending an email to the booth has not been claimed.
- [BillboardOS Sales Agent](https://agent.creao.ai/apps/82fa549a-99bd-402d-9990-4124d9f97cab): `82fa549a-99bd-402d-9990-4124d9f97cab`.
- [BillboardOS Revenue Agent](https://agent.creao.ai/apps/dc1b236c-1e3e-4db6-9134-7f406f6374d5): `dc1b236c-1e3e-4db6-9134-7f406f6374d5`.
- Creation-session rehearsal: Sales selected the fictional DevTools and Coffee campaigns, rejected the unconnected enterprise, and its actual JSON was supplied to Revenue.
- Two agent-scoped API keys were created with the owner's approval and stored only in ignored `.env`. The originally supplied key was unusable for these agents; the scoped keys work.
- A real API chain has completed on explicitly simulated business data: two qualified campaigns → one revenue plan → two prepared offers, zero deliveries. Revenue's explanatory rules were then corrected; verification of the updated version is in progress.
- [Successful Sales API run share](https://agent.creao.ai/share/53777b53b451c52b8adeb850770b3ec2), expires 2026-11-23. This is a conversation/run share link, not an agent install link.
- The first-run script is a server-side API smoke test. It does not implement or claim live outreach, auctions, payment or screen playback.
- Live seller tools and a Convex deployment connection still need to be configured. The existing customer agent API does not grant seller authority.
- Devpost is intentionally deferred at the user's request. Selecting the CREAO track and supplying the required evidence remain necessary for submission.

## Account and saved agents

1. Register using the [official Cal Hacks sign-up link](https://creao.ai/signup?hackathon=calhacks13&utm_source=calhacks13&utm_medium=hackathon&utm_campaign=hackathons-oct-2026). Use the account chosen by the owner. The owner handles Google verification and accepts any account terms.
2. Give the account email to the CREAO booth and ask them to verify the hacker upgrade/credits. A prepared message is below; it has not been sent.
3. In a new CREAO chat, use [sales.md](sales.md) and [rehearsal-sales.json](rehearsal-sales.json). Inspect the completed result, then use **Create Agent** or ask CREAO to save it as **BillboardOS Sales Agent**. Verify its only input field is `request_json` and it writes the canonical `sales-result.json` artifact.
4. In another chat, use [revenue.md](revenue.md), the same snapshot, and Sales' actual result. Inspect the result, then **Create Agent** as **BillboardOS Revenue Agent**, also with `request_json`.
5. Copy each agent ID from its page. Use an existing account `capi_` key as `CREAO_API_KEY`, or an app-scoped key as the corresponding role override. Store keys only in the local ignored `.env` or the server's secret store. Never paste keys into agent chat messages or source files. Creation of new credentials is performed with the owner's confirmation.
6. Run the API rehearsal below. Save one successful run's share link from the CREAO UI, after checking its contents are safe to share. An agent install link is not a run share link.

Booth message: "Hi, I'm participating in Cal Hacks 13.0 and building BillboardOS for Best One-Person Company. My CREAO account email is [your account email]. Could you verify the hackathon Pro Plus upgrade and credits?"

## First API run

The script uses only Node's built-in modules; Node 22.9+ is sufficient. `.env` is ignored by Git.

```dotenv
CREAO_SALES_AGENT_ID=
CREAO_REVENUE_AGENT_ID=
CREAO_API_KEY=
# Optional app-scoped overrides: CREAO_SALES_API_KEY, CREAO_REVENUE_API_KEY
```

```bash
# Local input check, no API calls or credits:
npm run creao:run -- --agent sales --input agents/creao/rehearsal-sales.json --check-input

# Calls the actual saved Sales Agent and polls for its result:
npm run creao:run -- --agent sales --input agents/creao/rehearsal-sales.json

# If polling was interrupted, resume the existing run without creating another:
npm run creao:run -- --agent sales --run-id <run-id>
```

Results are saved under ignored `.creao-runs/`. Use the completed Sales JSON as `salesResult` in a new request with the original `schemaVersion`, `traceId`, and `snapshot`, then call the Revenue Agent with `--agent revenue --input <request-file>`. Finally call Sales with `phase: "prepare_outreach"` and `revenuePlan` set to the Revenue result. No generated plan is automatically applied to live inventory by this script.

CREAO may generate a dashboard and prose even with a JSON-only instruction. The runner uses the explicitly named `sales-result.json` / `revenue-result.json` artifact as its machine contract; dashboard summary fields are not the full result. It verifies the CREAO artifact URL, sends authorization only to CREAO, follows the signed HTTPS storage redirect without credentials, and validates role/trace/snapshot identity. A transient read-only download may retry; starting a run never retries automatically. Blockers may be strings or records with an `id`.

For the complete three-stage rehearsal, use `npm run creao:rehearsal`. It calls the real saved agents sequentially with fictional business data and records each input/result in the printed directory. `--directory <previous-directory>` reuses completed stages with matching input. A stage that started but has no result must first be resumed with the logged run ID using `creao:run --agent <role> --run-id <id> --output <stage-result-path>`; the orchestration refuses to silently create a duplicate run.

## Integration and evidence still required

- Live snapshot: host-scoped inventory and opted-in buyer campaigns, without customer tokens, wallet keys, private contact details, or unrelated records.
- Validate all CREAO outputs on the server before business actions: ID membership, fresh snapshot, budget, integer money, floor/ceiling, common auction reserve and current availability.
- Store scoped BillboardOS tool credentials in CREAO **Secrets** only after the seller tool exists and its exact permissions are reviewed. Do not give a broad internal payment/admin secret to an agent.
- Start agents asynchronously; CREAO runs usually take minutes. Do not put a run in an eight-second bidding window. Coordinate handoffs in the backend, limit total runs, and never recursively trigger the same agent.
- Verify a webhook by fetching the run using the server-held CREAO key. Do not trust an unsigned callback body. Polling is the initial smoke-test path.
- Demonstrate a real run and a real downstream business action, with simulated buyers/events labeled accurately. A successful prompt rehearsal alone does not prove a live autonomous sales loop.
- Before submission: select CREAO on Devpost; add the agent IDs, a run share link, role/handoff diagram, and honest real/simulated/pending descriptions.

Sources checked 2026-10-24: [hackathon rules](https://community.creao.ai/CalHacks2026), [hackathon Tech Stack](https://community.creao.ai/CalHacks2026/tech), [saved agents](https://docs.creao.ai/features/agents), [API Trigger](https://docs.creao.ai/pro/api-trigger), [Secrets](https://docs.creao.ai/features/secrets), [saved runtime environments](https://docs.creao.ai/pro/agent-runtime-environment).
