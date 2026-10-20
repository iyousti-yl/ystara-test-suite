-- Phase 3b: keep definitions as they were read. jsonb sorts the keys of every object, so a
-- table's columns came back in another order than the table's own. The scenario builder shows
-- them as a grid that takes pasted rows, so the order matters. json keeps the text as given;
-- nothing queries inside a definition. Definitions stored before this keep jsonb's order until
-- a scan or import stores the same definition again (saveScanResult replaces it).
alter table object_definitions alter column definition type json using definition::json;
