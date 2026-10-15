# Decisions log

Short entries, newest first. One line of context, the decision, and why. Link the PR when there is one.

- **2026-10-15** Repeated, isolated jobs get a dedicated Claude Code subagent plus a skill that forks into it (Issam). First one: `datasphere-scanner` agent and `/datasphere-scan` skill. Project settings also deny Datasphere write commands for Claude Code.
- **2026-10-15** Scenario tests run as **read-only simulations** (fixtures inlined into one `SELECT`), not in a sandbox space (Issam, decision card). Flow types that can't be expressed in SQL get snapshot tests only.
- **2026-10-15** **Ystara is strictly read-only** on customer tenants: no create, update, delete or task runs, enforced by `assertReadOnly` in the connector (Issam). The spike's deploy and task-chain steps were removed.
- **2026-10-15** CLI spike succeeded on the partner tenant (CLI 2026.x).

- **2026-10-14** Code name "Ystara Test Suite" (Issam). Product name TBD; must not contain "SAP" or "Datasphere".
- **2026-10-14** Scope, stack, pricing hypothesis and phases approved as in `/business-ideas/master-plan.md` (project files). v1 hosted, metadata-only, snapshots + scenarios, roles, scheduled runs, email + Teams alerts.
- **2026-10-14** Build model: Claude writes most code, Issam reviews every PR; each PR carries a plain-language "what and why" note.
