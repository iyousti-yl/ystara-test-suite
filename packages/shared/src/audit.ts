/**
 * The audit log (migration 014): every request that changes something, and
 * every sign-in, as one event (apps/api/src/audit.ts writes them). This file
 * says, per route, how its event reads on the Audit page.
 *
 * Every route that isn't a GET must be listed here: the API refuses to start
 * when one is missing, so a new route can't be forgotten. null means the route
 * changes nothing worth logging (signing out, a dry compile).
 */

/** What an event acted on, read from the route's parameter before the request ran. */
export type AuditTargetKind = "tenant" | "pipeline" | "scenario" | "member" | "invitation" | "account" | "user";

export const AUDIT_GROUPS = ["Sign-in", "Users", "Tenants", "Discovery", "Pipelines", "Scenarios", "Snapshots", "Alerts", "Operator"] as const;
export type AuditGroup = (typeof AUDIT_GROUPS)[number];

export interface AuditAction {
  /** Past tense, sentence case, without the target: "Deleted the pipeline". */
  label: string;
  group: AuditGroup;
  /** The route parameter that names the target, and what it is. */
  target?: { kind: AuditTargetKind; param: string };
  /**
   * The request body's fields kept with the event. Only names, roles, spaces,
   * schedules and the like: never a password, client secret, webhook address,
   * API key, or a scenario's test rows. The route's other parameters (a
   * space) are kept too, except a link's token.
   */
  fields?: string[];
}

const tenant = { kind: "tenant", param: "id" } as const;
const pipeline = { kind: "pipeline", param: "id" } as const;
const scenario = { kind: "scenario", param: "id" } as const;

