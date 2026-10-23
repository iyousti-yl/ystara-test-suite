import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { ACTIVITY_HEADER } from "@ystara/shared";
import type {
  Account,
  AccountOverview,
  AccountSettings,
  AuditGroup,
  AuditPage,
  AuthenticatorSetup,
  ChangePassword,
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
  PipelineHistory,
  PipelineReport,
  PipelineResult,
  PipelineSchedule,
  PipelineSummary,
  ResetOffer,
  Role,
  SavedPipelineResult,
  Scan,
  SignOff,
  SignOffState,
  SignOffVerdict,
  SpaceScope,
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
import { activity } from "./activity";
import { answerError, connectionFailure } from "./errors";
import { fileNameOf, saveFile } from "./files";
import { signInSettled } from "./session";

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
 * never sees it). An answer 401 means "not signed in": on the first /auth/me,
 * App.tsx sends the browser to the sign-in page; later, the sign-in ended, and
 * main.tsx opens "Your sign-in ended" over the page (session.ts). Each call
 * says whether someone is using the page (activity.ts), and gives up after
 * 30 seconds; a call that gets no answer fails with one plain sentence (errors.ts).
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
export type SignOffJson = Json<SignOff>;
export type SignOffStateJson = Json<SignOffState>;
export type HistoryEventJson = Json<PipelineHistory["events"][number]>;
export type PipelineReportJson = Json<PipelineReport>;
export type AuditEventJson = Json<AuditPage["events"][number]>;
/** A scenario as the builder sends it: the API adds the pipeline and the version. */
export type ScenarioDraft = Omit<ScenarioSpec, "pipeline" | "version">;

export { ApiError, errorMessage, isUnauthorized, SignInEnded } from "./errors";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** How long a call may take before the app gives up on it. Drafting with Claude takes minutes, so it has none. */
const TIME_LIMIT_MS = 30_000;

/** fetch, with the activity header while someone uses the page and a time limit; no answer at all is one plain sentence. */
async function send(method: Method, path: string, body: unknown, timeLimit: number | false): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (activity.isActive()) headers[ACTIVITY_HEADER] = "1";
  try {
    return await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeLimit ? AbortSignal.timeout(timeLimit) : undefined,
    });
  } catch (e) {
    throw connectionFailure(e);
  }
}

/** The answer's JSON, or undefined when it has none; an answer cut off on the way is a connection failure. */
async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text().catch((e: unknown) => {
    throw connectionFailure(e);
  });
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

async function request<T>(method: Method, path: string, body?: unknown, timeLimit: number | false = TIME_LIMIT_MS): Promise<T> {
  const res = await send(method, path, body, timeLimit);
  const data = await bodyOf(res);
  if (!res.ok) throw answerError(path.split("?")[0], res.status, res.statusText, data);
  return data as T;
}

/**
 * A CSV export, fetched rather than opened in the tab: a refusal shows on the page in words (an ended
 * sign-in opens the sign-in dialog), never as the API's raw answer. Saved under the name the API gives it.
 */
export function useDownload() {
  return useMutation({
    mutationFn: async ({ path, name }: { path: string; name: string }) => {
      const res = await send("GET", path, undefined, TIME_LIMIT_MS);
      if (!res.ok) throw answerError(path.split("?")[0], res.status, res.statusText, await bodyOf(res));
      const blob = await res.blob().catch((e: unknown) => {
        throw connectionFailure(e);
      });
      saveFile(blob, fileNameOf(res.headers.get("content-disposition"), name));
    },
  });
}

/** How many events of a pipeline's history the API sends, newest first (its CSV has them all). */
export const HISTORY_EVENTS = 100;

/** Lists that come a page at a time (scans, snapshots, runs, suites): the API's page, newest first. */
export const PAGE = 50;

