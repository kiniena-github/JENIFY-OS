# JENIFY OS — Performance Attack, Round 1

> Author: `jenify-qa-security` (performance focus) · date 2026-08-22 · branch `wave-1`
> Mission §36 (attack performance at scale + weak hardware). READ-ONLY on the repo.
> Method: a throwaway benchmark (`scratchpad/perf_attack.mts`) seeds a single
> in-memory tenant via the real test helpers (`makeTestTenant`) plus bulk raw
> inserts, then calls the **actual service/query functions** (no mocks) and times
> the warm run; payload sizes are `JSON.stringify` byte lengths (raw + gzip);
> query plans are `EXPLAIN QUERY PLAN`. Bundle numbers are a production `vite build`.
> Seeded volume (one tenant): 10 002 items · 5 000 parties · 5 000 lots ·
> 30 000 stock_balances · 50 000 stock_movements · 20 000 invoices · 30 000
> invoice_lines · 8 000 payments+allocations · 10 000 production_batches ·
> 10 000 quality_tests · 10 000 deliveries · 700 translation keys/pack entries.
> Timings are server-side, on a fast dev PC with an **in-memory** DB — real disk
> (WAL) + Fastify JSON serialization make production numbers WORSE, not better.

## TL;DR

- **Worst bottleneck: the Sales report — 17.4 s** (unbounded N+1: one `invoicePaidCents`
  query per invoice in scope). Second worst: **the Dashboard — 6.2 s**, which every
  user hits on login.
- **Payloads are the real killer for weak hardware:** `/api/stock` serializes
  **12.3 MB (493 kB gzip)** and `/api/credit` **3.9 MB (727 kB gzip)** with **no
  pagination** — a 2 GB Android Go phone will freeze or OOM-kill the tab long before
  bandwidth even matters.
- **JS bundle budget HOLDS:** initial `index` 214.95 kB raw / **69.08 kB gzip**
  (budget ≤ 75 kB, 5.9 kB headroom) — identical to the 2026-08-21 baseline, no
  regression. The frontend risk is 100 % in the *data*, not the code.
- Two confirmed **full-table SCANs**: `quality_tests` and `translation_decisions`
  (no usable index). Several list/report queries do `USE TEMP B-TREE FOR ORDER BY`
  over the whole tenant table to return 200 rows.

## Measured results (warm, single tenant, in-memory DB)

| Operation | file:line | Time | Rows | Payload raw / gzip |
|---|---|---:|---:|---|
| `/api/reports/sales` (no period) | `reports.ts:463` | **17 396 ms** | 12 800 | 2 592 kB / 271 kB |
| `/api/dashboard` | `dashboard.ts:53` | **6 206 ms** | — | 222 kB / 12.8 kB |
| `/api/reports/delivery` | `reports.ts:500` | 2 007 ms | 10 000 | 2 500 kB / 174 kB |
| `customerOutstanding` (2 000-inv customer) | `sales.ts:414` | 1 989 ms | — | — (runs inside `confirmInvoice`) |
| `/api/reports/raw-stock` | `reports.ts:34` | 1 573 ms | — | — |
| `/api/reports/credit` | `reports.ts:484` | 1 382 ms | 12 800 | — |
| `/api/reports/finished-inventory` | `reports.ts:381` | 1 094 ms | 12 501 | 1 683 kB / 45.7 kB |
| `/api/reports/quality` | `reports.ts:220` | 1 038 ms | 3 333 | — |
| `/api/credit` (creditOverview) | `creditview.ts:26` | 880 ms | 12 800 | **3 934 kB / 727 kB** |
| `/api/stock` (all) | `stockview.ts:28` | 835 ms | 30 000 | **12 256 kB / 493 kB** |
| `/api/reports/packaging` | `reports.ts:318` | 784 ms | 3 333 | — |
| `/api/stock?kind=finished_good` | `stockview.ts:28` | 756 ms | 12 501 | — |
| `/api/reports/production` | `reports.ts:126` | 563 ms | 6 667 | — |
| `/api/reports/simple-item` | `reports.ts:539` | 469 ms | 0 | — |
| `/api/invoices` list+paid (limit 1000) | `commercial.ts:51` | 866 ms | 1 000 | — |
| `/api/movements` (limit 200) | `inventory.ts:278` | 297 ms | 200 | 95 kB / 18 kB |
| `/api/invoices` list+paid (limit 200) | `commercial.ts:51` | 298 ms | 200 | — |
| FIFO scan (5 000 lots, 1 line) | `sales.ts:231-245` | 73 ms | — | inside write tx |
| `getBundle('am')` (700 keys + pack) | `translations.ts:221` | 37 ms | — | 15 kB / 3.2 kB |

