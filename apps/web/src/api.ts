import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Account,
  AccountOverview,
  AuthenticatorSetup,
  ClaudeSetting,
  ConnectionState,
  CreatedInvitation,
  CreatedReset,
  InvitationOffer,
  Json,
  Me,
  ObjectDetails,
  Permission,
  PipelineDefinition,
  PipelineResult,
  PipelineSchedule,
  ResetOffer,
  Role,
  SavedPipelineResult,
  Scan,
  ScenarioCompile,
  ScenarioDrafted,
  ScenarioInputs,
  ScenarioRun,
  ScenarioRunSummary,
  ScenarioSpec,
  ScenarioSuite,
  ScenarioSuiteSummary,
  Snapshot,
  SnapshotComparison,
  SnapshotDetails,
  ScanGraph,
  SpaceDatabaseUser,
  StoredScenario,
  Team,
  Tenant,
  TeamsChannel,
  TenantConnection,
  TenantScanSchedule,
  UserOverview,
  WatchState,
} from "@ystara/shared";

/**
 * The web app's only way to the API. Every call goes to /api on the same
 * origin: the API serves this app (Docker, `npm run dev:api`), and in
 * development Vite forwards /api to it.
 *
 * Each read is a hook on TanStack Query, which caches answers per key, shares
 * them between components and refetches when told to (e.g. while a scan runs).
 * Response types come from packages/shared/src/api.ts, with dates as strings.
 *
 * The session cookie travels with every call on its own (HttpOnly: this code
 * never sees it). An answer 401 means "not signed in": main.tsx then asks
 * for /auth/me again, and App.tsx sends the browser to the sign-in page.
 */
export type TenantJson = Json<Tenant>;
export type ScanJson = Json<Scan>;
export type PipelineDefinitionJson = Json<PipelineDefinition>;
export type TeamJson = Json<Team>;
export type ConnectionJson = Json<TenantConnection>;
export type DatabaseUserJson = Json<SpaceDatabaseUser>;
export type SnapshotJson = Json<Snapshot>;
export type SnapshotDetailsJson = Json<SnapshotDetails>;
export type SnapshotComparisonJson = Json<SnapshotComparison>;
export type ScheduleJson = Json<PipelineSchedule>;
export type ScenarioJson = Json<StoredScenario>;
export type ScenarioRunJson = Json<ScenarioRun>;
export type ScenarioRunSummaryJson = Json<ScenarioRunSummary>;
export type ScenarioSuiteJson = Json<ScenarioSuite>;
export type ScenarioSuiteSummaryJson = Json<ScenarioSuiteSummary>;
export type ScanScheduleJson = Json<TenantScanSchedule>;
export type TeamsChannelJson = Json<TeamsChannel>;
/** A scenario as the builder sends it: the API adds the pipeline and the version. */
export type ScenarioDraft = Omit<ScenarioSpec, "pipeline" | "version">;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The whole answer, for fields beyond `error`. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export const isUnauthorized = (e: unknown) => e instanceof ApiError && e.status === 401;

async function request<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, errorMessage(data) ?? `The API answered ${res.status} ${res.statusText}`, data);
  return data as T;
}

/** The API's `{ error, issues? }` as one readable sentence. */
export function errorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || !("error" in data) || typeof data.error !== "string") return undefined;
  const issues = "issues" in data && Array.isArray(data.issues) ? data.issues.map((i: { message?: string }) => i.message).filter(Boolean) : [];
  return issues.length ? `${data.error}: ${issues.join("; ")}` : data.error;
}

// --- Signing in

export const ME = ["me"];

/** Who is signed in, in which account, and what their role allows. An ApiError 401 when nobody is. */
export const useMe = () => useQuery({ queryKey: ME, queryFn: () => request<Me>("GET", "/auth/me"), retry: false, staleTime: Infinity });

/** Whether the signed-in role allows something. Only hides buttons: the API checks every call itself. */
export function useCan() {
  const permissions = useMe().data?.permissions;
  return (permission: Permission) => permissions?.includes(permission) ?? false;
}

/**
 * After signing in, joining or switching accounts: forget everything cached for the previous
 * one. The pages on screen fetch their data again, now for this account. The invitation or
 * reset link just used is left alone: asked again, it would answer that it is used up.
 */
