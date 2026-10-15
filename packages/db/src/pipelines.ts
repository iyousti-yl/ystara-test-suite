import type { Queryable } from "./db.js";

/**
 * A saved pipeline: an output object plus the writers that belong to other
 * processes. The steps are not stored; they are computed from the tenant's
 * latest successful scan with the connector's buildPipeline.
 */
export interface PipelineDefinition {
  id: string;
  tenantId: string;
  name: string;
  output: { space: string; technicalName: string };
  /** Patterns as for `npm run scan -- --exclude-writer`: NAME or SPACE.NAME, `*` and `?` wildcards. */
  excludeWriters: string[];
  createdAt: Date;
}

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

export async function deletePipeline(db: Queryable, id: string): Promise<boolean> {
  return (await db.query("delete from pipelines where id = $1 returning id", [id])).rows.length > 0;
}
