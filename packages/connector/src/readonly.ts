/**
 * Read-only guard.
 *
 * Ystara never changes anything in a customer's Datasphere tenant. This is a
 * product promise, so it is enforced in code, not only by convention:
 * every CLI call goes through `assertReadOnly`, which allows a short list of
 * read commands and throws on anything else. Adding a write command means
 * changing this file on purpose, in a reviewed PR.
 *
 * Besides reads, one housekeeping command is allowed: `config cache init`,
 * which downloads the tenant's list of CLI commands into the CLI's local
 * cache (the object commands only exist after it). It changes nothing in the
 * tenant.
 *
 * SQL through a database user of a space goes through `assertSelectOnly`:
 * one SELECT statement and nothing else.
 */

export const CLI_OBJECT_KINDS = [
  "remote-tables",
  "local-tables",
  "replication-flows",
  "data-flows",
  "transformation-flows",
  "views", // CLI 2026.x merged sql-views and graphical-views into one command
  "analytic-models",
  "task-chains",
  "intelligent-lookups",
] as const;

export type CliObjectKind = (typeof CLI_OBJECT_KINDS)[number];

/** The only commands Ystara may run. */
export type ReadCommand =
  | { group: "objects"; kind: CliObjectKind; verb: "list" | "read" }
  | { group: "spaces"; verb: "list" | "read" }
  | { group: "config"; verb: "cache-init" };

const READ_VERBS = new Set(["list", "read"]);

export class WriteAttemptError extends Error {
  constructor(path: string[]) {
    super(`Blocked non-read Datasphere CLI command: "${path.join(" ")}". Ystara is read-only.`);
    this.name = "WriteAttemptError";
  }
}

export function commandPath(cmd: ReadCommand): string[] {
  if (cmd.group === "objects") return ["objects", cmd.kind, cmd.verb];
  if (cmd.group === "spaces") return ["spaces", cmd.verb];
  return ["config", "cache", "init"];
}

/**
 * Throws unless `path` is exactly one of the allowed read commands. Checked at
 * runtime as well as by the `ReadCommand` type, because types disappear in JS
 * callers and in anything built from user input.
 */
export function assertReadOnly(path: readonly string[]): void {
  const ok =
    (path.length === 3 &&
      path[0] === "objects" &&
      (CLI_OBJECT_KINDS as readonly string[]).includes(path[1]) &&
      READ_VERBS.has(path[2])) ||
    (path.length === 2 && path[0] === "spaces" && READ_VERBS.has(path[1])) ||
    (path.length === 3 && path[0] === "config" && path[1] === "cache" && path[2] === "init");
  if (!ok) throw new WriteAttemptError([...path]);
}

export class NotSelectError extends Error {
  constructor(reason: string) {
    super(`Blocked SQL that isn't a single SELECT (${reason}). Ystara is read-only.`);
    this.name = "NotSelectError";
  }
}

/**
 * Throws unless `sql` is one SELECT statement. Ystara builds every statement
 * itself, with quoted identifiers and `?` parameters for values, so the rules
 * can be strict: it starts with SELECT, and has no semicolon (a second
 * statement), no comment (which could hide one), no INTO (SQLScript writes a
 * result into a variable or table) and no FOR UPDATE or FOR SHARE (row locks).
 * The checks run with quoted identifiers and string literals blanked out, so a
 * name like "A;B" is fine but an unclosed quote is refused.
 */
export function assertSelectOnly(sql: string): void {
  const blanked = sql.replace(/"(?:[^"]|"")*"/g, '""').replace(/'(?:[^']|'')*'/g, "''");
  const reason =
    /["']/.test(blanked.replace(/""|''/g, ""))
      ? "an unclosed quote"
      : !/^\s*select\b/i.test(blanked)
        ? "it doesn't start with SELECT"
        : blanked.includes(";")
          ? "a semicolon"
          : /--|\/\*/.test(blanked)
            ? "a comment"
            : /\binto\b/i.test(blanked)
              ? "INTO"
              : /\bfor\s+(update|share)\b/i.test(blanked)
                ? "a row lock"
                : undefined;
  if (reason) throw new NotSelectError(reason);
}
