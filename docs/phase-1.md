# Phase 1 — SDP Inventory architecture

Status: approved, including all subsequent phases, by the user. This document preserves the Phase 1 proposal. See `implementation.md` and the root README for the implemented system, deliberate architecture changes and actual verification limits. The later approval supersedes the phase-by-phase pauses below. A subsequent user request removed pricing: references below to price/cost entry, currency settings and stock-value reporting are historical proposal details, superseded by the quantity-only workflow. The user also removed Company details editing and fixed the company identity to SHINDENGEN ELECTRIC MFG.CO.,LTD; the proposed company-name/timezone editor and settings mutation below are superseded, while Admin logo management remains available. Later requirements added tool/jig borrowing with request-only Staff access, Admin approval followed by issue, borrowed/returned quantities and notifications. Microsoft SQL Server replaces PostgreSQL as the deployment database; PostgreSQL details below describe the original proposal and retained legacy test backend.

## Decisions and assumptions

| Topic                 | Decision                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application / company | SDP Inventory / SHINDENGEN ELECTRIC MFG.CO.,LTD                                                                                                                 |
| Brand reference       | User-provided https://www.shindengen.com/; official assets and approved hex values still pending                                                                |
| Locations             | One production location only, confirmed by the user; seed as Production until its actual name is supplied                                                       |
| Deployment            | Docker Compose on a private server behind a TLS reverse proxy                                                                                                   |
| Users                 | Internal users; invite-only account creation, four roles                                                                                                        |
| Inventory scope       | One company and one production location; no location switching, transfers, manufacturing BOM, production orders, or consumption automation in the initial scope |
| Quantities            | Whole units initially; prices and costs use fixed-point decimals, never binary floats                                                                           |
| Currency / timezone   | Configurable company settings; no currency inferred from company identity. Store timestamps in UTC; render in the selected timezone                             |
| Backend               | Node.js + TypeScript, Express, Zod, Prisma, PostgreSQL                                                                                                          |
| Frontend              | React + TypeScript, Vite, Tailwind, React Query, React Hook Form + Zod                                                                                          |
| Files / email         | Private S3-compatible storage, local MinIO; SMTP transport and a local mail catcher                                                                             |
| Testing               | Vitest for services and UI, PostgreSQL integration tests, Playwright for critical user journeys                                                                 |

No official color palette is inferred from screenshots or site appearance. An SDP text wordmark and provisional accessible colors are used until supplied brand files are available. This is an architecture proposal, not a claim of production readiness or a completed accessibility audit.

## Architecture and deployment

The browser uses a single HTTPS origin. The reverse proxy serves static frontend assets and forwards `/api/v1` to the API. The API applies request validation, authentication, CSRF protection, role checks, service rules, and repository access in that order. PostgreSQL is the authority for accounts, stock, and audit history. MinIO stores private images; the API authorizes access before issuing short-lived signed URLs.

A worker processes image optimization, CSV imports, PDF exports, and email from durable PostgreSQL job/outbox records. It retries transient failures with bounded backoff and records terminal failures. Stock transactions and their outbox records commit together, preventing email or job delivery from determining whether stock changes persist. Deduplicate alerts per item/location threshold crossing.

Compose services: proxy, web, API, worker, PostgreSQL, MinIO, plus a development-only mail catcher. Publish only proxy ports in production. Use separate least-privilege database/storage credentials, persistent volumes, health checks, restart policies, and resource limits. Run migrations once as a release job, not concurrently from API replicas. Back up database and object storage together; document and test restoration before launch. Pin dependency and image versions during implementation and record their lockfiles.

### Planned folder structure

