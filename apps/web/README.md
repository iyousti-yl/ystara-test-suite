# @ystara/web

The browser app: tenants, scans, the objects a scan found, and the pipeline behind any object as a lineage picture. Built with Vite and React, UI5 Web Components for the Fiori look, React Flow for the picture and dagre to lay it out. It follows the system's light or dark mode.

## Running it

- **With Docker** (`docker compose up -d --build`): the API serves the built app on http://127.0.0.1:4000.
- **While changing it** (`npm run dev:web`): Vite serves it on http://127.0.0.1:5173 and reloads on every save. Calls to `/api` are forwarded to the API on `YSTARA_API_PORT` (4000 unless set in `.env`), so start the API too: Docker, or `npm run dev:api` with `docker compose up -d postgres migrate`.

The app only ever calls `/api` on its own origin and loads nothing from other servers (fonts included, see `src/fonts.ts`).

## Pages

| URL | Page | File |
|---|---|---|
| `/` | Tenants; add one by its Datasphere URL | `src/pages/TenantsPage.tsx` |
| `/tenants/:id` | A tenant's scans (refreshed while one runs), "Scan spaces", saved pipelines | `src/pages/TenantPage.tsx` |
| `/scans/:id` | A scan's status and warnings, and its objects; likely outputs first | `src/pages/ScanPage.tsx` |
| `/scans/:id/pipeline?output=SPACE.NAME&excludeWriter=...` | The pipeline behind one object on that scan; exclude writers, save it | `src/pages/PipelinePages.tsx` |
| `/pipelines/:id` | A saved pipeline, on the tenant's latest successful scan | `src/pages/PipelinePages.tsx` |

Every page works as a link: the API answers these paths with `index.html` and `src/App.tsx` picks the page.

## How it fits together

- `src/api.ts`: every API call, as hooks on TanStack Query (caching, refetching while a scan runs). Response types come from `packages/shared/src/api.ts`, the same types the API sends.
- `src/lineage/`: the picture. `model.ts` turns a pipeline into nodes and edges with what to mark on them (output, entry table, excluded writer, several writers, loop); `layout.ts` places them left to right; `LineageGraph.tsx` and `ObjectNode.tsx` draw them; `ObjectPanel.tsx` shows the selected object; `PipelineView.tsx` puts it together. The first two are plain functions with tests.
- `src/objectTypes.ts`: names and colours per object type (theme colours, so dark mode works).
- `src/theme.ts`, `src/fonts.ts`, `src/locale.ts`, `src/icons.ts`: UI5 setup (light or dark theme, the bundled 72 font and English locale data instead of UI5's CDN downloads). UI5 draws only icons that are imported in `icons.ts`.

## Dependencies

All packages are `devDependencies`: Vite bundles them into `dist/` at build time and nothing is needed at run time, so the Docker image prunes them. The UI5 packages move together (`~2.27`), and `@sap-theming/theming-base-content` must match the font files UI5 expects (`src/fontFaces.test.ts` checks).

## Tests

`npm test -w @ystara/web`: the lineage model and layout, and the font check. Pages are checked by clicking through them; there are no browser tests in CI yet.
