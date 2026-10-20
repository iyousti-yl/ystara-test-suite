# Writing a scenario

A scenario tests a pipeline's logic on rows you choose. You give a few rows for the pipeline's tables and say what you expect at its steps. `npm run scenario:run` compiles every view and transformation flow of the pipeline over your rows and checks each expectation. Nothing is loaded into or run in the tenant: each check is one SELECT that reads only your rows (`FROM DUMMY`), sent through the space's database user.

The examples use the synthetic sales pipeline the tests run (`packages/connector/src/simulate/fixtures/sales-space.ts`):

```
LT_ORDERS ── V_OPEN_ORDERS (STATUS = 'OPEN') ──┐
                                               ├── V_REGION_TOTALS (sum per region) ── TF_REGION_LOAD ── LT_REGION_TOTALS ── V_REGION_OUT
LT_CUSTOMERS ──────────────────────────────────┘
```

## Step by step

1. **Have a saved scan that holds the pipeline.** `npm run scan -- --space SALES --output V_REGION_OUT` saves one in `tools/scan/output`. `scenario:run` reads the newest one, or the folder you give with `--from`. It reads the definitions from the scan, so scan again after a view changes.

2. **Start the file** with `npm run scenario:new -- --output SALES.V_REGION_OUT --file tools/scenario/region-totals.local.yaml`. It writes every table that takes rows, with all its columns set to null and their types beside them, and a first check at the output:

   ```yaml
   fixtures:
     # LT_CUSTOMERS: nothing in the pipeline loads it
     - table: SALES.LT_CUSTOMERS
       rows:
         - CUSTOMER_ID: null  # NVARCHAR(10)
           REGION: null       # NVARCHAR(20)
     # LT_ORDERS: DF_ORDERS loads it, and a data flow can't be expressed in SQL
     - table: SALES.LT_ORDERS
       rows:
         - ORDER_ID: null     # NVARCHAR(10)
           CUSTOMER_ID: null  # NVARCHAR(10)
           AMOUNT: null       # DECIMAL(15, 2)
           STATUS: null       # NVARCHAR(10)
   ```

   Comments at the top of the file list the steps you can check, and the steps that can't be simulated. A scenario for a real tenant names its objects, so its file name must end in `.local.yaml`: git ignores those files, and they never leave your PC. `scenario:new` refuses any other name, and a file that exists already.

3. **Read the logic.** Add `--logic` to the same command (it works without `--file` too) to print each step, upstream first: the SQL of SQL views and transformation flows, the CSN query of graphical views, and the columns of tables. LT_REGION_TOTALS isn't in the fixtures: its transformation flow loads it, so it is that flow's SELECT over the steps before it.

   `npm run scenario:run -- --file tools/scenario/region-totals.local.yaml --compile-only` shows the same in one line per step, saying what stands in for it. This sends nothing:

   ```
   DF_ORDERS: not simulated: a data flow can't be expressed in SQL, so the table it loads gets a fixture
   LT_CUSTOMERS: fixture with 1 given row
   LT_ORDERS: fixture with 1 given row
   V_OPEN_ORDERS: compiled from its SQL
   V_REGION_TOTALS: compiled from its CSN query
   TF_REGION_LOAD: compiled from its SQL step; its own target LT_REGION_TOTALS starts empty (full load)
   LT_REGION_TOTALS: the SELECT of TF_REGION_LOAD (full load)
   V_REGION_OUT: compiled from its SQL
   ```

   A table you remove from the fixtures, or give `rows: []`, says "empty". The skeleton's rows are all null, so the join finds nothing and its check would fail with `0 rows, 1 expected` until you fill them in.

4. **Replace the nulls with the rows of your test**, and copy a row for more. Three to five rows per table is usually enough; a column no step uses can be left out. Choose them so they pass the pipeline's filters and joins: an order needs `STATUS: OPEN` to reach V_REGION_TOTALS, and a `CUSTOMER_ID` that LT_CUSTOMERS has. The logic from step 3 shows which values each step keeps. Make the values up: never copy rows from the tenant.

5. **Work out by hand what the output should be**, and write it under `expect`. With orders 10.5 and 4.5 for C1 (NORTH) and 3 for C2 (SOUTH), all OPEN, V_REGION_OUT has two rows: NORTH 15 and SOUTH 3. A YAML comment (`# ...`) above an expectation, saying why that value is right, helps whoever reads the scenario later.

6. **Compile again** with `--compile-only` until it lists no problems and every check says `ok`.

7. **Run it** without `--compile-only`. It signs in as the database user of `.env.local` (`DSP_DB_HOST`, `DSP_DB_USER`, `DSP_DB_PASSWORD`) and prints one line per check: `pass`, `FAIL` with what came back, `ERROR` with the database's message, or `-` when it couldn't run. The exit code is 1 when anything didn't pass.

The finished file:

```yaml
name: Region totals
description: Open orders are summed per region; closed orders are left out.
kind: golden
pipeline: SALES.V_REGION_OUT
fixtures:
  - table: LT_ORDERS
    rows:
      - { ORDER_ID: "1", CUSTOMER_ID: C1, AMOUNT: 10.5, STATUS: OPEN }
      - { ORDER_ID: "2", CUSTOMER_ID: C1, AMOUNT: 4.5, STATUS: OPEN }
      - { ORDER_ID: "3", CUSTOMER_ID: C2, AMOUNT: 3, STATUS: OPEN }
      - { ORDER_ID: "4", CUSTOMER_ID: C2, AMOUNT: 99, STATUS: CLOSED }
  - table: LT_CUSTOMERS
    rows:
      - { CUSTOMER_ID: C1, REGION: NORTH }
      - { CUSTOMER_ID: C2, REGION: SOUTH }
expect:
  - checkpoint: V_REGION_OUT
    assertions:
      # One row per region that has open orders.
      - { type: row_count, equals: 2 }
      - { type: unique, columns: [REGION] }
      - { type: no_nulls, columns: [REGION, TOTAL] }
      # 10.5 + 4.5 + 3; order 4 is closed, so its 99 is left out.
      - { type: aggregate, column: TOTAL, fn: sum, equals: 18 }
      - type: rows_equal
        key: [REGION]
        rows:
          - { REGION: NORTH, TOTAL: 15 }
          - { REGION: SOUTH, TOTAL: 3 }
  # A checkpoint can be any view or table of the pipeline, not only its output.
  - checkpoint: V_OPEN_ORDERS
    assertions:
      - { type: sql, query: 'SELECT COUNT(*) FROM {{checkpoint}} AS c WHERE c."ORDER_ID" = ''4''', equals: 0 }
```

**With Claude Code**, `/scenario-draft SALES.V_REGION_OUT` does steps 2 to 6: it reads the logic, makes up rows that pass the filters and joins, works out the expected results with a comment on each, and compiles the file. It never sends anything to the tenant. `/scenario-run tools/scenario/region-totals.local.yaml` runs a scenario and explains each check that didn't pass by the step that causes it. Check a drafted scenario's comments before you trust it: the expected values are only as right as the reasoning beside them.

## The file, key by key

| Key | Required | What it is |
|---|---|---|
| `name` | yes | What the scenario tests, in a few words. |
| `kind` | yes | `golden` (the normal case, with known results), `common` (a frequent variation) or `outlying` (an edge case: a missing manager, a date at a boundary). It is a label only. |
| `pipeline` | yes | The pipeline's output, as `NAME` (in the scan's first space) or `SPACE.NAME`. |
| `description` | no | A sentence on what the scenario shows. |
| `tags` | no | A list of words, for example `[hr, monthly]`. |
| `fixtures` | yes, at least one | Rows for the pipeline's tables (below). |
| `expect` | yes, at least one | Checks at the pipeline's steps (below). |

A key the format doesn't know, or a misspelt one, makes the file invalid, so a typo is never silently ignored. The run then says where: `expect.0.assertions.1: ...` means the second check of the first `expect` entry.

**A fixture** is `table` and `rows`:
- `table` is a table of the pipeline, as `NAME` or `SPACE.NAME`. It can't be a view: give rows to the tables the view reads.
- Each row names columns by their technical name. A column you leave out is NULL, and a column the table doesn't have stops the scenario.
- `rows: []` makes the table empty, and so does leaving the table out.
- Rows given for a table that a transformation flow loads take the place of that flow, so a scenario can start in the middle of a pipeline. With rows for LT_REGION_TOTALS, the steps before TF_REGION_LOAD don't matter.
- Each table gets at most one fixture. `csv:` isn't supported yet.

**An expectation** is a `checkpoint` and its `assertions`. The checkpoint is a view or table of the pipeline, as `NAME` or `SPACE.NAME`. A data flow can't be one, because it holds no rows: check the table it loads.

## Assertions

| Type | Checks | Example |
|---|---|---|
| `row_count` | how many rows the step returns | `{ type: row_count, equals: 2 }` |
| `no_nulls` | none of these columns is empty in any row | `{ type: no_nulls, columns: [REGION, TOTAL] }` |
| `unique` | no two rows have the same values in these columns | `{ type: unique, columns: [REGION] }` |
| `aggregate` | `sum`, `min`, `max`, `avg` or `count_distinct` of a column, give or take `tolerance` | `{ type: aggregate, column: TOTAL, fn: max, equals: 15, tolerance: 0.01 }` |
| `rows_equal` | the exact rows: matched on `key`, then the other columns your rows name are compared | see the finished file |
| `sql` | your own SELECT, which returns one row with one column | see the finished file |

`rows_equal` passes only when every expected row is there once, with the values you wrote, and no other row came back. Columns your rows don't name aren't compared, so you can check two columns of a wide view. It compares up to 10,000 rows.

`sql` is for anything the others don't cover. `{{checkpoint}}` stands for the step's result: give it an alias (`AS c`) and quote column names (`c."TOTAL"`). The query must be one SELECT. It can't read any real table or view, use `?`, or use `WITH`, and the run refuses it before sending if it does. In YAML, wrap it in single quotes and double each single quote inside (`''4''`).

## Writing values

- **Numbers** as numbers: `TOTAL: 15` matches the decimal `15.00`.
- **Text that looks like a number** in quotes: `"007"` stays `"007"`, while `007` would be the number 7.
- **Dates** as `"2026-01-15"`, **timestamps** as `"2026-01-15 10:30:00"`.
- **Booleans** as `true` or `false`; **empty** as `null`.
- Each value is cast to the column's type, so a value that doesn't fit (a date in a number column) makes the check `ERROR` with the database's message.

## When it doesn't run

- **"The scenario can't run, so nothing is sent"**: a fixture names no table of the pipeline, names a view, has a column the table doesn't have, or uses CSV. Each line says which.
- **A check marked `-`**: its checkpoint isn't a step of the pipeline, can't be simulated, or is a data flow. The line says why.
- **`STOPS:` on a step**: that step can't be compiled (for example, it is over SAP HANA's limit of bound values), and neither can the steps after it. Give rows to a table after it to test the rest.
- **`... isn't in the scan`**: scan the space again, or give `--from`.

## What it doesn't do yet

- Scenarios aren't stored in the app, run on a schedule or written in a visual builder.
- Transformation flows run as a full load: a flow that reads its own target sees it empty.
- `CURRENT_DATE` and other session values aren't fixed, so a step that uses them gives a result that depends on the day.
