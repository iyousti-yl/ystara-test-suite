-- A task chain step that empties a table (DELETE_DATA) is a "clears" edge, no longer "triggers"
-- (see EdgeKind in packages/shared/src/objects.ts). Scans stored before this keep "triggers" for
-- those steps; scanning again, or importing the saved scan again, records them as "clears".
alter table scan_edges drop constraint scan_edges_kind_check;
alter table scan_edges add constraint scan_edges_kind_check check (kind in ('reads_from', 'writes_to', 'triggers', 'clears'));
