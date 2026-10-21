import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { claudeDrafter, DRAFT_MODEL, DraftFailed, keyFromEnv, scenarioDrafter, type DraftBrief, type SendMessage } from "./drafting.js";

// A synthetic pipeline: V_OUT keeps the open rows of LT_DATA.
const brief: DraftBrief = {
  output: "S.V_OUT",
  tables: [
    {
      space: "S",
      technicalName: "LT_DATA",
      type: "local_table",
      why: "nothing in the pipeline loads it",
      columns: [
        { name: "ID", type: "NVARCHAR(10)", key: true },
        { name: "STATUS", type: "NVARCHAR(10)", used: true, keeps: "OPEN" },
      ],
    },
  ],
  checkpoints: [{ space: "S", technicalName: "V_OUT", type: "sql_view", columns: [{ name: "ID", type: "NVARCHAR(10)" }] }],
  logic: `== S.V_OUT (sql view): compiled\nSELECT "ID" FROM "LT_DATA" WHERE "STATUS" = 'OPEN'`,
  today: "2026-10-21",
};

const answer = (equals: number) => ({
  name: "Open rows",
  kind: "common",
  description: "ignored: the person's description is kept",
  notes: "Row 2 is closed.",
  tables: [{ table: "S.LT_DATA", columns: ["ID", "STATUS"], rows: [["1", "OPEN"], ["2", null]] }],
  checks: [
    { checkpoint: "S.V_OUT", type: "row_count", why: "Only row 1 is open.", equals },
    { checkpoint: "S.V_OUT", type: "rows_equal", why: "Row 1 comes through.", key: ["ID"], columns: ["ID"], rows: [["1"]] },
  ],
});

/** A fake Anthropic API answering with each of `texts` in turn, which records what it was sent. */
function fakeClaude(texts: (string | { stop: Anthropic.Beta.BetaStopReason })[]) {
  const sent: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const send: SendMessage = async (params) => {
    sent.push(structuredClone(params));
    const next = texts[sent.length - 1]!;
    const text = typeof next === "string" ? next : "";
    return {
      id: `msg_${sent.length}`,
      type: "message",
      role: "assistant",
      model: DRAFT_MODEL,
      content: [{ type: "text", text, citations: null }],
      stop_reason: typeof next === "string" ? "end_turn" : next.stop,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: sent.length > 1 ? 90 : 0 },
    } as Anthropic.Beta.BetaMessage;
  };
  return { send, sent };
}

describe("drafting a scenario", () => {
  it("is off without an API key", async () => {
    expect([keyFromEnv({}), keyFromEnv({ ANTHROPIC_API_KEY: "  " }), keyFromEnv({ ANTHROPIC_API_KEY: " sk-ant-synthetic " })]).toEqual([undefined, undefined, "sk-ant-synthetic"]);
    const off = claudeDrafter(async () => undefined);
    expect(await off.available()).toBe(false);
    await expect(off.draft(brief, { description: "Closed rows are left out." }, () => [])).rejects.toThrow(/its Anthropic API key was removed/);
    expect(await claudeDrafter(async () => "sk-ant-synthetic").available()).toBe(true);
  });

  it("sends the pipeline and the description, and reads the rows and checks back", async () => {
    const claude = fakeClaude([JSON.stringify(answer(1))]);
    const outcome = await scenarioDrafter(claude.send).draft(brief, { description: "Closed rows are left out.", kind: "golden" }, () => []);

    expect(outcome).toEqual({
      // The person's kind and description win; NULL cells are left out, as in a scenario file.
      scenario: {
        name: "Open rows",
        kind: "golden",
        description: "Closed rows are left out.",
        fixtures: [{ table: "S.LT_DATA", rows: [{ ID: "1", STATUS: "OPEN" }, { ID: "2" }] }],
        expect: [{ checkpoint: "S.V_OUT", assertions: [{ type: "row_count", equals: 1 }, { type: "rows_equal", key: ["ID"], rows: [{ ID: "1" }] }] }],
      },
      notes: ["Row 2 is closed.", "V_OUT, row_count: Only row 1 is open.", "V_OUT, rows_equal: Row 1 comes through."],
      problems: [],
      usage: { input: 100, output: 50, cacheRead: 0 },
    });
    const [params] = claude.sent;
    expect(params).toMatchObject({ model: DRAFT_MODEL, output_config: { format: { type: "json_schema" } }, cache_control: { type: "ephemeral" } });
    const prompt = params!.messages[0]!.content as string;
    expect(prompt).toContain("Description: Closed rows are left out.");
    expect(prompt).toContain(`STATUS  NVARCHAR(10)  (read by the logic, a filter keeps "OPEN")`);
    expect(prompt).toContain(`WHERE "STATUS" = 'OPEN'`);
  });

  it("sends back what stops the draft, and gives up after three answers", async () => {
    const claude = fakeClaude([JSON.stringify(answer(2)), JSON.stringify(answer(1))]);
    const compile = (draft: { expect: { assertions: { type: string; equals?: unknown }[] }[] }) =>
      draft.expect[0]!.assertions.some((a) => a.type === "row_count" && a.equals !== 1) ? ["row_count is wrong"] : [];
    const outcome = await scenarioDrafter(claude.send).draft(brief, { description: "Closed rows are left out." }, compile as never);
    expect(outcome.problems).toEqual([]);
    expect(outcome.usage).toEqual({ input: 200, output: 100, cacheRead: 90 });
    expect(claude.sent[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(claude.sent[1]!.messages[2]!.content).toContain("- row_count is wrong");

    const stubborn = fakeClaude([JSON.stringify(answer(2)), JSON.stringify(answer(2)), JSON.stringify(answer(2))]);
    const last = await scenarioDrafter(stubborn.send).draft(brief, { description: "Closed rows are left out." }, compile as never);
    expect([stubborn.sent.length, last.problems]).toEqual([3, ["row_count is wrong"]]);
  });

  it("says when Claude declines, runs out of room or answers something else", async () => {
    const draft = (texts: Parameters<typeof fakeClaude>[0]) => scenarioDrafter(fakeClaude(texts).send).draft(brief, { description: "Closed rows are left out." }, () => []);
    await expect(draft([{ stop: "refusal" }])).rejects.toThrow(DraftFailed);
    await expect(draft([{ stop: "max_tokens" }])).rejects.toThrow(/too long to finish/);
    await expect(draft(["not JSON"])).rejects.toThrow(/couldn't be read as a scenario/);
    await expect(draft([JSON.stringify({ ...answer(1), checks: [{ type: "row_count" }] })])).rejects.toThrow(/couldn't be read as a scenario/);
  });
});
