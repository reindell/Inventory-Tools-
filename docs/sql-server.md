# Microsoft SQL Server setup and data transition

The default Docker deployment now runs **Microsoft SQL Server 2022 Express**, not PostgreSQL. The application uses `node-mssql` with its Tedious driver, native T-SQL migrations under `migrations/mssql`, real SQL Server transactions, update/key-range/application locks, JSON checks, filtered indexes and append-only history triggers. Express permits production use within its edition limits, including a 10 GB relational database limit. Use a properly licensed larger edition when needed; review [Microsoft edition limits](https://learn.microsoft.com/en-us/sql/sql-server/editions-and-components-of-sql-server-2022) and the [official container setup](https://learn.microsoft.com/en-us/sql/linux/quickstart-install-connect-docker?view=sql-server-ver16).

The original PostgreSQL driver and `.data/postgres` store remain available for legacy local development and fast tests. Supplying an `mssql://` URL always selects SQL Server; connection failure never falls back to embedded storage. The company remains Shindengen. No existing database is erased, converted or automatically copied.

## Private server with Docker

1. Install Docker Engine/Compose with Linux-container support on a server meeting [Microsoft's requirements](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-setup). Reserve at least 3 GB for the SQL Server container, plus the application/storage/proxy requirements. The configuration uses Express, not a development-only edition.
2. Generate configuration with `node scripts/configure.mjs inventory.example.internal admin@example.com`. A new `.env` includes distinct complex SA, migration-owner and runtime passwords. Existing `.env` files are preserved: add `SQLSERVER_SA_PASSWORD` and review database-password complexity manually if upgrading an earlier configuration. Generated values are safe for the supplied URL interpolation; percent-encode reserved URL characters when hand-writing connection URLs.
3. Set SMTP and the other private-server values described in `.env.example`. `SQLSERVER_TRUST_SERVER_CERTIFICATE=true` trusts the SQL container's local certificate while still encrypting the database connection. Install a trusted SQL Server certificate and set this to `false` for environments requiring certificate validation. SQL Server has no host port mapping in the production Compose file.
4. Run `docker compose up --build -d`. The SQL service stores data in a new `sqlserver_data` volume. A one-shot migration container creates `sdp`, creates `sdp_owner` and `sdp_app` only if absent, applies native migrations and creates the initial Admin. The app receives only the runtime login; SA and owner credentials are confined to setup.
5. Check `docker compose ps` and `docker compose logs --tail=100 migrate app`. Open the configured HTTPS hostname after trusting/configuring the proxy certificate. Do not paste logs containing credentials or `.env` contents into chat.

The first application seed creates the Admin only unless `SEED_SAMPLE_DATA=true`. In SQL Server Management Studio, connect using an authorized administrative route to the server/database; do not expose port 1433 publicly. For an existing SQL Server, create an empty application database and separate migration/runtime users, use equivalent native grants, and set `DATABASE_URL` to that server. Neither application startup nor migration changes server authentication mode, TCP configuration, existing login passwords or unrelated databases.

`sdp_runtime` can work with inventory and requests, but cannot update/delete ledger, serial history, request history or audit history, write the schema-migration table, or create/delete singleton company/location records. Native triggers also reject history mutation for database owners. Schema setup is an administrative action; never give the app `sa` or `db_owner`.

## Local development with SQL Server

After provisioning an empty development database and a SQL Server login:

```powershell
$env:DATABASE_URL='mssql://sdp_owner:URL_ENCODED_PASSWORD@localhost:1433/sdp?encrypt=true&trustServerCertificate=true'
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. On a local Windows SQL Server Express instance, an explicitly selected Windows-authentication URL is also supported:

```powershell
$env:DATABASE_URL='mssql+windows://localhost/sdp?instance=SQLEXPRESS2022&encrypt=false&trustServerCertificate=true'
npm run dev
```

This Windows-only path uses the optional `msnodesqlv8` driver and installed Microsoft ODBC Driver 18, with the current Windows user's existing database permissions. It does not change SQL Server configuration or obtain another user's credentials. Docker uses the portable SQL-login driver. Change the instance/database names to your existing authorized instance; the application does not create databases through normal startup.

With no `DATABASE_URL`, the existing local PostgreSQL-compatible development database remains available. This is an explicit legacy development option and is forbidden as an embedded production database.

## Preserve earlier PostgreSQL data

The new `sqlserver_data` volume is separate from any older `postgres_data` volume and `.data/postgres` folder. Keep those older stores intact. Do not run `docker compose down -v`, remove old volumes, or copy PostgreSQL data files into SQL Server. A connection-URL change does not transfer records.

Before a real cutover, freeze writes and take a PostgreSQL logical backup plus a matching snapshot of private image/object storage. Restore into an isolated PostgreSQL instance to verify the backup. Use a reviewed one-time ETL into a **new empty SQL Server database**, preserving UUIDs, UTC timestamps, normalized SKU/barcode/serial identifiers, users and password hashes, image object keys, balances, idempotency links, movements, audit/serial/request history, and outstanding request/return ownership. Load referenced records before their dependents, account for SQL Server filtered-null uniqueness and bounded Unicode columns, and retain immutable history through inserts. Revoke existing sessions/reset/invitation tokens at cutover; reissue invitations and unfinished email jobs deliberately rather than delivering stale links twice. No automatic ETL has been executed or claimed by this change.

CSV import/export alone is **not** a full migration: it does not retain audit history, user identities, photos, serial ownership or outstanding loans. For a deliberately fresh opening inventory, archive the old system, import item definitions, and enter verified opening balances through the ledger. Choose this only when retaining the archived history separately meets the company's requirements.

Validate source/target row counts, UUID references, image reads, current and outstanding quantities, request statuses, ledger reconciliation and representative reports before switching employees to SQL Server. Keep the source backup and a rollback window. Run `npm run db:reconcile` against the target and verify that existing accounts can log in with the expected roles.

## Verification and backup

Set `TEST_DATABASE_URL` only to an isolated disposable test database. `npm test` runs native SQL Server permission probes when that URL selects SQL Server, plus all API and request tests. Set `E2E_DATABASE_URL` separately to an empty isolated SQL Server browser-test database; browser fixtures generate their own users and never inherit the app's normal database URL. CI provisions separate SQL Server API and browser databases. Development tests without a test URL use the embedded engine and do not establish native SQL Server verification by themselves.

The implementation was also exercised against an isolated local SQL Server 2022 Express database using Windows authentication, including the existing API suite and request workflow. The Docker/Tedious network path, final certificate trust, production storage/SMTP and container resource sizing still need deployment checks; a local Windows engine run does not prove those paths.

For production, use SQL Server `BACKUP DATABASE`/`RESTORE DATABASE` with company-approved encrypted, off-host backups and a coordinated private-image snapshot. Test restoration to an isolated server and reconcile the ledger and outstanding loans before relying on backups. SQL Server Express has no SQL Server Agent: schedule backups through the operating system or the organization's backup service. Never replace a SQL Server restore drill with PostgreSQL backup commands from the historical proposal.