### EXPLAIN QUERY PLAN — the smoking guns

```
quality_tests   WHERE tenant_id=?                       →  SCAN quality_tests            (no tenant index!)
translation_decisions WHERE language=?                  →  SCAN translation_decisions    (index is (keyId,language))
stock_movements WHERE tenant_id AND movement_type=?     →  SEARCH … INDEX movements_doc (tenant_id=?)  → scans whole tenant, filters type in b-tree
stock_movements … ORDER BY posted_at DESC LIMIT 200     →  SEARCH tenant + USE TEMP B-TREE FOR ORDER BY (sorts all 50k to return 200)
sales_invoices  … ORDER BY created_at DESC LIMIT 200    →  SEARCH tenant + USE TEMP B-TREE FOR ORDER BY (sorts all 20k to return 200)
translations    WHERE tenant_id AND language=?          →  SEARCH … translations_key_lang (tenant_id=?) → scans all tenant langs
payment_allocations WHERE tenant+invoice+status         →  well-indexed (allocations_invoice) — each call is fast; the N+1 COUNT is the problem
```

---

## Findings (severity · scale-at-which-it-breaks · fix)

### P1 — CRITICAL · Sales report N+1 over payments — 17.4 s
`services/reports.ts:463` — `paidCents: invoices.reduce((s, r) => s + invoicePaidCents(ctx, r.inv.id), 0)`
runs one JOIN query **per invoice in scope**. `salesReport` also loads **every** tenant
`invoice_lines` row unconditionally (`reports.ts:444-449`, no period/invoice filter → 30 000 rows here).
- **Cost:** 17.4 s for 12 800 invoices; the query count *is* the invoice count.
- **Breaks at:** ~3–5 k confirmed invoices in scope → multi-second; a full-history or
  year-to-date run for any active tenant.
- **Who hits first:** Mesob (a year or two of daily invoices reaches thousands); a
  distributor immediately.
- **Fix:** replace the per-invoice loop with the same single grouped
  `payment_allocations` aggregate `creditOverview`/`listPayments` already use
  (`GROUP BY invoiceId`), joined in memory. Push a period filter onto `invoice_lines`.
  Also add a hard `LIMIT` + pagination to the breakdown.

### P2 — CRITICAL · `/api/stock` unbounded payload (12.3 MB) + no pagination + JS-side kind filter
`services/stockview.ts:28-49`, route `routes/inventory.ts:134`. Returns **one row per
item × lot × warehouse** with no limit; the `kind` filter runs in JS *after* the full
join loads (`stockview.ts:49`), and **all** tenant lots are reloaded into a Map every
call (`stockview.ts:86`).
- **Cost:** 835 ms server, **12 256 kB raw / 493 kB gzip**, 30 000 rows.
- **Breaks at:** the phone, not the server. A few thousand rows already produce a
  multi-MB body and a table React cannot render on a low-end device (see §Weak hardware).
- **Who hits first:** Mesob accumulates a lot per receipt and per batch *forever* (no
  archival), so `stock_balances` climbs into the thousands within a year → sluggish.
  A distributor with 10 k items is instantly catastrophic.
- **Fix:** (a) push `items.kind = ?` and a `warehouseId`/`itemId` filter into the SQL
  join; (b) exclude zero-balance rows in SQL (`qty_on_hand != 0`); (c) paginate
  (`LIMIT/OFFSET` or keyset) and add a server-side aggregate summary; (d) join lot
  metadata in the same query instead of loading every lot.

