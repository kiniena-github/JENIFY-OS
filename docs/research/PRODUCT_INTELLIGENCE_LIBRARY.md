# PRODUCT INTELLIGENCE LIBRARY — the living classified index

**Owner:** jenify-product-research (Product Intelligence) · **Mission §40** · **Opened:** 2026-08-22
**Consolidates & extends (does not repeat):**
[GLOBAL_COMPETITOR_INTELLIGENCE.md](GLOBAL_COMPETITOR_INTELLIGENCE.md) (R1, 20 profiles),
[COMPETITOR_WAR_ROOM_R2.md](COMPETITOR_WAR_ROOM_R2.md) (R2, sector-vertical + failure evidence),
[AFRICA_BUSINESS_OS_REQUIREMENTS.md](AFRICA_BUSINESS_OS_REQUIREMENTS.md) (Africa requirements),
[FEATURE_INTELLIGENCE.md](FEATURE_INTELLIGENCE.md) (91-row structured dataset).
**Grounded in:** [FACTORY_OS_FEATURE_MATRIX.md](../FACTORY_OS_FEATURE_MATRIX.md) for every "status" cell.

> **What this document is.** ONE decision-ready index the Team Lead can act on. It classifies every
> durable finding from the whole research program into a single scheme, states whether JENIFY can deliver
> the same value *more simply*, and marks what is **shipped vs merely planned** — the two never blurred.
> The exhaustive per-competitor rows still live in `FEATURE_INTELLIGENCE.md`; this is the synthesis on top.

---

## 0. How to read this — legend, discipline, method

**Classification (single scheme for the whole program):**

| Tag | Meaning |
|---|---|
| **CORE** | Platform primitive every tenant gets; lives in `@factoryos/shared`/`server`/`web`. |
| **SHARED CAPABILITY** | Reusable engine parameterized by templates (rides core, not tenant-specific). |
| **SECTOR** | Belongs to one sector template (mfg, retail, distribution, pharmacy, logistics, construction…). |
| **SUBSECTOR** | A narrower slice inside a sector (e.g. pharmacy *insurance billing*). |
| **COUNTRY** | Country pack (tax, e-doc, language, payment rail, calendar). |
| **COMPANY CONFIG** | A per-tenant switch/threshold, not new code. |
| **ROLE EXPERIENCE** | Same data, role-scoped interface/dashboard/mobile nav. |
| **AI** | Belongs to the (future-planned) AI layer; obeys the AI-safety pipeline. |
| **LATER** | Right idea, wrong time — sequence after a prerequisite. |
| **REJECT** | Studied and declined (bloat / anti-pattern / lock-in). |

**Implementation status (grounded in the feature matrix, not aspiration):**
`shipped` = matrix **DONE** · `designed` = matrix **DESIGN-ONLY** or an approved contract (O2/O3, M2/M3 design) ·
`backlog` = matrix **MISSING** but on an M-queue · `not-started` = **MISSING**, no near milestone.

**Confidence:** **HIGH** (multiple independent sources) · **MED** (single credible source or model-knowledge corroborated) · **LOW** (inference / single unverified claim). Model knowledge ≤ Jan 2026 = `[K]`.

**VALIDATED vs ASPIRATIONAL discipline (enforced in §3).** A counter-claim is **VALIDATED** only if shipped
code supports it *today* (matrix DONE + Mesob go-live; 163-test suite per `CLAUDE.md`). Everything else is
**ASPIRATIONAL** — roadmap or contract, never a promise. The two columns are kept strictly apart.

**Legal.** Concepts, workflows, pricing, public behaviour only. No proprietary or GPL code was read to copy
(Odoo LGPLv3 / ERPNext GPLv3 studied at concept level per R1 §4). No statistic here is invented; weak
provenance is flagged.

**JENIFY's shipped baseline (the honest anchor for every "simpler-value" answer):** local-first single-box
operation with *zero cloud dependency*, append-only stock ledger, lots + genealogy, stage-based production
batches + QC gates, FIFO sales invoicing with VAT + pricing snapshots, credit limits, multi-currency
payments + allocations, deliveries with performance tracking, 9 reconciling reports, owner dashboard with
computed alerts, RBAC + audit, EC (Ethiopian) calendar, editable terminology framework, branded print/PDF,
role-scoped mobile nav, honest offline banner. **Not shipped:** costing/margins, purchasing UI/POs,
adjustments/counts, reorder alerts, returns, expiry/FEFO, BOM, scrap-to-ledger, persisted notifications, AI,
offline *writes*/sync, multi-site, payroll.

---

## 1. Master feature / insight index (classified, decision-ready)

