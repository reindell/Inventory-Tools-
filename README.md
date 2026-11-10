# SDP Inventory

Inventory management for **SHINDENGEN ELECTRIC MFG.CO.,LTD**, branded **SDP**, for **one production location**. React/TypeScript frontend, Express API, Microsoft SQL Server ledger, private image storage, roles, reports and Admin branding controls.

Source, tests, native SQL Server migrations and deployment configuration are included. The Docker deployment uses SQL Server 2022 Express with separate migration/runtime accounts. No remote deployment or automatic transfer of earlier PostgreSQL data has been performed. Docker networking, production storage/SMTP and final TLS still need target-server checks.

## Run locally

Requires Node.js 24 and npm. Docker is optional for local evaluation.

```powershell
npm ci
npm run brand:generate
npm run dev
```

Open **http://127.0.0.1:5173**. The API listens on port 3001. With no `DATABASE_URL`, this command retains the earlier embedded PostgreSQL-compatible development store. It is an explicit local evaluation option; it does not install or impersonate Microsoft SQL Server. To develop against SQL Server, provision an empty database and set `DATABASE_URL` before starting, as shown in [SQL Server setup](docs/sql-server.md). The first development start applies the selected engine's migrations and seeds sample stock. Startup may take several seconds.

Your unique local Admin email/password are stored in **`.data/bootstrap.json`**. No shared default password is embedded in the app. The file is private local state and ignored by Git. Alternatively, set `ADMIN_EMAIL` and a 12–128-character `ADMIN_PASSWORD` before the first seed. Existing accounts are never overwritten by a later seed.

Local state lives in `.data/`: database, private uploads, development signing secrets, and `.eml` mail when no SMTP URL is configured. These files are for development only. Do not commit, publish, or use the sample stock as real opening balances. Changing `.env` secrets/account values does not alter existing user passwords. Local evaluation needs no `.env`; `.env.example` is a **production** template.

## Microsoft SQL Server with Docker

Use [the SQL Server setup and cutover guide](docs/sql-server.md) for the complete workflow. On the private server with Docker installed:

```powershell
node scripts/configure.mjs inventory.example.internal admin@example.com
# Set SMTP_URL and review the new .env values.
docker compose up --build -d
docker compose ps
```

The SQL Server container uses the production-capable Express edition and a separate `sqlserver_data` volume. It has no publicly exposed database port. The migration container creates the database and restricted runtime role; the web app never receives the SA password. An existing `.env` is preserved: when upgrading earlier setup, add `SQLSERVER_SA_PASSWORD` and ensure all database passwords satisfy SQL Server complexity rules. Application hostname/TLS trust and SMTP must be configured for your server.

Earlier PostgreSQL data and volumes stay intact. Changing the connection URL does not move their records. A reviewed migration must preserve IDs, photos, ledger/audit history and outstanding loans; ordinary CSV import is not a complete database migration. Never delete old volumes to switch database engines.

## Included workflows

- Tools and jigs use the same item photo gallery in the catalog and requests. Admins and Managers can add/change photos from Item detail.
- Staff accounts can browse tools, choose a requested quantity, track their own requests and cancel before issue. They cannot edit inventory, change stock, view global movements or access Admin controls. Invite regular users with the **Staff** role; Viewer stays read-only.
- Admins receive in-app and email notifications, approve/reject requests, record actual quantities handed over and monitor who holds each tool. Separate approval does not reserve or deduct stock; **Issue tools** performs the deduction. Partial returns restore inventory and reduce outstanding quantities. Creation, issue and return are protected against duplicate submissions.
- Dashboard with item/unit totals, in-stock counts, low/out-of-stock attention and a recent movement ledger. Pricing and costs are excluded from the production workflow.
- Inventory search/scanner input, category/stock/status filters, sorting and pagination; responsive cards on phones.
- Unique normalized SKU/barcode constraints, live identity checks, item editing/drafts, zero-stock archival and restoration. Admins and Managers can use Add item, Edit item, Archive item and Restore item directly from Inventory; archived items stay available through the Status filter.
- Stock receipts, issues and adjustments with reasons, serial tracking, nonnegative balance constraints, row locks, optimistic versions, UUID idempotency keys and immutable audit history.
- Up to five item photos: upload/drop, progress, re-encoded WebP/thumbnails, order/primary controls, removal and keyboard-accessible zoom. Manage photos on Item detail after creating an item.
- CSV validation preview, explicit import commit, downloadable row errors, repeat-safe partial results and formula-safe exports.
- Branded stock PDF reports and Code 128 SKU/barcode labels with an optional logo. CSV files are text; use the stock PDF for a branded printable report.
- Login, invite activation, password reset, token rotation/reuse detection, role-based access and Admin account management.
- Admin logo settings, safe logo validation/rasterization, dynamic favicon/manifest and audited changes. Company identity stays **SHINDENGEN ELECTRIC MFG.CO.,LTD**; the Company details editor is removed.
- Durable request/low-stock/invitation/reset email outbox with retries. The notification bell updates automatically; local mail writes `.eml` files and production email requires SMTP.

