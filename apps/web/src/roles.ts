import type { Role } from "@ystara/shared";

/** Role names and what each one is for, in the words the pages use. The rules themselves are in packages/shared/src/roles.ts. */
export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  developer: "Developer",
  test_coordinator: "Test coordinator",
  viewer: "Viewer",
};

export const ROLE_SUMMARY: Record<Role, string> = {
  admin: "Everything, including users and roles and connecting tenants.",
  developer: "Scans spaces, saves pipelines, writes scenarios in code or visually, and runs tests.",
  test_coordinator: "Builds scenarios visually, runs tests and signs off results.",
  viewer: "Looks at pipelines, scenarios and results without changing them.",
};
