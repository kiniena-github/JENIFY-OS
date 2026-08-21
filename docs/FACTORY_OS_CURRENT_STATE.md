# FACTORY OS — Current State

> Audit snapshot as of 2026-08-21 (branch `milestone-1-hardening`, baseline commit `70efbd6`).
> Facts only — recommendations live in [FACTORY_OS_ARCHITECTURE_PLAN.md](FACTORY_OS_ARCHITECTURE_PLAN.md), per-feature status in [FACTORY_OS_FEATURE_MATRIX.md](FACTORY_OS_FEATURE_MATRIX.md).

## 1. System overview

JENIFY OS (public rebrand of FactoryOS; internal package/DB names unchanged) is a manufacturing ERP currently serving one tenant: **Mesob**, a salt factory in Tigray, Ethiopia. Deployment is local-only (one box, `127.0.0.1`), no cloud, no CI.

| Layer | Choice |
|---|---|
| Monorepo | npm workspaces (no Turbo/Nx), root `package.json` orchestrates via `npm-run-all` |
| Server | Fastify 5, better-sqlite3 12 (synchronous), Drizzle ORM 0.44, uuid v7, tsx runtime (no compiled dist) |
| Web | React 18, Vite 5, React Router 6, TanStack Query 5, single hand-written `styles.css` |
| Tests | Vitest 3 (server only), in-memory SQLite per suite |
| DB | Single SQLite file `data/factoryos.sqlite`, WAL mode, migrations auto-run on connect |

### Packages

```
packages/shared        @factoryos/shared       permission model, statuses, unit/money scaling,
                                               Ethiopian calendar, delivery performance
packages/server        @factoryos/server       Fastify API: 7 route files (~98 endpoints),
                                               26 services, 32-table Drizzle schema, migrations 0000–0004
packages/web           @factoryos/web          React SPA: 17 lazy-loaded pages, app shell, print routes
packages/config-mesob  @factoryos/config-mesob Mesob seed, ops scripts, init-production.ts go-live CLI
```

Dependency direction (one-way, enforced by structure): `config-mesob → server → shared`, `web → shared`. `shared` may never reference a tenant; everything Mesob-specific lives in `config-mesob`, which provisions exclusively through platform service APIs.

## 2. Module inventory

| Module | Routes | Services | Tables | Web page | Tests |
|---|---|---|---|---|---|
| Auth & sessions | `routes/auth.ts` | `auth.ts`, `recovery.ts` | `users`, `sessions`, `recovery_codes` | `LoginPage` | foundation, finalfix |
| Users & RBAC | `routes/admin.ts` | `users.ts`, `permissions.ts` | `roles`, `role_permissions` (versioned) | `UsersPage` | foundation, qc, e2e |
| Settings | `routes/admin.ts` | `settings.ts` | `tenant_settings` (versioned) | `SettingsPage` | foundation |
| Translations | `routes/auth.ts`, `admin.ts` | `translations.ts` | `translation_keys` (global), `translations`, `tenant_languages` | `SettingsPage` tabs | masterfix2 |
| Audit | `routes/admin.ts` | `audit.ts` | `audit_events` (append-only) | `AuditPage` | throughout |
| Numbering | `routes/admin.ts` | `numbering.ts` | `document_sequences` | `SettingsPage` | foundation |
| Master data | `routes/masterdata.ts` | `masterdata.ts`, `parties.ts` | `uoms`, `items`, `warehouses`, `parties` | `CustomersPage` | foundation |
| Inventory ledger | `routes/inventory.ts` | `inventory.ts`, `stockview.ts` | `stock_movements` (append-only), `stock_balances` (cache), `lots`, `reservations` | `InventoryPage` | inventory, documents |
| Receiving | `routes/inventory.ts` | `receiving.ts` | `goods_receipts` | `ReceivingPage` | documents, e2e |
| Transfers | `routes/inventory.ts` | `transfers.ts` | `stock_transfers` | `InventoryPage` | documents |
| Production | `routes/production.ts` | `production.ts`, `batches.ts` | `production_stages`, `production_batches`, `quality_tests` (immutable) | `ProductionPage` | production, qc |
| Sales | `routes/commercial.ts` | `sales.ts`, `creditview.ts` | `sales_invoices`, `invoice_lines` | `SalesPage`, `CreditPage` | commercial, e2e |
| Deliveries | `routes/commercial.ts` | `deliveries.ts` | `deliveries` | `DeliveriesPage` | commercial, masterfix2 |
| Payments | `routes/commercial.ts` | `payments.ts` | `payments`, `payment_allocations` | `PaymentsPage` | commercial |
| Simple transactions | `routes/insights.ts` | `simpletxn.ts` | `simple_transactions` | `SacksPage` | reports |
| Reports (9) | `routes/insights.ts` | `reports.ts` | (reads all) | `ReportsPage` | reports |
| Dashboard | `routes/insights.ts` | `dashboard.ts` | (reads all) | `DashboardPage` | reports |
| Provisioning | CLI only | `provisioning.ts` | (writes most) | `SetupPage` wizard | masterfix2, finalfix |
| Print | — | — | — | `PrintPage` (`/print/:kind/:id`) | manual |