### P3 — HIGH · Dashboard 6.2 s — the login landing page
`services/dashboard.ts:53`. One request calls `stockOverview` **twice** (raw + finished,
each re-loading 5 000 lots + scanning 30 000 balances + 3 joins), `creditOverview`
(12 800 invoices), a full committed-invoice scan, and full `production_batches` (10 000)
and `deliveries` (10 000) loads that are then filtered to "today" in JS.
- **Cost:** 6 206 ms. Payload is fine (222 kB / 12.8 kB — it aggregates); the pain is *time*.
- **Breaks at:** every screen after enough history — Mesob feels it as batch/lot/invoice
  counts grow (≈ 0.6 s even at 1/10 scale, and it only climbs).
- **Fix:** compute "today"/"this-month" slices in SQL (`WHERE date = ?`) instead of
  loading whole tables; call `stockOverview` once and derive both kinds; memoize/So the
  lot Map is built once. Longer term: a small maintained daily-summary table.

### P4 — HIGH · `/api/credit` unbounded payload (3.9 MB / 727 kB gzip)
`services/creditview.ts:26`, route `routes/commercial.ts:117`. Returns a row for **every**
committed invoice ever (no period, no limit). `creditReport` (`reports.ts:484`) wraps the
same overview.
- **Cost:** 880 ms, **3 934 kB raw / 727 kB gzip**, 12 800 rows (gzip is *large* because
  invoice numbers/dates/names compress poorly).
- **Breaks at:** thousands of open+settled invoices — Mesob within ~1–2 years; distributor now.
- **Fix:** default to `scope=open` on the API (settled/all behind an explicit paged
  query); paginate; return the aggregate totals (already computed) separately from rows.

### P5 — HIGH · `customerOutstanding` N+1 *inside a write transaction* — 2.0 s
`services/sales.ts:414-431`, called from `confirmInvoice` (`sales.ts:216`). Loops the
customer's committed invoices calling `invoicePaidCents` each → N+1, **while holding the
`confirmInvoice` write lock**, so it serializes/blocks every other writer.
- **Cost:** 1 989 ms for a customer with 2 000 invoices — per confirm.
- **Breaks at:** a distributor's key account (thousands of invoices) makes every credit
  sale to them take seconds and stalls concurrent postings; combined with the deferred-BEGIN
  `SQLITE_BUSY` gap (D10) this risks failed postings under load.
- **Fix:** one grouped query — `SUM(total) − SUM(active allocations)` for the customer's
  committed invoices — instead of the per-invoice loop.

### P6 — HIGH · `quality_tests` full cross-tenant SCAN + double batch load
`db/schema.ts:555-575` declares only `uniqueIndex('qc_attempt').on(batchId, attemptNumber)`
— **no `tenant_id` index**. `qualityReport` (`reports.ts:238`) does `WHERE tenant_id=?`
→ `SCAN quality_tests` across *all tenants*, and separately re-loads **all**
`production_batches` a second time just for a number lookup (`reports.ts:250`).
- **Cost:** 1 038 ms; grows with the *global* table, so other tenants' data slows this one.
- **Fix:** add `index('qc_tenant_batch').on(tenantId, batchId)` (migration 0007); reuse
  the batches already loaded at `reports.ts:227` for `batchNumById` instead of re-querying.
  (Matches defect **D7**.)

### P7 — HIGH · 6 of 9 reports load the full table, then date-filter in JS
`inPeriod()` (`reports.ts:29`) filters *after* a full load in: raw-stock (`:40,:59`),
production (`:142`), quality (`:237`), packaging (`:333`), finished-inventory (`:392`),
delivery (`:508`). So a "this month" report still reads all history. (Worse than **D6**'s
"5 of 9".) Delivery report also ships an unbounded **2.5 MB / 174 kB** body.
- **Fix:** push `from`/`to` into the SQL `WHERE` on the driving table's date column (as
  `salesReport` already does at `reports.ts:431-432`); require a bounded default period;
  paginate breakdowns.

### P8 — MEDIUM · List sorts spill to a temp B-tree (no ORDER-BY index)
`listMovements` (`inventory.ts:299`, ORDER BY `postedAt`) and `listInvoices`
(`sales.ts:464`, ORDER BY `createdAt`) — plus payments/receipts/transfers/deliveries —
sort the **entire** tenant table to return ≤ 200 rows (`USE TEMP B-TREE FOR ORDER BY`).
That is why `/api/movements` costs 297 ms for 200 rows over 50 k movements.
- **Fix:** add covering indexes `(tenant_id, posted_at DESC)` on `stock_movements` and
  `(tenant_id, created_at DESC)` on `sales_invoices`/`payments`. Add a date-range filter
  to `/api/movements` (it only accepts item/lot/warehouse/doc today — nothing time-bounded).

