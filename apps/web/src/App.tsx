import { useState } from "react";
import { Avatar, ShellBar, ShellBarBranding, ShellBarItem, Text, UserMenu, UserMenuAccount, UserMenuItem } from "@ui5/webcomponents-react";
import type { Me } from "@ystara/shared";
import { createBrowserRouter, isRouteErrorResponse, Navigate, Outlet, useLocation, useNavigate, useRouteError } from "react-router";
import { isUnauthorized, useMe, useSignOut, useSwitchAccount } from "./api";
import { ErrorStrip, Loading } from "./components/Feedback";
import { InvitePage } from "./pages/InvitePage";
import { OperatorPage } from "./pages/OperatorPage";
import { PipelineOnScanPage, SavedPipelinePage } from "./pages/PipelinePages";
import { ResetPage } from "./pages/ResetPage";
import { ScanPage } from "./pages/ScanPage";
import { SignInPage } from "./pages/SignInPage";
import { TenantPage } from "./pages/TenantPage";
import { TenantsPage } from "./pages/TenantsPage";
import { UsersPage } from "./pages/UsersPage";
import { ROLE_LABEL } from "./roles";

/**
 * The pages and their URLs. Every page can be opened by its link: the API
 * answers these paths with index.html and the router picks the page.
 * Everything under Layout needs a signed-in user; sign-in, invitation and
 * reset links work without one.
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
      { index: true, element: <TenantsPage /> },
      { path: "tenants/:tenantId", element: <TenantPage /> },
      { path: "scans/:scanId", element: <ScanPage /> },
      { path: "scans/:scanId/pipeline", element: <PipelineOnScanPage /> },
      { path: "pipelines/:pipelineId", element: <SavedPipelinePage /> },
      { path: "users", element: <UsersPage /> },
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
    <div className="app">
      <Shell me={me.data} />
      <main className="app-main">{error ? <RouteError /> : <Outlet />}</main>
    </div>
  );
}

/** The bar on top: the product, the account worked in, the admin and operator pages for those who may, and the user menu. */
function Shell({ me }: { me: Me }) {
  const navigate = useNavigate();
  const signOut = useSignOut();
  const switchAccount = useSwitchAccount();
  // The avatar the user menu opens from, while it is open.
  const [menuFor, setMenuFor] = useState<HTMLElement>();
  const isAdmin = me.permissions.includes("users.manage");

  return (
    <>
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
        content={<Text className="shell-account">{me.account.name}</Text>}
        profile={<Avatar initials={initials(me.user.email)} accessibleName={`${me.user.email}, ${me.account.name}`} />}
        onProfileClick={(e) => setMenuFor(e.detail.targetRef)}
      >
        {isAdmin && <ShellBarItem icon="group" text="Users and roles" onClick={() => navigate("/users")} />}
        {me.operator && <ShellBarItem icon="action-settings" text="Operator" onClick={() => navigate("/operator")} />}
      </ShellBar>
      <UserMenu
        open={menuFor !== undefined}
        opener={menuFor}
        showOtherAccounts={me.accounts.length > 1}
        onClose={() => setMenuFor(undefined)}
        onSignOutClick={() => signOut.mutate(undefined, { onSettled: () => navigate("/sign-in", { replace: true }) })}
        onChangeAccount={(e) => {
          const accountId = e.detail.selectedAccount.dataset.accountId;
          if (accountId && accountId !== me.account.id) switchAccount.mutate(accountId, { onSuccess: () => navigate("/") });
        }}
        onItemClick={(e) => {
          if (e.detail.item.dataset.to) navigate(e.detail.item.dataset.to);
        }}
        // The account worked in first; the others are listed under "Other accounts".
        accounts={[...me.accounts].sort((a, b) => Number(b.id === me.account.id) - Number(a.id === me.account.id)).map((a) => (
          <UserMenuAccount
            key={a.id}
            data-account-id={a.id}
            titleText={a.name}
            subtitleText={me.user.email}
            description={ROLE_LABEL[a.role]}
            avatarInitials={initials(me.user.email)}
            selected={a.id === me.account.id}
          />
        ))}
      >
        {isAdmin && <UserMenuItem icon="group" text="Users and roles" data-to="/users" />}
        {me.operator && <UserMenuItem icon="action-settings" text="Operator" data-to="/operator" />}
      </UserMenu>
    </>
  );
}

/** "AB" for ab.cd@..., "A" for a@... */
const initials = (email: string) =>
  email
    .split("@")[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

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
