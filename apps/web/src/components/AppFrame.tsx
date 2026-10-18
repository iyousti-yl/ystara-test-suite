import { useRef, useState, type ReactNode } from "react";
import {
  Avatar,
  Button,
  Menu,
  MenuItem,
  MenuSeparator,
  NavigationLayout,
  ShellBar,
  ShellBarBranding,
  SideNavigation,
  SideNavigationItem,
  SideNavigationSubItem,
  Text,
  UserMenu,
  UserMenuAccount,
  type NavigationLayoutDomRef,
} from "@ui5/webcomponents-react";
import type { Me } from "@ystara/shared";
import { useLocation, useNavigate } from "react-router";
import { useSignOut, useSwitchAccount, useTenants } from "../api";
import { ROLE_LABEL } from "../roles";
import { useTenantScope } from "../tenantScope";

/**
 * The frame around every signed-in page, laid out like Datasphere (UI5's
 * NavigationLayout): a top bar with the tenant picker, and a menu of apps
 * for the picked tenant on the left, with Tenants and the admin pages at its
 * bottom. The menu button folds the menu to icons, or opens it on a phone,
 * where it closes again once an entry is picked.
 */
export function AppFrame({ me, children }: { me: Me; children: ReactNode }) {
  const layout = useRef<NavigationLayoutDomRef>(null);
  // The avatar the user menu opens from, and the button the tenant menu opens from, while open.
  const [userMenuFor, setUserMenuFor] = useState<HTMLElement>();
  const [tenantMenuFor, setTenantMenuFor] = useState<HTMLElement>();
  const toggleMenu = () => {
    const l = layout.current;
    if (l) l.mode = l.isSideCollapsed() ? "Expanded" : "Collapsed";
  };

  return (
    <>
      <NavigationLayout
        ref={layout}
        header={<TopBar me={me} onMenu={toggleMenu} onTenantMenu={setTenantMenuFor} onUserMenu={setUserMenuFor} />}
        sideContent={<AppMenu me={me} />}
      >
        <main className="app-main">{children}</main>
      </NavigationLayout>
      {/* Popovers: outside the layout, whose slots take only the bar, the menu and the page. */}
      <TenantMenu opener={tenantMenuFor} onClose={() => setTenantMenuFor(undefined)} />
      <AccountMenu me={me} opener={userMenuFor} onClose={() => setUserMenuFor(undefined)} />
    </>
  );
}

/** The apps, and which one an address belongs to: scans are Discovery's, pipelines and snapshots Pipelines'. */
type App = "home" | "discovery" | "pipelines" | "connection" | "database-users" | "tenants" | "users" | "operator";

function appOf(pathname: string): App | undefined {
  const [first, , app] = pathname.split("/").filter(Boolean);
  if (first === "tenants") return pathname === "/tenants" ? "tenants" : ((app as App | undefined) ?? "home");
  if (first === "scans") return "discovery";
  if (first === "pipelines" || first === "snapshots") return "pipelines";
  if (first === "users" || first === "operator") return first;
  return undefined;
}

/** Where an app opens for a tenant. */
const appPath = (app: App, tenantId: string) => (app === "home" ? `/tenants/${tenantId}` : `/tenants/${tenantId}/${app}`);

/** The picked tenant, if the account still has it (it may have been deleted since, or belong to another browser's pick). */
function useCurrentTenant() {
  const tenants = useTenants();
  const { tenantId } = useTenantScope();
  return { tenants, current: tenants.data?.find((t) => t.id === tenantId) };
}

/** The apps of the picked tenant, then Tenants and the admin pages. `slot`: the layout's slot name, which goes on the element it places. */
function AppMenu({ me, slot }: { me: Me; slot?: string }) {
  const navigate = useNavigate();
  const tenantId = useCurrentTenant().current?.id;
  const app = appOf(useLocation().pathname);
  const item = (to: App, text: string, icon: string) =>
    tenantId && <SideNavigationItem icon={icon} text={text} data-to={appPath(to, tenantId)} selected={app === to} />;

  return (
    <SideNavigation
      slot={slot}
      // On every click, not only a change of selection: the app's own entry leads back to its first page.
      onItemClick={(e) => {
        const to = e.detail.item.dataset.to;
        if (to) navigate(to);
      }}
      fixedItems={
        <>
          <SideNavigationItem icon="it-system" text="Tenants" data-to="/tenants" selected={app === "tenants"} />
          {me.permissions.includes("users.manage") && <SideNavigationItem icon="group" text="Users and roles" data-to="/users" selected={app === "users"} />}
          {me.operator && <SideNavigationItem icon="action-settings" text="Operator" data-to="/operator" selected={app === "operator"} />}
        </>
      }
    >
      {item("home", "Home", "home")}
      {item("discovery", "Discovery", "search")}
      {item("pipelines", "Pipelines", "process")}
      {tenantId && (
        // Opens its first entry: on a phone, a click that only unfolded it would close the menu too.
        <SideNavigationItem
          icon="connected"
          text="Connection"
          data-to={appPath("connection", tenantId)}
          expanded={app === "connection" || app === "database-users" || undefined}
        >
          <SideNavigationSubItem text="Technical client" data-to={appPath("connection", tenantId)} selected={app === "connection"} />
          <SideNavigationSubItem text="Database users" data-to={appPath("database-users", tenantId)} selected={app === "database-users"} />
        </SideNavigationItem>
      )}
    </SideNavigation>
  );
}

