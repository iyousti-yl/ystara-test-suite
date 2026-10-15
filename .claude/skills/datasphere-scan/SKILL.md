---
name: datasphere-scan
description: Scan SAP Datasphere spaces read-only and check the lineage they produce. Use when asked to scan a space, show or verify the lineage of a pipeline or view, or validate discovery against a real tenant.
argument-hint: "<SPACE> [<SPACE> ...] [--output <OBJECT>]  |  --from <scan-folder> --output <OBJECT>"
context: fork
agent: datasphere-scanner
background: false
allowed-tools:
  - Bash(npm run scan *)
  - Bash(datasphere --version)
  - Bash(grep -c *)
  - Read
  - Grep
  - Glob
---

Run a read-only Ystara discovery scan and report on it.

Arguments: $ARGUMENTS

How to read the arguments:
- Bare words are space names; pass each one as `--space <NAME>`.
- Keep `--output <OBJECT>` and `--from <folder>` exactly as given. `--output` can be `OBJECT` or `SPACE.OBJECT`.
- With no arguments, scan the space in `DSP_SPACE` from `.env` (check it is set with `grep -c '^DSP_SPACE=.' .env`; never print `.env`), without `--output`.

Then follow your procedure: preflight, scan with `npm run scan -- ...`, read the newest folder in `tools/scan/output/`, check the lineage for warnings, isolated objects, missed references and implausible edges, and return the report in your standard format.

With `--output`, build the pipeline by your pipeline rules, not as `pipeline.json` has it: trace back from the output through the main chain to the ingestion tables and the flows that load them, include config and control side inputs and what they depend on, follow only the writer that belongs to this pipeline (other writers are listed as excluded), leave out task chains, and ignore references that only appear in SQL comments. Apply `.claude/tenant-conventions.local.md` on top if it exists.

Never run any Datasphere command other than `datasphere --version` yourself, and never change any file.
