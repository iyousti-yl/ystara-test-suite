# Decisions log

Short entries, newest first. One line of context, the decision, and why. Link the PR when there is one.

- **2026-10-15** The connector's pipeline builder now applies the pipeline rules below (PR #2). Which writer belongs is configuration, not code: `--exclude-writer` or a git-ignored `tools/scan/scan.local.json`. Without it, every writer of a table is followed and the table is flagged as ambiguous, so nothing is silently dropped (Claude's default; revisit if ambiguous tables turn out to be common).
- **2026-10-15** **No tenant-specific content in the repository** (Issam). Object names, naming conventions and process rules of a tenant live in git-ignored local files (`.claude/tenant-conventions.local.md`, scan output), never in commits. Today we build against one tenant; the product must stay tenant-agnostic.
- **2026-10-15** **What a pipeline is** (Issam, after the first real scan of the partner space). Traced backwards from the output view through the main chain (view ← table ← its flow ← … ← ingestion tables ← the flows that load them). Config and control tables/views are side inputs and belong to the pipeline, with their own dependencies. Only the writer that belongs to the pipeline is followed; other writers of the same table belong to other processes and are excluded until they become relevant. Task chains are orchestration and are not part of the pipeline. References in SQL comments don't count. The scanner agent applies these rules; the pipeline builder in the connector still needs to.
- **2026-10-15** Repeated, isolated jobs get a dedicated Claude Code subagent plus a skill that forks into it (Issam). First one: `datasphere-scanner` agent and `/datasphere-scan` skill. Project settings also deny Datasphere write commands for Claude Code.
- **2026-10-15** Scenario tests run as **read-only simulations** (fixtures inlined into one `SELECT`), not in a sandbox space (Issam, decision card). Flow types that can't be expressed in SQL get snapshot tests only.
- **2026-10-15** **Ystara is strictly read-only** on customer tenants: no create, update, delete or task runs, enforced by `assertReadOnly` in the connector (Issam). The spike's deploy and task-chain steps were removed.
- **2026-10-15** CLI spike succeeded on the partner tenant (CLI 2026.x).

- **2026-10-14** Code name "Ystara Test Suite" (Issam). Product name TBD; must not contain "SAP" or "Datasphere".
- **2026-10-14** Scope, stack, pricing hypothesis and phases approved as in `/business-ideas/master-plan.md` (project files). v1 hosted, metadata-only, snapshots + scenarios, roles, scheduled runs, email + Teams alerts.
- **2026-10-14** Build model: Claude writes most code, Issam reviews every PR; each PR carries a plain-language "what and why" note.
