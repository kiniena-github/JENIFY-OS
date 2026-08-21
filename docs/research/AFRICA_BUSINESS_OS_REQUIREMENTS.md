# AFRICA BUSINESS OS REQUIREMENTS REPORT

**Workstream R1 — JENIFY OS research program · Product Intelligence agent · 2026-08-21**

Scope: what software capabilities African businesses actually need, across the ladder
micro business → small shop → SME → mid-market → large local company → industrial company →
multi-site corporate. Every substantive claim carries *source · date · confidence*:
**verified** = primary source checked directly · **reported** = credible secondary coverage /
aggregated research seen via search · **inferred** = analyst judgment from the evidence.
No statistic in this report is invented; where provenance is weak it is flagged.

Judgment bar throughout: **FAST · SIMPLE · FLEXIBLE · LOCAL · INTELLIGENT.**

---

## 0. The operating reality the software must survive

These are the environmental facts that shape every requirement below.

| Fact | Evidence | Confidence |
|---|---|---|
| ~83% of African employment is informal (Central Africa 92.5%, West Africa 91.8%, 2024); informal economy ≈30–40% of GDP | ILO modelled estimates regional profile, Feb 2025; UNCTAD/World Bank via North Africa Post, 2024 | reported |
| ~90% of Nigeria's ~40M MSMEs operate informally; 44% of informal businesses earn under ₦20,000/day; ~90% profit under ₦500k/month | Moniepoint Informal Economy Report 2025 (TechCabal coverage, Oct 2025) | reported |
| Cash still dominates: only 1 in 4 Nigerian informal businesses gets even 10% of revenue digitally | Moniepoint 2025 report, Oct 2025 | reported |
| Mobile money is the payment rail: $1.4T transacted in Sub-Saharan Africa in 2025 (66% of global value), 1.2B registered accounts, 40% of SSA adults — highest ownership rate worldwide | GSMA State of the Industry Report on Mobile Money 2026 press release, 2026 | reported |
| Power is unreliable: firm sales losses from outages ≈$82B/yr globally plus ≈$65B/yr self-generation cost, concentrated in developing countries; SSA firms among the worst affected | World Bank Policy Research WP 8899 ("Underutilized Potential"), 2019 | reported |
| Connectivity is partial and expensive: SSA smartphone adoption 54% of connections (2024), mobile internet penetration ~27%, usage gap ~60% (covered but not using) | GSMA Mobile Economy SSA 2024 | reported |
| Ethiopia specifically: telebirr reached 58.6M users by H1 FY2025/26; national mobile-money accounts ~136M (2025) from <1M in 2020 | Ethio telecom H1 report 2025/26; Addis Insight Feb 2025; Birr Metrics 2026 | reported |
| Macro-instability is a business process: naira fell ₦997→₦1,535/$ during 2024 (−40.9%), inflation peaked 34.8%; the Ethiopian birr moved even more after the 2024 float | Chatham House, Mar 2025; Veriv Africa 2024 | reported |
| 80–90% of African SMEs are said to fail within 5 years, with cash-flow mismanagement the most-cited cause; provenance of the exact percentages is weak — treat as directional | MOHAC Africa; JTB Consulting; B&FT Ghana, 2023–2026 | reported (weakly provenanced) |
| Only ~1/3 of surveyed SMEs keep complete financial records; record-keepers grow materially faster (one survey: 28.3% vs 11.7% annual revenue growth) | Ghana/Nigeria academic SME surveys via ResearchGate, 2018–2025 (single-country samples) | reported (low) |
| Fewer than 1 in 3 African firms that adopted digital tools use them intensively | Borino, WTO working paper on firm digitalization in SSA, 2025 | reported |

**Consequence (inferred, high confidence):** the binding constraint is not missing features —
it is that existing software assumes formality, connectivity, literacy, stable currency and
trust that do not exist. An "Africa Business OS" wins on *survivability and simplicity*, not
feature count.

---

## 1. Universal capabilities — every African business, every size

Ranked by how universally the pain appears in the evidence.

