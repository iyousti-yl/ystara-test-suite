import type { SnapshotAlert } from "./alerts.js";
import type { Measurability } from "./database-users.js";
import type { DspEdge, DspObject, DspObjectRef, Pipeline } from "./objects.js";
import type { Permission, Role } from "./roles.js";
import type { ScenarioSpec } from "./scenario.js";

/**
 * What the API stores and sends, shared by the API (which sends it) and the web
 * app (which reads it). The records live here rather than in @ystara/db so the
 * browser code never depends on the database package.
 *
 * Over HTTP, dates arrive as ISO strings: the web app reads `Json<Scan>`, not `Scan`.
 */

export interface Tenant {
  id: string;
  accountId: string;
  name: string;
  /** Datasphere URL. Null for a tenant that only has imported scans. */
  host: string | null;
  createdAt: Date;
}

/**
 * How the worker logs in to a tenant: a technical OAuth client (purpose
 * "Technical User") an admin creates in Datasphere and enters in the Connect
 * wizard. Ystara stores its secret encrypted and never sends it back.
 *
 * Lifecycle: checking (saved, spaces changed, or "Check again") -> connected |
 * failed. The admin names the spaces to scan, and the worker checks each one by
 * listing a few of its objects: connected when at least one can be read.
 * (Not with `spaces list`: it needs a tenant-wide privilege that a technical
 * client limited to its spaces doesn't have.)
 */
export type ConnectionStatus = "checking" | "connected" | "failed";

/** One space the admin named, and what the last check found. */
export interface ConnectionSpace {
  space: string;
  /** Whether the client could list the space's objects. Null until checked. */
  readable: boolean | null;
  /** Why it couldn't: the CLI's last lines, without the secret. */
  error: string | null;
}

export interface TenantConnection {
  tenantId: string;
  clientId: string;
  tokenUrl: string;
  status: ConnectionStatus;
  checkedAt: Date | null;
  /** Why the last check couldn't log in at all: the CLI's last lines, without the secret. */
  error: string | null;
  /** The spaces to scan, in the order the admin gave them, each with its last check. Scans may use only the readable ones. */
  spaces: ConnectionSpace[];
  /** When the client or its spaces were entered or last changed. */
  updatedAt: Date;
}

/** The spaces a scan of a connected tenant may read: those its last check could read. */
export const readableSpaces = (connection: { spaces: ConnectionSpace[] }) => connection.spaces.filter((s) => s.readable).map((s) => s.space);

/** GET /api/tenants/:id/connection. Null until an admin connects the tenant. */
export interface ConnectionState {
  connection: TenantConnection | null;
}

/**
 * A database user of one space, which snapshots read its data with (SQL,
 * read access only). Ystara stores its password encrypted and never sends it
 * back. Lifecycle as for the technical client: checking (saved, or "Check
 * again") -> connected | failed. The check signs in, makes sure the user can't
 * change the space's schema, and lists what it sees there.
 */
export interface SpaceDatabaseUser {
  tenantId: string;
  /** The part of the user name before #. */
  space: string;
  /** The tenant's database host, <id>.hana.<region>.hanacloud.ondemand.com (or hnaN in place of hana). */
  host: string;
  /** SPACE#SUFFIX */
  user: string;
  status: ConnectionStatus;
  checkedAt: Date | null;
  /** Why the last check failed, without the password. */
  error: string | null;
  /**
   * The views and tables it saw in the space's schema at its last check: the
   * objects a snapshot can measure. Null until a check got that far. Kept
   * while it is checked again, and cleared when the user or password changes.
   */
  visible: { name: string; type: "VIEW" | "TABLE" }[] | null;
  /** When it was entered or last changed. */
  updatedAt: Date;
}

/**
 * Discovery scans: a request to read some spaces of a tenant, and, once done,
 * what was read (object definitions) and the lineage graph built from it.
 *
 * Lifecycle: queued (API) -> running (worker) -> succeeded | failed.
 * Imported scans (a saved `npm run scan` folder) go straight to succeeded.
 */
export type ScanStatus = "queued" | "running" | "succeeded" | "failed";
export type ScanSource = "tenant" | "import";

export interface Scan {
  id: string;
  tenantId: string;
  spaces: string[];
  source: ScanSource;
  status: ScanStatus;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  objectCount: number | null;
  edgeCount: number | null;
  warnings: string[];
  error: string | null;
}

/**
 * A saved pipeline: an output object plus the writers that belong to other
 * processes. The steps are not stored; they are computed from the tenant's
 * latest successful scan.
 */
