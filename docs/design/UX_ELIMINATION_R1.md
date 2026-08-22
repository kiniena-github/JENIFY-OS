# JENIFY OS — UX Elimination Audit R1

> **UX ELIMINATION TEAM** · jenify-ux-engineer (frontend-ux depth) · 2026-08-21 · AUDIT ONLY — no code changed.
> Mission §37: the job is **removing friction, not adding features.** Every recommendation below is a *removal* (a screen, a field, a decision, a tap) or a *smart default* — never new scope.
> Grounded in the **currently shipped** React pages: `packages/web/src/pages/{Receiving,Sales,Payments,Deliveries,Production,Customers,Inventory,Reports,Setup}Page.tsx`, `components/Layout.tsx`, `components/offline.tsx`, `App.tsx`, `styles.css`. Every claim cites a file:line.
> Builds on R5 (`docs/research/ROLE_EXPERIENCE_SIMPLICITY.md`) and R10 (`docs/research/MOBILE_LOWEND_UX.md`); this report is the **code-level walk** those set up.

---

## 0. Counting convention & scoring

One **interaction** = one tap on a control **or** one field filled (typing a value = 1 regardless of length; a `<select>` on desktop = 2: open + choose). Counts start from the role's landing screen, **signed in, before nav** — and nav itself is counted separately because eliminating it (role homes, W1-A2) is one of the biggest wins.

Per workflow we report four hard numbers:

- **Steps** = distinct screens/panels/modals traversed.
- **Clicks** = interactions per the convention above (nav included, shown split).
- **Req. fields** = fields the submit button actually blocks on (the real friction, not the visible count).
- **Typing** = free-text/number inputs the user must key by hand (the phone-keyboard tax, worst in Ethiopic — R10 §D.4).

Priority = **frequency × pain**. Receiving and Sales happen many times daily → top priority. Production/Deliveries several times daily. Payments a few times daily. Add-customer is near-setup (once per customer) → lowest.

---

## 1. RECEIVE STOCK — `ReceivingPage.tsx` · WAREHOUSE · **HIGHEST PRIORITY (constant × gate/phone pain)**

### Current friction (measured from code)

The new-receiving form (`ReceivingPage.tsx:142-218`) renders **11 visible fields** in one `form-grid`:
supplier `:143`, material `:153` (auto-defaults to `items.data[0]` via `effItemId` `:37`), source `:162` (read-only, derived from item attributes `:38,163`), truck `:165`, driver `:168`, date `:171` (defaults `todayIso()` `:26`), unit `:174` (auto-defaults to tonnes `t` `:40`), gross qty `:183` (optional), net qty `:192`, warehouse `:205`, remarks `:215` (optional).

The submit buttons block on **5 fields**: `!supplierId || !netQty || !warehouseId || !truckNumber || !driverName` (`:222,230`).

| Metric | Value | Detail |
|---|---|---|
| Steps | 1 | single inline form |
| Clicks | **~9** | nav 1 · supplier select 2 · truck 1 · driver 1 · net 1 · warehouse select 2 · Save&approve 1 |
| Req. fields | **5** | supplier, truck, driver, net, warehouse (item/unit/date/source already defaulted — good) |
| Typing | **3** | truck no., driver name, net qty |

### Eliminations (specific)

