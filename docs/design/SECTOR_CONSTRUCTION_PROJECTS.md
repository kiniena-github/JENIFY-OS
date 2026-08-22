# JENIFY OS — Sector Blueprint: Construction & Projects

**Status: DESIGN ONLY.** No code, no migrations, no routes may be built from this document
until (a) the shared platform contracts it depends on stabilize (see §11) and (b) the Founder
opens a construction milestone. Owner: `jenify-template-engineer` (construction/projects
focus). Date: 2026-08-22. Inputs: `docs/research/AFRICA_SECTOR_PRIORITY.md` §4.12,
`docs/research/AFRICA_BUSINESS_OS_REQUIREMENTS.md` §2/§5, `docs/FACTORY_OS_CURRENT_STATE.md`
§2/§3/§6, `docs/research/MOBILE_LOWEND_UX.md`, `docs/JENIFY_DECISIONS.md`.

---

## 0. Honesty header — why this is written now, and what it is not

- Construction ranks **#12 of 17** in the sector priority report (score 2.85): high revenue
  per tenant, extreme offline need, but "a genuinely new module family" gated on costing and
  multi-site. The research verdict stands: *the near-term way to serve this market is the
  building-materials supplier on the trade template.*
- The requirements report grades construction needs as **inferred, medium confidence —
  "validate with a real tenant before building"**, and explicitly lists "building sector
  packs (construction, hospitality) ahead of a real tenant" as **not recommended**.
- Therefore this blueprint's job is narrower and more valuable than "spec the module":
  1. Define the **domain model and workflows** so the team knows the shape of the demand.
  2. Extract the **platform contracts** construction imposes (projects/cost dimension,
     approvals, procurement, attachments, offline) so those primitives are designed
     **sector-neutral** — most are needed by ranks 1–6 anyway.
  3. Give the Founder a **decision surface**: what a construction pilot would require,
     what stays out, and which questions only a real contractor can answer.
- Every business rule below that is Ethiopian/African practice is marked with confidence.
  Rates, percentages and statutory rules are **`[VERIFY-LOCAL]` — configuration, never
  hardcoded** (Principle 4: never fabricate business rules).

## 1. Who this template serves

