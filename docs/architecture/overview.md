# Ystara Test Suite: architecture overview

_Phase 1 version. Written so one person can maintain the whole system. Update it whenever a decision changes; the "Decisions" table is the log._

## What the system does

1. **Connect** to a customer's SAP Datasphere tenant, **read-only**: the Datasphere CLI for object definitions (`list` and `read` only) and a database user with read access for `SELECT` queries. Ystara never creates, changes, deletes or runs anything in a tenant.
2. **Discover** every object in the selected spaces and build a lineage graph (what reads from what, what writes to what, what triggers what).
3. Let users define **pipelines** (an output object and its upstream chain) and attach tests:
   - **Snapshots:** capture metrics of each object, compare across time or before/after a change.
   - **Scenarios:** simulate the pipeline's logic on fixture data, entirely inside one read-only `SELECT`, and evaluate assertions at checkpoints (see "How a scenario run works").
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
| `apps/web` | UI: Fiori-like (UI5 Web Components for React), light and fast. Lineage pictures with React Flow, laid out by dagre. Built into `apps/web/dist` and served by the API | Enforce permissions (server does); load anything from a third-party server |
| `apps/api` | Auth, accounts, roles, CRUD for tenants/pipelines/scenarios, enqueue jobs, serve results (all under `/api`), serve the web app | Talk to Datasphere directly |
| `apps/worker` | Run jobs: scans, snapshots, scenario runs, alerts | Hold secrets longer than a job |
| `packages/connector` | The only code that talks to Datasphere (CLI wrapper, SQL client, discovery parser) | Persist anything |
| `packages/db` | The platform's own Postgres: SQL migrations, job queue setup, queries for accounts, users, sessions, tenants, scans and pipelines | Talk to Datasphere |
| `packages/shared` | Types, scenario YAML schema (Zod), role model | Depend on any app |

## Key design decisions

| # | Decision | Why | Revisit when |
|---|---|---|---|
| 1 | TypeScript end to end | Datasphere CLI is a Node package; one language to maintain; UI5 Web Components are TS-first | Never, unless the CLI moves |
| 2 | Fastify API + Postgres + pg-boss | Small, well documented, no Redis to operate | Job volume exceeds what Postgres handles comfortably (very unlikely in year 1) |
| 3 | Connector behind an interface | Lets us ship a self-hosted runner later without touching api/worker | A security team asks for the runner |
| 4 | Metadata, hashes and aggregates only; no raw rows by default | Security reviews and GDPR (HR data at the first client) | A customer opts in to store N differing rows |
| 5 | Scenario spec is YAML validated by Zod; visual builder emits the same YAML | One artefact for devs and non-devs; Git-friendly | Never |
| 6 | **Strictly read-only.** The connector allows only CLI `list`/`read`, plus `config cache init` which only downloads the CLI's command list (enforced in `packages/connector/src/readonly.ts`), and SQL `SELECT` | Product promise to customers and Issam's requirement (2026-10-15); easiest possible security review | Never without an explicit product decision |
| 7 | Hosted in the EU (Hetzner or Scaleway), Docker Compose, Caddy | Budget under €200/month, GDPR | Beyond ~30 tenants, move to managed Postgres and two VMs |
| 8 | Email + TOTP auth in v1, SSO in v2 | Keep v1 small; SSO is a known enterprise ask | First enterprise procurement |
| 9 | Scenario tests are **read-only simulations**: fixture rows are inlined into a single `SELECT` that reproduces the pipeline's SQL logic | Keeps decision 6 for scenarios too (chosen by Issam, 2026-10-15) | Customers ask for coverage of flow types that can't be expressed as SQL |
| 10 | Lineage is found by scanning definitions for names of known objects, with role rules per type, not by a parser per object format | Flow and task chain JSON differs between CLI releases; this survives format changes | Real samples show false or missing edges |
| 11 | Plain SQL (node-postgres) with numbered SQL migrations, no ORM; tests run on PGlite (Postgres in WebAssembly) | Every query readable as written; tests need no database server, on Windows too | Queries get repetitive enough that a query builder pays off |
| 12 | Pipelines are stored as an output plus writer exclusions; their steps are computed from the latest successful scan | Steps follow the tenant as it changes, and nothing goes stale | Tests attach to steps (phase 2), which may need stored step lists per scan |
| 13 | Local settings: app settings and secrets in `.env.local`; `.env` holds only the `YSTARA_*` host ports (Postgres 55432, API 4000) that Compose substitutes. Programs refuse a database without Ystara's migrations | Compose never sees a secret, and no tool silently uses another Postgres on the machine | Hosting (decision 7) brings a secrets store |
| 14 | One origin: the API serves the web app at `/` and itself under `/api` (Vite forwards `/api` in development). No CORS | No cross-origin calls to secure; one port to publish and, later, to put behind sign-in | The web app needs a CDN or its own host |
| 16 | Sign-in is email + password (scrypt) + a mandatory authenticator code (TOTP, RFC 6238); server-side sessions in an HttpOnly, SameSite=Strict cookie; no public sign-up, accounts are created by the operator (`npm run account:create`) and people join by one-time invitation links. Ystara's operator (a flag on the user, set only by `npm run operator:grant`) has a panel across all accounts that shows counts, never tenant data, and makes one-time reset links for a lost password or phone. Every API route checks a permission from `packages/shared/src/roles.ts` and only sees its own account (another account's ids answer 404) | Small, no identity provider to run or pay for, and strong enough for the first customers' security reviews (Issam chose "You create them" and an operator panel besides each account's admin page, "Both", 2026-10-16) | First enterprise customer that needs SSO (decision 8) |
| 15 | The web app loads nothing from third parties: SAP's 72 font is bundled from `@sap-theming/theming-base-content` instead of UI5's default CDN, and the API's Content-Security-Policy only allows fonts and styles from Ystara itself | GDPR (no visitor IPs to a CDN) and works offline; the policy blocks a regression instead of letting it leak | Never |