One row = one durable finding. **Source** lens: `COMP` competitor · `SECTOR` · `AFRICA`/`COUNTRY` · `PAIN`
user-pain · `AI`. **Simpler-value?** answers mission §26 *"can JENIFY deliver this value more simply?"*.
Rows are grouped by classification so the Team Lead can read one band at a time. `R3` marks findings new in
this round.

### 1A · CORE — platform primitives (all tenants)

| # | Source | Finding | Evidence · Conf | Can JENIFY deliver it more simply? | Status |
|---|---|---|---|---|---|
| C1 | COMP (all majors) | Perpetual **append-only stock ledger**, balances derive from it | universal core; theft/shrinkage evidence · HIGH | Already the design; shipped and Mesob-proven | shipped |
| C2 | COMP (all) | **Numbered PDF documents + branding snapshot** | paper is still the trust instrument · HIGH | Shipped (brandingVersion on 5 doc tables) | shipped |
| C3 | PAIN (fraud) | **RBAC + immutable audit + reverse-not-edit corrections** | staff theft near-universal (UJ 2023, reported) · HIGH | Shipped; the anti-fraud spine competitors lack at SME scale | shipped |
| C4 | COMP (Tally/Sage) | **Customer statements + aging** as the collection tool | credit economies; DATEV/Pastel channel · HIGH | Credit core shipped; statements/aging is a cheap add on it | backlog |
| C5 | PAIN + COMP (NetSuite counter) | **Owner daily digest + exception alerts**, printable/WhatsApp-shareable | absentee-owner + theft pain · HIGH | Dashboard shipped; digest export is the missing half, zero cloud | backlog |
| C6 | COMP (all) | **Stock adjustments + cycle counts** (audited) | ledger decays without them · HIGH | Cheap on existing ledger; M4 | backlog |
| C7 | COMP (all) | **Returns / credit notes** (reverse against original, audited) | trade reality; fraud channel if absent · HIGH | Reuses the immutable-reversal pattern already shipped; M4 | backlog |
| C8 | COMP (ERPNext/BC) | **Costing → FIFO valuation → margin per item/invoice** | "are we profitable?" wins every demo · HIGH | Extends the shipped FIFO engine; M2 | designed |
| C9 | COMP (all) | **2-step purchasing** (order → receive+bill), supplier UI | anti-SAP default; payables mirror the debt book · HIGH | Assembles existing party/ledger machinery; M2 | designed |
| C10 | COMP (Tally) | **Local-first single-box operation** (LAN, no cloud) | the offline reference; SaaS abandoned it · HIGH | *This is the shipped moat* — parity with Tally, minus the desktop | shipped |
| C11 | AFRICA (anti-Kippa) | **Data-ownership + one-click full export** promise | Kippa vanished, stranded 500k businesses (TechCabal 2024) · HIGH | Architecture shipped; productize the guarantee, near-zero build | shipped |
| C12 | COMP (Tally, R2) | **Mobile-first / low-end / bad-internet operational spine** | Tally has *no* full mobile entry (R12) · HIGH | Shipped role-nav + 69 kB budget on the exact axis Tally can't follow | shipped |
| C13 | SECTOR (mfg) | **Batch/lot + genealogy + QC gates** (recall trace) | food-safety/iodization; JENIFY *ahead* here · HIGH | Shipped and Mesob-proven — deeper than Prodio/Katana | shipped |
| C14 | COMP (all mfg) | **Scrap/rework disposition to the ledger** | closes a shrinkage hole; PARTIAL today · HIGH | `unitsRejected` exists; route it to the ledger; M4 | backlog |

### 1B · SHARED CAPABILITY — reusable engines, template-parameterized

