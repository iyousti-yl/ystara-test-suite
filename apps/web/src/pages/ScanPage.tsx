import { useMemo, useState } from "react";
import {
  Input,
  MessageStrip,
  Option,
  SegmentedButton,
  SegmentedButtonItem,
  Select,
  Table,
  TableCell,
  TableHeaderCell,
  TableHeaderRow,
  TableRow,
  Tag,
  Title,
} from "@ui5/webcomponents-react";
import { isDataEdge, OBJECT_TYPES, refKey, type ScanGraph } from "@ystara/shared";
import { useNavigate, useParams } from "react-router";
import { pipelineQuery, usePipelines, useScan, useScanGraph } from "../api";
import { monoColumnWidth } from "../columns";
import { ErrorStrip, Loading, ScanStatusTag } from "../components/Feedback";
import { PageError } from "../components/PageError";
import { PageHeader } from "../components/PageHeader";
import { counted, formatDateTime, formatNumber } from "../format";
import { typeColor, typeLabel } from "../objectTypes";
import { useInTenant } from "../tenantScope";

/**
 * One scan: its status and warnings, and every object it found. Picking an
 * object opens the pipeline behind it.
 */
export function ScanPage() {
  const { scanId = "" } = useParams();
  const scan = useScan(scanId);
  useInTenant(scan.data?.tenantId);
  const graph = useScanGraph(scanId, scan.data?.status === "succeeded");

  if (scan.isPending) return <Loading />;
  if (!scan.data) return <PageError error={scan.error} what="scan" />;
  const s = scan.data;

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: "Discovery", to: `/tenants/${s.tenantId}/discovery` }]}
        title={`Scan of ${s.spaces.join(", ")}`}
        subtitle={
          <span className="facts">
            <ScanStatusTag status={s.status} />
            <span>{s.source === "import" ? "Imported" : "Requested"} {formatDateTime(s.requestedAt)}</span>
            {s.finishedAt && <span>Finished {formatDateTime(s.finishedAt)}</span>}
            {s.objectCount !== null && (
              <span>
                {counted(s.objectCount, "object")}, {counted(s.edgeCount ?? 0, "link")}
              </span>
            )}
          </span>
        }
      />
      {s.status === "queued" && <MessageStrip hideCloseButton>Waiting for the worker. This page refreshes on its own.</MessageStrip>}
      {s.status === "running" && <MessageStrip hideCloseButton>Reading the spaces. This page refreshes on its own.</MessageStrip>}
      {s.error && (
        <MessageStrip design="Negative" hideCloseButton className="block">
          {s.error}
        </MessageStrip>
      )}
      {s.warnings.length > 0 && (
        <MessageStrip design="Critical" hideCloseButton className="block">
          {counted(s.warnings.length, "object")} could not be read or understood; the lineage may miss links to them.
          <ul className="warnings">
            {s.warnings.slice(0, 20).map((w) => (
              <li key={w}>{w}</li>
            ))}
            {s.warnings.length > 20 && <li>…and {formatNumber(s.warnings.length - 20)} more</li>}
          </ul>
        </MessageStrip>
      )}
      <ErrorStrip error={graph.error} />
      {graph.data && <ObjectList scanId={scanId} tenantId={s.tenantId} graph={graph.data} />}
    </div>
  );
}

type Filter = "outputs" | "all";

/** Objects nothing else reads: views and analytic models at the end of a chain are what pipelines are usually built for. */
const OUTPUT_TYPES = new Set(["sql_view", "graphical_view", "analytic_model"]);

