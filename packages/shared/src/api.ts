import type { Measurability } from "./database-users.js";
import type { DspEdge, DspObject, DspObjectRef, Pipeline } from "./objects.js";
import type { Permission, Role } from "./roles.js";

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
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  /** How many steps were measured, couldn't be measured, and failed. */
  counts: { measured: number; notMeasurable: number; failed: number };
}

/** GET /api/snapshots/:id */
export interface SnapshotDetails extends Snapshot {
  objects: SnapshotObject[];
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
