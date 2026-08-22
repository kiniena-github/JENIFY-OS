# JENIFY OS — Shared Capability Spines (Design)

**Author:** jenify-core-engineer (procurement-supplier · maintenance-asset · workforce-shift · finance-costing depth)
**Date:** 2026-08-21 · **Status:** design-only — NO CODE. One file. Feeds M2/M5 planning.
**Reviewers wanted:** jenify-architect (core-vs-config boundary), finance-costing (money math), jenify-qa-security (§3 invariants), sector design agents (retail/wholesale/manufacturing/construction fit).

> Read first: `CLAUDE.md` (principles), `docs/FACTORY_OS_CURRENT_STATE.md` §2 (module inventory), §3 (invariants), §6 (missing capabilities). This doc proposes FOUR reusable cross-sector spines + one shared engine that falls out of them. It designs *seams and objects*, not schema literals, and never puts tenant physics in core.

---

## 0. Framing — what a "capability spine" is here

A **spine** is a reusable vertical capability (objects + states + APIs + roles) that lives in core platform packages (`@factoryos/shared`, `server`, `web`), is switched on per tenant by a **capability flag**, and is *parameterised* by sector templates + country packs — never forked. A tenant that does not need procurement never sees it; a tenant that needs 2-step buying gets 2 steps, not a 7-step ceremony (competitor lesson: GLOBAL_COMPETITOR_INTELLIGENCE §5.7 — do NOT force procure-to-pay ceremony on a 5-person firm).

**Capability-ID convention (proposed).** `cap.<domain>.<feature>@<level>` where level ∈ {`lite`, `standard`, `full`}. A capability declares `requires:` (hard deps) and `enhances:` (soft deps). Tenant provisioning resolves the dependency graph; a template turns on a *bundle* of capabilities. This is the honest answer to Canias-TROIA / Odoo-Studio (competitor §2.17): typed declarative config, not a customer programming language.

**What already exists (do not rebuild — CURRENT_STATE §2):** parties (customer/supplier/both), items/UoM, warehouses, append-only stock ledger, **goods receipts (receiving)**, sales invoices + lines, **payments + payment_allocations** (receivables side), simple_transactions (SacksPage cash-book pattern), RBAC (roles/role_permissions versioned), audit_events (append-only), document_sequences (atomic numbering), tenant_settings (versioned). Every spine below *reuses* these; none duplicates them.

**Five invariants every spine inherits (CURRENT_STATE §3), stated once so each spine can reference by number:**
- (i) append-only ledgers, corrections are new rows;
- (ii) integer milli/cents, never floats;
- (iii) versioned never-overwritten config, documents snapshot their config version;
- (iv) posted docs are reversed/cancelled, never hard-deleted;
- (v) tenantId from session only, audit on every mutation, permission on every route (fail-closed).

---

## SPINE A — SHARED APPROVALS ENGINE (`cap.approval.*`)

**Why this is first.** Procurement needs "approve a requisition/PO over a limit". Assets need "approve a work order / capitalise an asset". Workforce needs "approve leave / timesheet / overtime". Finance needs "approve an expense / a payment run / a budget override". If each spine grows its own approval logic we get four inconsistent, un-auditable half-workflows. So **APPROVALS is designed once as a core primitive and reused** — this is the single most important structural decision in this document.

Design principle from competitors: SAP B1's "approval procedures scoped to exceptions" and Dynamics BC's dimension/threshold approvals are the validated pattern — approval is triggered by a *rule on a threshold*, not required on every document (competitor §2.3, §2.4). Default = no approval; a tenant opts into approval on specific document types over specific limits.

### A.1 Core objects (fields only, no schema literals)

- **approval_policy** — `id, tenantId, targetType (enum of approvable doc types: purchase_requisition|purchase_order|work_order|expense|leave_request|timesheet|payment_run|budget_override|adjustment…), condition (versioned rule: amount ≥ X in cents | quantity ≥ X | category = Y | always), steps[] (ordered), active, version, createdAt`. **Versioned, never overwritten (inv iii)** — a document snapshots `policyVersion` at submit time so re-reads reproduce the rule that governed it.
- **approval_step (within policy)** — `sequence, approverResolver (by roleCode | by named user | by "manager-of-submitter" | by module-permission), quorum (default 1), allowSelfApprove (default false)`.
- **approval_request** — `id, tenantId, targetType, targetId, policyVersion, submittedByUserId, state, currentStep, createdAt`. One per submitted document.
- **approval_action** — `id, tenantId, requestId, step, actorUserId, decision (approve|reject|delegate|comment), reason, actedAt`. **Append-only (inv i, v)** — an approval trail is never edited; a changed mind is a new action on a re-submitted request.

### A.2 Workflow states

`DRAFT → PENDING_APPROVAL → (APPROVED | REJECTED | WITHDRAWN)`; APPROVED unlocks the document's own post/execute transition. Rejected returns to DRAFT for edit + resubmit (new request, old one retained). Multi-step: PENDING_APPROVAL advances `currentStep` until the last step approves. Escalation/timeout is an *enhancement* (`cap.approval.escalation` — auto-escalate to next role after N hours) — design the seam, don't build it first.

