import type { RawObject } from "@ystara/connector";

/**
 * A second, busier process in the demo's space, the size a real one reaches:
 * sixteen tables loaded from a source system by data flows Ystara can't run
 * (the scenario builder's input tables, one of them 150 columns wide), tables
 * loaded by several flows, and two loops (a flow that reads the table it loads
 * back through a view, and a merge that reads its own history). Its pipeline has no snapshot and no
 * scenario yet. Every name is made up; the page that shows this pipeline is
 * the one to check for crowding (`npm run check:browser`).
 *
 *   DF_DEMO_INV_<SOURCE> ==> LT_DEMO_INV_<SOURCE>                     (16 sources)
 *   TF_DEMO_INV_STAGE_FROM_<...> (3 flows) ==> LT_DEMO_INV_STAGING
 *   TF_DEMO_INV_HISTORY_FROM_<...> (2 flows) ==> LT_DEMO_INV_HISTORY  <- reads LT_DEMO_INV_CURRENT
 *   TF_DEMO_INV_MERGE_<...> (2 flows) ==> LT_DEMO_INV_CURRENT         <- reads LT_DEMO_INV_HISTORY (a loop)
 *   TF_DEMO_INV_RATE_<...> (2 flows) ==> LT_DEMO_INV_RATED_LINES      <- one reads it back through a view (a loop)
 *   V_DEMO_INV_CARRIER_COST_BY_LANE_AND_MONTH_OUTPUT
 */
export const BUSY_SPACE = "DEMO";
export const BUSY_OUTPUT = "V_DEMO_INV_CARRIER_COST_BY_LANE_AND_MONTH_OUTPUT";
export const BUSY_PIPELINE_NAME = "Carrier invoice costs (demo)";

type Column = [name: string, type: Record<string, unknown>];
const text = (length = 40) => ({ type: "cds.String", length });
const amount = { type: "cds.Decimal", precision: 15, scale: 2 };
const id = { type: "cds.Integer64" };
const when = { type: "cds.Timestamp" };
const day = { type: "cds.Date" };
const flag = { type: "cds.Boolean" };

/** The source's tables, each with its key first: what the pipeline reads, then the columns it doesn't. */
const SOURCES: Record<string, Column[]> = {
  INVOICE_HEADER: [["invoiceId", id], ["carrierId", id], ["contractId", id], ["invoiceDate", day], ["currencyCode", text(3)], ["invoiceStatus", text(20)], ["lastModifiedDateTime", when], ["createdBy", text(60)], ["paymentTermsCode", text(10)], ["externalReference", text(100)]],
  INVOICE_LINE: [["invoiceId", id], ["invoiceLineId", id], ["chargeCode", text(20)], ["quantity", amount], ["lineAmount", amount], ["laneId", id], ...Array.from({ length: 144 }, (_, i): Column => [`lineAttribute${String(i + 1).padStart(3, "0")}`, text(60)])],
  CARRIER: [["carrierId", id], ["carrierName", text(120)], ["carrierGroup", text(40)], ["isActive", flag], ["countryCode", text(2)], ["vatNumber", text(30)]],
  CONTRACT: [["contractId", id], ["carrierId", id], ["validFrom", day], ["validTo", day], ["contractType", text(20)]],
  RATE_CARD: [["rateCardId", id], ["laneId", id], ["chargeCode", text(20)], ["unitRate", amount], ["validFrom", day], ["validTo", day], ["rateBasis", text(20)]],
  SURCHARGE: [["surchargeId", id], ["chargeCode", text(20)], ["surchargePercent", amount], ["validFrom", day]],
  CURRENCY_RATE: [["currencyCode", text(3)], ["rateDate", day], ["rateToEuro", amount]],
  COST_CENTER: [["costCenterId", text(10)], ["costCenterName", text(80)], ["companyCode", text(4)], ["validFrom", day], ["validTo", day]],
  ROUTE: [["routeId", id], ["routeName", text(80)], ["originDepotId", id], ["destinationDepotId", id]],
  LANE: [["laneId", id], ["routeId", id], ["laneName", text(80)], ["costCenterId", text(10)], ["distanceKm", amount]],
  DEPOT: [["depotId", id], ["depotName", text(80)], ["regionCode", text(10)]],
  VEHICLE: [["vehicleId", id], ["vehicleClass", text(20)], ["payloadKg", amount], ["isRefrigerated", flag]],
  DRIVER: [["driverId", id], ["carrierId", id], ["licenceClass", text(10)], ["hiringNotCompleted", flag]],
  FUEL_INDEX: [["indexMonth", day], ["fuelIndexPercent", amount]],
  TAX_CODE: [["taxCode", text(10)], ["taxPercent", amount], ["countryCode", text(2)]],
  DISPUTE: [["disputeId", id], ["invoiceId", id], ["disputedAmount", amount], ["disputeStatus", text(20)], ["openedAt", when], ["closedAt", when]],
};

