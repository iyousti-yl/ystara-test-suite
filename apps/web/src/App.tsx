import { ShellBar, ShellBarBranding } from "@ui5/webcomponents-react";
import { createBrowserRouter, isRouteErrorResponse, Outlet, useNavigate, useRouteError } from "react-router";
import { ErrorStrip } from "./components/Feedback";
import { PipelineOnScanPage, SavedPipelinePage } from "./pages/PipelinePages";
import { ScanPage } from "./pages/ScanPage";
import { TenantPage } from "./pages/TenantPage";
import { TenantsPage } from "./pages/TenantsPage";

/**
 * The pages and their URLs. Every page can be opened by its link: the API
 * answers these paths with index.html and the router picks the page.
 */
export const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    errorElement: <Layout error />,
    children: [
      { index: true, element: <TenantsPage /> },
      { path: "tenants/:tenantId", element: <TenantPage /> },
      { path: "scans/:scanId", element: <ScanPage /> },
      { path: "scans/:scanId/pipeline", element: <PipelineOnScanPage /> },
      { path: "pipelines/:pipelineId", element: <SavedPipelinePage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

function Layout({ error }: { error?: boolean }) {
  const navigate = useNavigate();
  return (
    <div className="app">
      <ShellBar
        branding={
          <ShellBarBranding
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate("/");
            }}
          >
            Ystara Test Suite
          </ShellBarBranding>
        }
      />
      <main className="app-main">{error ? <RouteError /> : <Outlet />}</main>
    </div>
  );
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
