# GLOBAL FEATURE INTELLIGENCE DATABASE (seed)

**Workstream:** R4 · **Date:** 2026-08-21 · **Rows:** 72 (seed — extend, never fork the schema)
**Report:** [GLOBAL_COMPETITOR_INTELLIGENCE.md](GLOBAL_COMPETITOR_INTELLIGENCE.md) — source keys `[Wn]`/`[K]` resolve in its §9.

## Schema (identical in every section table)

`# | Competitor | Sector | Capability | Feature | Workflow | Country relevance | Strength | Weakness | Complexity | African relevance | JENIFY decision | Score notes | Sources | Conf`

- **Complexity** = cost to build the *smallest valuable version* in JENIFY: Low / Med / High.
- **JENIFY decision** vocabulary: `Core (built)` · `Core` · `Shared capability` · `Sector template` · `Country pack` · `Company config` · `AI` · `Later` · `Reject`.
- **Score notes** (1–5, 5 = favorable to JENIFY): CV customer value · Si simplicity fit · Sp speed fit · IC implementation cost (5=cheap) · Mn maintenance (5=light) · Rv revenue · Df differentiation · Ev evidence quality (H/M/L).
- Decisions are **research recommendations only** — Founder/Team Lead approve via `JENIFY_DECISIONS.md`.

---

## A. Universal core — features in almost every strong ERP

