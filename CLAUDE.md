# Ystara Test Suite: working rules

Regression and scenario testing for SAP Datasphere pipelines. Read `docs/architecture/overview.md` before changing anything structural.

## Non-negotiable

- **Read-only on every Datasphere tenant.** Code may only `list`/`read` through the CLI and run `SELECT` through SQL. No create, update, delete, deploy or task runs, ever. The gate is `packages/connector/src/readonly.ts`; changing it is a product decision, not a code change. `.claude/settings.json` also denies write commands for Claude Code.
- **No client data or code in this repository.** Fixtures are synthetic. Scan output (`tools/scan/output/`) and `.env` are git-ignored and never committed.

## How we work

- **Repeated, isolated jobs get their own agent and skill.** When a job is run again and again on its own (a scan, a report, a check), define a subagent in `.claude/agents/<name>.md` (narrow tools, its own rules and report format) and a skill in `.claude/skills/<name>/SKILL.md` with `context: fork` and `agent: <name>` that hands it the task. Example: `/datasphere-scan HR --output V_HEADCOUNT_OUT` runs the `datasphere-scanner` agent.
- Every PR starts with the note in `docs/pr-note-template.md`: what changed in plain language, why, how, how to check, what it doesn't do yet.
- Issam develops on Windows: build paths with `path`, `fileURLToPath` and `pathToFileURL`, never by string concatenation of `import.meta.url`.
- Record decisions in `docs/architecture/decisions-log.md`.

## Commands

```bash
npm run typecheck   # tsc for all packages and tools
npm run lint
npm test
npm run scan -- --space <SPACE> [--output <OBJECT>]   # read-only discovery scan
```
