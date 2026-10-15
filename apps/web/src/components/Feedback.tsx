import { BusyIndicator, MessageStrip, Tag } from "@ui5/webcomponents-react";
import type { ScanJson } from "../api";

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