| # | Competitor | Sector | Capability | Feature | Workflow | Country relevance | Strength | Weakness | Complexity | African relevance | JENIFY decision | Score notes | Sources | Conf |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | All majors | Cross | Inventory | Perpetual stock ledger + balances | Every movement posts to append-only ledger | Global | Single source of truth | Decays without counts/adjustments | — | Essential (theft/shrinkage) | Core (built) | CV5 Si4 Sp4 IC5 Mn4 Rv5 Df2 Ev:H | [W9][W10] | H |
| 2 | Odoo | Cross | Sales | Quote→order→invoice→payment chain | One document flows through states | Global | No re-typing between stages | Odoo hides chain config deep | Med | High (trade norm is verbal quote) | Later (quote/order stages; invoice exists) | CV4 Si4 Sp4 IC3 Mn4 Rv4 Df2 Ev:H | [W9] | H |
| 3 | Tally | Cross | Accounting | Always-on double-entry GL, jargon hidden | Vouchers auto-post; books always current | India/Gulf/E.Africa | Trust of accountants; audit-ready | Steep for non-accountants if exposed | High | High (accountant channel) | Later (open question §7.1) | CV4 Si2 Sp3 IC2 Mn3 Rv4 Df2 Ev:H | [W5] | H |
| 4 | Zoho Books | Cross | Accounting | Bank/mobile-money reconciliation | Import/feed statements, match to payments | Global | Catches missing money fast | Feeds unavailable in many African banks | Med | High (CSV import path works) | Shared capability (statement import first) | CV4 Si3 Sp3 IC3 Mn3 Rv3 Df3 Ev:H | [W14] | H |
| 5 | All majors | Cross | Purchasing | Supplier + PO + goods receipt + bill | 2-step default: order → receive+bill | Global | Cost control starts here | Classic 7-step chain is SME-hostile | Med | High | Core (M2; keep 2-step default) | CV5 Si4 Sp4 IC3 Mn4 Rv4 Df3 Ev:H | [W9][W10] | H |
| 6 | Dynamics BC | Cross | Finance | Dimensions / analytic tags on transactions | Tag txns (branch, project, truck) → filtered reports | Global | Answers "which branch makes money" | BC setup ceremony heavy | Med | Med-High | Later (simple tags, not GL dims) | CV3 Si3 Sp3 IC3 Mn3 Rv3 Df2 Ev:M | [W11] | M |
| 7 | Odoo/ERPNext | Cross | Pricing | Price lists, customer-tier & qty discounts | Rules resolve price at line entry | Global | Encodes real trade pricing | Rule engines get baroque | Med | High (tiered wholesale norm) | Shared capability (M-scoped, small rule set) | CV4 Si3 Sp4 IC3 Mn3 Rv4 Df3 Ev:H | [W9][W10] | H |
| 8 | Odoo/Zoho | Cross | Onboarding | CSV/Excel import + opening balances | Template file → validate → preview → commit | Global | Cuts implementation days→hours | Bad imports poison data (need preview) | Low-Med | Very high (cheap onboarding) | Core (next; implementation weapon) | CV5 Si4 Sp5 IC4 Mn4 Rv5 Df3 Ev:H | [W9][W14] | H |
| 9 | ERPNext | Cross | Reporting | Saved filters / user-defined report views | Filter+column sets saved per role | Global | Users self-serve variations | Full report builders are a trap | Med | Med | Shared capability (saved filters only) | CV3 Si4 Sp4 IC3 Mn4 Rv3 Df2 Ev:M | [W10] | M |
| 10 | All majors | Cross | Documents | Numbered PDF docs + branding | Sequence + template + snapshot | Global | Legal/trust artifact | — | — | High (paper still rules) | Core (built) | CV5 Si5 Sp4 IC5 Mn5 Rv4 Df2 Ev:H | matrix | H |
| 11 | Tally/Sage | Cross | AR | Customer statement + aging report | One-click statement per customer/period | Global | The collection tool for credit trade | — | Low | Very high (credit economies) | Core (next; pairs w/ existing credit) | CV5 Si5 Sp5 IC4 Mn5 Rv4 Df3 Ev:H | [W5][W13] | H |
| 12 | Odoo/Zoho | Cross | Workflow | Approval on exceptions (discount>X, credit>limit) | Threshold triggers one approver | Global | Control without ceremony | BPM designers = bloat | Med | Med (owner-centric firms) | Company config (thresholds only) | CV3 Si3 Sp3 IC3 Mn3 Rv3 Df2 Ev:M | [W9] | M |
| 13 | Sage | Cross | Payroll | Statutory payroll (tax tables, filings) | Monthly run → payslips → filings | Per-country | Retention machine (SARS/PAYE) | Rule maintenance forever, per country | High | High but heavy | Country pack (Later) | CV4 Si2 Sp2 IC1 Mn1 Rv4 Df2 Ev:H | [W13] | H |
| 14 | All majors | Cross | Tax | VAT summary/return report | Period report matching filing form | Per-country | Removes filing fear | Forms differ per country | Low-Med | High (VAT economies incl. Ethiopia) | Country pack (Ethiopia VAT first) | CV4 Si4 Sp4 IC4 Mn3 Rv4 Df3 Ev:H | [W13][W15] | H |
| 15 | NetSuite | Corporate | Finance | Multi-entity consolidation | Subsidiaries roll up real-time | Global groups | NetSuite's crown jewel | Massive machinery | High | Low (SME first) | Later (after real multi-tenancy) | CV2 Si1 Sp2 IC1 Mn2 Rv3 Df1 Ev:H | [W8] | H |
| 16 | Odoo/BC | Retail/Wh | Inventory | Barcode scan on receive/count/sell | Scan → line auto-fills | Global | Speed + fewer errors; cheap hardware | — | Low-Med | High (Android camera scan) | Shared capability (M4 pair w/ counts) | CV4 Si4 Sp5 IC4 Mn4 Rv4 Df2 Ev:H | [W9] | H |
| 17 | All majors | Cross | Sales | Returns / credit notes | Reverse against original doc, audited | Global | Trade reality; fraud channel if absent | — | Med | High | Core (M4; already planned) | CV5 Si4 Sp4 IC3 Mn4 Rv4 Df2 Ev:H | matrix | H |
| 18 | All majors | Cross | Inventory | Stock adjustments + cycle counts | Count sheet → variance → audited adjustment | Global | Keeps ledger trustworthy | — | Low-Med | Very high (shrinkage) | Core (M4; already planned) | CV5 Si4 Sp4 IC4 Mn4 Rv4 Df2 Ev:H | matrix | H |

## B. Manufacturing-unique features

