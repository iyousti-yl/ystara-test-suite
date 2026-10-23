import { BusyIndicator, Button, MessageStrip, Tag } from "@ui5/webcomponents-react";
import { HEALTH_LABEL, type HealthState } from "@ystara/shared";
import type { ConnectionJson, ScanJson } from "../api";
import { SignInEnded } from "../errors";
import { formatDateTime, formatRelative } from "../format";

/** A failed request, in the API's own words. Not a sign-in that ended: "Your sign-in ended" (SignInAgain) says that over the page. */
export function ErrorStrip({ error }: { error: Error | null | undefined }) {
  if (!error || error instanceof SignInEnded) return null;
  return (
    <MessageStrip design="Negative" hideCloseButton className="block">
      {error.message}
    </MessageStrip>
  );
}

export function Loading({ text = "Loading…" }: { text?: string }) {
  return <BusyIndicator active text={text} className="block" />;
}

/** Under a list that comes a page at a time (useOlderPages in api.ts): the next older page, while there may be one. */
export function ShowOlder({ list, what }: { list: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown }; what: string }) {
  if (!list.hasNextPage) return null;
  return (
    <div className="load-more">
      <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
        {list.isFetchingNextPage ? "Loading…" : `Show older ${what}`}
      </Button>
    </div>
  );
}

const SCAN_STATUS = {
  queued: { design: "Information", label: "Queued" },
  running: { design: "Information", label: "Running" },
  succeeded: { design: "Positive", label: "Succeeded" },
  failed: { design: "Negative", label: "Failed" },
} as const;

export function ScanStatusTag({ status }: { status: ScanJson["status"] }) {
  const s = SCAN_STATUS[status];
  return <Tag design={s.design}>{s.label}</Tag>;
}

const CONNECTION_STATUS = {
  checking: { design: "Information", label: "Checking" },
  connected: { design: "Positive", label: "Connected" },
  failed: { design: "Negative", label: "Not connected" },
} as const;

export function ConnectionStatusTag({ status }: { status: ConnectionJson["status"] }) {
  const s = CONNECTION_STATUS[status];
  return <Tag design={s.design}>{s.label}</Tag>;
}

/** A pipeline's health: ruby when it fails, amber when its data changed, sapphire when it is fine. */
const HEALTH_DESIGN = {
  failing: "Negative",
  changed: "Critical",
  empty: "Critical",
  untested: "Neutral",
  running: "Information",
  ok: "Positive",
} as const;

export function HealthTag({ state }: { state: HealthState }) {
  return <Tag design={HEALTH_DESIGN[state]}>{HEALTH_LABEL[state]}</Tag>;
}

/** "3 hours ago" in a list, with the exact date and time on hover; a dash for none. */
export function When({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <>–</>;
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {formatRelative(iso)}
    </time>
  );
}