## 3. Architectural invariants — preserve these

These are the crown jewels. No change may violate them.

1. **Append-only stock ledger.** `stock_movements` rows are never updated or deleted; corrections are new movements. `stock_balances` is a transactionally-maintained cache; `recomputeBalances()` (`services/inventory.ts`) reconciles drift.
2. **Integer units everywhere.** Quantities are integer milli base-units (kg × 1000); money is integer cents. Never floats for money or quantity. One `real` column exists (`payments.fx_rate`) — display snapshot only.
3. **Versioned, never-overwritten config.** `tenant_settings` and `role_permissions` insert new versions; history is permanent. Documents snapshot the config version they were posted under (`pricingVersion`, `vatSnapshot`, `brandingVersion`) so reprints reproduce issuance-time state.
4. **Immutable QC attempts.** A retest is a new `quality_tests` row linked via `previousTestId`; test records are never mutated.
5. **Server-side financial masking.** `view_financial` per module is enforced by the server (`maskMoney`, `stripFinancial`), never by UI hiding.
6. **Tenant isolation via session only.** `tenantId` comes from `requireCtx()` (session), never from a request body. Every business table carries `tenant_id`; every query filters on it.
7. **Audit on every mutation.** Every state-changing service calls `writeAudit`. `audit_events` is append-only with no update/delete path.
8. **Permission on every route.** `requirePermission(ctx, module, action)` per handler; `hasPermission` requires literal `true` (fail-closed).
9. **Posted documents are reversed, never deleted.** Draft → posted → reversed lifecycle throughout.
10. **Stored UTC, displayed local.** All timestamps ISO-8601 UTC; tenant IANA timezone and Ethiopian calendar apply at display time only.

## 4. Test posture

- 163 vitest tests, 11 suites, all in `packages/server/test/` (in-memory DB via `helpers.ts` → `makeTestTenant` seeds a full "SaltCo" tenant with Addis timezone; `makeProcessStages` builds washing → iodization → packaging).
- Real HTTP tests via `buildApp()` + `app.inject()` with role-scoped cookie sessions asserting cross-role 403s (`e2e.test.ts` and the fix-pass suites).
- Migrations 0000–0004 exercise on every run (forward-only, empty DB).
- **Frontend: zero tests** (Milestone 1 WP7 bootstraps a harness).
- **Concurrency: zero tests.** No CI, no linter.
- Structural smell: the four "fix-pass" suites (`qc`, `masterfix`, `masterfix2`, `finalfix`) group regressions by when found, not by subsystem.

## 5. Defects register (Milestone 1 tracking source)

Severity: **C**ritical / **H**igh / **M**edium / **L**ow. Status updated as WPs land.

