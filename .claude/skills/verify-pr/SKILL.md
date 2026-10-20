---
name: verify-pr
description: Verify a Ystara pull request on this machine, end to end with the local Docker stack, and report PASS or FAIL per step plus the checks only the person can do. Use when asked to verify, check or test a PR before it is marked ready or merged.
argument-hint: "<PR number> | --branch <branch>"
context: fork
agent: pr-verifier
background: false
allowed-tools:
  - Bash(git status --porcelain)
  - Bash(git branch --show-current)
  - Bash(git fetch origin *)
  - Bash(git checkout --detach FETCH_HEAD)
  - Bash(git rev-parse *)
  - Bash(docker info*)
  - Bash(npm ci)
  - Bash(npm run typecheck)
  - Bash(npm run lint)
  - Bash(npm test)
  - Bash(docker compose up -d --build)
  - Bash(docker compose ps*)
  - Bash(docker compose logs *)
  - Bash(npm run db:demo*)
  - Bash(npm run check:browser*)
  - Bash(gh pr view *)
  - Read
  - Grep
  - Glob
---

Verify one Ystara pull request on this machine.

Arguments: $ARGUMENTS

How to read the arguments:
- A number is the PR: fetch `origin pull/<number>/head`.
- `--branch <branch>` checks out that branch's head instead (`git fetch origin <branch>`).
- With no arguments, ask which PR.

Then follow your procedure: preflight (a clean working tree, Docker running), check out the head detached, run `npm ci`, typecheck, lint and tests, start the stack with `docker compose up -d --build` and read its status and logs, load the demo tenant, run the browser check in light and dark, run the PR's own checks that fit your rules, and return your report with a PASS or FAIL per step and the steps left for the person.

Never merge, push, commit or reset; never stash or discard local changes; never run `docker compose down -v`, Datasphere commands, or anything that signs in with the tenant's database user. Those go to the person, with the exact command.