function useStartWith() {
  const client = useQueryClient();
  const keep = new Set([ME[0], "invitations", "resets"]);
  return (me: Me) => {
    client.setQueryData(ME, me);
    void client.resetQueries({ predicate: (q) => !keep.has(String(q.queryKey[0])) });
  };
}

export const useLogin = () => useMutation({ mutationFn: (input: { email: string; password: string }) => request<{ next: "code" }>("POST", "/auth/login", input) });

export function useCode() {
  const startWith = useStartWith();
  return useMutation({ mutationFn: (code: string) => request<Me>("POST", "/auth/code", { code }), onSuccess: startWith });
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({ mutationFn: () => request<void>("POST", "/auth/logout"), onSettled: () => client.clear() });
}

export function useSwitchAccount() {
  const startWith = useStartWith();
  return useMutation({ mutationFn: (accountId: string) => request<Me>("POST", "/auth/account", { accountId }), onSuccess: startWith });
}

// --- Invitation links

export const useInvitation = (token: string) =>
  useQuery({ queryKey: ["invitations", token], queryFn: () => request<InvitationOffer>("GET", `/invitations/${token}`), retry: false, staleTime: Infinity });

export const useAuthenticatorSetup = (token: string) =>
  useMutation({ mutationFn: () => request<AuthenticatorSetup>("POST", `/invitations/${token}/authenticator`) });

/**
 * A new user sends a password and a code from the authenticator secret the server made for the link (never the secret
 * itself); an existing user (signed in) sends nothing.
 */
export function useAcceptInvitation(token: string) {
  const startWith = useStartWith();
  return useMutation({
    mutationFn: (input: { password: string; code: string } | Record<string, never>) => request<Me>("POST", `/invitations/${token}/accept`, input),
    onSuccess: startWith,
  });
}

// --- Reset links (made on the operator panel)

export const useReset = (token: string) =>
  useQuery({ queryKey: ["resets", token], queryFn: () => request<ResetOffer>("GET", `/resets/${token}`), retry: false, staleTime: Infinity });

export const useResetAuthenticator = (token: string) => useMutation({ mutationFn: () => request<AuthenticatorSetup>("POST", `/resets/${token}/authenticator`) });

export function useAcceptReset(token: string) {
  const startWith = useStartWith();
  return useMutation({
    mutationFn: (input: { password: string; code: string }) => request<Me>("POST", `/resets/${token}/accept`, input),
    onSuccess: startWith,
  });
}

// --- Operator panel (Ystara's operator only)

const OPERATOR = ["operator"];

export const useAccountOverviews = (allowed: boolean) =>
  useQuery({ queryKey: [...OPERATOR, "accounts"], queryFn: () => request<Json<AccountOverview>[]>("GET", "/operator/accounts"), enabled: allowed });
export const useUserOverviews = (allowed: boolean) =>
  useQuery({ queryKey: [...OPERATOR, "users"], queryFn: () => request<Json<UserOverview>[]>("GET", "/operator/users"), enabled: allowed });

function useOperatorChange<I, O>(mutationFn: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({ mutationFn, onSettled: () => client.invalidateQueries({ queryKey: OPERATOR }) });
}

export const useCreateAccount = () =>
  useOperatorChange((input: { name: string; adminEmail: string }) => request<Json<CreatedInvitation> & { account: Account }>("POST", "/operator/accounts", input));
export const useInviteAdmin = () =>
  useOperatorChange((input: { accountId: string; email: string }) =>
    request<Json<CreatedInvitation>>("POST", `/operator/accounts/${input.accountId}/invitations`, { email: input.email }),
  );
export const useCreateReset = () => useOperatorChange((userId: string) => request<Json<CreatedReset>>("POST", `/operator/users/${userId}/reset`));

/** Whether drafting scenarios with Claude is on, and where its key comes from. Never the key. */
export const useClaudeSetting = (allowed: boolean) =>
  useQuery({ queryKey: [...OPERATOR, "claude"], queryFn: () => request<Json<ClaudeSetting>>("GET", "/operator/claude"), enabled: allowed });
