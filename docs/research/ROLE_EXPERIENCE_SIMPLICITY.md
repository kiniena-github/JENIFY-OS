# JENIFY OS — Role Experience & Simplicity Report

> Workstream **R5** of the JENIFY OS research program · 2026-08-21 · RESEARCH ONLY — no code changed.
> Authors: jenify-ux-engineer (role) operating under jenify-product-research rules.
> Grounded in: `packages/web/src` (17 pages, `Layout.tsx` nav, `ui.tsx` primitives), `packages/config-mesob/src/seed.ts` (8 live Mesob roles), `docs/FACTORY_OS_CURRENT_STATE.md` (defects D1–D13, missing-capability map), `docs/JENIFY_ROADMAP.md`.
> Evidence labels: **[Verified]** cited external source · **[Reported]** vendor/review claim, plausible but promotional · **[Inference]** our conclusion from the evidence.

---

## 1. The JENIFY Rule

> **FUNCTIONAL DEPTH MUST NOT EQUAL UI COMPLEXITY.**
> The platform may know everything; each person sees only their next action.
> Depth lives in the ledger, the permission matrix, and configuration — never in the number of menus, fields, or decisions a worker faces.

Corollaries (the working laws every JENIFY screen is judged by):

1. **One person, one job, one screen.** A role's most common task starts on the screen they land on — never behind navigation. (SAP's own Fiori "1-1-3" rule — one user, one use case, ≤3 screens — is the industry's admission that this is what ERP should have been. [Verified — see §2.7])
2. **Doing beats navigating.** Menus offer actions ("Receive truck", "Mark delivered"), not modules ("Inventory Management"). USSD research: successful menus "avoid navigating and focus on doing". [Verified — §2.2]
3. **The system fills in what it already knows.** Defaults from the customer, the item, the user's history, and yesterday's entry. A worker types only what only they know (the quantity, the truck number).
4. **Numbers and status carry the message; text is confirmation.** Semi-literate users reliably read numerals and colors even when they cannot read sentences — pair every color with a word, never color alone. [Verified — §2.2; matches existing `StatusBadge` practice]
5. **Complexity is a permission, not a default.** Price overrides, reversals, role matrices, settings — visible only to roles holding the action, and the danger must look dangerous (already true: `ReasonDialog`, disabled price fields).
6. **Simplicity is measured, not asserted.** Clicks, fields, seconds, and menu counts are tracked per release (§5). What is not counted regresses.

---

## 2. Evidence — what makes software operable by non-technical workers

### 2.1 POS systems (Square, Loyverse)

