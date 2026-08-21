# JENIFY AFRICA SECTOR PRIORITY REPORT

**Workstream:** R2 — Product Intelligence / Competitor Research (research only, no implementation)
**Date:** 2026-08-21 · **Status:** Draft for Team Lead synthesis
**Question studied:** Which business sectors should JENIFY OS support, in what order, and with what configuration?

---

## 1. Method and product-fit baseline

Ranking uses eight criteria (weights in §3). Product fit and template reuse are scored against
what actually exists in the repo today (`docs/FACTORY_OS_FEATURE_MATRIX.md`, 2026-08-21), not
against ambitions.

**The proven JENIFY spine (DONE, tested — 163 tests green):** auth/sessions/recovery · versioned
RBAC · audit trail · versioned settings · editable terminology/i18n framework · document
numbering · master data (UoM/items/warehouses) · customers · append-only stock ledger + derived
balances · lot tracking · reservations · goods receiving · transfers · production stages/batches
(measured/conserved/converted policies) · QC gates + release + genealogy · sales invoices
(FIFO, VAT, pricing snapshots) · credit limits · deliveries (performance-tracked) · payments +
explicit multi-invoice allocation (simple multi-currency) · 9 reconciling reports · owner
dashboard + computed alerts · print subsystem with branding snapshots · setup wizard.

**Known gaps that constrain sector choice (PARTIAL/MISSING/DESIGN-ONLY):** supplier UI, purchase
orders, costing/valuation/margins, returns/credit notes, stock adjustments/counts, reorder
alerts, expiry/FEFO/serial tracking, BOM/material consumption, scheduling, notifications,
maintenance/assets, workforce/shifts, offline writes/sync, multi-site, **no general ledger /
double-entry accounting**, no POS/barcode capture, no payroll, no project costing.

**Reuse verification (claim tested against the matrix):** the assertion that
distribution/retail reuse the manufacturing spine heavily is **confirmed**. A distributor or
structured retailer needs: items/UoM/warehouses ✔, receiving ✔, stock ledger/balances ✔,
lots ✔, transfers ✔, reservations ✔, credit-controlled invoicing ✔, deliveries ✔,
payments/allocations ✔, customer statements/reports ✔, printed documents ✔, RBAC/audit ✔.
Roughly **80–85% of a trade deployment is DONE code**; the trade-specific gap list is short and
already on the roadmap's M2/M4 axis (purchase orders + cost capture, returns/credit notes,
stock counts/adjustments, reorder alerts, barcode/fast sale entry). Production/QC modules
simply switch off — the core-vs-config architecture supports this without forking. This reuse
factor dominates the ranking below.

---

## 2. Ranking criteria and weights

| Criterion | Weight | Note |
|---|---|---|
| African market relevance | 10% | Share of African economy/employment |
| Number of potential customers | 15% | Addressable SME count |
| Pain level | 15% | How badly current tools/spreadsheets fail them |
| JENIFY product fit **today** | 20% | Scored against the feature matrix, not plans |
| Ease of onboarding | 10% | Setup effort, data migration, user sophistication |
| Revenue opportunity | 10% | Willingness/ability to pay per tenant |
| Template reuse | 15% | % of DONE spine reused; knowledge compounding |
| Implementation ease (inverse complexity) | 5% | New modules/regulatory burden required |

Scores 1–5 per criterion. Full scoring table in §3; per-sector evidence and configuration in §4.

---

## 3. Priority ranking (all candidates)

