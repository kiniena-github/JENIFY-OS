# JENIFY OS — Sector Blueprint: Retail (Tiny-Shop Mode)

> Sector design blueprint · 2026-08-22 · **DESIGN ONLY — no code changed.**
> Author: jenify-template-engineer (with frontend-ux depth), for Team Lead synthesis.
> Grounded in: `docs/research/AFRICA_SECTOR_PRIORITY.md` §4.3 (Retail, rank 3), `docs/research/ROLE_EXPERIENCE_SIMPLICITY.md` (R5 — Cashier profile §4.3, JENIFY rule §1), `docs/research/MOBILE_LOWEND_UX.md` (R10 — worker mode §C.6, Khatabook/OkCredit §C.1, budgets §E.1), `docs/research/OFFLINE_SYNC_ARCHITECTURE.md` (O1/O2 contract, entity classes §D.1), `docs/FACTORY_OS_CURRENT_STATE.md` §2/§6, `packages/shared/src/index.ts` (MODULES/ACTIONS/DOC_LIFECYCLE), `packages/server/src/services` (sales, payments, simpletxn, receiving, creditview).
> Companion blueprint: `docs/design/SECTOR_WHOLESALE.md` (same trade spine, different toggles — the two templates form one family per AFRICA_SECTOR_PRIORITY §5.1).

---

## 0. Mission rule

