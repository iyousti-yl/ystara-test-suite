# Ystara Test Suite: architecture overview

_Phase 0 version. Written so one person can maintain the whole system. Update it whenever a decision changes; the "Decisions" table is the log._

## What the system does

1. **Connect** to a customer's SAP Datasphere tenant with a scoped OAuth client (CLI) and a database user limited to a dedicated test space (SQL).
2. **Discover** every object in the selected spaces and build a lineage graph (what reads from what, what writes to what, what triggers what).
3. Let users define **pipelines** (an output object and its upstream chain) and attach tests:
   - **Snapshots:** capture metrics of each object, compare across time or before/after a change.
   - **Scenarios:** load fixture data into entry tables of a test copy of the pipeline, run the flows, evaluate assertions at checkpoints.
4. **Run** tests manually or on a schedule, **report** results, **alert** on failures.

## Components

```
                 ┌────────────┐      ┌────────────┐
   browser ────► │  apps/web  │ ───► │  apps/api  │ ───► PostgreSQL
                 └────────────┘      └─────┬──────┘        ▲
                                           │ enqueue       │ pg-boss queue
                                           ▼               │
                                     ┌────────────┐        │
                                     │ apps/worker│ ───────┘
                                     └─────┬──────┘
                                           │ packages/connector
                                           ▼
                              Datasphere CLI + HANA SQL ───► customer tenant
                                           │
                                           └──► notifier (email, Teams)
```

| Component | Responsibility | Must not |
|---|---|---|
| `apps/web` | UI: Fiori-like (UI5 Web Components for React), light and fast | Enforce permissions (server does) |
| `apps/api` | Auth, accounts, roles, CRUD for tenants/pipelines/scenarios, enqueue jobs, serve results | Talk to Datasphere directly |
| `apps/worker` | Run jobs: scans, snapshots, scenario runs, alerts | Hold secrets longer than a job |
| `packages/connector` | The only code that talks to Datasphere (CLI wrapper, SQL client, discovery parser) | Persist anything |
| `packages/shared` | Types, scenario YAML schema (Zod), role model | Depend on any app |

## Key design decisions

| # | Decision | Why | Revisit when |
|---|---|---|---|
| 1 | TypeScript end to end | Datasphere CLI is a Node package; one language to maintain; UI5 Web Components are TS-first | Never, unless the CLI moves |
| 2 | Fastify API + Postgres + pg-boss | Small, well documented, no Redis to operate | Job volume exceeds what Postgres handles comfortably (very unlikely in year 1) |
| 3 | Connector behind an interface | Lets us ship a self-hosted runner later without touching api/worker | A security team asks for the runner |
| 4 | Metadata, hashes and aggregates only; no raw rows by default | Security reviews and GDPR (HR data at the first client) | A customer opts in to store N differing rows |
| 5 | Scenario spec is YAML validated by Zod; visual builder emits the same YAML | One artefact for devs and non-devs; Git-friendly | Never |
| 6 | Test copies deployed into the customer's own test space | Data never leaves their tenant; CU cost stays theirs and visible | CLI can't deploy a type (then: snapshot-only for that step) |
| 7 | Hosted in the EU (Hetzner or Scaleway), Docker Compose, Caddy | Budget under €200/month, GDPR | Beyond ~30 tenants, move to managed Postgres and two VMs |
| 8 | Email + TOTP auth in v1, SSO in v2 | Keep v1 small; SSO is a known enterprise ask | First enterprise procurement |

## Data model (first cut)

- `accounts` (customer organisations) → `memberships` (user, role, optional space scope) → `users`
- `tenants` (host, encrypted OAuth and DB credentials) → `spaces`
- `objects` (type, technical name, definition JSONB, definition hash, deployable) and `edges` (from, to, kind)
- `pipelines` → `pipeline_steps`
- `snapshots` (object, metrics JSONB, captured at, run id)
- `scenarios` (pipeline, YAML text, version) → `fixtures`
- `runs` → `run_steps` → `assertion_results`
- `alert_channels`, `audit_log`

Credentials are encrypted with a master key held only in the worker/API environment (libsodium secretbox). Rotating the master key re-encrypts rows in a migration.

## How a scenario run works (phase 3 target)

1. Worker loads the scenario YAML and the pipeline graph.
2. For each entry table, creates or truncates a fixture table `YST_<name>` in the test space and inserts the rows (SQL).
3. Walks the pipeline top-down; for each deployable step, writes a copy `YST_<name>` whose sources are remapped to the `YST_` copies (CSN rewrite) and deploys it via CLI. Non-deployable steps are marked and the chain stops there with a clear message.
4. Triggers the flows or task chains listed under `run:` (CLI) and polls until done.
5. For each checkpoint, runs the assertions as SQL against the `YST_` copy; stores pass/fail, measured value and a key-only sample of mismatches.
6. Tears down the copies unless the user asked to keep them for debugging.

## Security posture (short form for the security pack)

- Least-privilege OAuth client; DB user scoped to the test space.
- Secrets encrypted at rest, TLS in transit, EU hosting, daily encrypted backups, 30-day retention of results by default.
- No customer row data stored unless explicitly enabled per account.
- Full audit log of connections, scans, runs and user actions.
- Self-hosted runner available when required (same connector interface).

## Open questions tracked by the spike (`tools/spike`)

- Exact CLI subcommand names per object type in the installed version.
- Which types can be created via CLI (analytic models and task chains are the uncertain ones).
- Whether task chains can be started via CLI and how completion is observed.
- Export time per space (sizing for scheduled re-scans).