| # | Sector | Score | One-line verdict |
|---|---|---|---|
| 1 | **Wholesale / Distribution** | 4.75 | Near-total spine reuse; biggest SME segment; credit+stock pain is exactly what JENIFY solves |
| 2 | **Manufacturing (process / agro-processing)** | 4.15 | Proven with Mesob; highest revenue per tenant; template already exists in production |
| 3 | **Retail (structured trade)** | 4.05 | Massive count; reuses spine; needs fast-sale/barcode UX; monetize the upper informal tier |
| 4 | **Pharmacy (retail + wholesale)** | 3.85 | High pain, regulated, pays; needs expiry/FEFO built (already a declared tracking mode) |
| 5 | **Automotive (parts trade + workshops)** | 3.75 | Scores high *because* it is the trade spine + job cards; ship as a subsector template, not a separate build |
| 6 | **Agriculture (aggregators / cooperatives / out-grower ops)** | 3.70 | Receiving+lots+quality+payments map perfectly to crop aggregation; seasonal, harder onboarding |
| 7 | **Education (private schools)** | 3.55 | Fee billing = invoices+payments+credit reused with no inventory; crowded local competitor field |
| 8 | **Restaurant / Food service** | 3.10 | POS-centric and crowded; only attractive later via recipe/stock control for mid-size operators |
| 9 | **Logistics / Transport** | 2.90 | Trip/fleet/fuel objects are new physics; deliveries module is a seed, not a product |
| 10 | **NGOs / Non-profits** | 2.90 | Huge count and real pain, but needs project/grant/fund accounting JENIFY lacks |
| 11 | **Real Estate (property management)** | 2.90 | Recurring rent billing reuses payments spine; small tenant counts per country; later niche |
| 12 | **Construction** | 2.85 | High value but needs project costing/progress billing — a genuinely new module family |
| 13 | **Healthcare (clinics)** | 2.75 | EMR is the buying criterion and is off-core; pharmacy/inventory side already covered by #4 |
| 14 | **Professional Services** | 2.70 | Simple invoicing already served by cheap accounting tools; JENIFY differentiators wasted |
| 15 | **Hospitality / Hotels** | 2.65 | PMS/channel-manager is the product hotels buy; crowded global cloud competition |
| 16 | **Mining (SME quarry/aggregates)** | 2.65 | Big money but few SME customers; enterprise incumbents; quarry ops are a manufacturing variant later |
| 17 | **Government-adjacent operations** | 2.25 | Procurement cycles, tender risk, customization demands — poison for a small team now |

Scoring detail (criterion order: relevance / customers / pain / fit / onboarding / revenue / reuse / ease):
Distribution 5/5/5/5/4/4/5/4 · Manufacturing 4/3/4/5/3/5/5/3 · Retail 5/5/4/4/4/2/4/4 ·
Pharmacy 4/3/5/4/3/4/4/3 · Automotive 4/4/4/4/3/3/4/3 · Agriculture 5/4/4/4/2/3/4/2 ·
Education 4/4/4/3/4/3/3/4 · Restaurant 4/5/3/2/3/2/3/3 · Logistics 4/3/4/2/3/3/2/3 ·
NGOs 4/4/3/2/3/3/2/3 · Real Estate 3/2/3/3/3/3/3/4 · Construction 4/3/4/2/2/4/2/2 ·
Healthcare 4/3/4/2/2/3/2/2 · Prof. Services 3/4/2/2/4/2/2/4 · Hotels 3/3/3/2/3/3/2/3 ·
Mining 3/1/3/3/2/4/3/2 · Government 3/2/3/2/1/3/2/2.

---

## 4. Sector profiles

Depth is proportional to rank: full profiles for ranks 1–5, tight structured entries below that.

### 4.1 Wholesale / Distribution — RANK 1

**Market evidence.** Wholesale/retail trade is the single largest MSME sector in Africa —
25.3% of Nigerian MSMEs (PwC MSME Survey 2024, high confidence). Africa's informal retail
market ≈ USD 600B and ~70% of consumers buy through informal shops supplied by wholesalers and
distributors (Wasoko/Africa Signal, 2025, medium). B2B commerce players prove the pain at
scale: MaxAB-Wasoko serves ~450,000 merchants across 5 markets and acquired Fatura's network of
626 wholesalers (WeeTracker, May 2025, high) — yet these platforms digitize *ordering from*
distributors, not the distributor's own internal operations, which remain on paper/Excel. Field
tools (Solutech, FieldAssist, BeatRoute) confirm poor inventory control, credit-sale
reconciliation, and van-sales chaos as the canonical pain points (vendor material, 2024–25,
medium — inference: they sell to brands, leaving independent distributors underserved).

- **Target businesses:** FMCG/beverage/building-materials/food-staples distributors, regional
  wholesalers, importer-traders, van-sales operators, sub-distributors; 5–100 staff, 1–5
  warehouses, heavy credit books.
- **Smallest useful configuration:** items + warehouses + customers + receiving + stock ledger
  + credit-limited sales invoices + deliveries + payments/allocations + customer statements.
  **All DONE today** — a distributor tenant is deployable with production modules toggled off.
- **Advanced configuration:** purchase orders + landed cost + margins (M2), returns/credit
  notes, reorder alerts, stock counts, van/route sales (mobile fast-entry + driver
  reconciliation), price lists per customer tier, multi-site branches, salesperson commission.
- **Essential modules:** master data, receiving, inventory, sales/credit, deliveries,
  payments, reports, printing, RBAC/audit. **Optional:** production (off), QC (off — or on for
  repackers), purchasing/costing, route sales, promotions.
- **Key objects:** supplier, purchase order, goods receipt, item/price list, stock
  lot/balance, sales invoice, delivery/route, van stock, payment, credit account, count sheet.
- **Workflows:** procure → receive → store/transfer → reserve → invoice (credit check) →
  deliver/van-sell → collect/allocate → reconcile stock and cash daily.
