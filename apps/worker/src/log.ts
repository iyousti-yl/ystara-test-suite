/**
 * The worker's log: one JSON object per line, like the API's (Fastify's), so both read the same way in
 * `docker compose logs` and in a log tool. Never pass a secret, a password or a test row in `fields`.
 */
type Fields = Record<string, unknown>;

function write(level: "info" | "warn" | "error", msg: string, fields: Fields = {}) {
  const line = JSON.stringify({ level, time: new Date().toISOString(), service: "ystara-worker", msg, ...fields });
  if (level === "info") console.log(line);
  else console.error(line);
}

export const log = {
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
};

/** An error's first line for the log, without its stack. */
export const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];