export interface PipelineDefinition {
  id: string;
  tenantId: string;
  name: string;
  output: { space: string; technicalName: string };
  /** Patterns as for `npm run scan -- --exclude-writer`: NAME or SPACE.NAME, `*` and `?` wildcards. */
  excludeWriters: string[];
  createdAt: Date;
}

/** An object as the lineage pictures need it: no definition. */
export interface GraphNode extends DspObjectRef {
  businessName?: string;
}

/** GET /api/scans/:id/graph: every object and edge of a scan, without definitions. */
export interface ScanGraph {
  scannedAt: string;
  spaces: string[];
  nodes: Omit<DspObject, "definition">[];
  edges: DspEdge[];
  warnings: string[];
}

/** GET /api/scans/:id/pipeline: the pipeline behind one output on one scan. */
export interface PipelineResult {
  scanId: string;
  excludeWriters: string[];
  pipeline: Pipeline;
  /** What to draw: every step and excluded writer, and the data edges between them. */
  graph: { nodes: GraphNode[]; edges: DspEdge[] };
  mermaid: string;
  /** For each step (by SPACE.NAME), whether a snapshot can measure it with SQL, from what the database users saw at their last check. */
  measurement: Record<string, Measurability>;
}

/** GET /api/pipelines/:id: a saved pipeline, computed on the tenant's latest successful scan. */
export interface SavedPipelineResult extends PipelineResult {
  definition: PipelineDefinition;
}

/** GET /api/scans/:id/objects/:space/:name: one object with its definition and every edge that touches it. */
export interface ObjectDetails {
  object: DspObject;
  edges: DspEdge[];
}

/**
 * Snapshots: the measures of a pipeline's steps at one moment, taken with SQL
 * through each space's database user (phase 2). Never rows: per object its row
 * count, and per column counts, and min, max and a sum as below.
 *
 * GDPR (Issam's choice, 2026-10-17): min and max are stored only as a salted
 * hash made inside the tenant's database, never as the value: they are often
 * one person's name, IBAN, salary or birth date. A sum stays plain, except on
 * an object with fewer than 10 rows, where it could be one person's value and
 * is hashed too. Equal hashes mean equal values, which is all a comparison
 * needs. The salt is per tenant and sealed with MASTER_KEY.
 *
 * Lifecycle: queued (API) -> running (worker) -> succeeded | failed. Failed
 * when a measurable step couldn't be measured; what was measured is kept.
 */
export type SnapshotStatus = "queued" | "running" | "succeeded" | "failed";

/** One column's measures. A measure its type doesn't have is left out; a hash or sum is null when there is nothing to measure (no non-null value). */
export interface ColumnMeasures {
  name: string;
  /** HANA's DATA_TYPE_NAME, e.g. NVARCHAR, DECIMAL, DATE. */
  dataType: string;
  nonNull: number;
  distinct?: number;
  /** SHA-256 (hex) of the salt and the smallest value as text. */
  minHash?: string | null;
  maxHash?: string | null;
  /** The sum of a number column, as text, on an object with at least 10 rows. */
  sum?: string | null;
  /** On an object with fewer rows: the sum's hash instead. */
  sumHash?: string | null;
  /**
   * The scale the sum was taken at: the column's own for integers and DECIMAL(p,s), 6 for floating types, which are
   * summed as DECIMAL(38, 6) so the order HANA adds rows in can't change the last digits. Missing on snapshots from
   * before it was stored; a comparison then assumes 0 for integers and 6 otherwise.
   */
  sumScale?: number;
}

/** One pipeline step in a snapshot. */
export interface SnapshotObject extends DspObjectRef {
  /** The definition's hash in the scan the snapshot used, so a comparison can tell a changed definition from changed data. */
  definitionHash: string | null;
  /** measured; not measurable (`reason` is the Measurability reason); failed (`reason` is the error). */
  status: "measured" | "not_measurable" | "failed";
  reason: string | null;
  rows: number | null;
  columns: ColumnMeasures[] | null;
  /** How long its measuring took. */
  tookMs: number | null;
}

export interface Snapshot {
  id: string;
  tenantId: string;
  pipelineId: string;
  pipelineName: string;
  /** The scan whose steps were measured: the tenant's latest successful one when the snapshot ran. */
  scanId: string | null;
  status: SnapshotStatus;
  /** Taken by the pipeline's schedule rather than by a person. */
  scheduled: boolean;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  /** How many steps were measured, couldn't be measured, and failed. */
  counts: { measured: number; notMeasurable: number; failed: number };
  /** The alert this scheduled snapshot raised, if it called for one (alerts.ts). */
  alert: SnapshotAlert | null;
}