| # | Source | Finding | Evidence · Conf | Can JENIFY deliver it more simply? | Status |
|---|---|---|---|---|---|
| S1 | COMP (Odoo/Zoho) | **CSV/Excel import + opening balances** (validate→preview→commit) | #1 implementation-speed weapon · HIGH | The single cheapest onboarding lever; leaving Excel costs hours not weeks; W1 | designed |
| S2 | COMP (Nebim) | **Item variant / attribute matrix in core** (grade×pack, size×color) | vertical physics; painful to retrofit · HIGH | Design the generic seam *before* tenant #2 — one engine, many sectors | designed |
| S3 | COMP (Odoo/ERPNext) | **Price lists + tiered/qty discounts + bulk repricing** | 30%+ inflation reprices weekly (Africa) · HIGH | Small rule set, effective dates; not a baroque engine | backlog |
| S4 | COMP (MRPeasy) | **Reorder-point / low-stock alerts** | computed on read; universal · HIGH | Same computed-alert pattern the dashboard already uses; M4 | backlog |
| S5 | COMP (Odoo/BC) | **Barcode scan on receive/count/sell** | Android camera = free hardware · HIGH | Cheap; pair with counts (M4) | backlog |
| S6 | COMP (ERPNext BOM) | **BOM-lite (1-level) + backflush consumption** | smallest path to real product cost · HIGH | 10% of Katana/ERPNext scope yields the costing win; M3 | designed |
| S7 | COMP (Odoo/NetSuite) | **Landed-cost allocation** (freight/duty onto stock) | import-dependent trade · HIGH | Simple %/per-unit spread, not a rules engine; M2/M3 | designed |
| S8 | COMP (Zoho) | **WhatsApp-shareable docs/reports** (share-ready PDF now, API later) | the channel customers actually read · HIGH | Share-ready PDFs ship cheaply; automated API is a later Founder call | backlog |
| S9 | COMP (Logo/all TR) | **FX price lists + balance revaluation** (inflation-hardened) | birr/naira devaluation is a *process* · HIGH | Multi-currency base shipped; add FX price lists on top | backlog |
| S10 | COMP (ERPNext) | **Saved report filters/views per role** | self-serve without a report builder · MED | Saved filters only — full builders are a trap | backlog |
| S11 | AFRICA (mobile money) | **Payment-method seam** (provider + reference, reconcile-first) | $1.4T/yr SSA rail (GSMA 2026) · HIGH | Recording a Telebirr/M-PESA ref = 80% of value at 5% of API cost | backlog |
| S12 | R3 · SECTOR (logistics) | **Landmark + GPS-pin addressing** (no formal addresses) | "2nd house after the yellow church" · MED | A structured address type reused by deliveries + any field role | not-started |

### 1C · SECTOR / SUBSECTOR — template-scoped

| # | Source | Finding | Evidence · Conf | Can JENIFY deliver it more simply? | Status |
|---|---|---|---|---|---|
| SE1 | SECTOR (Kippa, shop) | **Khata debtor/credit-book UX** (2-tap "he owes me") | informal credit is structural (26.9% GH firms) · HIGH | JENIFY *credit core is shipped*; add a shop-simple face over it | backlog |
| SE2 | SECTOR (Katana, mfg) | **Visual make-order board** (material-availability recolor, no solver) | best small-factory UX · HIGH | Katana's UX, none of its machinery, on shipped batches | backlog |
| SE3 | SECTOR (ERPNext) | **Job cards / operation logging** per stage | bridges plan↔floor · MED | JENIFY stages ≈ half of this already | backlog |
| SE4 | SECTOR (Marg/BeatRoute) | **Scheme/claims + van-stock** for distribution | encodes real trade (60% IN pharma dist.) · HIGH | Sector engine on core ledger/credit — *not* an SFA rep-tracking clone | not-started |
| SE5 | SECTOR (Bizom/FieldPro) | **Offline field order/visit capture** (secondary sales) | van in rural Zambia has no signal · HIGH | Rides the contracted O2 queue — structurally cheaper than a cloud DMS bolt-on | designed |
| SE6 | SECTOR (Candy/Buildertrend) | **Project cost object** (estimate→budget→cost-to-complete) | African construction runs on Excel (R7) · HIGH | Add as a shared *cost dimension* before the construction template | not-started |
| SE7 | R3 · SECTOR (pharmacy) | **FEFO dispensing + expiry alerts + return-to-supplier** | expiry is the #1 loss on 2–5% margins · HIGH | Batch/lot/genealogy shipped; add expiry date + FEFO pick + alert (computed) | backlog |
| SE8 | R3 · SUBSECTOR (pharmacy) | **Regulated-item register + recall + registration renewal** (PPB/NAFDAC) | counterfeit-drug risk; regulator demand · MED | Recall trace is *shipped* (genealogy); add a regulated-item flag + renewal alert | not-started |
| SE9 | R3 · SUBSECTOR (pharmacy) | **Insurance / scheme claim billing** (e.g. NHIF) | 3rd-party pays; claim turnaround is a KPI · MED | A payer party + claim doc on the sales spine; sequence after a real tenant | not-started |
| SE10 | R3 · SECTOR (logistics) | **Proof-of-delivery** (photo / signature / OTP) on a trip/route | POD is the payment trigger · HIGH | Deliveries *shipped*; add a POD capture + trip grouping on top | backlog |
| SE11 | R3 · SECTOR (logistics) | **COD cash collection + driver reconciliation** (float, variance) | COD dominates; riders reconcile per shift · HIGH | Reuses shipped payments + the cash-up pattern (§1D) — one driver ledger | backlog |
| SE12 | SECTOR (Loyverse) | **Free single-till POS** | freemium gravity well · HIGH | **Don't clone** — win the shop→SME transition where its ceiling bites | (REJECT as clone) |

