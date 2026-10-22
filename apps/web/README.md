# @ystara/web

The browser app: tenants, scans, the objects a scan found, the pipeline behind any object as a lineage picture, and snapshots of saved pipelines and their comparison. Built with Vite and React, UI5 Web Components for the Fiori controls, React Flow for the picture and dagre to lay it out. It wears the youlytics brand (sapphire, amber for the one main action of a page, IBM Plex Sans and Mono, a 4px spacing scale) and follows the system's light or dark mode.

## Running it

- **With Docker** (`docker compose up -d --build`): the API serves the built app on http://127.0.0.1:4000.
- **While changing it** (`npm run dev:web`): Vite serves it on http://127.0.0.1:5173 and reloads on every save. Calls to `/api` are forwarded to the API on `YSTARA_API_PORT` (4000 unless set in `.env`), so start the API too: Docker, or `npm run dev:api` with `docker compose up -d postgres migrate`.

The app only ever calls `/api` on its own origin and loads nothing from other servers (fonts included, see `src/fonts.ts`).

## Pages

| URL | Page | File |
|---|---|---|
| `/sign-in` | Email and password, then the code from the authenticator app | `src/pages/SignInPage.tsx` |
| `/invite/:token` | An invitation link: choose a password and set up the authenticator app, or join with an existing sign-in | `src/pages/InvitePage.tsx` |
| `/reset/:token` | A reset link from the operator: choose a new password and set up the authenticator app again | `src/pages/ResetPage.tsx` |
| `/users` | Users and roles (admins): members with their role and spaces, open invitations, invite someone (a role other than admin can be limited to some spaces) | `src/pages/UsersPage.tsx` |
| `/alerts` | Alerts (admins): the account's Teams channel | `src/pages/AlertsPage.tsx` |
| `/audit` | Audit log (admins): every change and sign-in in the account, filtered by person, kind and days, and as CSV | `src/pages/AuditPage.tsx` |
| `/operator` | The operator panel (operators only): every account and user, create an account, invite a new admin, reset someone's sign-in | `src/pages/OperatorPage.tsx` |
| `/` | Opens Home of the tenant picked last in this browser, or of the first tenant; Tenants when there is none | `src/App.tsx` |
| `/tenants` | Tenants (menu, bottom): every tenant of the account; add one by its Datasphere URL, then its Connect wizard opens | `src/pages/TenantsPage.tsx` |
| `/tenants/:id` | Home: the tenant at a glance (a card per app), the one next step that applies, Delete tenant in "…" for admins | `src/pages/TenantHomePage.tsx` |
| `/tenants/:id/discovery` | Discovery: the scans (refreshed while one runs) and Scan spaces (picks from the spaces the client reads; `?scan=1` opens it) | `src/pages/DiscoveryPage.tsx` |
| `/tenants/:id/pipelines` | Pipelines: the saved pipelines | `src/pages/PipelinesPage.tsx` |
| `/tenants/:id/connection` | Connection › Technical client: Connect, Check again, Change spaces, and Change client and Remove client in "…"; each space readable or not (`?connect=1` opens Connect) | `src/pages/TenantConnection.tsx` |
| `/tenants/:id/database-users` | Connection › Database users: one per space for snapshots, with what each sees | `src/pages/DatabaseUsers.tsx` |
| `/scans/:id` | A scan's status and warnings, and its objects; likely outputs first | `src/pages/ScanPage.tsx` |
| `/scans/:id/pipeline?output=SPACE.NAME&excludeWriter=...` | The pipeline behind one object on that scan; exclude writers, save it | `src/pages/PipelinePages.tsx` |
| `/pipelines/:id` | A saved pipeline, on the tenant's latest successful scan: the Lineage tab (the picture or the steps in order), Take snapshot | `src/pages/PipelinePages.tsx` |
| `/pipelines/:id/snapshots` | Its Snapshots tab: the schedule, the snapshots, and Compare | `src/pages/PipelinePages.tsx`, `src/pages/Schedule.tsx`, `src/pages/Snapshots.tsx` |
| `/pipelines/:id/compare?from=&to=` | Two snapshots compared, the latest two by default | `src/pages/ComparePage.tsx` |
| `/snapshots/:id` | One snapshot: the measures of each step | `src/pages/Snapshots.tsx` |
| `/pipelines/:id/scenarios`, `/pipelines/:id/scenarios/new`, `/scenarios/:id` | Its Scenarios tab, Run all, and the builder | `src/pages/PipelinePages.tsx`, `src/pages/Scenarios.tsx` |
| `/scenario-runs/:id`, `/scenario-suites/:id` | One scenario's run, and one run of all of a pipeline's scenarios | `src/pages/Scenarios.tsx` |
| `/pipelines/:id/history` | Its History tab: the sign-off (Sign off for test coordinators and admins), two charts (scenarios passing per suite, output rows per snapshot) and the timeline, as CSV too | `src/pages/History.tsx`, `src/components/Charts.tsx` |
| `/pipelines/:id/report` | The pipeline's report, without the app's menu, to print or save as PDF | `src/pages/ReportPage.tsx` |