```text
apps/
  web/
    public/brand/            # bundled files defined in root public/brand contract
    src/
      app/                  # router, providers, layout, error boundary
      components/           # Brand, table, dialog, upload, badges
      features/             # auth, dashboard, inventory, stock, users, settings
      styles/               # tokens and light/dark themes
  api/src/
    config/
    middleware/             # auth, roles, csrf, errors, logging, limits
    modules/                # each: routes, controller, service, repository, DTOs
    jobs/                   # images, imports, reports, mail, retention
    templates/              # branded email and PDF/print views
packages/
  contracts/                # Zod schemas, typed API DTOs, error codes
  branding/                 # shared resolver, asset manifest, token definitions
prisma/
  schema.prisma
  migrations/
  seed.ts
tests/
  integration/
  e2e/
infra/                      # Dockerfiles, proxy config, Compose
docs/                       # architecture, OpenAPI, operations, threat model
public/brand/               # canonical source; copied to web build, never duplicated manually
```

## Database schema

UUID primary keys for entities, except the fixed singleton location key specified below; UTC `timestamptz`; all foreign keys enforced. Use `numeric(19,4)` for prices/costs and nonnegative checks. Quantity is a bounded nonnegative bigint; DTOs serialize bigint and monetary values as decimal strings. Normalize SKU, barcode, email, and serial identity consistently before checking and writing. Preserve display strings separately where needed. Archived items retain their identifiers and history. Retain the location relationship internally for report identity; there is exactly one location and no location-management API.

| Table                       | Principal fields and constraints                                                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| users                       | id, email_normalized UNIQUE, display_name, password_hash, role enum, enabled, failed_login_count, locked_until, created_at, updated_at                                                                                     |
| invitations                 | id, email_normalized, role, token_hash UNIQUE, expires_at, accepted_at, invited_by FK users                                                                                                                                |
| refresh_sessions            | id, user_id FK, family_id, token_hash UNIQUE, expires_at, rotated_at, revoked_at; retain rotated-token hashes to detect reuse                                                                                              |
| password_reset_tokens       | id, user_id FK, token_hash UNIQUE, expires_at, consumed_at                                                                                                                                                                 |
| locations                   | singleton id with CHECK(id = 1), code UNIQUE, name; seeded once, no create/archive workflow; location FKs use this singleton key type instead of UUID                                                                      |
| categories                  | id, name_normalized UNIQUE, name, active                                                                                                                                                                                   |
| suppliers                   | id, name, contact fields, active                                                                                                                                                                                           |
| items                       | id, name, sku_normalized UNIQUE, sku, barcode_normalized UNIQUE nullable, category_id FK, supplier_id FK nullable, description, unit_price, unit_cost, serialized, status active/archived, version, created_at, updated_at |
| item_images                 | id, item_id FK, object_key UNIQUE, thumbnail_key, optimized_key, sort_order, is_primary, processing_status, created_at; partial UNIQUE(item_id) WHERE is_primary                                                           |
| stock_balances              | item_id FK, location_id FK, quantity CHECK >= 0, reorder_level CHECK >= 0, version, updated_at; composite PK(item_id, location_id)                                                                                         |
| stock_movements             | id, type in/out/adjustment, reason, note, actor_id FK, idempotency_record_id UNIQUE FK, created_at                                                                                                                         |
| stock_entries               | id, movement_id FK, item_id FK, location_id FK, delta CHECK != 0, unit_cost_snapshot, created_at; signed deltas and immutable rows                                                                                         |
| serial_units                | id, item_id FK, serial_normalized UNIQUE, serial, location_id FK, status in_stock/sold/damaged, version                                                                                                                    |
| serial_events               | id, serial_unit_id FK, movement_id FK, from/to location/status, actor_id FK, created_at                                                                                                                                    |
| idempotency_records         | id, actor_id FK, route, key, request_hash, response_status, response_json, expires_at; UNIQUE(actor_id, route, key)                                                                                                        |
| audit_events                | id, actor_id FK nullable, action, entity_type, entity_id, before/after redacted JSON, request_id, created_at; append-only application permissions                                                                          |
| brand_assets                | id, random object_key UNIQUE, checksum, verified_type, dimensions, email_derivative_key, uploader_id FK, created_at                                                                                                        |
| company_settings            | singleton id, company_name, app_name, currency_code, timezone, logo_asset_id FK nullable, brand_version, updated_by FK, updated_at                                                                                         |
| jobs / outbox               | id, type, payload, state, attempt_count, next_attempt_at, lease_until, deduplication_key UNIQUE nullable, created_at                                                                                                       |
| import_jobs / import_errors | actor_id FK, input_object_key, state, row_count, accepted/rejected counts; errors reference job, row_number, field, code, safe message                                                                                     |