const table = (name: string, columns: Column[]): RawObject => ({
  space: BUSY_SPACE,
  kind: "local-tables",
  technicalName: name,
  definition: { definitions: { [name]: { kind: "entity", elements: Object.fromEntries(columns.map(([col, type], i) => [col, { ...type, key: i === 0 }])) } } },
});

const loadFlow = (source: string): RawObject => {
  const name = `DF_DEMO_INV_${source}`;
  return {
    space: BUSY_SPACE,
    kind: "data-flows",
    technicalName: name,
    definition: {
      dataflows: {
        [name]: {
          kind: "sap.dis.dataflow",
          contents: {
            processes: {
              consumer1: { component: "com.sap.application.consumer.v2", metadata: { config: { connectionName: "DEMO_SOURCE_SYSTEM", remoteObjectReference: { name: source } } } },
              producer1: { component: "com.sap.database.table.producer", metadata: { config: { dwcEntity: `LT_DEMO_INV_${source}`, mode: "append" } } },
            },
          },
          targets: { [`LT_DEMO_INV_${source}`]: { kind: "entity" } },
        },
      },
    },
  };
};

const transform = (name: string, target: string, sql: string): RawObject => ({
  space: BUSY_SPACE,
  kind: "transformation-flows",
  technicalName: name,
  definition: {
    transformationflows: {
      [name]: {
        kind: "sap.dwc.transformationflow",
        contents: {
          processes: {
            sql1: { component: "com.sap.dwc.sqlscript", metadata: { config: { definition: sql } } },
            target: { component: "com.sap.dwc.target", metadata: { config: { name: target, loadType: "DELTA" } } },
          },
        },
      },
    },
  },
});

const src = (source: string) => `"LT_DEMO_INV_${source}"`;
const STAGING: Column[] = [["invoiceId", id], ["carrierId", id], ["contractId", id], ["invoiceDate", day], ["currencyCode", text(3)], ["sourceProcess", text(20)]];
const HISTORY: Column[] = [["invoiceId", id], ["validFrom", when], ["invoiceStatus", text(20)], ["disputedAmount", amount]];
const CURRENT: Column[] = [["invoiceId", id], ["carrierId", id], ["invoiceDate", day], ["invoiceStatus", text(20)], ["disputedAmount", amount]];
const RATED: Column[] = [["invoiceId", id], ["invoiceLineId", id], ["laneId", id], ["costCenterId", text(10)], ["ratedAmountEuro", amount], ["taxAmountEuro", amount]];

