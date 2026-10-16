import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
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
 * Authentication, two ways:
 *  - A technical OAuth client of the tenant (`client`): every call logs in
 *    with client credentials through a secrets file, so nobody needs to be
 *    present. This is how the worker scans.
 *  - Without `client`, the login stored on this machine (`datasphere login`),
 *    for a developer running `npm run scan`.
 * `configDir` gives the CLI its own folder (its cache, the secrets file and
 * the token it gets), so tenants never share a login. Delete it when done.
 *
 * CLI 2026.x notes (found with the feasibility spikes):
 *  - `list` and `read` always return JSON; there is no `--output` flag.
 *  - `list` returns 25 items unless `--top` is given.
 *  - SQL and graphical views share the `views` command.
 *  - `--host` only counts after the command and its flags. Before the
 *    command the CLI ignores it.
 *  - When it lacks something, such as the host, the CLI asks for it and exits
 *    with code 0, so exit code 0 alone doesn't mean it answered.
 *  - `spaces list` and `spaces read` need a tenant-wide privilege that a
 *    technical client with a role in its spaces doesn't have. Scans don't
 *    use them.
 */
export interface CliOptions {
  host: string;
  /** Executable name or path. Default "datasphere". */
  bin?: string;
  /** Per-call timeout. Default 120 s. */
  timeoutMs?: number;
  /** Log in with this client on every call. Needs `configDir`. */
  client?: TechnicalClient;
  /** The CLI's home folder for this tenant. Default: the user's own home and its stored login. */
  configDir?: string;
  /** Ask the CLI to log its requests, so a failure says more than "failed". For troubleshooting only. */
  verbose?: boolean;
}

/** An OAuth client created in the tenant with the purpose "Technical User" (client credentials). */
export interface TechnicalClient {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
}

export interface ListedObject {
  technicalName: string;
  businessName?: string;
}

export class DatasphereCli {
  private readonly bin: string;
  private readonly timeoutMs: number;

  private secrets?: Promise<string>;

  constructor(private readonly opts: CliOptions) {
    if (opts.client && !opts.configDir) throw new Error("A technical client needs a configDir of its own, so its secret never lands in a user's home folder");
    this.bin = opts.bin ?? "datasphere";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /**
   * The single place a CLI process is started. Every call passes the read-only guard first, and what the CLI printed is
   * checked before it is returned: a question instead of an answer, or a `list` or `read` that isn't JSON, is a failure
   * even when the CLI exits with code 0.
   */
  async exec(cmd: ReadCommand, flags: Record<string, string> = {}): Promise<string> {
    const command = commandPath(cmd);
    assertReadOnly(command);
    // The host, the login and --verbose go after the command and its flags, for every command. The CLI ignores a host
    // before the command: it asks for the URL of the system, or uses the host stored by `datasphere login`.
    const args = [...command, ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v]), "--host", this.opts.host];
    if (this.opts.client) args.push("--secrets-file", await this.secretsFile());
    if (this.opts.verbose) args.push("--verbose");
    // The CLI keeps its cache and tokens under the home folder: HOME on Linux and macOS, USERPROFILE on Windows.
    const env = this.opts.configDir ? { HOME: this.opts.configDir, USERPROFILE: this.opts.configDir } : undefined;
    // No input, so a question from the CLI gets no answer and ends the call at once instead of waiting until the timeout.
    const { stdout, stderr } = await execa(this.bin, args, { timeout: this.timeoutMs, env, stdin: "ignore" });
    this.checkAnswer(command, stdout, stderr);
    return stdout;
  }

  /** Throws when the CLI asked a question, or when a `list` or `read` printed something other than JSON. */
  private checkAnswer(command: string[], stdout: string, stderr: string): void {
    const name = `datasphere ${command.join(" ")}`;
    const lines = (text: string) => text.split("\n").map((l) => stripVTControlCharacters(l).trim()).filter(Boolean);
    const output = this.withoutSecret([stdout, stderr].filter(Boolean).join("\n"));
    // A prompt starts with "?", e.g. "? URL of the system to connect to". No line of JSON does.
    const question = [...lines(stdout), ...lines(stderr)].find((l) => l.startsWith("?"));
    if (question) {
      const asked = clip(this.withoutSecret(question.slice(1).trim()));
      throw new CliOutputError(`${name} asked "${asked}" instead of answering. Ystara gives the CLI no input: check the host and the login.`, output);
    }
    if (["list", "read"].includes(command[command.length - 1]) && !isJson(stdout)) {
      const first = lines(stdout)[0];
      throw new CliOutputError(`${name} printed ${first ? `"${clip(this.withoutSecret(first))}"` : "nothing"} instead of JSON.`, output);
    }
  }

  private withoutSecret(text: string): string {
    const secret = this.opts.client?.clientSecret;
    return secret ? text.replaceAll(secret, "<secret>") : text;
  }

  /** Downloads the tenant's list of CLI commands; the object commands only exist after it. Once per configDir. */
  async initCache(): Promise<void> {
    await this.exec({ group: "config", verb: "cache-init" });
  }

  /** The secrets file the CLI reads the client from, readable by this user only. Written once. */
  private secretsFile(): Promise<string> {
    return (this.secrets ??= (async () => {
      const file = path.join(this.opts.configDir!, "ystara-client.json");
      const { clientId, clientSecret, tokenUrl } = this.opts.client!;
      // Client credentials only use the token URL, but without an authorization URL next to it the CLI looks both up on the tenant first.
      const secrets = {
        client_id: clientId,
        client_secret: clientSecret,
        token_url: tokenUrl,
        authorization_url: tokenUrl.replace(/\/token\/?$/, "/authorize"),
        authorization_flow: "client_credentials",
      };
      await writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
      await chmod(file, 0o600);
      return file;
    })());
  }

  async version(): Promise<string> {
    const { stdout } = await execa(this.bin, ["--version"], { timeout: this.timeoutMs, stdin: "ignore" });
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

/**
 * The CLI ended without an error but didn't give what the command should: it asked a question, or a `list` or `read`
 * printed something other than JSON. `output` is everything it printed, without the client secret.
 */
export class CliOutputError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
    this.name = "CliOutputError";
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function clip(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
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