Every page works as a link: the API answers these paths with `index.html` and `src/App.tsx` picks the page. Every page except sign-in, invitation and reset links needs a signed-in user: `App.tsx` sends anyone else to `/sign-in?next=<the page>` and back after signing in. The user menu (top right) shows the account and role, switches accounts and signs out.

## How it fits together

- `src/components/AppFrame.tsx`: the frame of every signed-in page, laid out like Datasphere with UI5's `NavigationLayout`. The top bar has the menu button, the **tenant picker** and the user menu; the side menu has the apps of the picked tenant (Home, Discovery, Pipelines, Connection with Technical client and Database users) and, at the bottom, Tenants, Users and roles (admins) and Operator (operators). On a window under 600 px the menu is hidden until the menu button opens it, and it closes on a pick. Connection is a `SideNavigationGroup`, not a parent item: its title only folds it, where a parent item's click would also close the menu on a phone, and a selectable parent draws a divider next to its arrow. `appOf` says which app an address belongs to: scans are Discovery's, pipelines and snapshots Pipelines'. A component given to a layout slot (`header`, `sideContent`) gets the slot name as a `slot` prop and must put it on the element it renders, or the layout shows nothing in that slot.
- `src/tenantScope.tsx`: the picked tenant, remembered in this browser per account (`localStorage`, read and written in try/catch). A page under `/tenants/:id` picks its tenant (`useAddressTenant`); scans, pipelines and snapshots pick theirs (`useInTenant`). Nothing loads data by it: every page loads by the IDs in its address.
- `src/api.ts`: every API call, as hooks on TanStack Query (caching, refetching while a scan runs). Response types come from `packages/shared/src/api.ts`, the same types the API sends. `useMe()` is who is signed in; `useCan()` hides buttons the role can't use (the API checks every call anyway). A 401 on any call sends the browser back to sign-in (`src/main.tsx`).
- Sign-in fields are plain `<input>` elements styled like UI5's (`src/components/AuthFrame.tsx`), so password managers and the browser's one-time-code fill find them. `src/components/SetUpSignIn.tsx` is the password-then-authenticator setup that invitation and reset links share, and `src/components/LinkToSend.tsx` shows a new link once, with a Copy button.
- `src/lineage/`: the picture. `model.ts` turns a pipeline into nodes and edges with what to mark on them (output, entry table, excluded writer, several writers, loop); `layout.ts` sizes each node to its names and places them left to right; `viewport.ts` picks the first view and places the hover card; `LineageGraph.tsx` and `ObjectNode.tsx` draw them; `ObjectPanel.tsx` shows the selected object; `PipelineView.tsx` puts it together. The first three are plain functions with tests.
- `src/objectTypes.ts`: names and colours per object type (views sapphire, flows amethyst, tables grey, analytic models amber; brand tokens, so dark mode works).
- **The brand** (`src/brand.ts`): UI5 draws with its theme's parameters (`--sap…` CSS variables), so the brand takes the Horizon and Horizon Dark parameters, swaps each SAP colour for its youlytics colour, sets the ones that need a decision (the amber primary button with ink text, calm status tags, 40px controls, 10px corners, Plex for every font) and adds `--ystara-…` tokens for what `app.css` draws itself. `src/brand.test.ts` checks that no SAP blue, green or yellow is left and that every text colour reads on its ground (4.5:1). `app.css` keeps to the 4px scale (`--space-1` to `--space-8`): a page's blocks are 24px apart, a section is a white card with 24px inside. Pages follow the same pattern: `PageHeader` (breadcrumbs as a caption, a 34px title, a muted line), one amber action at most (`design="Emphasized"`), and rarely used actions such as Delete in a "…" menu (`components/MoreActions.tsx`); an empty list shows `components/EmptyState.tsx` with the one action that fills it. The mark in `components/Logo.tsx` is a stand-in until the brand's own files are in the project.
- `src/columns.ts`: how wide a table column of technical names must be (`monoColumnWidth`, given to a `TableHeaderCell`'s `minWidth`): as wide as its longest name, up to the table's width. The other columns shrink, then move under the row (`overflowMode="Popin"`, by `importance`), before a name breaks; only a name wider than a phone's screen wraps. Every table with technical names uses it; `npm run db:demo` adds names of up to 50 characters to look at.
- `src/theme.ts`, `src/fonts.ts`, `src/locale.ts`, `src/icons.ts`: UI5 setup (light or dark theme, the bundled IBM Plex fonts and English locale data instead of UI5's CDN downloads). UI5 draws only icons that are imported in `icons.ts`.

## Dependencies

All packages are `devDependencies`: Vite bundles them into `dist/` at build time and nothing is needed at run time, so the Docker image prunes them. The UI5 packages move together (`~2.27`); after an update, `src/brand.test.ts` says which new SAP colours the brand map lacks. The fonts come from `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` (weights 400, 500 and 600, latin and latin-ext; `src/fontFaces.test.ts` checks the faces).

## Tests

`npm test -w @ystara/web`: the lineage model and layout, the column widths, the brand's colours and contrast, and the font faces. Pages are checked by clicking through them; there are no browser tests in CI yet.
