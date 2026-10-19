/**
 * A piece of SQL with the values bound to its `?` placeholders, in order.
 * Fixture values are always bound, never written into the text, so a value
 * can't change what the statement does.
 */
export interface Fragment {
  sql: string;
  params: unknown[];
}

export const fragment = (sql: string, params: unknown[] = []): Fragment => ({ sql, params });

/** Joins pieces of text and fragments into one fragment, keeping the order of the values. */
export function concat(parts: (string | Fragment)[], separator = ""): Fragment {
  const sql: string[] = [];
  const params: unknown[] = [];
  for (const part of parts) {
    if (typeof part === "string") sql.push(part);
    else {
      sql.push(part.sql);
      params.push(...part.params);
    }
  }
  return { sql: sql.join(separator), params };
}

/**
 * Why a step can't be simulated (yet): the run stops before anything is sent.
 * The message names the step's construct, never a value.
 */
export class SimulationStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationStop";
  }
}