1. **Cash control & daily money truth.** Cash-flow failure is the most-cited business killer
   (§0). The single universal question is "how much money do I actually have, and who owes
   me?" — answered daily, in one screen, mixing cash + mobile money + bank. *(inferred from
   failure-cause evidence; high confidence)*
2. **Customer credit / debt book.** Selling on credit is structural: 26.9% of Ghanaian
   informal firms extend trade credit to customers; mean delinquency ≈18% (PMC/Heliyon study,
   2024 — reported). Tracking who owes what, aging, limits, statements and reminders is a
   universal need the cash-register class of tools ignores.
3. **Stock visibility & shrinkage control.** Inventory is most firms' largest asset. Employee
   theft is endemic: a South African survey found 778 of 1,000 merchants reporting staff
   theft (avg ZAR 2,857/incident — UJ study, 2023, reported); dishonest employees ≈43% of
   retail shrinkage (Global Retail Theft Barometer 2014, reported). Requirement: append-only
   movements, balances that can't be quietly edited, counts/adjustments with audit trail.
4. **Simple selling & documents.** Invoice/receipt in seconds, printed or shared by phone,
   numbered sequentially — because paper receipts are still the trust instrument, and
   tax authorities increasingly demand structured invoices (§5.5).
5. **Payments capture across rails.** Cash, mobile money, bank transfer, POS-agent — often on
   one invoice, sometimes across currencies. Partial payments and allocation are the norm,
   not the edge case. *(inferred from §0 payment-mix evidence; high confidence)*
6. **Supplier & purchase tracking.** Knowing landed cost and supplier balances; 13.8% of
   Ghanaian informal firms receive supplier trade credit (same 2024 study — reported), so
   payables tracking mirrors the debt book.
7. **Owner visibility & anti-fraud reporting.** Owners run multiple ventures and cannot be
   physically present; theft evidence (§1.3) plus the remote-management pain make a trusted
   daily digest — sales, cash, stock deltas, exceptions — the highest-leverage single report.
   *(inferred; high confidence)*
8. **People & simple payroll.** Wages are daily/weekly, casual and shift-based; casual workers
   often expect end-of-day payment (Eazipay Nigeria practitioner guidance, 2026 — reported).
   Africa's HR/payroll software market: $487M (2026) → projected $1.66B (2035) (MarkWide
   Research, 2026 — reported).
9. **Data permanence & exit.** Kippa's bookkeeping app (≈500k businesses) went dark in
   Jan 2024, stranding users' inventory, debtor and transaction records (TechCabal,
   Feb 2024 — reported). Businesses have learned that cloud tools can vanish. Requirement:
   local-first data, always-available export, printed fallbacks.
10. **Works under bad power/connectivity, on cheap devices, in the user's language** — see §5.

---

## 2. Sector-specific capabilities