/** Checks the key with Anthropic, then keeps it sealed. Every builder asks again whether it can draft. */
export function useSetClaudeKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (apiKey: string | null): Promise<Json<ClaudeSetting> | undefined> =>
      apiKey === null ? request<undefined>("DELETE", "/operator/claude") : request<Json<ClaudeSetting>>("PUT", "/operator/claude", { apiKey }),
    onSettled: () =>
      Promise.all([client.invalidateQueries({ queryKey: [...OPERATOR, "claude"] }), client.invalidateQueries({ predicate: (q) => q.queryKey.includes("scenario-inputs") })]),
  });
}

/** The operator may belong to the account too, so the header's account name is asked for again. */
export function useRenameAccountAsOperator() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId: string; name: string }) => request<Account>("PATCH", `/operator/accounts/${input.accountId}`, { name: input.name }),
    onSettled: () => Promise.all([client.invalidateQueries({ queryKey: OPERATOR }), client.invalidateQueries({ queryKey: ME })]),
  });
}

// --- Users and roles (admins)

const TEAM = ["team"];

export const useTeam = (allowed: boolean) => useQuery({ queryKey: TEAM, queryFn: () => request<TeamJson>("GET", "/team"), enabled: allowed });

function useTeamChange<I, O>(mutationFn: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({ mutationFn, onSettled: () => client.invalidateQueries({ queryKey: TEAM }) });
}

export const useInvite = () => useTeamChange((input: { email: string; role: Role }) => request<Json<CreatedInvitation>>("POST", "/team/invitations", input));
export const useWithdrawInvitation = () => useTeamChange((id: string) => request<void>("DELETE", `/team/invitations/${id}`));
export const useChangeRole = () => useTeamChange((input: { userId: string; role: Role }) => request<void>("PATCH", `/team/members/${input.userId}`, { role: input.role }));
export const useRemoveMember = () => useTeamChange((userId: string) => request<void>("DELETE", `/team/members/${userId}`));

/** The signed-in account's new name, which the header and the account switcher show (/auth/me). */
export function useRenameAccount() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (name: string) => request<Account>("PATCH", "/team/account", { name }), onSuccess: () => client.invalidateQueries({ queryKey: ME }) });
}

const active = (status: Scan["status"]) => status === "queued" || status === "running";
const pollWhile = (busy: boolean) => (busy ? 3000 : false);

// --- Tenants

export const useTenants = () => useQuery({ queryKey: ["tenants"], queryFn: () => request<TenantJson[]>("GET", "/tenants") });

/** Waits while `id` is empty (e.g. until the scan that names the tenant has loaded). */
export const useTenant = (id: string) =>
  useQuery({ queryKey: ["tenants", id], queryFn: () => request<TenantJson>("GET", `/tenants/${id}`), enabled: id !== "" });

export function useCreateTenant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; host: string }) => request<TenantJson>("POST", "/tenants", input),
    onSuccess: () => client.invalidateQueries({ queryKey: ["tenants"] }),
  });
}

/** Only the list is asked for again: the deleted tenant's page is left before anything on it would be. */
export function useDeleteTenant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string) => request<void>("DELETE", `/tenants/${tenantId}`),
    onSuccess: () => client.invalidateQueries({ queryKey: ["tenants"], exact: true }),
  });
}

// --- A tenant's technical client

/** Refetches every few seconds while the worker checks the client. */
export const useConnection = (tenantId: string) =>
  useQuery({
    queryKey: ["tenants", tenantId, "connection"],
    queryFn: async () => (await request<Json<ConnectionState>>("GET", `/tenants/${tenantId}/connection`)).connection,
    refetchInterval: (q) => pollWhile(q.state.data?.status === "checking"),
  });

function useConnectionChange<I, O>(tenantId: string, mutationFn: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({ mutationFn, onSettled: () => client.invalidateQueries({ queryKey: ["tenants", tenantId, "connection"] }) });
}

export const useConnect = (tenantId: string) =>
  useConnectionChange(tenantId, (input: { clientId: string; clientSecret: string; tokenUrl: string; spaces: string[] }) =>
    request<ConnectionJson>("PUT", `/tenants/${tenantId}/connection`, input),
  );
