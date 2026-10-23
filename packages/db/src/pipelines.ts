import type { PipelineDefinition } from "@ystara/shared";
import type { Queryable } from "./db.js";

/** Saved pipelines: an output plus writer exclusions; steps are computed from the latest successful scan. */
export type { PipelineDefinition };

interface Row {
  id: string;
  tenant_id: string;
  name: string;
  output_space: string;
  output_name: string;
  exclude_writers: string[];
  created_at: Date;
}

const toPipeline = (r: Row): PipelineDefinition => ({
  id: r.id,
  tenantId: r.tenant_id,
  name: r.name,
  output: { space: r.output_space, technicalName: r.output_name },
  excludeWriters: r.exclude_writers,
  createdAt: r.created_at,
});

export async function createPipeline(db: Queryable, input: Omit<PipelineDefinition, "id" | "createdAt">): Promise<PipelineDefinition> {
  const { rows } = await db.query<Row>(
    "insert into pipelines (tenant_id, name, output_space, output_name, exclude_writers) values ($1, $2, $3, $4, $5) returning *",
    [input.tenantId, input.name, input.output.space, input.output.technicalName, input.excludeWriters],
  );
  return toPipeline(rows[0]);
}

export async function listPipelines(db: Queryable, tenantId: string): Promise<PipelineDefinition[]> {
  return (await db.query<Row>("select * from pipelines where tenant_id = $1 order by name", [tenantId])).rows.map(toPipeline);
}

export async function getPipeline(db: Queryable, id: string): Promise<PipelineDefinition | undefined> {
  const { rows } = await db.query<Row>("select * from pipelines where id = $1", [id]);
  return rows[0] && toPipeline(rows[0]);
}

/** The loaders a saved pipeline leaves out: its steps are worked out again with them from the next read. */
export async function setIgnoredLoaders(db: Queryable, id: string, excludeWriters: string[]): Promise<PipelineDefinition | undefined> {
  const { rows } = await db.query<Row>("update pipelines set exclude_writers = $2 where id = $1 returning *", [id, excludeWriters]);
  return rows[0] && toPipeline(rows[0]);
}

export async function deletePipeline(db: Queryable, id: string): Promise<boolean> {
  return (await db.query("delete from pipelines where id = $1 returning id", [id])).rows.length > 0;
}
