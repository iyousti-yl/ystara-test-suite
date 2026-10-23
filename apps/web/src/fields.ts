import { DATASPHERE_URL_HINT, isDatasphereUrl, isTokenUrl, TOKEN_URL_HINT } from "@ystara/shared";

/**
 * The checks a form makes on a field before it sends it, the same the API
 * makes, so the reason shows under the field (its valueState) instead of
 * coming back from the API. Each says what is wrong, or nothing while the
 * field is fine or still empty (an empty required field only keeps the button
 * disabled).
 */

/** Names of tenants, pipelines and accounts: the API takes up to this many characters. */
export const NAME_MAX = 100;

/** A scenario's name may be longer: it says what the scenario shows. */
export const SCENARIO_NAME_MAX = 200;

/** The most spaces one scan or one technical client takes. */
export const MAX_SPACES = 20;

export const datasphereUrlProblem = (text: string) => (text.trim() && !isDatasphereUrl(text.trim()) ? DATASPHERE_URL_HINT : undefined);

export const tokenUrlProblem = (text: string) => (text.trim() && !isTokenUrl(text.trim()) ? TOKEN_URL_HINT : undefined);

const SPACE_ID = /^[A-Za-z0-9_]{1,64}$/;

/** "SALES, STOCK" typed by hand, as space IDs; undefined while one of them isn't a space ID. */
export function parseSpaceIds(text: string): string[] | undefined {
  const ids = text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.every((id) => SPACE_ID.test(id)) ? ids : undefined;
}

/** "HR, shared" typed by hand: the space IDs (upper case, each once), or what is wrong with them. */
export function spaceIdsOf(text: string): { spaces: string[]; problem?: string } {
  const ids = parseSpaceIds(text);
  if (!ids) return { spaces: [], problem: "Space IDs contain only letters, digits and underscores; separate them with commas." };
  const spaces = [...new Set(ids.map((id) => id.toUpperCase()))];
  if (spaces.length > MAX_SPACES) return { spaces, problem: `At most ${MAX_SPACES} spaces at a time.` };
  return { spaces };
}