export const useSetConnectionSpaces = (tenantId: string) =>
  useConnectionChange(tenantId, (spaces: string[]) => request<ConnectionJson>("PUT", `/tenants/${tenantId}/connection/spaces`, { spaces }));
export const useCheckConnection = (tenantId: string) => useConnectionChange(tenantId, () => request<ConnectionJson>("POST", `/tenants/${tenantId}/connection/check`));
export const useDisconnect = (tenantId: string) => useConnectionChange(tenantId, () => request<void>("DELETE", `/tenants/${tenantId}/connection`));

// --- Each space's database user (snapshots)

/** Refetches every few seconds while the worker checks one of them. */
export const useDatabaseUsers = (tenantId: string) =>
  useQuery({
    queryKey: ["tenants", tenantId, "database-users"],
    queryFn: () => request<DatabaseUserJson[]>("GET", `/tenants/${tenantId}/database-users`),
    refetchInterval: (q) => pollWhile(q.state.data?.some((u) => u.status === "checking") ?? false),
  });

function useDatabaseUserChange<I, O>(tenantId: string, mutationFn: (input: I) => Promise<O>) {
  const client = useQueryClient();
  return useMutation({ mutationFn, onSettled: () => client.invalidateQueries({ queryKey: ["tenants", tenantId, "database-users"] }) });
}

export const useSetDatabaseUser = (tenantId: string) =>
  useDatabaseUserChange(tenantId, (input: { host: string; user: string; password: string }) =>
    request<DatabaseUserJson>("PUT", `/tenants/${tenantId}/database-users`, input),
  );
export const useCheckDatabaseUser = (tenantId: string) =>
  useDatabaseUserChange(tenantId, (space: string) => request<DatabaseUserJson>("POST", `/tenants/${tenantId}/database-users/${space}/check`));
export const useRemoveDatabaseUser = (tenantId: string) =>
  useDatabaseUserChange(tenantId, (space: string) => request<void>("DELETE", `/tenants/${tenantId}/database-users/${space}`));

// --- Scans

/** Refetches every few seconds while one of the scans is queued or running. */
export const useScans = (tenantId: string) =>
  useQuery({
    queryKey: ["tenants", tenantId, "scans"],
    queryFn: () => request<ScanJson[]>("GET", `/tenants/${tenantId}/scans`),
    refetchInterval: (q) => pollWhile(q.state.data?.some((s) => active(s.status)) ?? false),
  });

export const useScan = (id: string) =>
  useQuery({
    queryKey: ["scans", id],
    queryFn: () => request<ScanJson>("GET", `/scans/${id}`),
    refetchInterval: (q) => pollWhile(q.state.data ? active(q.state.data.status) : false),
  });

export function useStartScan(tenantId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (spaces: string[]) => request<ScanJson>("POST", `/tenants/${tenantId}/scans`, { spaces }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["tenants", tenantId, "scans"] }),
  });
}

// --- Scan schedules

const scanScheduleKey = (tenantId: string) => ["tenants", tenantId, "scan-schedule"];

/** The tenant's scan schedule, or null. Refetched every minute while there is one, as its next run moves on. */
export const useScanSchedule = (tenantId: string) =>
  useQuery({
    queryKey: scanScheduleKey(tenantId),
    queryFn: async () => (await request<{ schedule: ScanScheduleJson | null }>("GET", `/tenants/${tenantId}/scan-schedule`)).schedule,
    refetchInterval: (q) => (q.state.data ? 60_000 : false),
  });

export function useSetScanSchedule(tenantId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { cron: string; timeZone: string }) =>
      (await request<{ schedule: ScanScheduleJson }>("PUT", `/tenants/${tenantId}/scan-schedule`, input)).schedule,
    onSuccess: (schedule) => client.setQueryData(scanScheduleKey(tenantId), schedule),
  });
}

export function useRemoveScanSchedule(tenantId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<void>("DELETE", `/tenants/${tenantId}/scan-schedule`),
    onSuccess: () => client.setQueryData(scanScheduleKey(tenantId), null),
  });
}

/** Only asked for once the scan has succeeded; a stored graph never changes, so it is never refetched. */
export const useScanGraph = (id: string, ready: boolean) =>
  useQuery({ queryKey: ["scans", id, "graph"], queryFn: () => request<ScanGraph>("GET", `/scans/${id}/graph`), enabled: ready, staleTime: Infinity });