### P9 — MEDIUM · Report/recompute queries scan all tenant movements (no `movement_type` index)
`rawStockReport` (`reports.ts:54`, `production_consume`), `finishedInventoryReport`
(`reports.ts:388`, `sale_dispatch`), `recomputeBalances` (`inventory.ts:315`, full group-by).
Each seeks the tenant via `movements_doc` then scans every movement filtering type in the b-tree.
- **Fix:** add `(tenant_id, movement_type, posted_at)`; date-bound the report movement reads.

### P10 — LOW/MEDIUM · Translation-intel scans; getBundle still cheap today
`translation_decisions` has no language-leading index → `languagePackHistory`
(`languageIntel.ts:571`) `SCAN`s the table (`WHERE language=?`). `translations` lacks a
`(tenant_id, language)` index (WM3) so `getBundle` scans all a tenant's languages.
`getBundle('am')` measured **37 ms** with 700 keys + a full 700-entry official pack + a
country + sector layer probe (~5 queries, uncached) — fine now, but it is called on **every
page load / language switch** and scales with `keys × languages × pack layers`.
- **Fix:** add `index('translations_tenant_lang').on(tenantId, language)` and
  `index('decisions_lang').on(language, decidedAt)`; cache `getBundle` per
  `(tenant, language, packVersion)` — invalidate on translation/pack write. Matches **WM3**.

### P11 — LOW · FIFO confirm loop scales with lot count, holds the write lock
`sales.ts:231-245`: loads **all** lots for the item, then `getAvailable` (2 indexed
queries) per lot until filled. 73 ms for 5 000 lots for a single line — bounded and
indexed, but multiplied by lines and executed inside `confirmInvoice`'s transaction.
- **Fix:** filter candidate lots to the selected warehouse and to lots with a positive
  balance in SQL (join `stock_balances`), and compute availability in one grouped query
  rather than 2 per lot.

---

## Bundle budget (production `vite build`, 2026-08-22)

| Metric | Budget | Measured | Status |
|---|---|---|---|
| Initial JS (gzip) | ≤ 75 kB | **69.08 kB** | ✅ 5.9 kB headroom — unchanged from baseline |
| Initial JS (raw) | ≈ 215 kB guardrail | 214.95 kB | ✅ at guardrail |
| Largest route chunk (gzip) | ≤ 40 kB | Settings 8.20 kB | ✅ |
| CSS (gzip) | ≤ 8 kB | 4.07 kB | ✅ |

Heaviest routes (gzip): Settings 8.20 · Production 6.02 · Reports 5.37 · Setup 4.23 ·
Sales 3.92 · useQuery 3.72 · Print 3.58 · Users 3.55 · Payments 3.15. All lazy-loaded,
all well under budget. **The budget holds; no code-splitting regression.** The frontend
scaling risk is entirely the *data volume* the heavy routes (Reports, Inventory, Credit,
Sales) fetch and render, not the JS.

## Weak-hardware reasoning (2 GB Android Go, Chrome, congested 3G ≈ 400 kbps ≈ 50 kB/s)

The server runs on the founder's local PC, so query *time* is a PC cost; the phone is the
**client** and pays for download + JSON parse + DOM render. That is where JENIFY breaks:

- **`/api/stock` = 493 kB gzip → ~10 s just to download**, then Chrome must inflate to
  **12.3 MB** of JSON, allocate ~30–50 MB of JS objects, and React must reconcile
  **30 000 rows × ~10 cells ≈ 300 000 DOM nodes**. On a 2 GB Go device (~400–600 MB
  per-tab budget) this realistically freezes the main thread for tens of seconds or gets
  the tab OOM-killed — a *hard failure*, not a slow screen. Pages don't virtualize or
  paginate (D8), so the whole set hits the DOM at once.
