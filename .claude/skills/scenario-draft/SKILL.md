---
name: scenario-draft
description: Draft a test scenario for a pipeline from the saved scan, with made-up rows that pass its filters and joins and expected results worked out from its logic, and compile it without sending anything. Use when asked to write, start or draft a scenario for a pipeline or view.
argument-hint: "<OUTPUT> [--name <file name>] [--from <scan folder>] [--exclude-writer <FLOW> ...] [what the case should test]"
context: fork
agent: scenario-writer
background: false
allowed-tools:
  - Bash(npm run scenario:new *)
  - Bash(npm run scenario:run * --compile-only*)
  - Read
  - Grep
  - Glob
  - Write(./tools/scenario/*.local.yaml)
  - Edit(./tools/scenario/*.local.yaml)
---

Draft one Ystara scenario and compile it.

Arguments: $ARGUMENTS

How to read the arguments:
- The first word is the pipeline's output, `OBJECT` or `SPACE.OBJECT`.
- `--name <name>` names the file `tools/scenario/<name>.local.yaml`. Without it, use the output's name in lower case with `_` as `-`, and add `-2`, `-3`... when that file exists.
- Keep `--from <folder>` and every `--exclude-writer <FLOW>` exactly as given.
- Any other words say what the case should test (e.g. "an employee without a manager"). Build the rows and checks around that case, and still cover the normal path in at least one row.

Then follow your procedure: `npm run scenario:new -- --output <OUTPUT> --file <file> --logic`, read the logic, choose made-up rows that exercise it, work out the expected results by hand, write the checks with a comment on each, compile with `npm run scenario:run -- --file <file> --compile-only` until every check says ok, and return your report.

Never run the scenario without `--compile-only`, never send SQL or Datasphere commands, never copy real values, and never write any file but the one `.local.yaml`.