/**
 * A list a page of PAGE at a time, newest first, as one array (`data`). The API answers
 * `?before=<requestedAt of the oldest row shown>` with the next older page; fetchNextPage loads it, and
 * hasNextPage says whether a full page came last, so older rows may be left. Refetching (polling while
 * something runs) asks for every page shown again. `poll`: how often to refetch, from the rows shown.
 * A row on two pages (a new one pushed the others down meanwhile) shows once, and a page that brings
 * nothing new ends the list.
 */
function useOlderPages<T extends { id: string; requestedAt: string }>(key: QueryKey, path: string, options: { enabled?: boolean; poll: (rows: T[]) => number | false }) {
  return useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => request<T[]>("GET", pageParam ? `${path}?before=${encodeURIComponent(pageParam)}` : path),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last, pages) => {
      const shown = new Set(pages.slice(0, -1).flatMap((page) => page.map((row) => row.id)));
      return last.length >= PAGE && last.some((row) => !shown.has(row.id)) ? last.at(-1)?.requestedAt : undefined;
    },
    select: (data) => [...new Map(data.pages.flat().map((row) => [row.id, row])).values()],
    enabled: options.enabled,
    refetchInterval: (q) => options.poll(q.state.data?.pages.flat() ?? []),
  });
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
    signInSettled();
    void client.resetQueries({ predicate: (q) => !keep.has(String(q.queryKey[0])) });
  };
}

/** Email and password. `accountId`: start in that account when the user belongs to it (signing in again over a page), else in their first. */
export const useLogin = () =>
  useMutation({ mutationFn: (input: { email: string; password: string; accountId?: string }) => request<{ next: "code" }>("POST", "/auth/login", input) });

export function useCode() {
  const startWith = useStartWith();
  return useMutation({ mutationFn: (code: string) => request<Me>("POST", "/auth/code", { code }), onSuccess: startWith });
}

/**
 * The code, when signing in again over a page whose sign-in ended (components/SignInAgain.tsx). The same
 * person in the same account carries on: the page stays, with what they typed, and asks for its data again.
 * Anyone else starts afresh, as after signing in, and `elsewhere` takes them Home. Both happen here, not in
 * the dialog, which is gone by the time a callback of its own would run.
 */
export function useCodeAgain(elsewhere: () => void) {
  const client = useQueryClient();
  const startWith = useStartWith();
  return useMutation({
    mutationFn: (code: string) => request<Me>("POST", "/auth/code", { code }),
    onSuccess: (next) => {
      const before = client.getQueryData<Me>(ME);
      if (before?.user.id !== next.user.id || before.account.id !== next.account.id) {
        startWith(next);
        return elsewhere();
      }
      client.setQueryData(ME, next);
      signInSettled();
      void client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== ME[0] });
    },
  });
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<void>("POST", "/auth/logout"),
    onSettled: () => {
      client.clear();
      signInSettled();
    },
  });
}

/** A new password, with the current one and a code. The API signs out every other browser, so /auth/me's count is asked for again. */
export function useChangePassword() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangePassword) => request<{ ok: true }>("POST", "/auth/password", input),
    onSuccess: () => client.invalidateQueries({ queryKey: ME }),
  });
}

export function useEndOtherSessions() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<{ ended: number }>("POST", "/auth/sessions/end-others"),
    onSuccess: () => client.invalidateQueries({ queryKey: ME }),
  });
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

export const useInvite = () =>
  useTeamChange((input: { email: string; role: Role; spaces: SpaceScope }) => request<Json<CreatedInvitation>>("POST", "/team/invitations", input));
export const useWithdrawInvitation = () => useTeamChange((id: string) => request<void>("DELETE", `/team/invitations/${id}`));
/**
 * A new role, and new spaces when given (null for every space); without spaces the member keeps theirs.
 * A change to the signed-in user's own role changes what the app offers them, so /auth/me is asked for again.
 */