- **Roles:** Owner, Warehouse/Storekeeper, Sales Clerk, Van Salesperson/Driver, Cashier,
  Credit Controller, Accountant (read/export). **Permissions:** existing (module, action)
  matrix fits; add price-override and credit-override as gated actions.
- **Dashboards/KPIs:** stock cover days, out-of-stock lines, receivables aging, credit
  utilization, collections vs sales, van reconciliation variance, top items/customers, margin
  (post-M2). **Reports:** existing 9 + purchases, margins, route/driver performance, aging.
- **Documents:** PO, GRN, invoice, delivery note, waybill, receipt, statement — numbering +
  branding snapshots already built.
- **Integrations:** mobile money (M-Pesa/Telebirr) payment capture, thermal/Bluetooth
  printers, barcode scanners, later supplier B2B portals.
- **AI opportunities:** reorder suggestions from velocity, credit-risk scoring from payment
  history, natural-language "how much does X owe / what's low in warehouse 2" (read-only
  intents first per AI safety principle).
- **Offline:** HIGH — depots have poor connectivity; local-first is a decisive advantage over
  cloud B2B platforms; van sales eventually need offline mobile capture (deferred sync work).
- **Localization:** VAT rates (done), currency (done), Amharic/Swahili/French/Arabic
  terminology (framework done, content per country), fiscal-receipt rules (e.g. Ethiopian
  fiscal printers, Kenyan eTIMS) as country packs.

### 4.2 Manufacturing (process / agro-processing) — RANK 2

**Market evidence.** Agro-industries average 27% of formal employment and 39% of formal output
in SSA, with informal SMEs adding more (ReSAKSS ATOR 2022, high). Only 12–15% of Africa's
agricultural GDP is captured in processing — governments (AGRA, UNIDO, Digital Ethiopia 2025)
are actively pushing local processing, i.e. new factories (medium-high). Manufacturing is
22.5% of Nigerian MSMEs (PwC 2024, high). Africa ERP market: USD 768M (2024) → USD 1.68B
(2030), 12.9% CAGR, driven partly by manufacturing modernization (NextMSC, 2025, medium —
vendor report). This is JENIFY's **proven** sector: Mesob (salt processing) is live-validated.

- **Target businesses:** salt/flour/oil/water/dairy/coffee/spice/beverage/soap/detergent
  processors, bakeries at industrial scale, animal-feed mills, plastics/packaging converters;
  10–300 staff, batch/process production with QC obligations.
- **Smallest useful configuration:** the Mesob template — receiving → staged production
  (measured/conserved/converted) → QC gate + release → packaging → inventory → credit sales →
  delivery → payments → reports. **Exists in production.**
- **Advanced configuration:** BOM/recipe + material consumption (M3), costing/margins (M2),
  manufacturing orders/scheduling (M3+), scrap/rework ledger trace (M4), maintenance/machines
  (M5 design), shifts/attendance (M5 design), multi-site.
- **Essential modules:** everything Mesob uses. **Optional:** BOM, scheduling, maintenance,
  workforce, multi-currency purchasing.
- **Key objects:** production stage, batch, quality test, release, lot genealogy, BOM (future),
  work center (future) — plus the full trade spine for the sales side.
- **Workflows/roles/permissions:** proven — Production Operator / Production Supervisor /
  Quality Management separation is a Founder-approved decision; reuse as-is.
- **Dashboards/KPIs:** yield per stage, QC pass rate, batch cycle time, units
  rejected, stock cover, receivables — largely built. **Reports/documents:** built.
- **Integrations:** scale/weighbridge capture, fiscal printers, lab instruments (later).
- **AI opportunities:** yield-anomaly flagging, QC-failure pattern detection, demand-based
  production suggestions.
- **Offline:** HIGH — factories run where power/connectivity fail; local-first already the
  design. **Localization:** iodization/food-standard terminology per country; certification
  documents (e.g. Ethiopian standards agency) as printed-doc templates.
- **Caveat:** fewer addressable customers than trade and slower onboarding (physics must be
  configured per factory) — but each deployment compounds the template library, and revenue
  per tenant is the highest of any sector.

### 4.3 Retail (structured trade) — RANK 3

**Market evidence.** Retail dominates African MSME counts (with wholesale, ~25% in Nigeria;
retail employs 30% of women-owned SMEs — AAE/MOHAC, medium). South Africa's wholesale+retail
sector ≈ ZAR 2.4T, 15% of GDP (MIBRE 2025, medium). The addressable JENIFY tier is **not** the
single kiosk (served by free POS apps and B2B platforms) but the structured tier: mini-markets,
pharmacies-adjacent shops, building-materials/hardware stores, electronics shops, multi-branch
retailers — businesses with stock rooms, staff, and credit customers.

