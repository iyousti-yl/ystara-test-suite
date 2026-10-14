import { execa } from "execa";
import type { TenantConnection } from "./types.js";

/**
 * Thin wrapper around `@sap/datasphere-cli`.
 *
 * Why a wrapper and not direct API calls: the CLI is SAP's supported automation
 * surface for Datasphere objects, handles OAuth for us, and tracks SAP's
 * object formats. We pay with a process spawn per call, which is fine for a
 * background worker.
 *
 * The exact subcommands differ slightly between CLI releases; the feasibility
 * spike (tools/spike) records what the installed version supports and this file
 * is adjusted from its output. Treat the commands below as the phase 0 draft.
 */
export class DatasphereCli {
  constructor(
    private readonly conn: TenantConnection,
    private readonly bin = "datasphere",
  ) {}

  private baseArgs(): string[] {
    return ["--host", this.conn.host];
  }

  /** Runs a CLI command and returns stdout. Secrets go through an options file, never argv, so they don't show in process lists. */
  async run(args: string[], input?: string): Promise<string> {
    const { stdout } = await execa(this.bin, [...this.baseArgs(), ...args], {
      input,
      env: { ...process.env, DATASPHERE_OAUTH_CLIENT_ID: this.conn.oauth.clientId },
      reject: true,
    });
    return stdout;
  }

  async version(): Promise<string> {
    const { stdout } = await execa(this.bin, ["--version"]);
    return stdout.trim();
  }

  async listSpaces(): Promise<string[]> {
    const out = await this.run(["spaces", "list", "--output", "json"]);
    const parsed = JSON.parse(out) as unknown;
    return Array.isArray(parsed) ? parsed.map((s) => String((s as { name?: string }).name ?? s)) : [];
  }

  async listObjects(space: string, kind: string): Promise<unknown> {
    // e.g. kind = "tables" | "views" | "data-flows" | "task-chains" | ...
    const out = await this.run(["objects", kind, "list", "--space", space, "--output", "json"]);
    return JSON.parse(out) as unknown;
  }

  async readObject(space: string, kind: string, technicalName: string): Promise<unknown> {
    const out = await this.run(["objects", kind, "read", "--space", space, "--technical-name", technicalName, "--output", "json"]);
    return JSON.parse(out) as unknown;
  }

  async createObject(space: string, kind: string, definition: unknown): Promise<void> {
    await this.run(["objects", kind, "create", "--space", space, "--file-path", "/dev/stdin"], JSON.stringify(definition));
  }

  async runTaskChain(space: string, technicalName: string): Promise<string> {
    return this.run(["tasks", "chains", "run", "--space", space, "--object", technicalName]);
  }
}
