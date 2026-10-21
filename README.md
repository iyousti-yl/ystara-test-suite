# Ystara Test Suite

Regression and scenario testing for SAP Datasphere pipelines: discover the full lineage of a pipeline from ingestion to consumed output, capture snapshots, run fixture-based scenarios, and know before a transport whether the numbers still hold.

**Status:** phase 1 (connector and discovery). Nothing here is customer-ready yet.

## Layout

```
apps/
  api/        Fastify REST API (sign-in, accounts and roles, tenants, pipelines, runs)
  worker/     Background jobs: discovery scans, snapshot capture, scenario runs
  web/        React UI (UI5 Web Components, Fiori-like); the API serves it
packages/
  shared/     Types, scenario YAML schema, validation (used by all apps)
  connector/  The only code that talks to Datasphere (CLI + HANA SQL)
  db/         Postgres access: SQL migrations, accounts, tenants, database users, scans, pipelines, snapshots
docs/
  architecture/  Architecture decisions and diagrams
tools/
  scan/       `npm run scan`: read-only discovery from your machine
  db/         `npm run db:import`: load a saved scan into the database
              `npm run db:demo`: add a synthetic demo tenant, with names as long as Datasphere allows
              `npm run account:create`: create a customer account and invite its first admin
              `npm run operator:grant`: make a user Ystara's operator (the operator panel)
  check/      `npm run check:tenant-content`: tenant names in what is about to be pushed
              `npm run check:browser`: the local web app in Chromium at several widths, with screenshots
  spike/      One-off feasibility scripts (not shipped)
```

Read [docs/architecture/overview.md](docs/architecture/overview.md) first.

## Getting started

```bash
npm install
cp .env.example .env.local     # fill in values (not .env: see below)
node -e "require('fs').writeFileSync('.master-key', require('crypto').randomBytes(32).toString('base64'), { flag: 'wx', mode: 0o600 })"   # writes .master-key
npm run typecheck
npm test
```

`.master-key` holds `MASTER_KEY`, which encrypts the secrets Ystara keeps: each user's authenticator secret and each tenant's client secret. It is git-ignored, and Docker Compose hands only this file to the API and the worker, never `.env.local`. Both refuse to start without it. Keep a copy somewhere safe: without it, every user has to set up their authenticator again and every tenant's client secret has to be entered again. If `MASTER_KEY` is still in your `.env.local`, move its value into `.master-key` and delete the line (the API refuses two different keys). Behind a proxy such as Caddy, set `YSTARA_TRUST_PROXY=1` (or the proxy's addresses) so sign-in limits count per real client.

### Run the app locally (Docker)

```bash
docker compose up -d --build          # Postgres, migrations, API, worker and the web app
npm run account:create -- --name "My company" --admin you@example.com   # prints an invitation link
open <the link>                       # choose a password, set up an authenticator app, and you are in
npm run operator:grant -- --email you@example.com   # optional: the operator panel for you
docker compose down                   # stop; add -v to also delete the database
```

**Signing in.** There is no sign-up page: customer accounts are created with `npm run account:create`, which prints a one-time link (valid 7 days) for the account's first admin. Everyone signs in with email, password and a 6-digit code from an authenticator app (Microsoft or Google Authenticator, 1Password, ...). Admins invite the rest of their team, set roles (admin, developer, test coordinator, viewer) and remove people on the **Users and roles** page; Ystara sends no email, the admin passes the link on. One person can belong to several accounts and switches between them in the user menu. Tenants from before sign-in are in an account named `Default`: run `npm run account:create -- --name Default --admin you@example.com` to get in.

