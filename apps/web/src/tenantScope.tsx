import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { useTenant } from "./api";

/**
 * The tenant the apps show, one at a time, as picked in the top bar. Pages
 * under /tenants/:tenantId take it from their address; scans, pipelines and
 * snapshots set it to their own tenant (useInTenant). Remembered in this
 * browser per account, so "/" opens it again. Nothing else depends on it:
 * every page still loads its own data by ID.
 */
interface TenantScope {
  tenantId?: string;
  pick: (tenantId: string) => void;
}

const Scope = createContext<TenantScope>({ pick: () => undefined });

export function TenantScopeProvider({ accountId, children }: { accountId: string; children: ReactNode }) {
  const key = `ystara.tenant.${accountId}`;
  const [tenantId, setTenantId] = useState(() => remembered(key));
  const pick = useCallback(
    (id: string) => {
      setTenantId(id);
      remember(key, id);
    },
    [key],
  );
  const value = useMemo(() => ({ tenantId, pick }), [tenantId, pick]);
  return <Scope.Provider value={value}>{children}</Scope.Provider>;
}

export const useTenantScope = () => useContext(Scope);

/** Shows `tenantId` in the top bar and the menu while this page is open (once it is known). */
export function useInTenant(tenantId: string | undefined) {
  const { tenantId: current, pick } = useTenantScope();
  useEffect(() => {
    if (tenantId && tenantId !== current) pick(tenantId);
  }, [tenantId, current, pick]);
}

/** The tenant of a page under /tenants/:tenantId, picked for the top bar once it has loaded. */
export function useAddressTenant() {
  const { tenantId = "" } = useParams();
  const tenant = useTenant(tenantId);
  useInTenant(tenant.data?.id);
  return { tenantId, tenant };
}

// Browser storage can be missing or refuse (private windows, blocked site data): then nothing is remembered.
function remembered(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; the pick still holds until the page is reloaded.
  }
}
