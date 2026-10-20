---
name: scenario-run
description: Run a Ystara scenario file, compile-only first and then its checks as read-only SELECTs, and explain each FAIL, ERROR and problem by the step that causes it. Use when asked to run, check or explain a scenario or its results.
argument-hint: "<scenario.local.yaml> [--compile-only] [--from <scan folder>] [--exclude-writer <FLOW> ...]"
context: fork
agent: scenario-runner
background: false
allowed-tools:
  - Bash(npm run scenario:run *)
  - Bash(npm run scenario:new * --logic*)
  - Bash(npm run spike:simulate -- --output * --fixtures *)
  - Bash(grep -c '^DSP_DB_USER=.' .env.local)
  - Read
  - Grep
  - Glob
---

Run one Ystara scenario and explain the result.

Arguments: $ARGUMENTS

How to read the arguments:
- The first word is the scenario file, usually `tools/scenario/<name>.local.yaml`. Without one, list the `.local.yaml` files in `tools/scenario/` and ask which to run.
- With `--compile-only`, compile and explain, and don't run the checks.
- Keep `--from <folder>` and every `--exclude-writer <FLOW>` exactly as given, on every command.

Then follow your procedure: compile with `npm run scenario:run -- --file <file> --compile-only`, run without `--compile-only` unless told not to, explain every check that didn't pass as [rows], [expected], [compiler gap] or [error] from the logic of the steps (`npm run scenario:new -- --output <OUTPUT> --logic`), and return your report.

Never change a file, never run `spike:simulate` with `--run` or `--oracle`, and never run Datasphere commands or SQL of your own. If the full run is refused, give the user the command to run themselves.
