---
name: tenant-content-check
description: Check what is about to be pushed, or a PR description, for tenant-specific content (object names, naming conventions, customer names, tenant hosts) and get a CLEAN or BLOCKED verdict. Use before every git push and before posting a PR description.
argument-hint: "[--base <branch>] [--file <path> ...]"
context: fork
agent: tenant-content-checker
background: false
allowed-tools:
  - Bash(npm run check:tenant-content)
  - Bash(npm run check:tenant-content *)
  - Bash(git diff *)
  - Bash(git log *)
  - Bash(git status *)
  - Read
  - Grep
  - Glob
---

Check the current branch for tenant-specific content before it is pushed.

Arguments: $ARGUMENTS

How to read the arguments:
- Pass `--base` and every `--file` to `npm run check:tenant-content -- ...` exactly as given.
- Without `--base`, the branch is compared with `origin/main`. For a PR stacked on another branch, the caller passes that branch.
- `--file` is for text that leaves another way, such as a PR description saved to a file. The check refuses a file that must never be committed (`.env*`, `*.local.*`, scan and check output); report that, don't work around it.

Then follow your procedure: run the check, apply the git-ignored tenant notes, judge every hit, open added images, and return the report in your standard format with a CLEAN or BLOCKED verdict.

Never change a file, never stage, commit or push, and never quote local notes beyond the name that matched. `git diff` and `git log` are for reading the outgoing lines only: `--output` and `git diff --no-index` are denied in the settings.