export const useObject = (scanId: string, ref: { space: string; technicalName: string } | undefined) =>
  useQuery({
    queryKey: ["scans", scanId, "objects", ref?.space, ref?.technicalName],
    queryFn: () => request<ObjectDetails>("GET", `/scans/${scanId}/objects/${ref!.space}/${ref!.technicalName}`),
    enabled: ref !== undefined,
    staleTime: Infinity,
  });

// --- Pipelines

/**
 * The pipeline behind `output` on one scan, with writers excluded by pattern (as `npm run scan -- --exclude-writer`).
 * Asked for again each time the page opens: which steps a snapshot can measure follows the database users' checks.
 */
export const usePipelineOnScan = (scanId: string, output: string, excludeWriters: string[]) =>
  useQuery({
    queryKey: ["scans", scanId, "pipeline", output, excludeWriters],
    queryFn: () => request<PipelineResult>("GET", `/scans/${scanId}/pipeline?${pipelineQuery(output, excludeWriters)}`),
    // While an exclusion is applied, keep showing the current picture of the same output.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[3] === output ? previous : undefined),
  });

export function pipelineQuery(output: string, excludeWriters: string[]): string {
  const q = new URLSearchParams({ output });
  for (const w of excludeWriters) q.append("excludeWriter", w);
  return q.toString();
}

export const usePipelines = (tenantId: string) =>
  useQuery({ queryKey: ["tenants", tenantId, "pipelines"], queryFn: () => request<PipelineDefinitionJson[]>("GET", `/tenants/${tenantId}/pipelines`) });

export const useSavedPipeline = (id: string) =>
  useQuery({ queryKey: ["pipelines", id], queryFn: () => request<Json<SavedPipelineResult>>("GET", `/pipelines/${id}`), enabled: id !== "", retry: false });

export function useSavePipeline(tenantId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; output: string; excludeWriters: string[] }) =>
      request<PipelineDefinitionJson>("POST", `/tenants/${tenantId}/pipelines`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: ["tenants", tenantId, "pipelines"] }),
  });
}

export function useDeletePipeline() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (pipeline: PipelineDefinitionJson) => request<void>("DELETE", `/pipelines/${pipeline.id}`),
    onSuccess: (_done, pipeline) => client.invalidateQueries({ queryKey: ["tenants", pipeline.tenantId, "pipelines"] }),
  });
}

// --- Snapshots

/**
 * Refetches every few seconds while one of them is queued or running, and
 * every minute while the pipeline has a schedule, so a scheduled one shows up.
 */
export const useSnapshots = (pipelineId: string, scheduled = false) =>
  useQuery({
    queryKey: ["pipelines", pipelineId, "snapshots"],
    queryFn: () => request<SnapshotJson[]>("GET", `/pipelines/${pipelineId}/snapshots`),
    refetchInterval: (q) => pollWhile(q.state.data?.some((s) => active(s.status)) ?? false) || (scheduled ? 60_000 : false),
  });

export const useSnapshot = (id: string) =>
  useQuery({
    queryKey: ["snapshots", id],
    queryFn: () => request<SnapshotDetailsJson>("GET", `/snapshots/${id}`),
    refetchInterval: (q) => pollWhile(q.state.data ? active(q.state.data.status) : false),
  });

/** Two snapshots compared: the pair given, or else the latest two successful ones. `enabled`: false while it is known there aren't two. */
export const useComparison = (pipelineId: string, pair: { from: string; to: string } | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ["pipelines", pipelineId, "compare", pair?.from ?? "", pair?.to ?? ""],
    queryFn: () =>
      request<SnapshotComparisonJson>("GET", `/pipelines/${pipelineId}/compare${pair ? `?${new URLSearchParams(pair).toString()}` : ""}`),
    enabled,
    retry: false,
  });

export function useTakeSnapshot(pipelineId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<SnapshotJson>("POST", `/pipelines/${pipelineId}/snapshots`),
    onSuccess: () => client.invalidateQueries({ queryKey: ["pipelines", pipelineId, "snapshots"] }),
  });
}