### 1D · COUNTRY — country packs

| # | Source | Finding | Evidence · Conf | Can JENIFY deliver it more simply? | Status |
|---|---|---|---|---|---|
| CO1 | COUNTRY (Logo/Uyumsoft) | **Fiscal e-document seam** (eTIMS/ETA/FIRS/Ethiopia) as first-class | mandates make it existential overnight · HIGH | Build the *seam* before any state demands it; numbering/VAT shipped, submission missing. *(depth owned by research-einvoicing)* | designed |
| CO2 | COUNTRY (all VAT) | **VAT summary / return report** matching the filing form | removes filing fear · HIGH | VAT on invoices shipped; the period return report is a cheap add | backlog |
| CO3 | COUNTRY (Ethiopia) | **EC calendar + editable Amharic/Tigrinya terminology + Telebirr seam** | home turf; telebirr 58.6M users · MED–HIGH | EC calendar + terminology framework *shipped*; content ~1.5% (T8); Telebirr seam backlog | backlog |
| CO4 | R3 · COUNTRY (mobile money) | **Per-rail payment adapters** (M-PESA Daraja / Nigeria aggregators / Telebirr) | no pan-African API exists (§2B) · HIGH | One core seam + thin per-country adapters; reconcile-first, integrate later | backlog |
| CO5 | COUNTRY (Sage) | **Statutory payroll** (casual/daily + deductions) | real need but rule-maintenance forever · HIGH | High value, heavy; country-pack, after template extraction; M5 | not-started |
| CO6 | COMP (DİA) | **"Compliance updates included forever"** as the vendor's job | retention machine · HIGH | A country-pack *principle*, not a feature — bake into pack maintenance | (principle) |

### 1E · ROLE EXPERIENCE

| # | Source | Finding | Evidence · Conf | Can JENIFY deliver it more simply? | Status |
|---|---|---|---|---|---|
| R1 | PAIN (roles) | **Different roles see different interfaces** (role-scoped mobile nav) | charter: "different roles, different interfaces" · HIGH | Shipped role nav; keep deepening per role | shipped |
| R2 | AFRICA (literacy) | **Numerals-and-icons-first, low-literacy screens; voice/photo later** | usability > translation (GSMA usage gap) · MED | A UX pass on shipped screens; cheap differentiation vs foreign tools | backlog |

### 1F · AI (future-planned layer)

| # | Source | Finding | Evidence · Conf | Can JENIFY deliver it more simply? | Status |
|---|---|---|---|---|---|
| AI1 | COMP (BC Copilot) | **Read-only NL intents over a typed action catalog** ("what did we sell yesterday?") | suggest-and-confirm is the validated UX · MED | The action catalog is the prerequisite; obey the AI-safety pipeline | designed |
| AI2 | PAIN + R3 sectors | **AI anomaly/exception flagging** (cash variance, near-expiry, COD variance) | fraud + expiry + COD are all variance problems · MED | Flags computed over the ledger; suggest, never auto-act | not-started |
| AI3 | R3 · SECTOR | **Demand forecasting** (pharmacy expiry↔stock-out; logistics ETA; distribution suggested order) | the analytical prize of every field tool · MED | Later; needs history + the action catalog first | not-started |

### 1G · LATER / REJECT (studied, sequenced or declined)

