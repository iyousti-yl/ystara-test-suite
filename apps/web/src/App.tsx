import { useEffect } from "react";
import { createBrowserRouter, isRouteErrorResponse, Navigate, Outlet, useLocation, useNavigate, useRouteError } from "react-router";
import { isUnauthorized, useMe, useTenants } from "./api";
import { AppFrame } from "./components/AppFrame";
import { ErrorStrip, Loading } from "./components/Feedback";
import { AlertsPage } from "./pages/AlertsPage";
import { ComparePage } from "./pages/ComparePage";
import { DiscoveryPage } from "./pages/DiscoveryPage";
import { InvitePage } from "./pages/InvitePage";
import { OperatorPage } from "./pages/OperatorPage";
import { PipelineOnScanPage, SavedPipelinePage } from "./pages/PipelinePages";
import { PipelinesPage } from "./pages/PipelinesPage";
import { ResetPage } from "./pages/ResetPage";
import { ScanPage } from "./pages/ScanPage";
import { ScenarioPage, ScenarioRunPage, ScenarioSuitePage } from "./pages/Scenarios";
import { SignInPage } from "./pages/SignInPage";
import { SnapshotPage } from "./pages/Snapshots";
import { DatabaseUsersPage } from "./pages/DatabaseUsers";
import { TechnicalClientPage } from "./pages/TenantConnection";
import { TenantHomePage } from "./pages/TenantHomePage";
import { TenantsPage } from "./pages/TenantsPage";
import { UsersPage } from "./pages/UsersPage";
import { TenantScopeProvider, useTenantScope } from "./tenantScope";

/**
 * The pages and their URLs. Every page can be opened by its link: the API
 * answers these paths with index.html and the router picks the page.
 * Everything under Layout needs a signed-in user; sign-in, invitation and
 * reset links work without one. The tenant apps live under /tenants/:tenantId,
 * so a link opens on its tenant; scans, pipelines, snapshots, scenarios and
 * their runs and suites keep their own addresses and pick their tenant themselves.
 */
export const router = createBrowserRouter([
  { path: "/sign-in", element: <SignInPage /> },
  { path: "/invite/:token", element: <InvitePage /> },
  { path: "/reset/:token", element: <ResetPage /> },
  {
    path: "/",
    element: <Layout />,
    errorElement: <Layout error />,
    children: [
      { index: true, element: <StartPage /> },
      { path: "tenants", element: <TenantsPage /> },
      { path: "tenants/:tenantId", element: <TenantHomePage /> },
      { path: "tenants/:tenantId/discovery", element: <DiscoveryPage /> },
      { path: "tenants/:tenantId/pipelines", element: <PipelinesPage /> },
      { path: "tenants/:tenantId/connection", element: <TechnicalClientPage /> },
      { path: "tenants/:tenantId/database-users", element: <DatabaseUsersPage /> },
      { path: "scans/:scanId", element: <ScanPage /> },
      { path: "scans/:scanId/pipeline", element: <PipelineOnScanPage /> },
      { path: "pipelines/:pipelineId", element: <SavedPipelinePage tab="lineage" /> },
      { path: "pipelines/:pipelineId/snapshots", element: <SavedPipelinePage tab="snapshots" /> },
      { path: "pipelines/:pipelineId/scenarios", element: <SavedPipelinePage tab="scenarios" /> },
      { path: "pipelines/:pipelineId/scenarios/new", element: <ScenarioPage /> },
      { path: "pipelines/:pipelineId/compare", element: <ComparePage /> },
      { path: "scenarios/:scenarioId", element: <ScenarioPage /> },
      { path: "scenario-runs/:runId", element: <ScenarioRunPage /> },
      { path: "scenario-suites/:suiteId", element: <ScenarioSuitePage /> },
      { path: "snapshots/:snapshotId", element: <SnapshotPage /> },
      { path: "users", element: <UsersPage /> },
      { path: "alerts", element: <AlertsPage /> },
      { path: "operator", element: <OperatorPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

function Layout({ error }: { error?: boolean }) {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) return <Loading />;
  if (isUnauthorized(me.error)) return <Navigate to={`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!me.data) return <ErrorStrip error={me.error} />;

  return (
    // Keyed by account: switching accounts starts again from that account's remembered tenant.
    <TenantScopeProvider key={me.data.account.id} accountId={me.data.account.id}>
      <AppFrame me={me.data}>{error ? <RouteError /> : <Outlet />}</AppFrame>
    </TenantScopeProvider>
  );
}

/** "/": the tenant picked last in this browser, or the first one; Tenants when the account has none yet. */
function StartPage() {
  const tenants = useTenants();
  const { tenantId } = useTenantScope();
  const navigate = useNavigate();

  useEffect(() => {
    if (!tenants.data) return;
    const start = tenants.data.find((t) => t.id === tenantId) ?? tenants.data[0];
    navigate(start ? `/tenants/${start.id}` : "/tenants", { replace: true });
  }, [tenants.data, tenantId, navigate]);

  return tenants.error ? <ErrorStrip error={tenants.error} /> : <Loading />;
}

function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : String(error);
  return (
    <div className="page">
      <ErrorStrip error={new Error(`Something went wrong on this page: ${message}`)} />
    </div>
  );
}

function NotFound() {
  return (
    <div className="page">
      <ErrorStrip error={new Error("There is no page at this address.")} />
    </div>
  );
}
