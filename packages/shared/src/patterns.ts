import { refKey } from "./objects.js";

/**
 * Writer exclusion patterns (`--exclude-writer`, saved pipelines, the web app):
 * a technical name or SPACE.NAME, with `*` and `?` wildcards, ignoring case.
 */
export function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

export function matchesPattern(pattern: string, ref: { space: string; technicalName: string }): boolean {
  const re = globToRegExp(pattern);
  return re.test(ref.technicalName) || re.test(refKey(ref));
}