export const BUSY_RAW: RawObject[] = [
  ...Object.entries(SOURCES).flatMap(([source, columns]) => [table(`LT_DEMO_INV_${source}`, columns), loadFlow(source)]),
  table("LT_DEMO_INV_STAGING", STAGING),
  table("LT_DEMO_INV_HISTORY", HISTORY),
  table("LT_DEMO_INV_CURRENT", CURRENT),
  table("LT_DEMO_INV_RATED_LINES", RATED),

  // Three flows load the staging table, from the same headers: one belongs to another process.
  ...["HEADER_DAILY", "HEADER_INITIAL", "HEADER_CORRECTIONS"].map((variant) =>
    transform(
      `TF_DEMO_INV_STAGE_FROM_${variant}`,
      "LT_DEMO_INV_STAGING",
      `SELECT h."invoiceId", h."carrierId", h."contractId", h."invoiceDate", h."currencyCode", '${variant}' AS "sourceProcess"\nFROM ${src("INVOICE_HEADER")} h\nJOIN ${src("CARRIER")} c ON c."carrierId" = h."carrierId"\nJOIN ${src("CONTRACT")} k ON k."contractId" = h."contractId"\nWHERE c."isActive" = TRUE`,
    ),
  ),
  // The history keeps every status an invoice had: it reads the current table, which the merge builds from the history.
  transform(
    "TF_DEMO_INV_HISTORY_FROM_CURRENT_STATUS",
    "LT_DEMO_INV_HISTORY",
    `SELECT c."invoiceId", CURRENT_TIMESTAMP AS "validFrom", c."invoiceStatus", c."disputedAmount"\nFROM "LT_DEMO_INV_CURRENT" c`,
  ),
  transform(
    "TF_DEMO_INV_HISTORY_FROM_DISPUTES",
    "LT_DEMO_INV_HISTORY",
    `SELECT d."invoiceId", d."openedAt" AS "validFrom", d."disputeStatus" AS "invoiceStatus", d."disputedAmount"\nFROM ${src("DISPUTE")} d`,
  ),
  transform(
    "TF_DEMO_INV_MERGE_STAGING_WITH_HISTORY",
    "LT_DEMO_INV_CURRENT",
    `SELECT s."invoiceId", s."carrierId", s."invoiceDate", h."invoiceStatus", h."disputedAmount"\nFROM "LT_DEMO_INV_STAGING" s\nLEFT JOIN "LT_DEMO_INV_HISTORY" h ON h."invoiceId" = s."invoiceId"`,
  ),
  transform(
    "TF_DEMO_INV_MERGE_LATE_CORRECTIONS",
    "LT_DEMO_INV_CURRENT",
    `SELECT s."invoiceId", s."carrierId", s."invoiceDate", 'CORRECTED' AS "invoiceStatus", 0 AS "disputedAmount"\nFROM "LT_DEMO_INV_STAGING" s\nWHERE s."sourceProcess" = 'HEADER_CORRECTIONS'`,
  ),
  // The rating flow, and a delta flow that reads the rated lines back, through a view, to add what changed.
  transform(
    "TF_DEMO_INV_RATE_LINES_WITH_CONTRACT_RATES",
    "LT_DEMO_INV_RATED_LINES",
    `SELECT l."invoiceId", l."invoiceLineId", l."laneId", n."costCenterId",\n  l."quantity" * r."unitRate" * (1 + COALESCE(s."surchargePercent", 0) / 100) * f."fuelIndexPercent" / 100 * x."rateToEuro" AS "ratedAmountEuro",\n  l."lineAmount" * t."taxPercent" / 100 AS "taxAmountEuro"\nFROM ${src("INVOICE_LINE")} l\nJOIN ${src("RATE_CARD")} r ON r."laneId" = l."laneId" AND r."chargeCode" = l."chargeCode"\nLEFT JOIN ${src("SURCHARGE")} s ON s."chargeCode" = l."chargeCode"\nJOIN ${src("LANE")} n ON n."laneId" = l."laneId"\nJOIN ${src("INVOICE_HEADER")} h ON h."invoiceId" = l."invoiceId"\nJOIN ${src("CURRENCY_RATE")} x ON x."currencyCode" = h."currencyCode" AND x."rateDate" = h."invoiceDate"\nJOIN ${src("FUEL_INDEX")} f ON f."indexMonth" = h."invoiceDate"\nJOIN ${src("CARRIER")} c ON c."carrierId" = h."carrierId"\nJOIN ${src("TAX_CODE")} t ON t."countryCode" = c."countryCode"`,
  ),
  transform(
    "TF_DEMO_INV_RATE_DELTA_SINCE_LAST_LOAD",
    "LT_DEMO_INV_RATED_LINES",
    `SELECT r."invoiceId", r."invoiceLineId", r."laneId", r."costCenterId", r."ratedAmountEuro", r."taxAmountEuro"\nFROM "V_DEMO_INV_RATED_LINES_CHANGED_SINCE_LAST_LOAD" r\nJOIN ${src("INVOICE_LINE")} l ON l."invoiceLineId" = r."invoiceLineId"`,
  ),
  {
    space: BUSY_SPACE,
    kind: "views",
    technicalName: "V_DEMO_INV_RATED_LINES_CHANGED_SINCE_LAST_LOAD",
    definition: {
      definitions: {
        V_DEMO_INV_RATED_LINES_CHANGED_SINCE_LAST_LOAD: {
          kind: "entity",
          "@DataWarehouse.sqlEditor.query": `SELECT r."invoiceId", r."invoiceLineId", r."laneId", r."costCenterId", r."ratedAmountEuro", r."taxAmountEuro"\nFROM "LT_DEMO_INV_RATED_LINES" r\nWHERE r."ratedAmountEuro" IS NOT NULL`,
        },
      },
    },
  },
  {
    space: BUSY_SPACE,
    kind: "views",
    technicalName: BUSY_OUTPUT,
    definition: {
      definitions: {
        [BUSY_OUTPUT]: {
          kind: "entity",
          "@DataWarehouse.consumption.external": true,
          "@DataWarehouse.sqlEditor.query": `SELECT n."laneName", d."depotName", o."costCenterName", MONTH(c."invoiceDate") AS "invoiceMonth",\n  SUM(r."ratedAmountEuro") AS "ratedAmountEuro", SUM(r."taxAmountEuro") AS "taxAmountEuro", COUNT(DISTINCT v."vehicleId") AS "vehicles", COUNT(DISTINCT p."driverId") AS "drivers"\nFROM "LT_DEMO_INV_CURRENT" c\nJOIN "LT_DEMO_INV_RATED_LINES" r ON r."invoiceId" = c."invoiceId"\nJOIN ${src("LANE")} n ON n."laneId" = r."laneId"\nJOIN ${src("ROUTE")} t ON t."routeId" = n."routeId"\nJOIN ${src("DEPOT")} d ON d."depotId" = t."originDepotId"\nJOIN ${src("COST_CENTER")} o ON o."costCenterId" = r."costCenterId"\nLEFT JOIN ${src("VEHICLE")} v ON v."isRefrigerated" = FALSE\nLEFT JOIN ${src("DRIVER")} p ON p."carrierId" = c."carrierId"\nWHERE c."invoiceStatus" <> 'CANCELLED'\nGROUP BY n."laneName", d."depotName", o."costCenterName", MONTH(c."invoiceDate")`,
        },
      },
    },
  },
];