// --- Schedules

const scheduleKey = (pipelineId: string) => ["pipelines", pipelineId, "schedule"];

/** The pipeline's schedule, or null. Refetched every minute while there is one, as its next run moves on. */
export const useSchedule = (pipelineId: string) =>
  useQuery({
    queryKey: scheduleKey(pipelineId),
    queryFn: async () => (await request<{ schedule: ScheduleJson | null }>("GET", `/pipelines/${pipelineId}/schedule`)).schedule,
    refetchInterval: (q) => (q.state.data ? 60_000 : false),
  });

export function useSetSchedule(pipelineId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { cron: string; timeZone: string; rowDropPercent: number }) =>
      (await request<{ schedule: ScheduleJson }>("PUT", `/pipelines/${pipelineId}/schedule`, input)).schedule,
    onSuccess: (schedule) => client.setQueryData(scheduleKey(pipelineId), schedule),
  });
}

export function useRemoveSchedule(pipelineId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<void>("DELETE", `/pipelines/${pipelineId}/schedule`),
    onSuccess: () => client.setQueryData(scheduleKey(pipelineId), null),
  });
}

// --- Watching a pipeline

const watchKey = (pipelineId: string) => ["pipelines", pipelineId, "watch"];

/** Whether the signed-in user watches the pipeline (and gets its alerts), and how many people do. */
export const useWatch = (pipelineId: string) =>
  useQuery({ queryKey: watchKey(pipelineId), queryFn: () => request<WatchState>("GET", `/pipelines/${pipelineId}/watch`) });

export function useSetWatching(pipelineId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (watching: boolean) => request<WatchState>(watching ? "PUT" : "DELETE", `/pipelines/${pipelineId}/watch`),
    onSuccess: (state) => client.setQueryData(watchKey(pipelineId), state),
  });
}

// --- Scenarios (the builder)

const scenariosKey = (pipelineId: string) => ["pipelines", pipelineId, "scenarios"];
const runActive = (status: ScenarioRunSummary["status"]) => status === "queued" || status === "running";

/** A pipeline's scenarios, by name. Refetches every few seconds while one of their latest runs is queued or running. */
export const useScenarios = (pipelineId: string) =>
  useQuery({
    queryKey: scenariosKey(pipelineId),
    queryFn: () => request<ScenarioJson[]>("GET", `/pipelines/${pipelineId}/scenarios`),
    refetchInterval: (q) => pollWhile(q.state.data?.some((s) => s.lastRun && runActive(s.lastRun.status)) ?? false),
  });

/** What the builder offers for the pipeline on the latest scan: tables that take rows and steps a check can be on. */
export const useScenarioInputs = (pipelineId: string) =>
  useQuery({
    queryKey: ["pipelines", pipelineId, "scenario-inputs"],
    queryFn: () => request<ScenarioInputs>("GET", `/pipelines/${pipelineId}/scenario-inputs`),
    enabled: pipelineId !== "",
    retry: false,
  });

/** The draft compiled as it is now, unsaved; `draft` is undefined while there is nothing to compile. Nothing is sent to the tenant. */
export const useScenarioCompile = (pipelineId: string, draft: ScenarioDraft | undefined) =>
  useQuery({
    queryKey: ["pipelines", pipelineId, "scenario-check", draft],
    queryFn: () => request<ScenarioCompile>("POST", `/pipelines/${pipelineId}/scenario-check`, draft),
    enabled: draft !== undefined,
    retry: false,
    staleTime: Infinity,
    // While the next draft compiles, keep showing what the last one gave.
    placeholderData: (previous) => previous,
  });

/**
 * Rows and checks drafted by Claude from the scenario's description (only when
 * the server has an Anthropic API key: ScenarioInputs.drafting). Saves nothing;
 * an answer can take a minute or two.
 */
export const useDraftScenario = (pipelineId: string) =>
  useMutation({
    mutationFn: (body: { description: string; name?: string; kind?: ScenarioSpec["kind"] }) =>
      request<ScenarioDrafted>("POST", `/pipelines/${pipelineId}/scenario-draft`, body),
  });