| # | Defect | Where | Sev | WP | Status |
|---|---|---|---|---|---|
| D1 | Server "today" is UTC, not tenant-local — Ethiopia (UTC+3) gets yesterday's date 00:00–03:00: night-shift deliveries rejected, overdue 3h early, dashboard stale | `dashboard.ts:54`, `creditview.ts:68-69`, `sales.ts:404`, `deliveries.ts:35,169,195` | C | WP1 | OPEN |
| D2 | `initFreshProductionTenant` non-atomic; warehouse validation runs after inserts → stranded half-tenant, retry blocked. Go-live blocker | `provisioning.ts:193` (validation at 251-255) | C | WP2 | OPEN |
| D3 | Multi-write services without `inTx`: `createRole` (crash → empty-matrix lockout), `recoverWithCode` (burns code w/o password set), `generateRecoveryCodes`, `createUser`, settings/translations bulk writes | `permissions.ts`, `recovery.ts`, `users.ts`, `settings.ts`, `translations.ts` | H | WP2 | OPEN |
| D4 | Dormant multi-tenant auth bug: login compares `tenantCode` to a tenant UUID; recovery has no tenant filter; `/api/login-info` returns "first active tenant". Activates at go-live (2nd tenant) | `auth.ts:34-37`, `recovery.ts:94-97`, `routes/auth.ts:19` | C | WP3 | OPEN |
| D5 | No runtime input validation on ~98 routes; `req.body` spread into services; no finiteness/magnitude guard (1e12 tons overflows MAX_SAFE_INTEGER); role matrix stored unvalidated | `routes/*` (esp. `admin.ts:47,106`), `masterdata.ts:63` | H | WP4 | OPEN |
| D6 | N+1: invoice list per-row `invoicePaidCents` (200/page); `customerOutstanding` per-invoice aggregates inside confirm tx; FIFO 2 queries/lot; 5 of 9 reports date-filter in JS after full-table load | `routes/commercial.ts:52`, `sales.ts:414-431,231-245`, `reports.ts` | M | WP5 | OPEN |
| D7 | Missing indexes: `goods_receipts`/`stock_transfers`/`quality_tests` (tenant), `production_batches` (tenant,status), `translations` (tenant,language), `audit_events` (module/user) | migration gap | M | WP5 | OPEN |
| D8 | Frontend: read errors swallowed on 15/17 pages (`isLoading`/`isError` used zero times — failed GET renders as empty table); Modal lacks Escape/focus-trap/aria; CSS `var(--panel)` and `var(--muted)` undefined | `packages/web` (esp. `styles.css:407,411,441`, `ui.tsx` Modal) | H | WP7 | OPEN |
| D9 | Ops scripts mutate live DB on import — no dry-run/backup/transaction; cwd-dependent logins path; `saveRoleMatrix` bumps versions even when unchanged | `config-mesob/apply-masterfix.ts`, `apply-qc-update.ts` | H | WP6 | OPEN |
| D10 | Hygiene: dead `sessionTimeoutMinutes`; 1-char passwords in `createUser`; branding upload dead > ~750 KB (bodyLimit 1 MB < app cap 2 MB); `/api/system-info` leaks git SHA/DB size to any user; `logger:false`; no rate limit on login/recover; `inTx` deferred BEGIN (`SQLITE_BUSY_SNAPSHOT` not retried) | `auth.ts`, `users.ts:42`, `app.ts:33`, `routes/admin.ts:292`, `context.ts` | M | WP6 | OPEN |
| D11 | Username-enumeration oracle in recovery: check ORDER leaks account existence — unknown user → 401 `recovery_invalid`, valid user + weak password → 400 `password_weak`. The finalfix "no disclosure" test always sends a valid password so it never catches this. Fix: validate password before the user lookup + add the weak-password/unknown-user parity test *(jenify test-team 2026-08-21)* | `services/recovery.ts:114-117`, `test/finalfix.test.ts:401-416` | H | WP3 | OPEN |
| D12 | `nextDocNumber` read-then-return race: SELECT then separate UPDATE means two concurrent postings on one sequence can both read the same value — second committer dies on the unique doc-number index with an opaque error. No concurrent-posting test exists. Fix: single atomic `UPDATE … RETURNING` + interleaved-transaction test *(jenify test-team 2026-08-21)* | `services/numbering.ts:33-46`, `db/schema.ts:545` | M | WP2 | OPEN |
| D13 | Error-surface hygiene: global handler returns raw `e.message` for non-`AppError` exceptions (internal detail on unexpected errors); `/api/branding-version/:version` is the one authenticated route with no `requirePermission` (presentation-only by design — make the exemption explicit in code comment or guard it) *(jenify test-team 2026-08-21)* | `app.ts:59-61`, `routes/admin.ts:232-237` | M | WP6 | OPEN |