1. **Auto-select the supplier when there is one active supplier** — exactly as `material` already auto-picks `items.data?.[0]` (`:37`). Mesob receives raw salt from a dominant source; when `suppliers.data.length === 1`, default `supplierId` to it; otherwise default to the **user's last-used supplier** (sticky). **−2 clicks.** Cite `:144`.
2. **Default the warehouse to the user's home/last raw-material warehouse.** The page already knows the warehouse set (`warehouses.data`, stat card `:127-131`); receiving almost always lands in one raw store. Default `warehouseId` to last-used-by-this-user; auto-pick when only one raw warehouse exists. **−2 clicks.** Cite `:206`.
3. **Repeat-last truck + driver as a one-tap prefill.** The same truck/driver return trip after trip; offer "same as last receipt" prefill (driver often rides with a known truck). Turns 2 typed fields into 0–1 taps. **−1 to −2 typing.** Cite `:166,169`.
4. **Hide `gross` and `remarks` behind progressive disclosure for the warehouse role.** Gross (`:183`) is optional and only meaningful where a second weighing happens; remarks (`:215`) is rarely used. Collapse both behind "More" so the worker sees ~5 fields, not 11. Field-hiding is a **role-experience** concern, not a data change. Cite `:183,215`.
5. **Source field should not render as an input at all for workers.** It is already read-only and derived (`:162-164`); show it as a small labelled chip in the confirm summary, not a form row. **−1 visible field.**

### Reduced target

| Metric | Now | After | How |
|---|---|---|---|
| Clicks | ~9 | **~4** | nav→0 (role home, W1-A2) · supplier/warehouse defaulted · truck/driver repeat-last · net 1 · confirm 1 |
| Req. fields | 5 | **1 keyed (net)** + confirmed defaults | supplier/warehouse/truck/driver all defaulted-or-prefilled |
| Typing | 3 | **1** (net qty — the one thing only the gate knows) |

### WORKER-ON-A-PHONE flag — **the single hardest current screen**

Receiving is done at the gate, on a phone, on congested/no signal, by the lowest-literacy role (R10 §A/B). Yet it is shipped as an **11-field desktop `form-grid`** with six `<select>` dropdowns and a submit that lives below a long scroll. On mobile the inputs are bumped to 44 px and buttons to 48 px (`styles.css:342-344`) — targets are fine — but the **form shape is wrong**: a scrolling grid of dropdowns, not a card/step flow with lookup-first pickers and one big POST (R10 §C.2/C.3). This is exactly the screen W1-A3 (Offline Receiving) is rebuilding — so the reduced 4-click card flow above must be **what A3 ships**, not the desktop grid wrapped in a queue.

---

## 2. CREATE A SALE / INVOICE — `SalesPage.tsx` · SALES · **HIGH PRIORITY (constant)**

### Current friction