> **The tiny retailer must never feel like they are using an ERP.**
> Target user: a shop owner who has never used business software — possibly never used any app beyond Telebirr and WhatsApp. Training target: **first unaided sale within 10 minutes; every feature discoverable without a manual** (stricter than R5's ≤60-minute worker bar, because there is no trainer — the app *is* the trainer).

Judged by the five principles: FAST (a sale in ≤3 taps, <15 s), SIMPLE (five words on screen, ever), FLEXIBLE (the full JENIFY spine is underneath — the shop can grow into a wholesaler without migrating), LOCAL (sells with zero connectivity), INTELLIGENT (the app remembers items, prices, customers, and debts so the seller doesn't).

The design law from R5 applies at maximum strength: **functional depth must not equal UI complexity.** Tiny-shop mode is not a lite product or a fork — it is the existing JENIFY core wearing its smallest possible face: a presentation profile + a sector template configuration. Every tap posts through the same services, permissions, ledger, and audit trail as Mesob's factory.

---

## 1. The five-concept experience

The seller sees exactly five words, as a bottom navigation bar (≤5 destinations, thumb zone — R10 §C.2). No sidebar, no modules, no settings icon on the worker path.

| Concept | What the seller thinks it is | What it actually is underneath |
|---|---|---|
| **SELL** | "Ring up what the customer buys" | `sales_invoices` + `invoice_lines` (FIFO issue, pricing snapshot, optional VAT) posted with integral payment — the existing sale+payment single flow (`SalesPage.tsx:155-165` pattern), server-side stock movement, audit |
| **STOCK** | "What I have on the shelf" | Items + one warehouse + append-only `stock_movements` / derived `stock_balances`; "Stock in" = a simplified `goods_receipts` posting; low-stock = the computed-alerts framework + reorder points (M4) |
| **CUSTOMERS** | "My debt book (people who owe me)" | `parties` + credit module (`creditview.ts` outstanding/overdue) + `payments` with oldest-first auto-allocation — the Khatabook/OkCredit khata, running on a real receivables ledger |
| **EXPENSES** | "Money I spent today" | **NEW** small expense record (§7 E1) — categorized cash-out entries feeding the day's cash position; not a general ledger |
| **MONEY** | "How did I do today?" | Owner dashboard scoped to retail: today's sales, cash position (cash in − expenses − payouts), method split, top debtors, low stock — existing `dashboard.ts`/`reports.ts` reads + shift aggregation |

Rules that keep it feeling like a notebook, not an ERP:

1. **Vocabulary is market-language, delivered via the existing terminology/i18n layer** (`translation_keys`/`translations`). "Invoice" → "Sale". "Party" → "Customer". "Goods receipt" → "Stock in". "Payment allocation" never appears — the seller sees "Abebe paid 200". Zero new i18n machinery; this is exactly what the editable-terminology framework was built for. Amharic/Tigrinya per T8 rules: numerals carry meaning, no jargon even translated (R5 §2.2).
2. **No draft state on the seller path.** `DOC_LIFECYCLE` keeps draft→posted underneath, but tiny-shop UI collapses it: confirm = post. Mistakes are fixed by reversal (owner action), never by editing a posted sale — invariant §3.9 of CURRENT_STATE holds untouched.
3. **One warehouse ("My Shop"), no transfers, no lots, no reservations, no production** — all present in core, all switched off by template config (§8).
4. **Zero required typing for a sale.** Tiles, pickers, and a number pad carry the whole flow (R10 §D.4's zero-required-Ethiopic-typing rule). Free text exists only for optional notes and new-item/customer names.

### What the seller sees on a 2 GB Android Go phone

- The same React PWA, in the **worker-mode presentation profile** (R10 §C.6): bottom nav of the five words, full-screen step flows, card lists, ≥48 px targets (56 px primary), 18–20 px primary text, numerals-first.
- **SELL is the home screen** — the app opens ready to sell (R5 corollary 1: the most common task starts on the landing screen). A grid of item tiles (photo or auto-colored initial + name + price), most-sold first (Square quick-service pattern, R5 §2.1), search field on top, camera-scan button in the same field (scan-shaped input, hardware later).
- All R10 §E.1 budgets bind: initial route ≤75 kB gzip, route chunk ≤40 kB, INP <200 ms at 6× CPU throttle, shift data <2 MB, no CDN assets, Noto Sans Ethiopic shipped locally. Tile photos are thumbnail-sized, cached, and never on the posting critical path.
- Draft persistence for the in-progress cart (Android Go evicts backgrounded tabs — R10 §A.3.5): a half-built sale survives answering a phone call.

---

## 2. POS flow — SELL

### 2.1 Fast sale (common item, cash): ≤3 taps

```
Tap 1: item tile            (qty 1 assumed; tap again = qty 2; long-press = number pad)
Tap 2: CASH                 (method row: CASH · MOBILE MONEY · DEBT — big buttons)
Tap 3: CONFIRM  ETB 40      (one screen: items, qty, total in huge numerals, change calculator)
        └─ posts invoice + payment + stock movement in one server transaction
```

- The confirm screen is sacred (M-PESA pattern, R5 §2.2 / R10 §C.6.2): what, how much, method, cancel. It is also where cash-tendered/change lives (seller types cash given, change shows huge — optional, skippable).
- Multi-item sale: keep tapping tiles; running total pinned at bottom; same 2 closing taps.
- **Price override:** haggling is normal in this market. Default template config: seller may adjust line price downward within a configurable % band; beyond the band requires the `sales.approve`-gated override (mechanism exists). Owner-operator effectively has free pricing; a hired cashier does not. Band value = tenant config, not code.
- Time budget: common cash sale **<15 s** (tighter than R5's cashier 45 s because tiny-shop tiles skip customer selection — cash sales are anonymous walk-ins by default; a generic "Walk-in customer" party absorbs them).

### 2.2 Payment methods

| Method | Flow | Underneath |
|---|---|---|
| **CASH** | Tap CASH → confirm | `payments` method `cash` — reference optional (already the code's policy, `payments.ts referenceRequired`) |
| **MOBILE MONEY** (Telebirr / M-PESA) | Tap MOBILE MONEY → confirm; optional short reference field | `payments` electronic method; the existing tenant setting that makes references optional per method is preset in the retail template so a missing ref never blocks a sale at the counter |
| **DEBT** (credit sale) | Tap DEBT → pick customer (recent-first lookup, 3-letter search) → confirm shows **"Abebe now owes ETB 240"** | Sales invoice posted unpaid; balance = existing outstanding computation. No allocation UI ever shown |

### 2.3 The debt book — CUSTOMERS (culturally central)

Khatabook/OkCredit won tier-2/3 merchants by **digitizing the khata habit, not teaching accounting** (R10 §C.1). Tiny-shop CUSTOMERS is that ledger, backed by real invoices:

- **Customer list = the debt book**: name, phone, balance in red ("owes you 240") or green (settled/advance), last activity. Sorted by balance descending — the top of the list is the collection worklist.
- **Customer page = two buttons + a story**: "GOT PAID" and "GAVE ON CREDIT" above a dated running-balance history (each entry: date, items or "payment", amount, running balance). GOT PAID posts a payment auto-allocated oldest-first — the word "allocation" never appears. GAVE ON CREDIT jumps into the SELL flow with the customer pre-attached.
- **Reminders**: "Remind" button composes an SMS/WhatsApp share with the balance ("You owe Mesob Shop ETB 240 — pay via Telebirr 09xx"). v1 = device share sheet (zero infrastructure, zero cost to us); automated SMS is a country-pack integration later.
- **Credit limit as a soft warning by default**: the core's hard credit-limit block (with `sales.approve` override) stays available, but the retail template defaults to warn-not-block — tiny retailers manage trust personally; a hard block at the counter in front of a neighbor is a product-killer. Formal shops flip the toggle. (Founder question §10.5.)
- **Statement share-as-image**: the existing print subsystem renders the customer statement; tiny-shop adds render-to-image + Web Share (§7 N4).

### 2.4 Returns

- Returns/credit notes are an M4 gap (CURRENT_STATE §6). Tiny-shop v1 ships without partial returns but **with same-day sale reversal**: owner (or `sales.approve` holder) opens the sale from MONEY → today's sales → "Undo sale" with reason — the existing posted→reversed lifecycle, restocking via reversing movements. Honest, audited, and covers the dominant tiny-shop case ("wrong item, customer at the counter").
- Partial returns / exchange / restock-vs-damage land with M4 credit notes; the POS surface then gains a "RETURN" verb inside SELL, never a sixth bottom-nav concept.

### 2.5 Receipts

- **Share-as-image is the primary receipt** (WhatsApp/Telegram share is how receipts move in this market); print is optional. The existing print subsystem (branding snapshots, numbering) renders the receipt; a small client renderer converts it to an image for the share sheet (§7 N4).
- Paper: 58 mm Bluetooth thermal printer support is a later hardware integration (same shape as wholesale's printer needs — shared build). No receipt is ever required to complete a sale.
- Fiscal receipts: Ethiopia mandates fiscal devices for the formal retail tier (AFRICA_SECTOR_PRIORITY §4.3/§5.5). Tiny-shop v1 targets the informal/semi-formal tier without fiscal integration; a fiscal country pack is the gate to the formal tier. (Founder question §10.3.)

---

## 3. Products & stock — STOCK

- **Item creation in one screen**: name (any keyboard/language), price, optional photo (camera, thumbnailed client-side), optional barcode (camera scan fills the field), optional low-stock level, optional cost (dormant until M2 costing). Unit defaults to "piece"; UoM machinery stays beneath for shops selling by kg/liter.
- **Lookup order**: tiles (top sellers) → 3-letter search (name, normalized for Ethiopic wordspace variants per R10 §D.4) → camera barcode scan. Barcode is an accelerator, never a requirement — most tiny-shop goods carry EAN barcodes (packaged FMCG), most services and loose goods don't.
- **Stock in**: one screen — item, qty, optional "from" (free supplier pick or none), optional unit cost (M2). Posts a simplified goods receipt. No PO matching, no QC, no lots — all off by template.
- **Low-stock**: per-item minimum level; STOCK tab shows a red "Running low (3)" band on top; MONEY shows the count. Reuses the computed-alerts framework; needs the M4 reorder-point field. Until M4, v1 can ship a template-level interim (min level on the item + a filtered stock view) — flag for architect review rather than fork the alert model.
- **Stock adjust ("count correction")**: owner-only, reason required, posts an `adjustment` movement (type declared in core, unemitted — M4 activates it). Until then, owner corrections go through stock-in/reversal honestly.
- **What STOCK never shows**: valuation, margins (until M2), movements ledger jargon, warehouse pickers.

---

## 4. Cashier shifts, expenses, owner dashboard

### 4.1 Shifts (NEW — needed the moment a shop has staff)

A **till session**: OPEN (declare opening float) → all sales/payments/expenses auto-attributed → CLOSE (count cash, variance computed, short note). Owner sees per-shift: sales by method, expected vs counted cash, variance. Owner-operator mode auto-opens a daily session silently — the owner never sees the word "shift", just "Today".

- Design shape: a first-class `till_sessions` object under the payments module (open/close as gated actions in the fine-grained action pattern, like `delivery: ['load','dispatch']`). Append-only close; reopen = audited owner action. This is the same object wholesale van-reconciliation needs — **build once in core, both sector templates consume it.**

### 4.2 Expenses (NEW — small, deliberately not accounting)

"Paid 300 for transport" in ≤4 taps: EXPENSES → category tile (transport/rent/electricity/purchases/other — template-seeded, tenant-editable) → amount pad → confirm. Posts an expense record attributed to the till session; photo-of-receipt attachment later (the dormant `attachments` table is the natural home — T5). Not a general ledger (that ceiling is a known platform question, AFRICA_SECTOR_PRIORITY §5.4); it exists so MONEY can answer "where did my cash go" — the #1 tiny-retail anxiety.

### 4.3 Owner dashboard — MONEY

Banking-app grammar (R5 §2.3): position first, zero data entry on the home path.

- **Today** (huge numerals): sales total · cash in hand (float + cash sales + debts collected − expenses − cash lifted) · sales by method · profit placeholder (lights up at M2 costing).
- **Debt book summary**: total owed to me, top 5 debtors (tap → customer page), overdue amount (red).
- **Stock**: low-stock count (tap → filtered list), today's stock-ins.
- **Staff view** (multi-staff shops): open shift status, last variance.
- Weekly/monthly roll-ups and best/dead sellers live one tap deeper in the existing reports module, relabeled ("This month", "Best sellers") — export stays owner-gated.

---

## 5. Mapping to existing JENIFY capabilities

| Tiny-shop capability | Verdict | Existing spine used |
|---|---|---|
| Sale posting, pricing snapshots, VAT, FIFO stock issue | **REUSE** | `sales.ts`, `invoice_lines`, stock ledger |
| Sale+payment in one flow | **REUSE** | existing paid-sale auto-payment pattern |
| Cash / mobile-money / reference policy | **REUSE** | `payments.ts` + per-method reference setting |
| Debt book balances, overdue, statements | **REUSE** | `parties`, credit module, `creditview.ts`, payment allocations (auto, hidden) |
| Stock in | **REUSE** | `receiving.ts` simplified form |
| Reversal ("undo sale") | **REUSE** | posted→reversed lifecycle |
| Receipts, numbering, branding | **REUSE** | print subsystem + `document_sequences` |
| RBAC, audit, i18n/terminology, versioned settings | **REUSE** | core, unchanged |
| Owner dashboard reads | **REUSE + extend** | `dashboard.ts`, `reports.ts`, retail widget set |
| POS-mode UI (tiles, bottom nav, confirm screens) | **NEW — frontend** | worker-mode presentation profile (R10 §C.6); no new server rules |
| Till sessions / cashier shifts | **NEW — core object** | payments-module extension; shared with wholesale van reconciliation |
| Expenses | **NEW — small core object** | feeds MONEY; not a GL |
| Item barcode field + camera scan + item photos | **NEW — small** | items extension + client scan; photos via `attachments` (T5) |
| Share-as-image receipts/statements | **NEW — frontend-only** | render print view → image → Web Share |
| Low-stock levels / reorder alerts | **M4 dependency** | alert framework exists; reorder-point field doesn't |
| Partial returns / credit notes | **M4 dependency** | v1 = same-day reversal |
| Margins/profit on MONEY | **M2 dependency** | costing absent by design |
| Offline sale capture | **O1/O2 dependency** | §9 |
| PIN fast user-switch (shared device) | **NEW — session feature** | R10 §C.6.4; depends on D10 session hardening |

Everything in the NEW column is core-vs-config clean: till sessions, expenses, and barcode land in **core** (any sector may use them); tile layouts, five-concept nav, vocabulary, toggles, and defaults land in the **retail sector template**; nothing tenant-specific enters core.

---

## 6. Role experiences

### 6.1 Owner-operator (one person = everything) — the launch persona

- One user, full permissions, tiny-shop mode. SELL is home; MONEY is one tap. Shifts auto-managed invisibly (§4.1). Price freely, undo own mistakes (audited), see everything.
- Onboarding = the setup wizard retail path: shop name → currency (preset) → add 5–10 items (photo+name+price each ~20 s) → **sell**. First unaided sale inside 10 minutes; add items lazily at first sale of an unknown good ("+ New item" inside the SELL search).
- The owner-operator must never meet: roles, permissions, warehouses, document numbering, settings beyond "my shop details". Admin surfaces exist behind MONEY → "My shop" — visited monthly, not daily.

### 6.2 Shop with 2–3 staff

- **Owner**: full tiny-shop + MONEY + staff management ("Add staff: name, PIN, can they change prices? see money?" — a 3-question flow that writes the role matrix underneath; the matrix UI itself stays hidden).
- **Cashier** (template role): SELL + CUSTOMERS (collect/credit) + own-shift summary. No price change beyond the band, no reports, no expenses above a petty cap, no stock-in, MONEY hidden (`view_financial` masking is server-side — the simple UI is never the security boundary, CURRENT_STATE §3.5).
- **Storekeeper** (optional template role): STOCK only — stock-in, counts, low-stock.
- Shared-phone reality: short idle lock + 4-digit PIN unlock re-attributing actions to the unlocked user (R10 §C.6.4) — the audit trail stays honest on one shared Android.

---

## 7. New-build register (for Team Lead sequencing)

| # | Item | Layer | Size feel |
|---|---|---|---|
| N1 | POS-mode UI: five-concept shell, tile grid, sale flow, confirm screens | web (presentation profile + retail template config) | the flagship build |
| N2 | Till sessions (open/attribute/close/variance) | core (payments module) | small-medium; shared with wholesale |
| N3 | Expenses (categorized cash-out records) | core (small object) | small |
| N4 | Share-as-image (receipt, statement, reminder) | web only | small |
| N5 | Item barcode field + camera scan input; item photos | core (field) + web | small |
| N6 | PIN fast user-switch | core session layer | small; after D10 |
| E1–E3 | Reorder points (M4), returns/credit notes (M4), costing/margins (M2) | existing roadmap items retail consumes | already tracked |

---

## 8. Capability activation map (retail template)

| Status | Modules / capabilities |
|---|---|
| **Required (on)** | dashboard (MONEY) · sales (SELL) · inventory single-warehouse (STOCK) · parties + credit (CUSTOMERS) · payments · users · settings · audit · reports (owner-only) |
| **Recommended (on by default, owner may hide)** | expenses (N3) · till sessions (N2 — auto-silent for owner-operator) · low-stock alerts (post-M4) · receipts share-as-image |
| **Optional (off by default, one toggle away)** | VAT on sales (off for informal tier; on = existing VAT snapshots) · hard credit-limit blocking (default soft-warn) · deliveries module (shops that deliver) · barcode scanning · second warehouse + transfers (back-store shops) · supplier/PO discipline (post-M2 — the growth path toward the wholesale template) |
| **Disabled by default (invisible)** | production · quality · lots/tracking modes · reservations · draft/approval workflow on documents (confirm = post) · multi-currency · Ethiopian-calendar dual display (per-tenant preference) · fiscal-device integration (country pack, formal tier) |

The activation map **is** the sector template artifact: toggles + role presets + vocabulary pack + numbering formats + dashboard widget set + defaults (walk-in customer, "piece" UoM, expense categories). Turning things back on is configuration, not migration — a growing shop becomes a structured retailer, then a wholesaler (companion blueprint), on the same tenant and ledger.

---

## 9. Offline — selling must not stop

Retail's offline need is **CRITICAL** (AFRICA_SECTOR_PRIORITY §4.3): a shop that cannot sell during an outage abandons the app that day. Tiny-shop rides the O1/O2 contract in `docs/research/OFFLINE_SYNC_ARCHITECTURE.md` — no new sync machinery is proposed here:

- **O1 (read cache)**: item tiles, prices, customer list + balances-as-of, today's totals — cached in IndexedDB, masked payloads only, staleness always labeled ("as of 10:42").
- **O2 (queued writes)**: the POS sale is the strongest candidate for O2's "small safe subset". Op `sale.pos_post` — minted `opId` at confirm, per-device FIFO, server-side replay through the full sales service (permissions, stock validation, numbering at post time), five honest statuses on the receipt card (SAVED LOCALLY → WAITING TO SYNC → SYNCED / CONFLICT). Stale-world rejections (stock ran out server-side) park in the conflict view for the owner — never auto-adjusted.
- **The class-X question (needs architect + Founder sign-off):** the O2 entity taxonomy puts *payments* in class X (online-only, permanently). A cash POS sale carries an integral cash tender, so a strict reading forbids offline selling — which retail cannot accept. Proposed resolution, mirroring the Square precedent the O2 report itself cites: the **integral tender inside a `sale.pos_post` op is part of the class-L sale posting**, allowed offline with Square-style policy caps (max offline amount, max queue age, visible counter); **standalone payments** (debt collection, allocations to old invoices) **remain class X online-only** in v1. This amends nothing structurally — it scopes one op type — but it must be an explicit decision, not a drive-by.
- **Offline queue caps are shop policy**: template defaults (e.g. 72 h age cap per the O2 report's Square analysis) surfaced in owner language ("12 sales waiting to sync — connect soon").
- **Deployment vehicle caveat**: JENIFY today is local-first around a site node; a tiny shop has no PC. Until the node question (§10.1) is decided, the offline design above assumes the phone is a client of *some* node (shop box, home box, or hosted) — O2's client-side contract is identical in all three cases, which is why this blueprint can proceed ahead of that decision.

---

## 10. Open Founder questions

1. **Deployment vehicle for a tiny shop.** The platform is local-first around a node; a tiny shop owns one Android phone, no PC. Options: (a) a cheap shop box (~$100 Android/SBC running the node), (b) a hosted node (requires explicit Founder approval — currently forbidden by principle 7), (c) phone-as-node (a real engineering program, not currently on any roadmap). This decision gates go-to-market more than any feature in this blueprint.
2. **Offline cash-sale ruling** (§9): approve the integral-tender-inside-sale scoping of the O2 class-X boundary, with caps? (Architect review required either way.)
3. **Which retail tier first**: informal/semi-formal (no fiscal devices, VAT off, lowest willingness-to-pay, huge count) vs formal structured shops (fiscal country pack + VAT required in Ethiopia)? Decides whether the fiscal-device workstream (AFRICA_SECTOR_PRIORITY §5.5) blocks retail launch or follows it.
4. **Pricing/monetization for this segment** — retail scores lowest willingness-to-pay of the top sectors; per-tenant flat vs per-device vs free-tier-to-wholesale-upsell changes what "tiny" means commercially. (No evidence gathered; flagged, not answered.)
5. **Credit-limit default**: confirm soft-warn (not block) as the tiny-shop default (§2.3).
6. **Price-override band default** for hired cashiers (e.g. −10%?) — a business rule we must not fabricate (principle 4).
7. **Pilot sourcing**: can the Mesob owner network source 1–2 tiny-shop pilots alongside the distributor pilots (AFRICA_SECTOR_PRIORITY open question c)? A shop pilot would field-validate the 10-minute onboarding claim.

---

## 11. Team Lead summary

1. Tiny-shop mode = five words (SELL · STOCK · CUSTOMERS · EXPENSES · MONEY) as a bottom nav on a 2 GB Android Go phone; underneath, unmodified JENIFY core — invoices, append-only ledger, parties/credit, payments, RBAC, audit.
2. It is a presentation profile + sector template (toggles, vocabulary, role presets, defaults) — not a fork, not a lite product; a shop can grow into the wholesale template on the same tenant.
3. Common cash sale: tile → CASH → confirm = 3 taps, <15 s, M-PESA-style confirm preserved; DEBT sale adds one customer pick and speaks Khatabook ("Abebe now owes 240"), with share-sheet reminders.
4. NEW builds: POS-mode UI (flagship), till sessions (core, shared with wholesale), small expenses object, barcode field + camera scan + item photos, share-as-image receipts, PIN user-switch. Everything else is reuse or already-roadmapped (M2 costing, M4 returns/reorder/adjustments).
5. Offline rides O1/O2 exactly as specified; one explicit ruling requested — integral cash tender inside a POS sale joins the queueable class-L subset with Square-style caps, while standalone payments stay online-only.
6. Top open questions: the tiny-shop deployment vehicle (no PC in a shop — box vs hosted vs phone-as-node), the offline cash-sale ruling, and which retail tier (informal vs fiscal-formal) launches first.