export function useChangeRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; role: Role; spaces?: SpaceScope }) =>
      request<void>("PATCH", `/team/members/${input.userId}`, { role: input.role, spaces: input.spaces }),
    onSettled: (_done, _error, input) =>
      Promise.all([
        client.invalidateQueries({ queryKey: TEAM }),
        input.userId === client.getQueryData<Me>(ME)?.user.id ? client.invalidateQueries({ queryKey: ME }) : undefined,
      ]),
  });
}
/** The spaces the account's scans covered, to limit a member to. */
export const useTeamSpaces = (allowed: boolean) => useQuery({ queryKey: [...TEAM, "spaces"], queryFn: () => request<string[]>("GET", "/team/spaces"), enabled: allowed });
export const useRemoveMember = () => useTeamChange((userId: string) => request<void>("DELETE", `/team/members/${userId}`));

/** The signed-in account's new name, which the header and the account switcher show (/auth/me). */
export function useRenameAccount() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (name: string) => request<Account>("PATCH", "/team/account", { name }), onSuccess: () => client.invalidateQueries({ queryKey: ME }) });
}

const active = (status: Scan["status"]) => status === "queued" || status === "running";
const pollWhile = (busy: boolean) => (busy ? 3000 : false);
const runActive = (status: ScenarioRunSummary["status"]) => status === "queued" || status === "running";
/** After a change to a pipeline's results, scenarios, schedule or sign-off: the Pipelines board and the pipeline's header ask again. */
const refreshSummaries = (client: ReturnType<typeof useQueryClient>) => client.invalidateQueries({ predicate: (q) => q.queryKey[2] === "pipeline-summaries" });

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

/** Newest first, a page at a time (useOlderPages). Refetches every few seconds while one of the scans is queued or running. */
export const useScans = (tenantId: string) =>
  useOlderPages<ScanJson>(["tenants", tenantId, "scans"], `/tenants/${tenantId}/scans`, { poll: (scans) => pollWhile(scans.some((s) => active(s.status))) });

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

/** `within`: the output (SPACE.NAME) of the pipeline it was opened from, so a member limited to some spaces still sees every step. */
export const useObject = (scanId: string, ref: { space: string; technicalName: string } | undefined, within?: string) =>
  useQuery({
    queryKey: ["scans", scanId, "objects", ref?.space, ref?.technicalName, within],
    queryFn: () =>
      request<ObjectDetails>("GET", `/scans/${scanId}/objects/${ref!.space}/${ref!.technicalName}${within ? `?within=${encodeURIComponent(within)}` : ""}`),
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

export type PipelineSummaryJson = Json<PipelineSummary>;

/**
 * The latest results of each of the tenant's pipelines, for the Pipelines board
 * and the pipeline's header (pipelineHealth reads them). Refetched every few
 * seconds while something runs, and every minute anyway, as schedules move on.
 */
export const usePipelineSummaries = (tenantId: string) =>
  useQuery({
    queryKey: ["tenants", tenantId, "pipeline-summaries"],
    queryFn: () => request<PipelineSummaryJson[]>("GET", `/tenants/${tenantId}/pipeline-summaries`),
    enabled: tenantId !== "",
    refetchInterval: (q) =>
      pollWhile(q.state.data?.some((s) => (s.suite && runActive(s.suite.status)) || (s.snapshot && active(s.snapshot.status))) ?? false) || 60_000,
  });

export const useSavedPipeline = (id: string) =>
  useQuery({ queryKey: ["pipelines", id], queryFn: () => request<Json<SavedPipelineResult>>("GET", `/pipelines/${id}`), enabled: id !== "", retry: false });

/** A saved pipeline's ignored loaders, changed in place: its steps, picture and warnings are worked out again. */
export function useSetIgnoredLoaders(pipelineId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (excludeWriters: string[]) => request<PipelineDefinitionJson>("PUT", `/pipelines/${pipelineId}/ignored-loaders`, { excludeWriters }),
    onSuccess: (p) =>
      Promise.all([
        client.invalidateQueries({ queryKey: ["pipelines", pipelineId] }),
        client.invalidateQueries({ queryKey: ["tenants", p.tenantId, "pipelines"] }),
        refreshSummaries(client),
      ]),
  });
}