/** Keyed by method and route as registered under /api, e.g. "DELETE /pipelines/:id". */
export const AUDIT_ACTIONS: Record<string, AuditAction | null> = {
  // Signing in. A failed attempt of a known user is an event in each of their accounts (not a route: routes/auth.ts
  // writes it), so admins see someone guessing; an unknown email belongs to no account.
  "POST /auth/login": null, // the password step: the sign-in is logged once the code is checked
  "sign-in: wrong password": { label: "Typed a wrong password", group: "Sign-in" },
  "sign-in: wrong code": { label: "Typed a wrong authenticator code", group: "Sign-in" },
  "sign-in: codes locked": { label: "Was locked out after too many wrong codes", group: "Sign-in" },
  "POST /auth/code": { label: "Signed in", group: "Sign-in" },
  "POST /auth/logout": null,
  "POST /auth/account": { label: "Switched to this account", group: "Sign-in" },
  "POST /invitations/:token/authenticator": null, // shows a new user their authenticator secret; accepting is logged
  "POST /invitations/:token/accept": { label: "Joined the account with an invitation", group: "Users" },
  "POST /resets/:token/authenticator": null,
  "POST /resets/:token/accept": { label: "Chose a new password and authenticator with a reset link", group: "Sign-in" },
  "POST /auth/password": { label: "Changed their password", group: "Sign-in" },
  "POST /auth/sessions/end-others": { label: "Signed out their other browsers", group: "Sign-in" },

  // Users and the account
  "PATCH /team/account": { label: "Renamed the account", group: "Users", fields: ["name"] },
  "POST /team/invitations": { label: "Invited a user", group: "Users", fields: ["email", "role", "spaces"] },
  "DELETE /team/invitations/:id": { label: "Withdrew the invitation", group: "Users", target: { kind: "invitation", param: "id" } },
  "PATCH /team/members/:userId": { label: "Changed the member's role or spaces", group: "Users", target: { kind: "member", param: "userId" }, fields: ["role", "spaces"] },
  "DELETE /team/members/:userId": { label: "Removed the member", group: "Users", target: { kind: "member", param: "userId" } },

  // Tenants and their connection
  "POST /tenants": { label: "Added a tenant", group: "Tenants", fields: ["name", "host"] },
  "DELETE /tenants/:id": { label: "Deleted the tenant", group: "Tenants", target: tenant },
  "PUT /tenants/:id/connection": { label: "Set the technical client", group: "Tenants", target: tenant, fields: ["clientId", "tokenUrl", "spaces"] },
  "PUT /tenants/:id/connection/spaces": { label: "Changed the spaces to scan", group: "Tenants", target: tenant, fields: ["spaces"] },
  "POST /tenants/:id/connection/check": { label: "Checked the technical client", group: "Tenants", target: tenant },
  "DELETE /tenants/:id/connection": { label: "Removed the technical client", group: "Tenants", target: tenant },
  "PUT /tenants/:id/database-users": { label: "Set a database user", group: "Tenants", target: tenant, fields: ["user", "host"] },
  "POST /tenants/:id/database-users/:space/check": { label: "Checked a database user", group: "Tenants", target: tenant },
  "DELETE /tenants/:id/database-users/:space": { label: "Removed a database user", group: "Tenants", target: tenant },

  // Discovery
  "POST /tenants/:id/scans": { label: "Started a scan", group: "Discovery", target: tenant, fields: ["spaces"] },
  "PUT /tenants/:id/scan-schedule": { label: "Set the scan schedule", group: "Discovery", target: tenant, fields: ["cron", "timeZone"] },
  "DELETE /tenants/:id/scan-schedule": { label: "Removed the scan schedule", group: "Discovery", target: tenant },

  // Pipelines
  "POST /tenants/:id/pipelines": { label: "Saved a pipeline", group: "Pipelines", target: tenant, fields: ["name", "output", "excludeWriters"] },
  "DELETE /pipelines/:id": { label: "Deleted the pipeline", group: "Pipelines", target: pipeline },
  "PUT /pipelines/:id/ignored-loaders": { label: "Changed the ignored loaders", group: "Pipelines", target: pipeline, fields: ["excludeWriters"] },
  "PUT /pipelines/:id/watch": { label: "Started watching the pipeline", group: "Pipelines", target: pipeline },
  "DELETE /pipelines/:id/watch": { label: "Stopped watching the pipeline", group: "Pipelines", target: pipeline },
  "POST /pipelines/:id/signoffs": { label: "Signed off the pipeline", group: "Pipelines", target: pipeline, fields: ["verdict", "comment"] },

  // Scenarios
  "POST /pipelines/:id/scenario-draft": { label: "Drafted a scenario with Claude", group: "Scenarios", target: pipeline },
  "POST /pipelines/:id/scenario-check": null, // compiles a scenario without saving or running it
  "POST /pipelines/:id/scenarios": { label: "Created a scenario", group: "Scenarios", target: pipeline, fields: ["name", "kind"] },
  "PUT /scenarios/:id": { label: "Saved the scenario", group: "Scenarios", target: scenario, fields: ["name", "kind"] },
  "DELETE /scenarios/:id": { label: "Deleted the scenario", group: "Scenarios", target: scenario },
  "POST /scenarios/:id/runs": { label: "Ran the scenario", group: "Scenarios", target: scenario },
  "POST /pipelines/:id/scenario-suites": { label: "Ran all the pipeline's scenarios", group: "Scenarios", target: pipeline },

  // Snapshots
  "POST /pipelines/:id/snapshots": { label: "Took a snapshot", group: "Snapshots", target: pipeline },
  "PUT /pipelines/:id/schedule": { label: "Set the snapshot schedule", group: "Snapshots", target: pipeline, fields: ["cron", "timeZone", "rowDropPercent"] },
  "DELETE /pipelines/:id/schedule": { label: "Removed the snapshot schedule", group: "Snapshots", target: pipeline },

  // Alerts
  "PUT /account/teams-channel": { label: "Connected a Teams channel", group: "Alerts" },
  "POST /account/teams-channel/test": { label: "Sent a test card to the Teams channel", group: "Alerts" },
  "DELETE /account/teams-channel": { label: "Removed the Teams channel", group: "Alerts" },
  "PUT /account/settings": { label: "Changed the account's settings", group: "Users", fields: ["draftingWithClaude"] },

  // The operator panel: kept apart from every account's log (account_id null).
  "POST /operator/accounts": { label: "Created an account", group: "Operator", fields: ["name", "adminEmail"] },
  "PATCH /operator/accounts/:id": { label: "Renamed an account", group: "Operator", target: { kind: "account", param: "id" }, fields: ["name"] },
  "POST /operator/accounts/:id/invitations": { label: "Invited an account's admin", group: "Operator", target: { kind: "account", param: "id" }, fields: ["email"] },
  "PUT /operator/claude": { label: "Set the Anthropic API key", group: "Operator" },
  "DELETE /operator/claude": { label: "Removed the Anthropic API key", group: "Operator" },
  "POST /operator/users/:id/reset": { label: "Made a sign-in reset link", group: "Operator", target: { kind: "user", param: "id" } },
};

/** "METHOD /route" as AUDIT_ACTIONS keys it, from a method and a route registered under /api. */
export const auditKey = (method: string, route: string): string => `${method.toUpperCase()} ${route.replace(/^\/api(?=\/)/, "")}`;

/** GET /api/audit: one event, newest first. */
export interface AuditEvent {
  id: string;
  at: Date;
  /** Who did it, by email as it was then; null when the user's row is gone and no email was kept. */
  userEmail: string | null;
  action: string;
  /** From AUDIT_ACTIONS; the action's key when it is no longer listed. */
  label: string;
  group: AuditGroup | null;
  target: AuditTarget | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
}

export interface AuditTarget {
  kind: AuditTargetKind;
  id: string;
  /** Its name (or email) when the request ran; null when it didn't exist. */
  name: string | null;
  /** The tenant a pipeline or scenario belongs to, for a link. */
  tenantId?: string;
  /** The pipeline a scenario belongs to, for a link. */
  pipelineId?: string;
}

/** GET /api/audit: a page of events, and the id to ask for the next older page with (?before=). */
export interface AuditPage {
  events: AuditEvent[];
  next: string | null;
}
