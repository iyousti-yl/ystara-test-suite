---
name: browser-check
description: Check Ystara's web app in a real browser at several widths for console errors, CSP violations, requests to other sites, failed API calls and layout problems. Use after changing the web app, before a PR is marked ready, or when a page looks wrong.
argument-hint: "[--as <email>] [--account <name>] [--page /path ...] [--widths 390,1440] [--dark] [--url http://127.0.0.1:5173]"
context: fork
agent: browser-checker
background: false
allowed-tools:
  - Bash(npm run check:browser)
  - Bash(npm run check:browser *)
  - "Bash(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000/api/auth/me)"
  - "Bash(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/api/auth/me)"
  - Read
  - Grep
  - Glob
---

Check the running web app in Chromium and report what is wrong.

Arguments: $ARGUMENTS

How to read the arguments:
- Pass them to `npm run check:browser -- ...` exactly as given. `--page` takes paths on this app that start with one `/` (the check refuses anything else).
- With no arguments, run it without any: it signs in as the operator (or the first admin) and opens every kind of page that has data at 390, 1024, 1440 and 1920 px.
- When asked to check a change in dark mode, run once without and once with `--dark`.

Then follow your procedure: preflight, run the check, read `report.json`, look at the screenshots, and return the report in your standard format. The only curl commands allowed without asking are the preflight from your procedure, exactly as written there, against the app on this machine (the API's port 4000 or the dev server's 5173).

Only open pages: never click anything that changes data, never write your own browser scripts, and never change a file.
