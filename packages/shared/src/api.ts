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
  /** The latest sign-in reset link Ystara's operator made for them, when it was used or is still open. */
  signInReset?: { madeAt: Date; usedAt?: Date };
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
