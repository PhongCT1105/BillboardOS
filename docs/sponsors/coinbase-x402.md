# Coinbase — Build agents that trade and pay

| | |
|---|---|
| **Type** | **Tool required.** Use Coinbase for Agents and x402. |
| **Tracks** | **Payment Agents** · Trading Agents. **Choose one primary track.** |
| **Prize** | Per track, one winning team; **each eligible member** gets $500 USDC + a call with an Emerging Talent recruiter. Limit one prize per person. |
| **Our target** | **P0 — Payment Agents (decided 2026-10-24)** |
| **Rules status** | Track PDF read in full; CDP docs read 2026-10-24 |
| **Sources** | `docs/original/Coinbase CalHacks Challenge 2026.pdf` · [x402 docs](https://docs.cdp.coinbase.com/x402/welcome) · [AI agents docs](https://docs.cdp.coinbase.com/ai-agents/overview) · [Official guide] printed p. 11 |

The guide's "up to $4,000 total" assumed entering both tracks. The PDF says to **choose one primary track**.

## Tracks

| Track | Challenge | Examples |
|---|---|---|
| **Payment Agents** | Give an agent a way to pay for things, earn money, or both. Use the **Coinbase MCP for Agents and x402** to explore what an agent can do when it can participate in commerce. | An agent that buys tools to finish a job; sells research or a service; hires another agent; or **manages the budget for a small business**. |
| Trading Agents | Agentic trading and portfolio management, using Coinbase for Agents or the Coinbase Wallet MCP. | A trading strategy template; a portfolio tool; an agent that tests investment ideas; a market-monitoring skill. |

**What counts:** "Start with an existing agent platform (Grok Bot, Instinct, Muse, etc.) or build your own. Skills, templates, integrations, and GitHub starter kits are eligible in either track. You don't need to build a standalone app."

## Eligibility (Terms & Conditions)

- [ ] Each person who wants a prize is **18+**, a **legal resident of the US or Canada (excluding Quebec)**, and has a **verified Coinbase account** they personally hold.
- [ ] Get a CDP API key at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com).
- [ ] Follow the prompt by submitting a project summary, working example, architecture and builder feedback.
- Winners may have to complete an affidavit. Winning grants Coinbase permission to use names and submitted content for promotion.

## Judging

| Criterion | What judges ask |
|---|---|
| **Usefulness** | Does it solve a clear problem for an identifiable user? |
| **Technical design** | Does it work reliably? Explain choices of models, tools, memory and scheduling. |
| **Ease of reuse** | Can another person install or access it and complete the core task using your instructions? |
| **Product feedback** | Insightful, actionable feedback about building with Coinbase for Agents. |

"We won't score projects on code volume, trading returns, or money spent. **Real-money transactions are not required.** Label simulated actions clearly, keep credentials private, and **don't manage funds for other people.**"

## What to submit

- [ ] **Project summary:** who it's for, what it does, which agent platform and Coinbase tools it uses.
- [ ] **Working example:** a short demo and a repo, installable skill/template, or hosted link with setup instructions.
- [ ] **Architecture:** brief explanation or diagram of components, controls and known limitations.
- [ ] **Builder feedback:** biggest blocker, how we worked around it, and the one missing Coinbase capability we most want. Keep a running log during the build (`docs/notes/coinbase-feedback.md`).
- Optional: opt into a follow-up conversation with the Coinbase team.

## Technical reference (CDP docs)

### x402 flow

1. Client requests a resource.
2. Server replies **HTTP 402** with price, recipient and accepted payment options.
3. Client signs a payment and resends the request with proof attached.
4. Server asks the **CDP Facilitator** to verify → server does the work → server asks the facilitator to settle.
5. Server returns the resource and a payment confirmation.

Pricing models: fixed price ("exact"), an authorized maximum settling only what's used, or deferred batch settlement. USDC is the common asset.

### Seller (our booking endpoint)