**The operator panel.** Whoever runs Ystara becomes its operator with `npm run operator:grant -- --email you@example.com` (only this command sets it; `--revoke` takes it away). The operator gets an **Operator** page across all customer accounts: every account with its members, admins, tenants and open invitations, and every user with their accounts and roles. It shows counts, never tenants, scans or pipelines. From there the operator creates an account (with an invitation link for its first admin), renames one, invites an admin to an account that has none left, and makes a **reset link** (valid 3 days, not for operators) for someone who lost their password or phone: they choose a new password and set up their authenticator again, and every browser signed in as them is signed out. The admins of their accounts see on **Users and roles** that Ystara reset the sign-in, and when.

The web app is laid out like Datasphere: a tenant picker in the top bar, and a side menu of apps for that tenant. **Home** shows the tenant at a glance and the next step to take. **Discovery** lists its scans; a scan lists the objects it found (with the likely outputs first), and any object opens the pipeline behind it as a lineage picture: entry tables, the output, tables with several writers and loops are marked, and clicking an object shows what it reads and writes and its definition. Writers that belong to another process can be excluded with a click, and the pipeline saved. **Pipelines** lists the saved ones, each with a Lineage tab and a Snapshots tab. **Connection** holds the technical client and the database users. Tenants, Users and roles and Operator sit at the bottom of the menu.

The API (with the web app) and Postgres are published on 127.0.0.1 only, because they speak plain http; https comes with hosting. Everything stored is metadata (definitions and lineage), never table rows.

**Ports.** Postgres is on host port 55432 (not 5432, so it never meets another Postgres on your machine) and the API on 4000. To change them, set `YSTARA_DB_PORT` / `YSTARA_API_PORT` in `.env`: Compose and the npm tools both read it, so they always agree. The API, worker and `db:*` tools check that the database they reach is Ystara's and stop with a clear message otherwise.

**Settings.** App settings and secrets go in `.env.local`. `.env` may only hold the `YSTARA_*` ports, because Compose reads `.env` and can print parts of its values (a `$` in a secret is read as a variable); the tools refuse to start when `.env` holds anything else and name the keys to move. Shell variables win over both files.

**Scanning with a technical OAuth client.** `npm run scan` uses your own `datasphere login` unless `.env.local` holds a technical OAuth client of the tenant (`DSP_CLIENT_ID`, `DSP_CLIENT_SECRET`, `DSP_TOKEN_URL`); then it logs in with that client in a temporary CLI folder, the way the worker does. `npm run spike:technical-client` checks first, read-only, whether such a client can read the spaces in `DSP_SPACE` (one or more space IDs, separated by commas); its header says how to create the client. It lists every kind of object a scan reads and reads the first of each, and ends with the count per kind: run it once per client to see which kinds a smaller role hides. Spaces are always named by their IDs: listing the tenant's spaces needs a tenant-wide privilege the client shouldn't have, so the spike only warns when it can't, and scans never do it. Add `-- --verbose` to see the CLI's requests when a step fails.

