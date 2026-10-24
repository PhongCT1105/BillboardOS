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

## Suggested .env names when app code begins

```bash
DATABASE_URL=
LLM_API_KEY=
X402_NETWORK=
X402_PAYMENT_ASSET=
X402_FACILITATOR_URL=
X402_RECEIVER_ADDRESS=
CRS_SANDBOX_API_KEY=
CAMERA_DEVICE_ID=
```

These are **proposed configuration keys** only; adapt to the actual sponsor SDK and never check in filled values.