Only what the sector genuinely adds beyond §1. Sector packs should be *templates over one
core*, not forks (consistent with JENIFY's roadmap).

| Sector | Additional capabilities actually needed | Evidence & notes |
|---|---|---|
| **Retail / small shop** | Fast POS flow; price lists that survive weekly repricing (§5.6); supplier BNPL tracking (TradeDepot pivoted to stock aggregation + BNPL for shopkeepers — TechCrunch, Mar 2024, reported); shrinkage counts | FMCG margins are 2–5% (TechCrunch, 2024 — reported), so pennies of stock loss matter |
| **Distribution / wholesale FMCG** | Van/route sales, per-route cash reconciliation, customer credit at scale, delivery confirmation | The B2B e-commerce wave (Wasoko, MaxAB, MarketForce) collapsed on thin margins and logistics cost — Wasoko exited 5 countries in 2024; MaxAB-Wasoko pivoted to fintech (WeeTracker, Jul 2025 — reported). Lesson: sell *software to existing distributors*, don't become the distributor |
| **Manufacturing / industrial** | Batches, QC gates, traceability, scrap/rework, machine maintenance, production costing | JENIFY's Mesob pilot already proves the core loop (receiving→production→QC→packaging→sales — verified in repo). African manufacturing digital adoption remains shallow: high cost, skills gaps, vendor dependency (SA manufacturing studies, 2024 — reported) |
| **Pharmacy / healthcare retail** | Expiry/FEFO, regulated-item tracking, demand forecasting | mPharma runs vendor-managed inventory across 850+ pharmacies in 7 countries incl. Ethiopia (CGD/HowWeMadeItInAfrica, 2021–24 — reported); expiry tracking is the non-negotiable delta |
| **Agriculture / cooperatives** | Member/outgrower ledgers, seasonal input credit, weigh-and-grade receiving, patronage payouts | ~33M smallholder farms produce ~70% of the continent's food; farm-management software adoption remains very low; rural internet ~30% of adults (AgFunder News; GSMA AgriTech, 2023–26 — reported). Offline + local language are decisive here |
| **Construction / projects** | Project cost buckets, site material issue, subcontractor certificates, retention | *(inferred from sector structure; medium confidence — validate with a real tenant before building)* |
| **Hospitality (hotel/restaurant)** | Room/table orders, recipes/portion costing, shift cash-up | *(inferred; medium confidence — same validation rule)* |
| **Logistics / delivery** | Landmark-based addressing + GPS pins + phone-first coordination — formal addresses often don't exist ("second house after the yellow church…", icargos, 2025 — reported); proof-of-delivery; driver cash collection | Delivery failure rates and costs are structurally higher than developed markets (allbusiness.africa, 2026 — reported) |

Rule derived from the Wasoko/MaxAB/Kippa record *(inferred, high confidence)*: in every
sector, the durable business is the **operating system + records + compliance layer**, not
the marketplace/lending balance sheet. JENIFY should power operators, not replace them.

---

## 3. Small-business requirements (micro → small shop → small SME)

What the bottom of the ladder needs — and refuses to tolerate.

- **Time-to-first-value in minutes, not weeks.** No implementation project, no consultant.
  ERP-class tools fail here on cost, complexity and consultant dependency (South Africa
  open-source-ERP and SaaS-ERP barrier studies, 2013–2015 — reported).
- **One phone, shared and cheap.** Assume a low-end Android (SSA smartphone adoption 54% of
  connections; $40 4G-device pilots only starting 2026 — GSMA, reported), intermittent data,
  and multiple people using one device. Web/PWA + print beats app-store dependence.
- **Digitize the habit, don't replace it.** The debt notebook, the sack count, the
  end-of-day cash count — the software must mirror these rituals (JENIFY's `SacksPage`
  simple-transactions module is exactly this pattern — verified in repo).
- **Forgiving by design, honest by ledger.** Users mis-key constantly; corrections must be
  easy but *visible* (reversals, not edits) — the owner's trust depends on it.
- **Free/near-free entry with a real upgrade path.** ~90% of Nigerian informal businesses
  profit under ₦500k (~$330)/month (Moniepoint 2025 — reported): willingness to pay is tens
  of dollars a year at this tier. Monetize the tiers above; the micro tier is distribution
  and data gravity. *(inferred)*
- **Records that unlock credit.** 70.1% of Nigerian informal businesses have used some form
  of credit; formal loans correlate with +36% transaction values (Moniepoint 2025 —
  reported); lenders now score informal merchants from transaction data (Springer ML
  credit-scoring study, 2025 — reported). Clean digital records are the collateral of the
  informal economy — a first-order selling point, not a by-product.
- **What they do NOT need:** double-entry vocabulary, workflow engines, module catalogs,
  mandatory master-data setup, anything requiring an accountant to explain.

---

## 4. Enterprise requirements (mid-market → large local → industrial → multi-site corporate)

The top of the ladder needs what global ERP sells — minus the failure modes. A South
Africa/Zimbabwe case study found 3 of 8 medium-sized ERP implementations had to be redone
(ResearchGate, 2014 — reported); cloud-ERP adopters cite customization limits, vendor
dependency and data-control fear (SA studies, 2015–2024 — reported).

- **Role-scoped control:** RBAC, segregation of duties, approval thresholds, immutable audit
  trail — fraud control is a board-level topic, not a feature (§1.3, §0 theft evidence).
- **Multi-branch / multi-site:** per-site stock, inter-site transfers, site P&L, consolidated
  owner view; sites must keep operating when the link to HQ is down (offline-first at the
  *site* level, not just the device — inferred from §5.1–5.2; high confidence).
- **Production depth:** BOM/recipe, costing and valuation, planning, maintenance, QC and full
  traceability (export buyers and regulators demand it).
- **Statutory compliance:** country-pack tax (VAT regimes, withholding), e-invoicing
  integration (§5.5), payroll statutory deductions, fiscal document numbering.
- **Multi-currency as core:** FX-denominated imports plus devaluation (§0) make currency
  snapshots on every document mandatory (JENIFY already snapshots — verified in repo).
- **Data migration & coexistence with Excel:** every enterprise arrives with years of
  spreadsheets; import tooling and CSV-everywhere export are adoption gates. *(inferred; high
  confidence)*
- **Local implementability:** implementations must succeed with local partners and days—not
  consultant-years; configuration over customization, templates extracted from real
  deployments (JENIFY roadmap already encodes this — verified in repo).
- **Anti-requirements:** SAP-scale process bureaucracy, per-seat pricing that punishes
  low-wage headcount, mandatory always-on cloud.

---

## 5. Africa-specific requirements (the non-negotiables)

These separate a real Africa OS from a localized Western product.

**5.1 Power resilience.** Outages are routine and costly (§0, World Bank WP 8899 — reported).
Requirements: instant restart with zero data loss (journaled local DB), battery-friendly
clients, printable fallbacks so business continues on paper and is back-captured later.
*(design implications inferred; high confidence)*

**5.2 Connectivity independence.** With a ~60% usage gap and 2G/3G realities in rural areas
(GSMA, reported), offline-first is an architecture, not a feature: local device/site as
source of truth, queued sync, conflict resolution, low-bandwidth payloads (practitioner
engineering guidance for African field teams — GBOX/Paneo, 2025–26, reported). JENIFY's
local-first single-site design already delivers this for tenant #1; multi-site sync is the
hard next step (feature matrix: offline sync DESIGN-ONLY — verified in repo).

**5.3 Mobile money & agent rails as first-class payments.** $1.4T/yr in SSA (GSMA 2026 —
reported); Nigeria's ~2M POS agents processed ₦10.51T in Q1 2025 alone, +302% YoY (NIBSS via
THISDAY, Feb 2026 — reported); Ethiopia runs on telebirr (§0). Requirements: record and
reconcile mobile-money receipts per provider, country packs per rail (telebirr, M-Pesa,
MoMo, Wave), and *reconciliation before integration* — recording a telebirr reference on a
payment is 80% of the value at 5% of the complexity of live APIs. *(inferred; high
confidence)*

