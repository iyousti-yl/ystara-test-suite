/**
 * Role model. Roles are per account membership and can be narrowed to a set of
 * spaces. Permissions are checked server-side only; the UI uses them to hide
 * actions, never to enforce anything.
 */
export const ROLES = ["admin", "developer", "test_coordinator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "account.manage",
  "tenant.connect",
  "users.manage",
  "discovery.run",
  "pipelines.read",
  "pipelines.write",
  "scenarios.read",
  "scenarios.write_code",
  "scenarios.write_visual",
  "runs.execute",
  "runs.read",
  "results.sign_off",
  "audit.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ALL,
  developer: [
    "discovery.run",
    "pipelines.read",
    "pipelines.write",
    "scenarios.read",
    "scenarios.write_code",
    "scenarios.write_visual",
    "runs.execute",
    "runs.read",
  ],
  test_coordinator: [
    "pipelines.read",
    "scenarios.read",
    "scenarios.write_visual",
    "runs.execute",
    "runs.read",
    "results.sign_off",
  ],
  viewer: ["pipelines.read", "scenarios.read", "runs.read"],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * The spaces a member sees: null for every space, or only these, in every
 * tenant of the account (migration 014). Admins always see every space. A
 * pipeline belongs to its output's space: a member who sees that space sees
 * the whole pipeline, upstream steps in other spaces included, since a test
 * needs all of them.
 */
export type SpaceScope = string[] | null;

export const seesSpace = (scope: SpaceScope, space: string): boolean => scope === null || scope.includes(space);

/** What a membership's spaces mean for its role: an admin's are ignored, an empty list is none. */
export const spaceScopeOf = (role: Role, spaces: string[] | null): SpaceScope => (role === "admin" ? null : spaces);
