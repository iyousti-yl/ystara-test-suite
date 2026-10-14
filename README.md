# Ystara Test Suite

Regression and scenario testing for SAP Datasphere pipelines: discover the full lineage of a pipeline from ingestion to consumed output, capture snapshots, run fixture-based scenarios, and know before a transport whether the numbers still hold.

**Status:** phase 0 (foundations). Nothing here is customer-ready yet.

## Layout

```
apps/
  api/        Fastify REST API (accounts, tenants, pipelines, runs)
  worker/     Background jobs: discovery scans, snapshot capture, scenario runs
  web/        React UI (UI5 Web Components, Fiori-like)
packages/
  shared/     Types, scenario YAML schema, validation (used by all apps)
  connector/  The only code that talks to Datasphere (CLI + HANA SQL)
docs/
  architecture/  Architecture decisions and diagrams
tools/
  spike/      One-off feasibility scripts (not shipped)
```

Read [docs/architecture/overview.md](docs/architecture/overview.md) first.

## Getting started

```bash
npm install
cp .env.example .env     # fill in values
npm run typecheck
npm run dev:api          # http://localhost:4000/health
```

### Feasibility spike (phase 1 gate)

Checks which Datasphere object types the CLI can list, read and deploy on your tenant, and whether task chains can be triggered. Needs the `DSP_*` values in `.env` and the CLI installed (`npm i -g @sap/datasphere-cli`).

```bash
npm run spike:cli
```

Results land in `tools/spike/output/` (git-ignored). Paste the summary into the phase 1 decision in the plan.

## Conventions

- TypeScript everywhere, strict mode. One language to maintain.
- Every module has a short `README.md` or a header comment saying what it does and why.
- Every pull request includes a plain-language "what and why" note.
- Nothing in this repository may contain data, code or object definitions from a freelance client.