### A.3 Capability IDs + dependencies

- `cap.approval.lite@` — single-step, single-approver-by-role, amount-threshold only. **requires:** RBAC (exists), audit (exists), numbering (exists). Nothing else. This alone covers 90% of SME need.
- `cap.approval.standard` — multi-step, quorum, manager-of-submitter resolver, delegation. **requires:** `cap.approval.lite`, workforce spine (for "manager-of" org graph — see Spine C).
- `cap.approval.escalation` (enhancement) — timeout/escalation/reminders. **enhances:** notifications (CURRENT_STATE §6: notifications persistence is M4 — until then, computed-on-read like existing dashboard alerts).

### A.4 Roles touched & approval-engine-as-service

Every role can be a *submitter*; approver identity is resolved per policy. Owner/operations approve procurement + finance; supervisor approves workforce; maintenance lead approves work orders. The engine exposes a tiny internal API surface — `submitForApproval(targetType, targetId)`, `decide(requestId, decision, reason)`, `isApproved(targetType, targetId)` — that each spine calls at its gate. **No spine implements its own approval state machine.**

### A.5 Audit / immutability

approval_request + approval_action are append-only; every decide() writes audit (inv v). A document may not leave PENDING_APPROVAL except via a recorded approval_action. Self-approval is blocked unless the policy explicitly allows it (segregation of duties — AFRICA_REQUIREMENTS §4: fraud control is board-level). The approval trail is reproducible at reprint time via `policyVersion`.

### A.6 Open Founder questions (approvals)

1. Default posture: ship every tenant with approvals **off** (opt-in) — confirm this matches the "SIMPLE for the shop, controllable for the factory" bar? (Recommended: yes.)
2. Should "manager-of-submitter" resolution require the Workforce spine, or do we allow a lightweight `reportsToUserId` on the user record for tenants that never adopt full Workforce? (Recommended: lightweight pointer in core, full org graph in Workforce.)

---

## SPINE B — PROCUREMENT (`cap.procurement.*`)

Closes CURRENT_STATE §6's biggest M2 hole alongside costing: "Suppliers exist as parties; no PO/RFQ, no supplier UI, no receipt-to-PO match." Ties directly into **existing receiving** (`goods_receipts`) — receiving becomes PO-aware, not replaced.

### B.1 Full workflow (each stage is capability-gated so tenants pick their depth)

```
REQUEST → APPROVAL → RFQ → QUOTATIONS → COMPARISON → PURCHASE ORDER
        → RECEIVE (existing goods_receipts, now PO-linked) → INVOICE/MATCHING (later)
        → SUPPLIER PERFORMANCE
```

**Two-step default (competitor §5.7 anti-ceremony).** `cap.procurement.lite` = **PURCHASE ORDER → RECEIVE + BILL** only. RFQ/quotation/comparison and 3-way match are opt-in (`cap.procurement.standard` / `cap.procurement.full`). Mesob and most African SMEs run lite; a construction or mid-market tenant turns on the ceremony.

### B.2 Core objects (fields only)

- **purchase_requisition** — `id, tenantId, docNumber, requestedByUserId, date, neededByDate, warehouseId?, costCenter?, status, notes`. Lines: `itemId, qtyMilli, entryUomId, estUnitCostCents?, reason`. Internal demand signal; feeds approval.
- **rfq** — `id, tenantId, docNumber, requisitionId?, date, dueDate, status`. Lines: `itemId, qtyMilli, spec`. Recipients: `rfqSupplierId[]` (FK parties.kind∈{supplier,both}).
- **supplier_quotation** — `id, tenantId, docNumber, rfqId, supplierId, receivedDate, validUntil, currency, fxRateSnapshot?, status`. Lines: `itemId, qtyMilli, unitPriceCents, leadTimeDays, minOrderQty, notes`. **Money integer cents; multi-currency snapshot pattern already used by payments (inv ii, iii).**
- **quotation_comparison** (derived view, not necessarily a stored doc) — ranks quotations per line by landed unit cost, lead time, supplier score; records `awardedSupplierId + reason` when a PO is raised (decision provenance).
- **purchase_order** — `id, tenantId, docNumber, supplierId, date, expectedDate, warehouseId, currency, fxRateSnapshot?, pricingVersion (snapshot), status, totalCents (derived)`. Lines: `itemId, qtyMilliOrdered, qtyMilliReceived (derived from receipts), unitCostCents, uomId, taxSnapshot?`. **Snapshots config version at post (inv iii).**
- **goods_receipt (EXISTING — extended, not replaced)** — add nullable `purchaseOrderId` + per-line `purchaseOrderLineId`. Receiving without a PO stays valid (Mesob receives from Afdera today with no PO). A PO-linked receipt drives `qtyMilliReceived` and over/under-receipt flags. **This is the critical tie-in: one receiving surface, PO-aware when a PO exists.**
- **supplier_bill / vendor_invoice** — `id, tenantId, docNumber, supplierId, poId?, receiptId?, date, dueDate, currency, fxRateSnapshot?, amountCents, taxSnapshot?, status (draft|posted|reversed), matchState (unmatched|matched|variance)`. Payables sibling of the existing sales_invoice. **3-way match** (PO ↔ receipt ↔ bill) is `cap.procurement.full`; `lite` posts a bill straight from a receipt.
- **supplier_performance (derived/rollup)** — per supplier: on-time-delivery %, price trend, quality-reject rate (from receiving inspection + QC linkage), quotation win rate, avg lead time. Not a hand-edited table — computed from posted history (like the existing delivery-performance helper in `@factoryos/shared`).

