import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Json,
  ObjectDetails,
  PipelineDefinition,
  PipelineResult,
  SavedPipelineResult,
  Scan,
  ScanGraph,
  Tenant,
} from "@ystara/shared";

/**
 * The web app's only way to the API. Every call goes to /api on the same
 * origin: the API serves this app (Docker, `npm run dev:api`), and in
 * development Vite forwards /api to it.
 *
 * Each read is a hook on TanStack Query, which caches answers per key, shares
 * them between components and refetches when told to (e.g. while a scan runs).
 * Response types come from packages/shared/src/api.ts, with dates as strings.
 */
export type TenantJson = Json<Tenant>;
export type ScanJson = Json<Scan>;
export type PipelineDefinitionJson = Json<PipelineDefinition>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, errorMessage(data) ?? `The API answered ${res.status} ${res.statusText}`);
  return data as T;
}

/** The API's `{ error, issues? }` as one readable sentence. */
export function errorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || !("error" in data) || typeof data.error !== "string") return undefined;
  const issues = "issues" in data && Array.isArray(data.issues) ? data.issues.map((i: { message?: string }) => i.message).filter(Boolean) : [];
  return issues.length ? `${data.error}: ${issues.join("; ")}` : data.error;
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

/** The pipeline behind `output` on one scan, with writers excluded by pattern (as `npm run scan -- --exclude-writer`). */
export const usePipelineOnScan = (scanId: string, output: string, excludeWriters: string[]) =>
  useQuery({
    queryKey: ["scans", scanId, "pipeline", output, excludeWriters],
    queryFn: () => request<PipelineResult>("GET", `/scans/${scanId}/pipeline?${pipelineQuery(output, excludeWriters)}`),
    staleTime: Infinity,
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
  useQuery({ queryKey: ["pipelines", id], queryFn: () => request<Json<SavedPipelineResult>>("GET", `/pipelines/${id}`), retry: false });

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
