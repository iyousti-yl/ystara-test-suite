import { execa } from "execa";
import { assertReadOnly, commandPath, type CliObjectKind, type ReadCommand } from "./readonly.js";

/**
 * Thin, read-only wrapper around `@sap/datasphere-cli` (tested with 2026.x).
 *
 * Why the CLI and not direct API calls: it is SAP's supported automation
 * surface for Datasphere objects, handles login for us, and tracks SAP's
 * object formats. We pay with a process spawn per call, which is fine for a
 * background worker.
 *
 * Authentication: the user (or, later, the worker) logs in once with
 * `datasphere login`; this wrapper only passes `--host`.
 *
 * CLI 2026.x notes (found with the feasibility spike):
 *  - `list` and `read` always return JSON; there is no `--output` flag.
 *  - `list` returns 25 items unless `--top` is given.
 *  - SQL and graphical views share the `views` command.
 */
export interface CliOptions {
  host: string;
  /** Executable name or path. Default "datasphere". */
  bin?: string;
  /** Per-call timeout. Default 120 s. */
  timeoutMs?: number;
}

export interface ListedObject {
  technicalName: string;
  businessName?: string;
}

export class DatasphereCli {
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: CliOptions) {
    this.bin = opts.bin ?? "datasphere";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** The single place a CLI process is started. Every call passes the read-only guard first. */
  async exec(cmd: ReadCommand, flags: Record<string, string> = {}): Promise<string> {
    const path = commandPath(cmd);
    assertReadOnly(path);
    const args = ["--host", this.opts.host, ...path, ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])];
    const { stdout } = await execa(this.bin, args, { timeout: this.timeoutMs });
    return stdout;
  }

  async version(): Promise<string> {
    const { stdout } = await execa(this.bin, ["--version"], { timeout: this.timeoutMs });
    return stdout.trim();
  }

  async listObjects(space: string, kind: CliObjectKind, top = 1000): Promise<ListedObject[]> {
    const out = await this.exec({ group: "objects", kind, verb: "list" }, { space, top: String(top) });
    return parseListing(out);
  }

  async readObject(space: string, kind: CliObjectKind, technicalName: string): Promise<unknown> {
    const out = await this.exec({ group: "objects", kind, verb: "read" }, { space, "technical-name": technicalName });
    return JSON.parse(out) as unknown;
  }
}

/** Accepts the shapes seen so far: an array of strings or of objects with technicalName/name. */
export function parseListing(stdout: string): ListedObject[] {
  const parsed = JSON.parse(stdout) as unknown;
  const items = Array.isArray(parsed) ? parsed : [];
  return items
    .map((item): ListedObject | null => {
      if (typeof item === "string") return { technicalName: item };
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        const name = o.technicalName ?? o.name;
        if (typeof name === "string") {
          return { technicalName: name, businessName: typeof o.businessName === "string" ? o.businessName : undefined };
        }
      }
      return null;
    })
    .filter((x): x is ListedObject => x !== null);
}
