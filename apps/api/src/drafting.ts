import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { getServerSecret, type Db } from "@ystara/db";
import type { Assertion, Expectation, ScenarioDrafted, ScenarioInputs } from "@ystara/shared";
import { serverSecretContext, type SecretBox } from "@ystara/shared/secrets";

/**
 * Drafting a scenario from its description with Claude (phase 3c). The
 * builder sends the description; this sends Claude the pipeline's definitions
 * (object and column names, types and each step's SQL or CSN query, as
 * `npm run scenario:new -- --logic` prints them) and gets back made-up rows
 * for the tables that take rows and the checks those rows should pass, worked
 * out from the logic. Ystara compiles the draft and sends Claude what stops it,
 * twice at most. No data goes out: Ystara never reads the tenant's rows.
 *
 * It is on when the server has an Anthropic API key: the one the operator
 * entered on the operator panel (sealed in server_secrets), or the API's
 * ANTHROPIC_API_KEY (.env.local for `npm run dev:api`), which wins. Without
 * one the builder doesn't offer it.
 */

export const DRAFT_MODEL = "claude-opus-5-5";
/** Compiling the draft and sending back what stops it: at most this many answers from Claude in all. */
const ATTEMPTS = 3;

/** What the pipeline offers a scenario, and its logic as text. */
export interface DraftBrief {
  /** The pipeline's output, SPACE.NAME. */
  output: string;
  tables: ScenarioInputs["tables"];
  checkpoints: ScenarioInputs["checkpoints"];
  /** Each step's logic, upstream first (pipelineLogic in the connector). */
  logic: string;
  /** Today, YYYY-MM-DD: the date a filter on CURRENT_DATE compares with. */
  today: string;
}

export interface DraftRequest {
  description: string;
  name?: string;
  kind?: "golden" | "common" | "outlying";
}

/** Compiles a drafted scenario as the builder would send it; the problems that stop it, empty when it compiles. */
export type Compile = (draft: ScenarioDrafted["scenario"]) => string[];

export interface DraftOutcome extends ScenarioDrafted {
  /** Tokens Claude read and wrote, over all its answers, for the log. */
  usage: { input: number; output: number; cacheRead: number };
}

/** Claude declined, or its answer couldn't be read: the message says which, for the person. */
export class DraftFailed extends Error {}

export interface ScenarioDrafter {
  /** Whether drafting is on: the server has a key. */
  available(): Promise<boolean>;
  draft(brief: DraftBrief, request: DraftRequest, compile: Compile): Promise<DraftOutcome>;
}

/** Sends one request; the Anthropic client's beta messages, or a fake in tests. */
export type SendMessage = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;

/** The server's ANTHROPIC_API_KEY, when it has one. */
export const keyFromEnv = (env: NodeJS.ProcessEnv = process.env) => env.ANTHROPIC_API_KEY?.trim() || undefined;

/** Whether Anthropic takes a key, by asking for the model's details (free). Throws when Anthropic can't be reached. */
export async function checkClaudeKey(apiKey: string): Promise<"ok" | "refused"> {
  try {
    await new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 }).models.retrieve(DRAFT_MODEL);
    return "ok";
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return "refused";
    throw e;
  }
}

/** Where drafting's key comes from, and how a new one is checked; tests fake the check. */
export interface ClaudeAccess {
  /** The server's ANTHROPIC_API_KEY: it wins over the operator's. */
  fromEnvironment?: string;
  check: (apiKey: string) => Promise<"ok" | "refused">;
}

/** The key drafting uses now: the server's, else the one the operator entered (opened with MASTER_KEY), else none. */
export async function currentClaudeKey(db: Db, secrets: SecretBox, access: ClaudeAccess): Promise<string | undefined> {
  if (access.fromEnvironment) return access.fromEnvironment;
  const sealed = await getServerSecret(db, "anthropic_api_key");
  return sealed === undefined ? undefined : secrets.open(sealed, serverSecretContext("anthropic_api_key"));
}

/** A drafter with whichever key `key` gives at the time: the server's, the operator's, or none. */
export function claudeDrafter(key: () => Promise<string | undefined>): ScenarioDrafter {
  let client: { apiKey: string; anthropic: Anthropic } | undefined;
  return {
    available: async () => (await key()) !== undefined,
    async draft(brief, request, compile) {
      const apiKey = await key();
      if (!apiKey) throw new DraftFailed("Drafting with Claude isn't set up on this server any more: its Anthropic API key was removed.");
      // Streamed, since an answer with its reasoning can take a few minutes; one retry for a dropped connection.
      if (client?.apiKey !== apiKey) client = { apiKey, anthropic: new Anthropic({ apiKey, timeout: 5 * 60_000, maxRetries: 1 }) };
      const { anthropic } = client;
      return scenarioDrafter((params) => anthropic.beta.messages.stream(params).finalMessage()).draft(brief, request, compile);
    },
  };
}

