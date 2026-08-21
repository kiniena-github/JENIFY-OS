# JENIFY MIGRATION INTELLIGENCE REPORT

**Workstream:** R6 — Data / Migration (research program)
**Agent:** jenify-data-migration, operating under jenify-product-research rules
**Date:** 2026-08-21 · **Status:** RESEARCH ONLY — no code changed, no schema changed
**Question studied:** How do African businesses actually keep their records today, what do
existing migration/import tools get right and wrong, and what is the exceptional JENIFY
migration pipeline (spec, not code) — including opening balances — with an MVP cut?

Confidence labels used throughout: **[High]** multiple/official sources, **[Med]** single
source or forum evidence, **[Low]** weak or contested, **[Inference]** our reasoning, labeled.

---

## 0. What JENIFY has today (repo ground truth — verified by reading the code)

There is **no import capability at all** in the current codebase. Verified:

- The only CSV feature is **export** (`packages/web/src/pages/ReportsPage.tsx`,
  `exportCsv()` ~line 450). No upload endpoint, no parser, no staging tables.
- All stock writes flow through the audited append-only ledger:
  `postMovement()` in `packages/server/src/services/inventory.ts` (has an
  `allowNegative` flag documented as "never used by normal operations"). Balances derive
  from movements; `recomputeBalances()` exists as a consistency check.
- The intended home for opening balances is already reserved in a comment:
  `packages/server/src/services/provisioning.ts` lines 129–130 — *"Real-world opening
  stock/receivables at go-live should enter through proper opening documents later — never
  as fabricated"* historical transactions. `docs/JENIFY_DECISIONS.md` (2026-08-19,
  "Go-live from explicit approved configuration only") makes this a Founder decision.
- The audited service surface an importer must call (never raw inserts):
  `createParty/updateParty` (parties.ts), `createItem/createUom/toBaseQty/createWarehouse`
  (masterdata.ts), `createLot` + `postMovement` (inventory.ts), `createInvoice/confirmInvoice/
  customerOutstanding` (sales.ts), `createPayment/postPayment/applyAllocations` (payments.ts),
  `defineSequence/nextDocNumber` (numbering.ts), `writeAudit` (audit.ts), `inTx` (context.ts).