### Deferred (tracked, not in Milestone 1)

| # | Item | Notes |
|---|---|---|
| T1 | Plaintext role passwords in `data/mesob-logins.txt` (OneDrive-synced) | gitignored and never committed; operational decision for the founder — rotate at go-live, delete the file |
| T2 | Live SQLite under OneDrive sync | WAL + file-sync clients are a known corruption vector; move the deployment directory out of OneDrive before go-live |
| T3 | Prod web serving requires `vite preview` | server serves only `/branding/`; serve `web/dist` from Fastify or a static host |
| T4 | 7 dead exports in `shared` (`toCents` etc.) vs duplicated `cents()` in `sales.ts`/`payments.ts` | consolidate during M2 costing work |
| T5 | `attachments` table exists, entirely unused | wire or remove when documents feature is scheduled |
| T6 | Remaining ~80 routes without validation schemas | choke-point guards from WP4 cover the dangerous classes; finish incrementally |
| T7 | 11 remaining pages without `QueryState`; ~39 hand-rolled write handlers | continue `useAppMutation` rollout after WP7 exemplar |
| T8 | Amharic/Tigrinya translation fill (placeholders: ~20 of 685 keys) | needs factory review, not engineering |
| T9 | PWA "J" icons are placeholders, `maskable` without safe-zone padding | needs the approved JENIFY logo binary (not yet in repo) |
| T10 | No CI / linter | add GitHub Actions + ESLint when the repo gets a remote |

## 6. Missing capabilities (by design, not defects)

| Capability | State | Target |
|---|---|---|
| Costing / valuation | No purchase price anywhere; no unit cost, COGS, or margin | M2 |
| Procurement | Suppliers exist as `parties`; no PO/RFQ, no supplier UI, no receipt-to-PO match | M2 |
| BOM / recipe | Iodine is a form attribute, not consumed stock; no multi-component input | M3 |
| Manufacturing orders / scheduling | Batches are ad hoc; no orders, capacity, or demand link | M3+ |
| Stock adjustments / counts / reorder points | `adjustment` movement type declared, never emitted | M4 |
| Returns / credit notes | Absent; rejected packaging units vanish from the ledger | M4 |
| Maintenance / machines / work centers | Nothing exists | M5 (design first) |
| Workforce / shifts / attendance | Only login users; operator names are free text | M5 (design first) |
| Notifications persistence / delivery | Dashboard alerts computed on read only | M4 |
| Offline writes | Service worker is deliberately shell-only | Deferred |
| Expiry / FEFO, serial tracking | Declared (`trackingMode: serial`), unimplemented | Deferred |
| Multi-site | Single-site by construction (warehouses only) | Deferred |
| QOS / AI | Nothing exists in code; **FUTURE PLANNED — a major planned part of JENIFY OS, inactive until the Founder starts the AI milestone** (Founder decision 2026-08-21) | AI milestone (design-only until then) |

## 7. Deployment reality

- One box, local network, no TLS (cookie flags sized accordingly), server binds `127.0.0.1:3001`, Vite dev/preview on `5173`/`4173` proxies `/api` and `/branding`.
- Single SQLite file `data/factoryos.sqlite` (WAL). Migrations run automatically on connect.
- Mesob seeded via `config-mesob/seed.ts` (8 roles: owner, operations, warehouse, production operator, production supervisor, quality, sales, finance). The founder changed the `owner` password manually; other seeded logins in gitignored `data/mesob-logins.txt`.
- Go-live path: `init-production.ts` clones approved configuration only (explicit warehouse/language allow-lists, counters reset, zero operational history) into a fresh tenant — dry-run by default, `--yes` to execute.
- Three manual `backup-*.sqlite` snapshots sit in `data/` (human discipline, not codified — WP6 codifies it for ops scripts).