/** The drafting loop over `send`: one Anthropic client's requests, or a fake in tests. */
export function scenarioDrafter(send: SendMessage): ScenarioDrafter {
  return {
    available: async () => true,
    async draft(brief, request, compile) {
      const usage = { input: 0, output: 0, cacheRead: 0 };
      const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: requestText(brief, request) }];
      for (let attempt = 1; ; attempt++) {
        const answer = await send({
          model: DRAFT_MODEL,
          max_tokens: 64_000,
          // Anthropic's recommended model takes over when a safety classifier declines a request.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "high", format: { type: "json_schema", schema: DRAFT_SCHEMA } },
          // The instructions and the pipeline stay the same between corrections, so they are cached.
          cache_control: { type: "ephemeral" },
          system: SYSTEM,
          messages,
        });
        usage.input += answer.usage.input_tokens;
        usage.output += answer.usage.output_tokens;
        usage.cacheRead += answer.usage.cache_read_input_tokens ?? 0;
        if (answer.stop_reason === "refusal") throw new DraftFailed("Claude declined to draft this scenario. Try describing it differently.");
        if (answer.stop_reason === "max_tokens") throw new DraftFailed("Claude's draft was too long to finish. Describe a smaller case, with fewer rows.");

        const text = answer.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        const parsed = DraftAnswer.safeParse(parseJson(text));
        if (!parsed.success) throw new DraftFailed("Claude's answer couldn't be read as a scenario. Try again.");
        const { scenario, notes } = toScenario(parsed.data, request);
        const problems = compile(scenario);
        if (!problems.length || attempt === ATTEMPTS) return { scenario, notes, problems, usage };
        messages.push(
          { role: "assistant", content: answer.content },
          {
            role: "user",
            content: `Ystara compiled this scenario and found what stops it:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nFix these and give the whole scenario again.`,
          },
        );
      }
    },
  };
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const SYSTEM = `You write test scenarios for SAP Datasphere pipelines in Ystara, a regression and scenario testing tool.

A scenario gives made-up rows to the pipeline's tables and says what its steps should return for them. Ystara compiles every step (SQL views, graphical views, SQL transformation flows) from its definition and runs each check as a SELECT over those rows only. A table loaded by a transformation flow takes no rows: the flow's SELECT stands in for it, as at a full load.

How to write one:
1. Read the logic from the output back to the tables, and list what decides which rows survive and what values come out: WHERE conditions and the values they keep, join keys between tables, GROUP BY, CASE branches, DISTINCT, UNION, and comparisons with today's date.
2. Give 3 to 5 rows per table (10 at most) that exercise what the description asks for: rows that pass every filter, at least one row a filter drops, matching join keys across tables, one row per CASE branch that matters. Only fill the columns the logic reads, the keys, and the columns your checks compare; leave the others out (they are NULL).
3. Every value is made up: codes such as E001 or ORG_A, names such as Test Person 1. Never real people, real companies or values that look copied from production.
4. Values fit their column's type: numbers as JSON numbers, text as JSON strings (also text that looks like a number, such as "007"), dates as "YYYY-MM-DD", timestamps as "YYYY-MM-DD HH:MM:SS", booleans as true or false, NULL as null.
5. Work out by hand, step by step, what each check should find for your rows. Put checks only on the listed checkpoints. At the output, at least a row_count, unique and no_nulls on its key when it has one, and one rows_equal on the key with the 2 to 4 columns the logic computes. Add a check at an intermediate step when a filter or join there is the point of the case.
6. For each check, say in "why" in one sentence why that value is right (e.g. "E003 is dropped: its status is inactive"). In "notes", say what the rows cover and anything you had to assume, such as the meaning of a code.
7. A sql check is one SELECT that returns one row with one value; {{checkpoint}} stands for the step's result; it has no ? placeholders.

Use the tables, columns and checkpoints exactly as listed, with SPACE.NAME for tables and checkpoints. If the description can't be tested with this pipeline, say so in notes and draft the closest scenario that can.`;