- Platform physics an importer must respect: quantities are **integer milli base-units**,
  money is **integer cents** in tenant default currency, ids are UUIDv7, tenant isolation is
  per-query discipline (roadmap risk #1 — every staging structure must carry `tenant_id`).

So this report proposes a genuinely new capability, aligned with existing services — it does
not duplicate anything that exists.

---

## 1. How African businesses actually run today

### 1.1 Media of record

| Medium | Evidence | Confidence |
|---|---|---|
| **Paper**: exercise books, counter books, receipt booklets, memory | Studies of Ugandan (Kawempe) and Ghanaian (Cape Coast, Sissala West) SMEs: many businesses rely on memory or rudimentary notebooks; most keep no complete written records even though ~74% say bookkeeping matters ([Cape Coast study](https://www.academia.edu/40304129/Bookkeeping_and_Perception_of_Growth_of_Small_and_Medium_Scale_Enterprises_in_the_Cape_Coast_Metropolis), [Sissala West](https://journals.e-palli.com/home/index.php/ajebi/article/view/1520)) | High (pattern), Med (any single %) |
| **Excel / Google Sheets** | One SME survey: 44.4% manual records, 36.4% Excel, 19.2% software ([ResearchGate table](https://www.researchgate.net/figure/Types-of-accounting-records-kept-by-SMEs_tbl3_366590486)) | Med (single study; direction consistent across studies) |
| **Accounting packages** | QuickBooks, Sage, and Tally are the common formal tier; TallyPrime is actively marketed to African SMBs and is embedded in Kenya's eTIMS tax compliance ([Tally SSA](https://tallysolutions.com/ssa/), [ERPNext-in-Kenya migration guide](https://itkenya.com/migrate-quickbooks-tally-to-erpnext-kenya/)) | High |
| **Digital khata/ledger apps** | Khatabook/OkCredit model (India) cloned into Africa — Kippa (Nigeria) reached ~500,000 businesses tracking debtors, inventory, invoices ([TechCabal](https://techcabal.com/2024/02/23/kippa-users-left-in-the-dark/)) | High |
| **Legacy/local ERP** | Present in larger firms; not the JENIFY entry segment | Inference |

The often-quoted "60% of small businesses fail within 3 years due to poor record-keeping"
claim circulates in this literature — treat as **[Low]**, causality unproven.

**The Kippa lesson (strategic):** when Kippa pivoted in 2024, its app went dark and ~500k
merchants lost access to their debtors, inventory, and transaction data
([TechCabal](https://techcabal.com/2024/02/23/kippa-users-left-in-the-dark/),
[layoffs](https://techcabal.com/2023/10/19/exclusive-kippa-lays-off-40-employees-as-it-shelves-kippa-pay/)) **[High]**.
African SMEs have been burned. JENIFY's migration story must therefore be symmetric:
**easy in AND easy out** (full export already partially exists). Local-first is itself the
trust answer — the customer's data lives on the customer's machine. Say this out loud in
onboarding material. **[Inference]**

### 1.2 What the data actually looks like (the enemy we are designing for)

From the studies above, the migration guides for Tally/QuickBooks in Africa, and Ethiopian
computing specifics:

1. **No consistent IDs.** Customers are "Ato Gebre (shop near bus station)". Identity is a
   name + a phone number + human memory. Phone numbers are the closest thing to a key.
   **[High — pattern across khata apps, whose core key is the phone contact]**
2. **Messy sheet structure.** Title rows and logos above the real header; merged cells for
   group labels; totals rows mid-sheet and at the bottom; multiple tables per sheet; one
   sheet per month/warehouse with slightly different columns. Microsoft's TableSense
   research shows even ML-based table boundary detection reaches only ~91% recall / 86.5%
   precision ([TableSense, AAAI'19](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/TableSense_AAAI19.pdf)) —
   i.e., **fully automatic structure detection is not a solved problem; a human confirm
   step is mandatory.** **[High]**
3. **Mixed languages in one file.** English headers with Amharic/Tigrinya values, or vice
   versa; transliteration variants of the same name ("Haile"/"Hailay"/"ኃይሌ"). **[Inference,
   grounded in Mesob's own bilingual UI requirement]**
4. **Ethiopian encoding trap.** Documents typed in pre-Unicode Ge'ez fonts (Power Ge'ez,
   Visual Ge'ez…) store **ASCII codepoints rendered as Ethiopic by the font** — the file
   content is gibberish Latin unless converted (11+ legacy encodings exist; see
   [geezorg/DocxConverter](https://github.com/geezorg/DocxConverter/blob/master/README.md),
   [SIL converters](https://software.sil.org/abyssinica/resources/)) **[High]**. Charset
   sniffing cannot detect this — it looks like valid Latin text. Needs a heuristic warning
   (Amharic-enabled tenant + implausible Latin letter frequencies) plus a manual "this was
   typed in a legacy Ge'ez font" flag. **[Inference]**
5. **Ethiopian calendar.** Source books dated in E.C. (2016 E.C. ≈ 2023/24 G.C., 13 months,
   New Year in September). Date columns must ask "which calendar?" — never guess.
   **[High as fact; Inference as requirement]**
6. **Informal credit ledgers.** The debt book is per-person, running-balance style
   ("Abebe: +500, -200, rest 300"), often without dates or invoice granularity. Only the
   **current outstanding balance per person** is reliable. **[High — this is exactly the
   khata-app data model]**
7. **Mixed units and packed quantities.** "50kg bag", "25 bags × 50kg", quintals, "ኩንታል";
   money as "1,200.50 Br", "ETB 1200", parentheses for negatives, thousand-separator
   ambiguity (1.200,50 vs 1,200.50). **[High — universal spreadsheet pathology]**
8. **Merged/duplicated people.** The same customer appears under three spellings across
   monthly sheets; suppliers double as customers. **[High — pattern]**

Design consequence: the pipeline must treat **the source as testimony, not truth** — surface
ambiguity, never silently "fix" (migration-agent rule 4).

---

## 2. Migration & import experiences worth learning from — and their failures

### 2.1 ERPNext Data Import

What it is: template-download → fill → upload → background job. Documented failures:
imports stuck "In progress"/"Not Started" with no error shown
([forum](https://discuss.frappe.io/t/erpnext-data-import-failed/81623),
[GH #40811](https://github.com/frappe/erpnext/issues/40811)); "Cannot match column" even
after manual mapping ([forum](https://discuss.frappe.io/t/error-when-importing-cannot-match-column/87955));
child-table fields not recognized ([GH #34997](https://github.com/frappe/erpnext/issues/34997));
large files (30k rows) dying midway (~7k in) with a background-job error
([forum](https://discuss.frappe.io/t/data-import-error-where-to-begin-debugging/139152));
regressions between minor versions. **[High — many independent reports]**

**Lessons:** (a) never dead-end — every failure must be visible, row-level, and explained;
(b) map from **their** file, don't force them into your template (offer the template as a
fallback, not the front door); (c) an import that half-ran without a clear record of what
committed is the worst outcome — run identity + reconciliation are non-negotiable.

### 2.2 Odoo import

What it is: in-app CSV/XLSX import with field mapping and **External IDs** for relations.
Relational (`many2one`) lookups resolve at import time — missing reference rows fail; users
must import reference data in dependency order and hand-manage `XXX/External ID` columns;
the import commits in a single transaction, so one bad row can sink the whole file
([Odoo docs](https://www.odoo.com/documentation/19.0/applications/essentials/export_import_data.html),
[guide](https://deploymonkey.com/blog/odoo-data-import-export-guide)). **[High]**

**Lessons:** (a) never make the *user* manage foreign keys — JENIFY resolves references
in-app ("'Adigrat store' isn't a warehouse yet — create it / pick one"); (b) all-or-nothing
must be a *visible choice at approval time* ("import 143 clean rows, hold 7 flagged rows"),
not a silent property of the transaction; (c) dependency ordering is the system's job.

### 2.3 QuickBooks Desktop → Online conversion

Documented pain: hard record limits (≈750k "targets" practical ceiling), a **60-day
migration window** after subscribing, silent field drops ("blank fields where Desktop data
doesn't match Online's structure"), categories with no equivalent must be manually
reassigned first, and the professional guidance that **trial-balance parity is the only
reliable success proof**
([Breakwater guide](https://www.breakwatercorp.com/quickbooks-desktop-to-online-migration/),
[CMP](https://blog.cmp.cpa/quickbooks-desktop-to-quickbooks-online),
[Intuit](https://quickbooks.intuit.com/learn-support/en-ca/help-article/import-export-files/migrating-quickbooks-desktop-quickbooks-online/L47H2Uugp_CA_en_CA)). **[High]**

**Lessons:** (a) publish an explicit "what does NOT migrate" list per import type —
honesty beats silent drops; (b) no arbitrary time windows; (c) the reconciliation report
(source totals vs system totals) is the deliverable of a migration, not a nice-to-have.

### 2.4 Xero conversion balances — the pattern to adopt

Xero formalizes go-live as a **conversion date** plus **conversion balances**: the state of
the business on that day. Critically, AR and AP are entered as *open invoices/bills* so that
later payments can allocate against them normally
([Xero Central](https://central.xero.com/s/article/Enter-conversion-balances-US),
[setup guide](https://outbooks.co.uk/training-and-support/bookkeeping-vat-return/conversion-balance-in-xero/)). **[High]**

**Lesson:** this is exactly the JENIFY decision ("real opening balances via proper opening
documents") made concrete: opening state is a **first-class document type dated at
cutover**, not fabricated history — and opening receivables must be *allocatable* documents
so `applyAllocations` works on day one.

### 2.5 Airtable / Notion CSV mapping UX

Airtable's CSV extension auto-detects header rows, auto-matches same-named columns, and
**remembers your field mappings for the next import**
([Airtable support](https://support.airtable.com/docs/csv-import-extension)) — though users
report the remembering being flaky ([community thread](https://community.airtable.com/other-questions-13/csv-import-field-mapping-not-sticking-14823)).
Notion requires property types set before import; CSV round-trips lose **linked records**
(relations) entirely ([XRAY](https://www.xray.tech/post/migrating-notion-airtable-linked-records)). **[High]**

**Lessons:** (a) remembered per-tenant mapping templates are cheap and beloved — monthly
re-imports must be one click; (b) relations die in flat files — resolving them is where
JENIFY must be better, in-app.

### 2.6 Flatfile / OneSchema / Dromo (the modern importer products)

State of the art: fuzzy header matching (Levenshtein/Jaro-Winkler/synonym dictionaries,
claimed ~95% auto-match), AI-suggested mappings trained on historical uploads, **in-grid
row-level error fixing with live revalidation**, and stored mapping configurations replayed
so repeat imports get faster
([Flatfile](https://flatfile.com/platform/portal/),
[OneSchema](https://www.oneschema.co/blog/building-a-csv-uploader),
[Dromo best practices](https://dromo.io/blog/data-mapping-best-practices-csv-imports)). **[High]**

**Lesson (smallest version that captures the value):** JENIFY needs no ML and no external
service (LOCAL principle): a **multilingual synonym dictionary (en/am/ti) + normalized
Levenshtein + per-tenant remembered templates** gets most of the benefit at near-zero
complexity. The in-grid "fix it here, revalidate" loop is the single highest-value UX idea
to copy.

### 2.7 Tally (source-system intelligence)

Tally exports masters and vouchers as XML (most complete) or Excel; migrations to ERPNext
map its group-based ledger hierarchy with manual review
([TallyHelp](https://help.tallysolutions.com/article/Tally.ERP9/Data_Management/import-data.htm),
[Kenya guide](https://itkenya.com/migrate-quickbooks-tally-to-erpnext-kenya/)). **[High]**
For JENIFY MVP, Tally matters only as: *"export your ledgers/stock items to Excel, then use
the normal JENIFY import"* — a per-source cheat-sheet, not a connector. **[Inference]**

---

## 3. The JENIFY migration pipeline — design spec (research, not code)

Principles inherited: preview-before-commit always; audited services only; idempotent runs;
never silently fix; tenant-isolated staging; test tenants only (never live Mesob data).
Everything below is a spec for a future milestone — nothing here is built.

### Stage 0 — Upload
- Accept `.xlsx`, `.csv`, `.tsv` (and `.xls` if the chosen parser supports it); detect file
  type by content, not extension. Parse **locally in-process** — no cloud parsing (LOCAL,
  and Founder rule 7). Note: SheetJS Community Edition is Apache-2.0 — license-safe. [Med]
- Compute a **content hash** on upload. `(tenant_id, file_hash, mapping_version)` becomes
  the **import run identity** — the anchor for idempotency, reconciliation, and rollback.
- Encoding: honor BOM; sniff UTF-8 vs cp1252; if the tenant has Ethiopic languages enabled
  and text shows implausible Latin frequencies, warn: *"This may be a legacy Ge'ez font
  file — convert it first"* (link to converter guidance; §1.2.4). Never auto-convert.

### Stage 1 — Detect (structure)
- Per sheet: find the real header row (skip title/logo/blank rows); un-merge merged cells
  by propagating the value across the span **only for header/group rows**, flagging data-row
  merges for review; drop fully-empty rows/columns.
- **Totals rows are treasure, not noise:** detect "TOTAL/ድምር"-style rows, exclude them from
  data, and **capture them as the source control totals** that Stage 9 reconciles against.
- Multi-table sheets and month-per-sheet workbooks: treat each detected table as its own
  import candidate; same mapping template can be applied across sheets.
- Because detection tops out well below 100% even with ML (TableSense, §1.2.2), every
  detection is a **pre-filled suggestion the human confirms** ("Your data starts at row 4
  with these headers — correct?"), with manual override (click the real header row).

### Stage 2 — Classify (what entity is this sheet?)
- Score each detected table against target entities — **customers, suppliers, items,
  opening stock, opening receivables** — using: header synonyms (multilingual dictionary:
  "ስም/name/customer", "ስልክ/phone", "ዕቃ/item", "ብዛት/qty", "ቀሪ/balance/outstanding"…), value
  shapes (phone-like, money-like, qty-like columns), and sheet name.
- Show the guess with confidence and let the human confirm or change it. Never silent.

### Stage 3 — Map columns (assisted, remembered)
- Two-panel mapping: their columns ⇄ JENIFY fields; auto-suggest via synonyms + fuzzy
  match; unmapped source columns can be kept as a note/attribute or ignored — visibly.
- Required-field enforcement per entity (e.g., item needs name + unit; opening stock needs
  item + qty + warehouse). Support **constant fills** ("all rows → warehouse: Main Store"),
  simple **combine/split** (name+phone in one cell), and **unit mapping** into UoMs via
  `toBaseQty` (create missing UoMs through `createUom`, with confirmation).
- Persist the finished mapping as a **named per-tenant template**; next month's file
  auto-applies it (Airtable/OneSchema lesson, done reliably).

### Stage 4 — Clean (normalize, transparently)
- Deterministic, explainable transforms only; every changed cell shows original → cleaned:
  trim/collapse whitespace; Unicode NFC; phone → E.164 with tenant default country (+251);
  money → integer cents with explicit thousand/decimal-separator choice when ambiguous;
  qty+unit parsing ("25 bags × 50kg") → integer milli base-units; "(500)" → −500.
- **Dates ask, never guess:** DD/MM vs MM/DD chosen once per file when ambiguous; and a
  first-class **"Ethiopian or Gregorian calendar?"** prompt when years look like E.C.
  (§1.2.5). This is a differentiator no Western importer has. **[Inference]**

### Stage 5 — Find duplicates
- Within-file and against-DB. Parties: normalized name + phone (phone match is a strong
  signal — it is the informal sector's primary key, §1.2.1); items: normalized name + unit.
- Three bands: exact → auto-flag "already exists, will skip/update"; fuzzy → **human
  decides** (merge / keep both / skip) with both records shown; distinct → create.
  **Never auto-merge** (rule 4). Decisions are stored on the staging rows and audited.

### Stage 6 — Validate (row-level, fixable)
- Every row gets a status: `ready | warning | error | duplicate | excluded`, with
  per-cell messages in plain language ("Phone has 8 digits — Ethiopian mobiles have 9").
- **Fix in place:** edit the cell in the preview grid → instant revalidation (the
  Flatfile/OneSchema loop, §2.6). No fix-in-Excel-and-reupload round trips required —
  though re-upload of a corrected file into the same run must also work.

### Stage 7 — Preview totals (the approval gate)
- One screen: N create / N update / N skip / N held (errors), plus **control totals** —
  total qty per item, total outstanding per customer, row counts — side by side with the
  source totals captured in Stage 1. Discrepancies highlighted before anything commits.
- Human explicitly chooses: "import all clean rows, hold the 7 flagged" (visible partial —
  the anti-Odoo, §2.2) or "fix everything first". Approval is an audited action.
  **Nothing touches the ledger before this approval** (rule 1).

### Stage 8 — Import (through audited APIs only)
- Executed inside `inTx` batches, calling only existing services (`createParty`,
  `createItem`, opening-document services of §4, …) — numbering via `nextDocNumber`,
  audit via the services' own `writeAudit` paths. **No direct DB inserts, ever** (rule 2).
- Provenance: staging row → created entity id is recorded in the run's staging tables
  (no core-schema pollution needed); every audit entry carries the `import_run_id`.
- **Idempotency:** re-running the same run key skips rows already linked to created
  entities; a re-uploaded identical file resolves to the same run and cannot duplicate
  (rule 3). Held rows can be fixed and imported later *into the same logical run*.

### Stage 9 — Reconcile against source
- Auto-generated reconciliation report per run: source control totals vs post-import
  system state — on-hand per item/warehouse (stock balances + `recomputeBalances` spot
  check), outstanding per customer (`customerOutstanding`), entity counts. Discrepancies
  listed row-referenced. Founder/operator signs off; the sign-off is audited.
  (QuickBooks lesson: parity *is* the proof of migration, §2.3.)

### Stage 10 — Rollback / correct as a unit
- Because every write was a proper document, rollback = reverse/cancel each created
  document in reverse dependency order + archive created master data, driven by the run's
  provenance links. Consistent with immutability: **reversal, not deletion**
  (JENIFY_DECISIONS 2026-08-17).
- If imported master data has since been used by other documents, full rollback is blocked
  for those records and the run reports exactly what was and wasn't rolled back.

### Paper-first businesses (the majority, §1.1)
No OCR in MVP. The pragmatic path: a **JENIFY-provided pre-mapped Excel/ODS template** per
entity (localized headers, dropdown units/warehouses) that the business types its books
into once — that file then flows through the same pipeline with a built-in mapping
template. Photograph-the-ledger-page OCR is a natural **JENIFY AI / QOS** capability later
(future-planned per JENIFY_DECISIONS 2026-08-21) — the pipeline's staging + preview + audit
stages are exactly the safety harness an AI extractor would need, so nothing designed here
is throwaway. **[Inference]**

---

## 4. Opening balances — the specific design

Constraints already decided (JENIFY_DECISIONS 2026-08-19; provisioning.ts comment): fresh
production tenants start clean; **real opening state enters via proper opening documents;
fabricated history is forbidden.** Xero's conversion-balance pattern (§2.4) is the model.

**Opening Stock Document** (new document type, spec):
- One per warehouse (or one per import run per warehouse); lines: item, optional lot
  (`createLot`), qty in integer milli base-units, optional unit cost (cents) for future
  valuation. Posting date = the tenant's **cutover date**, chosen once and displayed
  everywhere the opening data appears.
- Posts `OPENING_STOCK` movements through `postMovement` with
  `documentKind: 'opening_stock'` — append-only, numbered via `nextDocNumber`, reversible
  as a document (negative movements), exactly like receipts' reverse pattern.
- Declares **state, not history**: no fake purchase receipts to "explain" the stock.
- QC nuance for Mesob-like tenants: pre-existing finished iodized stock has no QC record.
  The opening line should carry an explicit release status — default **"opening — untested,
  released by owner declaration"** (audited), with the option to attach real test data.
  Iodine stays a batch/lot attribute, not inventory (decision 2026-08-17). **[Open question
  for the QC roles — see §6]**

**Opening Receivables** (spec):
- One **opening invoice** per customer (informal debt books only support a reliable current
  balance, §1.2.6) — or per open invoice where the source system has that granularity
  (Tally/QuickBooks exports do).
- `documentKind: 'opening_invoice'`, no stock lines, posted at cutover; fully
  **allocatable** so `applyAllocations` works on day one (the Xero insight). The original
  informal date/reference is stored as descriptive fields *on* the opening document (usable
  by aging views) — honest: posted at cutover, describing a pre-existing balance.
- Negative balances (customer prepayments) become opening credit/advance documents — not
  negative invoices. **[Inference; needs commercial-domain review]**

**Opening Payables:** JENIFY currently has no supplier-invoice/payables module (verified:
credit views are customer-side) — opening payables are **out of scope until that module
exists**; record the gap, don't improvise.

---

## 5. What JENIFY should learn / avoid — ranked recommendations (value ÷ complexity)

1. **Opening documents (stock + receivables) as first-class, reversible document types** —
   unblocks every real go-live including Henok's clean tenant; small surface, reuses
   `postMovement`/invoice machinery. *Highest value, moderate complexity.*
2. **Import-run identity + staging + preview gate + reconciliation report** — the trust
   core; everything else hangs off it. *High value, moderate complexity.*
3. **Assisted mapping: multilingual synonym dictionary + fuzzy match + remembered
   per-tenant templates** — 80% of Flatfile's magic at ~5% of the complexity, no ML, fully
   local. *High value, low complexity.*
4. **In-grid row-level fix-and-revalidate** — the single best UX idea in the field. *High
   value, moderate frontend complexity.*
5. **Ethiopian-reality cleaning: E.C./G.C. calendar prompt, +251 phones, legacy Ge'ez
   warning, unit packs ("25×50kg")** — a genuine differentiator no global tool has. *High
   value, low complexity each.*
6. **Duplicate detection with human-decided fuzzy band (phone as strong key)** — prevents
   the classic triple-customer mess. *Medium-high value, medium complexity.*
7. **Pre-mapped localized entry templates for paper-first businesses** — covers the
   majority segment without OCR. *Medium value, very low complexity.*
8. **Per-source cheat-sheets (Tally/QuickBooks/Sage export steps)** — docs, not code.
   *Medium value, near-zero complexity.*
9. **Avoid:** background jobs that fail silently (ERPNext), user-managed external IDs and
   silent all-or-nothing transactions (Odoo), silent field drops and migration windows
   (QuickBooks), CSV-only relation handling (Notion), cloud-dependent importer services
   (violates LOCAL; and the Kippa trust lesson).

## 6. Open questions for the Team Lead / Founder

1. Cutover-date semantics: single tenant-level conversion date, or per-document dates
   allowed within a go-live window?
2. QC status of opening finished stock: is "released by owner declaration" acceptable to
   the Quality Management role model (separate roles decision, 2026-08-19)?
3. Opening receivables granularity for Mesob specifically: per-customer balance or
   per-invoice (does Henok's book have invoice-level detail)?
4. Should opening stock carry unit cost now (future valuation) or qty-only in MVP?
5. Mapping templates: per-tenant only, or promoted into sector templates (roadmap risk #2 —
   extract from real deployments)?
6. Where does the staging store live — same SQLite DB (tenant-scoped tables) or a separate
   per-run file? (OneDrive-sync corruption risk T2 argues for care here.)

---

## 7. Sources (external claims)

ERPNext: [forum: import failed](https://discuss.frappe.io/t/erpnext-data-import-failed/81623) · [forum: cannot match column](https://discuss.frappe.io/t/error-when-importing-cannot-match-column/87955) · [GH #34997](https://github.com/frappe/erpnext/issues/34997) · [GH #40811](https://github.com/frappe/erpnext/issues/40811) · [forum: debugging](https://discuss.frappe.io/t/data-import-error-where-to-begin-debugging/139152)
Odoo: [official import docs](https://www.odoo.com/documentation/19.0/applications/essentials/export_import_data.html) · [DeployMonkey guide](https://deploymonkey.com/blog/odoo-data-import-export-guide)
QuickBooks: [Intuit migration article](https://quickbooks.intuit.com/learn-support/en-ca/help-article/import-export-files/migrating-quickbooks-desktop-quickbooks-online/L47H2Uugp_CA_en_CA) · [Breakwater](https://www.breakwatercorp.com/quickbooks-desktop-to-online-migration/) · [CMP](https://blog.cmp.cpa/quickbooks-desktop-to-quickbooks-online)
Xero: [conversion balances](https://central.xero.com/s/article/Enter-conversion-balances-US) · [Outbooks setup guide](https://outbooks.co.uk/training-and-support/bookkeeping-vat-return/conversion-balance-in-xero/)
Airtable/Notion: [CSV import extension](https://support.airtable.com/docs/csv-import-extension) · [mapping not sticking](https://community.airtable.com/other-questions-13/csv-import-field-mapping-not-sticking-14823) · [linked-records loss](https://www.xray.tech/post/migrating-notion-airtable-linked-records)
Importer products: [Flatfile Portal](https://flatfile.com/platform/portal/) · [OneSchema](https://www.oneschema.co/blog/building-a-csv-uploader) · [Dromo](https://dromo.io/blog/data-mapping-best-practices-csv-imports)
African SME records: [record types table](https://www.researchgate.net/figure/Types-of-accounting-records-kept-by-SMEs_tbl3_366590486) · [Cape Coast](https://www.academia.edu/40304129/Bookkeeping_and_Perception_of_Growth_of_Small_and_Medium_Scale_Enterprises_in_the_Cape_Coast_Metropolis) · [Sissala West, Ghana](https://journals.e-palli.com/home/index.php/ajebi/article/view/1520)
Khata apps / Kippa: [TechCabal: users left in the dark](https://techcabal.com/2024/02/23/kippa-users-left-in-the-dark/) · [TechCabal: layoffs](https://techcabal.com/2023/10/19/exclusive-kippa-lays-off-40-employees-as-it-shelves-kippa-pay/) · [OkCredit](https://okcredit.com/)
Ethiopic encoding: [geezorg/DocxConverter](https://github.com/geezorg/DocxConverter/blob/master/README.md) · [SIL Abyssinica resources](https://software.sil.org/abyssinica/resources/) · [MS Q&A: Power Geez on Win11](https://learn.microsoft.com/en-us/answers/questions/5676907/my-power-geez-2010-font-stopped-running-on-my-wind)
Tally: [TallyHelp export/import](https://help.tallysolutions.com/article/Tally.ERP9/Data_Management/import-data.htm) · [Kenya migration guide](https://itkenya.com/migrate-quickbooks-tally-to-erpnext-kenya/) · [Tally SSA](https://tallysolutions.com/ssa/)
Structure detection: [TableSense (Microsoft, AAAI'19)](https://www.microsoft.com/en-us/research/wp-content/uploads/2019/01/TableSense_AAAI19.pdf)

---

## TEAM LEAD SUMMARY (10 lines)

1. African target customers run on paper first, Excel second, Tally/QuickBooks/Sage third; identity = name+phone, credit = running balances in a debt book — design for that, not for clean CSVs.
2. JENIFY has zero import capability today (CSV export only); opening balances are already Founder-decided to be "proper opening documents, never fabricated history" — this spec makes that concrete.
3. Competitor failures define our bar: ERPNext dead-ends silently, Odoo makes users manage foreign keys and all-or-nothing transactions, QuickBooks drops fields silently — JENIFY wins with visible row-level errors, in-app reference resolution, and an explicit "what won't migrate" list.
4. Xero's conversion-balance pattern is the one to adopt: cutover date + opening stock documents (OPENING_STOCK movements via postMovement) + per-customer opening invoices that payments can allocate against.
5. Pipeline spec: Upload → detect (header/totals rows, encoding) → classify → assisted mapping (multilingual synonyms + fuzzy + remembered templates) → clean (E.C./G.C. calendar prompt, +251 phones, unit packs) → duplicates (human-decided fuzzy band) → row-level fixable validation → preview totals → audited import → reconciliation vs source totals → rollback-as-a-unit via document reversal.
6. Every run has an identity (tenant + file hash + mapping version): idempotent re-runs, provenance links, auditable approval, reversible as a unit — all writes through existing audited services, never raw inserts.
7. Detected totals rows in the source sheet become the reconciliation anchor; the reconciliation report is the migration's proof-of-success artifact (the QuickBooks trial-balance lesson).
8. No ML, no cloud services needed: synonym dictionary + Levenshtein + remembered templates ≈ 80% of Flatfile's value, fully local; the staging/preview/audit harness later becomes the safety rail for AI-powered (OCR) migration under JENIFY AI/QOS.
9. Kippa's collapse stranded ~500k merchants' data — "easy in AND easy out, and it lives on your machine" is a marketable trust position, not just engineering hygiene.
10. **Recommended MVP cut: customers, suppliers, items (+UoM mapping), and opening inventory via Opening Stock Documents — plus per-tenant mapping templates and the reconciliation report. Next slice: opening receivables as allocatable opening invoices. Explicitly out: transaction history (forever, by decision), payables (no module yet), OCR (AI milestone), source-system connectors (cheat-sheet docs instead).**