- Node **22+**. Packages: `express @coinbase/cdp-sdk @x402/core @x402/evm @x402/svm @x402/extensions @x402/express` (Hono and Next.js examples exist).
- Route config:

  ```typescript
  "GET /report": {
    price: "$0.01",
    networks: ["eip155:84532"], // Base Sepolia
    description: "Generate a concise research report",
  },
  ```

- `environment: "development"` → testnets and test funds; `"production"` → mainnets.
- Networks: Base Sepolia `eip155:84532` (testnet), Base `eip155:8453` (mainnet), Solana devnet/mainnet.
- Env: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` (authenticate to the facilitator), `X402_PAY_TO` (receiving address), or `CDP_WALLET_SECRET` to let CDP provision the receiving wallet.

### Buyer (advertiser agent)

- Packages: `@coinbase/cdp-sdk @x402/core @x402/evm @x402/svm @x402/extensions @x402/fetch`.

  ```typescript
  const client = new CdpX402Client({ environment: "development" });
  const fetchWithPayment = wrapFetchWithPayment(globalThis.fetch, client);
  const response = await fetchWithPayment("https://x402.vercel.app/protected");
  ```

- The CDP-managed wallet means no private key to store. Test USDC: `cdp.evm.requestFaucet({ address, network: "base-sepolia", token: "usdc" })`.
- Env: `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET`.

### Agent tools ("Coinbase for Agents")

| Tool | Access | Relevant capabilities | Auth |
|---|---|---|---|
| Coinbase MCP | `https://agents.coinbase.com/mcp`, CLI `@coinbase/coinbase-cli` | Trading; **x402 payments listed as "coming soon"** | Sign in with Coinbase or API key |
| Wallet MCP | `https://wallet-mcp.coinbase.com` | Balances, send, swap, sign, **x402 payments**; every write approved in Coinbase Wallet | Sign in with Coinbase Wallet |
| CDP MCP | CLI `@coinbase/cdp-cli` | Server wallets, smart accounts, **x402 APIs** | CDP API key + wallet secret |
| Agentic Wallet | [guide](https://docs.cdp.coinbase.com/x402/agentic-accounts/agentic-wallet.md) | A wallet for your own agent to discover and pay x402 services | — |

## How BillboardOS fits (proposed)

**Track: Payment Agents.** It matches two of the track's own examples: an agent that **sells a service** (billboard slots) and one that **manages the budget for a small business** (the advertiser's buying agent).

- **Seller:** a small Express server running `@x402/express` protects `POST /purchases/:holdId`. After the facilitator verifies a payment, it calls the Convex booking mutation, and only then settles. This follows the official quickstart, which is safer than fitting the middleware into a Convex HTTP action.
- **Buyer:** the advertiser's agent pays with `CdpX402Client` on Base Sepolia, within a budget cap.
- **Ease of reuse:** package the buyer side as an installable **"book a billboard" skill or MCP tool** that any agent (Claude Code, Grok Bot, ASI:One) can use to find slots, get quotes and pay through x402. Judges explicitly reward installable skills.
- **Testnet only:** Base Sepolia with faucet USDC, labeled as test funds. The rule "don't manage funds for other people" fits: each advertiser agent spends its own wallet.

## Evidence checklist

- [ ] Real 402 response with payment requirements.
- [ ] Buyer agent pays from its own CDP wallet; facilitator verify and settle results logged.
- [ ] Booking is confirmed only after verification; replayed or expired payment never books.
- [ ] Transaction reference visible in the ledger and operator console (and on a Base Sepolia explorer).
- [ ] Installable skill/tool with setup instructions that someone else can run.
- [ ] Architecture diagram with controls and known limitations.
- [ ] Builder feedback written up.

## Open questions

- [ ] Which team members meet the eligibility rules and have verified Coinbase accounts?
- [ ] Does "use the Coinbase MCP for Agents" require a specific MCP? The Coinbase MCP lists x402 as coming soon, so ask at the booth whether the Wallet MCP, CDP MCP or the SDK alone qualifies.
- [ ] Settle before or after the booking mutation if the hold expires mid-request? (Current proposal: verify → book → settle; if the booking fails, don't settle.)