/** GET, PUT and DELETE /api/pipelines/:id/watch: whether the signed-in user watches the pipeline, and how many people do. */
export interface WatchState {
  watching: boolean;
  watchers: number;
}

/** GET /api/snapshots/:id */
export interface SnapshotDetails extends Snapshot {
  objects: SnapshotObject[];
}

/**
 * Scenarios (phase 3b): a saved pipeline's test cases, made in the app's
 * builder and stored as the ScenarioSpec of scenario.ts. A run compiles the
 * pipeline from the tenant's latest successful scan over the scenario's rows
 * and sends each check as one SELECT that reads only those rows, through a
 * database user of the tenant (packages/connector/src/simulate). Rows are the
 * scenario's own, typed in by a person, never read from the tenant; a run
 * stores what each check gave back, which comes from those rows only.
 *
 * Run lifecycle: queued (API) -> running (worker) -> passed (every check
 * passed) | failed (a check failed or couldn't run) | error (the run couldn't
 * start: no scan, the pipeline isn't in it, the scenario has problems, no
 * database user, a failed sign-in).
 */
export type ScenarioRunStatus = "queued" | "running" | "passed" | "failed" | "error";
export type ScenarioCheckStatus = "pass" | "fail" | "error" | "not_run";

/** A run in a list: its status and how many checks passed. */
export interface ScenarioRunSummary {
  id: string;
  status: ScenarioRunStatus;
  requestedAt: Date;
  finishedAt: Date | null;
  /** Set once the run has judged its checks. */
  passed: number | null;
  total: number | null;
}

export interface StoredScenario {
  id: string;
  tenantId: string;
  pipelineId: string;
  /** The same as spec.name, unique per pipeline. */
  name: string;
  spec: ScenarioSpec;
  createdAt: Date;
  updatedAt: Date;
  /** Who last saved it, by email, when they are still a user. */
  updatedBy: string | null;
  lastRun: ScenarioRunSummary | null;
}

/** What stood in for one step in a run or a check: as SimulatedStep in the connector says it. */
export interface ScenarioStepNote extends DspObjectRef {
  note: string;
  problem?: string;
}

/** One check's result: `label` as the run prints it (e.g. "row_count = 2"), `detail` what came back. */
export interface ScenarioCheckResult {
  checkpoint: string;
  label: string;
  status: ScenarioCheckStatus;
  detail: string;
}

/** GET /api/scenario-runs/:id */
export interface ScenarioRun extends ScenarioRunSummary {
  scenarioId: string;
  scenarioName: string;
  tenantId: string;
  pipelineId: string;
  pipelineName: string;
  /** The scan whose definitions were compiled. */
  scanId: string | null;
  /** The scenario as it was when the run was asked for. */
  spec: ScenarioSpec;
  startedAt: Date | null;
  error: string | null;
  steps: ScenarioStepNote[] | null;
  checks: ScenarioCheckResult[] | null;
  requestedBy: string | null;
}

/**
 * A column as a scenario fills or checks it: its technical name and SAP HANA
 * type, and on a table that takes rows what the pipeline's logic does with it
 * (columnUsage in the connector), so the builder shows the columns that matter
 * and fills new rows with values that get through.
 */
export interface ScenarioColumn {
  name: string;
  type: string;
  /** Part of the table's key. */
  key?: boolean;
  /** Read by a filter, join, grouping or calculation of the pipeline, not only passed on. */
  used?: boolean;
  /** Compared with another table's column in a join. */
  joined?: boolean;
  /** A value the pipeline's filters keep (NULL for IS NULL). */
  keeps?: string | number | boolean | null;
  /** Compared with today's date: the start or the end of a validity range. */
  range?: "start" | "end";
}

/**
 * GET /api/pipelines/:id/scenario-inputs: what the builder offers for a
 * pipeline on the tenant's latest successful scan. `tables` take rows (every
 * table no compiled transformation flow loads), with why; `checkpoints` are
 * the views and tables a check can be on, with their columns when the
 * definition lists them.
 */
export interface ScenarioInputs {
  scanId: string;
  /** Whether this server can draft a scenario from its description with Claude (POST /api/pipelines/:id/scenario-draft): it has an Anthropic API key. */
  drafting: boolean;
  tables: (DspObjectRef & { why: string; columns: ScenarioColumn[] })[];
  checkpoints: (DspObjectRef & { columns: ScenarioColumn[] | null })[];
  steps: ScenarioStepNote[];
}

