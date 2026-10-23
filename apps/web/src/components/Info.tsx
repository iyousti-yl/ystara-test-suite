import { useId, useState, type ReactNode } from "react";
import { Button, Icon, Popover } from "@ui5/webcomponents-react";

/**
 * A small (i) beside a heading or a name that opens the longer explanation in
 * a popover, so a page says one short line and keeps the rest a click away.
 * `label` names what it explains, for screen readers and the tooltip
 * ("About test rows").
 */
export function InfoButton({ label, children }: { label: string; children: ReactNode }) {
  const [opener, setOpener] = useState<HTMLElement>();
  return (
    <>
      <Button
        className="info-button"
        design="Transparent"
        icon="information"
        tooltip={label}
        accessibleName={label}
        onClick={(e) => setOpener(opener ? undefined : (e.currentTarget ?? undefined))}
      />
      <Popover className="info-popover" open={opener !== undefined} opener={opener} placement="Bottom" accessibleName={label} onClose={() => setOpener(undefined)}>
        <div className="info-text">{children}</div>
      </Popover>
    </>
  );
}

/**
 * Findings to look at (tables several flows load, objects a scan couldn't
 * read) as one line with a count and Review, which opens the list: a real
 * tenant can have dozens, and a banner each would bury the page.
 */
export function ToCheck({ label, summary, children }: { label: string; summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="checks" aria-label={label}>
      <div className="checks-head">
        <Icon name="message-warning" className="checks-icon" />
        <span>{summary}</span>
        <Button design="Transparent" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Hide" : "Review"}
        </Button>
      </div>
      {open && <div className="checks-body">{children}</div>}
    </section>
  );
}

/**
 * A state in one quiet line with a small mark, instead of a banner: "ok" for
 * a normal state (it compiles), "warn" for something to look at, "error" for
 * a failure among several items of a list (each would otherwise get a red
 * banner), "info" for a fact (no snapshot can be taken here). `more` puts the longer reason
 * behind an (i) at the end, named by `moreLabel`.
 */
export function QuietNote(props: { tone?: "ok" | "warn" | "error" | "info"; children: ReactNode; more?: ReactNode; moreLabel?: string; className?: string }) {
  const tone = props.tone ?? "info";
  return (
    <p className={`quiet-state${tone === "warn" || tone === "error" ? "" : " muted"}${props.className ? ` ${props.className}` : ""}`}>
      {/* A fact with an (i) already has its mark at the end. */}
      {!(tone === "info" && props.more) && <Icon name={QUIET_ICONS[tone]} className={`quiet-state-${tone}`} />}
      <span>{props.children}</span>
      {props.more && <InfoButton label={props.moreLabel ?? "More about this"}>{props.more}</InfoButton>}
    </p>
  );
}

const QUIET_ICONS = { ok: "sys-enter-2", warn: "message-warning", error: "error", info: "information" } as const;

/**
 * A row that folds its content away: a chevron, a title and a quiet summary
 * on the right. Long lists (a scenario's input tables, what a pipeline should
 * be checked for) start folded, so a page shows each item in one line.
 */
export function Fold(props: { title: ReactNode; summary?: ReactNode; open: boolean; onToggle: (open: boolean) => void; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={`fold${props.open ? " is-open" : ""}${props.className ? ` ${props.className}` : ""}`}>
      <button type="button" className="fold-head" aria-expanded={props.open} aria-controls={id} onClick={() => props.onToggle(!props.open)}>
        <Icon name="slim-arrow-right" className="fold-chevron" />
        <span className="fold-title">{props.title}</span>
        {props.summary !== undefined && <span className="fold-summary">{props.summary}</span>}
      </button>
      {props.open && (
        <div className="fold-body" id={id}>
          {props.children}
        </div>
      )}
    </div>
  );
}