- **`/api/credit` = 727 kB gzip → ~15 s download** + 12 800 rows rendered — same class of
  failure on the Credit page.
- **Reports** (sales 271 kB, delivery 174 kB gzip) download in 4–5 s on 3G, then render
  thousands of `<tr>` — janky INP measured in seconds even where the tab survives.
- **Dashboard** is the merciful case: its 12.8 kB gzip body renders fine — but the user
  waits **6 s** for the server to build it after every login.
- getBundle (3.2 kB gzip) and the JS bundle (69 kB gzip, ~1.5 s on 3G, cached after first
  load) are both fine. Nothing about the *code* size threatens the Go phone; the *lists* do.

## Who hits what first — Mesob vs distributor

- **Mesob (the pilot, moderate volume):** first pain is **Dashboard latency (P3)** and the
  **Sales report N+1 (P1)** as a year or two of daily invoices/batches/lots accumulate;
  then `/api/stock` (P2) as lots pile up with no archival. Mesob is safe *today* but these
  degrade continuously — none of them have a ceiling.
- **Distributor-size tenant (5 k parties, 10 k items, 20 k+ invoices):** hits **all** of
  P1–P9 immediately and hard — the 12 MB stock payload and the 17 s report make those
  screens unusable on day one, and P5 stalls every credit sale to a big account.

## Must-fix-before-scale

Ordered by measured pain × likelihood of being hit:

1. **P1** — kill the sales-report payment N+1 (grouped aggregate) and period-bound `invoice_lines`.
2. **P2** — paginate `/api/stock`, push `kind`/warehouse/zero-balance filters into SQL, stop reloading all lots.
3. **P3** — dashboard: SQL-side day/month slices; one `stockOverview`; single lot Map.
4. **P4** — paginate `/api/credit`; default `scope=open`; totals separate from rows.
5. **P5** — replace `customerOutstanding` loop with one grouped query (also unblocks the write lock).
6. **P6 + P8 + P9 + P10** — one additive migration (0007): `quality_tests(tenant,batch)`,
   `stock_movements(tenant,movement_type,posted_at)` & `(tenant,posted_at)`,
   `sales_invoices/payments(tenant,created_at)`, `translations(tenant,language)`,
   `translation_decisions(language,decided_at)`. (Covers **D7** + **WM3**.)
7. **P7** — push report period filters into SQL and require a bounded default period; paginate breakdowns.

### Wave 1 vs later

- **Wave 1 (do now — small, additive, high payoff):** the migration 0007 index set (#6) —
  additive-only, zero behavioral risk, matches D7/WM3 and instantly fixes the SCANs and
  temp-B-tree sorts. The two grouped-query rewrites P1 and P5 (localized, no schema change,
  each removes a multi-second cliff). Default `scope=open` + a hard `LIMIT` on `/api/credit`
  and `/api/stock` as a cheap stop-gap before full pagination.
- **Wave 1 if capacity allows:** dashboard SQL-slice rewrite (P3) and pushing report
  period filters into SQL (P7) — both are contained service edits, both need the Mesob
  regression suite (163 tests) green and a re-measure appended to `MOBILE_PERFORMANCE_BASELINE.md`.
- **Later (needs UX + product decisions):** real keyset pagination + list virtualization on
  Inventory/Credit/Sales/Reports pages (paired with the D8 frontend query-state work); a
  maintained daily-summary table for the dashboard; `getBundle` cache keyed on pack version.
  These change API contracts and UI, so they belong to a scoped milestone, not a hotfix.

## What was NOT tested (honest gaps)

- No true multi-tenant fan-out: cross-tenant SCANs (P6, P10) were reasoned from query plans,
  not measured with N tenants of data — the effect only compounds as tenants are added.
- Timings are in-memory on a fast PC; real WAL disk + Fastify serialization make absolute
  numbers larger (the *relative* ranking holds).
- No real-device render/INP capture — the weak-hardware section is grounded estimation
  (payload bytes × DOM node counts × known Go-device budgets), still the gap flagged in
  `MOBILE_PERFORMANCE_BASELINE.md`.
- Write-path throughput under concurrency (P5/P11 lock contention, `SQLITE_BUSY`) is
  reasoned, not load-tested — no concurrency harness exists yet (Current State §4).