| # | Source | Finding | Verdict | Why |
|---|---|---|---|---|
| L1 | COMP (Tally) | Always-on **double-entry GL** (accountant-familiar) | **LATER** | Open question §7.1; Ethiopian Peachtree channel may make a familiar GL a GTM asset — Founder call. `not-started` |
| L2 | COMP (NetSuite) | **Multi-entity consolidation** | **LATER** | Only after multi-tenancy is structurally real (roadmap risk #1). `not-started` |
| L3 | OFFLINE (Loyverse/Toast) | **Offline writes + queue** with restricted-ops-offline policy | **LATER** | O2/O3 contracts exist; server stays final authority, no LWW. `designed` |
| L4 | OFFLINE | **Multi-site / site-node sync** | **LATER** | The unserved structural gap and T4 unlock; highest-risk build. `designed` |
| L5 | SECTOR (Bumpa) | **Social-commerce storefront** (IG/WhatsApp selling) | **LATER** | Integration, not core; JENIFY powers operators, not the storefront. `not-started` |
| L6 | AFRICA | **Records-to-credit lender export** (consented) | **LATER** | High value; needs partners + Founder approval on external sharing. `not-started` |
| L7 | COMP (Infor) | **Full QMS/CAPA module** | **REJECT** | Even Infor's is called weak; keep shipped QC gates + retests. |
| L8 | COMP (Canias TROIA) | **Customer-facing programming language** | **REJECT** | Every customer forks; declarative typed config instead (validates JENIFY). |
| L9 | COMP (Workcube) | **40-module "all-in-one" navigation** | **REJECT** | Module count is a sales number; ship fewer, deeper, composable capabilities. |
| L10 | COMP (SAP B1/BC/Odoo) | **Accounting-ceremony-first onboarding** | **REJECT** | Operations-first onboarding is JENIFY law. |
| L11 | COMP (NetSuite/Odoo) | **Opaque pricing, renewal uplifts (20–45%), version surcharges (25%)** | **REJECT** | #1 customer complaint; transparent local-currency pricing wins Africa. |
| L12 | OFFLINE (cloud cohort) | **Cloud-only dependence** | **REJECT** | Never adopt; it is precisely JENIFY's structural advantage. |
| L13 | COMP (Infor APS) | **APS finite-capacity scheduling** | **LATER** | Visual board first (SE2), no solver, until a tenant demands it. `not-started` |
| L14 | COMP (ERPNext) | **Subcontracting** (send material / receive product) | **LATER** | Common African reality (outsourced milling); after mfg template. `not-started` |

---

## 2. Round-3 additions

### 2A · Two new sector deep-dives

Chosen because R2 already went deep on distribution, retail POS, construction and MES-lite, while these two
remain shallow in the program yet each has sharp African physics and heavy *reuse* of JENIFY's shipped core.

#### (i) PHARMACY / drug retail + distribution

| Dimension | Detail | Source · Conf |
|---|---|---|
| **Core objects** | Drug SKU **with batch + expiry date**; supplier; goods receipt (batch-stamped); dispensing/sale record; prescription; regulated-item register (controlled substances); insurance/scheme payer + claim; return-to-supplier (expired/defective). | pharmacy-software surveys KE/NG · HIGH |
| **Signature workflows** | **FEFO** dispensing (nearest-expiry batch picked first, regardless of receipt order); **expiry alerts** at a configurable threshold (90/60 days) → clear/priority-dispatch/write-off; batch **recall** trace; **return-to-supplier** for expired stock; **batch-wise profit** analysis; regulatory registration + renewal tracking (Kenya **PPB**, Nigeria **PCN/NAFDAC**). | Aqiq (ERPNext KE), RobiPOS, ClinikEHR/PharmaPOS NG · HIGH |
| **Roles** | Pharmacist (dispense, prescription check); counter/dispenser; store/inventory manager (expiry, reorder); owner (margin, shrink); auditor/regulator (recall, controlled-item register). | inferred from tool role models · MED |
| **KPIs** | **Expiry write-off value/%**; near-expiry inventory value; essential-med **stock-out rate**; gross margin per batch; dispensing accuracy; insurance-claim turnaround days. | vendor feature framing · MED |
| **Mobile + offline** | Dispensing/POS **must continue through outages** (offline sale queue); barcode scan; expiry alerts on device; owner view on phone. | connectivity/power reality (R1 §5.1–5.2) · HIGH |
| **AI opportunities** | Demand forecasting to cut **both** stock-outs and expiry simultaneously; near-expiry clearance suggestions; counterfeit/recalled-batch flagging; (later) drug-interaction check. | AI-safety pipeline; suggest-confirm · MED |
| **Regional anchor** | mPharma runs vendor-managed inventory across **850+ pharmacies in 7 countries incl. Ethiopia** (R1) — the expiry/VMI pain is real and continental. | HowWeMadeItInAfrica 2021–24 (reported) · MED |

**Differentiation verdict — simpler value?** *Strongly yes, because JENIFY already ships the hard 70%.*
Batch/lot tracking, **genealogy (= recall trace)**, and QC gates are DONE and Mesob-proven; competitors bolt
FEFO onto a flat inventory, whereas JENIFY would add only an **expiry date + FEFO pick order + a computed
near-expiry alert** (the same computed-alert machinery the dashboard already uses) on top of a genuine
lot-genealogy spine. **Biggest single opportunity: FEFO + expiry-alert on the shipped batch/genealogy core**
(SE7) — small build, converts a proven manufacturing strength into a whole new sector. Regulated-item
register (SE8) and insurance-claim billing (SE9) are the deeper, later slices. **Classification: SECTOR
(pharmacy) on shipped CORE; expiry/FEFO is the near-term add; recall/registration = SUBSECTOR.** Conf HIGH
that the reuse is real; MED that JENIFY leads without the regulatory/insurance depth built.

#### (ii) LOGISTICS / last-mile delivery + transport

| Dimension | Detail | Source · Conf |
|---|---|---|
| **Core objects** | Shipment/consignment; **trip/route**; stop; driver/rider; vehicle; **proof-of-delivery** (photo/signature/OTP); **COD cash collection** + driver float; failed-delivery reason. | last-mile-software surveys Africa/SA · HIGH |
| **Signature workflows** | Route planning/sequencing + dispatch; live tracking + ETA; **POD capture** (POD is the payment/settlement trigger); **COD reconciliation** — rider counts cash, reconciles collections at end of shift; failed-delivery re-attempt handling. | Loop.co.za, allbusiness.africa · HIGH |
| **Roles** | Dispatcher/ops (plan, assign); **driver/rider** (navigate, capture POD, collect cash); ops manager (on-time %, exceptions); customer (track, confirm). | inferred from tool role models · MED |
| **KPIs** | **On-time delivery %**; **first-attempt success rate**; failed-delivery rate; cost per delivery; **COD reconciliation variance**; driver cash float outstanding. | vendor feature framing · MED |
| **Africa physics** | **Informal addressing** — formal addresses often don't exist → landmark + GPS pin; **COD dominance** — the rider is a cash handler; the **dispatch-rider economy** (Jumia footprint); structurally higher failure/re-attempt cost than developed markets. | allbusiness.africa 2026, icargos 2025 · HIGH |
| **Mobile + offline** | Driver app must **capture POD and collect COD offline** en route (no signal), sync on reconnect; landmark navigation; phone-first coordination on low-end Android. | R1 §5.1–5.2 · HIGH |
| **AI opportunities** | Route optimization/stop sequencing; ETA prediction; **COD variance / cash-shrink flagging**; address resolution from landmark text → geocode. | suggest-confirm; AI-safety pipeline · MED |

**Differentiation verdict — simpler value?** *Yes for the distributor's/maker's own last mile; no for a
pure 3PL platform.* JENIFY already ships **Deliveries with performance tracking** — the record spine. The
gap is **POD capture (photo/signature/OTP)**, **trip/route grouping**, and **COD driver reconciliation**,
all of which sit naturally on the shipped deliveries + payments + (planned) cash-up machinery as *one driver
ledger*. JENIFY should **not** try to become CargoWise/Shipsy (fleet-3PL optimization); the simpler,
defensible value is: *the maker/distributor confirms its own deliveries and reconciles rider cash offline,
inside the same system that made and sold the goods.* **Biggest single opportunity: offline POD + COD
driver-cash reconciliation on the shipped deliveries + payments spine** (SE10/SE11) — turns an existing
module into a field-grade last-mile record no cloud TMS matches offline. **Classification: SECTOR
(logistics) on shipped CORE; landmark addressing = SHARED CAPABILITY.** Conf HIGH.

### 2B · Deeper African-market dimension — mobile-money integration patterns (Kenya / Nigeria / Ethiopia)

*(Chose mobile-money patterns over e-invoicing because e-invoicing depth is owned this round by
`research-einvoicing` / `ETHIOPIA_EINVOICING_VERIFICATION.md` — no duplication.)*

| Market | Rail & integration reality (2026) | What it means for JENIFY |
|---|---|---|
| **Kenya — M-PESA** | Safaricom **Daraja** API is the developer standard: OAuth token → **STK-push** prompt → **callback** with result; C2B/B2C/reversal endpoints. **API is free** (normal M-PESA tariff applies via PayBill/Till). Onboarding is heavy: business registration + bank account + paybill/till + KRA docs, ~**5 weeks**. **Daraja is Kenya-only.** | Cleanest real-time rail; but per-country onboarding is a project. Adapter #1. Conf HIGH. |
| **Nigeria** | **No single M-PESA-equivalent.** Rails are **card + bank transfer + ~2M POS agents** (NIBSS). Developers use **aggregators** — **Paystack** (clean REST, but only ~4 African countries mid-2026) and **Flutterwave** (wraps card/transfer/some mobile money behind one API). | Integrate via an aggregator, not a single wallet; treat "payment provider" as pluggable. Conf HIGH. |
| **Ethiopia (home)** | **Telebirr** (58.6M users, now a **super-app**) + **CBE Birr**; **M-PESA Ethiopia is now live** (Safaricom PII licence; **63k merchants, 26k agents, 12 banks**). Telebirr API is **document-gated** — contact admins, present a business licence, receive test/prod credentials; integration commonly **$1,500–$5,000** of work. APIs immature/undocumented relative to Daraja. | Multiple rails at home now (Telebirr + CBE Birr + M-PESA); document-gated APIs argue for **reconcile-first**. Conf MED–HIGH. |

**Cross-market pattern (the architecture answer).** There is **no pan-African mobile-money API**: Daraja is
Kenya-only, Nigeria is aggregator-land, Ethiopia is document-gated with three rails. The pragmatic,
FAST/SIMPLE/LOCAL design is therefore what R1 §5.3 already argued and this round confirms: **a single
payment-method seam in core that records provider + reference and reconciles, with thin per-country
adapters added only where a live API pays off.** Recording a Telebirr/M-PESA reference on a payment captures
~80% of the value at ~5% of the integration cost — and it works *offline*, which every live API does not.
**Classification: CORE seam (S11) + COUNTRY adapters (CO4); reconcile-first is the sequencing rule.** Conf HIGH.

### 2C · Competitor move since Round 2 that threatens the roadmap

**Odoo 20 — agentic AI + rebuilt mobile + Africa doubling-down (dated, concrete).**
Odoo announced **Odoo 20 for release at Odoo Experience Brussels, 24–26 Sept 2026**, headlining **agentic
AI** ("Ask AI", AI agents, document automation), a **rebuilt mobile interface**, and **module-wide
simplification**. Separately, **Odoo Experience 2026 *Africa* runs 3–4 Sept 2026 in Nairobi** (Odoo's
regional HQ since 2022). Conf HIGH (vendor + event pages).

**Why it threatens the roadmap.** Odoo is moving on **the two axes JENIFY names as differentiators —
mobile and AI — at once**, while deepening its **Africa** push. If Odoo 20's "rebuilt mobile" and agentic AI
land credibly in Nairobi, the window in which "mobile-first + safe AI, in Africa" reads as *uniquely* JENIFY
narrows on the marketing surface.

**Why it does *not* invalidate the sequence (evidenced, not slogan).** Odoo's move is **cloud-first and
still consultant-gated** — R2 documented the failure pattern (40% project failure, $15k/16-mo "no working
system", "demo features not included"). Agentic AI on a cloud ERP does nothing for a factory during a
power/连 outage, and it rides the same implementation model that strands African SMEs. JENIFY's answer is
**not to race Odoo's AI**, but to hold the axis Odoo structurally cannot follow: **local-first, zero-cloud,
operations-first, no-consultant** — and to keep JENIFY's own AI strictly to the shipped-when-safe, read-only,
suggest-and-confirm path (AI1). **Action for Team Lead:** treat Odoo 20 as a *marketing-timing* threat, not
an architecture threat; make "works with no internet and no consultant" the headline where Odoo says "AI".
The one thing to monitor: if Odoo 20's mobile genuinely works offline (it has not, historically), that would
be a real escalation — verify post-launch. Conf HIGH on the move; MED on impact.

*(No other post-R2 move found this round invalidates the sequence. The R2 embedded-finance-rail threat —
OmniRetail net-profitable, Wasoko/MaxAB pivot to fintech — still stands and still argues for the
payment/credit-rail seam, S11/CO4.)*

---

## 3. Differentiation scorecard — refresh (top 5 first-sector collisions)

Top-5 = the systems JENIFY actually meets in its **first sectors** (shop → SME → factory, Ethiopia first).
**VALIDATED = shipped code today** (matrix DONE + Mesob go-live). **ASPIRATIONAL = roadmap/contract.**
Kept strictly apart — no slogans, one line each.

| Competitor | Their real edge (honest) | JENIFY **VALIDATED** counter (shipped today) | JENIFY **ASPIRATIONAL** counter (planned) |
|---|---|---|---|
| **Odoo (now Odoo 20, Sept 2026: agentic AI + rebuilt mobile, Nairobi HQ)** | Breadth in one data model; modern UX; new AI + mobile push; Africa events | Local-first zero-cloud operation and a real factory floor (batches/QC/genealogy) that ran a go-live **with no external consultant** | Read-only suggest-and-confirm AI over a typed action catalog (AI1); declarative template engine + CSV import (S1) instead of partner code |
| **Tally / TallyPrime** (E-Africa SME accounting) | Keyboard speed; offline single-box trust; accountant/dealer channel; VAT depth | **Mobile-first on a $80 Android, offline, low-end** — the exact axis Tally has *no* full app for; local-first parity + factory depth Tally lacks | Full offline *writes* (O2 queue) Tally's mobile can't do; owner digest (C5); accountant-familiar exports |
| **ERPNext** (free-core, localized into Ethiopia via 360Ground) | Genuinely deep free core; DocType metadata; traceability | One deployment that is **used daily** (Mesob), local-first, with shipped batch/QC/genealogy — not an abandoned half-system | One safe declarative template + AI action catalog instead of unbounded DocType sprawl; hypercare-free adoption via owner digest |
| **Loyverse** (free shop-tier POS) | Free-forever till; offline sale queue; 170+ countries | One integrated record spanning stock→production→QC→sales→credit→payments→delivery→reports on a local-first base — past the till ceiling | Shop-simple POS/credit face (SE1) for the shop→SME transition; free-tier is a Founder GTM input, not a clone |
| **Ashewa SmartERP** (Ethiopian all-in-one SaaS, Amharic) | Local language + support + tax awareness, on home turf | **Local-first (zero cloud dependency)** — the one thing it lacks — plus EC calendar, editable Amharic terminology, Mesob-proven manufacturing, all shipped | Ethiopia country pack: Telebirr/M-PESA-ET seam (CO4), VAT return (CO2), e-invoice seam when mandated (CO1) |

**One-line doctrine (unchanged, reinforced):** every first-sector rival is beaten on the two axes JENIFY
already ships — **local-first (no cloud)** and **one integrated record with real factory depth** — while
their edges (breadth, keyboard speed, free tills, new AI) are answered by *sequenced templates on the shared
core*, never by cloning. VALIDATED claims are backed by the green test suite + Mesob go-live; the
ASPIRATIONAL column is the roadmap, not a promise. *(True baseline note: below the shop tier the real default
is still **Excel + WhatsApp + nothing** — R2 §1.3 — the deepest "competitor" of all.)*

---

## 4. Round-3 source index (accessed 2026-08-22)

- [X1] aqiqsolutions.com (ERPNext pharma KE: batch/lot, FEFO, PPB, eTIMS/M-Pesa); robisearch.com (RobiPOS KE FEFO/batch profit); clinikehr.com, inkeepx.com, medsoftwares.com PharmaPOS, virtualrx.ng (NG pharmacy FEFO/expiry alerts, NAFDAC)
- [X2] slashdot.org last-mile Africa; loop.co.za (last-mile key features); allbusiness.africa (African last-mile, dispatch-rider economy, address problem, COD reconciliation); mobilityforesights.com SA last-mile market
- [X3] mctaba.com & cnbcode.com & kenzobe.com (M-PESA Daraja STK-push, OAuth/callback, 5-week onboarding, Kenya-only); tasflex.co.ke (KE gateways); mctaba.com Paystack-alternatives (Paystack ~4 countries; Flutterwave/Pesapal/IntaSend wrappers)
- [X4] developingtelecoms.com & baydis.medium.com & kakupress.biz (Telebirr super-app); appther.com (Telebirr/CBE Birr API doc-gated, $1,500–5,000 integration); connectingafrica.com & safaricom.co.ke & pymnts.com (M-PESA Ethiopia live: 63k merchants, 26k agents, 12 banks)
- [X5] zehntech.com & flexsin.com & nerithonx.com (Odoo 20 Sept 2026: agentic AI, rebuilt mobile, module simplification); odoo.com/event Odoo Experience 2026 Brussels (24–26 Sept) & Africa/Nairobi (3–4 Sept); ecosire.com & erp.today (Odoo-vs-ERPNext 2026, open-source AI shortlist)
- R1/R2 keys `[Wn]`/`[Rn]`/`[K]` resolve in `GLOBAL_COMPETITOR_INTELLIGENCE.md` §9 and `COMPETITOR_WAR_ROOM_R2.md` §8.

---

## 5. Maintenance rules (this is a *living* index)

1. **One scheme, one document.** All future product intelligence is classified into §0's scheme and indexed
   here; the granular per-competitor rows keep living in `FEATURE_INTELLIGENCE.md` (this is the synthesis).
2. **Status cells are grounded, never aspirational** — every `shipped/designed/backlog/not-started` must
   trace to `FACTORY_OS_FEATURE_MATRIX.md`; when a matrix row changes, update the index row in the same pass.
3. **VALIDATED vs ASPIRATIONAL stays strictly separated** (§3) — a claim enters the VALIDATED column only
   when shipped code + a green test support it.
4. A classification here is a **research recommendation**; it becomes binding only when echoed in
   `docs/JENIFY_DECISIONS.md`.
5. **No invented statistics; concept-level study only** (Odoo LGPLv3 / ERPNext GPLv3 — never code/schema).
6. New rounds **append** (mark `Rn`) and extend; they do not rewrite prior findings.
