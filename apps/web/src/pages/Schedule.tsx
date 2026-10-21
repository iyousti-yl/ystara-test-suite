import { Button, ComboBox, ComboBoxItem, Dialog, Input, Label, Link, MessageStrip, StepInput, Title } from "@ui5/webcomponents-react";
import {
  checkSchedule,
  DEFAULT_ROW_DROP_PERCENT,
  describeMinutes,
  describeRun,
  MIN_MINUTES_BETWEEN_RUNS,
  MIN_MINUTES_BETWEEN_SCANS,
  type ScheduleCheck,
} from "@ystara/shared";
import { useState } from "react";
import {
  useCan,
  useRemoveScanSchedule,
  useRemoveSchedule,
  useScanSchedule,
  useSchedule,
  useSetScanSchedule,
  useSetSchedule,
  type ScanScheduleJson,
  type ScheduleJson,
} from "../api";
import { ErrorStrip } from "../components/Feedback";
import { formatDateTime } from "../format";

interface Example {
  cron: string;
  label: string;
}

/** Cron lines a person can start from, for snapshots. */
const EXAMPLES: Example[] = [
  { cron: "30 7 * * 1-5", label: "Weekdays at 07:30" },
  { cron: "0 6 * * *", label: "Every day at 06:00" },
  { cron: "0 8 * * 1", label: "Mondays at 08:00" },
  { cron: "0 5 1 * *", label: "The 1st of each month at 05:00" },
  { cron: "0 * * * *", label: "Every hour" },
];

