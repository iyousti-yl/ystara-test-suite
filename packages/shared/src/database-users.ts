import { FLOW_TYPES, refKey, type DspObjectRef } from "./objects.js";

/**
 * Database users of a space, which snapshots read its data with (Space
 * Management > the space > Database Access > Database Users). Datasphere names
 * them SPACE#SUFFIX, and each one reads only its own space's schema, on the
 * tenant's database host. With read access only, a user sees just the views
 * exposed for consumption: that decides which steps of a pipeline a snapshot
 * can measure.
 *
 * Plain functions without Node, so the web app can check a name as it is
 * typed; the API checks it when it is entered and the worker before it signs in.
 */

/**
 * SAP HANA Cloud, where a Datasphere tenant's database runs: `hana` in the host, or `hna1`, `hna2`… on newer
 * tenants. The worker sends this host the user's password, so nothing else is accepted.
 */
const DATABASE_HOST = /^[a-z0-9-]+\.(?:hana|hna[0-9]+)\.[a-z0-9-]+\.hanacloud\.ondemand\.com$/;

export const DATABASE_HOST_HINT =
  "Use the host name shown in the database user's details: <id>.hana.<region>.hanacloud.ondemand.com, or with hna1, hna2… in place of hana";

/** <id>.hana.<region>.hanacloud.ondemand.com (or hnaN), as the database user's details show it: no https://, port or path. */
export function isDatabaseHost(value: string): boolean {
  return DATABASE_HOST.test(value);
}

/**
 * Why `user` can't be a database user of a space, if it can't. A name without
 * # is most often one that something cut short (an unquoted # starts a comment
 * in .env files), and signing in with it only fails; repeated failed sign-ins
 * can lock the user. So it is refused before anyone signs in.
 */
export function databaseUserProblem(user: string): string | undefined {
  return /^[^#\s]+#[^#\s]+$/.test(user) ? undefined : "database user names look like SPACE#SUFFIX";
}

/** The space a database user belongs to: the part of its name before #. */
export const databaseUserSpace = (user: string) => user.split("#")[0];

/**
 * Whether a snapshot can measure a pipeline step with SQL, and if not, why:
 * - process: a flow or task chain holds no data of its own (the table it loads is a step too);
 * - no-database-user: the step's space has no database user;
 * - not-checked: its database user hasn't been checked yet;
 * - check-failed: its last check failed (wrong password, a user that could write, ...);
 * - not-visible: the database user doesn't see it, because it isn't exposed for consumption.
 */
export type Measurability =
  | { measurable: true }
  | { measurable: false; reason: "process" | "no-database-user" | "not-checked" | "check-failed" | "not-visible" };

/** What `measurability` needs to know about a space's database user. */
export interface DatabaseUserReach {
  space: string;
  status: "checking" | "connected" | "failed";
  /** The objects it saw in its space's schema at its last check. Null until checked. */
  visible: { name: string }[] | null;
}

/** From what each space's database user saw at its last check, never from an assumption about what is readable. */
export function measurability(step: DspObjectRef, users: DatabaseUserReach[]): Measurability {
  if (FLOW_TYPES.has(step.type) || step.type === "task_chain") return { measurable: false, reason: "process" };
  const user = users.find((u) => u.space === step.space);
  if (!user) return { measurable: false, reason: "no-database-user" };
  if (user.status === "failed") return { measurable: false, reason: "check-failed" };
  if (!user.visible) return { measurable: false, reason: "not-checked" };
  return user.visible.some((o) => o.name === step.technicalName) ? { measurable: true } : { measurable: false, reason: "not-visible" };
}

/**
 * Why no snapshot of a pipeline can be taken when none of its steps is
 * measurable, as one sentence that says what would change it. The API refuses
 * with it and the pipeline page shows it. `tenantHasUrl` is false for a tenant
 * that only has imported scans: it can't have a database user at all.
 */
export function whyNothingMeasurable(steps: DspObjectRef[], measurement: Record<string, Measurability>, tenantHasUrl: boolean): string {
  if (!tenantHasUrl) {
    return "This tenant only has imported scans, so it has no Datasphere URL and no database user to measure with. Add the tenant with its Datasphere URL to take snapshots.";
  }
  const spacesWith = (reason: Exclude<Measurability, { measurable: true }>["reason"]) => {
    const spaces = steps.filter((s) => {
      const m = measurement[refKey(s)];
      return m && !m.measurable && m.reason === reason;
    });
    const names = [...new Set(spaces.map((s) => s.space))];
    return names.length === 0 ? undefined : names.length === 1 ? `space ${names[0]}` : `spaces ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  };
  const missing = spacesWith("no-database-user");
  if (missing) return `There is no database user for ${missing} yet. An admin adds one under Connection › Database users.`;
  const failed = spacesWith("check-failed");
  if (failed) return `The database user of ${failed} failed its last check. Connection › Database users says why.`;
  const checking = spacesWith("not-checked");
  if (checking) return `The database user of ${checking} hasn't been checked yet. Try again once Connection › Database users shows it as connected.`;
  if (spacesWith("not-visible")) {
    return "The database users don't see any step of this pipeline, because none is exposed for consumption. A modeler can expose a view; select a step to see why it can't be measured.";
  }
  return "None of this pipeline's steps can be measured with SQL. Select a step to see why.";
}
