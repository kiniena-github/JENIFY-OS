# FACTORY OS — Feature Matrix

> Status: **DONE** (working + tested) · **PARTIAL** (works, known gaps) · **MISSING** (not built) · **DESIGN-ONLY** (deliberately unbuilt, design lives in the architecture plan).
> Defect numbers (D#/T#) reference the register in [FACTORY_OS_CURRENT_STATE.md](FACTORY_OS_CURRENT_STATE.md).
> **Rule: update the affected row in the same commit as any feature change.**

| Feature | Status | Server | Tables | Web | Tests | Defects | Priority | Agent |
|---|---|---|---|---|---|---|---|---|
| Authentication & sessions | DONE | `auth.ts`, `routes/auth.ts` | `users`, `sessions` | `LoginPage` | foundation, e2e | D4, D10 | M1 | security-permissions |
| Recovery codes | DONE | `recovery.ts` | `recovery_codes` | `UsersPage` panel | finalfix, masterfix2 | D3, D4 | M1 | security-permissions |
| RBAC (versioned matrices) | DONE | `permissions.ts` | `roles`, `role_permissions` | `UsersPage` | foundation, qc, e2e | D3, D5 | M1 | security-permissions |
| User management | DONE | `users.ts` | `users` | `UsersPage` | foundation | D3, D10 | M1 | security-permissions |
| Audit trail + viewer | DONE | `audit.ts` | `audit_events` | `AuditPage` | throughout | D7 | M1 | security-permissions |
| Versioned settings | DONE | `settings.ts` | `tenant_settings` | `SettingsPage` | foundation | D3, D10 | M1 | lead-architect |
| Translations / editable terminology | DONE (framework) | `translations.ts`, `i18n-keys.ts` | `translation_keys`, `translations`, `tenant_languages` | Settings tabs | masterfix2 | T8 (content ~1.5%) | ongoing | africa-localization |
| Document numbering | DONE | `numbering.ts` | `document_sequences` | Settings tab | foundation | — | — | lead-architect |
| Master data (UoM/items/warehouses) | DONE | `masterdata.ts` | `uoms`, `items`, `warehouses` | Settings/Setup | foundation | D5 | M1 | inventory-warehouse |
| Customers | DONE | `parties.ts` | `parties` | `CustomersPage` | foundation, e2e | — | — | sales-customer |
| Suppliers | PARTIAL | `parties.ts` (kind=supplier) | `parties` | **none** (seed/API only) | — | — | M2 | procurement-supplier |
| Stock ledger + balances | DONE | `inventory.ts`, `stockview.ts` | `stock_movements`, `stock_balances` | `InventoryPage` | inventory, reports | D7 | M1 | inventory-warehouse |
| Lot tracking | DONE | `inventory.ts` | `lots` | via pages | inventory, production | — | — | inventory-warehouse |
| Reservations | DONE | `inventory.ts` | `reservations` | via pages | inventory, commercial | — | — | inventory-warehouse |
| Goods receiving | DONE | `receiving.ts` | `goods_receipts` | `ReceivingPage` | documents, e2e | D7; no cost capture | M1/M2 | inventory-warehouse |
| Warehouse transfers | DONE | `transfers.ts` | `stock_transfers` | `InventoryPage` | documents | D7 | M1 | inventory-warehouse |
| Stock adjustments | MISSING | movement type declared, never emitted | — | — | — | — | M4 | inventory-warehouse |
| Stock counts / cycle counting | MISSING | — | — | — | — | — | M4 | inventory-warehouse |
| Reorder points / low-stock alerts | MISSING | — | — | — | — | — | M4 | inventory-warehouse |
| Expiry / FEFO / serial tracking | MISSING | `trackingMode: serial` declared only | — | — | — | — | deferred | inventory-warehouse |
| Production stages (config) | DONE | `production.ts` | `production_stages` | Settings/Setup | production | — | — | production-manufacturing |
| Production batches | DONE | `batches.ts` | `production_batches` | `ProductionPage` | production, qc | D1 (dashboard), D7 | M1 | production-manufacturing |
| QC gates + immutable retests | DONE | `batches.ts` | `quality_tests` | `ProductionPage` | qc | D7 | M1 | quality-traceability |
| Batch genealogy / traceability | DONE | `batches.ts` (`batchGenealogy`) | — | `ProductionPage` | production | — | — | quality-traceability |
| Scrap / rework disposition | PARTIAL | `unitsRejected` only — rejected units leave no ledger trace | — | — | — | — | M4 | production-manufacturing |
| BOM / recipe / material consumption | DESIGN-ONLY | iodine is a form attribute | — | — | — | — | M3 | production-manufacturing |
| Manufacturing orders / scheduling | MISSING | batches are ad hoc | — | — | — | — | M3+ | production-manufacturing |
| Purchase orders / RFQs | DESIGN-ONLY | — | — | — | — | — | M2 | procurement-supplier |
| Costing / valuation / margins | DESIGN-ONLY | no purchase price anywhere | — | — | — | — | M2 | finance-costing |
| Sales invoices (FIFO, VAT, pricing snapshots) | DONE | `sales.ts` | `sales_invoices`, `invoice_lines` | `SalesPage` | commercial, e2e | D1, D6 | M1 | sales-customer |
| Credit limits + overview | DONE | `creditview.ts`, `sales.ts` | — | `CreditPage` | commercial, masterfix2 | D1, D6 | M1 | sales-customer |
| Deliveries | DONE | `deliveries.ts` | `deliveries` | `DeliveriesPage` | commercial, masterfix2 | D1 | M1 | sales-customer |
| Payments + allocations (multi-currency snapshot) | DONE | `payments.ts` | `payments`, `payment_allocations` | `PaymentsPage` | commercial | — | — | sales-customer |
| Returns / credit notes | MISSING | — | — | — | — | — | M4 | sales-customer |
| Simple transactions (sacks) | DONE | `simpletxn.ts` | `simple_transactions` | `SacksPage` | reports | — | — | inventory-warehouse |
| Reports (9, reconciling, CSV/print) | DONE | `reports.ts` | reads all | `ReportsPage` | reports | D6 (JS date filter) | M1 | lead-architect |
| Owner dashboard + computed alerts | DONE | `dashboard.ts` | reads all | `DashboardPage` | reports | D1 | M1 | frontend-ux |
| Notifications (persisted/delivered) | DESIGN-ONLY | computed-on-read only | — | — | — | — | M4 | lead-architect |
| Print subsystem + branding snapshots | DONE | `brandingVersion` on 5 doc tables | — | `PrintPage` | finalfix | — | — | frontend-ux |
| Setup wizard | DONE | via public APIs | — | `SetupPage` | manual | — | — | frontend-ux |
| Go-live provisioning | PARTIAL | `provisioning.ts`, `init-production.ts` CLI | — | — | masterfix2, finalfix | D2 (non-atomic) | M1 | security-permissions |
| Ops migration scripts | PARTIAL | `apply-masterfix.ts`, `apply-qc-update.ts` | — | — | none | D9 | M1 | lead-architect |
| Maintenance / machines / work centers | MISSING | — | — | — | — | — | M5 design | maintenance-asset |
| Workforce / shifts / attendance | MISSING | free-text operator names only | — | — | — | — | M5 design | workforce-shift |
| Offline writes / sync | DESIGN-ONLY | SW is shell-only by design | — | `sw.js` | — | — | deferred | africa-localization |
| Multi-site | MISSING | single-site by construction | — | — | — | — | deferred | lead-architect |
| QOS / AI | DESIGN-ONLY | **out of scope per founder** | — | — | — | — | on re-scope | jenify-ai-qos |
| Frontend error/loading states | PARTIAL | — | — | all pages | none | D8 | M1 | frontend-ux |
| Frontend test harness | MISSING | — | — | — | none | D8 | M1 | qa-factory-simulation |