Header block (`:229-285`): customer `:229`, price category `:247` (auto-derived from the customer's `defaultPriceCategory` via `effCategory` `:65-70`, and **disabled** for non-approvers `:250` — already excellent), payment type `:260` (defaults `'paid'` `:47`), amount-paid `:267` (only if partial), due-date `:272` (only if not paid), fulfillment `:277` (defaults `'delivery'` `:50`), notes `:283`.
Line block, 1 line by default (`:52-54`, rendered `:289-377`): product `:296`, warehouse `:313`, quantity `:323`, unit `:330` (auto-set from the item's base UoM on product-select `:302`), unit price `:340` (financial roles only; placeholder = list price `:349`; disabled for non-approvers `:351`), discount `:356` (financial+approver only).
Payment is **auto-recorded** when a "paid" sale confirms (`:154-165`) — a genuine strength; protect it.

Repeat one-line cash sale (`paymentTerm='paid'`, customer has a default category):

| Metric | Value | Detail |
|---|---|---|
| Steps | 1 | inline form |
| Clicks | **~9** | nav 1 · customer 2 · product 2 · warehouse 2 · qty 1 · Confirm 1 (category/payment/fulfillment/unit/price all defaulted) |
| Req. fields | **4** | customer, product, warehouse, qty (`formReady`/`linesReady` `:115-127`) |
| Typing | **1** | quantity |

### Eliminations

1. **Default the line `warehouseId` to the single finished-goods warehouse (or user's last).** This is the biggest single sales win: warehouse is asked **per line** (`:313`) yet finished salt ships from essentially one store. Prefill it the way the unit already auto-fills from the item (`:302`). **−2 clicks per line.** Cite `:313-321`.
2. **Lookup-first / most-sold tiles for the product picker.** Today it is a full `<select>` of every sellable item (`:296-311`). For a phone cashier, render the top-N most-sold items as tap tiles (R10 §C.1 Square pattern); keep the dropdown as the "more" path. Removes a dropdown open+scan for the 80% case. Cite `:296`.
3. **Remember `fulfillment` per customer.** Some customers always pick up, some always take delivery; default `fulfillment` (`:277`, currently always `'delivery'`) from the customer's history instead of a global constant. Removes a silent wrong-default correction, not a required tap — small but real.
4. **Keep price category disabled+derived — do not "simplify" it away.** `:250` already hides the decision from non-approvers while showing the value; this is the model to replicate elsewhere, not to remove.

### Reduced target

| Metric | Now | After | How |
|---|---|---|---|
| Clicks | ~9 | **~5** | nav→0 (role home) · customer 2 · product tile 1 · qty 1 · Confirm 1 (warehouse defaulted) |
| Req. fields | 4 | **3** (customer, product, qty) | warehouse defaulted |
| Typing | 1 | **1** (qty) | unchanged — qty is irreducible |

### Phone flag
The line row is a 4–6 column `form-grid` (`:295`) that reflows to a tall stack on mobile; the per-line **✕ remove** and **+ Add line** are `btn-sm` (`:370,379`). Acceptable, but the multi-line invoice is a desktop shape — a cashier needs one product + qty + PAY, with extra lines behind an explicit "add another".

---

## 3. COMPLETE A PRODUCTION STAGE — `ProductionPage.tsx` · PRODUCTION OPERATOR · **HIGH PRIORITY (several/day, low-literacy role)**

### Current friction

`ProductionPage` shows **every stage as a tab** to everyone (`:34-44`) — an operator assigned to one stage still scans all tabs. Completing an open batch: row **Complete** (`:198`) opens `CompleteModal` (`:615-671`) → `OutputFields` (`:316-388`): for a bulk *measured* stage, output quantity kg `:353` (required); for *conserved*, nothing (auto = input, `:343-351`); for a *packed* stage, product `:358` + units produced `:368` + rejected `:371` + destination warehouse `:374`. Plus **operator** `:654` and **supervisor** `:657` free-text names (pre-filled from the batch if present `:624-625`).

Complete a bulk measured batch:

| Metric | Value | Detail |
|---|---|---|
| Steps | 2 | stage panel → Complete modal |
| Clicks | **~5** | nav 1 · stage tab 1 (if not active) · Complete 1 · output qty 1 · Complete batch 1 |
| Req. fields | **1** | output qty (`outputReady` `:414-422`); conserved stage = **0** |
| Typing | **1–3** | output qty + (operator, supervisor if not prefilled) |

### Eliminations

1. **Default `operatorName` to the logged-in user.** Both the new-batch form (`:586`) and the complete modal (`:654`) ask the operator to **type their own name every batch** — pure friction and an audit weakness (free text, misspellable). The operator is almost always the signed-in user; default `state.operatorName` to `user.displayName`. This is the R5 §4.10 "HR-lite replaces free-text operator" finding, at its cheapest. **−1 typing every batch.** Cite `:586,654`.
2. **Show the operator only their own stage; drop the tab row for single-stage roles.** The all-stages tab bar (`:34-44`) is a supervisor tool. For an operator, land on their stage (W1-A2 focus) and hide the others. **−1 click** and removes a wrong-stage error class.
3. **Fold the modal back into the row for the common Complete.** `CompleteModal` re-renders the same `OutputFields` a second time (`:653`) after the row already showed the batch; for a bulk stage with one qty, an inline expand ("enter output → Complete") avoids a modal that traps the software keyboard on a phone (R10 §C.3). Removes 1 screen.
4. **Supervisor field: hidden unless the stage/role requires a second signer.** `:589,657` — most operator completions don't need a separate supervisor name; surface it only where the stage config demands review.

### Reduced target: **~3 clicks** (stage home → output qty → Complete), **0–1 typing** (output qty only; operator defaulted).

---

## 4. RECORD A PAYMENT — `PaymentsPage.tsx` · FINANCE · **MEDIUM PRIORITY (few/day, literate role)**

### Current friction — already lean; deliberately two-step for audit

`NewPaymentForm` (`:187-328`): customer `:259`, amount `:269`, currency `:280` (only shown if foreign currencies configured `:213`), method `:293` (defaults `'cash'` `:206`), date `:302` (defaults today `:208`), reference `:305` (**required only for non-cash** `:220,307` — correctly conditional), notes `:312`. Posting a payment (`:222-248`) then **auto-opens the Allocate modal** via `justPostedId`/`useEffect` (`:28-35,242`), and the allocation is **pre-suggested oldest-first** (`AllocateModal` `:339-351`) so Apply is one tap.

Record + allocate a cash payment:

| Metric | Value | Detail |
|---|---|---|
| Steps | 2 | record form → allocate modal (both intentional; M-Pesa confirm-before-post is sacred, R10 §C.4) |
| Clicks | **~6** | nav 1 · customer 2 · amount 1 · Post 1 · Apply 1 (method/date defaulted, allocation pre-filled) |
| Req. fields | **2** | customer, amount (`:319`) |
| Typing | **1** | amount |

### Eliminations (light — this flow is close to optimal)

1. **Keep the two-step; do not collapse it.** The post→allocate split is an immutability/audit feature, not friction to remove (CLAUDE.md §5). The pre-suggestion already does the heavy lifting.
2. **When exactly one open invoice matches the amount, pre-fill Apply to it and keep the confirm.** Already effectively done by the oldest-first suggestion (`:342-350`); ensure the single-invoice case lands 100% pre-filled so Apply is a pure confirm, never a re-type.
3. **Reference field placement is correct** (`refRequired` `:220`) — cite as the pattern for conditional-required done right; nothing to remove.

### Reduced target: **~5 clicks** (customer defaulted from context where a statement was opened; otherwise unchanged). Lower ROI than Receiving/Sales — leave mostly as-is.

---

## 5. CONFIRM A DELIVERY — `DeliveriesPage.tsx` · WAREHOUSE / DRIVER · **MEDIUM PRIORITY (several/day; driver = phone-only)**

### Current friction

**Dispatch** is already ideal: row **Dispatch** (`:106`) calls `act()` directly (`:100`), no modal → **nav 1 + 1 = 2 clicks.** Protect this.

**Mark delivered**: row **Delivered** (`:111`) → `DeliveredModal` (`:336-389`): actual date `:363` (defaults today `:338`), **received-by** `:372` (required, free text `:383`), notes `:375`.

| Flow | Clicks | Req. fields | Typing |
|---|---|---|---|
| Dispatch | **2** | 0 | 0 |
| Mark delivered | **~4** | 1 (received-by `:383`) | **1 (received-by — typed on the driver's phone)** |

`CreateDeliveryModal` (`:187-277`) is warehouse-side, 6 fields: linked invoice `:236`, destination `:246`, truck `:249`, driver name `:252`, driver phone `:255`, expected date `:258` (all required unless pickup `:206-210`).

### Eliminations

1. **Default `destination` from the customer's `location`.** The create-delivery destination (`:246`) and details destination (`:308`) are typed fresh, but the linked invoice's customer already has a `location` on the party record (`CustomersPage.tsx:229`). Prefill it, editable. **−1 typing.**
2. **Repeat-last truck/driver/phone on create-delivery** (`:249-256`) — same fleet trip after trip, mirror the Receiving repeat-last. **−up to 3 typing.**
3. **Make "received-by" optional, or default it to the customer contact.** On the driver's phone (R10 §D.4, zero-required-Ethiopic-typing rule) a **required** free-text name (`:372,383`) is the worst kind of field. The delivery is already attributed to the driver; make received-by optional, or prefill the customer's contact name with edit. This is the one delivery elimination that matters for the future driver role. **−1 required typing.**
4. **Default `expectedDate` to today (or invoice due date)** instead of blank-required (`:258` currently forces a pick).

### Reduced target: dispatch stays **2**; mark-delivered → **~2** (Delivered → confirm), **0 required typing**.

---

## 6. ADD A CUSTOMER — `CustomersPage.tsx` · SALES · **LOW PRIORITY (near-setup, once per customer)**

### Current friction

`CustomerModal` (`:145-287`): name `:214`, type `:217` (defaults `'retailer'` `:164`), phone `:226`, location `:229`, tax info `:232`, default price category `:235` (optional), credit limit `:250` (financial+approver only, `:192,261`), notes `:265`, status `:268` (edit only). Save blocks on `name && phone && location` (`:281`).

| Metric | Value | Detail |
|---|---|---|
| Steps | 1 | modal |
| Clicks | **~5** | Add 1 · name 1 · phone 1 · location 1 · Save 1 (type defaulted) |
| Req. fields | **3** | name, phone, location |
| Typing | **3** | name, phone, location |

### Eliminations

1. **Auto-derive `defaultPriceCategory` from `partyType`** (retailer→retail, wholesaler→wholesale, distributor→distributor) as the pre-selected value (`:235-249`), so the user never sets it and Sales still gets a correct category default (`SalesPage.tsx:65`). Removes an optional-but-consequential decision.
2. **Nothing else worth removing** — name/phone/location are irreducible identity typed once. This flow is correctly lean; its low frequency means it is **not** where elimination effort belongs.

---

## 7. Cross-cutting findings (apply to every workflow above)

1. **Every role lands on the same generic Dashboard.** `App.tsx:45` routes the index to `DashboardPage` for all roles; `dashboardFocus` exists in the DB (`packages/server/src/db/schema.ts:57`) and is emitted by the permissions service (`services/permissions.ts:32,46`) but **read nowhere in `packages/web`**. Result: the "nav 1" tax is paid at the start of *every* workflow above. This is the cheapest high-value removal in the codebase and is precisely W1-A2's job.
2. **Nav over-shows for the roles that need least.** All of Receiving, Inventory, and Empty Sacks gate on the same `module: 'inventory'` with the default `'view'` action (`Layout.tsx:19,20,27,76`) — `NavEntry.action` is optional and unset, so any role with `inventory.view` sees all three. A Sales officer carries Receiving + Empty Sacks in the sidebar. Fix is presentational only (per-entry required action), and belongs in W1-A2.
3. **The mobile substrate exists but is unconfigured.** `Layout.tsx:178-191` already ships a role-scoped **bottom nav** (first 4 permitted modules + More) at ≥56 px (`styles.css:372`); mobile bumps controls to 44–48 px (`styles.css:342-344`). The R5-era "28 px buttons" claim is now **outdated** on mobile — targets are Material-grade. The remaining mobile friction is **shape, not size**: 11-field `form-grid`s, `table-wrap` horizontal-scroll tables (`ReceivingPage.tsx:245`, every page), multi-button row-action clusters, and keyboard-trapping modals. The bottom-nav comment (`:173-177`) explicitly names the Role Experience Engine (W1-A2) as the thing that will configure this substrate.
4. **The offline sync vocabulary is already defined and unused.** `components/offline.tsx:31-45` defines the five honest states (`local | pending | synced | conflict | failed`) and `OfflineBanner`; only connectivity is wired today (`:16-29`). W1-A3 must render receiving drafts with these exact badges — no new vocabulary.
5. **Free-text where a record should exist.** Operator/supervisor names (`ProductionPage.tsx:586,589`), driver/received-by (`DeliveriesPage.tsx:252,372`) are all hand-typed strings — friction on a phone *and* weak audit. Defaulting operator→logged-in-user and received-by→customer-contact removes typing and strengthens the trail simultaneously.

---

## 8. Requirements handed to the builds in flight

### → W1-A2 Role Experience Engine (permission ≠ experience)
These eliminations **are** the engine's spec, not extras:

- **R-A2.1 — Role homes (kills "nav 1" everywhere).** Wire `dashboardFocus` (`schema.ts:57`, `permissions.ts:32`) into the index route (`App.tsx:45`): warehouse→receiving/awaiting-action, sales→sales, production→their stage, finance→payments; owner keeps Dashboard. Removes the leading nav click from workflows §1–§5.
- **R-A2.2 — Per-role field hiding as configuration.** Hide `gross`+`remarks` (Receiving), `supervisor` (Production), price/discount (already done for non-financial) per the effective-experience spec — the depth stays server-side, the worker sees fewer fields (R5 corollary 5).
- **R-A2.3 — Single-stage operator view.** Production operator sees only their assigned stage; hide the all-stages tab bar (`ProductionPage.tsx:34-44`) for single-stage roles.
- **R-A2.4 — Nav de-noising.** Honor a per-entry required action so Receiving/Sacks stop showing for Sales (`Layout.tsx:19,27,76`); worker nav ≤5 (R10 §C.2). Presentation only; RBAC untouched.
- **R-A2.5 — `operatorName` defaults to the signed-in user** (`ProductionPage.tsx:586,654`); received-by defaults to customer contact (`DeliveriesPage.tsx:372`). The experience layer is where "who is acting" is known.
- **R-A2.6 — Warehouse/supplier defaults are per-role/per-user context** — the natural home for "this warehouse role's default raw store / finished store" that eliminations §1.2 and §2.1 depend on.

### → W1-A3 Offline Receiving (client queue + idempotent replay)
The receiving eliminations must land **inside** A3 so the offline form is already the reduced form — not the 11-field desktop grid wrapped in a queue:

- **R-A3.1 — Ship the ~4-click card flow of §1, not the current `form-grid`.** Supplier + warehouse auto-defaulted, truck/driver repeat-last, one keyed field (net qty), one big POST. Lookup-first pickers, 48/56 px targets (R10 §C.2).
- **R-A3.2 — Render drafts with the five `SyncStatusBadge` states** from `offline.tsx:31-45`; never show "saved" until the server confirms (honesty contract, `offline.tsx:4-14`).
- **R-A3.3 — Draft persistence survives tab eviction** (R10 §A.3.5) — an in-progress gate receipt must not vanish when the worker takes a call.
- **R-A3.4 — Progressive disclosure of gross/remarks** so the offline card stays ~5 fields; the reduced field set is what gets queued.

---

## 9. Priority ladder (frequency × pain)

| Rank | Workflow | Now (clicks / req / typing) | After | Where it lands |
|---|---|---|---|---|
| 1 | **Receive stock** | 9 / 5 / 3 | **4 / 1 / 1** | **W1-A3** (+A2 defaults) |
| 2 | **Create sale** | 9 / 4 / 1 | **5 / 3 / 1** | W1-A2 (warehouse default, role home) |
| 3 | **Complete stage** | 5 / 1 / 1–3 | **3 / 1 / 0–1** | **W1-A2** (operator default, single-stage home) |
| 4 | **Mark delivered** | 4 / 1 / 1 | **2 / 0 / 0** | W1-A2 (received-by default) |
| 5 | Record payment | 6 / 2 / 1 | ~5 / 2 / 1 | already lean — protect |
| 6 | Add customer | 5 / 3 / 3 | 5 / 3 / 3 | low ROI — derive category only |

**Do-no-harm list (strengths to protect, never "simplify" away):** payment auto-recorded with a paid sale (`SalesPage.tsx:154-165`); price category derived + disabled for non-approvers (`:250`); confirm-before-post on money/stock (payments two-step, `ReasonDialog` on reversals); server-side financial masking (`canFinancial` gating throughout); direct-action Dispatch with no modal (`DeliveriesPage.tsx:106`); oldest-first allocation pre-suggestion (`PaymentsPage.tsx:342-350`).