## Supplied Excel samples

The default development sample catalog now comes from **`Sample of tools and jigs/SIP Assembly Jigs.xlsx`**: 135 entries across 12 sheets, with original photos for 130 entries. Merged quantity rows are counted once. Sample availability uses SPARE + STOCK; original IN-USE counts and source remarks remain reference information, without inventing borrower assignments. Admin-confirmed new handovers display **In use** until returned.

Fresh development databases load the catalog automatically. To add it to an existing local database, stop the development API if it owns the embedded database, then run:

```powershell
npm run db:samples -- --dry-run
npm run db:samples -- --with-stock
```

Use `--catalog-only` to add names/photos without opening quantities. Existing SKUs, edits, balances and photos are skipped rather than overwritten, so repeats do not duplicate stock. Production keeps samples disabled by default. For a configured Docker deployment, use `docker compose exec app node dist-server/cli.js samples --catalog-only`, or explicitly choose `--with-stock` after verifying the sample counts. Four inconsistent workbook totals are reported in the [sample extraction/import notes](samples/sip-assembly-jigs/README.md).

## SDP branding

The original Shindengen logo and official website mark are bundled in [`public/brand/`](public/brand/README.md), including source links and checksums. The logo keeps its original blue `#003e6f`; dark surfaces use a white backing plate. Login, navigation, new emails, PDF reports and labels share the same brand resolver. Browser and app icons use the official mark. The clean **SDP** text wordmark remains an asset-failure fallback. Application action colors remain provisional.

Expected full/mark files and optional dark variants are listed in the brand contract. Run `npm run brand:generate` after replacing the mark, then rebuild. Admin uploads override bundled logos and propagate to navigation, login, new email, PDF reports, labels and browser icons. Removing an override restores Shindengen artwork. Replacements are stored privately with random names; original uploaded SVG never reaches the browser.

The page-title format is `SDP Inventory | {Page}`. Theme tokens and accessibility policy are in [`DESIGN.md`](DESIGN.md) and [`UX-CONTRACT.md`](UX-CONTRACT.md). The provisional palette passed numeric text-pair checks and automated browser AA checks; manual assistive-technology review is still recommended. Confirm the timezone, production name, logo and color values before live use. Items, CSV exports and PDF reports track quantities without prices or costs. Historical stored amounts remain intact internally, and old CSV price columns are ignored during import.