- **Target businesses:** mini-markets/supermarkets (1–10 branches), hardware/building
  materials, electronics/phone shops, agro-dealers, boutiques with inventory discipline.
- **Smallest useful configuration:** items + one warehouse + fast sales entry + payments +
  daily stock/cash report. Spine is DONE **except a fast POS-style sale screen and barcode
  capture** — the critical build for this sector.
- **Advanced configuration:** multi-branch transfers (done), purchase orders/costing (M2),
  reorder alerts, stock counts (M4), customer loyalty/price tiers, returns (M4).
- **Essential:** master data, inventory, sales, payments, reports, RBAC. **Optional:**
  receiving/PO, credit module (hardware stores use it heavily), deliveries, production (off).
- **Key objects:** SKU/barcode, price list, sale, shift/till session (new), count sheet.
- **Workflows:** receive → shelve → sell (fast) → end-of-day cash+stock reconciliation.
- **Roles:** Owner, Shopkeeper/Cashier, Storekeeper, Branch Manager. **Permissions:** existing
  matrix + till-session and discount-limit actions.
- **Dashboards/KPIs:** daily sales, gross margin (post-M2), shrinkage, stock cover,
  best/dead sellers, till variance. **Documents:** receipt, invoice, statement (built).
- **Integrations:** barcode scanners, cash drawers, thermal printers, mobile money, fiscal
  devices (mandatory in Ethiopia/Kenya/Rwanda/Tanzania — a real country-pack dependency).
- **AI:** reorder suggestions, dead-stock alerts, sales anomaly detection.
- **Offline:** CRITICAL — a shop cannot stop selling when the network drops; local-first is
  the differentiator vs cloud POS. **Localization:** fiscal receipts, VAT, local languages.
- **Caveat:** willingness to pay per tenant is the lowest of the top group; wins on volume and
  on being the natural downstream of distribution tenants (same template family).

### 4.4 Pharmacy (retail + wholesale) — RANK 4

**Market evidence.** mPharma runs vendor-managed inventory across 850+ pharmacies in Ghana,
Nigeria, Kenya, Zambia, Zimbabwe, Malawi and **Ethiopia** (Today Africa, 2025, high),
proving expiry/stock/forecast pain is acute and monetizable. Africa digital health projected
~USD 8.4B by 2028 (Kapsule, 2025, low-medium). Dedicated pharmacy software directories for
Africa are thin and mostly foreign (SourceForge/Capterra 2025-26, medium) — a localized,
offline pharmacy template has room.

- **Target businesses:** community pharmacies (1–10 branches), pharmaceutical wholesalers/
  importers, hospital pharmacies; regulated, literate staff, real margins.
- **Smallest useful configuration:** trade spine + **expiry/FEFO lot tracking** (the one hard
  gap — `trackingMode` is declared in the schema but unbuilt) + fast sale + purchase capture.
- **Advanced configuration:** batch recalls via lot genealogy (already built for
  manufacturing — direct reuse), reorder points, controlled-substances register, insurer/
  claim export (Kenya SHA), multi-branch.
- **Essential:** master data, inventory with expiry, receiving, sales, payments, reports,
  audit (regulatory value). **Optional:** credit, deliveries (wholesale side), QC (repackers).
- **Key objects:** drug item (generic name, strength, form), expiry lot, prescription-note
  (light), supplier, recall notice.
- **Workflows:** receive with expiry capture → FEFO pick → dispense/sell → expiry watchlist →
  return-to-supplier; wholesale: PO → receive → credit-sell to pharmacies → collect.
- **Roles:** Owner/Pharmacist-in-charge, Dispenser, Storekeeper, Cashier. **Permissions:**
  existing matrix + controlled-item actions.
- **Dashboards/KPIs:** expiring-in-90-days value, stockout rate of fast movers, margin,
  expiry write-off, purchases vs sales. **Reports:** expiry list, movement register (often a
  legal requirement), the existing stock/sales set.
- **Documents:** receipt, invoice, GRN, expiry/write-off form.
- **Integrations:** barcode, insurers/claims (per country), mobile money.
- **AI:** demand forecast per drug, expiry-risk ranking, substitution suggestions (careful:
  read-only, never clinical advice).
- **Offline:** HIGH. **Localization:** national drug lists, regulator formats (Ethiopia EFDA,
  Kenya PPB, Nigeria PCN), VAT exemption rules for medicines.
- **Verdict:** the best *paying* niche adjacent to the trade template; unlocks after
  expiry/FEFO ships (a scoped M4-class build, not a new domain).

