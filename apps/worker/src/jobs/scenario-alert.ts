import {
  getPipeline,
  getScan,
  getScanSchedule,
  getScenarioSuite,
  getTenant,
  saveScenarioAlert,
  saveScenarioAlertTeams,
  statusesBeforeSuite,
  suiteRunResults,
  watcherEmails,
  type Db,
} from "@ystara/db";
import {
  brokenScenarios,
  describeBrokenScenario,
  describeRun,
  scenarioAlertSubject,
  type BrokenScenario,
  type ChangedStep,
  type ScenarioAlert,
  type TeamsMessage,
} from "@ystara/shared";
import { deliverAlert, type AlertDelivery, type AlertMail } from "./deliver.js";

/**
 * The alert job after a suite a scan queued: finds the scenarios that broke
 * (brokenScenarios in @ystara/shared: they passed their run before, or never
 * ran, and don't pass now) and, when there are any, records the alert, emails
 * the pipeline's watchers and posts it in the account's Teams channel
 * (deliverAlert). A suite started by hand raises none. Runs again safely, as
 * runSnapshotAlert does.
 */
export async function runScenarioAlert(db: Db, suiteId: string, opts: AlertDelivery): Promise<ScenarioAlert | undefined> {
  const suite = await getScenarioSuite(db, suiteId);
  if (!suite || suite.cause !== "scan" || suite.status === "queued" || suite.status === "running") return undefined;
  const emailSettled = !!suite.alert && ["sent", "no_watchers", "no_mail_server"].includes(suite.alert.status);
  const teamsSent = suite.alert?.teams?.status === "sent";
  if (emailSettled && teamsSent) return suite.alert ?? undefined;
  const pipeline = await getPipeline(db, suite.pipelineId);
  const tenant = pipeline && (await getTenant(db, pipeline.tenantId));
  if (!pipeline || !tenant) return undefined;

  const broken = suite.alert?.broken ?? brokenScenarios(await suiteRunResults(db, suiteId), await statusesBeforeSuite(db, suiteId));
  if (!broken.length) return undefined;

  const scan = suite.scanId ? await getScan(db, suite.scanId) : undefined;
  const timeZone = (await getScanSchedule(db, tenant.id))?.timeZone ?? "UTC";
  const content: ScenarioAlertContent = {
    suiteId,
    pipeline: { id: pipeline.id, name: pipeline.name },
    tenantName: tenant.name,
    scannedAt: scan?.finishedAt ?? suite.requestedAt,
    timeZone,
    changed: suite.changed,
    broken,
    appUrl: opts.appUrl,
  };
  await deliverAlert(
    {
      accountId: tenant.accountId,
      emailSettled,
      teamsSent,
      recipients: () => watcherEmails(db, pipeline.id),
      mail: () => scenarioAlertEmail(content),
      teamsMessage: () => scenarioAlertTeamsMessage(content),
      save: (status, extra) => saveScenarioAlert(db, suiteId, { broken, status, ...extra }),
      saveTeams: (delivery) => saveScenarioAlertTeams(db, suiteId, delivery),
    },
    opts,
  );
  return (await getScenarioSuite(db, suiteId))?.alert ?? undefined;
}

interface ScenarioAlertContent {
  suiteId: string;
  pipeline: { id: string; name: string };
  tenantName: string;
  scannedAt: Date;
  /** The tenant's scan schedule's, for the time; UTC without one. */
  timeZone: string;
  changed: ChangedStep[];
  broken: BrokenScenario[];
  appUrl: string;
}

const CHANGE: Record<ChangedStep["change"], string> = { definition: "definition changed", added: "new in the pipeline", removed: "no longer in the pipeline" };

/** The changed steps as one line: at most 8 names, then how many more. */
function changedLine(changed: ChangedStep[]): string {
  const shown = changed.slice(0, 8).map((s) => `${s.technicalName} (${CHANGE[s.change]})`);
  return shown.join(", ") + (changed.length > shown.length ? `, and ${changed.length - shown.length} more` : "");
}

/** The email's subject and text: step and scenario names and check labels, never a value read from the tenant. */
export function scenarioAlertEmail(input: ScenarioAlertContent): Omit<AlertMail, "bcc"> {
  const app = input.appUrl.replace(/\/+$/, "");
  const lines = [
    `The scan of the tenant "${input.tenantName}" of ${describeRun(input.scannedAt, input.timeZone)} (${input.timeZone} time) changed the pipeline "${input.pipeline.name}": ${changedLine(input.changed)}.`,
    "",
    `Its scenarios ran again, and ${input.broken.length === 1 ? "one that passed before doesn't now" : `${input.broken.length} that passed before don't now`}:`,
    "",
    ...input.broken.map((b) => `- ${describeBrokenScenario(b)}`),
    "",
    "What each scenario's checks gave back:",
    `${app}/scenario-suites/${input.suiteId}`,
    "",
    `You get this email because you watch this pipeline in Ystara. To stop, click Unwatch on its page: ${app}/pipelines/${input.pipeline.id}/snapshots`,
  ];
  return { subject: scenarioAlertSubject(input.pipeline.name, input.broken), text: lines.join("\n") };
}

export function scenarioAlertTeamsMessage(input: ScenarioAlertContent): TeamsMessage {
  const app = input.appUrl.replace(/\/+$/, "");
  return {
    title: scenarioAlertSubject(input.pipeline.name, input.broken).replace(/^\[Ystara\] /, ""),
    subtitle: `Tenant ${input.tenantName} · after the scan of ${describeRun(input.scannedAt, input.timeZone)} (${input.timeZone})`,
    lines: [`Changed: ${changedLine(input.changed)}.`, ...input.broken.map(describeBrokenScenario)],
    link: { title: "Open the results", url: `${app}/scenario-suites/${input.suiteId}` },
  };
}
