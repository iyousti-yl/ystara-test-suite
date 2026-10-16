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
