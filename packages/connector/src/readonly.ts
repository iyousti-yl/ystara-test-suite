/**
 * Read-only guard.
 *
 * Ystara never changes anything in a customer's Datasphere tenant. This is a
 * product promise, so it is enforced in code, not only by convention:
 * every CLI call goes through `assertReadOnly`, which allows a short list of
 * read commands and throws on anything else. Adding a write command means
 * changing this file on purpose, in a reviewed PR.
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
  | { group: "spaces"; verb: "list" | "read" };

const READ_VERBS = new Set(["list", "read"]);

export class WriteAttemptError extends Error {
  constructor(path: string[]) {
    super(`Blocked non-read Datasphere CLI command: "${path.join(" ")}". Ystara is read-only.`);
    this.name = "WriteAttemptError";
  }
}

export function commandPath(cmd: ReadCommand): string[] {
  return cmd.group === "objects" ? ["objects", cmd.kind, cmd.verb] : ["spaces", cmd.verb];
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
    (path.length === 2 && path[0] === "spaces" && READ_VERBS.has(path[1]));
  if (!ok) throw new WriteAttemptError([...path]);
}