## Verify

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:a11y
npm run format:check
npm audit
```

The default API suite runs against the legacy in-memory development engine. For native Microsoft SQL Server integration, use an **isolated disposable** database:

```powershell
$env:TEST_DATABASE_URL = 'mssql://TEST_USER:URL_ENCODED_PASSWORD@localhost:1433/sdp_test?encrypt=true&trustServerCertificate=true'
npm test
Remove-Item Env:TEST_DATABASE_URL
```

The suite writes test fixtures and permission probes to that database; never use a live database URL. CI provisions SQL Server 2022 Express and runs the same API/request suites and native permission checks, then browser tests against a separate SQL Server database. Browser tests start isolated API/web servers on ports 3002/5174 and use generated test credentials/data. Reports appear under `playwright-report/`; verified UI screenshots appear under `docs/screenshots/`.

To check compiled bundles after building, set `E2E_BUILT=true` before the browser command. Results and target-server verification limits are recorded in [docs/verification.md](docs/verification.md).

## Private-server Docker deployment

On the target server, install Docker Engine and Compose, then:

```sh
node scripts/configure.mjs inventory.example.internal admin@example.com
# Edit .env: supply SMTP_URL, review sender, hostname and all deployment values.
docker compose up --build -d
docker compose ps
```

The configuration helper creates fresh secrets and refuses to overwrite `.env`. It never prints passwords. The initial production Admin password is in `.env`; protect that file and change the password after first sign-in. Production seeds only the Admin unless `SEED_SAMPLE_DATA=true` is explicitly set.

Only Caddy ports 80/443 are published. The private-server Caddy configuration uses its internal CA; trust that CA on managed client devices. For approved public DNS/ACME deployment, adjust `infra/Caddyfile` as documented in the [security and deployment guide](docs/security.md). `APP_ORIGIN` must exactly match the employee-facing HTTPS URL. SQL Server and MinIO remain private; MinIO's application account is restricted to the private inventory bucket. Database migrations use the owner login; the app uses `sdp_app` with the restricted `sdp_runtime` database role.

The deployment includes a single API process with a leased outbox worker, persistent database/object/CA volumes, health checks, non-root app execution, resource limits and graceful shutdown. Configure monitoring, encrypted off-host backups and a restore drill. Do not delete live volumes to update the app. See [implementation decisions and limits](docs/implementation.md) before scaling or adding locations.

The reference object-storage container is built from pinned MinIO source releases; its build needs Go module downloads and can take several minutes. The upstream community repositories are archived, and registry image checks failed here. Review storage maintenance/patch ownership before live use, or configure a maintained S3-compatible service. This Docker/source-build path is supplied but has not been executed in this workspace.

## API and database operations

- API base: `/api/v1`. OpenAPI: authenticated `GET /api/v1/openapi.json`; Swagger assets: `/api/v1/docs` (requires authenticated requests). Use a client that sends the Bearer token; documentation is not exposed publicly.
- Mutations require an exact allowed `Origin`, signed CSRF cookie and matching `X-CSRF-Token` from `GET /api/v1/auth/csrf`. Stock mutations additionally require a UUID `Idempotency-Key` and current balance version.
- `npm run db:migrate` applies versioned SQL; `npm run db:seed` creates the initial Admin and development samples where allowed; `npm run db:reconcile` reports ledger/serial discrepancies without changing balances.
- Native SQL Server schema and permissions: [`migrations/mssql/`](migrations/mssql). Earlier PostgreSQL migrations remain in [`migrations/`](migrations) for legacy data. DTOs: [`shared/contracts.ts`](shared/contracts.ts). Parameterized repositories and a tested SQL Server dialect adapter keep ledger locks and constraints explicit.
- Future schema changes require new migrations. Review production image digests/scans before release. Dependency lockfiles cover JavaScript packages, not Docker image vulnerabilities.

## Project map

```text
src/                   React pages, shared UI, API client, theme
server/                Express routes, services, SQL, auth, storage, workers, reports
shared/                Shared typed DTOs and validation
migrations/            Legacy PostgreSQL migrations; mssql/ contains native SQL Server schema/grants
public/brand/          Original Shindengen logo/mark and generated browser/app icons
scripts/               Icon generation, build worker copy, deployment configuration
infra/                 TLS proxy, database and private-storage bootstrap
tests/                 API/security/contrast tests and Playwright browser journeys
docs/                  Architecture, decisions, security and verification evidence
```

The initial [Phase 1 proposal](docs/phase-1.md) is preserved for context. The maintained [implementation decisions](docs/implementation.md) record changes from it. Operational and release checks are in [docs/security.md](docs/security.md).
