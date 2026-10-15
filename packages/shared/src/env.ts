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
 *
 * Variables already set in the shell win over both files.
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
}

/** The variable names in a dotenv text. Values are never looked at, so they can't end up in an error. */
export function envKeys(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
    .filter((key): key is string => key !== undefined);
}