## Data model

In place (`packages/db/migrations/`):

- `accounts` (customer organisations) → `memberships` (user, role) → `users` (email, scrypt password hash, encrypted authenticator secret, last code used, operator flag)
- `invitations` (account, email, role, token hash, expiry, accepted at) and `sessions` (token hash, user, account, verified by code or not, expiry). Only hashes of links and cookies are stored
- `sign_in_resets` (user, operator who made it, token hash, sealed authenticator secret, expiry, used at): one-time links from the operator panel to choose a new password and authenticator, kept on record
- `tenants` (account, name unique per account, host). Credentials arrive with the connection wizard.
- `scans` (tenant, spaces, source tenant/import, status queued/running/succeeded/failed, counts, warnings, error) → `scan_objects` (space, name, type, CLI kind, definition hash) and `scan_edges` (from, to, kind)
- `object_definitions` (tenant, hash, definition JSONB): each distinct definition once per tenant
- `pipelines` (tenant, name, output, writer exclusions)

Planned:

- a space scope on `memberships` (a role limited to some spaces)
- encrypted OAuth and DB credentials on `tenants`
- `pipeline_steps` if tests need stored step lists
- `snapshots` (object, metrics JSONB, captured at, run id)
- `scenarios` (pipeline, YAML text, version) → `fixtures`
- `runs` → `run_steps` → `assertion_results`
- `alert_channels`, `audit_log`

Secrets are encrypted with `MASTER_KEY` (AES-256-GCM, `apps/api/src/auth/secrets.ts`; authenticator secrets now, tenant credentials with the wizard). The key lives alone in the git-ignored file `.master-key`, which Docker Compose passes as a secret to the containers that need it; a hosting platform can set `MASTER_KEY` instead. Rotating the master key re-encrypts rows in a migration.

## Sign-in and accounts (phase 1d)

1. The operator runs `npm run account:create -- --name <Account> --admin <email>`, which prints a one-time link for the account's first admin.
2. Opening the link, a new user chooses a password and scans a QR code with an authenticator app. The server makes that secret and keeps it (sealed) on the invitation; the first code from the app proves it works and creates the user. Someone who already uses Ystara in another account signs in as that email and joins; their role elsewhere, or in this account if they already belong to it, never changes.
3. Signing in takes the password (a 10-minute "pending" session), then a code (a new 12-hour session: the cookie changes). Each code works once. Wrong codes count per user across sign-ins: five in a row lock codes for a minute, then 2, 4, ... up to an hour, and end the sign-in. Each attempt is counted before its code is checked, in the same statement as the lock check, so requests sent at the same moment can't try more codes. Login, code and invitation routes allow ten tries a minute per address and per email, user or link, so one client can't lock out a whole office. Behind a proxy, `YSTARA_TRUST_PROXY` says which proxy may report the client's address. Invitation tokens never reach the log. Changes from another site's pages are refused (Origin check, on top of the SameSite cookie).
4. Admins manage their account on the Users and roles page: invite by email and role, change roles, remove people. An account always keeps one admin. Removing someone ends their sign-in to that account at once.
5. The web app hides what a role can't do, but only the API enforces it (`config.access` on every route, `apps/api/src/auth/access.ts`).
6. The operator (`npm run operator:grant`) runs the Operator page: every account and user with counts, creating accounts, inviting an admin to an account that has none left (never to one that still has an admin, so the operator can't make themselves admin of a customer, and never someone already in the account, whose role an invitation can't change), and reset links. A reset link (valid 3 days, one at a time per user, never for an operator) lets someone choose a new password and set up their authenticator again; using it signs out every browser signed in as them. Each link records the operator who made it and when it was used, goes into the log, and shows on the Users and roles page of the person's accounts ("Sign-in reset by Ystara on ..."): every link of the last 30 days, used, open or never used, so a newer link never hides an earlier one. Ystara still sends no email: the operator passes the link on after checking who asks.

