import { Button, ComboBox, ComboBoxItem, Dialog, Input, Label, Link, MessageStrip, StepInput, Title } from "@ui5/webcomponents-react";
import { checkSchedule, DEFAULT_ROW_DROP_PERCENT, describeRun, MIN_MINUTES_BETWEEN_RUNS } from "@ystara/shared";
import { useState } from "react";
import { useCan, useRemoveSchedule, useSchedule, useSetSchedule, type ScheduleJson } from "../api";
import { ErrorStrip } from "../components/Feedback";

/** Cron lines a person can start from. */
const EXAMPLES = [
  { cron: "30 7 * * 1-5", label: "Weekdays at 07:30" },
  { cron: "0 6 * * *", label: "Every day at 06:00" },
  { cron: "0 8 * * 1", label: "Mondays at 08:00" },
  { cron: "0 5 1 * *", label: "The 1st of each month at 05:00" },
  { cron: "0 * * * *", label: "Every hour" },
];

/** The browser's own zone first, then every zone the browser knows. */
function timeZones(): string[] {
  const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [...new Set([own, ...all, "UTC"])];
}

/** A run more than this late means no worker is taking the schedules. */
const LATE_AFTER_MS = 5 * 60 * 1000;

/**
 * A saved pipeline's schedule on its Snapshots tab: the cron line, its zone,
 * the next runs and when watchers get an alert (the row drop that alerts is
 * set with the schedule), with Set, Change and Remove for those who take
 * snapshots. `whyNot`: why no snapshot can be taken yet, which also stops a schedule.
 */
export function ScheduleSection({ pipelineId, whyNot }: { pipelineId: string; whyNot: string | undefined }) {
  const can = useCan();
  const schedule = useSchedule(pipelineId);
  const remove = useRemoveSchedule(pipelineId);
  const [editing, setEditing] = useState(false);
  const current = schedule.data;
  const canSet = can("runs.execute");

  return (
    <section className="block">
      <div className="list-toolbar section-toolbar">
        <Title level="H4">Schedule</Title>
        {canSet && (
          <Button icon="date-time" disabled={!!whyNot} tooltip={whyNot ?? "Take snapshots on a schedule"} onClick={() => setEditing(true)}>
            {current ? "Change" : "Set schedule"}
          </Button>
        )}
        {canSet && current && (
          <Button
            design="Transparent"
            icon="delete"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm("Remove the schedule? Snapshots already taken stay, and you can still take one by hand.")) remove.mutate();
            }}
          >
            Remove
          </Button>
        )}
      </div>
      <ErrorStrip error={schedule.error ?? remove.error} />
      {current ? <ScheduleSummary schedule={current} fetchedAt={schedule.dataUpdatedAt} /> : schedule.isSuccess && <p className="muted">No schedule: snapshots are only taken by hand.</p>}
      {editing && <ScheduleDialog pipelineId={pipelineId} current={current ?? undefined} onClose={() => setEditing(false)} />}
    </section>
  );
}

/** `fetchedAt`: when the schedule was read, which is every minute while the page is open. */
function ScheduleSummary({ schedule, fetchedAt }: { schedule: ScheduleJson; fetchedAt: number }) {
  const nextRunAt = new Date(schedule.nextRunAt);
  const after = checkSchedule(schedule.cron, schedule.timeZone, nextRunAt, 2);
  const runs = [nextRunAt, ...(after.ok ? after.next : [])].map((at) => describeRun(at, schedule.timeZone));
  const late = fetchedAt - nextRunAt.getTime() > LATE_AFTER_MS;
  return (
    <>
      <p className="schedule-summary">
        <span className="mono">{schedule.cron}</span> <span className="muted">in {schedule.timeZone} time.</span> Next runs: {runs.join(", ")}.
      </p>
      <p className="muted">
        Watchers get an email when a scheduled snapshot fails, when a step&apos;s definition or columns change, or when the output goes empty or loses
        more than {schedule.rowDropPercent}% of its rows.
      </p>
      {late && (
        <MessageStrip design="Critical" hideCloseButton className="block">
          The run planned for {runs[0]} has not started, so the worker may be stopped. It takes the missed run once it is back.
        </MessageStrip>
      )}
    </>
  );
}

function ScheduleDialog({ pipelineId, current, onClose }: { pipelineId: string; current: ScheduleJson | undefined; onClose: () => void }) {
  const save = useSetSchedule(pipelineId);
  const [zones] = useState(timeZones);
  const [openedAt] = useState(() => new Date());
  const [cron, setCron] = useState(current?.cron ?? EXAMPLES[0].cron);
  const [timeZone, setTimeZone] = useState(current?.timeZone ?? zones[0]);
  const [rowDropPercent, setRowDropPercent] = useState(current?.rowDropPercent ?? DEFAULT_ROW_DROP_PERCENT);
  const check = checkSchedule(cron, timeZone, openedAt);
  const dropOk = Number.isInteger(rowDropPercent) && rowDropPercent >= 1 && rowDropPercent <= 100;
  const submit = () => save.mutate({ cron, timeZone, rowDropPercent }, { onSuccess: onClose });

  return (
    <Dialog
      open
      headerText={current ? "Change schedule" : "Set schedule"}
      onClose={onClose}
      footer={
        <div className="dialog-footer">
          <Button design="Emphasized" onClick={submit} disabled={!check.ok || !dropOk || save.isPending}>
            Save
          </Button>
          <Button design="Transparent" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        <Label for="schedule-cron" required>
          Cron line
        </Label>
        <Input id="schedule-cron" className="mono full-width" value={cron} onInput={(e) => setCron(e.target.value)} />
        <p className="muted">
          Five fields: minute, hour, day of the month, month and weekday (0 or 7 is Sunday). <span className="mono">*</span> means every,{" "}
          <span className="mono">1-5</span> a range, <span className="mono">*/2</span> every second one. Runs are at least {MIN_MINUTES_BETWEEN_RUNS} minutes
          apart.
        </p>
        <div className="schedule-examples">
          {EXAMPLES.map((example) => (
            <Link key={example.cron} onClick={() => setCron(example.cron)}>
              {example.label}
            </Link>
          ))}
        </div>
        <Label for="schedule-zone" required>
          Time zone
        </Label>
        <ComboBox
          id="schedule-zone"
          className="full-width"
          filter="Contains"
          value={timeZone}
          onInput={(e) => setTimeZone(e.target.value)}
          onChange={(e) => setTimeZone(e.target.value)}
        >
          {zones.map((zone) => (
            <ComboBoxItem key={zone} text={zone} />
          ))}
        </ComboBox>
        {check.ok ? (
          <div>
            <Label>Next runs</Label>
            <ul className="schedule-runs">
              {check.next.map((at) => (
                <li key={at.toISOString()}>{describeRun(at, timeZone)}</li>
              ))}
            </ul>
          </div>
        ) : (
          <MessageStrip design="Negative" hideCloseButton>
            {check.error}
          </MessageStrip>
        )}
        <Label for="schedule-drop" required>
          Alert when the output loses more than (%)
        </Label>
        <StepInput id="schedule-drop" min={1} max={100} value={rowDropPercent} onChange={(e) => setRowDropPercent(e.target.value)} />
        <p className="muted">
          Each run measures the steps the database users can see, as Take snapshot does, and is compared with the snapshot before it. The
          pipeline&apos;s watchers get an email when it fails, when a step&apos;s definition or columns change, or when the output goes empty or loses
          more than this share of its rows.
        </p>
        <ErrorStrip error={save.error} />
      </div>
    </Dialog>
  );
}