| # | Competitor | Sector | Capability | Feature | Workflow | Country relevance | Strength | Weakness | Complexity | African relevance | JENIFY decision | Score notes | Sources | Conf |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 19 | ERPNext | Mfg | BOM | Multi-level BOM / recipe | Define inputs per output unit | Global | Foundation of costing/planning | Multi-level early = overkill | Med | High (agro-processing) | Shared capability (BOM-lite, 1-level first; M3) | CV5 Si3 Sp3 IC3 Mn3 Rv4 Df3 Ev:H | [W10] | H |
| 20 | Odoo | Mfg | Production | MO with backflush consumption | Complete MO → inputs auto-issued from ledger | Global | No manual issue clerking | Wrong BOM silently corrupts stock | Med | High (low admin staffing) | Shared capability (M3, with variance prompt) | CV4 Si4 Sp4 IC3 Mn3 Rv4 Df3 Ev:H | [W9] | H |
| 21 | Infor SyteLine | Mfg | Planning | APS finite-capacity scheduling | Constraint-based what-if schedule | Global mid-mkt | Real differentiator at mid-market | Huge machinery, planner skill needed | High | Low now | Later (visual board first, no solver) | CV3 Si1 Sp2 IC1 Mn2 Rv3 Df3 Ev:H | [W17] | H |
| 22 | Katana | Mfg-lite | Planning | Visual make-order priority board | Drag priority; material availability recolors live | Global SMB | Best small-factory scheduling UX | Pricey ($359+/mo) | Med | High (simple visual planning) | Sector template (mfg; M3+) | CV4 Si4 Sp4 IC3 Mn4 Rv4 Df4 Ev:H | [W20] | H |
| 23 | MRPeasy | Mfg-lite | Planning | Reorder suggestions from demand | Below-point → suggested PO/MO list | Global SMB | Simple MRP without the acronym | Forecasting beyond SME data | Low-Med | High | Shared capability (after reorder points) | CV4 Si4 Sp4 IC4 Mn4 Rv4 Df3 Ev:H | [W20] | H |
| 24 | SAP B1/ERPNext | Mfg | Traceability | Batch/lot + genealogy + recall trace | Lot links inputs↔outputs↔customers | Global (food/pharma) | Regulatory + recall power | — | — | High (food safety, iodization) | Core (built — Mesob-proven; JENIFY ahead here) | CV5 Si4 Sp4 IC5 Mn4 Rv5 Df5 Ev:H | matrix | H |
| 25 | ERPNext | Mfg | Shop floor | Job cards / operation logging | Operator logs qty+time per stage | Global | Bridges plan↔floor | Tablet discipline needed | Med | Med | Sector template (mfg; JENIFY stages ≈ half built) | CV3 Si3 Sp3 IC3 Mn3 Rv3 Df3 Ev:M | [W10] | M |
| 26 | Odoo | Mfg | Assets | Work centers + OEE metrics | Downtime/perf logged per center | Global | Improvement culture tool | Data discipline heavy | Med-High | Low-Med now | Later (M5 maintenance design) | CV2 Si2 Sp3 IC2 Mn2 Rv2 Df2 Ev:M | [W9] | M |
| 27 | ERPNext | Mfg | Subcontract | Subcontracting (send material, receive product) | Issue to partner → receive finished | Global | Common African reality (informal jobs out) | Stock-at-partner tracking | Med | High (outsourced milling etc.) | Later (sector template) | CV3 Si3 Sp3 IC3 Mn3 Rv3 Df3 Ev:M | [W10] | M |
| 28 | All strong mfg | Mfg | Quality | Scrap/rework disposition to ledger | Reject → scrap/rework/hold w/ ledger trace | Global | Closes shrinkage hole | — | Low-Med | High | Core (M4; matrix gap confirmed by research) | CV4 Si4 Sp4 IC4 Mn4 Rv3 Df3 Ev:H | matrix[W17] | H |
| 29 | Infor | Mfg | Quality | Full QMS/CAPA module | NC→CAPA→effectiveness cycle | Regulated global | Compliance markets need it | Even Infor's is called weak; ceremony-heavy | High | Low | Reject (keep QC gates + retests) | CV2 Si1 Sp2 IC1 Mn2 Rv2 Df1 Ev:H | [W17] | H |
| 30 | Odoo/NetSuite | Mfg/Dist | Costing | Landed cost allocation | Spread freight/duty onto received stock | Import economies | True cost of imports | Allocation rules confuse users | Med | Very high (import-dependent trade) | Shared capability (M2/M3, simple % or per-unit) | CV4 Si3 Sp3 IC3 Mn3 Rv4 Df4 Ev:H | [W8][W9] | H |
| 31 | ERPNext/BC | Mfg | Costing | Product cost from BOM + actuals; margin per item | Cost rolls up; invoice shows margin | Global | The "are we profitable" answer | Std-vs-actual debates | Med | Very high | Core (M2 with FIFO valuation) | CV5 Si3 Sp3 IC3 Mn3 Rv5 Df4 Ev:H | [W10][W11] | H |
| 32 | Nebim | Retail/Mfg | Master data | Variant/attribute matrix in core (size×color) | Matrix drives stock, barcodes, replenishment | Turkey/global retail | Vertical physics in the data model | Painful to retrofit later | Med-High | High (grade×package, size×color) | Shared capability (design seam before tenant #2) | CV4 Si3 Sp3 IC2 Mn3 Rv4 Df4 Ev:H | [W3] | H |

## C. What matters most to small businesses

| # | Competitor | Sector | Capability | Feature | Workflow | Country relevance | Strength | Weakness | Complexity | African relevance | JENIFY decision | Score notes | Sources | Conf |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 33 | Tally | SME | UX | Keyboard-fast entry; sub-second latency | Voucher entry without mouse | India+ | Speed = the moat; 2M businesses | Dated visuals | Low (discipline) | High (low-spec PCs) | Core principle (perf KPI + keyboard paths) | CV5 Si5 Sp5 IC4 Mn4 Rv4 Df4 Ev:H | [W5] | H |
| 34 | Vyapar | Micro | Billing | Free/cheap Android-first invoicing | Phone → invoice → WhatsApp in <1 min | India | Meets users on the phone | Shallow beyond billing | Med | Very high (phone-first economies) | Later (mobile role-scoped web first) | CV4 Si4 Sp4 IC3 Mn3 Rv3 Df3 Ev:M | [W6] | M |
| 35 | Kippa | Micro | Credit | Khata debtor/credit book | Record "he owes me" in 2 taps; reminders | Nigeria | Matches informal credit economy | Micro-only scope | Low | Very high | Sector template (shop) — JENIFY credit core + simple UX | CV5 Si5 Sp5 IC4 Mn4 Rv4 Df4 Ev:H | [W24] | H |
| 36 | Bumpa | Micro-retail | Commerce | Social storefront (Instagram/WhatsApp selling) | DM order → recorded sale + inventory | Nigeria/Kenya | Where African retail actually sells | Not an ops system | Med-High | Very high | Later (integration, not core) | CV4 Si3 Sp3 IC2 Mn2 Rv3 Df3 Ev:H | [W24] | H |
| 37 | Loyverse | Retail/food | POS | Free offline-capable Android POS | Sell offline; sync later; restricted ops offline | 170+ countries | Zero-cost entry; proven pattern | Refunds/new items blocked offline | Med-High | Very high | Sector template (retail POS lane; offline pattern = design reference) | CV5 Si4 Sp4 IC2 Mn3 Rv4 Df4 Ev:H | [W19] | H |
| 38 | Wave | Micro | Accounting | Free accounting as acquisition funnel | Free books; paid payments/payroll | US/CA | Zero-friction adoption | Not sustainable everywhere | — | Model lesson only | Reject (feature) / note (pricing strategy) | CV3 Si4 Sp4 IC3 Mn3 Rv2 Df2 Ev:M | [K] | M |
| 39 | Marg | Distribution | Pricing | Scheme/bonus management (10+2 free, slabs) | Scheme auto-applies at billing | India | Encodes real trade practice; 60% pharma share | Config sprawl | Med | Very high (FMCG/pharma dist.) | Sector template (distribution) | CV5 Si3 Sp4 IC3 Mn3 Rv5 Df5 Ev:H | [W6] | H |
| 40 | Busy/Tally | SME | Pricing model | One-time license + small annual sub | Buy once, own it | India | Cash-flow honest; no churn anxiety | Vendor revenue lumpy | — | Very high (subscription fatigue) | Company config n/a → Founder pricing input | CV4 Si5 Sp5 IC5 Mn4 Rv3 Df4 Ev:H | [W5][W6] | H |
| 41 | Zoho | SME | Output | WhatsApp-share invoice/receipt/report | Doc → WhatsApp deep-link/PDF | India/Africa | The channel customers read | API costs if automated | Low | Very high | Shared capability (share-ready PDFs now; API later) | CV5 Si5 Sp5 IC4 Mn4 Rv4 Df4 Ev:H | [W14] | H |
| 42 | Pesapal Sabi / Lipa | Retail | Payments | M-PESA STK push at checkout + auto-recon | Amount → phone prompt → paid + matched | Kenya/EA | Removes cash risk; 10k+ merchants | Kenya-specific APIs | Med | Very high (Telebirr analog for Ethiopia) | Country pack (payment-method seam in core) | CV5 Si4 Sp4 IC3 Mn3 Rv5 Df5 Ev:H | [W23] | H |
| 43 | sell.ke/Tuma | Retail | Compliance | eTIMS fiscal receipt at POS | Sale → KRA-compliant e-receipt | Kenya | Mandate makes it existential | Per-country integration | Med | Very high | Country pack | CV5 Si4 Sp4 IC3 Mn2 Rv5 Df4 Ev:H | [W23] | H |
| 44 | NetSuite (counter) | SME | Visibility | Owner real-time dashboard anywhere | Phone shows today's cash/sales/stock | Global | The demo that sells ERPs | Cloud-dependent | Low-Med | Very high (JENIFY's local-only gap) | Core (owner daily digest export first) | CV5 Si4 Sp4 IC4 Mn4 Rv4 Df4 Ev:H | [W8] roadmap | H |
| 45 | Uzapoint | SME | POS/inv | Simple African SME POS + inventory + M-PESA | Sell, restock, view report; minimal training | Kenya | Right-sized; local support | Shallow ceiling | — | High (validates segment) | (competitive intel — segment JENIFY shop template serves) | CV4 Si4 Sp4 IC3 Mn3 Rv4 Df3 Ev:M | [W23] | M |