/** The product, the tenant picker, the account worked in, and the user menu's avatar. `slot` as for AppMenu. */
function TopBar(props: { me: Me; slot?: string; onMenu: () => void; onTenantMenu: (opener: HTMLElement) => void; onUserMenu: (opener: HTMLElement) => void }) {
  const { me, onMenu } = props;
  const navigate = useNavigate();
  return (
    <ShellBar
      slot={props.slot}
      startButton={<Button icon="menu2" design="Transparent" tooltip="Menu" accessibleName="Menu" onClick={onMenu} />}
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
      content={
        <>
          {/* Hidden first when the bar runs out of room: the account name, never the tenant picker. */}
          <TenantButton data-hide-order="10" onOpen={props.onTenantMenu} />
          <Text className="shell-account" data-hide-order="1">
            {me.account.name}
          </Text>
        </>
      }
      profile={<Avatar initials={initials(me.user.email)} accessibleName={`${me.user.email}, ${me.account.name}`} />}
      onProfileClick={(e) => props.onUserMenu(e.detail.targetRef)}
    />
  );
}

/** The accounts to switch between, and signing out. */
function AccountMenu({ me, opener, onClose }: { me: Me; opener?: HTMLElement; onClose: () => void }) {
  const navigate = useNavigate();
  const signOut = useSignOut();
  const switchAccount = useSwitchAccount();
  return (
    <UserMenu
      open={opener !== undefined}
      opener={opener}
      showOtherAccounts={me.accounts.length > 1}
      onClose={onClose}
      onSignOutClick={() =>
        signOut.mutate(undefined, {
          onSettled: () => navigate("/sign-in", { replace: true }),
        })
      }
      onChangeAccount={(e) => {
        const accountId = e.detail.selectedAccount.dataset.accountId;
        if (accountId && accountId !== me.account.id) switchAccount.mutate(accountId, { onSuccess: () => navigate("/") });
      }}
      // The account worked in first; the others are listed under "Other accounts".
      accounts={[...me.accounts]
        .sort((a, b) => Number(b.id === me.account.id) - Number(a.id === me.account.id))
        .map((a) => (
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
    />
  );
}

/** The picked tenant's name in the top bar; it opens the tenant menu. */
function TenantButton({ onOpen, ...rest }: { onOpen: (opener: HTMLElement) => void; "data-hide-order": string }) {
  const { tenants, current } = useCurrentTenant();
  return (
    <Button
      {...rest}
      className="tenant-button"
      design="Transparent"
      icon="it-system"
      endIcon="slim-arrow-down"
      tooltip="The tenant every app shows"
      onClick={(e) => e.currentTarget && onOpen(e.currentTarget)}
    >
      {current?.name ?? (tenants.data?.length === 0 ? "No tenant yet" : "Pick a tenant")}
    </Button>
  );
}

/**
 * Picking a tenant opens the same app for it; from a scan, pipeline or
 * snapshot, that app's first page. "All tenants" opens Tenants.
 */
function TenantMenu({ opener, onClose }: { opener?: HTMLElement; onClose: () => void }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { tenants, current } = useCurrentTenant();
  const { pick } = useTenantScope();

  return (
    <Menu
      open={opener !== undefined}
      opener={opener}
      headerText="Tenant"
      onClose={onClose}
      onItemClick={(e) => {
        const { tenantId: picked, to } = e.detail.item.dataset;
        if (to) navigate(to);
        if (!picked) return;
        const app = appOf(pathname);
        // The admin pages show no tenant: the pick only changes the menu. Every other page opens on the picked tenant, which picks it.
        if (app === "users" || app === "operator") pick(picked);
        else navigate(appPath(app === undefined || app === "tenants" ? "home" : app, picked));
      }}
    >
      {tenants.data?.map((t) => (
        <MenuItem key={t.id} data-tenant-id={t.id} text={t.name} icon={t.id === current?.id ? "accept" : undefined} />
      ))}
      {tenants.data?.length ? <MenuSeparator /> : null}
      <MenuItem data-to="/tenants" text="All tenants…" icon="list" />
    </Menu>
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