Relationships: categories and suppliers each have many items. Items have many images, balances, stock entries, and serial units. Locations have many balances, stock entries, and serial units. A movement has many entries and serial events. Users create movements and audit records. Settings select one validated brand asset.

Indexes: unique SKU/barcode/email/serial keys; items(category_id, status, created_at, id); items(created_at, id); stock_entries(item_id, location_id, created_at, id); stock_movements(created_at, id); audit_events(entity_type, entity_id, created_at) and (actor_id, created_at); jobs(state, next_attempt_at). Add PostgreSQL trigram indexes for measured name/SKU search workloads. No destructive cascading deletes of ledgers or audit records.

### Stock invariants and concurrency

1. Every stock-changing request requires an Idempotency-Key. Reserve/check its record in the same database transaction as the stock write. Reusing a key with different input returns 409; identical concurrent requests converge on the committed response.
2. Create missing balance rows using conflict-safe inserts, then lock all affected balances in sorted item/location order with `SELECT ... FOR UPDATE`. Lock serial rows when relevant. Revalidate item status and permissions within the transaction.
3. Validate quantities, available stock, and serial ownership/status. Resolve the sole production location server-side rather than accepting arbitrary location IDs. Reject any operation that produces negative stock. The database nonnegative check provides a second guard.
4. Write immutable entries, update balance projections and serial units, append audit/outbox rows, and store the idempotent response atomically. Transfers are outside this release; adding another location requires a reviewed schema and API change.
5. An adjustment records a signed delta, reason, and expected balance version. If the version changed since the user opened the form, return 409 and request review of the fresh count. Corrections use compensating entries, never ledger edits.
6. Reconciliation verifies quantity equals the sum of ledger deltas and checks serialized quantities against in-stock serial units. Opening balances are ledger entries. Report discrepancies without silently changing balances.

Serialized stock requests supply exactly one unique serial number per unit. Selling or damaging a unit removes it from available stock and records a serial event; returns restore eligible units explicitly. Serialization mode cannot change after stock/history exists without a dedicated migration workflow. Archived items cannot receive normal stock operations; require zero balances before archive.

## REST API plan

Base `/api/v1`. All list endpoints accept validated search/filter/sort and bounded pagination; server-side sort fields are allowlisted. JSON errors use `{ error: { code, message, fieldErrors?, requestId } }`. Use 201 for creation, 202 for jobs, 204 for applicable no-body actions, 400 for malformed input, 401/403 for authentication/authorization, 404 for missing resources, 409 for duplicate/version/stock conflicts, 413 for oversized uploads, 422 for semantic validation, and 429 for limits. OpenAPI is generated from DTO definitions, with authenticated production documentation.

