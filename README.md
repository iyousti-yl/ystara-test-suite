# Ystara Test Suite

Regression and scenario testing for SAP Datasphere pipelines: discover the full lineage of a pipeline from ingestion to consumed output, capture snapshots, run fixture-based scenarios, and know before a transport whether the numbers still hold.

**Status:** phase 1 (connector and discovery). Nothing here is customer-ready yet.

## Layout

```
apps/
  api/        Fastify REST API (accounts, tenants, pipelines, runs)
  worker/     Background jobs: discovery scans, snapshot capture, scenario runs
  web/        React UI (UI5 Web Components, Fiori-like); the API serves it
packages/
  shared/     Types, scenario YAML schema, validation (used by all apps)
  connector/  The only code that talks to Datasphere (CLI + HANA SQL)
  db/         Postgres access: SQL migrations, tenants, scans, pipelines
docs/
  architecture/  Architecture decisions and diagrams
tools/
  scan/       `npm run scan`: read-only discovery from your machine
  db/         `npm run db:import`: load a saved scan into the database
  spike/      One-off feasibility scripts (not shipped)
```

Read [docs/architecture/overview.md](docs/architecture/overview.md) first.

## Getting started

```bash
npm install
cp .env.example .env.local     # fill in values (not .env: see below)
npm run typecheck
npm test
```

### Run the app locally (Docker)

```bash
docker compose up -d --build          # Postgres, migrations, API, worker and the web app
open http://127.0.0.1:4000            # the web app; the API is under /api (curl http://127.0.0.1:4000/api/health)
docker compose down                   # stop; add -v to also delete the database
```

The web app lists tenants and their scans, the objects each scan found (with the likely outputs first), and the pipeline behind any object as a lineage picture: entry tables, the output, tables with several writers and loops are marked, and clicking an object shows what it reads and writes and its definition. Writers that belong to another process can be excluded with a click, and the pipeline saved.

The API (with the web app) and Postgres are published on 127.0.0.1 only: there is no sign-in yet. Everything stored is metadata (definitions and lineage), never table rows.

**Ports.** Postgres is on host port 55432 (not 5432, so it never meets another Postgres on your machine) and the API on 4000. To change them, set `YSTARA_DB_PORT` / `YSTARA_API_PORT` in `.env`: Compose and the npm tools both read it, so they always agree. The API, worker and `db:*` tools check that the database they reach is Ystara's and stop with a clear message otherwise.

**Settings.** App settings and secrets go in `.env.local`. `.env` may only hold the `YSTARA_*` ports, because Compose reads `.env` and can print parts of its values (a `$` in a secret is read as a variable); the tools refuse to start when `.env` holds anything else and name the keys to move. Shell variables win over both files.

**Scanning with a technical OAuth client.** `npm run scan` uses your own `datasphere login` unless `.env.local` holds a technical OAuth client of the tenant (`DSP_CLIENT_ID`, `DSP_CLIENT_SECRET`, `DSP_TOKEN_URL`); then it logs in with that client in a temporary CLI folder, the way the worker will. `npm run spike:technical-client` checks first, read-only, whether such a client can see a space; its header says how to create the client.

Load a scan you already saved with `npm run scan`, without calling the tenant, then open it in the web app or ask the API for a pipeline:

```bash
npm run db:import -- --from tools/scan/output/<run> --tenant Partner
curl "http://127.0.0.1:4000/api/scans/<scan id>/pipeline?output=<SPACE.VIEW>&excludeWriter=<OTHER_FLOW>"
```

API routes (all JSON, all under `/api`): `GET/POST /tenants`, `GET /tenants/:id`, `GET/POST /tenants/:id/scans` (POST queues a read-only scan for the worker), `GET /scans/:id`, `GET /scans/:id/graph`, `GET /scans/:id/objects/:space/:name` (one object with its definition and links), `GET /scans/:id/pipeline?output=...&excludeWriter=...`, `GET/POST /tenants/:id/pipelines`, `GET/DELETE /pipelines/:id` (a saved pipeline, computed on the tenant's latest successful scan). Response types are in `packages/shared/src/api.ts`.

**Working on the web app.** `npm run dev:web` serves it on http://127.0.0.1:5173 with instant reload and forwards `/api` to the API on `YSTARA_API_PORT` (Docker's, or `npm run dev:api`). See `apps/web/README.md`.

**Scanning a tenant from the app.** The worker uses the Datasphere CLI's own login until the connection wizard stores tenant credentials. The worker container has no login, so to scan a tenant, run the worker on your machine instead: `docker compose stop worker`, then `npm run dev:worker` (after `datasphere login`). To run the API or worker with npm against the Docker database: `docker compose up -d postgres migrate`, then `npm run dev:api` / `npm run dev:worker`. Schema changes are numbered SQL files in `packages/db/migrations/`; `npm run db:migrate` applies them.

### Discovery scan (read-only)

Builds the lineage of a space and, optionally, the pipeline behind one output object. Needs `datasphere login` done once, `DSP_HOST` in `.env.local`, and the CLI installed (`npm i -g @sap/datasphere-cli`).

```bash
npm run scan -- --space HR --output V_HEADCOUNT_OUT
npm run scan -- --space HR --space SHARED            # several spaces, cross-space lineage
npm run scan -- --from tools/scan/output/<run> --output OTHER_VIEW   # replay a saved scan offline
npm run scan -- --space HR --output V_HEADCOUNT_OUT --exclude-writer DF_OTHER_LOAD   # leave out a writer from another process
```

A pipeline is traced backwards from the output: what it reads (main chain and side inputs such as config tables and control views), the flow that writes each table, and so on down to the tables nothing upstream writes. Task chains are never part of it, and names in SQL comments don't count. When a table has several writers, name the ones that belong to other processes with `--exclude-writer` (repeatable, `*` wildcards) or in a git-ignored `tools/scan/scan.local.json` (format in the header of `tools/scan/scan.ts`); otherwise every writer is followed and the table is reported as ambiguous.

Results land in `tools/scan/output/<timestamp>/` (git-ignored): `lineage.md` (Mermaid diagram), `pipeline.json` (steps, entry points, excluded and ambiguous writers, cycles), `graph.json` and `raw.json`. `raw.json` holds object definitions only, never table rows.

In Claude Code, `/datasphere-scan HR --output V_HEADCOUNT_OUT` hands the scan to the dedicated `datasphere-scanner` agent (`.claude/agents/`), which runs it read-only, checks the lineage for gaps and returns a short report. See `CLAUDE.md` for the agent-and-skill convention.

### Feasibility spike

`npm run spike:cli` lists and reads one object of each kind and reports what the installed CLI supports. Read-only.

## Read-only guarantee

Ystara never creates, changes, deletes or runs anything in a Datasphere tenant. Every CLI call goes through `assertReadOnly` in `packages/connector/src/readonly.ts`, which allows only `list` and `read` and throws on anything else. Changing that file is a product decision, not a code detail.

## Conventions

- TypeScript everywhere, strict mode. One language to maintain.
- Every module has a short `README.md` or a header comment saying what it does and why.
- Every pull request includes a plain-language "what and why" note.
- Nothing in this repository may contain data, code or object definitions from a freelance client.
