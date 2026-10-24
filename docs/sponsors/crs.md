# CRS — Financial Intelligence Challenge (Best Use of CRS Credit API)

| | |
|---|---|
| **Type** | **Tool required.** "The only rule: make meaningful use of the CRS sandbox and show it working live in your demo." |
| **Prizes** | Best Overall CRS Hack $1,000 · Best Financial AI Agent $500 · Best Identity / Fraud Innovation (FDE interview) · Most Unexpected Use of CRS (FDE interview) |
| **Our target** | **P1** — Best Overall + Best Financial AI Agent |
| **Rules status** | Guide text + [calhacks.crscreditapi.com](https://calhacks.crscreditapi.com) read 2026-10-24; endpoint list arrives by email |
| **Sources** | [Official guide] printed pp. 12–13 · [CRS Cal Hacks page](https://calhacks.crscreditapi.com) |

## Judging criteria

1. **Use of CRS:** how central CRS data is to the product, not a bolt-on.
2. **Working demo:** it runs live against the sandbox.
3. **Usefulness:** it solves a real problem for a person or a business.
4. **Creativity:** it shows something they didn't expect.

Best Financial AI Agent: "an AI agent that does real work with CRS data, using our API or MCP server."

## Rules

- Use the **provided test identities only**.
- Questions: CRS booth. Winners are contacted through Cal Hacks.

## Sandbox

- Base URL: `https://api-sandbox.stitchcredit.com:443/api`
- Auth: `POST /api/users/login` → Bearer token.
- Example endpoint: `POST /api/experian/credit-profile/credit-report/standard/exp-prequal-vantage4`.
- Product categories: consumer credit (reports, FICO/VantageScore), identity verification (ID, KBA, OTP, device, document), prefill, **business credit** ("a company's debt picture and its state filings"), public records (bankruptcies, liens, judgments), criminal and eviction, compliance (OFAC, Military Lending Act).
- **No dedicated business-verification or fraud API is listed.**
- MCP server: npm `@crscreditapi/crs-calhacks-mcp-server`, described for "planning, development, and debugging questions" from Claude Code — a developer aid.
- Keys: enter an email on the CRS page → invite → CRS portal; a second email sends a Postman collection with OpenAPI specs, test cases and test identities.
- The page's example identity is a consumer. **Business-credit test entities are unconfirmed.**

## How BillboardOS fits (proposed)

The risk agent queries business credit (and identity verification for the signer) during advertiser onboarding. The result sets **payment terms**: prepay via x402, net-15 invoice through Nessie, or operator review. A weak credit signal never counts as proof of fraud. See [payments and risk](../architecture/payments-and-risk.md).

## Evidence checklist

- [ ] Live sandbox call during the demo with a provided test identity.
- [ ] The CRS result visibly changes payment terms.
- [ ] Decision log shows evidence, policy and confidence; uncertain results go to review.

## Open questions

- [ ] Register a team email to get keys and the Postman collection.
- [ ] Which business-credit test entities exist?