export function useSavePipeline(tenantId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; output: string; excludeWriters: string[] }) =>
      request<PipelineDefinitionJson>("POST", `/tenants/${tenantId}/pipelines`, input),
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ["tenants", tenantId, "pipelines"] }), refreshSummaries(client)]),
  });
}

export function useDeletePipeline() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (pipeline: PipelineDefinitionJson) => request<void>("DELETE", `/pipelines/${pipeline.id}`),
    onSuccess: (_done, pipeline) => Promise.all([client.invalidateQueries({ queryKey: ["tenants", pipeline.tenantId, "pipelines"] }), refreshSummaries(client)]),
  });
}

// --- Snapshots

/**
 * Newest first, a page at a time (useOlderPages). Refetches every few seconds while one of them is queued
 * or running, and every minute while the pipeline has a schedule, so a scheduled one shows up.
 */
export const useSnapshots = (pipelineId: string, scheduled = false) =>
  useOlderPages<SnapshotJson>(["pipelines", pipelineId, "snapshots"], `/pipelines/${pipelineId}/snapshots`, {
    poll: (snapshots) => pollWhile(snapshots.some((s) => active(s.status))) || (scheduled ? 60_000 : false),
  });

/** `enabled`: false while it isn't needed (Compare asks for one only when it is older than the list it shows). */
export const useSnapshot = (id: string, enabled = true) =>
  useQuery({
    queryKey: ["snapshots", id],
    queryFn: () => request<SnapshotDetailsJson>("GET", `/snapshots/${id}`),
    enabled: enabled && id !== "",
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
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: ["pipelines", pipelineId, "snapshots"] }), refreshSummaries(client)]),
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
    onSuccess: (schedule) => {
      client.setQueryData(scheduleKey(pipelineId), schedule);
      return refreshSummaries(client);
    },
  });
}

export function useRemoveSchedule(pipelineId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request<void>("DELETE", `/pipelines/${pipelineId}/schedule`),
    onSuccess: () => {
      client.setQueryData(scheduleKey(pipelineId), null);
      return refreshSummaries(client);
    },
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
    onSuccess: (state) => {
      client.setQueryData(watchKey(pipelineId), state);
      return refreshSummaries(client);
    },
  });
}

// --- Scenarios (the builder)

const scenariosKey = (pipelineId: string) => ["pipelines", pipelineId, "scenarios"];

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
      request<ScenarioDrafted>("POST", `/pipelines/${pipelineId}/scenario-draft`, body, false),
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
      return Promise.all([client.invalidateQueries({ queryKey: scenariosKey(pipelineId) }), refreshSummaries(client)]);
    },
  });
}

export function useDeleteScenario(pipelineId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (scenarioId: string) => request<void>("DELETE", `/scenarios/${scenarioId}`),
    onSuccess: () => Promise.all([client.invalidateQueries({ queryKey: scenariosKey(pipelineId) }), refreshSummaries(client)]),
  });
}