/**
 * POST /api/pipelines/:id/scenario-draft: rows and checks Claude drafted from
 * the scenario's description and the pipeline's definitions (names, columns
 * and logic; never data, which Ystara doesn't read), compiled on the latest
 * scan. Nothing is saved: the builder shows the draft for a person to check.
 */
export interface ScenarioDrafted {
  scenario: Omit<ScenarioSpec, "pipeline" | "version" | "tags">;
  /** What the rows cover and what Claude assumed, then why each expected value is right. */
  notes: string[];
  /** What still stops the draft from compiling after Claude's corrections; empty when it compiles. */
  problems: string[];
}

/**
 * GET /api/operator/claude: whether drafting scenarios with Claude is on, and
 * where its Anthropic API key comes from. Never the key itself.
 */
export interface ClaudeSetting {
  /** "environment": the server's ANTHROPIC_API_KEY, which wins; "operator": the key entered on the operator panel; null: drafting is off. */
  source: "environment" | "operator" | null;
  /** When the operator's key was entered, and by whom; null without one. */
  operatorKey: { updatedAt: Date; updatedBy: string | null } | null;
}

/** POST /api/pipelines/:id/scenario-check: a scenario compiled on the latest scan, nothing sent. */
export interface ScenarioCompile {
  /** Problems that stop the whole scenario (a fixture that can't be placed). */
  problems: string[];
  /** Each check in order, with why it can't run when it can't. */
  checks: { checkpoint: string; label: string; problem: string | null }[];
  steps: ScenarioStepNote[];
}

/**
 * Sign-in. A customer account has users, each with one role in it (a user can
 * belong to several accounts). Everyone signs in with email, password and a
 * code from an authenticator app.
 */
export interface Account {
  id: string;
  name: string;
}

/** The shortest password allowed (apps/api/src/auth/passwords.ts checks it; the pages say it). */
export const MIN_PASSWORD_LENGTH = 12;

/** GET /api/auth/me: who is signed in, in which account, and what their role allows there. */
export interface Me {
  user: { id: string; email: string };
  account: Account;
  role: Role;
  permissions: Permission[];
  /** Every account the user belongs to. */
  accounts: (Account & { role: Role })[];
  /** Ystara's operator: sees the operator panel. */
  operator: boolean;
}

/** A user's membership of the signed-in account (GET /api/members). */
export interface Member {
  userId: string;
  email: string;
  role: Role;
  joinedAt: Date;
  /**
   * The sign-in reset links Ystara's operator made for them in the last 30 days, newest first: when each was made,
   * when it was used, and whether it still works (an unused link that isn't open expired or was replaced).
   */
  signInResets: { madeAt: Date; usedAt?: Date; open: boolean }[];
}

/** An open invitation to join the account. The link itself is shown only once, when it is created. */
export interface Invitation {
  id: string;
  email: string;
  role: Role;
  createdAt: Date;
  expiresAt: Date;
}

/** GET /api/team: the account's members and open invitations (admins only). */
export interface Team {
  members: Member[];
  invitations: Invitation[];
}

/** POST /api/team/invitations: the new invitation and its token, for the link /invite/<token>. Shown once. */
export interface CreatedInvitation {
  invitation: Invitation;
  token: string;
}

/**
 * POST /api/invitations/:token/authenticator: a secret the server made and keeps (sealed) on the
 * invitation. Shown once, for the QR code and for typing in by hand; never sent back.
 */
export interface AuthenticatorSetup {
  secret: string;
  /** What the QR code holds. */
  otpauthUri: string;
}

/** GET /api/operator/accounts: every customer account, with counts only (the operator sees no lineage data). */
export interface AccountOverview extends Account {
  createdAt: Date;
  members: number;
  admins: number;
  tenants: number;
  openInvitations: number;
}

/** GET /api/operator/users: every user, with the accounts they belong to. */
export interface UserOverview {
  id: string;
  email: string;
  operator: boolean;
  createdAt: Date;
  accounts: (Account & { role: Role })[];
}

/** POST /api/operator/users/:id/reset: a one-time link (/reset/<token>) to choose a new password and authenticator. Shown once. */
export interface CreatedReset {
  token: string;
  expiresAt: Date;
}

/** GET /api/resets/:token: whose sign-in the link resets. */
export interface ResetOffer {
  email: string;
}

/** GET /api/invitations/:token: what the link offers, before it is accepted. */
export interface InvitationOffer {
  account: string;
  email: string;
  role: Role;
  /** The email already has a Ystara user (from another account): sign in and accept. */
  existingUser: boolean;
}

/** A value as it arrives over HTTP (JSON): dates become ISO strings. */
export type Json<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;