function requestText(brief: DraftBrief, request: DraftRequest): string {
  const column = (c: ScenarioInputs["tables"][number]["columns"][number]) => {
    const notes = [
      c.key && "key",
      c.used && "read by the logic",
      c.joined && "joined",
      c.keeps !== undefined && `a filter keeps ${JSON.stringify(c.keeps)}`,
      c.range && `the ${c.range} of a validity range`,
    ].filter(Boolean);
    return `  ${c.name}  ${c.type}${notes.length ? `  (${notes.join(", ")})` : ""}`;
  };
  return [
    `Draft a scenario for the pipeline whose output is ${brief.output}.`,
    "",
    `Description: ${request.description}`,
    request.name ? `Name so far: ${request.name}` : "",
    request.kind ? `Kind: ${request.kind}` : "",
    `Today is ${brief.today}.`,
    "",
    "Tables that take rows:",
    ...brief.tables.flatMap((t) => [`${t.space}.${t.technicalName} (${t.why})`, ...t.columns.map(column)]),
    "",
    "Checkpoints (steps a check can be on), with their columns when known:",
    ...brief.checkpoints.map((c) => `${c.space}.${c.technicalName}${c.columns ? `: ${c.columns.map((x) => x.name).join(", ")}` : ""}`),
    "",
    "The pipeline's steps, upstream first, with what stands in for each and its logic:",
    brief.logic,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

// --- The answer: a JSON schema Claude's output follows, and its reading -------

const Value = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const common = { checkpoint: z.string(), why: z.string() };
const Check = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("row_count"), equals: z.number().int() }),
  z.object({ ...common, type: z.literal("no_nulls"), columns: z.array(z.string()) }),
  z.object({ ...common, type: z.literal("unique"), columns: z.array(z.string()) }),
  z.object({ ...common, type: z.literal("aggregate"), column: z.string(), fn: z.enum(["sum", "min", "max", "avg", "count_distinct"]), equals: z.number(), tolerance: z.number() }),
  z.object({ ...common, type: z.literal("rows_equal"), key: z.array(z.string()), columns: z.array(z.string()), rows: z.array(z.array(Value)) }),
  z.object({ ...common, type: z.literal("sql"), query: z.string(), equals: Value }),
]);
const DraftAnswer = z.object({
  name: z.string(),
  kind: z.enum(["golden", "common", "outlying"]),
  description: z.string(),
  notes: z.string(),
  tables: z.array(z.object({ table: z.string(), columns: z.array(z.string()), rows: z.array(z.array(Value)) })),
  checks: z.array(Check),
});
type DraftAnswer = z.infer<typeof DraftAnswer>;

/** Rows as records: each row's values under `columns`, NULLs left out as in a scenario file. */
const records = (columns: string[], rows: (string | number | boolean | null)[][]) =>
  rows.map((row) => Object.fromEntries(columns.flatMap((c, i) => (row[i] === null || row[i] === undefined ? [] : [[c, row[i]]]))));

function assertionOf(c: DraftAnswer["checks"][number]): Assertion {
  switch (c.type) {
    case "row_count":
      return { type: c.type, equals: c.equals };
    case "no_nulls":
    case "unique":
      return { type: c.type, columns: c.columns };
    case "aggregate":
      return { type: c.type, column: c.column, fn: c.fn, equals: c.equals, tolerance: c.tolerance };
    case "rows_equal":
      return { type: c.type, key: c.key, rows: records(c.columns, c.rows) };
    case "sql":
      return { type: c.type, query: c.query, equals: c.equals };
  }
}

function toScenario(answer: DraftAnswer, request: DraftRequest): { scenario: ScenarioDrafted["scenario"]; notes: string[] } {
  const expect: Expectation[] = [];
  for (const check of answer.checks) {
    const assertion = assertionOf(check);
    const at = expect.find((e) => e.checkpoint === check.checkpoint);
    if (at) at.assertions.push(assertion);
    else expect.push({ checkpoint: check.checkpoint, assertions: [assertion] });
  }
  return {
    scenario: {
      // The person's own name and kind win over Claude's.
      name: request.name?.trim() || answer.name,
      kind: request.kind ?? answer.kind,
      description: request.description,
      fixtures: answer.tables.map((t) => ({ table: t.table, rows: records(t.columns, t.rows) })),
      expect,
    },
    notes: [answer.notes, ...answer.checks.map((c) => `${c.checkpoint.split(".").pop()}, ${c.type}: ${c.why}`)].filter((n) => n.trim()),
  };
}

const string = { type: "string" };
const strings = { type: "array", items: string };
const value = { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }] };
const values = { type: "array", items: { type: "array", items: value } };
const object = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const check = (type: string, properties: Record<string, unknown>) =>
  object({ checkpoint: { ...string, description: "SPACE.NAME of a listed checkpoint" }, type: { type: "string", const: type }, why: string, ...properties });

/** DraftAnswer as JSON Schema, in the subset structured outputs take: every object closed, every field required. */
export const DRAFT_SCHEMA = object({
  name: { ...string, description: "A few words naming the case" },
  kind: { type: "string", enum: ["golden", "common", "outlying"] },
  description: string,
  notes: { ...string, description: "What the rows cover, and what you assumed" },
  tables: {
    type: "array",
    items: object({ table: { ...string, description: "SPACE.NAME of a table that takes rows" }, columns: strings, rows: { ...values, description: "Each row's values, in the order of columns" } }),
  },
  checks: {
    type: "array",
    items: {
      anyOf: [
        check("row_count", { equals: { type: "integer" } }),
        check("no_nulls", { columns: strings }),
        check("unique", { columns: strings }),
        check("aggregate", { column: string, fn: { type: "string", enum: ["sum", "min", "max", "avg", "count_distinct"] }, equals: { type: "number" }, tolerance: { type: "number" } }),
        check("rows_equal", { key: strings, columns: strings, rows: values }),
        check("sql", { query: string, equals: value }),
      ],
    },
  },
});