## How discovery works (phase 1)

1. For each space and each object kind, `list` then `read` every object (CLI, read-only, a few in parallel). One unreadable object becomes a warning; the scan carries on. Spaces are given by their IDs: Ystara never lists the tenant's spaces, because `spaces list` and `spaces read` need a tenant-wide privilege that its technical client shouldn't have.
2. Classify each object (`views` is split back into SQL and graphical views) and hash its definition so re-scans show what changed.
3. Find references: walk each definition and match strings, and identifiers inside SQL text with comments removed, against the names of all scanned objects. Role rules: in flows, each step's `component` decides (`...producer`, `...target` write; `...consumer`, `...source` read), keys of a `targets` section are writes, and elsewhere a key path containing "target" means a write; in task chains, references are steps; in tables, views and analytic models, references are reads. A flow reading its own target (delta, lookup) is not a dependency. When a `read` bundles dependency definitions, only the object's own entry is scanned.
4. Build edges that point the way data moves (`reads_from`, `writes_to`) plus control edges from task chains: `triggers` for a step they run, `clears` for a table a step empties (DELETE_DATA).
5. A **pipeline** for an output object is traced backwards through data edges: what it reads (main chain and side inputs alike), the flow that writes each table, down to tables nothing upstream writes. Task chains are never followed. Writers excluded by configuration are listed, not followed; a table still left with several writers is reported as ambiguous. Steps are topologically sorted and loops are reported, not hidden. **Entry points** are tables with no other table upstream (where fixtures go).

Try it locally: `npm run scan -- --space <SPACE> --output <OBJECT>` writes a Mermaid lineage diagram to `tools/scan/output/`.

## How a scenario run works (phase 3 target, read-only simulation)

Nothing is written to the tenant and no flow or task chain is run. Instead the platform tests the **logic** of the pipeline:

1. Load the scenario YAML and the pipeline.
2. Turn each entry table's fixture rows into an inline data set (`SELECT ... FROM DUMMY UNION ALL ...`).
3. Walk the pipeline from the entry points to each checkpoint and compose one `WITH` query: every view and SQL-based transformation flow becomes a CTE, with its references to upstream objects rewritten to the CTEs that replace them. A table loaded by a transformation flow is represented by that flow's `SELECT` (full-load semantics).
4. Run the composed `SELECT` through the read-only database user and evaluate the assertions on the result.
5. Steps that cannot be expressed as SQL (data flows with script operators, replication flows, remote sources) stop the simulation at that point with a clear message; those parts of the chain are covered by snapshot tests instead.

Open questions for phase 3: how delta loads and upserts in transformation flows should be simulated, and how graphical views' query model maps to SQL (likely via the CSN `query` that Datasphere also stores).

## Security posture (short form for the security pack)

- Read-only by design: CLI limited to `list`/`read` in code (plus `config cache init`, which only fills the CLI's local list of commands), database user with `SELECT` rights only, no writes, deploys or task runs.
- Sign-in with password and a mandatory authenticator code; roles checked on every API call; each account sees only its own data.
- Secrets encrypted at rest, TLS in transit, EU hosting, daily encrypted backups, 30-day retention of results by default.
- No customer row data stored unless explicitly enabled per account.
- Full audit log of connections, scans, runs and user actions.
- Self-hosted runner available when required (same connector interface).

## Feasibility spike results (2026-10-15)

The spike ran successfully against the partner tenant with Datasphere CLI 2026.x. Findings already reflected in the connector: `list`/`read` always return JSON (no `--output` flag), `list` needs `--top` beyond 25 items, and SQL and graphical views share the `views` command.

## Technical client spike results (2026-10-16)

Issam ran `npm run spike:technical-client` against the partner tenant with CLI 2026.21, a fresh CLI folder and the client in a secrets file. Findings reflected in the connector:

- `--host` goes after the command and its flags, for every command (the connector puts `--secrets-file` and `--verbose` there too). Before the command the CLI ignores the host: it asks "URL of the system to connect to" and exits with code 0. The old order only worked on a machine where `datasphere login` had stored a host.
- The CLI runs with no input. A question (a line starting with "?") or a `list`/`read` that isn't JSON is a failure even on exit code 0.
- With the host after the command, the client lists the views and local tables of a space it is a member of. `spaces list` and `spaces read` fail: they need a tenant-wide privilege, so scans and the spike don't rely on them.
