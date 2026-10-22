import { Link } from "@ui5/webcomponents-react";
import { pipelineHealth, type HealthNext, type PipelineHealth } from "@ystara/shared";
import { useNavigate } from "react-router";
import type { PipelineSummaryJson } from "../api";

/** The page a pipeline's next step opens. */
export function healthPath(pipelineId: string, next: HealthNext): string {
  switch (next.page) {
    case "suite":
      return `/scenario-suites/${next.id}`;
    case "snapshot":
      return `/snapshots/${next.id}`;
    case "compare":
      return `/pipelines/${pipelineId}/compare`;
    case "scenarios":
      return `/pipelines/${pipelineId}/scenarios`;
    case "snapshots":
      return `/pipelines/${pipelineId}/snapshots`;
  }
}

/** pipelineHealth for a summary as the API sends it (dates as text, which it doesn't read). */
export const healthOf = (s: PipelineSummaryJson): PipelineHealth => pipelineHealth(s as unknown as Parameters<typeof pipelineHealth>[0]);

/** The next step as a link. Inside a clickable row it opens its own page, not the row's. */
export function NextStep({ pipelineId, next }: { pipelineId: string; next: HealthNext | null }) {
  const navigate = useNavigate();
  if (!next) return null;
  const to = healthPath(pipelineId, next);
  return (
    <Link
      href={to}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigate(to);
      }}
    >
      {next.text}
    </Link>
  );
}
