import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { databaseUserProblem } from "@ystara/shared";
import { unquotedHashKeys } from "@ystara/shared/env";

/**
 * The database user in .env.local (DSP_DB_HOST, DSP_DB_USER, DSP_DB_PASSWORD,
 * and DSP_DB_PORT if not 443), checked before anyone signs in: a value cut
 * short by an unquoted # only fails, and repeated failed sign-ins can lock the
 * user. Exits with a sentence saying what to fix; nothing is sent then.
 * `needs` names the settings the calling spike needs, for that sentence.
 */
export function databaseUserFromEnv(root: string, needs: string) {
  const appFile = path.join(root, ".env.local");
  const cut = existsSync(appFile) ? unquotedHashKeys(readFileSync(appFile, "utf8"), ["DSP_DB_USER", "DSP_DB_PASSWORD"]) : [];
  if (cut.length) {
    console.error(
      `${cut.join(" and ")} in .env.local ${cut.length === 1 ? "has" : "have"} an unquoted #, which starts a comment, so only the part before it is read. ` +
        "Put the value in single quotes (double quotes if it has a ' in it), e.g. DSP_DB_USER='SPACE#SUFFIX'. Nothing was sent to the tenant.",
    );
    process.exit(1);
  }
  const db = { host: requiredEnv("DSP_DB_HOST", needs), port: Number(process.env.DSP_DB_PORT?.trim() || 443), user: requiredEnv("DSP_DB_USER", needs), password: requiredEnv("DSP_DB_PASSWORD", needs) };
  const userProblem = databaseUserProblem(db.user);
  if (userProblem) {
    console.error(`DSP_DB_USER: ${userProblem}. In .env.local, quote the value (DSP_DB_USER='SPACE#SUFFIX'): an unquoted # starts a comment. Nothing was sent to the tenant.`);
    process.exit(1);
  }
  return db;
}

export function requiredEnv(name: string, needs: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is missing in .env.local. ${needs}`);
    process.exit(1);
  }
  return value;
}