**5.4 Cash as a managed asset.** Cash remains dominant (§0). Requirements: cash drawers/
tills per user, shift cash-up, deposit tracking, variance flags — the software must make
cash *auditable*, since cash is where fraud lives. *(inferred from §1.3 evidence; high)*

**5.5 Tax & document compliance packs.** E-invoicing mandates are spreading fast: Kenya
eTIMS mandatory since Jan 2024 with expenses non-deductible without an e-invoice; Rwanda EBM
since 2013; Nigeria FIRS phased B2B/B2C/B2G e-invoicing from Aug 2025 (₦5B+ turnover first);
Egypt, Uganda, Tanzania active (VATupdate/Sovos, 2025–26 — reported). Compliance is becoming
a *forced adoption moment* for business software — the state is pushing businesses into
exactly the records JENIFY produces. Country packs (tax rules + fiscal invoice formats +
filing exports) become a moat and a distribution channel.

**5.6 Inflation/devaluation-aware operations.** 30%+ inflation and 40%+ annual devaluation
(§0) mean prices change weekly. Requirements: bulk repricing, price lists with effective
dates, replacement-cost awareness so sales don't destroy margin (consumer-goods costs rose
67% in one year in Nigeria — Veriv Africa, reported), FX-rate snapshots on documents.

**5.7 Language & literacy.** Translation alone is insufficient — usability for low-digital-
literacy users is the deeper barrier (ICTworks; GSMA usage-gap analysis — reported).
Requirements: editable per-tenant terminology (JENIFY framework exists; only ~1.5% content
translated — verified in repo, defect T8), numerals-and-icons-first screens, voice/photo
input as a future lever, Amharic/Tigrinya/Swahili/Hausa/French/Arabic packs prioritized by
deployment geography.

