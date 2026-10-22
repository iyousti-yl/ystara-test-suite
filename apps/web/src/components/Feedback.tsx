import { BusyIndicator, MessageStrip, Tag } from "@ui5/webcomponents-react";
import { HEALTH_LABEL, type HealthState } from "@ystara/shared";
import type { ConnectionJson, ScanJson } from "../api";
import { formatDateTime, formatRelative } from "../format";

/** A failed request, in the API's own words. */
export function ErrorStrip({ error }: { error: Error | null | undefined }) {
  if (!error) return null;
  return (
    <MessageStrip design="Negative" hideCloseButton className="block">
      {error.message}
    </MessageStrip>
  );
}

export function Loading({ text = "Loading…" }: { text?: string }) {
  return <BusyIndicator active text={text} className="block" />;
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