### 4.5 Automotive (parts trade + workshops) — RANK 5 (as a subsector template)

**Market evidence.** Large, growing aftermarket across passenger/commercial fleets; parts flow
largely through informal channels and small traders; reliable inventory is cited as the
competitive edge for parts dealers (africon / Aviaan, 2024-25, medium). Workshop software
exists but is generic/foreign (SourceForge 2026, medium).

- **Target businesses:** spare-parts importers/wholesalers/retailers, garages/workshops, small
  fleet maintainers.
- **Smallest useful:** the retail/distribution template verbatim (parts = SKUs with
  cross-references). **Advanced:** workshop job cards (labor + parts consumption — a light
  cousin of production batches), vehicle history, fleet PM schedules (M5 maintenance design).
- **Key objects:** part (OEM/alt numbers), vehicle, job card, mechanic. **Roles:** Owner,
  Counter Sales, Storekeeper, Mechanic, Service Advisor.
- **KPIs:** parts margin, job turnaround, mechanic productivity, dead stock. **Documents:**
  quote, job card, invoice, GRN.
- **Integrations:** barcode, mobile money. **AI:** part-number lookup/matching from free text
  (high value — messy naming is the sector's data problem). **Offline:** HIGH.
  **Localization:** import-duty cost tracking (needs M2 landed cost).
- **Verdict:** do **not** build separately — ship as a named subsector template of
  retail/distribution plus a thin job-card module later. Scores high precisely because it is
  the spine.

### 4.6 Agriculture — aggregators, cooperatives, out-grower schemes (RANK 6)

**Evidence:** smallholder-segment farm software is the fastest-growing slice (~15.6% CAGR,
Mordor, medium); cooperative platforms (FtMA ~150k farmers, DigiFarm) prove the aggregation
model; digitizing aggregation centers is flagged as the "quick win" (NextBillion, medium).
**Target:** crop aggregators/traders, coffee/sesame/grain cooperatives and unions, out-grower
operators. **Smallest useful:** receiving with weight+quality grade per farmer lot → farmer
ledger (parties + payments out) → stock → bulk sales — direct reuse of receiving, lots,
quality tests, payments. **Advanced:** seasonal campaigns, input-credit against deliveries,
grading-based pricing, multi-collection-site sync. **Key objects:** farmer, collection site,
grade, season, advance. **Roles:** buyer/clerk, warehouse, cashier, manager. **KPIs:** volume
by site/farmer, grade mix, price paid vs market, farmer balances. **Documents:** goods receipt
ticket, farmer statement, sales contract. **Integrations:** scales, mobile-money payouts.
**AI:** price/grade anomaly detection. **Offline:** EXTREME — collection points are rural;
JENIFY's local-first design is a genuine wedge, but multi-site sync (deferred) becomes the
binding constraint. **Localization:** commodity boards (ECX in Ethiopia), cooperative
regulation. **Caveat:** seasonal cashflows, donor-mediated purchasing, low digital literacy →
slower onboarding; rank rises sharply once multi-site/offline sync exists.

### 4.7 Education — private schools (RANK 7)

**Evidence:** Nigerian private schools pay ₦80k–₦800k/year for school management systems;
digitized fee collection is the anchor feature; market is active with local vendors (Edves
et al., 2025, medium). **Target:** private K-12 schools, colleges, training centers.
**Smallest useful:** student register (parties) + termly fee invoices + payments/allocations +
arrears (credit module re-labeled) + statements — near-total reuse of the billing spine, zero
inventory. **Advanced:** class/term structures, sibling discounts, payment plans, parent
receipts via SMS, payroll (missing), academics (out of scope — partner or ignore).
**Key objects:** student, guardian, class, term, fee structure. **Roles:** bursar, registrar,
head, owner. **KPIs:** collection rate, arrears aging, enrollment. **Documents:** fee invoice,
receipt, statement. **Integrations:** mobile money/bank, SMS. **AI:** arrears-risk flags.
**Offline:** medium. **Localization:** term calendars, language. **Caveat:** entrenched cheap
local competitors differentiate on academics (report cards, CBT exams) which JENIFY should not
build; enter only as a "fees and operations" template, or skip.

### 4.8 Restaurant / Food service (RANK 8)

**Target:** mid-size restaurants, caterers, cafeteria contractors, cloud kitchens.
**Smallest useful:** menu-item sales + daily cash + purchases; real value arrives with recipe
(BOM) → ingredient consumption → food-cost variance, which needs M3 BOM work.
**Modules:** sales (fast entry), inventory, receiving; optional tables/KDS (do not build —
crowded POS space: iKhokha, Oracle/NCR downmarket; SA hospitality POS alone USD 114.5M, 9.7%
CAGR — Grand View, medium). **Objects:** menu item, recipe, wastage. **KPIs:** food cost %,
daily covers, wastage. **Offline:** critical. **Verdict:** revisit after BOM (M3) as a
"food-cost control" angle for serious operators, not a POS play.

### 4.9 Logistics / Transport (RANK 9)

**Target:** small fleet owners (5–50 trucks), transporters serving distributors, last-mile
operators. **Evidence:** digital brokerage (Kobo360 ~30k trucks; Lori 20k+ across 12
countries — CB Insights/Africa Signal, medium) digitizes matching, not the fleet owner's own
ops (trips, fuel, maintenance, driver settlements — still Excel). **Smallest useful:** trip
records + trip revenue/expense + customer invoicing (reuse) + driver ledger. **Advanced:**
fuel tracking, maintenance schedules (M5), tyre/parts inventory (reuse), GPS integration.
**Objects:** vehicle, trip, driver, fuel log. **KPIs:** revenue/km, fuel variance, utilization,
downtime. **Offline:** high. **Verdict:** real niche, but trip/fleet physics is a new module
family; sequence after maintenance/asset design (M5). Note: JENIFY's *deliveries* module
already gives distribution tenants light transport tracking — capture the need there first.

### 4.10 NGOs / Non-profits (RANK 10)

**Evidence:** 268k registered NPOs in South Africa alone; 67% of medium/large NGOs run
projects on spreadsheets/email (KendoManager 2026, medium). **Target:** local NGOs, program
implementers. **Smallest useful:** project/grant cost tracking + procurement + inventory of
supplies (reuse) + donor-format reports. **Gap:** fund/grant accounting and budget-vs-actual
are the buying criteria — JENIFY has no GL. **Offline:** high (field programs). **Verdict:**
attractive count, but requires the accounting layer; defer until a finance module exists.
Donor-funded deployments could however *pay well* as services engagements later.

### 4.11 Real Estate — property management (RANK 11)

**Target:** landlords/agents with 10–500 units, small property managers. **Smallest useful:**
unit register + recurring rent invoices + payments/arrears + statements (billing-spine reuse;
recurring-invoice generation is a small build). **Advanced:** leases, deposits, maintenance
requests (M5 seed), utility recharges. **KPIs:** occupancy, arrears, collection rate.
**Offline:** low-medium. **Verdict:** cheap template on the billing spine; niche volume; fine
as an opportunistic template, never a program.

### 4.12 Construction (RANK 12)

**Evidence:** African construction-management adoption nascent, modular/low-code preferred
(360iResearch/DBMR, medium); material-cost volatility (steel/aluminum tariffs up to 50%)
makes cost control the pain (Fortune BI 2025, medium). **Target:** SME contractors,
subcontractors, materials-heavy builders. **Smallest useful:** project as cost-center +
material issues from store (inventory reuse) + supplier purchases + client progress invoices.
**Gap:** project costing, budgets/BOQ, retention/progress billing, equipment — a new module
family; labor is informal (payroll gap). **Roles:** QS, site manager, storekeeper. **KPIs:**
cost vs budget, material variance per site. **Offline:** extreme (sites). **Verdict:** high
revenue but heavy build + messy site data; defer until multi-site and costing exist. The
*building-materials supplier* (retail/distribution template) is the near-term way to serve
this market.

### 4.13 Healthcare — clinics & small hospitals (RANK 13)

**Evidence:** EMR adoption real but fragmented; Helium Health, ClinikEHR, Easy Clinic contest
the SME tier (AjirMed/Kapsule 2025-26, medium). **Target:** private clinics, diagnostic labs.
**Smallest useful:** patient billing + pharmacy/consumables stock (reuse). **Gap:** the EMR
(clinical records, appointments, lab results) is the product clinics actually buy — off
JENIFY's core and regulated. **Verdict:** serve the *pharmacy/stock/billing* slice via the
pharmacy template; do not build an EMR.

### 4.14 Professional Services (RANK 14)

**Target:** law/accounting/engineering/IT firms. **Need:** time/engagement billing, retainers —
plain invoicing+payments reuse, but cheap accounting SaaS (Zoho, QuickBooks, Wave) owns this
space and JENIFY's inventory/production differentiators are irrelevant. **Verdict:** support
incidentally (any tenant can invoice services); never target.

### 4.15 Hospitality / Hotels (RANK 15)

**Target:** guesthouses, lodges, small hotels. **Need:** rooms/rates/reservations/channel
managers (Hotelogix, eZee et al. — crowded cloud space, medium). JENIFY reuse limited to
stores/procurement/F&B stock. **Verdict:** skip as a lead sector; the F&B-stock angle rides
the restaurant/BOM work if ever needed.

### 4.16 Mining — SME quarry/aggregates (RANK 16)

Industrial mining is enterprise territory (SAP/Pronto). The SME slice — quarries, crushers,
sand/aggregate producers — is really *process manufacturing* (blast/crush/screen stages,
weighbridge sales, credit customers) and could reuse the Mesob pattern later. Few customers,
high per-tenant value, safety/royalty compliance per country. **Verdict:** opportunistic
manufacturing-template variant only.

### 4.17 Government-adjacent operations (RANK 17)

Parastatals, municipal utilities, government suppliers. Long procurement cycles, tender
compliance, customization pressure, payment risk — all hostile to a small local-first team.
**Verdict:** decline until JENIFY has scale; individual government *suppliers* are just trade
tenants and are welcome.

---

## 5. Cross-cutting findings for the Team Lead

1. **One template family covers ranks 1, 3, 5 (and feeds 4):** distribution, retail, and
   automotive are one "trade spine" with different toggles — the highest-leverage extraction
   target from Mesob. This matches the roadmap's "template extraction from Mesob" candidate
   and the strategic-risk note that templates must become declarative artifacts first.
2. **The 3 highest-ROI feature builds by sector unlock:** (a) purchase orders + cost/margin
   capture (unlocks credible trade + manufacturing costing — M2), (b) expiry/FEFO lots
   (unlocks pharmacy + food distribution), (c) fast-sale/barcode entry (unlocks retail).
   Returns/credit notes and stock counts follow closely (trade trust features).
3. **Offline-first is the wedge everywhere.** Every top-6 sector lists offline as high-to-
   extreme need; cloud competitors (Odoo/ERPNext partners growing in Nairobi/Lagos — medium)
   are weakest exactly there. JENIFY should market local-first as the headline, and treat the
   deferred sync/multi-site work as the gate to agriculture (#6) and construction (#12).
4. **No general ledger is the ceiling** for NGOs, construction, professional services, and
   full ERP replacement conversations. A decision is eventually needed: build light
   accounting, or integrate/export to local accountants' tools. Flag as an open question.
5. **Fiscal/e-invoicing country packs** (Ethiopia fiscal printers, Kenya eTIMS, Rwanda EBM,
   Tanzania EFD) are the most concrete localization dependency for trade sectors — worth an
   R-workstream of their own before retail go-lives outside Ethiopia.
6. **Sector counts favor trade, revenue favors manufacturing** — the portfolio answer is to
   run both: manufacturing deepens (few, high-value, slow), trade scales (many, low-touch,
   template-driven).

**Open questions:** (a) Which country after Ethiopia? Kenya (eTIMS, M-Pesa, mature SME tech
market) vs Nigeria (largest counts, hardest logistics) materially changes localization order.
(b) Pricing model per sector (per-tenant flat vs per-user) — no evidence gathered here.
(c) Whether Mesob's owner network can source 2–3 distributor pilot tenants (fastest possible
validation of rank 1).

---

## 6. Sources

Accessed 2026-08-21 via web search. Confidence: H = multiple corroborating sources or primary
data; M = single credible source or vendor-published; L = promotional/unverified.

| Source | Used for | Conf. |
|---|---|---|
| [PwC Nigeria MSME Survey 2024](https://www.pwc.com/ng/en/assets/pdf/pwc-msme-survey-report-2024.pdf) | Sector shares: wholesale/retail 25.3%, manufacturing 22.5% | H |
| [IFC / SME Finance Forum](https://www.smefinanceforum.org/post/ifc-sme-finance-forum-target-solutions-to-africa%E2%80%99s-331-billion-sme-finance-gap) | 44M formal MSMEs SSA; $331B finance gap; 51% credit-constrained | H |
| [WeeTracker — MaxAB-Wasoko/Fatura, May 2025](https://weetracker.com/2025/05/19/maxab-wasoko-acquires-fatura/) + [TechCrunch merger coverage](https://techcrunch.com/2024/08/27/wasoko-maxab-complete-merger) | 450k merchants; B2B commerce landscape | H |
| [Africa Signal — Wasoko](https://africasignal.com/wasoko-the-digital-supply-chain-powering-africas-informal-retail-revolution/) | ~$600B informal retail; 70% informal share | M |
| [NextMSC Africa ERP Market](https://www.nextmsc.com/report/africa-erp-software-market-ic3591) | Africa ERP $768M→$1.68B, 12.9% CAGR | M |
| [Fortune BI — MEA ERP](https://www.fortunebusinessinsights.com/middle-east-africa-enterprise-resource-planning-erp-software-market-107426) | MEA ERP $5.38B (2024) | M |
| [ReSAKSS ATOR 2022 ch.5](https://www.resakss.org/sites/default/files/2022_ator_individual_chapters/Chapter%205_ReSAKSS_AW_ATOR_2022.pdf) + [IntechOpen](https://www.intechopen.com/online-first/1255062) | Agro-processing 27% employment / 39% output; 12–15% of ag GDP processed | H |
| [MIBRE SA Wholesale & Retail 2025](https://mibre.co.za/wholesale-retail-sector-report-2025/) | SA trade sector ZAR 2.4T, 15% GDP | M |
| [Today Africa — mPharma](https://todayafrica.co/inside-mpharmas-journey/) | 850+ pharmacies, 7 countries incl. Ethiopia; VMI model | H |
| [Kapsule — EHR in Africa](https://kapsuletech.com/blog/electronic-health-records-africa/) + [AjirMed](https://ajirmed.com/top-10-ehr-or-emr-electronic-medical-record-software-companies-for-hospitals-in-african-nations.electronic-medical-records-emr-nigeria) | EMR fragmentation; $8.4B digital health by 2028; SME-tier vendors | M |
| [Grand View — SA hospitality POS](https://www.grandviewresearch.com/industry-analysis/south-africa-hospitality-point-of-sale-software-market) | $114.5M (2024), 9.7% CAGR; iKhokha township positioning | M |
| [Edves 2025 guides](https://edves.org/ultimate-guide-school-management-software-nigeria-2025/) + [SchoolTech Nigeria pricing](https://schooltechnigeria.com/school-management-software-pricing-nigeria/) | Nigerian school-software pricing ₦80k–₦800k/yr | M |
| [KendoManager — SA NGOs 2026](https://www.kendomanager.com/project-management-software-south-african-ngos) | 268k NPOs; 67% on spreadsheets | M |
| [CB Insights — Kobo360](https://www.cbinsights.com/company/kobo360) + [Africa Signal — Lori](https://africasignal.com/lori-systems-building-the-digital-highways-for-africas-cargo/) | 30k / 20k+ trucks; brokerage-not-ops gap | M |
| [Mordor — Farm Management Software](https://www.mordorintelligence.com/industry-reports/farm-management-software-market) + [NextBillion](https://nextbillion.net/digital-agriculture-smallholders/) | Smallholder 15.6% CAGR; aggregation-center digitization | M |
| [trade.gov Ethiopia Digital Economy](https://www.trade.gov/country-commercial-guides/ethiopia-digital-economy) + [Shega — Digital Ethiopia 2025](https://shega.co/news/digital-ethiopia-2025-progress-challenges-and-the-road-ahead) | Ethiopia digitization policy; IT services 9.67% CAGR | M |
| [Solutech](https://solutech.co.ke/van-sales), [FieldAssist](https://fieldassist.com/blog/distributor-management-software-for-africa-fmcg-brands/), [BeatRoute](https://beatroute.io/sales-transformation/fmcg-route-to-market-in-africa/) | FMCG route-to-market pain points (vendor-published) | M |
| [africon — spare parts channels](https://africon.de/en/how-automotive-spare-parts-actually-reach-end-customers-in-africa/) | Aftermarket channel structure | M |
| [CloudSpinx](https://cloudspinx.co.ke/blog/odoo-erp-east-africa-smes/) / [Serpa Africa](https://serpa.africa/insights/odoo-erp-implementation-guide-for-smes-in-southern-africa/) | Odoo/ERPNext partner growth in Africa (competitive context) | M |

---

## 7. TOP-5 FOR THE TEAM LEAD

1. **Wholesale / Distribution** — 80–85% of the deployment is DONE code today; largest African
   SME segment; credit-plus-stock chaos is precisely the Mesob-proven spine.
2. **Manufacturing (process / agro-processing)** — the proven, founder-validated template with
   the highest revenue per tenant; every deployment compounds the template library.
3. **Retail (structured trade)** — enormous customer count riding the same trade template; one
   focused build (fast-sale/barcode entry) opens it; offline-first beats cloud POS.
4. **Pharmacy (retail + wholesale)** — highest pain-and-pay niche adjacent to trade; unlocked
   by building expiry/FEFO, which is already a declared-but-unbuilt tracking mode.
5. **Agriculture (aggregators / cooperatives)** — receiving+lots+grading+payments map directly
   onto crop aggregation and the offline need is extreme (JENIFY's wedge); gated on
   multi-site/sync, so sequence behind 1–4. *(Automotive parts/workshops scored #5 numerically
   but ships free as a subsector template of ranks 1/3 — no separate program needed.)*