/** And for scans: at night, when nobody changes the tenant. */
const SCAN_EXAMPLES: Example[] = [
  { cron: "0 2 * * *", label: "Every night at 02:00" },
  { cron: "0 1 * * 1-5", label: "Weeknights at 01:00" },
  { cron: "0 3 * * 0", label: "Sundays at 03:00" },
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

/** The next three runs of a saved schedule, as a person reads them. */
function nextRuns(schedule: { cron: string; timeZone: string; nextRunAt: string }, minMinutes: number): string[] {
  const nextRunAt = new Date(schedule.nextRunAt);
  const after = checkSchedule(schedule.cron, schedule.timeZone, nextRunAt, 2, minMinutes);
  return [nextRunAt, ...(after.ok ? after.next : [])].map((at) => describeRun(at, schedule.timeZone));
}

/** Shown when a planned run is more than LATE_AFTER_MS late, as of `fetchedAt` (the schedule is read every minute). */
function LateStrip({ nextRunAt, fetchedAt, run }: { nextRunAt: string; fetchedAt: number; run: string }) {
  if (fetchedAt - new Date(nextRunAt).getTime() <= LATE_AFTER_MS) return null;
  return (
    <MessageStrip design="Critical" hideCloseButton className="block">
      The run planned for {run} has not started, so the worker may be stopped. It takes the missed run once it is back.
    </MessageStrip>
  );
}

function ScheduleSummary({ schedule, fetchedAt }: { schedule: ScheduleJson; fetchedAt: number }) {
  const runs = nextRuns(schedule, MIN_MINUTES_BETWEEN_RUNS);
  return (
    <>
      <p className="schedule-summary">
        <span className="mono">{schedule.cron}</span> <span className="muted">in {schedule.timeZone} time.</span> Next runs: {runs.join(", ")}.
      </p>
      <p className="muted">
        Watchers get an email when a scheduled snapshot fails, when a step&apos;s definition or columns change, or when the output goes empty or loses
        more than {schedule.rowDropPercent}% of its rows.
      </p>
      <LateStrip nextRunAt={schedule.nextRunAt} fetchedAt={fetchedAt} run={runs[0]} />
    </>
  );
}

/**
 * The cron line, its zone and the next runs it gives (or why it can't be
 * saved), for both kinds of schedule. `check` is the parent's
 * checkSchedule of the two, as of when the dialog opened.
 */
function CronFields(props: {
  id: string;
  cron: string;
  onCron: (cron: string) => void;
  timeZone: string;
  onTimeZone: (zone: string) => void;
  zones: string[];
  examples: Example[];
  minMinutes: number;
  check: ScheduleCheck;
}) {
  const { id, check } = props;
  return (
    <>
      <Label for={`${id}-cron`} required>
        Cron line
      </Label>
      <Input id={`${id}-cron`} className="mono full-width" value={props.cron} onInput={(e) => props.onCron(e.target.value)} />
      <p className="muted">
        Five fields: minute, hour, day of the month, month and weekday (0 or 7 is Sunday). <span className="mono">*</span> means every,{" "}
        <span className="mono">1-5</span> a range, <span className="mono">*/2</span> every second one. Runs are at least {describeMinutes(props.minMinutes)}{" "}
        apart.
      </p>
      <div className="schedule-examples">
        {props.examples.map((example) => (
          <Link key={example.cron} onClick={() => props.onCron(example.cron)}>
            {example.label}
          </Link>
        ))}
      </div>
      <Label for={`${id}-zone`} required>
        Time zone
      </Label>
      <ComboBox
        id={`${id}-zone`}
        className="full-width"
        filter="Contains"
        value={props.timeZone}
        onInput={(e) => props.onTimeZone(e.target.value)}
        onChange={(e) => props.onTimeZone(e.target.value)}
      >
        {props.zones.map((zone) => (
          <ComboBoxItem key={zone} text={zone} />
        ))}
      </ComboBox>
      {check.ok ? (
        <div>
          <Label>Next runs</Label>
          <ul className="schedule-runs">
            {check.next.map((at) => (
              <li key={at.toISOString()}>{describeRun(at, props.timeZone)}</li>
            ))}
          </ul>
        </div>
      ) : (
        <MessageStrip design="Negative" hideCloseButton>
          {check.error}
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
        <CronFields
          id="schedule"
          cron={cron}
          onCron={setCron}
          timeZone={timeZone}
          onTimeZone={setTimeZone}
          zones={zones}
          examples={EXAMPLES}
          minMinutes={MIN_MINUTES_BETWEEN_RUNS}
          check={check}
        />
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

/**
 * The tenant's scan schedule, on Discovery: each run scans the spaces its
 * technical client could read at its last check. When a scan changes a step
 * of a saved pipeline, that pipeline's scenarios run again, and its watchers
 * hear of any that broke. Set, Change and Remove for those who scan;
 * `whyNot`: why this tenant can't be scanned on a schedule yet.
 */
export function ScanScheduleSection({ tenantId, spaces, whyNot }: { tenantId: string; spaces: string[]; whyNot: string | undefined }) {
  const can = useCan();
  const schedule = useScanSchedule(tenantId);
  const remove = useRemoveScanSchedule(tenantId);
  const [editing, setEditing] = useState(false);
  const current = schedule.data;
  const canSet = can("discovery.run");

  return (
    <section className="block">
      <div className="list-toolbar section-toolbar">
        <Title level="H4">Scan schedule</Title>
        {canSet && (
          <Button icon="date-time" disabled={!!whyNot} tooltip={whyNot ?? "Scan the tenant on a schedule"} onClick={() => setEditing(true)}>
            {current ? "Change" : "Set schedule"}
          </Button>
        )}
        {canSet && current && (
          <Button
            design="Transparent"
            icon="delete"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm("Remove the scan schedule? Scans already made stay, and you can still scan by hand.")) remove.mutate();
            }}
          >
            Remove
          </Button>
        )}
      </div>
      <ErrorStrip error={schedule.error ?? remove.error} />
      {current ? (
        <ScanScheduleSummary schedule={current} spaces={spaces} fetchedAt={schedule.dataUpdatedAt} />
      ) : (
        schedule.isSuccess && (
          <p className="muted">
            No schedule: the tenant is only scanned by hand. A nightly scan catches changed definitions, and reruns the scenarios of each pipeline they
            change.
          </p>
        )
      )}
      {editing && <ScanScheduleDialog tenantId={tenantId} spaces={spaces} current={current ?? undefined} onClose={() => setEditing(false)} />}
    </section>
  );
}

function ScanScheduleSummary({ schedule, spaces, fetchedAt }: { schedule: ScanScheduleJson; spaces: string[]; fetchedAt: number }) {
  const runs = nextRuns(schedule, MIN_MINUTES_BETWEEN_SCANS);
  return (
    <>
      <p className="schedule-summary">
        <span className="mono">{schedule.cron}</span> <span className="muted">in {schedule.timeZone} time.</span> Next runs: {runs.join(", ")}.
      </p>
      <p className="muted">
        Each run scans {spaces.length ? <span className="mono">{spaces.join(", ")}</span> : "the spaces the technical client can read"}. When it changes
        a step of a saved pipeline, that pipeline&apos;s scenarios run again, and its watchers get an alert if one that passed before doesn&apos;t now.
        Set on {formatDateTime(schedule.updatedAt)}.
      </p>
      <LateStrip nextRunAt={schedule.nextRunAt} fetchedAt={fetchedAt} run={runs[0]} />
    </>
  );
}

function ScanScheduleDialog({ tenantId, spaces, current, onClose }: { tenantId: string; spaces: string[]; current: ScanScheduleJson | undefined; onClose: () => void }) {
  const save = useSetScanSchedule(tenantId);
  const [zones] = useState(timeZones);
  const [openedAt] = useState(() => new Date());
  const [cron, setCron] = useState(current?.cron ?? SCAN_EXAMPLES[0].cron);
  const [timeZone, setTimeZone] = useState(current?.timeZone ?? zones[0]);
  const check = checkSchedule(cron, timeZone, openedAt, 5, MIN_MINUTES_BETWEEN_SCANS);
  const submit = () => save.mutate({ cron, timeZone }, { onSuccess: onClose });

  return (
    <Dialog
      open
      headerText={current ? "Change scan schedule" : "Set scan schedule"}
      onClose={onClose}
      footer={
        <div className="dialog-footer">
          <Button design="Emphasized" onClick={submit} disabled={!check.ok || save.isPending}>
            Save
          </Button>
          <Button design="Transparent" onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="dialog-body">
        <CronFields
          id="scan-schedule"
          cron={cron}
          onCron={setCron}
          timeZone={timeZone}
          onTimeZone={setTimeZone}
          zones={zones}
          examples={SCAN_EXAMPLES}
          minMinutes={MIN_MINUTES_BETWEEN_SCANS}
          check={check}
        />
        <MessageStrip design="Information" hideCloseButton>
          Read-only, as Scan spaces: each run lists and reads the object definitions of {spaces.length ? spaces.join(", ") : "the spaces the technical client can read"}, through the
          technical client. After a scan that changes a saved pipeline, its scenarios run on their test rows only.
        </MessageStrip>
        <ErrorStrip error={save.error} />
      </div>
    </Dialog>
  );
}