/** A scenario's runs, newest first, a page at a time (useOlderPages). Refetches every few seconds while one is queued or running. */
export const useScenarioRuns = (scenarioId: string) =>
  useOlderPages<ScenarioRunSummaryJson>(["scenarios", scenarioId, "runs"], `/scenarios/${scenarioId}/runs`, {
    enabled: scenarioId !== "",
    poll: (runs) => pollWhile(runs.some((r) => runActive(r.status))),
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

/** A pipeline's suites, newest first, a page at a time (useOlderPages). Refetches every few seconds while one is queued or running. */
export const useScenarioSuites = (pipelineId: string) =>
  useOlderPages<ScenarioSuiteSummaryJson>(suitesKey(pipelineId), `/pipelines/${pipelineId}/scenario-suites`, {
    poll: (suites) => pollWhile(suites.some((s) => runActive(s.status))),
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
    onSuccess: () =>
      Promise.all([client.invalidateQueries({ queryKey: suitesKey(pipelineId) }), client.invalidateQueries({ queryKey: scenariosKey(pipelineId) }), refreshSummaries(client)]),
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

// --- The account's settings (admins)

const SETTINGS = ["account", "settings"];

export const useAccountSettings = (allowed: boolean) =>
  useQuery({ queryKey: SETTINGS, queryFn: () => request<AccountSettings>("GET", "/account/settings"), enabled: allowed });

/** Every builder asks again whether it can draft, as drafting with Claude may have been switched on or off. */
export function useSetAccountSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (settings: AccountSettings) => request<AccountSettings>("PUT", "/account/settings", settings),
    onSuccess: (settings) => {
      client.setQueryData(SETTINGS, settings);
      return client.invalidateQueries({ predicate: (q) => q.queryKey.includes("scenario-inputs") });
    },
  });
}

// --- A pipeline's results: sign-offs, history and the report

const signOffsKey = (pipelineId: string) => ["pipelines", pipelineId, "signoffs"];

/** The latest sign-off, what changed since, and what signing off now would cover. */
export const useSignOffs = (pipelineId: string) =>
  useQuery({ queryKey: signOffsKey(pipelineId), queryFn: () => request<SignOffStateJson>("GET", `/pipelines/${pipelineId}/signoffs`) });

export function useSignOff(pipelineId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { verdict: SignOffVerdict; comment: string }) => request<SignOffJson>("POST", `/pipelines/${pipelineId}/signoffs`, input),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: signOffsKey(pipelineId) }),
        client.invalidateQueries({ queryKey: ["pipelines", pipelineId, "history"] }),
        client.invalidateQueries({ queryKey: ["pipelines", pipelineId, "report"] }),
        refreshSummaries(client),
      ]),
  });
}

export const usePipelineHistory = (pipelineId: string) =>
  useQuery({
    queryKey: ["pipelines", pipelineId, "history"],
    queryFn: async () => (await request<Json<PipelineHistory>>("GET", `/pipelines/${pipelineId}/history`)).events,
  });

export const usePipelineReport = (pipelineId: string) =>
  useQuery({ queryKey: ["pipelines", pipelineId, "report"], queryFn: () => request<PipelineReportJson>("GET", `/pipelines/${pipelineId}/report`) });

// --- The audit log (admins)

export interface AuditFilters {
  user?: string;
  group?: AuditGroup;
  /** Days, as YYYY-MM-DD in the browser's time zone; `to` is included. */
  from?: string;
  to?: string;
}

/** The filters as the API's query string: whole days in the browser's time zone, `to` up to the end of its day. */
export function auditQuery(f: AuditFilters, before?: string): string {
  const q = new URLSearchParams();
  if (f.user) q.set("user", f.user);
  if (f.group) q.set("group", f.group);
  if (f.from) q.set("from", new Date(`${f.from}T00:00`).toISOString());
  if (f.to) {
    const end = new Date(`${f.to}T00:00`);
    end.setDate(end.getDate() + 1);
    q.set("to", end.toISOString());
  }
  if (before) q.set("before", before);
  const text = q.toString();
  return text ? `?${text}` : "";
}

/** The log a page of 100 at a time, newest first; fetchNextPage loads the next older page. */
export const useAuditLog = (filters: AuditFilters, allowed: boolean) =>
  useInfiniteQuery({
    queryKey: ["audit", filters],
    queryFn: ({ pageParam }) => request<Json<AuditPage>>("GET", `/audit${auditQuery(filters, pageParam)}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
    enabled: allowed,
  });

export const useAuditUsers = (allowed: boolean) => useQuery({ queryKey: ["audit", "users"], queryFn: () => request<string[]>("GET", "/audit/users"), enabled: allowed });