- Loyverse's checkout is two decisions: tap item(s) → choose payment method. Reviewers repeatedly report staff need minimal or **zero formal training**. [Reported — [Capterra reviews](https://www.capterra.com/p/150632/Loyverse-POS/reviews/), [FitSmallBusiness](https://fitsmallbusiness.com/loyverse-review/), [posusa.com](https://www.posusa.com/loyverse-pos-review/)]
- Square: uncluttered layout, one thing to focus on at a time, quick-service mode with **pre-set combo tiles** for the highest-frequency sales; role-based staff permissions are standard even in this "simple" product. [Reported — [Square](https://squareup.com/us/en/point-of-sale), [agentestudio POS design principles](https://agentestudio.com/blog/design-principles-pos-interface), [expertmarket review](https://www.expertmarket.com/pos/pos-review)]
- **Lesson [Inference]:** the POS bar is the JENIFY bar for worker roles: first unaided transaction within one hour, most-sold items reachable as tiles, payment recorded in the same flow as the sale (JENIFY already auto-records payment with a "paid" sale — `SalesPage.tsx:155-165` — keep and advertise this).

### 2.2 Mobile money (M-Pesa, Telebirr)

- M-Pesa's USSD flow serves ~40M customers on ~160-character screens: extreme character discipline, action verbs, numbered choices, and a **mandatory confirmation screen** (action + amount + recipient + cancel) before money moves. [Verified — [Arkesel USSD design guide](https://arkesel.com/ussd-menu-design-best-practices/), [CGAP smartphone/mobile-money design principles](https://www.cgap.org/sites/default/files/publications/slidedeck/principlesofsmartphonedesign05oct16-161005230428.pdf)]
- Field studies with non-literate and semi-literate users: technical terms fail **even when translated**; numbers and amounts are understood by almost everyone; receipts work because the numerals carry the meaning. [Verified — [Medhi et al., mobile-money UI comparison](https://www.researchgate.net/publication/221518457_A_comparison_of_mobile_money-transfer_UIs_for_non-literate_and_semi-literate_users), [Designing Mobile Interfaces for Novice and Low-Literacy Users](https://www.researchgate.net/publication/234829313_Designing_Mobile_Interfaces_for_Novice_and_Low-Literacy_Users)]
- Telebirr (the mobile-money app Mesob's staff most likely already use): praised for Amharic/Oromo/Tigrinya language support; criticized for cramped layout, small fonts, and growing super-app complexity; Ethiopian users prefer **spacious layouts and larger type**. [Reported — [UX review pt.1](https://biruksidea.medium.com/ethiotelecom-tele-birr-ui-ux-design-review-part-1-a877011fd5ee), [redesign critique](https://medium.com/@rounded_corners/redesigning-telebirr-for-a-better-user-experience-284107553244)]
- **Lesson [Inference]:** JENIFY's floor is "Telebirr-grade": if a worker can send money on their phone, they can post a JENIFY transaction. Keep vocabulary at market-language level via the existing `t()` layer (no "document lifecycle", "posting", "allocation" in worker-facing labels), and treat the confirm-before-post pattern as sacred for anything that moves stock or money.

### 2.3 Banking apps

- Modern banking home screens surface **balance + 3–5 quick actions**; anything done daily is one tap from home; flat navigation (1–2 taps to any core feature); card/tile UI instead of text link lists. [Reported — [merge.rocks fintech UX strategies](https://merge.rocks/blog/10-best-strategies-for-banking-app-ux-fintech-design-studio-guide), [UX Paradise banking patterns](https://medium.com/uxparadise/banking-app-design-10-great-patterns-and-examples-de761af4b216), [Lollypop banking UI](https://lollypop.design/blog/2026/june/banking-app-ui-design/)]
- **Lesson [Inference]:** the Owner's JENIFY is a banking app: today's position at a glance, drill-down on tap, zero data entry on the home path.

### 2.4 Warehouse scanner apps

- Practitioner guidance converges on: **one task per screen**, minimal decisions per screen (every extra choice raises decision fatigue and abandonment), oversized text/buttons, and letting a scan replace a tap wherever possible. [Reported/Verified mix — [Karabin, 7 UX best practices for warehouse mobile apps](https://medium.com/@stefan.karabin/7-ux-design-best-practices-for-warehouse-mobile-apps-b6e2a0a6940f), [envzone warehouse UI elements](https://envzone.com/essential-ui-elements-for-design-business-warehouse-management-app/)]
- **Lesson [Inference]:** JENIFY's warehouse/delivery screens should be lists of *things awaiting one action*, each with a single large primary button — not tables of records with small per-row button clusters. Barcode/scan input is a future accelerator (no scanner hardware at Mesob today), but the screen shape should anticipate it.

### 2.5 Factory terminals / industrial HMI

- ISA-101-derived practice: touch targets sized for gloves, vibration and viewing distance; generous spacing to prevent accidental activation; uncrowded screens so the important number is findable at a glance; consistent patterns to cut cognitive load. [Verified — [HMI design best practices / ISA-101](https://plcprogramming.io/blog/hmi-design-best-practices-complete-guide), [industrial touch display guidance](https://www.aptusdisplay.com/info-detail/how-to-design-an-industrial-touch-display-interface)]
- **Lesson [Inference]:** the Production stage panel (already close to a station screen: `ProductionPage.tsx` StagePanel with today's input/output/loss cards) should evolve toward a terminal profile: bigger targets, fewer per-row micro-buttons, one primary action per open batch.

### 2.6 Where ERP fails — the anti-patterns JENIFY must not repeat

- Academic usability studies of SAP S/4HANA and Oracle Cloud ERP find recurring problems: multistep task complexity, weak feedback (users clicking repeatedly with no effect), painful data entry, and navigation over long lists. [Verified — [MDPI 2022 ERP usability study](https://www.mdpi.com/2076-3417/12/5/2293), [ERP usability issues, user & expert perspectives](https://www.researchgate.net/publication/280217393_Erp_Usability_Issues_From_The_User_And_Expert_Perspectives)]
- Odoo/ERPNext (the open-source competitors closest to JENIFY's market): steep learning curve, overwhelming module/config surface, onboarding measured in **days** (reported 2–3 days Odoo, 5–7 days ERPNext to basic comfort). [Reported — [gloriumtech comparison](https://gloriumtech.com/odoo-vs-erpnext/), [cudio comparison](https://www.cudio.com/blog/erpnext-vs-odoo)]
- Important nuance from click-count research: users who complain about "too many clicks" are usually complaining about **not finding things / not knowing if it worked** — confident, well-fed-back clicks are cheap; uncertain ones are expensive. So click budgets (§5) matter, but feedback and findability matter more. [Verified — [UIE three-click-rule test](https://articles.centercentre.com/three_click_rule/)]
- **Lesson [Inference]:** JENIFY's competitive weapon is the onboarding delta: **minutes-to-first-transaction vs days-of-training.** That is a marketable, measurable number.

### 2.7 The industry's own confession: SAP Fiori "1-1-3"

SAP replaced SAP GUI with Fiori explicitly because role-blind complexity failed: Fiori's principles are role-based, responsive, simple — codified as **1 user, 1 use case, ≤3 screens**, showing each role only what it needs. [Verified — [tutorialspoint Fiori intro](https://www.tutorialspoint.com/sap_fiori/sap_fiori_introduction.htm), [pathlock Fiori overview](https://pathlock.com/blog/sap-fiori/)] Yet SAP still fails the studies in §2.6 because the depth underneath leaks through. **[Inference]** JENIFY can actually deliver 1-1-3 because its depth is small, configured per tenant, and permission-scoped at the server (financial masking is server-side — `maskMoney`/`stripFinancial` — so a simple UI is never a security bluff).

---

## 3. Where JENIFY stands today (code-grounded)

### 3.1 Already right — protect these

| Strength | Where |
|---|---|
| Nav filtered by permission; users never see modules they can't view | `Layout.tsx:75` |
| Server-side financial masking — simplicity is real, not cosmetic | CURRENT_STATE §3.5 |
| Smart defaults: price category derived from customer; list price prefilled; entry UoM auto-set from item; date=today; receiving unit defaults to tonnes; source locked | `SalesPage.tsx:64-70,300-302`, `ReceivingPage.tsx:36-40` |
| Sale + payment in one flow ("paid" sale auto-records the payment) | `SalesPage.tsx:155-165` |
| Consistent page grammar: stat cards → inline "New X" form → "Recent X" table with row actions | all transactional pages |
| Status always color **plus** text | `ui.tsx StatusBadge` |
| Dangerous actions demand a reason and look dangerous | `ui.tsx ReasonDialog` |
| Route-level code splitting; ~69 kB gzip first load — fast on modest devices | `App.tsx`, CLAUDE.md budget |
| i18n everywhere (`t()`), Amharic/Tigrinya enabled (translations still placeholder — T8) | `seed.ts:97-100` |

### 3.2 Simplicity gaps found

1. **`dashboardFocus` is stored per role and used nowhere.** Every role lands on the same all-purpose Dashboard (`App.tsx:45` index route). The schema (`db/schema.ts:52`) and every Mesob role (`seed.ts`) already declare the intended home module — the frontend ignores it. The single cheapest role-experience win in the codebase.
2. **Nav over-shows because three nav entries share one module.** `Receiving`, `Inventory`, and `Empty Sacks` all gate on `can('inventory','view')` (`Layout.tsx:18,19,26`). Result today (matrix × NAV): Sales Officer sees **9** menu entries including Receiving and Empty Sacks; Finance sees **11**; Production Operator sees **7** including Receiving. Menu noise for exactly the users who need the least.
3. **No quick actions anywhere.** The Dashboard is read-only stat cards + activity + alerts (`DashboardPage.tsx`); stat cards like "Pending approval" (`ReceivingPage.tsx:115-119`) are not clickable. Alerts don't link to the thing to fix. Every task starts with sidebar navigation.
4. **Approval work is scattered.** A manager approving the morning's receipts, batches, and dispatches visits three pages and scans three tables for rows with buttons. There is no "things waiting for you" view, though the data (draft receipts, pending QC, confirmable deliveries) is all one query away.
5. **Mobile is a shrunk desktop.** One breakpoint (≤900px) turns the sidebar into a drawer (`styles.css:323`); tables stay tables in `table-wrap` scrollers; per-row `btn-sm` buttons are small targets — the opposite of §2.4/§2.5 guidance. Fine for office roles; wrong for gate/floor/driver roles.
6. **Feedback gaps undermine trust** (the real "too many clicks" complaint per §2.6): failed reads render as empty tables on 15/17 pages, Modal lacks Escape/focus trap (defect **D8**, WP7 — treated here as assumed baseline, not re-recommended).
7. **Shared-terminal reality unaddressed.** One login = one long session (12h timeout setting, currently dead — D10). A shared floor terminal invites everyone acting as one user, which quietly destroys the audit trail's value. POS solves this with fast user switching / PIN re-auth.
8. **Click audit of today's top workflows** (counting convention: §4):

| Workflow (role) | Today | Notes |
|---|---|---|
| Check business position (owner) | **0** after login | already excellent |
| Approve one pending receipt (operations) | **2** (nav + row button) | but finding it = table scan; no queue |
| Dispatch a delivery (warehouse) | **2** | good; buttons small on phone |
| Receive a truck (warehouse) | **~9** (nav 1 + supplier 2 + truck 1 + driver 1 + net qty 1 + warehouse 2 + save 1) | date/unit/material/source already defaulted |
| 1-line repeat cash sale (sales) | **~9** (nav 1 + customer 2 + product 2 + warehouse 2 + qty 1 + confirm 1) | payment auto-recorded; category/price/UoM defaulted |
| Complete a batch (production) | **~4–6** (nav + stage tab + row Complete + qty + confirm) | modal-based |
| Record + allocate payment (finance) | **~7–8** | method/date defaulted; allocation extra |

**[Inference]** The forms are already lean by ERP standards; the remaining cost is in *navigation, selection, and finding* — which is exactly what role homes, quick actions, and sticky defaults remove.

---

## 4. Role experience profiles

**Counting convention** — one "interaction" = one tap/click on a control, or filling one input (typing a value = 1 regardless of characters; desktop select = 2: open + choose). Budgets count from the role's home screen, signed in. "Max clicks" = ceiling for the role's **most common task**, not every task.

**Mapping to today** — Mesob live roles: owner, operations, warehouse, production operator, production supervisor, quality, sales, finance (`seed.ts`). Profiles marked *(future)* have no role today; they are design targets tied to roadmap milestones (CURRENT_STATE §6) so the experience is designed **before** the module, not bolted on after. All of this is evolution of the existing shell: same sidebar/header/pages, plus role-scoped home + quick actions.

| # | JENIFY role | Mesob today | Device (primary) | Home screen | Max clicks (top task) | Nav budget |
|---|---|---|---|---|---|---|
| 1 | OWNER | `owner` | desktop + phone (read) | business pulse | 0 (see position) | grouped-all |
| 2 | MANAGER | `operations` (+`production_supervisor` variant) | desktop / tablet | approvals & exceptions inbox | 2 (approve item) | ≤9 |
| 3 | CASHIER | *(future — subset of sales+payments)* | phone / tablet | sell screen | 5 (cash sale) | ≤4 |
| 4 | SALES | `sales` | desktop now, phone target | new sale + my recent | 7 (repeat 1-line sale) | ≤7 |
| 5 | WAREHOUSE | `warehouse` | tablet / phone at gate | awaiting-action list | 2 (dispatch) / 7 (receive truck) | ≤5 |
| 6 | PRODUCTION | `production` | shared terminal / tablet | my stage panel | 4 (complete batch) | ≤4 |
| 7 | QUALITY | `quality` | tablet + desktop | QC queue | 4 (record result) | ≤5 |
| 8 | PROCUREMENT | *(future — M2)* | desktop | purchase pipeline | 6 (repeat PO) | ≤6 |
| 9 | FINANCE | `finance` | desktop | money dashboard | 6 (record+allocate payment) | ≤9 |
| 10 | HR | *(future — M5)* | desktop / tablet | today's attendance board | 3 (mark attendance) | ≤5 |
| 11 | DELIVERY (driver) | *(future — driver is free text today)* | phone only | my deliveries today | 2 (mark delivered) | ≤3 |
| 12 | MAINTENANCE | *(future — M5, design-first)* | phone / tablet | open work orders | 3 (report breakdown) | ≤4 |
| 13 | ADMIN | part of `owner` today | desktop | system health | 4 (fix a user's access) | admin group |

### 4.1 OWNER — "How is my business today?"
- **Sees first:** today's cash in, sales, outstanding + overdue (danger-toned), stock position, alerts, recent activity — the existing Dashboard already is this; it stays the owner's home.
- **Quick actions (4):** Overdue credit list · Approvals waiting (count badge) · This month's report · Audit trail ("what happened today").
- **Hidden:** data-entry forms de-emphasized (owner *can* do everything; the home path never asks them to); admin/system screens behind an "Administration" nav group.
- **Clicks:** position = 0; any drill-down ≤2. **Literacy/training:** fully literate, zero patience; 30-minute walkthrough, banking-app expectations (§2.3).

### 4.2 MANAGER (Operations) — "What is waiting on me?"
- **Sees first:** an **inbox**: draft receipts to approve, batches awaiting approval, deliveries ready to dispatch, low-stock and stuck-item alerts, today's production summary. (Today: generic dashboard; `dashboardFocus='production'` unused.)
- **Quick actions (5):** Approve receiving · Approve batch · Dispatch delivery · New transfer · Today's production.
- **Hidden:** payments/credit money detail (no `view_financial` on payments today — keep), settings, users, role admin.
- **Clicks:** approve any waiting item ≤2 from home (tap inbox row → confirm). **Literacy/training:** literate; productive in half a day.

### 4.3 CASHIER *(future role — design target)*
Mesob today folds this into sales/finance; shops and the multi-sector roadmap need it as the narrowest money-handling role.
- **Sees first:** a **sell screen**: tiles of the most-sold items (Square quick-service pattern, §2.1), running total, one big "Paid — record sale" button.
- **Quick actions (4):** New sale · Record payment received · Reprint last receipt · My day's cash summary.
- **Hidden:** everything else. No credit approval, no price editing (list price locked — mechanism already exists via `sales.approve`), no reports beyond own shift, nav ≤4 entries.
- **Clicks:** one-item cash sale ≤5, <45 s. **Literacy/training:** basic literacy + numerate; ≤1 hour to first unaided sale (Loyverse bar, §2.1).

### 4.4 SALES — "Sell and don't oversell"
- **Sees first:** new-invoice form + available finished stock + own recent invoices (SalesPage is already 90% this — it should simply *be* home).
- **Quick actions (5):** New invoice · New customer · Stock check · Customer balance · Request delivery.
- **Hidden:** margins/costs (don't exist yet — keep it that way for this role when M2 costing lands), price/discount overrides without `sales.approve` (already enforced), Receiving/Empty Sacks nav noise (§3.2-2).
- **Clicks:** repeat 1-line sale ≤7 (today ~9; customer search-first + remembered warehouse close the gap). Credit-limit block with authorized override already well-designed (`SalesPage.tsx:213-220`). **Literacy/training:** literate, numerate; half a day.

### 4.5 WAREHOUSE — "Trucks in, trucks out"
- **Sees first:** awaiting-action list: trucks/receipts in draft, deliveries to load, loaded deliveries to dispatch, stock at *their* warehouses. Not a stats page — a to-do list (scanner-app pattern, §2.4).
- **Quick actions (4):** Receive truck · Load delivery · Dispatch · Transfer stock. *(Later, M4: Count stock.)*
- **Hidden:** all money (server-masked already), production internals, customer credit, reports beyond stock. Nav ≤5.
- **Clicks:** dispatch ≤2; receive truck ≤7 (today ~9 — remembered supplier+warehouse for the repeat Afdera truck). Big-target buttons on phone/tablet; card rows, not table rows. **Literacy/training:** basic literacy; numbers-first design (§2.2); one shift shadowing.

### 4.6 PRODUCTION — "Start it, finish it, report the number"
- **Sees first:** **their stage only** (operator is assigned a stage; supervisor sees all stage tabs — today everyone sees all tabs): open batches each with one big next action (Start / Complete), today's input/output/loss cards.
- **Quick actions (4):** Start batch · Complete batch (enter output) · Report waste/loss · My batches' QC status.
- **Hidden:** QC recording (Quality's job — already role-split by design), all money, sales/customers, settings. Nav ≤4.
- **Clicks:** complete batch ≤4 including typing output qty. Terminal-profile targets (glove-sized, spaced — §2.5). **Literacy/training:** low literacy tolerated: icon + number + colored status with word; one shift.

### 4.7 QUALITY — "Test, decide, release"
- **Sees first:** **QC queue**: batches `pending_qc` / `retest_required` / `passed_pending_release`, oldest first, each opening straight into the test form. (Today QC lives inside Production page modals — works, but the queue isn't the landing view and there's no `quality`-module nav entry at all.)
- **Quick actions (4):** Record test · Release passed batch · Order retest · Hold batch.
- **Hidden:** production create/edit (view only — enforced), money, sales. Nav ≤5.
- **Clicks:** record result ≤4; release ≤2. Immutable-retest model stays (a retest is a new attempt — never edit). **Literacy/training:** technically literate (lab); half a day.

### 4.8 PROCUREMENT *(future — M2, design before build)*
- **Sees first:** purchase pipeline: open POs, deliveries awaited, low-stock reorder suggestions.
- **Quick actions (4):** New PO (repeat-last-PO prefill) · Receive against PO · Supplier list · Price history.
- **Hidden:** sales side, production, HR. Desktop role; nav ≤6.
- **Clicks:** repeat PO ≤6. **Literacy/training:** literate; half a day. **[Inference]** design the PO form to the Receiving form's grammar so warehouse receipt-against-PO is recognizably the same screen.

### 4.9 FINANCE — "Money in, credit under control"
- **Sees first:** money dashboard: payments today, outstanding, overdue, customers near credit limit — plus a "record payment" fast path. (Finance already gets the financial card row; `dashboardFocus='payments'` unused.)
- **Quick actions (5):** Record payment · Allocate payment · Approve credit/override · Customer statement · Export report.
- **Hidden:** production/warehouse entry forms; identity editing of customers (finance approves credit, doesn't edit identity — matrix already encodes this nuance). Nav ≤9 is acceptable: this is a power role.
- **Clicks:** record + allocate ≤6. **Literacy/training:** accountant; one day including credit rules.

### 4.10 HR *(future — M5, design-first)*
- **Sees first:** today's attendance/shift board. **Quick actions:** Mark attendance · Add worker · Approve leave · Shift change. **Hidden:** everything operational/financial. **Clicks:** mark attendance ≤3. **[Inference]** the first HR deliverable should replace free-text operator names on batches with worker records — an HR-lite that serves Production's audit value before payroll ambitions.

### 4.11 DELIVERY (driver) *(future role; module exists, driver is free text)*
- **Sees first:** **my deliveries today** — cards with customer, destination, load summary, and one giant status button each.
- **Quick actions (3):** Mark delivered · Report problem · Call customer (`tel:` link).
- **Hidden:** everything else. No money unless a COD decision is made (open question §7). Nav ≤3; phone only.
- **Clicks:** mark delivered ≤2 taps. **Literacy/training:** lowest bar in the system — USSD-grade (§2.2): big numbers, big buttons, zero jargon, zero formal training. Works from a normal phone browser; PWA shell already exists.

### 4.12 MAINTENANCE *(future — M5, design-first)*
- **Sees first:** open work orders / machine list with status. **Quick actions:** Report breakdown (photo later) · Close work order · Request part. **Clicks:** report breakdown ≤3. **Literacy/training:** technician; minutes. **[Inference]** breakdown reporting is the wedge feature — one form, huge downtime-visibility value, long before preventive-maintenance scheduling.

### 4.13 ADMIN — "Keep the system healthy" *(today inside `owner`)*
- **Sees first:** system health: users & roles, failed logins, last backup age, audit anomalies, translation coverage.
- **Quick actions (5):** Add user · Reset access (password/recovery) · Edit role matrix · Backup now · Manage languages.
- **Hidden:** may be *denied* financial visibility (server masking makes an IT-admin-without-money-visibility genuinely enforceable — a differentiator vs small-business norms where "the IT guy sees everything").
- **Clicks:** restore a locked-out user ≤4. **Literacy/training:** the one role allowed to see system terminology. **[Inference]** splitting ADMIN out of `owner` is low-cost (a role row) and high-governance-value once any non-founder administers a tenant.

---

## 5. Simplicity metrics — what JENIFY tracks per release

Standard usability practice measures effectiveness (task success), efficiency (time on task), and errors; SUS gives a comparable perceived-ease score (average 68; ≥70 good). [Verified — [NN/g-derived metric guides](https://measuringu.com/essential-metrics/), [Maze usability metrics](https://maze.co/collections/reporting-analysis/measure-usability-metrics/)] JENIFY adapts these into five hard numbers plus two field measures:

| Metric | Definition | Budget |
|---|---|---|
| **M1 Clicks per workflow** | Interactions (per §4 convention) from role home to posted document, for each role's top task | Per-role ceilings in §4 table; any regression fails review |
| **M2 Fields per form** | Visible fields / required fields on any daily-use form | ≤10 visible, ≤6 required for worker forms (Receiving today: 11/6 — at the line) |
| **M3 Time-to-complete** | Stopwatch, trained user, realistic data | cash sale <60 s · truck receipt <90 s · payment <45 s · batch completion <30 s · QC record <60 s |
| **M4 Menus visible per role** | Sidebar entries after permission filtering | worker ≤5 · supervisor ≤7 · manager ≤9 · owner/admin grouped |
| **M5 Training-to-first-unaided-transaction** | Minutes from first login to first correctly posted document without help | worker roles ≤60 min; the marketing number vs Odoo/ERPNext's days (§2.6) |
| **M6 Error-rejection rate** | Server validation rejections ÷ successful posts, per form (from audit/API logs) | <5%; a spike = the form lets people be wrong |
| **M7 Task success without help** | % of trained users completing their top task unaided (5-user field test) | ≥90% |

**Instrumentation, cheapest first [Inference]:**
1. **Now (manual, per release):** M1/M2/M4 are countable from code and a browser in minutes — put them in the release checklist as a table diffed against last release. M3 by stopwatch during the existing manual walkthrough.
2. **Near (server-side):** M6 from `audit_events` + API 4xx counts — no client work.
3. **Later (client events):** a tiny UX event counter (page-land → post timestamps) feeding M3 automatically. Not before Milestone-1 hardening lands; never at the cost of the JS budget (~69 kB gzip).
4. **Field tests:** M5/M7 at Mesob with real staff at go-live, then per new tenant — each becomes template knowledge, per the roadmap's "deployments become templates, not forks".

---

## 6. Recommendations — evolution, not redesign (value ÷ complexity ranked)

Assumed baseline: D8 (error/busy visibility, Modal a11y) ships in Milestone 1 WP7 — perceived reliability is a precondition for everything below (§2.6: "too many clicks" is really "I'm not sure it worked").

1. **Wire `dashboardFocus` into role-scoped homes.** Land each role on their focus module; owner keeps Dashboard. Data already in DB and every role sets it; one routing change + per-page readiness. *(Value: very high · Complexity: low)*
2. **Quick-action row + clickable pending counts on the home screen.** 3–6 permission-filtered action buttons per role (§4 lists them) and make "Pending approval"-type stat cards navigate to the filtered list. *(Very high · Low-medium)*
3. **Manager approvals inbox.** One view aggregating draft receipts, batches awaiting approval/QC-release, dispatchable deliveries — each row: summary + Approve/act button. Kills the three-page morning scan. *(High · Medium)*
4. **Nav de-noising.** Give nav entries an optional required-action (Receiving → `inventory.create`, Empty Sacks → `inventory.create`) and group admin entries (Users/Settings/Audit) under "Administration". Sales drops 9→7 entries, Finance 11→9, workers ≤5 — no permission changes, purely presentational. *(High · Low)*
5. **Sticky smart defaults + repeat-last.** Remember per user: last warehouse, supplier, customer, UoM; add "repeat last" prefill on Receiving/Sales/(future) PO. Cuts the two heaviest workflows ~25–30% of interactions (§3.2-8). *(High · Low-medium)*
6. **Mobile action-cards for floor/gate/driver screens.** At ≤900px render Deliveries/Receiving-pending/Production-open lists as cards with one large primary action button (≥48 px target), per §2.4/§2.5. Desktop tables unchanged. *(High · Medium)*
7. **Shared-terminal fast user switching (PIN re-auth).** POS-style switch-user for floor terminals so the audit trail stays honest. Depends on session hardening (D10). *(Medium-high · Medium)*
8. **Worker-language label pass with the T8 translation fill.** When Amharic/Tigrinya translations are done with factory review, audit English worker-facing labels for jargon at the same time (one `t()` sweep, no code structure change). *(Medium · Low)*
9. **Future-role experience specs before their modules** (Cashier, Driver, Procurement, HR-lite, Maintenance — §4.3/4.8/4.10–4.12) so M2/M5 modules are born inside click budgets rather than retrofitted. *(Medium · Low — paper only)*

---

## 7. Open questions for the Founder

1. Actual literacy/language profile of Mesob floor staff (drives how far Production/Delivery screens lean on icons+numbers vs text) — and which staff have smartphones.
2. Device inventory & budget: any tablets for gate/floor? Or is phone-browser + the office desktop the reality for go-live?
3. Are floor terminals shared? If yes, rec #7 (PIN switching) rises sharply in priority.
4. Do drivers handle cash on delivery? (Defines whether the Driver profile ever shows money.)
5. Should ADMIN split from `owner` at Mesob go-live, or only from tenant #2 onward?
6. Which role does the Founder want the first field-timed M5 measurement on (suggest: Warehouse — highest daily volume)?

---

## Team Lead summary (10 lines)

1. JENIFY rule established: **functional depth must never equal UI complexity** — depth lives in ledger/permissions/config; each role sees only its next action.
2. Evidence base: POS (zero-training checkout), M-Pesa/Telebirr (numbers-first, confirm-before-commit, jargon fails even translated), banking (home = position + 3–5 quick actions), scanner apps/HMI (one task per screen, big targets), ERP studies (multistep complexity + weak feedback are the killers), SAP Fiori 1-1-3 (industry admits role-scoping is the answer).
3. The current app is already lean by ERP standards — smart defaults, permission-filtered nav, server-side money masking, sale+payment in one flow; the remaining cost is navigation, finding, and feedback, not form size.
4. Biggest code finding: `dashboardFocus` exists per role in the DB and is completely unused by the web app — every role lands on the same dashboard.
5. Second finding: module-level nav filtering over-shows (Sales sees 9 menu entries incl. Receiving/Empty Sacks; Finance 11); there are zero quick actions and no approvals inbox anywhere.
6. Thirteen role profiles are specified (§4) with home screen, 3–6 quick actions, hidden surface, device, click ceilings, and literacy assumptions — mapped onto the 8 live Mesob roles; Cashier/Driver/Procurement/HR/Maintenance are design targets tied to roadmap milestones, not new scope.
7. Click ceilings: owner 0 (see position), manager 2 (approve), driver 2 (delivered), cashier 5 (cash sale), production 4 (complete batch), sales 7, warehouse 7 (receive truck).
8. Seven measurable simplicity metrics defined (§5) with budgets and a cheapest-first instrumentation path; M5 "minutes-to-first-unaided-transaction ≤60" is the marketable number vs competitors' days of training.
9. Everything proposed is evolution of the existing shell (same pages, blue language, i18n, permissions) — no redesign, no new permission model, D8/WP7 assumed as baseline.
10. **Top 5 highest-impact simplicity changes for the current app:** (1) wire `dashboardFocus` into role-scoped homes; (2) quick-action row + clickable pending-counts on home; (3) manager approvals inbox; (4) nav de-noising via per-entry required-action + admin grouping; (5) sticky smart defaults + repeat-last prefill on Receiving/Sales.