export const useScenario = (id: string) =>
  useQuery({ queryKey: ["scenarios", id], queryFn: () => request<ScenarioJson>("GET", `/scenarios/${id}`), enabled: id !== "", retry: false });

export function useSaveScenario(pipelineId: string, scenarioId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draft: ScenarioDraft) =>
      scenarioId ? request<ScenarioJson>("PUT", `/scenarios/${scenarioId}`, draft) : request<ScenarioJson>("POST", `/pipelines/${pipelineId}/scenarios`, draft),
    onSuccess: (saved) => {
      client.setQueryData(["scenarios", saved.id], saved);
      return client.invalidateQueries({ queryKey: scenariosKey(pipelineId) });
    },
  });
}

export function useDeleteScenario(pipelineId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (scenarioId: string) => request<void>("DELETE", `/scenarios/${scenarioId}`),
    onSuccess: () => client.invalidateQueries({ queryKey: scenariosKey(pipelineId) }),
  });
}

/** A scenario's runs, newest first. Refetches every few seconds while one is queued or running. */
export const useScenarioRuns = (scenarioId: string) =>
  useQuery({
    queryKey: ["scenarios", scenarioId, "runs"],
    queryFn: () => request<ScenarioRunSummaryJson[]>("GET", `/scenarios/${scenarioId}/runs`),
    enabled: scenarioId !== "",
    refetchInterval: (q) => pollWhile(q.state.data?.some((r) => runActive(r.status)) ?? false),
  });

export function useRunScenario(pipelineId: string, scenarioId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<ScenarioRunJson>("POST", `/scenarios/${scenarioId}/runs`),
    onSuccess: () =>
      Promise.all([client.invalidateQueries({ queryKey: ["scenarios", scenarioId] }), client.invalidateQueries({ queryKey: scenariosKey(pipelineId) })]),
  });
}

export const useScenarioRun = (id: string) =>
  useQuery({
    queryKey: ["scenario-runs", id],
    queryFn: () => request<ScenarioRunJson>("GET", `/scenario-runs/${id}`),
    refetchInterval: (q) => pollWhile(q.state.data ? runActive(q.state.data.status) : false),
  });

// --- Suites: all of a pipeline's scenarios at once

const suitesKey = (pipelineId: string) => ["pipelines", pipelineId, "scenario-suites"];

/** A pipeline's suites, newest first. Refetches every few seconds while one is queued or running. */
export const useScenarioSuites = (pipelineId: string) =>
  useQuery({
    queryKey: suitesKey(pipelineId),
    queryFn: () => request<ScenarioSuiteSummaryJson[]>("GET", `/pipelines/${pipelineId}/scenario-suites`),
    refetchInterval: (q) => pollWhile(q.state.data?.some((s) => runActive(s.status)) ?? false),
  });

export const useScenarioSuite = (id: string) =>
  useQuery({
    queryKey: ["scenario-suites", id],
    queryFn: () => request<ScenarioSuiteJson>("GET", `/scenario-suites/${id}`),
    refetchInterval: (q) => pollWhile(q.state.data ? runActive(q.state.data.status) : false),
  });

export function useRunAllScenarios(pipelineId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<ScenarioSuiteJson>("POST", `/pipelines/${pipelineId}/scenario-suites`),
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: suitesKey(pipelineId) }), client.invalidateQueries({ queryKey: scenariosKey(pipelineId) })]),
  });
}

// --- The account's Teams channel (admins)

const TEAMS = ["account", "teams-channel"];

export const useTeamsChannel = (allowed: boolean) =>
  useQuery({
    queryKey: TEAMS,
    queryFn: async () => (await request<{ channel: TeamsChannelJson | null }>("GET", "/account/teams-channel")).channel,
    enabled: allowed,
  });

export function useSetTeamsChannel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (url: string) => (await request<{ channel: TeamsChannelJson }>("PUT", "/account/teams-channel", { url })).channel,
    onSuccess: (channel) => client.setQueryData(TEAMS, channel),
  });
}

export const useTestTeamsChannel = () => useMutation({ mutationFn: () => request<void>("POST", "/account/teams-channel/test") });

export function useRemoveTeamsChannel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<void>("DELETE", "/account/teams-channel"),
    onSuccess: () => client.setQueryData(TEAMS, null),
  });
}