**5.8 Informality gradient.** Businesses are not "formal or informal" — they formalize by
degrees. The OS must run a business with no TIN, no bank account and one employee, and let
it *grow into* compliance (registers → invoices → tax pack → payroll) without re-platforming.
*(inferred from §0 informality evidence; high confidence)*

**5.9 Trust & data ownership.** Post-Kippa (§1.9), "your data lives with you and exports
freely" is a marketable requirement, and local-first is its proof. JENIFY's architecture is
already the answer; say it out loud in positioning.

---

## 6. Must-have vs optional matrix

M = must-have · O = valuable option · — = not applicable. Tiers: **T1** micro/small shop ·
**T2** SME · **T3** mid-market/large local · **T4** industrial/multi-site corporate.
*(Matrix is analyst synthesis of §§1–5 — inferred, high confidence)*

| Capability | T1 | T2 | T3 | T4 |
|---|---|---|---|---|
| Sales + receipt/invoice + document numbering | M | M | M | M |
| Cash & payments capture (cash/mobile money/bank, partial payments) | M | M | M | M |
| Customer credit / debt book + aging | M | M | M | M |
| Stock ledger, immutable movements | M | M | M | M |
| Stock counts, adjustments, low-stock alerts | O | M | M | M |
| Supplier balances & purchases | O | M | M | M |
| Purchase orders / procurement workflow | — | O | M | M |
| Costing, margins, valuation | O | M | M | M |
| Bulk repricing / price lists | M | M | M | M |
| Owner daily digest + exception alerts | M | M | M | M |
| RBAC, audit trail, approval limits | O | M | M | M |
| Multi-branch stock + transfers | — | O | M | M |
| Offline operation (device/site) | M | M | M | M |
| Mobile-money recording & reconciliation | M | M | M | M |
| Mobile-money/bank API integration | O | O | M | M |
| Country tax pack (VAT, e-invoice, fiscal docs) | O* | M | M | M |
| Payroll (casual/daily + statutory) | O | O | M | M |
| Production: batches, QC, traceability | — | O (if maker) | M (if maker) | M |
| BOM/recipes, production costing | — | O | M | M |
| Maintenance / assets | — | — | O | M |
| Delivery management, landmark addressing, POD | O | O | M | M |
| Multi-currency documents | O | M | M | M |
| Local language / custom terminology | M | M | M | M |
| Data export / printed fallbacks | M | M | M | M |
| Consolidated group reporting | — | — | O | M |
| AI assistance (queries, anomaly flags) | O | O | O | O→M trend |

\* becomes M the moment the country mandate reaches the tier (Kenya already has no
turnover threshold — §5.5).

---

## 7. Biggest unmet needs (the gaps nobody serves well)

1. **The missing middle.** Bookkeeping apps (Kippa-class) are too shallow and die; ERP
   (SAP/Odoo-class) is too heavy and fails in implementation (§4). A growing SME must today
   choose between a toy and a project. Nothing credible occupies "runs a real multi-person
   business, installable in a day." *(inferred from §3/§4 evidence; high confidence)*
2. **Offline-first multi-branch stock truth.** Cloud POS tools assume connectivity; ERP
   assumes a WAN. Site-autonomous operation with trustworthy sync is essentially unserved at
   SME price points. *(inferred; high)*
