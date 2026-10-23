import { useEffect } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { isUnauthorized, useMe, useTenants } from "./api";
import { AppFrame } from "./components/AppFrame";
import { ErrorStrip, Loading } from "./components/Feedback";
import { PageError, RouteError, RouteErrorPage, StartError } from "./components/PageError";
import { SignInAgain } from "./components/SignInAgain";
import { AuditPage } from "./pages/AuditPage";
import { ComparePage } from "./pages/ComparePage";
import { DiscoveryPage } from "./pages/DiscoveryPage";
import { InvitePage } from "./pages/InvitePage";
import { OperatorPage } from "./pages/OperatorPage";
import { PipelineOnScanPage, SavedPipelinePage } from "./pages/PipelinePages";
import { PipelinesPage } from "./pages/PipelinesPage";
import { ReportPage } from "./pages/ReportPage";
import { ResetPage } from "./pages/ResetPage";
import { ScanPage } from "./pages/ScanPage";
import { ScenarioPage, ScenarioRunPage, ScenarioSuitePage } from "./pages/Scenarios";
import { SecurityPage } from "./pages/SecurityPage";
import { SettingsPage } from "./pages/SettingsPage";
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
 * reset links work without one, and a pipeline's report has no frame. The tenant apps live under /tenants/:tenantId,
 * so a link opens on its tenant; scans, pipelines, snapshots, scenarios and
 * their runs and suites keep their own addresses and pick their tenant themselves.
 * Every page has an error element: inside the frame RouteError, elsewhere RouteErrorPage.
 */
export const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: <RouteErrorPage />,
    children: [
      { path: "/sign-in", element: <SignInPage />, errorElement: <RouteErrorPage /> },
      { path: "/invite/:token", element: <InvitePage />, errorElement: <RouteErrorPage /> },
      { path: "/reset/:token", element: <ResetPage />, errorElement: <RouteErrorPage /> },
      // Without the app's frame, so that it prints as a report; it checks the sign-in itself.
      { path: "/pipelines/:pipelineId/report", element: <ReportPage />, errorElement: <RouteErrorPage /> },
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
          { path: "pipelines/:pipelineId/history", element: <SavedPipelinePage tab="history" /> },
          { path: "pipelines/:pipelineId/scenarios/new", element: <ScenarioPage /> },
          { path: "pipelines/:pipelineId/compare", element: <ComparePage /> },
          { path: "scenarios/:scenarioId", element: <ScenarioPage /> },
          { path: "scenario-runs/:runId", element: <ScenarioRunPage /> },
          { path: "scenario-suites/:suiteId", element: <ScenarioSuitePage /> },
          { path: "snapshots/:snapshotId", element: <SnapshotPage /> },
          { path: "users", element: <UsersPage /> },
          { path: "settings", element: <SettingsPage /> },
          // Alerts became a part of Settings; old links still work.
          { path: "alerts", element: <Navigate to="/settings" replace /> },
          { path: "security", element: <SecurityPage /> },
          { path: "audit", element: <AuditPage /> },
          { path: "operator", element: <OperatorPage /> },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
]);

/** Every page, and over it "Your sign-in ended" when a call says so (session.ts). */
function Root() {
  return (
    <>
      <Outlet />
      <SignInAgain />
    </>
  );
}

/**
 * The frame, for whoever is signed in. Without a sign-in on the first /auth/me, the sign-in page, and back
 * here after it; a sign-in that ends later keeps the page (Root). If /auth/me can't be asked at all, a card
 * that asks again.
 */
function Layout({ error }: { error?: boolean }) {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) return <Loading />;
  if (!me.data) {
    if (isUnauthorized(me.error)) return <Navigate to={`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
    return <StartError error={me.error} retrying={me.isFetching} onRetry={() => void me.refetch()} />;
  }

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

  return tenants.error ? (
    <div className="page">
      <ErrorStrip error={tenants.error} />
    </div>
  ) : (
    <Loading />
  );
}

function NotFound() {
  return <PageError heading="Page not found" sentence="There is no page at this address. Check the link, or start again from Home." />;
}