| Segment | Description | Fit |
|---|---|---|
| SME general contractors | Licensed grade contractors (Ethiopia licenses contractors in graded categories, GC/BC classes — exact grade rules `[VERIFY-LOCAL]`), 5–200 staff, 1–10 concurrent projects, materials-heavy | Primary |
| Specialist subcontractors | Finishing, electrical, sanitary, structural steel crews that themselves buy materials and bill main contractors | Primary (smaller config) |
| Own-build developers | Real-estate developers building to sell/rent; same site physics, self-billing | Secondary |
| Labor-only subcontractors | Crew + gang leader, near-zero materials | Out of v1 (they are a party in someone else's tenant, not a tenant) |

The buying pain (from the research): **material-cost volatility** (steel/aluminium price
shocks), material leakage from sites, no budget-vs-actual truth per project, cash advances
that never get retired, and client billing (interim certificates) assembled by hand in Excel.

**Sector language note:** Ethiopian/African formal construction is **BOQ-driven** (Bill of
Quantities: hierarchical work items with unit rates, derived from standard methods of
measurement; PPA/MoWUD standard bidding documents and FIDIC-derived conditions on larger
works — practice, HIGH confidence; document formats `[VERIFY-LOCAL]` per country pack).
Progress is billed through **Interim Payment Certificates (IPC)** based on measured
quantities, with **retention**, **advance recovery**, and **variation orders**. The template
must speak this language natively, via the existing editable-terminology framework.

## 2. Core domain objects

Conventions inherited from the platform, non-negotiable: quantities in integer milli
base-units; money in integer cents (tenant default currency, FX snapshot per document);
posted documents draft → posted → reversed, never deleted; every mutation audited; every
table tenant-scoped; settings versioned append-only.

### 2.1 Project (NEW — platform primitive, not construction-only)

The unit of cost truth. Conceptually: code, name, client (existing `parties`), contract
reference, currency, planned start/end, status (`draft → active → suspended → closed`),
linked site(s), linked site store warehouse(s), responsible PM (user), original contract
sum (cents), approved-variations-to-date (derived), revised contract sum (derived).
Projects are a **cost-attribution dimension**, not a document: value-bearing records point
at a project; the project never owns ledger rows.

### 2.2 Site and site store (REUSE + EXTEND)

A site is a physical place of work; a **site store is a warehouse** (existing `warehouses`)
flagged with a site/project association. Central store = existing warehouse, unchanged.
This reuses the entire append-only stock ledger, balances cache, lots, reservations, and
transfers for site inventory **without a new inventory system**. Multi-*site* here means
multiple warehouses in one tenant DB — which the platform already supports — not the
deferred multi-node sync architecture (§11.4 covers where that boundary bites).

### 2.3 Contract, BOQ and budget (NEW — template family)

- **BOQ**: hierarchical bill → section (substructure, superstructure, finishes…) → line
  items: item code, description, UoM (existing `uoms`), contract quantity (milli), unit
  rate (cents), amount (derived). Imported (data-migration tooling) or entered; **versioned
  append-only** — a variation order creates a new BOQ revision, never edits history.
- **Budget cost codes**: the internal cost view. v1 keeps this deliberately simple: a flat,
  configurable cost-code list per tenant (default pack: `MAT` materials, `LAB` labor,
  `SUB` subcontract, `EQP` equipment/fuel, `EXP` site expenses/overhead), each with a
  budget amount per project. BOQ = what we sell to the client; cost codes = what we spend.
  Mapping BOQ→cost-codes (full quantity take-off costing) is **out of v1** (§9).
- Lump-sum contracts without BOQ: supported by a one-line BOQ (lump sum item, percent
  measured) — no special mode.

### 2.4 Material request — MR (NEW — thin document on existing primitives)

Site's demand signal: requested-by (user), project, site store, needed-by date, lines
(item, qty, purpose note), status (`draft → submitted → approved/rejected →
fulfilled/partially → closed`). Approval runs through the generic approvals primitive
(§2.10). Fulfilment is by **transfer** (central → site store; existing `stock_transfers`)
and/or **purchase** (→ PO), each fulfilment line linked back to the MR.

### 2.5 Purchasing (REUSE M2 — hard dependency)

Suppliers already exist as `parties`; purchase orders, purchase receipts matched to PO, and
**cost capture** are the roadmap's M2 build. Construction adds only: PO carries optional
project + cost code; receipt into a site store books cost to the project. **No
construction-specific purchasing engine** — if M2 procurement isn't built, this template
cannot ship (activation map §8).

### 2.6 Subcontractors and payment certificates (NEW — document family)

- Subcontractor = existing `parties` (type extended or role-flagged — same pattern as
  customers/suppliers).
- **Subcontract agreement**: project, subcontractor, scope description, BOQ subset or own
  bill, agreement sum, retention % `[config]`, advance given (cents).
- **Subcontractor payment certificate (SPC)**: work-done-to-date lines (qty measured ×
  rate), gross to date, less previous certificates, less retention `[config %]`, less
  advance recovery `[config schedule]`, net payable. Posted SPC creates a **payable** the
  Finance role settles through the existing payments engine (payments already support
  multi-document allocation; direction "outgoing" reuses the supplier-payment path M2
  introduces). Certificates are numbered documents (existing numbering), printable
  (existing print subsystem), immutable once posted.

### 2.7 Equipment and fuel (NEW-light — log objects, not asset management)

Full maintenance/asset management is an M5 design-first domain (`maintenance-asset` agent).
v1 construction needs only **cost visibility and anti-theft logs**:
- **Equipment register**: name, type (owned/rented), plate/serial, current site, hourly or
  daily internal rate (cents) `[config]`, rental supplier + rate if rented.
- **Equipment usage log**: date, project, equipment, hours/days, operator name, meter
  reading (optional) → books `EQP` cost at the internal/rental rate.
- **Fuel log**: date, project, equipment/generator, liters (milli), source (site fuel stock
  item or direct purchase), odometer/hour-meter reading. Fuel held on site is just a stock
  item in the site store — issues flow through the ledger like any material (the research
  flags fuel as a top leakage vector; the append-only ledger is the counter).

### 2.8 Workforce — daily labor (NEW-light — muster roll, not payroll)

Payroll is missing platform-wide (M5 design-first) and site labor is largely **informal,
daily/weekly cash-paid** (requirements report §0/§1.8 — HIGH confidence). v1 records the
economic fact without statutory payroll:
- **Daily labor record** (part of the site diary, §2.9): date, project, cost code, headcount
  by category (daily laborer, mason, carpenter… categories `[config]`), rate per category
  (cents) `[config]`, gang leader name (free text or party), total labor cost (derived).
- Payment of labor happens through petty-cash/expense retirement (§2.11), not payroll.
- Named-worker attendance, skills, statutory deductions: **out of v1**, feeds the M5
  workforce design later.

### 2.9 Daily site diary (NEW — the sector's anchor ritual)

One record per site per day, filed by the Site Engineer/Foreman from a phone:
date (Gregorian + Ethiopian calendar display — existing shared helper), weather/stoppage
note, work executed (free text + optional BOQ-line quantity progress entries), labor block
(§2.8), equipment block (§2.7), materials received/issued summary (auto-pulled from ledger,
not retyped), visitors/instructions received, photos (§2.12), issues/safety incidents.
Submitted diaries are immutable (correction = follow-up entry, consistent with Principle 5).
The diary is deliberately **the one mandatory daily mobile artifact** — everything else
hangs off it.

### 2.10 Approvals (NEW — core platform primitive, sector-neutral)

Construction is approval-dense (MRs, POs, certificates, variations, advances) but the need
is universal (trade wants credit-override and price-override approvals; the requirements
report lists "approval limits/thresholds" as a T2+ must-have). Design once, in core:
- **Approval policy** (versioned settings): per document type, threshold bands in cents →
  required approver role(s), sequential steps supported, self-approval forbidden.
- **Approval request**: document type + id, amount, requester, status
  (`pending → approved → rejected → withdrawn`), step records with actor, timestamp,
  comment. Append-only; every action audited.
- Enforcement is server-side at posting time (same philosophy as `requirePermission` and
  financial masking): a document whose policy demands approval cannot post without a
  granted request. Notifications ride the M4 notifications work when it lands; v1 exposes
  an "outstanding approvals" queue per role (dashboard + mobile).

### 2.11 Expenses, petty cash and advances (NEW-light — document + ledger discipline)

The African site reality (requirements report §1/§5.4 — cash is where fraud lives):
- **Cash advance**: to a staff member (user or named party), project, amount, purpose,
  approval per policy. Open advances are a first-class visible balance.
- **Advance retirement**: itemized expense lines (date, cost code, description, amount,
  photo of receipt), cash returned, over/under-spend explicit. Advance closes only by
  retirement or audited write-off.
- **Direct site expense**: same line shape without an advance (paid from site float).
  All expense lines book to project + cost code. No general ledger is implied — these are
  operational cost records (the platform's no-GL ceiling stands; see §12 Q6).

### 2.12 Photos and attachments (REUSE — activate T5)

The schema's `attachments` table exists and is entirely unused (current state T5). Site
photos (diary, receipts, delivered materials, work progress, retirement receipts) are its
first real consumer. Requirements: capture from phone camera, client-side downscale to a
size budget `[config, default small — sites run on expensive data]`, attach to diary /
receipt / retirement / certificate; immutable once the parent posts.

### 2.13 Progress claim / Interim Payment Certificate to client (NEW — document family)

The revenue side, mirroring §2.6 in the other direction:
- **Measurement record**: per BOQ line, cumulative quantity executed to date (entered by
  PM/QS, evidenced by diary progress entries). Versioned per claim.
- **Progress claim (IPC)**: gross value to date (Σ measured qty × rate, on the current BOQ
  revision), less previously certified, plus/minus approved variations, less retention
  `[config %, cap % of contract — commonly retention ~5–10% with caps; VERIFY-LOCAL]`,
  less advance recovery `[config schedule — mobilization advances of ~20–30% recovered
  pro-rata are common practice; VERIFY-LOCAL]`, VAT per existing tax config, net claim.
- Client-side certification (consultant/engineer approval external to the tenant) is
  recorded as a status + certified-amount field with attachment — JENIFY documents the
  process, it does not simulate the consultant.
- A posted/certified IPC produces a **receivable** through the existing sales-invoice
  machinery (invoice lines snapshot pricing/VAT exactly as today), so collections, credit
  view, statements and payment allocation are **pure reuse**. Retention receivable is
  tracked as an explicit remainder, released by a final/retention certificate.

### 2.14 Variation order — VO (NEW — versioning discipline on the BOQ)

Client-instructed scope change: reference, description, instruction attachment, new/changed
BOQ lines (add line, change quantity, new rate item), value delta (cents, signed), status
(`draft → submitted → client-approved → rejected`). An approved VO creates a **new BOQ
revision** (append-only) and moves the revised contract sum. Unapproved work-at-risk is
visible as a flagged VO in `submitted` state — a real African pain: contractors die on
unpaid variations (inference from sector structure, MEDIUM).

## 3. Mapping to existing JENIFY capabilities — reuse vs NEW

| Construction need | Platform capability today | Verdict |
|---|---|---|
| Clients, subcontractors, suppliers | `parties` (customers done; suppliers partial) | **REUSE** (+ M2 supplier UI) |
| Site stores / central store | `warehouses` + append-only `stock_movements`, balances, lots, reservations | **REUSE** — site store = warehouse with site flag (**EXTEND**: flag only) |
| Material transfer to site | `stock_transfers` | **REUSE** |
| Site material receipt | `goods_receipts` + receiving flow | **REUSE** (+ M2 PO match) |
| Material issue to work | `stock_movements` issue type | **EXTEND**: carry project + cost code |
| Purchasing / POs / cost capture | M2 (design-only today) | **DEPENDENCY** — must exist first |
| Client billing, VAT, numbering, print | sales invoices, numbering, branding-snapshot print | **REUSE** under IPC document (**EXTEND**: claim math wrapper) |
| Collections, credit, statements | payments + allocations, credit view | **REUSE** |
| Subcontractor payment | payments engine (outgoing direction lands with M2 payables) | **REUSE** after M2 |
| Roles, permissions, financial masking | versioned RBAC, `view_financial` server-side masking | **REUSE** — certificate/BOQ rates masked for site roles |
| Audit, immutability, reversal lifecycle | audit events, draft/posted/reversed | **REUSE** |
| Terminology (BOQ, IPC, VO wording; Amharic/Tigrinya) | editable terminology + i18n framework | **REUSE** (content work) |
| Ethiopian calendar, UTC storage | shared calendar helpers | **REUSE** |
| Photos / documents | `attachments` table (unused, T5) | **REUSE — first activation** |
| Data import (BOQ from Excel) | jenify-data-migration tooling (planned) | **DEPENDENCY** (soft — manual entry possible) |
| Projects as cost dimension | nothing | **NEW — core** |
| Approvals engine | nothing | **NEW — core (sector-neutral)** |
| BOQ / budgets / measurement / IPC / VO / SPC | nothing | **NEW — template family** |
| MR document | nothing | **NEW — template (thin)** |
| Equipment register + usage/fuel logs | nothing (M5 maintenance is design-first) | **NEW-light — template; feeds M5 design** |
| Daily labor muster | nothing (M5 workforce design-first) | **NEW-light — template; feeds M5 design** |
| Site diary | nothing (`simple_transactions`/SacksPage proves the "digitize the ritual" pattern) | **NEW — template** |
| Petty cash advance/retirement | nothing | **NEW — template (near-sector-neutral; trade wants it too)** |
| Offline capture at site | O2 receiving-first pattern (decision 2026-08-22) | **REUSE pattern**, extend queue to diary + receipt |

## 4. Workflows

Permissions shown as (module, action) in the existing matrix style; all postings audited;
all documents numbered via existing sequences.

### 4.1 Material request → approval → purchase/transfer → site receipt → issue

| # | Step | Actor | System behavior |
|---|---|---|---|
| 1 | Raise MR from site (phone) | Site Engineer/Foreman | Draft MR; lookup-first item picker; offline-queueable |
| 2 | Submit | Site Engineer | Approval request opens per policy (e.g. value > threshold → PM; above band 2 → Director) `[config]` |
| 3 | Approve / reject / trim lines | PM (then Director if banded) | Step recorded; rejection returns with comment |
| 4a | Fulfil by transfer | Storekeeper (central) | `stock_transfers` central → site store, linked to MR lines |
| 4b | Fulfil by purchase | Procurement | PO (M2) referencing MR + project + cost code; PO approval per policy |
| 5 | Site receipt | Site Storekeeper/Foreman | Goods receipt into site store (offline-capable — O2 receiving pattern); photo of delivery; qty variance vs MR/PO explicit |
| 6 | Issue to work | Site Storekeeper | Issue movement with project + cost code (+ optional BOQ section note); balance derives from ledger |
| 7 | Close MR | PM or auto on full fulfilment | Unfulfilled remainder explicit, never silent |

Anti-leakage properties: site stock is ledger-derived and count-checkable (M4 counts apply
to site stores automatically); every issue names who/when/what-for; MR-vs-received-vs-issued
variance is reportable per site.

### 4.2 Daily progress reporting

1. Foreman opens today's diary (phone, offline-tolerant): yesterday's copy pre-fills labor
   categories and equipment list — **low typing**.
2. Enters: labor headcounts, equipment hours, fuel, work-done notes, optional BOQ-line
   quantities, photos, incidents.
3. Submits → immutable; PM sees it in the morning review queue; unsubmitted diaries by
   `[config]` cutoff surface as an exception on the PM/Owner dashboard (the "owner digest
   that staff cannot doctor" principle applied to sites).
4. Diary quantities feed the measurement record as *evidence*, never auto-certify.

### 4.3 Subcontractor payment certificate

1. Subcontractor requests valuation (off-system) → PM/QS enters measured quantities against
   the subcontract bill.
2. SPC drafted: system computes gross-to-date, less previous, retention, advance recovery →
   net. All deduction lines explicit, printable.
3. Approval per policy (PM → Director above threshold `[config]`).
4. Posted SPC = payable; Finance pays via payments engine (cash/bank/telebirr reference
   required for non-cash — existing rule), allocation to certificate explicit.
5. Retention ledger per subcontractor visible; released via final certificate at defects
   period end `[config]`.

### 4.4 Variation order

1. Instruction received on site → captured in diary + photo/attachment immediately
   (evidence timestamp).
2. PM drafts VO: changed/new BOQ lines, value delta, rate basis (BOQ rate / pro-rata / new
   rate `[config vocabulary]`).
3. Internal approval per policy → submitted to client/consultant (printed doc) → status
   client-approved (with reference + attachment) or rejected.
4. Approved VO posts a new BOQ revision; revised contract sum updates; next IPC includes it.
   Work-at-risk (executing before approval) is a flagged state the Owner dashboard counts.

### 4.5 Progress claim / IPC (client billing)

1. PM/QS updates cumulative measurement per BOQ line (current revision).
2. Claim drafted: system computes the §2.13 waterfall; every deduction is a visible line.
3. Internal approval (Director above threshold) → print → submit to consultant/client.
4. Certification recorded (certified amount may differ from claimed — both kept; delta
   reportable). Certified IPC posts the receivable invoice; retention remainder tracked.
5. Collections/aging/statements run on existing machinery; unpaid certified IPCs age on the
   existing credit view.

### 4.6 Cash advance → retirement

1. Site Engineer requests advance (phone): amount, purpose, project → approval per policy.
2. Finance pays (existing payment methods; telebirr/bank ref required) → open advance
   visible on both sides.
3. Engineer retires: itemized lines + receipt photos + cash returned; over/under explicit.
4. Finance accepts retirement (or bounces lines) → advance closes; costs book to
   project/cost codes. Outstanding-advance aging is a standard Finance/Owner report.

## 5. Mobile site experience

Governed by the approved mobile rules (decisions 2026-08-22; `MOBILE_LOWEND_UX.md`):
2 GB-RAM Android Go target, initial JS ≤ 75 kB gzip (construction pages are lazy chunks like
every route today), touch targets ≥ 48 px / primary actions ≥ 56 px, Ethiopic body ≥ 16 px,
one verb = one screen = one confirm, lookup-first pickers, honest offline status only.

**Site worker mode (Site Engineer/Foreman/Site Storekeeper) — a ≤5-destination bottom nav:**

| Destination | Content | Typing budget |
|---|---|---|
| Today (diary) | Pre-filled from yesterday; steppers (+/−) for headcounts and hours, not keyboards; camera button per section | Numbers + short notes only |
| Receive | MR-expected deliveries listed → tap → confirm/adjust qty → photo → done (mirrors the proven O2 receiving flow) | Adjust-qty only |
| Request (MR) | Item lookup-first (search-as-you-type, scan-ready input shape), qty stepper, needed-by date picker | Minimal |
| Approvals | Only what this role can act on; approve/reject + comment; big buttons | One comment |
| Stock | Read-only site-store balances + my open advances | None |

- **Offline tolerance:** reads served from last-synced cache with an honest staleness
  banner; queued writes limited to the v1-safe set — diary draft, site receipt, MR draft,
  photos — following the O2 decision (server stays final authority, no last-write-wins, no
  silent merges, no fake sync status). Approvals and postings of value documents (IPC, SPC,
  VO) are **online-only** in v1: they are money documents and the honest-status rule
  forbids pretending they posted.
- **Photos** compress client-side to the data budget (worker-shift transfer target
  < 2 MB — baseline doc) and upload lazily when on Wi-Fi/signal, with per-photo queued/sent
  status.
- **Financial masking on site:** BOQ rates, certificate values and budgets are server-masked
  for site roles without `view_financial` — a foreman sees quantities, never contract money.

## 6. Project dashboards and reports

All figures derive from the ledgers/documents — nothing hand-entered into a dashboard.

**Per-project dashboard (PM / Owner):**
- **Budget vs actual per cost code** (MAT/LAB/SUB/EQP/EXP): budget, committed (open POs +
  open subcontract balance — needs M2 commitments), actual to date, variance, % consumed.
- **Progress vs billing:** contract sum + approved VOs, measured value to date, certified
  to date, retention held by client, unbilled measured work, work-at-risk (unapproved VO
  value).
- **Cash position of the project:** invoiced, collected, receivable aging, retention
  receivable; advances outstanding on site.
- **Material story:** top 10 items issued vs received per site store; fuel consumed per
  equipment/generator; site-store balance value `[masked per role]`.
- **Exceptions:** missing diaries, MRs pending > N days, approvals outstanding (by
  approver), certified-vs-claimed gaps, negative-margin cost codes.

**Company dashboard (Owner/Director):** portfolio table (project, % measured, budget
variance, receivable, retention, open approvals), cash across projects, subcontractor
exposure (certified-unpaid + retention held), equipment utilization (logged hours / days
on site).

**Reports (extending the existing 9-report + export pattern):** project cost ledger
(filterable by cost code/period), site material register (received/issued/balance), MR
register, certificate registers (IPC and SPC, with retention/advance columns), VO register,
advance/retirement register, fuel log, labor cost summary by category, diary archive
(printable — clients and consultants ask for it).

## 7. Roles and experiences

Extends the existing versioned role matrix; module set below is the construction template's
module vocabulary for (module, action) permissions. Separation-of-duties defaults follow
the Mesob-proven pattern (requester ≠ approver ≠ payer).

| Role | Primary surface | Sees | Cannot |
|---|---|---|---|
| Owner / Director | Desktop + phone dashboard | Everything incl. money; approval queue for top bands | Post operational documents (by default config — can self-enable; self-approval always blocked) |
| Project Manager | Desktop + phone | Their projects: budgets, measurement, IPC/SPC/VO drafting, MR approvals band 1, diaries review | Pay money; approve own requests; edit posted documents |
| Site Engineer / Foreman | **Phone worker mode** | Diary, MR, receipts, own advances, site stock quantities | Any money figures (masked); approvals above policy; deleting anything |
| Site Storekeeper | Phone worker mode | Receive, issue, site balances, counts | Rates/values (masked); transfers out without document |
| Procurement | Desktop | MR queue, POs, suppliers, price history (M2) | Approving own POs; receiving |
| Finance | Desktop | Payments in/out, advances/retirements, certificates payable/receivable, retention ledgers, all money reports | Measurement entry; MR/PO creation |
| Quantity Surveyor (optional role, often = PM in SMEs) | Desktop | BOQ, measurement, claims, VOs | Payments |

## 8. Capability activation map

Template activation config (the declarative-template artifact the roadmap's risk #2
demands) — REQ = required for the template to function, REC = recommended default-on,
OPT = optional toggle:

| Capability | Level | Depends on |
|---|---|---|
| Projects dimension + cost codes | REQ | NEW core (§11.1) |
| Warehouses as site stores + transfers + receiving + ledger | REQ | DONE |
| Parties (client/supplier/subcontractor) | REQ | DONE + M2 supplier UI |
| Approvals engine | REQ | NEW core (§11.2) |
| Purchasing + cost capture | REQ | **M2 — gating dependency** |
| Payments incl. outgoing/payables | REQ | DONE + M2 payables direction |
| BOQ + measurement + IPC | REQ | NEW template |
| Variation orders | REQ (trivial projects: unused, not disabled) | BOQ |
| Subcontracts + SPC | REC | Approvals, payables |
| Site diary + labor block | REC | Projects |
| MR workflow | REC (small tenants may transfer directly) | Approvals |
| Advances/expenses | REC | Approvals |
| Equipment register + usage/fuel logs | OPT | Projects |
| Attachments/photos | REC | T5 activation |
| Offline site capture (diary/receipt/MR) | OPT v1 → REC | O2 queue extension |
| Stock counts/adjustments on site stores | REC | M4 |
| Production/QC/BOM modules | OFF | — (core-vs-config toggle, as with trade) |
| Retention & advance math on certificates | REQ | `[config]` percentages only — no hardcoded rates |

## 9. Explicitly OUT of v1

- **Full BOQ→cost-code quantity take-off costing** (resource norms per BOQ item). v1
  budgets by cost code; norms-based material variance ("cement consumed vs norm for m³
  cast") is v2 — it needs BOM-class machinery (M3) and clean site data first.
- **Scheduling / Gantt / critical path.** Cost and cash truth first; scheduling is a
  different product muscle and the research shows no evidence SME contractors buy it.
- **Statutory payroll** for site labor (M5 platform domain). v1 records labor cost, not
  payslips/deductions.
- **Full asset management** (depreciation, maintenance plans) — M5 design-first domain;
  v1 keeps register + logs only.
- **Tender/estimation module** (pre-contract bidding). v1 starts at contract award.
- **Client portal / consultant e-certification.** Paper + print + status fields.
- **Multi-node offline sites** (site server syncing to HQ). v1 = one tenant DB, phones as
  clients with bounded offline queues; the deferred sync architecture remains the gate for
  remote-site depth (consistent with priority report §5.3).
- **General ledger / double-entry.** The platform-wide no-GL ceiling stands; construction
  v1 produces cost/receivable/payable truth, and the accountant-export question stays open
  (§12 Q6).
- **Labor-only subcontractor tenants** (crew management as its own template).

## 10. Africa-specific realities this design must survive

Grounded in `AFRICA_BUSINESS_OS_REQUIREMENTS.md` (§0, §1, §5) and the priority report:

1. **Cash advances are the operating system of a site.** Formal PO-to-invoice flows coexist
   with a foreman holding cash. Hence advances/retirements are first-class documents with
   photos, not an accounting afterthought (§2.11, §4.6).
2. **Informal daily labor** paid cash daily/weekly, hired at the gate, organized by gang
   leaders — no contracts, no IDs sometimes. Hence headcount-by-category muster in the
   diary, not named-employee payroll (§2.8).
3. **Fuel and generators.** Sites self-generate power; fuel is bought in jerrycans and is
   a prime theft target. Fuel = stock item + per-equipment log (§2.7); generator hours in
   the diary.
4. **Materials leakage and price volatility.** Cement/rebar prices move weekly (requirements
   §5.6); theft evidence is endemic (§1.3). Counters: append-only site ledgers, received-vs-
   issued variance, M4 counts on site stores, M2 cost capture for replacement-cost awareness.
5. **Mobile money + bank + cash mixed on one project.** telebirr references on payments are
   already required platform behavior; certificates settle across rails with explicit
   allocation.
6. **Connectivity at sites is worse than shops.** Priority report marks construction offline
   need "extreme". v1's honest answer: bounded offline capture for the three site rituals
   (diary, receipt, MR), online-only money documents, no fake sync (§5).
7. **Consultant-driven certification culture.** The consultant/engineer certifies; JENIFY
   records claimed vs certified and never pretends to be the certifier (§4.5).
8. **Statutory environment `[VERIFY-LOCAL]`:** VAT on construction services, withholding on
   payments to subcontractors/suppliers, retention customs, advance-guarantee practice,
   contractor grade rules — all are country-pack configuration; Ethiopia e-invoicing
   remains VERIFY-FIRST per the 2026-08-22 decision. No compliance claims from this
   document.
9. **Trust and permanence.** A contractor's BOQ, certificates and retention ledger are
   multi-year assets; local-first storage + full export + printed fallbacks (existing
   platform posture) are selling points here, post-Kippa.

## 11. Platform contract demands (the asks — addressed to jenify-architect / jenify-core-engineer)

These are the shared contracts that must stabilize before this template is buildable. All
are sector-neutral; construction is merely their most demanding customer.

1. **Project/cost-center dimension (core).** An optional, indexed `(projectId, costCode)`
   attribution on value-bearing records: stock issues, goods receipts, transfers, POs,
   payments, expenses, invoices. Must be additive (nullable columns / side table — additive-
   only migration rule), enforced per-tenant-config, and reportable across modules. This is
   the single biggest architectural demand: it touches the ledger's write paths, so it must
   be designed once, centrally — retail branches, agriculture seasons and NGO grants are the
   same dimension wearing different names.
2. **Generic approvals primitive (core).** Threshold-banded, versioned-policy, append-only
   approval requests bound to any document type, enforced server-side at posting (§2.10).
   Trade needs it (credit/price overrides) before construction does.
3. **Payables direction in M2.** Supplier/subcontractor payments and outgoing allocation
   must be a symmetric extension of the existing payments engine, not a construction fork.
4. **Attachments activation (T5)** with size budgets and role-scoped access.
5. **Offline queue extension points (O2).** The receiving-first queue architecture should
   accept new queueable document types by declaration (diary, MR), keeping the honest-status
   contract.
6. **Declarative template artifact.** Construction must ship as the second (or third)
   declarative sector template — module toggles + role pack + terminology pack + document
   types + approval policies — never as `apply-construction.ts` scripts (roadmap risk #2).
7. **Measurement-document pattern.** IPC/SPC "cumulative measured minus previously
   certified" is a reusable certified-progress document shape; design it so agriculture
   (grading-based receiving) and future service billing can reuse the snapshot discipline.

## 12. Open Founder questions

1. **Pilot tenant.** Do we have a real SME contractor (ideally in the Mesob network) willing
   to pilot? Per standing rule, no construction build starts without one — which contractor,
   which project size, which grade?
2. **Sequencing vs trade.** Construction is rank 12; its REQ dependencies (M2 procurement/
   costing, approvals, projects dimension) are all things ranks 1–4 want anyway. Confirm:
   we build those as core milestones on trade's schedule, and construction waits — correct?
3. **Site money on phones.** May a Site Engineer *request* advances and see *their own*
   advance balance on the phone while all other money stays masked — or is site-side money
   visibility zero? (Determines the worker-mode payload contract.)
4. **Retention/advance defaults for Ethiopia.** Which retention %, cap, advance % and
   recovery schedule do we ship as the Ethiopian country-pack *defaults*? Needs a local QS/
   contract review — we will not fabricate them.
5. **Withholding tax on subcontractor/supplier payments** `[VERIFY-LOCAL]`: in scope for
   the construction v1 country pack (as a certificate deduction line), or deferred with a
   manual field?
6. **Accountant boundary.** Construction sharpens the no-GL question (priority report §5.4):
   is the answer a structured export pack for external accountants, or does a light finance
   layer ever enter the roadmap? Direction wanted before certificate/retention reporting is
   finalized.
7. **Equipment rates.** Internal hourly/daily equipment costing rates are fabricatable
   numbers — do we ship the register with blank rates and force tenant entry (my
   recommendation, consistent with Principle 4), or provide a worked example pack?
8. **Diary as legal record.** Ethiopian practice may require specific site-diary formats on
   government contracts `[VERIFY-LOCAL]` — do we target the government-works format in v1
   print templates, or private works only (recommended: private first; government formats
   are a country-pack print template later)?

---

*Change log: 2026-08-22 — initial blueprint (jenify-template-engineer, design-only, Wave 1
Design track). No code or migrations authorized from this document.*
