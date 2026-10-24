# Kickoff checklist

What has to be in place before the first line of product code. Devpost closes **Sunday 2026-10-25, 9:00 AM**; judging runs 10:30 AM–12:30 PM.

## Decided

- Stack: [ADR 0002](../decisions/0002-sponsor-native-stack.md) (Convex backend; Express x402 endpoint; Claude; CREAO; CRS; Nessie).
- Coinbase track: **Payment Agents**.
- CREAO track: **Best One-Person Company**.
- Primary narrative: [Hyphenate](../sponsors/hyphenate.md) AR + collections seats.

## Accounts and keys

Keys live in Convex environment variables or the Express server's local `.env`, never in the repo or browser code.

| Service | Where | Gives us | Needed for | Owner |
|---|---|---|---|---|
| Convex | `npx convex dev` (login) | Deployment URL | Everything | |
| Coinbase | coinbase.com, verified account **per prize-eligible member** | Prize eligibility | Coinbase track | each member |
| CDP | portal.cdp.coinbase.com | `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` | x402 seller + buyer | |
| CREAO | hackathon sign-up link → agent.creao.ai | `capi_` key, credits | CREAO agents | |
| CRS | calhacks.crscreditapi.com (email) | Sandbox login, Postman collection, test identities | Risk agent | |
| Nessie | nessieisreal.com | API key | Bank feed | |
| Anthropic | console.anthropic.com | API key | Agent reasoning | |
| Fetch.ai (P2) | agentverse.ai | Agent address | Fetch.ai track | |

## Information still missing

- [ ] CREAO **Tech Stack** tab: API Trigger endpoint, auth, request body, webhook payload.
- [ ] Whether Devpost limits how many sponsor tracks one project can enter.
- [ ] Which Coinbase MCP counts for Payment Agents (booth).
- [ ] CRS business-credit test entities (Postman collection).
- [ ] Convex track criteria (Convex workshop or booth).

## Team decisions

- [ ] Owners per workstream: edge + player · Convex core + Express x402 · agents (Claude + CREAO) · finance (CRS, Nessie, ledger) + console.
- [ ] Named community for Anthropic (draft: independent SF owners of 1–20 digital screens).
- [ ] Booking unit: e.g., one exclusive 5-minute window per screen.
- [ ] Pricing policy: floor, max discount, approval threshold.
- [ ] Planted errors and their answer key (Hyphenate proof).

## Hardware

- [ ] Logitech webcam (MLH lab) or a laptop camera for counting.
- [ ] A monitor or second laptop as the billboard screen.
- [ ] Optional: Raspberry Pi from the rental booth (parts due back Sunday 2 PM).

## Workshops worth attending (Saturday; times on the live site)

Convex ("Build Your Backend with Convex") · CREAO ("From Chat to Backend") · Microsoft ("System Design for Deployed Agents") · Anthropic ("Intro to Claude Code"). Hyphenate's workshop was Friday.