## D. Offline champions & patterns

| # | Competitor | Sector | Capability | Feature | Workflow | Country relevance | Strength | Weakness | Complexity | African relevance | JENIFY decision | Score notes | Sources | Conf |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 46 | Tally | SME | Offline | Desktop/LAN full offline multi-user | All ops local; optional hosted access | India/EA | Total connectivity independence | Multi-site sync bolt-on | — | Very high | Core (built — JENIFY is already this) | CV5 Si5 Sp5 IC5 Mn4 Rv4 Df5 Ev:H | [W5] | H |
| 47 | Toast | Restaurant | Offline | Local hub server keeps venue running | Cloud down → hub serves POS; sync later | US | Commercial-grade resilience | Hardware cost | High | Very high (power/net outages) | Later (site-node sync design reference) | CV4 Si3 Sp4 IC2 Mn2 Rv4 Df4 Ev:M | [K] | M |
| 48 | Loyverse/Square | Retail | Offline | Offline queue w/ restricted operations | Sales allowed; risky ops blocked offline | Global | Honest risk model | Payment risk window (Square) | Med | Very high | Later (adopt restricted-ops policy in sync design) | CV4 Si4 Sp4 IC3 Mn3 Rv3 Df4 Ev:H | [W19] | H |
| 49 | Odoo POS | Retail | Offline | Browser cache offline for POS only | Session continues; syncs on reconnect | Global | Proves browser offline viable | Core Odoo still online-only | Med | High | Later (pattern note for web client) | CV3 Si3 Sp3 IC3 Mn3 Rv3 Df3 Ev:M | [W9][K] | M |
| 50 | SAP B1/Wolvox/Sage 50 | SME | Offline | On-prem LAN deployment survives disconnection | Server in the shop; clients on LAN | Global legacy | Quietly why desktop still sells in Africa | No remote visibility | — | Very high | Core (built) + Core (digest export = the missing half) | CV4 Si4 Sp4 IC4 Mn4 Rv3 Df4 Ev:H | [W11][W4a][W13] | H |
| 51 | Cloud cohort (ERPNext/NetSuite/BC/Zoho/DİA/Workcube) | Cross | Offline | (Absence) hard connectivity dependence | No internet → no business ops | Global | — | Structural weakness in Africa | — | Defining gap | (JENIFY advantage — never adopt cloud-only) | CV5 Si5 Sp5 IC5 Mn5 Rv5 Df5 Ev:H | §5.4 | H |