| Method and path                                    | Purpose / access                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| GET /auth/csrf                                     | Establish CSRF token; no privileged data                                                           |
| POST /auth/login, /auth/refresh, /auth/logout      | Login, rotate refresh token, revoke session; CSRF/origin protected                                 |
| GET /auth/me                                       | Current user and permissions                                                                       |
| POST /auth/forgot-password, /auth/reset-password   | Generic reset request and one-use reset token consumption                                          |
| POST /auth/accept-invitation                       | Invite-only registration; no public self-registration                                              |
| GET /dashboard                                     | Totals, value, alerts, recent movements, top movers for the sole production location; date filters |
| GET /items                                         | Search, category/status/stock filters, sort and pagination                                         |
| GET /items/check-identity?sku=&barcode=&excludeId= | Debounced identity availability; final writes still enforce uniqueness                             |
| POST /items                                        | Create item; Admin/Manager                                                                         |
| GET /items/:id                                     | Details, image metadata, stock balance                                                             |
| PATCH /items/:id                                   | Edit with expected version; Admin/Manager                                                          |
| POST /items/:id/archive, /items/:id/restore        | Soft archive or restore; Admin/Manager; audited                                                    |
| POST /items/:id/images                             | Stream validated image upload; Admin/Manager; maximum five, enforced under item lock               |
| GET /items/:id/images/:imageId/url                 | Authorized short-lived image URL                                                                   |
| PATCH /items/:id/images                            | Atomic reorder and primary selection; Admin/Manager                                                |
| DELETE /items/:id/images/:imageId                  | Remove association and schedule object cleanup; Admin/Manager                                      |
| GET /items/:id/serials                             | Paginated unit status and serial search                                                            |
| GET /items/:id/movements, /movements               | Per-item or global filterable stock history                                                        |
| POST /stock/in, /stock/out                         | Atomic ledger changes for the sole production location; Admin/Manager/Staff                        |
| POST /stock/adjustments                            | Audited count correction; Admin/Manager                                                            |
| PATCH /items/:id/stock-settings                    | Set reorder level for the sole production location; Admin/Manager                                  |
| GET /alerts/low-stock                              | Low and out-of-stock balances                                                                      |
| GET /categories, /suppliers                        | Lookup lists                                                                                       |
| POST /categories, /suppliers                       | Create lookup; Admin/Manager                                                                       |
| PATCH /categories/:id, /suppliers/:id              | Update/archive lookup; Admin/Manager                                                               |
| POST /imports/items                                | Upload CSV for validation preview; Admin/Manager                                                   |
| GET /imports/:id, /imports/:id/errors              | Job progress, row errors and downloadable error CSV; owner/Admin                                   |
| POST /imports/:id/commit                           | Commit validated rows after explicit review; Admin/Manager                                         |
| GET /exports/items.csv                             | Filtered CSV; all authenticated roles                                                              |
| POST /reports/stock                                | Branded PDF job using filters, currency, timestamp, location and requesting user                   |
| POST /labels                                       | Printable SKU/barcode labels with optional logo; all authenticated roles                           |
| GET /jobs/:id, /jobs/:id/download                  | Authorized progress/download, restricted to requesting user or Admin                               |
| GET /users                                         | User list; Admin only                                                                              |
| POST /users/invitations                            | Invite with assigned role; Admin only                                                              |
| PATCH /users/:id                                   | Role or enabled state; Admin only, revoke affected sessions                                        |
| GET /settings/branding                             | Public-safe active company name and validated logo metadata; available to login                    |
| GET /settings                                      | Company settings; Admin only                                                                       |
| PATCH /settings                                    | Company name, currency/timezone settings; Admin only, audited                                      |
| POST /settings/logo                                | Validate and publish replacement logo; Admin only, audited                                         |
| DELETE /settings/logo                              | Revert to bundled logo or text fallback; Admin only, audited                                       |
| GET /audit-events                                  | Filtered audit history; Admin only                                                                 |
| GET /health/live, /health/ready                    | Minimal liveness and dependency readiness; detailed diagnostics private                            |

Staff can read inventory and perform ordinary stock in/out; Manager additionally manages items, imports, and adjustments; Viewer is read/export only. Admin controls users and branding. All restrictions are enforced by the server. Prevent disabling/demoting the final active Admin. Audit denied sensitive actions without recording submitted secrets.

CSV import defaults to item metadata and reorder levels; opening quantities require a separately reviewed stock-import operation through the ledger service with idempotency. Show a validation preview; no rows persist before commit. Revalidate uniqueness during commit and return errors per row. Persist each accepted row atomically and report partial success explicitly. Escape formula-triggering cells in all spreadsheet exports, including error files.

## UI wireframe descriptions

Desktop shell: expanded left sidebar with logo/home link, Dashboard, Inventory, Movements, Low stock, Users, Settings; role-sensitive navigation; company and production location name with search in top bar; user menu and theme toggle. No location selector is needed. Collapsed shell uses the mark with accessible tooltips. Mobile uses a labelled menu button and dismissible drawer. Every page title is `SDP Inventory | {Page}`.

