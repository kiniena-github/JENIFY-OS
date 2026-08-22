# SECTOR TEMPLATE BLUEPRINT — Wholesale / Distribution

> **Owner:** jenify-template-engineer (sales-customer depth) · **Status:** Design blueprint for Founder direction · **Date:** 2026-08-21
> **Sector rank:** #1 next sector (`docs/research/AFRICA_SECTOR_PRIORITY.md` §3, score 4.75)
> **Grounding:** `AFRICA_SECTOR_PRIORITY.md` §4.1 · `AFRICA_BUSINESS_OS_REQUIREMENTS.md` §2/§5/§6 · `FACTORY_OS_CURRENT_STATE.md` §2 · `FACTORY_OS_FEATURE_MATRIX.md` · `GLOBAL_COMPETITOR_INTELLIGENCE.md` (Marg §2.10, offline-POS §2.20, Loyverse) · `ROLE_EXPERIENCE_SIMPLICITY.md` · `MOBILE_LOWEND_UX.md`
> **Constraints honoured:** core-vs-config (no tenant literals in core); immutable ledger; append-only versioned config; server-side financial masking; mobile-first / low-end / bad-internet / low-bandwidth. Reuse the proven Mesob spine; do NOT fork it.

This is the **second deep sector proof** for JENIFY after Mesob (manufacturing). It reuses the manufacturing trade spine with production/QC toggled OFF and adds the smallest set of trade-specific capabilities (orders, purchasing, returns, van/route sales). It is written to be implementable against **stable platform contracts** — it names existing services/tables to reuse and marks every NEW object explicitly. **No code here; design only.**

---

## 0. Thesis and non-goals

**Thesis (confirmed by research).** A distributor/wholesaler needs items/UoM/warehouses, receiving, an append-only stock ledger with derived balances, lots, transfers, reservations, credit-controlled invoicing, deliveries, payments with explicit allocation, customer statements, printed documents, and RBAC/audit — **all of which are DONE, tested code today** (`AFRICA_SECTOR_PRIORITY.md` §1 reuse verification; `FACTORY_OS_CURRENT_STATE.md` §2). The research puts **~80–85% of a trade deployment as existing code**. Production stages, QC gates, batch genealogy simply switch OFF via the template — the core-vs-config architecture supports this without a fork.

**What makes distribution distinct from Mesob (the real delta):**
1. **Order precedes invoice.** In manufacturing sales, an invoice is posted directly. In distribution, a customer **order/quotation** is captured first (often in the field, offline), then fulfilled → invoiced. This is the single biggest NEW object (`GLOBAL_COMPETITOR_INTELLIGENCE.md` §5.1: quote→order→invoice→payment is the universal ERP spine; JENIFY jumps straight to invoice today).
2. **Van/route (cash-van) sales.** A field rep carries stock on a van (van = mobile warehouse), sells and collects cash on a route, and reconciles stock + cash at end of day. This is the "most important screen set" and must be **mobile-first, ≥48px targets, offline-tolerant** (`MOBILE_LOWEND_UX.md`; `AFRICA_SECTOR_PRIORITY.md` §4.1 "van-sales chaos").
3. **Purchasing/procurement basics.** Distributors buy to resell; supplier balances and a light 2-step purchase (order → receive+bill) are needed. Suppliers already exist as `parties(kind=supplier)`; the UI and PO object are the gap (`FACTORY_OS_FEATURE_MATRIX.md`: Suppliers PARTIAL, POs DESIGN-ONLY M2).
4. **Returns.** Trade runs on returns/credit notes; today rejected units "vanish from the ledger" (`FACTORY_OS_CURRENT_STATE.md` §6). Returns are NEW (M4).
5. **Customer hierarchy + tiered pricing.** retailer → sub-distributor → key account, each on a price tier. Price **categories** already exist per-customer (`parties.defaultPriceCategory`, `pricing` settings, `sales.ts`); hierarchy is the small NEW piece.