## E. Turkish-ERP ideas

| # | Competitor | Sector | Capability | Feature | Workflow | Country relevance | Strength | Weakness | Complexity | African relevance | JENIFY decision | Score notes | Sources | Conf |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 52 | Logo/Uyumsoft | Cross | Compliance | Turn-key fiscal e-documents (e-invoice/waybill/ledger) | Post doc → state format+submission automatic | Turkey (mandated) | Mandates make ERP compulsory infra | Per-country engineering forever | High | Very high (eTIMS/ETA now; ET/NG next) | Country pack (build the seam early) | CV5 Si3 Sp3 IC2 Mn2 Rv5 Df4 Ev:H | [W1][W4b] | H |
| 53 | DİA | SME | Business model | Regulatory updates free & automatic in subscription | Vendor ships law changes; user does nothing | Turkey | Retention machine; trust | Vendor cost | — | High | Country pack principle (compliance is vendor's job) | CV5 Si5 Sp4 IC3 Mn2 Rv4 Df4 Ev:H | [W2] | H |
| 54 | Nebim | Retail | Master data | Size-color-season matrix as core architecture | See row 32 | Turkey/retail | Vertical physics native | Narrow if hardcoded | Med-High | High | Shared capability (generic attribute matrix) | CV4 Si3 Sp3 IC2 Mn3 Rv4 Df4 Ev:H | [W3] | H |
| 55 | Nebim | Retail | Replenishment | Store distribution/replenishment by matrix | Central → stores by size-curve rules | Turkey | Real multi-branch retail need | Needs multi-site first | High | Med (later chains) | Later (multi-site prerequisite) | CV3 Si2 Sp3 IC2 Mn2 Rv3 Df3 Ev:M | [W3] | M |
| 56 | Canias | Mfg | Platform | TROIA embedded 4GL; customers program the ERP | Change anything in-language | Turkey/DE | Ultimate flexibility | Every customer forks; upgrade hell; skills scarcity | High | Low | Reject (declarative config instead — validates JENIFY model) | CV2 Si1 Sp2 IC1 Mn1 Rv2 Df2 Ev:H | [W5] | H |
| 57 | Workcube | Cross | Product strategy | 40+ modules all-in-one platform | One login for everything | Turkey | Sales story; single vendor | Breadth-over-depth; navigation overload | — | Cautionary | Reject (module-count strategy); keep composable capabilities | CV2 Si1 Sp2 IC2 Mn2 Rv3 Df1 Ev:M | [W4] | M |
| 58 | Logo/all TR | Cross | Finance | Inflation/FX-hardened ops (FX price lists, revaluation) | Prices in FX, settle in local; revalue balances | Turkey | Survives 50%+ inflation | Accounting complexity | Med | Very high (birr/naira/cedi) | Shared capability (FX price lists; JENIFY multi-currency base exists) | CV4 Si3 Sp3 IC3 Mn3 Rv4 Df4 Ev:H | [W1][K] | M |
| 59 | AKINSOFT | Cross | Product strategy | Vertical bundles (hotel/restaurant/market) off one core | Same engine, named packages | Turkey | Low-end proof of template model | Desktop-era tech | — | Validates strategy | Sector template (strategy confirmation) | CV4 Si4 Sp4 IC4 Mn3 Rv4 Df3 Ev:M | [W4a] | M |
| 60 | Logo/Tally | Cross | Distribution | Dealer/partner network sells & supports | Local dealer implements, trains, supports | TR/India | Scale without vendor headcount | Quality variance (ERPNext's curse) | — | High (trust is local) | (GTM input for Founder, not product) | CV4 Si3 Sp3 IC3 Mn3 Rv5 Df3 Ev:H | [W1][W5][W10] | H |

## F. African/local systems solving local problems better

| # | Competitor | Sector | Capability | Feature | Workflow | Country relevance | Strength | Weakness | Complexity | African relevance | JENIFY decision | Score notes | Sources | Conf |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 61 | Sage Pastel | SME | Distribution | Accountant-channel dominance (trained generation) | Accountants prescribe the software | South Africa | Channel = moat (DATEV pattern) | Product aging | — | High (accountant exports/GL Q) | (GTM input; supports GL open question) | CV4 Si3 Sp3 IC3 Mn3 Rv4 Df3 Ev:H | [W13] | H |
| 62 | RIB CCS Candy | Construction | Estimating | Contractor-built estimating→budget→cost-to-complete | Bill of quantities → allowables → valuations | SA/Africa/ME | African-built #1; project-centric unit of work | Not an ERP | High | High (construction template ref) | Sector template (construction, future; study concepts) | CV4 Si3 Sp3 IC2 Mn3 Rv4 Df4 Ev:H | [W22] | H |
| 63 | JiPOS/HotelPlus | Hotel | PMS | One system: reservations+POS+housekeeping+accounts | Front desk to folio in one | Kenya | Small properties refuse integrations | Ceiling for chains | Med-High | High (hotel template ref) | Sector template (hotel, future) | CV4 Si4 Sp3 IC3 Mn3 Rv4 Df3 Ev:M | [W21] | M |
| 64 | GAAP/Pilot | Restaurant | POS | Outage-tolerant restaurant POS + recipe costing | Service continues through load-shedding | South Africa | Built for African power reality | Local-market ceiling | Med | Very high | Sector template (restaurant, future) | CV4 Si4 Sp4 IC3 Mn3 Rv4 Df4 Ev:M | [W21][K] | M |
| 65 | Dolibarr | SME | Platform | $0 self-hosted simple ERP on cheap LAN box | Install once; run offline | Francophone Africa | Simplicity+price beat depth | Shallow modules; GPLv3 | — | High (francophone/OHADA distinct) | (Country-pack scope question §7.5; concepts only) | CV3 Si4 Sp4 IC4 Mn3 Rv2 Df2 Ev:H | [W18] | H |
| 66 | ERPNext-Egypt | SME | Compliance | Community-built ETA e-invoice integration (UUID stored) | Submit on post; state ref on invoice | Egypt | Open-source speed to compliance | Community maintenance risk | Med | High (pattern for ET when mandated) | Country pack (pattern reference) | CV4 Si4 Sp4 IC3 Mn3 Rv4 Df3 Ev:H | [W15] | H |
| 67 | Telebirr/CBE Birr (ecosystem) | Payments | Payments | Ethiopian mobile money rails | Pay/receive via wallet + reference | Ethiopia | The local cash-out/in reality | APIs immature/undocumented | Med | Very high (tenant #1's country) | Country pack (Ethiopia; after payment-method seam) | CV5 Si4 Sp4 IC3 Mn3 Rv5 Df5 Ev:M | [K][W25] | M |
| 68 | eProd | Agriculture | Supply chain | Outgrower/smallholder mgmt + momo farmer payments | Field collection→grading→payment to phone | Kenya | African agri physics done right | Niche | High | High (agri template ref) | Sector template (agriculture, future) | CV4 Si3 Sp3 IC2 Mn3 Rv4 Df4 Ev:M | [K] | M |
| 69 | Bahmni | Healthcare | Architecture | Composed vertical from open parts (EMR+Odoo billing+lab) | Integration seams make a hospital system | Global south | Proves platform-with-seams strategy | Integration fragility | — | Strategy validation | (Architecture lesson: clean seams enable verticals) | CV3 Si3 Sp3 IC3 Mn3 Rv3 Df3 Ev:M | [K] | M |

## G. Unnecessarily complicated workflows (anti-patterns to avoid)

| # | Competitor | Sector | Capability | Feature | Workflow | Country relevance | Strength | Weakness | Complexity | African relevance | JENIFY decision | Score notes | Sources | Conf |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 70 | SAP B1/BC/Odoo | Cross | Onboarding | Accounting-ceremony-first setup (COA, posting groups, periods before first sale) | Days of config before value | Global | Correct for auditors | Kills SME adoption; consultant tax | — | Anti-pattern | Reject (operations-first onboarding stays JENIFY law) | CV1 Si1 Sp1 IC2 Mn2 Rv1 Df1 Ev:H | [W9][W11] | H |
| 71 | Classic ERP | Cross | Purchasing | 7-step procure-to-pay as default for tiny firms | Req→RFQ→compare→PO→GRN→3-way match→pay | Global | Control at scale | Ceremony ≫ risk for SMEs | — | Anti-pattern | Reject as default; Company config opt-in later | CV1 Si1 Sp1 IC2 Mn2 Rv1 Df1 Ev:H | [W8][W11] | H |
| 72 | NetSuite/Odoo | Cross | Commercial | Opaque pricing, renewal uplifts (20–45%), behind-version surcharges (25%) | Lock-in then squeeze | Global | Vendor revenue | #1 customer complaint; churn fuel | — | Anti-pattern | Reject (transparent, predictable, local-currency pricing) | CV1 Si1 Sp1 IC1 Mn1 Rv2 Df1 Ev:H | [W8][W9] | H |

---

### Maintenance rules for this dataset
1. One row = one feature/idea at one competitor (or cohort). Never merge decisions across rows.
2. New rows append within the fitting section; new sections require Team Lead sign-off (schema stays fixed).
3. A row's `JENIFY decision` becomes binding only when echoed in `docs/JENIFY_DECISIONS.md`.
4. When a decision ships, update the row to `Core (built)` etc. and cross-link the feature-matrix row.
5. Open-source-derived rows are concept-level only (licenses: report §4); never record copied code or schema text here.
