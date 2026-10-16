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