| Screen           | Layout and behavior                                                                                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login            | Centered full logo, company name, email/password form, show-password control, reset link, generic login error, lockout feedback. Invitation activation uses the same shell                                                                                     |
| Dashboard        | Item count, available stock value, low/out counts; low-stock table, recent movements, top-moving items over selected dates for the sole production location. Define value as quantity × current unit cost, not a financial valuation statement                 |
| Inventory        | Search focused for barcode scans; category, active/archive and stock filters; sort; paginated image/SKU/name/quantity/status/price table; Add, Import and Export actions by role. Mobile cards preserve status and key actions                                 |
| Item detail      | Breadcrumb and SKU, image gallery with keyboard-accessible zoom dialog, description and supplier, stock balance/reorder level, serial tab if enabled, filterable immutable stock ledger, stock actions                                                         |
| Add/edit item    | Group identity, classification, pricing, serialization, description, images; inline errors; debounced identity check; drag/drop with progress, reorder controls and primary selector. Draft recovery scoped to user, excluding secrets; unsaved-change warning |
| Stock dialog     | Operation selector (in/out/adjustment), item, quantity, optional serial list, reason/note, current/projected balance. Review summary; disable submit while processing; retain input on failures; conflict message with refreshed stock                         |
| Movements        | Date/type/item/user filters, ledger table and movement detail; correction creates a new movement                                                                                                                                                               |
| Low stock        | Low/Out text and icons, quantity/reorder levels, authorized restock action and report export                                                                                                                                                                   |
| Users            | Admin-only table, invitation action, role/enable form, explicit confirmation for access changes, last-Admin protection feedback                                                                                                                                |
| Settings         | Admin-only company name, approved logo preview on light/dark backgrounds, type/size instructions, upload progress/error, save confirmation and audit reference. Include currency/timezone fields; clarify currency changes do not convert prices               |
| Import           | CSV template, upload, column validation, row preview/error download, explicit commit, accepted/rejected summary                                                                                                                                                |
| Reports / labels | Filter preview, company logo/name header, print pagination, barcode scan preview, label size and optional-logo controls; generation/loading/error states                                                                                                       |

Shared UX: loading skeletons reserve dimensions; empty states explain the next allowed action; retryable failures preserve inputs; success toasts do not replace persistent form feedback. Confirm archival, user access changes, and logo removal. Undo archival when still valid; stock corrections require an audited compensating movement. Keyboard navigation, focus-visible rings, dialog focus containment/restoration, labelled inputs, live status announcements, reduced motion, and touch targets are acceptance criteria. Stock badges include icon plus text, never color alone. React Query invalidates affected totals/balances after committed mutations; no speculative stock decrement in the UI.

### Brand tokens and contrast plan

These colors are provisional UI choices, not Shindengen brand colors. Replace primary/accent after the actual assets and hex values are confirmed, then repeat contrast checks. CSS custom properties feed Tailwind semantic tokens; shared branding exports supply report/email colors. Brand artwork is never recolored to match these tokens.

| Token              | Light   | Dark    |
| ------------------ | ------- | ------- |
| --color-background | #FFFFFF | #0F172A |
| --color-foreground | #0F172A | #F8FAFC |
| --color-primary    | #1D4ED8 | #93C5FD |
| --color-on-primary | #FFFFFF | #0F172A |
| --color-accent     | #1D4ED8 | #93C5FD |

Check all text/background combinations against 4.5:1 for ordinary text and 3:1 for large text; check interactive boundaries, focus indicators, charts, badges, errors, and disabled-state legibility in both themes. The initial base pair measurements are recorded below after local calculation. Full WCAG 2.1 AA verification requires rendered screens, keyboard checks, automated accessibility checks, and manual inspection in Phase 3; a palette alone cannot establish compliance.

Calculated using sRGB linearization and relative luminance:

| Foreground / background | Contrast ratio | Ordinary text AA |
| ----------------------- | -------------- | ---------------- |
| #0F172A / #FFFFFF       | 17.85:1        | Pass             |
| #F8FAFC / #0F172A       | 17.06:1        | Pass             |
| #FFFFFF / #1D4ED8       | 6.70:1         | Pass             |
| #0F172A / #93C5FD       | 9.90:1         | Pass             |

## Security and validation plan

- Hash passwords with Argon2id. Use short-lived JWT access tokens in memory and rotating opaque refresh tokens in Secure, HttpOnly, SameSite cookies. Verify issuer/audience/expiry and check account/session state for revocation. Detect token reuse and revoke its session family. No tokens in localStorage or logs.
- Require CSRF tokens and exact Origin checks for state changes, including cookie-based refresh/logout and login CSRF protection. Same-origin production API; explicit development CORS origins, no wildcard credentialed access.
- Rate-limit by IP and identity with bounded login lockouts, generic reset responses, single-use hashed reset/invitation tokens, and secure password-reset session revocation. Disable request-body logging on auth endpoints.
- Validate every DTO, parameter, query, and file; use parameterized queries and narrowly scoped raw SQL only for locks. Configure Helmet/CSP, object-src none, frame restrictions, HTTPS/HSTS, and strict MIME headers. Encode user text in HTML, email, PDF, and print templates.
- Item uploads: verified PNG/JPEG/WebP, up to 10 MiB each, max 25 megapixels, one to five files, reject animations; strip metadata and generate thumbnails/optimized WebP in a bounded worker. Logo uploads follow the stricter 2 MiB PNG/SVG/WebP contract in public/brand/README.md. Uploaded SVG is rasterized, never served as executable content.
- Private object storage and signed reads; avoid user-controlled object paths. Isolate image/SVG decoders, disable external resources and limit CPU/memory/time. Test malicious SVG, spoofed MIME, decompression bombs, duplicate concurrent uploads and unauthorized replacements.
- Use structured request IDs and redacted logs, least-privilege roles, append-only audit writes, secrets from environment, and dependency/container scanning. Map authorization to OWASP broken access control; injection to parameterization and encoding; authentication failures to session/rate controls; misconfiguration to TLS/CSP/CORS; vulnerable components to scans; integrity failures to migrations and immutable ledger; logging failures to audit/monitoring; SSRF to denied decoder network access. Record remaining OWASP coverage and deployment risks in Phase 4.

## Implementation phases and acceptance gates

1. **Phase 1 (this delivery):** architecture, folder structure, normalized schema, endpoints, wireframes, branding contract. Pause for user confirmation before backend code.
2. **Phase 2:** runnable backend, versioned migrations and realistic single-location seed; auth, role checks, items/images, serial units, atomic stock ledger, branding upload/storage/audit services and tests. Integration tests cover concurrent withdrawals, stock transaction rollback, serial consistency, key replay/mismatch, duplicate identities, image limits, malicious SVG, rejection of additional locations and non-Admin settings access. Publish OpenAPI. Pause for confirmation.
3. **Phase 3:** React frontend, design system, all listed screens, responsive layouts, shared Brand component/fallback, real asset discovery, generated provisional favicon set, title handling, light/dark themes, branded emails/PDF/labels and job UX. Verify contrast, keyboard/axe checks, scanner search, and Playwright login → create → stock-in → stock-out → report; test logo replacement across surfaces. Pause for confirmation.
4. **Phase 4:** hardening, production Compose/proxy configuration, setup README, env example, operational scripts, threat model, scan results, backup/restore check and deployment checklist. Verify real PostgreSQL/MinIO/SMTP flows and production cookie/TLS settings. Report remaining limitations and obtain confirmation before deployment.

Unconfirmed items: exact SDP acronym expansion, actual brand assets/colors, the single production location's name, currency, SMTP sender, server/domain details, and label printer dimensions. These do not block reviewing this architecture. The user has confirmed one production location only.