function ObjectList({ scanId, tenantId, graph }: { scanId: string; tenantId: string; graph: ScanGraph }) {
  const navigate = useNavigate();
  // Outputs that already have a saved pipeline, so nobody saves the same one twice by accident.
  const saved = new Map((usePipelines(tenantId).data ?? []).map((p) => [refKey(p.output), p.name]));
  const multiSpace = graph.spaces.length > 1;

  const rows = useMemo(() => {
    const upstream = new Map<string, number>();
    const downstream = new Map<string, number>();
    for (const e of graph.edges) {
      if (!isDataEdge(e)) continue;
      upstream.set(refKey(e.to), (upstream.get(refKey(e.to)) ?? 0) + 1);
      downstream.set(refKey(e.from), (downstream.get(refKey(e.from)) ?? 0) + 1);
    }
    return graph.nodes.map((n) => ({ ...n, key: refKey(n), upstream: upstream.get(refKey(n)) ?? 0, downstream: downstream.get(refKey(n)) ?? 0 }));
  }, [graph]);

  const outputs = rows.filter((r) => OUTPUT_TYPES.has(r.type) && r.downstream === 0);
  const [filter, setFilter] = useState<Filter>(outputs.length > 0 ? "outputs" : "all");
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const term = search.trim().toLowerCase();
  const shown = (filter === "outputs" ? outputs : rows).filter(
    (r) =>
      (!type || r.type === type) &&
      (!term || r.technicalName.toLowerCase().includes(term) || r.businessName?.toLowerCase().includes(term)),
  );
  const presentTypes = OBJECT_TYPES.filter((t) => rows.some((r) => r.type === t));
  // A scan whose objects have no business name (a tenant that doesn't use them) gets no empty column.
  const businessNames = rows.some((r) => r.businessName);

  return (
    <section className="block">
      <div className="list-toolbar">
        <Title level="H2" size="H4">Objects</Title>
        <SegmentedButton onSelectionChange={(e) => setFilter(e.detail.selectedItems[0]?.dataset.filter as Filter)}>
          <SegmentedButtonItem data-filter="outputs" selected={filter === "outputs"}>
            Likely outputs ({formatNumber(outputs.length)})
          </SegmentedButtonItem>
          <SegmentedButtonItem data-filter="all" selected={filter === "all"}>
            All ({formatNumber(rows.length)})
          </SegmentedButtonItem>
        </SegmentedButton>
        <Select onChange={(e) => setType(e.detail.selectedOption.dataset.type ?? "")} accessibleName="Type">
          <Option data-type="" selected={type === ""}>
            All types
          </Option>
          {presentTypes.map((t) => (
            <Option key={t} data-type={t} selected={type === t}>
              {typeLabel(t)}
            </Option>
          ))}
        </Select>
        <Input showClearIcon placeholder="Search by name" value={search} onInput={(e) => setSearch(e.target.value)} />
      </div>
      <p className="muted">
        {filter === "outputs"
          ? "Views and analytic models that nothing else in the scan reads: what people use. Pick one to see the pipeline behind it, and save it from there."
          : "Pick any object to see the pipeline behind it, and save it from there."}
      </p>
      <Table
        noDataText="No objects match."
        overflowMode="Popin"
        onRowClick={(e) => navigate(`/scans/${scanId}/pipeline?${pipelineQuery(String(e.detail.row.rowKey), [])}`)}
        headerRow={
          <TableHeaderRow sticky>
            {/* As wide as the scan's longest name, so the column doesn't move while searching. */}
            <TableHeaderCell minWidth={monoColumnWidth(rows.map((r) => r.technicalName), 14)} importance={2}>
              Technical name
            </TableHeaderCell>
            {businessNames && <TableHeaderCell minWidth="12rem">Business name</TableHeaderCell>}
            <TableHeaderCell minWidth="9rem" importance={1}>
              Type
            </TableHeaderCell>
            {multiSpace && <TableHeaderCell minWidth="7rem">Space</TableHeaderCell>}
            <TableHeaderCell minWidth="5rem" horizontalAlign="End">
              Inputs
            </TableHeaderCell>
            <TableHeaderCell minWidth="5rem" horizontalAlign="End">
              Used by
            </TableHeaderCell>
          </TableHeaderRow>
        }
      >
        {shown.map((r) => (
          <TableRow key={r.key} rowKey={r.key} interactive>
            <TableCell>
              <span>
                <span className="mono">{r.technicalName}</span>
                {saved.has(r.key) && (
                  <Tag design="Neutral" className="tag-after" title={`Saved as the pipeline "${saved.get(r.key)}"`}>
                    Saved
                  </Tag>
                )}
              </span>
            </TableCell>
            {businessNames && <TableCell>{r.businessName || "–"}</TableCell>}
            <TableCell>
              {/* In a span: the cell lays its children out in a row, and the dot sits on the text's line only inside one. */}
              <span>
                <span className="type-dot" style={{ background: typeColor(r.type) }} />
                {typeLabel(r.type)}
              </span>
            </TableCell>
            {multiSpace && <TableCell className="mono">{r.space}</TableCell>}
            <TableCell horizontalAlign="End" className="mono">{r.upstream}</TableCell>
            <TableCell horizontalAlign="End" className="mono">{r.downstream}</TableCell>
          </TableRow>
        ))}
      </Table>
    </section>
  );
}
