# Getting started

**Current repo phase:** documentation scaffold. Application code, backend, wallets, sensors, and integration keys are not present yet.

## Clone and read

```bash
git clone https://github.com/PhongCT1105/BillboardOS.git
cd BillboardOS
```

Browse the docs in GitHub under `docs/`, or serve the documentation locally:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-docs.txt
mkdocs serve
```

Then open `http://127.0.0.1:8000/`. Do not commit `.venv` or `site/`.

## Suggested future application layout (not yet created)

```text
apps/
  web/                # advertiser portal and operator dashboard
  api/                # authenticated services and policy engine
  display/            # local fullscreen billboard player
packages/
  agents/             # tools, message schemas and orchestration
  domain/             # typed quotes, holds, bookings, finance
  integrations/       # x402, CRS, events
  ui/                 # shared UI
infra/                # local dev deployment and secrets examples
tests/                # concurrency, payment, display and agent traces
docs/                 # architecture, competition and demo hub
references/original/   # source archive, with permission
```

Don't create 10 services for a 2-day hackathon; this is a monorepo namespace suggestion. Start with a single API and database.

## Development conventions

- For changes to requirements, update `docs/product/requirements.md` alongside the PR.
- Never commit secrets, real customer data, or personal facial images.
- All mocked sponsor APIs must be labelled as mocks in code and demo.
- PR titles: `feat:`, `fix:`, `docs:`, `test:`, `chore:`.
- Critical integration PRs should contain a short Loom/screen recording or reproducible steps and actual test output.
- Record consequential choices under `docs/decisions/`.

## Environment variables

Copy the template and fill it in:

```bash
cp .env.example .env
```

Each variable in `.env.example` is tagged with where it's read:

- `[local]`: the Express x402 server, buyer agent, edge counter or scripts read it from `.env`.
- `[convex]`: Convex functions read it. **Convex doesn't read `.env`**; push each one with `npx convex env set NAME value`.
- `[web]`: exposed to the browser through the `VITE_` prefix. Never put a secret there.

`npx convex dev` writes `CONVEX_DEPLOYMENT` and `VITE_CONVEX_URL` to `.env.local` for you. Use testnet values only (Base Sepolia, CRS sandbox, Nessie).
