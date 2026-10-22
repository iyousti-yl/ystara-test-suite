import { useState } from "react";
import {
  Button,
  DatePicker,
  Label,
  Option,
  Select,
  Table,
  TableCell,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
} from "@ui5/webcomponents-react";
import { AUDIT_GROUPS, type AuditGroup } from "@ystara/shared";
import { Link } from "react-router";
import { auditQuery, useAuditLog, useAuditUsers, useCan, useMe, type AuditEventJson, type AuditFilters } from "../api";
import { ErrorStrip } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../format";
import { ROLE_LABEL } from "../roles";
import { kindLabel } from "../scenario/model";

/**
 * The account's audit log (/audit), for admins: every change anyone made in
 * the account and every sign-in, newest first, with who, what, on what, when
 * and from where. Filters by person, kind and days; the same list downloads
 * as CSV. Nothing in it can be changed or deleted.
 */
const GROUPS = AUDIT_GROUPS.filter((g) => g !== "Operator");

export function AuditPage() {
  const can = useCan();
  const me = useMe().data!;
  const allowed = can("audit.read");
  const [filters, setFilters] = useState<AuditFilters>({});
  const log = useAuditLog(filters, allowed);
  const users = useAuditUsers(allowed);
  const events = log.data?.pages.flatMap((p) => p.events) ?? [];
  const set = (change: Partial<AuditFilters>) => setFilters((f) => ({ ...f, ...change }));

  if (!allowed) {
    return (
      <div className="page">
        <ErrorStrip error={new Error("Only admins can read the audit log.")} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Audit log"
        subtitle={`Who changed what in ${me.account.name}, and when, sign-ins included. Nobody can change or delete an entry.`}
        actions={
          <Button design="Emphasized" icon="download" disabled={!events.length} onClick={() => window.location.assign(`/api/audit.csv${auditQuery(filters)}`)}>
            Download CSV
          </Button>
        }
      />
      <div className="filter-row block" role="search">
        <div className="filter">
          <Label for="audit-user">Who</Label>
          <Select id="audit-user" value={filters.user ?? ""} onChange={(e) => set({ user: e.detail.selectedOption.value || undefined })}>
            <Option value="">Everyone</Option>
            {users.data?.map((u) => (
              <Option key={u} value={u}>
                {u}
              </Option>
            ))}
          </Select>
        </div>
        <div className="filter">
          <Label for="audit-group">What</Label>
          <Select id="audit-group" value={filters.group ?? ""} onChange={(e) => set({ group: (e.detail.selectedOption.value || undefined) as AuditGroup | undefined })}>
            <Option value="">Everything</Option>
            {GROUPS.map((g) => (
              <Option key={g} value={g}>
                {g}
              </Option>
            ))}
          </Select>
        </div>
        <div className="filter">
          <Label for="audit-from">From</Label>
          <DatePicker id="audit-from" valueFormat="yyyy-MM-dd" value={filters.from ?? ""} maxDate={filters.to} onChange={(e) => set({ from: e.detail.valid && e.detail.value ? e.detail.value : undefined })} />
        </div>
        <div className="filter">
          <Label for="audit-to">To</Label>
          <DatePicker id="audit-to" valueFormat="yyyy-MM-dd" value={filters.to ?? ""} minDate={filters.from} onChange={(e) => set({ to: e.detail.valid && e.detail.value ? e.detail.value : undefined })} />
        </div>
        {(filters.user || filters.group || filters.from || filters.to) && (
          <Button design="Transparent" onClick={() => setFilters({})}>
            Clear filters
          </Button>
        )}
      </div>
      <ErrorStrip error={log.error ?? users.error} />
      <section className={log.isFetching && !log.isFetchingNextPage && log.data ? "block is-refreshing" : "block"}>
        <Table
          loading={log.isPending}
          noDataText={filters.user || filters.group || filters.from || filters.to ? "Nothing matches these filters." : "Nothing has been logged yet."}
          overflowMode="Popin"
          headerRow={
            <TableHeaderRow>
              <TableHeaderCell minWidth="11rem" importance={1}>
                When
              </TableHeaderCell>
              <TableHeaderCell minWidth="12rem" importance={1}>
                Who
              </TableHeaderCell>
              <TableHeaderCell minWidth="16rem" importance={1}>
                What
              </TableHeaderCell>
              <TableHeaderCell minWidth="14rem">Details</TableHeaderCell>
              <TableHeaderCell minWidth="7rem">IP address</TableHeaderCell>
            </TableHeaderRow>
          }
        >
          {events.map((e) => (
            <TableRow key={e.id} rowKey={e.id}>
              <TableCell>{formatDateTime(e.at)}</TableCell>
              <TableCell className="wrap-anywhere">{e.userEmail ?? <span className="muted">A user since deleted</span>}</TableCell>
              <TableCell>
                <div>{e.label}</div>
                <Target event={e} />
              </TableCell>
              <TableCell className="wrap-anywhere">{details(e.detail)}</TableCell>
              <TableCell className="mono">{e.ip ?? "–"}</TableCell>
            </TableRow>
          ))}
        </Table>
        {log.hasNextPage && (
          <div className="load-more">
            <Button disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
              {log.isFetchingNextPage ? "Loading…" : "Show older entries"}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

/** What the event acted on, linked when it has a page of its own (it may have been deleted since). */
function Target({ event }: { event: AuditEventJson }) {
  const t = event.target;
  if (!t?.name) return null;
  const to = t.kind === "tenant" ? `/tenants/${t.id}` : t.kind === "pipeline" ? `/pipelines/${t.id}` : t.kind === "scenario" ? `/scenarios/${t.id}` : undefined;
  return <div className="muted wrap-anywhere">{to ? <Link to={to}>{t.name}</Link> : t.name}</div>;
}

const FIELD: Record<string, string> = {
  name: "name",
  email: "email",
  adminEmail: "admin",
  role: "role",
  spaces: "spaces",
  space: "space",
  host: "host",
  user: "user",
  clientId: "client ID",
  tokenUrl: "token URL",
  output: "output",
  excludeWriters: "ignored loaders",
  cron: "schedule",
  timeZone: "time zone",
  rowDropPercent: "alert on a row drop of (%)",
  kind: "kind",
  verdict: "verdict",
  comment: "comment",
};

const ORDER = Object.keys(FIELD);
const place = (key: string) => (ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length);

/** "role: viewer · spaces: SALES, STOCK": the fields kept with the event, in FIELD's order (a verdict before its comment). */
export function details(detail: Record<string, unknown> | null): string {
  if (!detail) return "";
  return Object.entries(detail)
    .sort(([a], [b]) => place(a) - place(b))
    .map(([key, value]) => {
      const text =
        value === null
          ? key === "spaces"
            ? "every space"
            : "none"
          : Array.isArray(value)
            ? value.join(", ") || "none"
            : typeof value === "object"
              ? JSON.stringify(value)
              : key === "role" && String(value) in ROLE_LABEL
                ? ROLE_LABEL[value as keyof typeof ROLE_LABEL]
                : key === "kind"
                  ? kindLabel(String(value))
                  : String(value);
      return `${FIELD[key] ?? key}: ${text}`;
    })
    .join(" · ");
}