**Non-goals for v1 (explicitly deferred — see §7):** promotions/scheme management (free-with-purchase, slab discounts — Marg's depth), route optimization / GPS, salesperson commission engines, mobile-money live API integration, multi-currency purchasing depth, e-invoicing country packs, BOM (irrelevant to pure trade), general ledger. These are real but are NOT the smallest excellent template.

**Judged against FAST·SIMPLE·FLEXIBLE·LOCAL·INTELLIGENT:** the win is that ~80–85% ships by reuse (FAST), the delta is 3–4 capabilities not 40 modules (SIMPLE), templates toggle rather than fork (FLEXIBLE), offline-first van sales is the wedge cloud B2B platforms cannot match (LOCAL), and the owner daily brief + reorder/credit signals are the INTELLIGENT layer — all consistent with the "don't become a marketplace/lender, power the operator" rule (`AFRICA_BUSINESS_OS_REQUIREMENTS.md` §2).

---

## 1. Core objects — mapping to EXISTING JENIFY capabilities

Legend: **REUSE** = exists, tested, use as-is · **REUSE+cfg** = exists, template configures it · **EXTEND** = existing object needs a field/relationship · **NEW** = new object/service/table.

| Distribution object | JENIFY mapping | Status | Notes / contract |
|---|---|---|---|
| Customer (retailer, shop) | `parties(kind=customer)` + `CustomersPage` | **REUSE** | credit limit, default price category already on `parties` (`schema.ts:272–279`). |
| **Customer hierarchy** (retailer → sub-distributor → key account) | `parties` + NEW self-referencing `parentPartyId` + `partyTier` | **EXTEND** | Sub-distributor is a customer that also has its own downstream; key account is a flag/tier. Keep as a nullable parent pointer + a tier code drawn from the pricing categories — no new table. Assumption: hierarchy is 1–2 levels deep in v1 (label). |
| **Sales rep / salesperson** | `sales_invoices.salespersonId` exists (`schema.ts:597`) as a free field; NEW link to a `users` row with a `sales_rep` role | **EXTEND** | Today salesperson is an unvalidated id. v1: bind rep = the authenticated user for field orders; keep the column, add a real FK/role. Mirrors delivery driver being free-text today. |
| **Quotation / Order** (order precedes invoice) | NEW `sales_orders` + `sales_order_lines`; converts to existing `sales_invoices` | **NEW** | THE headline object. Draft order → confirmed order (reserves stock via existing `reservations`) → fulfilled → invoiced (existing `sales.ts`). Order carries price snapshot like invoices do. |
| Sales invoice | `sales.ts`, `sales_invoices`, `invoice_lines` (FIFO, VAT, pricing snapshot) | **REUSE** | Invoice is generated FROM a confirmed order in v1 rather than typed fresh. All money/masking rules intact. |
| **Price lists per customer tier** | `pricing` settings (versioned) + `prices[itemId][categoryCode]` + `parties.defaultPriceCategory` (`sales.ts:68–117`) | **REUSE+cfg** | Tiers = price categories (e.g. `retail`, `subdist`, `key`). Already snapshotted via `pricingVersion`. v1 needs only category naming per tenant + assignment to hierarchy. Custom-price/discount approval gating already enforced (`sales.ts:147–150`). |
| Credit management | `creditview.ts`, `parties.creditLimitCents`, credit check in `sales.ts` | **REUSE** | Limit, utilization, block-on-over-limit exist. Add credit-override as a gated action (below). |
| Multi-warehouse / depot | `warehouses`, `stock_transfers`, per-warehouse balances | **REUSE** | Depots = warehouses. Inter-depot transfer exists. (True multi-**site** with autonomy is Deferred — v1 is multi-warehouse on one node.) |
| **Van as inventory location** | `warehouses` row of a NEW `warehouseKind='van'` | **REUSE+cfg / EXTEND** | Van stock = a warehouse the rep loads (transfer_out from depot → van) and sells from. Load = existing transfer; van-sale = issue from van warehouse. Add a `kind`/`mobile` flag so a van is distinguishable in UI and reconciliation. **OPEN QUESTION for Founder (§8).** |
| Purchasing / procurement | Supplier = `parties(kind=supplier)` (REUSE); NEW `purchase_orders` + PO→receipt match | **PARTIAL→NEW** | v1 = light 2-step (order → receive+bill), NOT full procure-to-pay (`GLOBAL_COMPETITOR_INTELLIGENCE.md` §5.7 anti-pattern). Goods receiving (`receiving.ts`) already exists; add optional PO reference + supplier bill/payable. |
| Supplier management | `parties(kind=supplier)` data exists; **no UI** | **EXTEND (UI)** | Add SuppliersPage (mirror CustomersPage) + payables view (mirror `creditview`). |
| Goods receipt (inbound) | `receiving.ts`, `goods_receipts` | **REUSE** | Add optional link to PO; add unit-cost capture (M2 costing dependency — see §6). |
| Delivery / dispatch | `deliveries.ts`, `deliveries` (perf-tracked, truck/driver fields exist `schema.ts:643–646`) | **REUSE** | Depot model: invoice → delivery note → dispatch → confirm. Driver still free-text today; bind to a user (EXTEND). |
| **Delivery route** | NEW light `route` grouping of orders/deliveries per rep per day | **NEW (light)** | v1 = a named day-route = ordered list of customer stops; NOT optimization. Deferred: sequencing/GPS. |
| Payment collection (cash-van) | `payments.ts`, `payments.method`, `payment_allocations` (explicit multi-invoice) | **REUSE** | Cash/mobile-money method + allocation to invoices exists. Van model: collect at stop → allocate to that customer's invoices. Record telebirr/M-Pesa **reference** (reconciliation-first, `AFRICA_BUSINESS_OS_REQUIREMENTS.md` §5.3) — small EXTEND to payment method metadata. |
| **Returns / credit notes** | NEW `sales_returns` (+ credit-note doc); reverses stock via new inbound movement, issues credit against customer | **NEW** | M4. Restores stock to a warehouse (append-only movement, not deletion — invariant #1/#9) and creates a credit the customer can allocate. |
| **End-of-day cash & stock reconciliation** | NEW reconciliation view over existing `payments` + van-warehouse `stock_movements` + `simple_transactions` | **NEW (composed)** | Composes existing ledgers: expected cash = sum of van sales; expected stock = load − sales − returns; variance flagged. Reuses `SacksPage` simple-transaction pattern for cash count ritual. |
| Branch operations | `warehouses` + per-warehouse reporting; owner consolidated dashboard | **REUSE+cfg** | v1 = branches as warehouses with per-warehouse KPIs. Full branch P&L needs costing (M2) + GL (deferred). |
| Documents (PO, GRN, order confirmation, invoice, delivery note, waybill, receipt, statement, credit note) | Print subsystem + `document_sequences` + branding snapshots | **REUSE+cfg** | Numbering + branding-versioned reprints exist. Add order-confirmation, PO, credit-note, statement templates (config, not core). |

**Reuse verdict:** of the ~24 objects above, **~15 are pure REUSE/REUSE+cfg**, ~4 are EXTEND (small fields/UI on existing tables), and **~5 are genuinely NEW** (sales orders, purchase orders, returns, light routes, EOD reconciliation view). This matches the research's **80–85% existing-code** estimate; the NEW surface is concentrated and additive.

---

## 2. Capability activation map (template artifact)

The template is a **declarative artifact** (per roadmap risk #2 — templates must be declarative, extracted, not imperative forks). It activates platform capabilities as Required / Recommended / Optional / **Off**. Capability IDs below align to existing `MODULES` (`packages/shared/src/index.ts:9`) plus proposed NEW capability IDs (prefixed `NEW:`), to be lifted into route metadata when the declarative seam lands.

| Capability ID | Activation | Dependency / note |
|---|---|---|
| `parties` (customers + suppliers) | **Required** | supplier UI is EXTEND |
| `inventory` (ledger, balances, lots, reservations, transfers) | **Required** | van = warehouse depends on `warehouseKind` flag |
| `receiving` | **Required** | optional PO link |
| `sales` (invoices, FIFO, VAT, pricing snapshot) | **Required** | — |
| `credit` | **Required** | credit-override gated action |
| `delivery` | **Recommended** | Off for pure counter-wholesale; On for depot/van |
| `payments` (+ allocations) | **Required** | mobile-money reference = EXTEND |
| `reports` | **Required** | + new trade reports (§4) |
| `dashboard` | **Required** | + distribution owner brief (§4) |
| `users` / RBAC / `audit` / `settings` | **Required** | new roles + gated actions |
| `NEW:orders` (quotation/sales order) | **Required** | THE sector-defining capability; depends on `sales`, `inventory` (reservations) |
| `NEW:purchasing` (PO + supplier bill/payable) | **Recommended** | depends on `parties(supplier)`, `receiving`; full value needs M2 costing |
| `NEW:returns` (credit notes) | **Recommended** | M4; depends on `sales`, `inventory` |
| `NEW:vansales` (route/van stock, EOD reconcile) | **Optional** | mobile-first; depends on `orders`, `inventory(van warehouse)`, `payments` |
| `NEW:routes` (day route grouping) | **Optional** | light; depends on `vansales`/`delivery` |
| `production` / `quality` | **Off** | toggled off by template — proves core-vs-config |
| Costing/valuation/margins | **Off in v1** (arrives M2) | template leaves margin KPIs dormant until M2 |
| Expiry/FEFO | **Off in v1** | needed for pharmacy/food sub-template later (Deferred) |

**Two shipped profiles from one template:**
- **Depot distributor** (order → pick → deliver → collect): `orders` + `delivery` + `purchasing`, van Off.
- **Van-sales operator** (load → sell on route → reconcile): `vansales` + `routes` + `orders`, delivery light.
An owner can run both (some customers delivered from depot, some served by van).

---

## 3. Workflows

Money/stock confirmations keep the mandatory confirm-before-post screen (action + amount + counterparty), which is already JENIFY practice and a security control, not just UX (`MOBILE_LOWEND_UX.md` §; `ROLE_EXPERIENCE_SIMPLICITY.md`). All posted docs are reversed, never deleted (invariant #9); every mutation writes audit (invariant #7).

### 3.1 Order-to-cash — van-sales rep (FIELD, mobile, offline-tolerant)
1. **Morning load.** Rep (or warehouse) transfers stock depot → van warehouse (existing `transfers`). Van now holds authoritative on-van balances.
2. **On route, per customer stop:** open customer (or add walk-up), **capture order** on phone — item, qty, tier price auto-filled from customer's price category (existing pricing). Credit check runs against `creditLimitCents`; over-limit needs `credit.override` (gated).
3. **Confirm sale.** For cash-van, order → invoice → payment in one confirm screen. Stock issues from van warehouse; cash/mobile-money captured with reference; payment allocated to the invoice (existing `payments` + `payment_allocations`).
4. **Offline tolerance.** Order capture and confirm queue locally when the network drops; UI shows **"saved on device" vs "posted to server"** in words + color (the R8 offline contract; `MOBILE_LOWEND_UX.md`). **Posting to the immutable ledger happens on reconnect; nothing is silently merged** (roadmap mandate). *Assumption/label:* v1 offline is **capture-and-queue on one device**, not multi-device sync (sync is Deferred — `FACTORY_OS_FEATURE_MATRIX.md` offline sync DESIGN-ONLY).
5. **End of day:** §3.4 reconciliation.

### 3.2 Order-to-delivery — depot distribution
1. **Order capture** (rep, phone/desk, or counter) → draft `sales_order`; confirming reserves stock (existing `reservations`).
2. **Pick & pack** at depot (warehouse role) against the order.
3. **Invoice** generated from the order (existing `sales.ts`, FIFO/VAT/pricing snapshot).
4. **Dispatch** → delivery note/waybill; driver (bound user) delivers; **proof-of-delivery** confirm (existing `deliveries` performance tracking).
5. **Collect** on delivery or on terms; payment + allocation (existing). Credit customers get statements (existing reporting).

### 3.3 Returns
1. Customer returns goods (damaged/unsold). Warehouse/rep raises a `sales_return` referencing the original invoice/line.
2. Stock **added back** via a new inbound `stock_movement` to the chosen warehouse (append-only; never a delete — invariant #1).
3. A **credit note** is issued; the credit becomes allocatable against the customer's open/future invoices (reuses allocation machinery). Fully audited. *Label:* v1 supports return-to-stock + credit; supplier returns and scrap disposition of unsellable returns are deferred.

### 3.4 End-of-day cash reconciliation (van)
1. System computes **expected van stock** = opening load − sales − returns (from van-warehouse movements) and **expected cash** = Σ cash sales − Σ change (from `payments` where method=cash on the route).
2. Rep enters **counted cash** and (optionally) **counted stock** — the `SacksPage` simple-transaction ritual reused.
3. **Variance** is flagged (short/over) and requires manager acknowledgement; unsold van stock transfers back depot → van reversal. Everything audited; cash variance is a first-class fraud signal (`AFRICA_BUSINESS_OS_REQUIREMENTS.md` §1.3, §5.4).

---

## 4. Roles, role experiences, KPIs, documents

Roles use the existing versioned RBAC `(module, action)` matrix. New gated actions proposed: `sales.price_override`, `credit.override`, `orders.confirm`, `vansales.reconcile`, `purchasing.approve`. These extend `EXTRA_ACTIONS` (`shared/src/index.ts:43`) in the same bounded style as `delivery: ['load','dispatch']`.

| Role | Home question (`ROLE_EXPERIENCE_SIMPLICITY.md`) | Primary screens | KPIs / signals | Documents |
|---|---|---|---|---|
| **Owner** | "How is my business today?" | Owner daily brief (dashboard) | sales today vs avg, cash collected vs sold, receivables aging + credit breaches, stock cover days & out-of-stock lines, van reconciliation variances, top items/customers, purchases due | daily brief (printable/shareable), statements |
| **Branch Manager** | "What is waiting on me & how is my branch?" | branch dashboard, approvals queue | branch sales, credit overrides pending, reconciliation exceptions, low-stock for this depot, driver/rep performance | branch report, delivery manifest |
| **Sales Rep (FIELD, mobile — most important)** | "Sell, don't oversell, get paid" | **mobile order capture, my route/customers, my van stock, collect payment, my day totals** | my sales today, my collections, my outstanding customers, van stock left, credit status per customer (color) | order confirmation, receipt |
| **Warehouse / Storekeeper** | "Trucks in, trucks out" | receiving, pick lists, transfers, van loads | to-receive today, to-pick orders, low-stock, transfer status | GRN, pick list, transfer note, van load sheet |
| **Cashier** | "Money in, reconcile" | payment capture, allocation, cash-up | cash vs mobile money in, unallocated receipts, till/route variance | receipt, deposit slip |
| **Driver** | "Deliver and confirm" | my deliveries, POD confirm (mobile) | deliveries done/pending, cash collected on delivery | delivery note, waybill, POD |

**Owner daily brief signals specific to distribution (the INTELLIGENT layer):** collections-vs-sales gap (cash leakage), receivables aging buckets + customers over credit limit, **van reconciliation variance by rep** (theft/error signal), stock cover days & stockouts of fast movers, top/bottom SKUs, orders captured-but-unfulfilled, supplier payments due. All computed-on-read on existing ledgers (no new persistence) — mirrors the existing dashboard pattern and the research's #1 opportunity (owner digest, `AFRICA_BUSINESS_OS_REQUIREMENTS.md` §8).

**Mobile-first field contract (`MOBILE_LOWEND_UX.md`, roadmap mandate):** ≥48px touch targets; interactive ≤3 s on a ~$80 phone over 3G; every tap <200 ms; numerals/icons-first; PIN fast-unlock + short idle re-lock for shared/loaned phones; confirm-before-post kept sacred; honest offline banner (saved-on-device vs posted). Rep screens are presentation + config over existing server rules where possible — do not invent new server business rules for the mobile shell beyond the NEW order/van objects.

---

## 5. Smallest excellent reusable template — v1 IN vs DEFERRED

**IN v1 (the smallest excellent trade template):**
- Reuse of the full spine: parties, inventory ledger/balances/lots/reservations/transfers, receiving, credit-controlled sales invoices (FIFO/VAT/pricing snapshot), deliveries, payments + allocations, reports, dashboard, printing/branding, RBAC/audit, settings/terminology. *(existing, tested)*
- **NEW: sales orders / quotations** (order precedes invoice; converts to invoice; reserves stock).
- **Customer hierarchy (1–2 levels) + tiered price categories** (retailer/sub-distributor/key account) via existing pricing categories + parent pointer.
- **Sales rep binding** to user + salesperson on order/invoice.
- **Light purchasing:** supplier UI + 2-step PO → receive+bill + payables view. *(supplier data exists; UI + PO NEW)*
- **Returns / credit notes** (return-to-stock + allocatable credit).
- **Van sales:** van-as-warehouse, load, mobile offline-tolerant order+sell+collect, **end-of-day cash & stock reconciliation** with variance flags.
- **Light day-routes** (ordered customer stops per rep).
- **Distribution owner daily brief** (computed signals above).
- Two shipped profiles (depot distributor / van-sales operator) from one declarative template; production+QC toggled OFF.

**DEFERRED (real, but not the smallest excellent v1):**
- Promotions / **scheme management** (free-with-purchase, slab/bonus discounts — Marg's depth, `GLOBAL_COMPETITOR_INTELLIGENCE.md` §2.10).
- **Route optimization / GPS / sequencing**; landmark addressing beyond a text field.
- **Salesperson commission** engine.
- **Costing / margins / valuation** (arrives M2 — brief leaves margin KPIs dormant until then).
- **Expiry / FEFO** (unlocks pharmacy/food sub-template later — Deferred capability).
- **Mobile-money live API** integration (v1 records references only — reconciliation-first).
- **e-invoicing / fiscal country packs** (Ethiopia fiscal, Kenya eTIMS — country-pack workstream).
- **Multi-site autonomy & sync** (v1 is multi-warehouse on one local node; site-node sync is Deferred).
- **General ledger / double-entry** (operational ledger only — platform-wide open question).
- Multi-device concurrent offline sync for van reps (v1 = single-device capture-and-queue).

**Rule respected:** extract the template from a real deployment, don't gold-plate from imagination (`AFRICA_BUSINESS_OS_REQUIREMENTS.md` §8 "extract from deployments"; roadmap risk #2). v1 is deliberately the reuse spine + orders + van + returns + light purchasing.

---

## 6. Dependencies & sequencing (implementation guidance, not code)

- **Prerequisite (platform, before tenant #2 of any kind):** multi-tenancy hardened (roadmap risk #1; D2/D4) and the **declarative template artifact** extracted from Mesob's imperative `seed.ts`/`apply-*.ts` (roadmap risk #2). The distribution template should be authored as that declarative artifact, not another imperative script.
- **`NEW:orders` depends on:** `sales` (invoice generation), `inventory` reservations. Independent of costing — can ship first.
- **`NEW:purchasing` full value depends on M2 costing** (landed cost/unit cost on receipt) for margins; the 2-step PO + payable can ship ahead with cost capture stubbed.
- **`NEW:returns` depends on:** append-only inbound movement + allocation reuse; independent of costing for stock, needs costing for value of returns.
- **`NEW:vansales` depends on:** `orders`, van-warehouse flag, `payments`; offline queue depends on R8 offline architecture (deferred sync). v1 van sales works online + single-device queue without full sync.
- **Owner daily brief:** computed-on-read on existing ledgers — buildable immediately, no new persistence.
- **Costing (M2), Expiry/FEFO, e-invoicing packs, multi-site sync** are named dependencies for the *advanced* distribution configuration and the pharmacy/food sub-templates, not for v1.

---

## 7. Open product questions for the Founder

1. **Van inventory as warehouse?** Recommended: model a van as a `warehouse` with `kind='van'` (load = transfer, sell = issue, reconcile = variance). Confirm this vs a separate van-stock construct. *(Recommendation: warehouse — maximal reuse of ledger/transfers/reservations.)*
2. **Pricing tiers — how many, and how assigned?** Are tiers purely price categories (retail/sub-distributor/key), or do sub-distributors get contract/negotiated prices per SKU? v1 assumes tier = existing price category assigned via customer hierarchy; confirm depth.
3. **Customer hierarchy depth.** Is 1–2 levels (retailer under sub-distributor under distributor) enough for the pilot, or are deeper chains needed? Affects whether a parent pointer suffices vs a hierarchy table.
4. **Order → invoice policy.** Always order-first (order is mandatory, invoice derived), or allow direct-invoice for counter/cash sales? *(Recommendation: van/cash = order+invoice in one confirm; depot = order-first mandatory.)*
5. **Which pilot tenant + country?** Distribution proof needs a real distributor (can Mesob's owner network source 2–3? — `AFRICA_SECTOR_PRIORITY.md` §5 open Q). Country choice (Ethiopia vs Kenya) sets the mobile-money reference format and any fiscal pack.
6. **Credit-override authority.** Who may exceed a credit limit (branch manager only? owner?) — sets the gated-action role mapping.
7. **Mobile-money at v1.** Confirm reconciliation-first (record telebirr/M-Pesa reference on payment) is acceptable for v1, with live APIs deferred.

---

## 8. Summary for the Team Lead

- **v1 scope:** the proven Mesob **trade spine reused** (parties, inventory ledger, receiving, credit-controlled invoicing, deliveries, payments+allocation, reports, dashboard, printing, RBAC/audit) with **production/QC toggled OFF**, PLUS a concentrated NEW delta: **sales orders/quotations (order precedes invoice), customer hierarchy + tiered pricing (via existing price categories), light purchasing (supplier UI + 2-step PO + payables), returns/credit notes, van/route sales with end-of-day cash & stock reconciliation, light day-routes, and a distribution owner daily brief.** Two profiles from one declarative template: depot distributor and van-sales operator. Field/mobile rep screens are the most important set (≥48px, offline-tolerant capture, honest online/offline state).
- **New capabilities needed (5 concentrated):** `NEW:orders`, `NEW:purchasing`, `NEW:returns`, `NEW:vansales` (van-as-warehouse + EOD reconcile), `NEW:routes` (light) — plus small EXTENDs (party parent pointer/tier, salesperson→user binding, driver→user, van `warehouseKind`, payment mobile-money reference). Full purchasing/branch value depends on M2 costing; owner brief is buildable now.
- **Reuse estimate:** **~80–85% existing code** (confirmed against `FACTORY_OS_CURRENT_STATE.md` §2 and `AFRICA_SECTOR_PRIORITY.md` §1 reuse verification). ~15 of ~24 core objects are pure reuse; ~5 are genuinely new and additive; production/QC prove the toggle.
- **Top 3 open questions:** (1) Van inventory modelled as a warehouse? (recommend yes). (2) Pricing tiers — categories only, or negotiated per-SKU sub-distributor prices, and how many tiers? (3) Which real distributor pilot tenant + country (sets mobile-money reference format and any fiscal pack)?
- **Guardrails:** author as the declarative template artifact (roadmap risk #2), require multi-tenancy hardening first (risk #1), keep the immutable ledger / append-only / audit / server-side masking invariants, defer promotions/route-optimization/commission/costing/FEFO/e-invoicing/multi-site-sync/GL. No code written; only this file created.