### B.3 Workflow states

- requisition: `DRAFT → PENDING_APPROVAL → APPROVED → CLOSED(converted) | REJECTED`
- rfq: `DRAFT → SENT → QUOTING → CLOSED`
- quotation: `RECEIVED → SHORTLISTED → AWARDED | DECLINED`
- purchase_order: `DRAFT → PENDING_APPROVAL → APPROVED → SENT → PARTIALLY_RECEIVED → RECEIVED → CLOSED`; plus `CANCELLED` (pre-receipt) and `REVERSED` (post — inv iv, never deleted).
- supplier_bill: `DRAFT → MATCHED/VARIANCE → POSTED → (PAID via payments allocation) → REVERSED`.

### B.4 Capability IDs + dependencies

- `cap.procurement.lite` — PO → receive+bill. **requires:** parties (exists), items+UoM (exists), inventory/receiving (exists), numbering (exists), `cap.approval.lite` (optional gate). **enhances:** costing (a PO's unitCostCents feeds M2 FIFO cost capture — finance-costing owns valuation).
- `cap.procurement.standard` — adds requisition + approval + supplier bill matching (2-way PO↔bill). **requires:** `cap.procurement.lite`, `cap.approval.lite`.
- `cap.procurement.full` — adds RFQ → quotation → comparison + 3-way match + supplier performance. **requires:** `cap.procurement.standard`.
- `cap.procurement.supplier_intelligence` (AI enhancement, future) — see B.7.

### B.5 Which sectors need it (map)

| Sector | Procurement need | Level |
|---|---|---|
| Manufacturing (Mesob) | Raw material + consumable buying, cost capture for margin | lite→standard (M2) |
| Wholesale/distribution | High-volume supplier buying, payables at scale, price-change tracking | standard |
| Retail/shop | Simple restock, supplier balances | lite |
| Construction | Requisition→RFQ→compare→PO is genuinely needed (materials, subcontractor quotes, project cost buckets) | full |

Construction is the tenant that justifies building `full`; do NOT build `full` before a real construction tenant validates it (AFRICA_REQUIREMENTS roadmap risk #2: extract from deployments, never imagination). Coordinate with `design-construction`.

### B.6 Roles / role experiences touched

Requester (any operational role) raises requisitions; **warehouse** receives against PO (existing ReceivingPage, now PO-aware); **operations/owner** approve + award; **finance** matches + posts bills + pays via existing payments; supplier-facing RFQ/quotation is an owner/operations surface. Server-side financial masking (inv v) already hides costs from roles lacking `view_financial` — supplier prices inherit that.

### B.7 AI opportunities (design the hooks; build in the AI milestone per §6/charter — jenify-ai-engineer owns)

All read-only, suggest-and-confirm (BC-Copilot pattern, competitor §2.4; JENIFY AI-safety pipeline in CLAUDE.md principle 6). AI never posts a PO on its own.
1. **Supplier price-change detection** — flag when a new quotation/PO unit cost deviates >X% from that supplier's trailing average or from peers (inflation reality: AFRICA_REQUIREMENTS §5.6 — prices move weekly, so anomaly must be inflation-aware, not naive).
2. **Late-delivery pattern** — from PO expectedDate vs receipt date history, surface chronically-late suppliers.
3. **Best historical supplier** — for an item, rank by landed cost + on-time + reject-rate; suggest at RFQ award time.
4. **Abnormal procurement** — quantity/frequency/off-hours outliers vs baseline (fraud lens — AFRICA_REQUIREMENTS §1.3/§4).
5. **Suggested reorder** — from stock balance + reorder point + lead time (ties to M4 reorder-point alerts; computed-on-read, no scheduler needed).

### B.8 Audit / immutability

Every PO/bill is posted→reversed, never deleted (inv iv); receipts already append-only via stock ledger (inv i). Awarded-supplier reason is retained (decision provenance). Cost figures are integer cents (inv ii). Supplier price history is never overwritten — a price change is a new quotation/PO line, so the AI price-trend has an honest series.

### B.9 Open Founder questions (procurement)

1. Is 3-way match ever wanted at Mesob, or is lite (receipt→bill) the ceiling for the manufacturing pilot? (Recommended: lite for Mesob; reserve full for construction/wholesale.)
2. Do we model landed cost (freight/duty apportionment) in M2 or defer? Ethiopia FX-scarce imports make landed cost real — but it's a costing concern; finance-costing should own the split. (Recommended: capture a landed-cost adjustment field on receipt in M2, full apportionment later.)
3. Subcontractor procurement (construction) — is a subcontractor a `party` or a `workforce` object? (Cross-spine; see C.9.)

---

## SPINE C — ASSETS / MAINTENANCE (`cap.asset.*`, `cap.maintenance.*`)

Fills CURRENT_STATE §6: "Maintenance / machines / work centers — Nothing exists (M5, design first)". `maintenance-asset` owns the domain (charter: "domain not yet in code"). Design only; the physics are validated by a real tenant before build.

### C.1 Core objects (fields only)

- **asset** — `id, tenantId, code, name, class (machine|vehicle|tool|facility|it_equipment|other), category (tenant-configured vocabulary), locationId? (reuse warehouse/site), parentAssetId? (component hierarchy), acquisitionDate, acquisitionCostCents?, supplierId? (FK parties — provenance ties to procurement), status, meterUnit? (hours|km|cycles), currentMeter?, custodianUserId?, notes, active, createdAt`. Money integer cents (inv ii); acquisition ties to a supplier_bill when procurement bought it.
- **asset_meter_reading** — `id, tenantId, assetId, readingValue, readingUnit, readAt, readByUserId, source (manual|derived)`. **Append-only (inv i)** — meter history drives usage-based PM + future predictive alerts.
- **maintenance_plan (preventive schedule)** — `id, tenantId, assetId?|assetClass?, triggerType (calendar|meter|both), intervalDays?|intervalMeter?, taskChecklist[], sparePartsForecast[], leadTimeDays, active, version`. **Versioned (inv iii).**
- **breakdown_report** — `id, tenantId, assetId, reportedByUserId, reportedAt, symptom, severity, downtimeStartAt, status`. Field-report entry point (mobile-first — AFRICA_REQUIREMENTS §3: one cheap Android, photo input as future lever).
- **work_order** — `id, tenantId, docNumber, assetId, sourceType (preventive|breakdown|inspection|request), planId?, breakdownId?, priority, assignedTechnicianId (FK workforce employee OR user), scheduledAt, startedAt, completedAt, laborMinutes, status, resolution, downtimeMinutes (derived), costCents (derived: parts + labor)`. The central maintenance document.
- **work_order_part (spare parts consumption)** — `id, tenantId, workOrderId, itemId (FK items — spare parts ARE inventory), qtyMilli, warehouseId, unitCostCents (from FIFO), movementId (FK stock ledger)`. **This is the tie-in: spare-part issue is a normal stock movement (inv i) — no parallel inventory.**
- **service_history (derived view)** — per asset: all work orders, parts, cost, downtime, MTBF/MTTR — computed from posted work orders, not hand-maintained.

### C.2 Workflow states

- work_order: `DRAFT → PLANNED → ASSIGNED → IN_PROGRESS → ON_HOLD(awaiting_parts) → COMPLETED → CLOSED`; plus `CANCELLED`. A completed WO that consumed parts is immutable; a correction is a new adjusting WO (inv iv).
- breakdown_report: `OPEN → ACKNOWLEDGED → WORK_ORDER_RAISED → RESOLVED`.
- maintenance_plan: active/versioned; generates due WOs computed-on-read (no scheduler in M4/M5 — same pattern as existing dashboard alerts).

### C.3 Capability IDs + dependencies

- `cap.asset.register@lite` — asset register + meter readings + service history. **requires:** locations/warehouses (exists), parties (for supplier provenance), numbering. **enhances:** procurement (asset acquisition from a bill).
- `cap.maintenance.reactive` — breakdown → work order → spare-part issue + downtime capture. **requires:** `cap.asset.register`, inventory (spare parts = stock, exists), `cap.approval.lite` (optional gate for costly WOs).
- `cap.maintenance.preventive` — maintenance_plan + auto-generated due WOs + spare-parts forecast (feeds procurement reorder). **requires:** `cap.maintenance.reactive`.
- `cap.maintenance.predictive` (AI/future enhancement) — meter-trend + failure-pattern alerts. **enhances:** meter readings + service history; jenify-ai-engineer owns, inactive until AI milestone.

### C.4 Which sectors need it (map)

| Sector | Asset/maintenance need | Level |
|---|---|---|
| Manufacturing (Mesob) | Machines (washing/iodization/packaging lines), PM schedules, downtime → OEE later | register→preventive (M5) |
| Wholesale/distribution | **Vehicle fleet** (delivery trucks), service/fuel, roadworthiness | register→reactive, vehicle-flavoured |
| Retail | Minimal (shop fixtures, cold chain) | register/lite optional |
| Construction | **Heavy equipment + tools register**, utilization, on-site breakdown, hire vs own | register→preventive, high value |

Vehicles are just `asset.class=vehicle` with vehicle attributes (plate, odometer as meter, fuel log) — NOT a separate spine. Nebim lesson (competitor §2.15): put the defining attribute in the core object, parameterise by template; don't fork "fleet management" from "machine maintenance".

### C.5 Roles / role experiences touched

**Technician** (may be a workforce employee who is NOT a system user — see Spine C↔D boundary): receives assignment, updates WO, issues parts (mobile). **Maintenance lead/supervisor:** plans, assigns, approves. **Warehouse:** issues spare parts from stock. **Operations/owner:** downtime + utilization dashboards. Field-worker WO update is the mobile/low-bandwidth surface (jenify-offline-infra + jenify-ux-engineer).

### C.6 Audit / immutability

Meter readings + part issues append-only (inv i); WO cost is integer cents (inv ii); completed WOs reversed not deleted (inv iv); every WO state change writes audit (inv v). Downtime and utilization are derived from immutable timestamps, never hand-typed totals — so the metrics can't be doctored (fraud lens).

### C.7 Utilization / downtime / OEE note

Downtime = Σ(WO downtimeMinutes) + breakdown gaps; utilization = runtime meter Δ ÷ available time. **OEE** (availability × performance × quality) needs production-batch linkage — defer to when Mesob asks; study SyteLine/Katana APS *concepts* at 1/100th scope (competitor §2.6, §6 Tier-3). Do NOT build OEE dashboards speculatively.

### C.9 Open Founder questions (assets/maintenance)

1. Is a **technician** always a Workforce employee, or can a tenant run maintenance with only free-text technician names before adopting Workforce? (Recommended: `assignedTechnician` accepts an employee OR a free-text name at lite, hardens to employee FK when Workforce is on — mirrors the current "operator names are free text" reality, CURRENT_STATE §6.)
2. Fixed-asset **depreciation / capitalisation** — is that an asset-register concern or a finance/GL concern? (Recommended: acquisition cost lives on the asset; depreciation is a finance-layering/GL question — see Spine D; do not build depreciation schedules in the maintenance spine.)
3. Subcontractor + hired equipment (construction): hired equipment is an asset with `ownership=hired` + a supplier link; a subcontractor is a `party`, their crew is out of scope. Confirm with `design-construction`.

---

## SPINE D — WORKFORCE (`cap.workforce.*`) — payroll stays an EXTENSION, not built here

Fills CURRENT_STATE §6: "Workforce / shifts / attendance — Only login users; operator names are free text (M5, design first)". `workforce-shift` owns the domain. **The load-bearing distinction: an EMPLOYEE is not necessarily a system USER.** A washing-line operator or a field delivery hand exists in the org, works shifts, is assigned tasks, and appears on documents — but may never log in. Today the repo conflates the two (operators are free text). This spine separates them cleanly.

### D.1 Core objects (fields only)

- **employee** — `id, tenantId, code, fullName, phone?, nationalId?, role/title (free or FK job_role), teamId?, supervisorEmployeeId?, employmentType (permanent|casual|daily|contract), startDate, status (active|suspended|terminated), linkedUserId? (NULLABLE FK users — set only if this employee also logs in), payRateCents?, payBasis (daily|hourly|monthly|piece), notes`. **`linkedUserId` nullable is the whole point** — org membership ≠ system identity. Pay fields are captured for the payroll *extension* to consume; this spine does not compute pay.
- **team** — `id, tenantId, name, leadEmployeeId?, costCenter?, active`.
- **job_role (org role, distinct from RBAC role)** — `id, tenantId, title, description`. **Explicitly NOT `roles`/`role_permissions`** (those are RBAC/system-access, CURRENT_STATE §2). An employee's job title ("Iodization Operator") is org data; their *system permissions* only exist if they have a linkedUser with an RBAC role. Two different concepts, two different tables — do not merge (competitor §2.2 warns of ERPNext permission sprawl from conflating them).
- **shift** — `id, tenantId, name, startTime, endTime, breakMinutes, daysOfWeek, siteId?`. Template; versioned.
- **shift_assignment** — `id, tenantId, employeeId, shiftId, date, status (scheduled|worked|absent|swapped)`.
- **attendance_record** — `id, tenantId, employeeId, date, clockInAt?, clockOutAt?, hoursWorked (derived), source (manual|supervisor|device), approvedByUserId?`. **Append-only + corrections-as-new-rows (inv i)** — attendance is fraud-sensitive (ghost workers, AFRICA_REQUIREMENTS §1.3/§4).
- **task / work_assignment** — `id, tenantId, docNumber?, title, assignedEmployeeId, assignedByUserId, dueAt, priority, status, linkedDocType? (production_batch|delivery|work_order|…), linkedDocId?, completedAt, proof? (note|photo ref)`. General field-worker assignment reusable across spines (a delivery, a maintenance WO, a production task all create tasks).
- **leave_request** / **overtime_request** — `id, tenantId, employeeId, type, fromDate, toDate/hours, reason, status`. Flow through the shared APPROVALS engine (Spine A) — do NOT build a workforce-specific approval path.

### D.2 Workflow states

- shift_assignment: `SCHEDULED → WORKED | ABSENT | SWAPPED`.
- attendance: `OPEN(clocked-in) → CLOSED(clocked-out) → APPROVED`; corrections append.
- task: `ASSIGNED → IN_PROGRESS → DONE | CANCELLED`; supervisor verify optional.
- leave/overtime: `DRAFT → PENDING_APPROVAL → APPROVED|REJECTED` (via Spine A).

### D.3 Capability IDs + dependencies

- `cap.workforce.registry@lite` — employees + teams + job roles + supervisor graph. **requires:** tenancy + audit only. **enhances:** RBAC (optional employee↔user link), approvals ("manager-of-submitter" resolver reads the supervisor graph — Spine A.3), maintenance (technician = employee), production (operator = employee, replaces free text), deliveries (driver = employee).
- `cap.workforce.attendance` — shifts + assignments + attendance + tasks. **requires:** `cap.workforce.registry`.
- `cap.workforce.field` — task assignment + mobile field-worker + supervisor views + POD/proof. **requires:** `cap.workforce.registry`; **enhances:** offline-infra (field devices), deliveries.
- **`cap.payroll.*` — DECLARED, NOT DESIGNED HERE (see D.7 boundary).**

### D.4 Which sectors need it (map)

| Sector | Workforce need | Level |
|---|---|---|
| Manufacturing (Mesob) | Named operators on batches/QC, shift rosters, attendance | registry→attendance (M5) |
| Wholesale/distribution | Drivers, route crews, field assignment, per-route accountability | registry→field |
| Retail | Cashiers/shift cash-up staff, attendance | registry→attendance |
| Construction | Site crews, daily/casual labor, task-per-site, timesheets → (payroll extension) | registry→field, high |

Casual/daily labor with end-of-day cash pay (AFRICA_REQUIREMENTS §1.8) is real across all four — but paying them is the payroll *extension*, not this spine.

### D.5 Roles / role experiences touched

**Supervisor** view (roster, attendance approve, task assign, team dashboard) is the primary new surface. **Employee/field-worker** gets a minimal mobile task+attendance view *only if* linked to a user; unlinked employees are managed *by* a supervisor. **Owner/operations:** headcount, attendance, labor-cost visibility. RBAC still governs who can see/do — an employee record grants no access by itself (fail-closed, inv v).

### D.6 Audit / immutability

Attendance + assignment history append-only (inv i); pay rates versioned (inv iii — a rate change is a new version, so the payroll extension reads the rate effective on the work date); every mutation audited (inv v). Employee terminate = status change, never row delete (inv iv) — retains history for any downstream payroll/legal record.

### D.7 PAYROLL — the extension boundary (design the seam, NOT payroll)

**Why bounded:** payroll is statutory, per-country, and legally dangerous to fabricate (CLAUDE.md principle 4: never fabricate business rules; principle 7: local only). Ethiopia PAYE, pension, cost-sharing, overtime multipliers, and the Ethiopian/EFY fiscal calendar are country-pack physics (AFRICA_REQUIREMENTS §5.5), not core. Competitor lesson: Sage/Pastel win Africa partly on *statutory payroll as a country-pack product* (competitor §2.7).

**The seam this spine guarantees so payroll can bolt on later without rework:**
1. Employee carries `payBasis` + versioned `payRateCents` (raw inputs only, no computation).
2. Attendance + shift_assignment + overtime + piece-count (from production tasks) are the **immutable time/output facts** a payroll engine consumes.
3. A future `cap.payroll` capability is a **country-pack-owned extension** (jenify-country-localization) that reads those facts, applies statutory rules from a versioned country pack, and *writes results into the Finance layer as expenses/payables* (Spine E) — it does NOT live in core workforce.
4. Payroll output posts as normal payable/expense documents (reversible, audited) — no special ledger.

**Do not** build gross-to-net, tax tables, or payslips until a country's legal requirements are verified with the Founder. Design-only until then.

### D.8 Open Founder questions (workforce)

1. Confirm employee↔user is **optional/nullable** and that unlinked employees can appear on production/delivery/WO documents (replacing today's free-text operators). (Recommended: yes — this is the core value.)
2. Does Mesob want attendance/shift tracking in M5, or only the employee registry (named operators) first? (Recommended: registry first — smallest safe step; it immediately upgrades production/QC provenance.)
3. Country/legal trigger: which country's payroll rules get verified first (Ethiopia, given Mesob) and when does that milestone open? (Founder + jenify-country-localization.)

---

## SPINE E — FINANCE LAYERING (`cap.finance.*`) — operational finance now, GL later

The judgment call in this doc. AFRICA_REQUIREMENTS §1.1 is unambiguous: the universal need is **"how much money do I actually have, and who owes me?" answered daily** — NOT double-entry vocabulary (§3: what small businesses do NOT need). So finance is designed as **layers**: an operational layer everyone gets, an advanced layer factories/mid-market opt into, and a full-GL/accounting layer that is mostly an *integration decision* (§E.4).

### E.1 Layer 1 — Operational finance (`cap.finance.operational`) — the layer almost everyone gets

Most of it EXISTS; this layer completes the money-in/money-out picture without accounting ceremony.

- **Money IN — EXISTS:** `payments` + `payment_allocations` (receivables, partial payments, multi-currency snapshot). Reuse as-is.
- **Money OUT — payables (NEW, from Spine B):** supplier_bill + a **supplier-side payment** (mirror the existing payments object for the pay-out direction; allocate against bills exactly as payments allocate against invoices). Payables aging mirrors the existing receivables/credit view.
- **Expenses (NEW, small):** `expense` — `id, tenantId, docNumber, date, category (tenant vocabulary), payeeId? (party or employee), amountCents, method (cash|mobile_money|bank), reference, costCenter?, status`. The `simple_transactions`/SacksPage cash-book pattern (CURRENT_STATE §2) is the proven precedent — extend that instinct, don't invent a GL for it.
- **Cash & bank accounts (NEW):** `financial_account` — `id, tenantId, name, type (cash_drawer|mobile_money|bank), currency, openingBalanceCents`. Balance is **derived from posted payments/expenses/transfers (append-only, inv i)** — not a stored editable number. Enables cash-drawer-per-user + shift cash-up (AFRICA_REQUIREMENTS §5.4 — cash is where fraud lives; make it auditable).
- **Payment allocation — EXISTS** (payment_allocations); extend the same mechanism to the payables side.
- **Mobile-money reconciliation seam (NEW, high Africa value):** `method` + `reference` + provider on payments/expenses so a telebirr/M-Pesa reference is recorded and reconciled — **recording-first, API-later** (AFRICA_REQUIREMENTS §5.3: 80% of value at 5% of complexity). Country-pack owns provider list.

**States:** all money docs `DRAFT → POSTED → REVERSED` (inv iv). Balances always derived from the append-only series (inv i), integer cents (inv ii). No period-close ceremony at this layer.

### E.2 Layer 2 — Advanced operational finance (`cap.finance.advanced`) — factories & mid-market opt in

- **Costing / COGS / valuation** — finance-costing owns; M2. Purchase cost capture (from Spine B PO) → FIFO valuation (existing FIFO engine) → margin per product/invoice. Devaluation-aware (AFRICA_REQUIREMENTS §5.6).
- **Budgets** — `budget` (versioned) per cost center/category/period; actuals compared on read; over-budget triggers Spine A approval (`budget_override`).
- **Controls** — approval thresholds (Spine A), segregation of duties, cost centers on documents. **enhances:** RBAC + approvals.
- **NOT full GL** — see E.4.

**Dependencies:** `cap.finance.advanced` **requires** `cap.finance.operational` + procurement (cost capture) + inventory (valuation). `cap.finance.operational` **requires** parties + payments (exist) + numbering.

### E.3 Layer 3 — Full accounting / General Ledger — the own-vs-integrate decision

This is where JENIFY must NOT sleepwalk into building SAP. A GL means chart-of-accounts, double-entry postings, journals, trial balance, period close, financial statements, tax filing. CLAUDE.md principle: no giant generic ERP. Competitor §5.7 + AFRICA_REQUIREMENTS §3: accounting-ceremony-first onboarding is a top anti-pattern.

### E.4 RECOMMENDATION — when JENIFY owns a GL vs integrates external accounting

**Recommendation: DEFAULT = do NOT own a GL. Integrate/export to the accountant's tool. Build a JENIFY-native GL only as an opt-in Layer-3 capability, and only after M2 costing + payables land and a real tenant demands statutory statements JENIFY can't export to.**

Reasoning, evidence-based:
1. **The market is won at the accountant channel, and that channel already owns the GL.** Ethiopia runs on Peachtree/Sage-50-era desktop accounting; South Africa on Pastel; the accountant is trained on these (competitor §2.7, §3.1 DATEV lesson: *channel > features*). Fighting the incumbent GL is fighting the channel. **Feed it instead** — a clean, structured export (journal/trial-balance CSV, or a Pastel/QuickBooks/Tally-shaped file) makes JENIFY the *system of record the accountant loves*, not a rival they resist.
2. **JENIFY's operational ledger is already double-entry-grade in trustworthiness** (append-only stock + payments + audit, inv i/v). What's missing is *accounting presentation*, not *data integrity*. That presentation is cheaply produced as an export/adapter, expensively produced as an owned GL.
3. **Owning a GL imports the anti-patterns JENIFY exists to escape** — posting periods, chart-of-accounts setup before you can sell, dimension ceremony (competitor §5.7). It also imports statutory liability per country (fabricating tax/close rules — CLAUDE.md principle 4).
4. **BUT own a GL when:** (a) a tenant needs statutory financial statements + e-filing that no local integration can consume; (b) multi-entity consolidation is real (deferred — roadmap risk #1); (c) a country mandate (§5.5 e-invoicing → e-ledger, à la Turkey e-Defter, competitor §2.13) makes the GL *compulsory infrastructure* — then ship it turn-key as a country pack. Tally proves a GL that hides all jargon can still be SIMPLE (competitor §2.8) — so *if* JENIFY builds one, it must be jargon-free and template-driven, never a chart-of-accounts the shopkeeper configures.

**Concrete path:** M2 = operational finance completion (payables, expenses, cash/bank, costing) + a **GL-export adapter capability** (`cap.finance.gl_export` — maps posted JENIFY documents to accounting-journal rows for the accountant's existing tool). Treat a native GL (`cap.finance.gl@full`) as a country-pack-gated Layer-3 capability, designed only when (a)/(b)/(c) above fires. **Do not design giant accounting scope now** (task constraint honored).

### E.5 Which sectors need which layer

| Sector | operational | advanced | GL |
|---|---|---|---|
| Retail/shop | yes | optional | export only |
| Wholesale | yes | yes (margins, payables scale) | export → native if multi-entity |
| Manufacturing (Mesob) | yes | yes (costing M2) | export first |
| Construction | yes | yes (project cost buckets, retention) | export; native if statutory |

### E.6 Roles / audit

**Finance** role owns the layer (existing `view_financial` mask, inv v, already hides money from unauthorised roles server-side). All money docs reversible not deletable (inv iv); balances derived from append-only series (inv i); integer cents (inv ii); every posting audited (inv v). No hard close — reversal + audited correction only.

### E.7 Open Founder questions (finance)

1. Confirm the **integrate-first / export-to-accountant** GL stance — or does the Ethiopian accountant channel make a *familiar native GL* a go-to-market asset worth building sooner? (This is competitor §7 Q1 + AFRICA_REQUIREMENTS §8 Q1, unresolved — a Founder + distribution-channel decision.)
2. Which external target first for `cap.finance.gl_export` — Peachtree/Sage-50 shape (Ethiopia install base) or QuickBooks/Tally? (Depends on Q1 channel choice.)
3. Cash-drawer + shift cash-up: M2 or M4? (Recommended: cash/bank accounts in M2 with payables; formal cash-up with the workforce-shift M5 attendance work.)
4. Fixed-asset depreciation (Spine C.9 Q2) — an advanced-finance concern; owned here, not in maintenance. Build only with GL/costing, not speculatively.

---

## 1. CROSS-CUTTING — build sequence, shared engine, dependency graph

### 1.1 The shared engine that emerged

**APPROVALS (Spine A) is the reusable engine.** All four spines submit documents to one approval state machine (procurement PO/requisition, maintenance work order, workforce leave/overtime, finance expense/budget-override/payment-run). Build `cap.approval.lite` ONCE, first; every other spine calls `submitForApproval / decide / isApproved`. A secondary reusable primitive also emerges: **task/work_assignment (Spine D)** is reused by maintenance WOs, deliveries, and production — build it once in Workspace-field, reference everywhere.

### 1.2 Dependency-ordered build sequence

```
0. cap.approval.lite            (needs only RBAC+audit+numbering — all exist)   ← FIRST, unblocks all
1. cap.procurement.lite         (PO → receive[existing] + bill)  requires: parties, inventory, approval.lite   ← M2, with costing
   └ cap.finance.operational    (payables, expenses, cash/bank)  requires: payments[exists], procurement
   └ cap.finance.advanced       (costing/COGS/margins/budgets)   requires: finance.operational, inventory   ← M2 core value
2. cap.finance.gl_export        (adapter to accountant's tool)   requires: finance.operational              ← M2/M3, the GL answer
3. cap.workforce.registry       (employees≠users; named operators) requires: tenancy+audit                  ← M5, smallest safe first
   └ cap.workforce.attendance   requires: workforce.registry
   └ cap.workforce.field(+task) requires: workforce.registry     ← task primitive others reuse
4. cap.asset.register           requires: locations, parties                                                 ← M5
   └ cap.maintenance.reactive   requires: asset.register, inventory[spares], approval.lite
   └ cap.maintenance.preventive requires: maintenance.reactive
5. cap.procurement.standard/full (RFQ→quote→compare, 3-way match)  ← only when construction/wholesale tenant validates
6. AI enhancements (procurement intel, predictive maintenance)     ← AI milestone only, jenify-ai-engineer, suggest-and-confirm
7. cap.finance.gl@full / cap.payroll.*  ← country-pack-gated, ONLY when statutory need verified (E.4 a/b/c, D.7)
```

Rationale: approvals first (cheapest, unblocks everything); procurement+finance next (M2 — closes the biggest hole, delivers margins, the #1 competitor demo-winner); workforce registry before assets (technician/operator = employee); assets/maintenance next; ceremony (full procurement) and statutory (GL/payroll) last and only on validated demand. This honors CLAUDE.md principle F (smallest safe milestone) and the anti-bloat rule (G).

### 1.3 What stays out of core (config/country-pack physics)

Payroll gross-to-net rules · tax/close/GL statutory presentation · mobile-money provider lists · sector task checklists · asset categories · expense categories · approval thresholds · pay bases. All are versioned config or country packs — never tenant literals in core (CLAUDE.md principle 3).

---

*End of design. No code written. Four spines + one shared APPROVALS engine + GL integrate-first recommendation delivered; dependency-ordered sequence in §1.2. Open Founder questions consolidated per spine (A.6, B.9, C.9, D.8, E.7) for the Team Lead to route.*
