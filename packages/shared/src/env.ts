import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Settings files at the repository root, for the programs you run on your
 * machine (API, worker, scan and database tools). Node only: import it from
 * "@ystara/shared/env"; the package index doesn't export it, so the web app
 * never pulls in node:fs.
 *
 *   .env.local  App settings and secrets (Datasphere, database URL). Git-ignored.
 *   .env        Docker Compose settings only: the YSTARA_* host ports. Compose reads
 *               this file for variable substitution and can print parts of its values
 *               in warnings (a `$` in a secret is read as a variable), so anything else
 *               in it stops the program before it starts.
 *   .master-key The key that encrypts stored secrets (MASTER_KEY), alone in its own
 *               git-ignored file, so Docker Compose can hand it to the containers that
 *               need it and nothing else from .env.local. Found through MASTER_KEY_FILE.
 *
 * Variables already set in the shell win over the files.
 */
export const COMPOSE_SETTING = /^(YSTARA_[A-Z0-9_]+|COMPOSE_[A-Z0-9_]+)$/;

export function loadLocalEnv(root: string): void {
  const composeFile = path.join(root, ".env");
  if (existsSync(composeFile)) {
    const misplaced = envKeys(readFileSync(composeFile, "utf8")).filter((k) => !COMPOSE_SETTING.test(k));
    if (misplaced.length > 0) {
      throw new Error(
        `.env contains ${misplaced.join(", ")}. Docker Compose reads .env and can print parts of its values, ` +
          "so app settings and secrets belong in .env.local: move these lines there (same format) and keep only YSTARA_* ports in .env.",
      );
    }
    process.loadEnvFile(composeFile);
  }
  const appFile = path.join(root, ".env.local");
  if (existsSync(appFile)) process.loadEnvFile(appFile);
  const keyFile = path.join(root, ".master-key");
  if (!process.env.MASTER_KEY_FILE && existsSync(keyFile)) process.env.MASTER_KEY_FILE = keyFile;
}

/**
 * A setting that may come from a file: NAME_FILE names the file (Docker
 * Compose mounts secrets as files under /run/secrets, so a password never
 * sits in a container's environment), otherwise NAME itself. The file holds
 * the value alone; a final line break is dropped.
 */
export function settingFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env[`${name}_FILE`]?.trim();
  if (!file) return env[name];
  if (!existsSync(file)) throw new Error(`${name}_FILE names ${file}, which doesn't exist.`);
  return readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r?\n$/, "");
}

/** The variable names in a dotenv text. Values are never looked at, so they can't end up in an error. */
export function envKeys(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
    .filter((key): key is string => key !== undefined);
}

/**
 * The keys among `keys` whose value in a dotenv text has an unquoted #. Node's
 * loader reads an unquoted # as the start of a comment, anywhere in the value,
 * so `USER=SPACE#SUFFIX` gives "SPACE". In quotes it is kept: `USER='SPACE#SUFFIX'`.
 * Like envKeys, it says which key, never what the value is.
 */
export function unquotedHashKeys(text: string, keys: string[]): string[] {
  const found = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && keys.includes(m[1]) && !/^["'`]/.test(m[2]) && m[2].includes("#")) found.add(m[1]);
  }
  return [...found];
}

/**
 * The version this program runs: YSTARA_VERSION, which the Docker build sets to the git commit it was built from
 * (deploy/compose passes it), or "dev" on a developer's machine. /api/health and /api/meta show it, and each
 * worker records it with its sign of life.
 */
export const appVersion = (env: NodeJS.ProcessEnv = process.env): string => env.YSTARA_VERSION?.trim() || "dev";
