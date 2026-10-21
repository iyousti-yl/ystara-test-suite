/**
 * Alerts in a Microsoft Teams channel (phase 3c): an account's admin makes a
 * webhook in Teams (a workflow "Post to a channel when a webhook request is
 * received") and enters its address in Ystara. Snapshot and scenario alerts
 * are then also posted there as an Adaptive Card, with the same names, counts
 * and links as the email, never a value from the data.
 *
 * The address is a secret (anyone who has it can post in the channel): sealed
 * in the database, never shown again, and left out of every error.
 */
export interface TeamsMessage {
  title: string;
  /** One line under the title: the pipeline and tenant. */
  subtitle?: string;
  /** The reasons, one paragraph each. */
  lines: string[];
  link?: { title: string; url: string };
}

/** The card as Teams workflows (and older incoming webhooks) take it: a message with one Adaptive Card. */
export function teamsPayload(message: TeamsMessage): unknown {
  const text = (value: string, extra: Record<string, unknown> = {}) => ({ type: "TextBlock", text: value, wrap: true, ...extra });
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            text(message.title, { weight: "Bolder", size: "Medium" }),
            ...(message.subtitle ? [text(message.subtitle, { isSubtle: true, spacing: "None" })] : []),
            ...message.lines.map((line) => text(line, { spacing: "Small" })),
          ],
          actions: message.link ? [{ type: "Action.OpenUrl", title: message.link.title, url: message.link.url }] : [],
        },
      },
    ],
  };
}

/** Posts a card to a Teams webhook; throws with what Teams answered, never the address. */
export type PostToTeams = (url: string, message: TeamsMessage) => Promise<void>;

/** How long a post may take before it counts as failed. */
const TEAMS_TIMEOUT_MS = 15_000;

export const postToTeams: PostToTeams = async (url, message) => {
  let response: Response;
  try {
    // No redirects: the address was checked (teamsWebhookHost), where it would lead to was not.
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(teamsPayload(message)),
      redirect: "error",
      signal: AbortSignal.timeout(TEAMS_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new Error(timedOut ? `Teams didn't answer within ${TEAMS_TIMEOUT_MS / 1000} seconds.` : "Teams couldn't be reached.");
  }
  if (!response.ok) {
    const hint = response.status === 404 || response.status === 401 || response.status === 403 ? " The webhook may have been deleted or turned off in Teams." : "";
    throw new Error(`Teams refused the post (HTTP ${response.status}).${hint}`);
  }
};