**Reading a space with SQL (phase 2, snapshots).** `npm run spike:sql` checks, read-only, whether a database user of a space (`DSP_DB_HOST`, `DSP_DB_USER`, `DSP_DB_PASSWORD`, `DSP_SPACE` in `.env.local`) can read the space with SQL: which privileges it has (it fails when one could change the space's schema), how many views and tables it sees, whether a sample of each can be read, and how long one object takes to measure with all snapshot metrics. It prints names, counts and timings, never a value from the data. Its header says how to create the user. Put `DSP_DB_USER` and `DSP_DB_PASSWORD` in single quotes (`DSP_DB_USER='SPACE#SUFFIX'`; double quotes for a password with a `'` in it): unquoted, a `#` starts a comment in `.env.local` and the rest of the value is lost. The spike refuses such a value, and a user name without `#`, before it signs in, because repeated failed sign-ins can lock the user. Every statement goes through the connector's SQL guard, `assertSelectOnly` in `packages/connector/src/readonly.ts`: one SELECT, nothing else. In the app, an admin adds one database user per space under **Connection › Database users** (host, `SPACE#SUFFIX` and password; the host must be `<id>.hana.<region>.hanacloud.ondemand.com`, or with `hna1`, `hna2`… in place of `hana`). The worker signs in once, refuses a user that could change the space, and lists what it sees; each pipeline page then marks the steps a snapshot can measure, and says why the others can't be. **Take snapshot** on a saved pipeline measures those steps; min and max (and the sum of an object with fewer than 10 rows) are kept only as a salted hash made in the tenant's database, never as the value. **Compare** on the pipeline's Snapshots tab shows what changed between two snapshots: a verdict for the pipeline and each step (unchanged, data changed, definition changed or both), the changed steps marked in the lineage picture, and each changed column's measures before and after. **Set schedule** on the same tab takes snapshots on a cron line in a time zone (weekdays at 07:30 is `30 7 * * 1-5`), with the next runs shown as it is typed; the worker takes them on its own, and the list marks them Scheduled. **Alerts:** each scheduled snapshot is compared with the pipeline's previous successful one, and the pipeline's watchers get an email when it failed, when a step's definition or columns changed, or when the output went empty or lost more than a set share of its rows (20% unless the schedule says otherwise). **Watch** on a pipeline's page follows it; whoever saves a pipeline watches it. Emails go only to watchers who are members of the account, and carry step and column names, row counts and links, never a value from the data. The worker sends them through the mail server in `SMTP_URL` (in `.env.local`: `smtp://user:password@host:587`, or `smtps://` on port 465), from `SMTP_FROM` (`Ystara <ystara@localhost>` by default), with links to `YSTARA_PUBLIC_URL` (`http://127.0.0.1:4000` by default). Without `SMTP_URL`, alerts are only shown on the snapshot page. Docker Compose sends them to **Mailpit**, a local inbox at http://127.0.0.1:8025 that sends nothing on; for `npm run dev:worker`, set `SMTP_URL=smtp://127.0.0.1:1025` to use it too.

Load a scan you already saved with `npm run scan`, without calling the tenant, then open it in the web app (the command prints the link):

```bash
npm run db:import -- --from tools/scan/output/<run> --tenant Partner [--account "My company"]
```

`--account` can be left out while there is only one account.

Without a tenant of your own, `npm run db:demo -- [--account "My company"]` adds the tenant "Synthetic demo", also without any tenant call: a scan of one space, a saved pipeline and two snapshots that differ. Its object and column names are 30, 40 and 50 characters long, the longest Datasphere allows, so a page that can't show a long name shows it there, and `npm run check:browser` reports it. Its names are left out of `npm run check:tenant-content`, which knows them from `tools/db/demo.ts`. To load it again, delete the demo tenant from its Home first.

API routes (all JSON, all under `/api`, all but sign-in, invitation and reset links need a signed-in user; `apps/api/src/auth/access.ts` explains the checks). Sign-in: `POST /auth/login`, `POST /auth/code`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/account` (switch account), `GET /invitations/:token`, `POST /invitations/:token/authenticator`, `POST /invitations/:token/accept`, `GET /resets/:token`, `POST /resets/:token/authenticator`, `POST /resets/:token/accept`. Users and roles (admins): `GET /team`, `PATCH /team/account` (rename the account), `POST /team/invitations`, `DELETE /team/invitations/:id`, `PATCH/DELETE /team/members/:userId`. Operator panel (operators only): `GET/POST /operator/accounts`, `PATCH /operator/accounts/:id` (rename), `POST /operator/accounts/:id/invitations` (a new admin), `GET /operator/users`, `POST /operator/users/:id/reset` (a reset link). Discovery: `GET/POST /tenants`, `GET /tenants/:id`, `DELETE /tenants/:id` (admins: the tenant and everything Ystara stored for it), `GET/PUT/DELETE /tenants/:id/connection` (the tenant's technical client and the spaces to scan; PUT and DELETE for admins, the secret is never sent back), `PUT /tenants/:id/connection/spaces` (admins: only the spaces), `POST /tenants/:id/connection/check` (the worker logs in again and checks each space), `GET/POST /tenants/:id/scans` (POST queues a read-only scan for the worker; with a technical client, only of spaces its last check could read), `GET /scans/:id`, `GET /scans/:id/graph`, `GET /scans/:id/objects/:space/:name` (one object with its definition and links), `GET /scans/:id/pipeline?output=...&excludeWriter=...`, `GET/POST /tenants/:id/pipelines`, `GET/DELETE /pipelines/:id` (a saved pipeline, computed on the tenant's latest successful scan). Snapshots: `GET/PUT /tenants/:id/database-users` (PUT for admins), `POST /tenants/:id/database-users/:space/check`, `DELETE /tenants/:id/database-users/:space` (admins), `GET/POST /pipelines/:id/snapshots` (POST refuses with the reason when no step is measurable), `GET /snapshots/:id`, `GET /pipelines/:id/compare?from=<snapshot>&to=<snapshot>` (two snapshots compared step by step; without a pair, the latest two successful ones), `GET/PUT/DELETE /pipelines/:id/schedule` (`{ schedule }`, null without one; PUT `{ cron, timeZone, rowDropPercent? }` refuses with the reason a line that isn't a schedule or a pipeline nothing can be measured in), `GET/PUT/DELETE /pipelines/:id/watch` (whether you watch the pipeline and how many people do; PUT watches, DELETE stops, for every role). Response types are in `packages/shared/src/api.ts`.

**Working on the web app.** `npm run dev:web` serves it on http://127.0.0.1:5173 with instant reload and forwards `/api` to the API on `YSTARA_API_PORT` (Docker's, or `npm run dev:api`). See `apps/web/README.md`.

**Checks before a push.** `npm run check:tenant-content` compares what is about to be pushed (commits, uncommitted files, commit messages with their authors, `--file` texts) with the tenant names this machine knows from git-ignored places: saved scans, `*.local.md` notes, `tools/scan/scan.local.json` and the local database. Names are found as whole words, ignoring case. An object name from a scan that is one plain word (User, POSITION) is listed apart and doesn't block, because code uses the same words; the same word in a note or `scan.local.json` still blocks. A generic name that keeps coming up can be left out altogether: list it under a "Not tenant names" heading (or after a `Not tenant names:` line) in a git-ignored note such as `.claude/tenant-conventions.local.md`. It also flags Datasphere hosts, real email addresses and files that must never be committed, and `--file` reads only files inside the repository, never those files (`.env*`, `.master-key`, `*.local.*`, scan and check output) nor `.git`. Save a PR description to check in `tools/check/drafts/`, which git ignores.

A git **pre-push hook** (`.githooks/pre-push`) runs the same check on what each push adds (`--head <commit>`: commits only, not uncommitted files), so a plain `git push` is covered too; a BLOCKED verdict stops the push and says how to fix it. `npm install` / `npm ci` turns the hook on (the `prepare` script runs `git config core.hooksPath .githooks`; outside a git folder, as in the Docker build, it does nothing). `git push --no-verify` skips the hook: a last resort, only when every hit is a false positive. Output cut off by a pipe (`git push 2>&1 | head`) can't let a push through: the hook ignores SIGPIPE and the check settles its exit code before it prints. CI runs the check too, on every PR (from its base branch) and every push to main; it has no tenant notes, scans or database, so there only the generic checks apply (hosts, email addresses, files that must never be committed).

`npm run check:browser` opens the local app in Chromium at 390, 1024, 1440 and 1920 px as a signed-in user, on every tenant of the account (`--tenant <name>` keeps to one), and records console errors, CSP violations, requests to other sites, failed API calls, sideways scrolling, text a box cuts off, technical names broken mid-word in a table column too narrow for them, and lineage nodes under the minimap, with a screenshot of each page and one more per screenful of a long page (in the git-ignored `tools/check/output/`). It signs in by writing a 15-minute session into the local database, so it refuses an app or database on another machine. Run `npx playwright install chromium` once first. In Claude Code, `/tenant-content-check` and `/browser-check` run these and judge the results (`.claude/agents/`).

**Connecting a tenant and scanning it from the app.** A tenant is added by its Datasphere URL, which must be `https://<tenant>.<region>.hcs.cloud.sap`: Ystara sends nothing to any other address. After adding it, the app opens **Connect**: a Datasphere admin creates an OAuth client with the purpose Technical User (System › Administration › App Integration), adds its technical user to the spaces to scan with a scoped role that can read their objects (e.g. Viewer), and enters the client ID, secret, token URL (on SAP's sign-in service, `https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token`) and the IDs of those spaces. Ystara stores the secret encrypted for that tenant only and never shows it again; the worker logs in with the client at once and checks each space by listing one of its views and local tables. **Connection › Technical client** shows each space as readable or not (with the CLI's error), the spaces can be changed there without entering the secret again, and the scan dialog offers only the readable ones. Every scan of that tenant then logs in with the client, in a temporary CLI folder deleted after the job (a worker that starts deletes the ones a killed worker left behind). The CLI gets none of the worker's own settings, and secrets and tokens in what it prints are masked. A tenant without a client is not scanned: the scan fails with "not connected". An admin can delete a tenant from its Home: the dialog lists what goes with it (its scans, saved pipelines and their snapshots, the stored client secret and database user passwords), and nothing in Datasphere is touched. Only for local development, a worker started with `YSTARA_WORKER_MACHINE_LOGIN=1` scans such a tenant with the Datasphere CLI's own login on its machine; the worker container has neither, so for that run the worker on your machine: `docker compose stop worker`, then `datasphere login` and `npm run dev:worker` with `YSTARA_WORKER_MACHINE_LOGIN=1` set in your shell. Never on a shared worker: every account's tenants would be read with your rights. To run the API or worker with npm against the Docker database: `docker compose up -d postgres migrate`, then `npm run dev:api` / `npm run dev:worker`. Schema changes are numbered SQL files in `packages/db/migrations/`; `npm run db:migrate` applies them.

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

**Simulating a pipeline (phase 3 spike).** `npm run spike:simulate -- --output V_HEADCOUNT_OUT` takes the newest saved scan (or `--from tools/scan/output/<run>`) and turns each step of the pipeline into one SELECT that reads nothing but `DUMMY`: tables become fixtures inlined in the statement, SQL views and SQL transformation flows are compiled from their SQL, graphical views from their CSN query. It sends nothing until you add `--run`, which runs each step's SELECT through the database user of `.env.local` (as for `npm run spike:sql`) and reports rows or the database's first error line. `--oracle` (with `--run`) also compares each exposed view with the SQL it was deployed as, over the same fixtures; when the database user can't read that SQL, as with Datasphere's views, it compares only the view's column names and order and marks the line `cols`. A table without a fixture gets made-up rows (`--rows`, 3 by default); `--fixtures file.yaml` gives real-looking ones, as a scenario's `fixtures` or a list of `{ table, rows }`. Rows given for a table stand in for it, also in place of a transformation flow that loads it. A step that can't be compiled says why, and so does every step that reads it: nothing ever falls back to reading the real object. Results land in `tools/spike/output/simulate-<time>/` (git-ignored).

**Running a scenario (phase 3a).** A scenario is a YAML file: the pipeline's output, test rows for its tables, and what you expect at any of its steps (`packages/shared/src/scenario.ts`). This one is for the synthetic sales pipeline the tests run (`packages/connector/src/simulate/scenario.test.ts`):

```yaml
name: Region totals
kind: golden
pipeline: SALES.V_REGION_OUT
fixtures:
  - table: LT_ORDERS
    rows:
      - { ORDER_ID: "1", CUSTOMER_ID: C1, AMOUNT: 10.5, STATUS: OPEN }
      - { ORDER_ID: "2", CUSTOMER_ID: C1, AMOUNT: 4.5, STATUS: OPEN }
      - { ORDER_ID: "3", CUSTOMER_ID: C2, AMOUNT: 3, STATUS: OPEN }
  - table: LT_CUSTOMERS
    rows:
      - { CUSTOMER_ID: C1, REGION: NORTH }
      - { CUSTOMER_ID: C2, REGION: SOUTH }
expect:
  - checkpoint: V_REGION_OUT
    assertions:
      - { type: row_count, equals: 2 }
      - { type: unique, columns: [REGION] }
      - { type: no_nulls, columns: [REGION, TOTAL] }
      - { type: aggregate, column: TOTAL, fn: sum, equals: 18 }
      - type: rows_equal
        key: [REGION]
        rows: [{ REGION: NORTH, TOTAL: 15 }, { REGION: SOUTH, TOTAL: 3 }]
      - { type: sql, query: 'SELECT COUNT(*) FROM {{checkpoint}} AS c WHERE c."TOTAL" > 10', equals: 1 }
```

`npm run scenario:run -- --file tools/scenario/region-totals.local.yaml` compiles it over the newest saved scan, as the spike does, and runs each assertion as one SELECT over its step's result through the database user of `.env.local`, then prints pass or FAIL with what came back. `--compile-only` sends nothing. A table the scenario gives no rows for is empty, so a result depends only on what the scenario says; rows given for a table loaded by a transformation flow stand in for that flow, so a scenario can start in the middle of a pipeline. Write numbers as numbers (`TOTAL: 15` matches the decimal `15.00`), and put text that looks like a number in quotes (`"007"` stays `"007"`). A scenario that names a real tenant's objects belongs in a file ending in `.local.yaml`, which git ignores. `npm run scenario:new -- --output <OBJECT> --file tools/scenario/<name>.local.yaml` starts one from the scan, with every table that takes rows and its columns, and `--logic` prints each step's SQL. [docs/writing-scenarios.md](docs/writing-scenarios.md) walks through writing one, key by key; in Claude Code, `/scenario-draft <OBJECT>` drafts one and `/scenario-run <file>` runs and explains one.

**Building scenarios in the app (phase 3b).** A saved pipeline's Scenarios tab lists its scenarios and opens the builder: a grid of test rows for each table that takes them (paste rows from a spreadsheet, with or without a header line), checks added per step, a compile check on the latest scan as you go, and Run, which queues the checks for the worker to send through a connected database user of the tenant. Each run has a page with every check's result. The builder shows the scenario as YAML too, for a `.local.yaml` file, and loads one. `npm run db:demo` adds a scenario with a run to the demo tenant.

**The builder, round 2 (phase 3c).** A grid shows the table's keys and the columns the pipeline reads (Show all for the rest), and Add row or Fill empty cells start rows with values that get through its filters and joins. Download Excel template gives one sheet per table to fill in and Upload Excel file reads it back. Draft rows and checks with Claude writes a first scenario from the description once the operator has entered an Anthropic API key on the operator panel (Drafting with Claude); `ANTHROPIC_API_KEY` in `.env.local` wins over it for `npm run dev:api`. It sends the description and the pipeline's definitions (names, columns, logic) to Anthropic, never tenant data, and saves nothing. The app is light by default; Appearance in the account menu switches to dark or to the system's setting.

## Read-only guarantee

Ystara never creates, changes, deletes or runs anything in a Datasphere tenant. Every CLI call goes through `assertReadOnly` in `packages/connector/src/readonly.ts`, which allows only `list` and `read` (plus `config cache init`, which only downloads the CLI's list of commands) and throws on anything else. Changing that file is a product decision, not a code detail.

## Conventions

- TypeScript everywhere, strict mode. One language to maintain.
- Every module has a short `README.md` or a header comment saying what it does and why.
- Every pull request includes a plain-language "what and why" note.
- Nothing in this repository may contain data, code or object definitions from a freelance client.
