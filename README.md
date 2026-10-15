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

### Discovery scan (read-only)

Builds the lineage of a space and, optionally, the pipeline behind one output object. Needs `datasphere login` done once, `DSP_HOST` in `.env`, and the CLI installed (`npm i -g @sap/datasphere-cli`).

```bash
npm run scan -- --space HR --output V_HEADCOUNT_OUT
npm run scan -- --space HR --space SHARED            # several spaces, cross-space lineage
npm run scan -- --from tools/scan/output/<run> --output OTHER_VIEW   # replay a saved scan offline
```

Results land in `tools/scan/output/<timestamp>/` (git-ignored): `lineage.md` (Mermaid diagram), `pipeline.json`, `graph.json` and `raw.json`. `raw.json` holds object definitions only, never table rows.

### Feasibility spike

`npm run spike:cli` lists and reads one object of each kind and reports what the installed CLI supports. Read-only.

## Read-only guarantee

Ystara never creates, changes, deletes or runs anything in a Datasphere tenant. Every CLI call goes through `assertReadOnly` in `packages/connector/src/readonly.ts`, which allows only `list` and `read` and throws on anything else. Changing that file is a product decision, not a code detail.

## Conventions

- TypeScript everywhere, strict mode. One language to maintain.
- Every module has a short `README.md` or a header comment saying what it does and why.
- Every pull request includes a plain-language "what and why" note.
- Nothing in this repository may contain data, code or object definitions from a freelance client.