3. **Customer-credit discipline tooling.** The debt book is universal (§1.2) yet almost no
   tool treats credit sales, limits, statements and collection as the core object. JENIFY's
   Mesob pilot already does (credit sales + limits DONE — verified in repo) — rare ground.
4. **Fraud-resistant operations for low-trust environments.** Append-only ledgers, cash
   variance detection, role separation, and an owner digest that *cannot be doctored by
   staff* — demanded by the theft evidence (§1.3), delivered by almost nobody at SME scale.
5. **Compliance without accountants.** e-invoicing mandates (§5.5) will strand millions of
   small firms; "press one button, be compliant" country packs are wide open.
6. **Devaluation-aware pricing and costing** (§5.6) — Western software assumes stable money.
7. **Records-to-credit bridge.** Clean operational data that a lender can trust (with the
   owner's consent) — the fintechs proved demand (§3), then exited the software side.
8. **Data permanence guarantee** — the anti-Kippa promise (§5.9).
9. **Genuinely local UX** — language + literacy + terminology (§5.7); translation projects
   exist, usable low-literacy business software barely does.

---

## 8. Major JENIFY opportunities, ranked by value-vs-complexity

Ranked score = customer value × Africa-fit ÷ complexity, judged against FAST · SIMPLE ·
FLEXIBLE · LOCAL · INTELLIGENT and against what the repo already contains (never rebuild
what exists). Status refers to `docs/FACTORY_OS_FEATURE_MATRIX.md`.

| # | Opportunity | Why it wins | Complexity | Repo status |
|---|---|---|---|---|
| 1 | **Owner daily digest & exception alerts** (sales, cash, stock deltas, credit breaches; exportable/printable, later WhatsApp-able) | Counters theft + absentee-owner pain (§1.3, §1.7); roadmap already flags it as the cheap answer to competitors' remote-visibility demos | Low | Dashboard DONE; digest export MISSING |
| 2 | **Stock-control pack: adjustments, cycle counts, reorder alerts** | Direct shrinkage counter (§1.3); completes the inventory story cheaply on the existing ledger | Low | MISSING (M4 queue) |
| 3 | **Data-ownership positioning + one-click full export** | Anti-Kippa trust moat (§1.9); near-zero build on local-first architecture | Very low | Architecture DONE; productize the promise |
| 4 | **Customer-credit discipline suite: statements, aging, reminders, collection notes** | Universal debt-book need (§1.2); extends an existing strength instead of building anew | Low–Med | Credit sales/limits DONE; statements MISSING |
| 5 | **Mobile-money reconciliation (record + reconcile telebirr/M-Pesa refs; APIs later)** | $1.4T rail (§5.3); reconciliation-first captures most value at a fraction of API complexity; Ethiopia pack first (Mesob) | Med | Payments DONE; provider refs/reconciliation MISSING |
| 6 | **Costing, margins & devaluation-aware repricing (incl. bulk reprice, purchase cost capture)** | Inflation reality (§5.6); biggest analytical gap in current build | Med | DESIGN-ONLY (M2) |
| 7 | **Supplier/procurement completion (supplier UI, POs, payables aging)** | Mirrors the debt book on the buy side (§1.6); mostly assembling existing party/ledger machinery | Med | Suppliers PARTIAL, POs DESIGN-ONLY (M2) |
| 8 | **Country compliance packs (Ethiopia first; eTIMS/EBM/FIRS blueprints next)** | Mandates force adoption (§5.5); packs = moat + distribution; fits config-over-core architecture | Med–High (per country) | Numbering/VAT DONE; e-invoice integr. MISSING |
| 9 | **Local-language content completion + low-literacy UX pass (Amharic/Tigrinya first)** | Framework already built — content is ~1.5% done (T8); cheap differentiation vs every foreign competitor (§5.7) | Low–Med | Framework DONE, content MISSING |
| 10 | **Casual workforce & daily-wage payroll** | Real need (§1.8) but tier-3+ urgency; statutory complexity per country | Med | MISSING (M5 design) |
| 11 | **Offline multi-site sync / site-node architecture** | The unserved structural gap (§7.2) and the T4 unlock — but the highest-risk build; sequence after multi-tenancy hardening per roadmap risk #1 | High | DESIGN-ONLY (deferred) |
| 12 | **AI operating layer (read-only intents first: "what did we sell yesterday?")** | INTELLIGENT differentiator; safe path already specified in principles; needs the declarative action catalog first (roadmap risk #3) | High | DESIGN-ONLY (future milestone) |
| 13 | **Records-to-credit export (consented lender pack)** | High strategic value (§7.7) but needs partners + founder approval on external sharing; design only for now | Med (mostly non-technical) | Not started |

**Explicitly not recommended:** becoming a marketplace/distributor/lender (Wasoko/MaxAB
graveyard, §2); feature-parity chases against SAP/Odoo module lists (§4 anti-requirements);
building sector packs (construction, hospitality) ahead of a real tenant — extract from
deployments, never from imagination (roadmap risk #2).

**Open questions for the Team Lead:** (1) Which country after Ethiopia — Kenya (eTIMS
maturity) or Nigeria (market size)? (2) Pricing architecture for the T1 free tier vs T2/T3
monetization. (3) When does WhatsApp delivery of the owner digest clear the "no external
services without Founder approval" bar? (4) Validation plan for the informal-tier UX —
Mesob proves the factory tier, not the shop tier.

---

## Executive summary (for the Team Lead)

1. Africa's business base is ~83% informal, cash-heavy, mobile-money-native ($1.4T/yr SSA), power- and connectivity-constrained — software must survive this, not assume it away (reported, multi-source).
2. The universal needs are five: daily money truth, customer debt book, tamper-proof stock, instant documents, and an owner digest that staff cannot doctor.
3. The market's missing middle — between bookkeeping toys that die (Kippa) and ERPs that fail in implementation (3/8 redone in one study) — is exactly the ground JENIFY's Mesob-proven core occupies.
4. Fraud is a first-class requirement: staff theft is near-universal in the evidence; JENIFY's append-only ledger + RBAC + audit trail is a differentiator to be completed (counts, cash-up, digest) and marketed.
5. Credit sales are structural, not exceptional — JENIFY's existing credit machinery is rare; extend it with statements/aging/reminders cheaply.
6. E-invoicing mandates (Kenya, Rwanda, Nigeria, Egypt, Uganda, Tanzania) are forcing businesses into digital records — country compliance packs are both moat and distribution.
7. Inflation/devaluation (30%+ / 40%+ in anchor markets) makes bulk repricing and replacement-cost margin awareness a core requirement Western software lacks.
8. Local-first architecture is the strategic asset: it answers power, connectivity, and the post-Kippa data-trust crisis — productize the guarantee; sequence multi-site sync only after multi-tenancy hardening.
9. Top near-term value-per-complexity: owner digest, stock-control pack, data-export promise, credit statements, mobile-money reconciliation — all low/medium builds on existing foundations.
10. Do not become a marketplace, lender, or SAP clone; the durable position is the operating system + records + compliance layer, extracted into templates from real deployments.

---

*Method note: evidence gathered 2026-08-21 via web research (GSMA, World Bank/IFC/ILO,
academic SME studies, African tech press, practitioner accounts) plus repo review
(`CLAUDE.md`, `docs/JENIFY_ROADMAP.md`, `docs/FACTORY_OS_FEATURE_MATRIX.md`). Figures seen
through secondary coverage are marked "reported"; none are invented. Key sources: GSMA
SOTIR 2026 & Mobile Economy SSA 2024; World Bank WP 8899 (2019); ILO regional profile
(2025); Moniepoint Informal Economy Report 2025; TechCabal (Kippa, Feb 2024); TechCrunch /
WeeTracker (B2B e-commerce, 2024–25); VATupdate/Sovos e-invoicing trackers (2025–26);
Chatham House (naira, 2025); Ethio telecom H1 2025/26 report; UJ employee-theft study
(2023); Ghana trade-credit study (PMC, 2024); WTO Borino working paper (2025).*
