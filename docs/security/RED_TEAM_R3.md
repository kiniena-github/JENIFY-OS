# JENIFY OS — Security Red Team, Round 3

> Adversarial review of the **three Wave-1 operational gaps** just implemented on
> branch `wave-1`: (A) sales returns / credit notes and (C) partial purchase
> returns in `packages/server/src/services/returns.ts`; (B) single-invoice split
> delivery in `packages/server/src/services/deliveries.ts` (`dispatchDelivery`
> `lineQtys` + `invoice_lines.qtyDelivered` + `reduceReservation` in `inventory.ts`).
> Author role: **jenify-qa-security + qa-factory-simulation** — RED TEAM.
> Date: 2026-08-22. **Read-only**: no repo code changed except this report.
> Method: traced each new service from its route (`routes/commercial.ts`), read
> every collaborator (`inventory.ts`, `sales.ts`, `receiving.ts`, `context.ts`),
> and **proved/disproved each attack with a throwaway probe test** (12 cases, all
> green) run under the OS temp dir via `vitest --config`. Probe location:
> `…/scratchpad/r3probe.test.ts` (not committed).
>
> **Severity:** C critical · H high · M medium · L low.
> **State:** CONFIRMED (proven by probe/code) · SUSPECTED (design-level).

---

## 0. Bottom line

**No Critical. Two CONFIRMED Highs, and they are the SAME bug in two places.** Both new
quantity-guarded write paths validate the caller's line array against a **snapshot of
prior quantities taken once, before the loop, and never advanced as the loop consumes
the caller's own entries.** So a caller who lists the **same line twice in one request**
gets each entry validated against the stale baseline and both are applied — a cumulative
over-return / over-dispatch that the single-line and cross-request tests in
`wave1-gaps.test.ts` never exercise.

- **F1 (H, CONFIRMED, HTTP-reachable now):** `createSalesReturn` — duplicate
  `invoiceLineId` in `lines[]` restocks **12 packs onto a 10-pack sale** (phantom +2 into
  the append-only ledger) and issues a **60 000-cent credit note on a 50 000-cent
  invoice**. `POST /api/sales-returns` passes `req.body` straight through (`commercial.ts:58`).
- **F2 (H, CONFIRMED at service layer, NOT currently HTTP-reachable):** `dispatchDelivery`
  with duplicate `lineQtys` ships **8 packs but records `qtyDelivered = 4`**, leaving the
  invoice permanently `dispatched`. The `/dispatch` route calls `dispatchDelivery(ctx, id)`
  with **no `lineQtys`** (`commercial.ts:204`), so the split path is unreachable from the
  API today — a latent High that arms itself the moment anyone wires `req.body.lineQtys`.

**What held (CONFIRMED sound):** partial **purchase returns** (F3) — over-return, negative
qty, and returns off a reversed receipt are all correctly blocked; **tenant isolation** on
every returns path (F5); **double-reverse** of a credit note; **cross-invoice / foreign
line-id** injection into a sales return; and the **ledger invariant** balance == Σ posted
movements, which recomputes clean with zero discrepancies through a returns + split-delivery
sequence (F4). Note the invariant that breaks in F1/F2 is **not** balance==Σmovements (every
mutation still posts a real movement) — it is the higher-level business invariant
`Σreturned ≤ sold` / `Σdispatched ≤ ordered`, which lets F1 conjure physical stock and
over-credit money while the ledger stays internally "consistent."

---

## 1. Findings

### F1 — Sales return: duplicate line id over-returns in ONE credit note  **[H · CONFIRMED · reachable]**

**File:** `packages/server/src/services/returns.ts:83` (snapshot) and `:93–123` (loop);
reachable via `routes/commercial.ts:56–58`.

**Root cause.** `alreadyReturned = returnedByLine(...)` is computed once (line 83) and the
per-line guard reads `alreadyReturned.get(rl.invoiceLineId)` (line 102) **without ever
adding the current request's own quantities back into the map.** Two `lines[]` entries for
the same `invoiceLineId` therefore both compare against the same `priorMilli` and both pass
`priorMilli + qtyMilli > soldMilli` (line 103). Each entry then posts a `+qty` restock
movement (line 110–121) — a positive movement never trips `postMovement`'s negative guard —
and inserts its own credit-note line and `amountCents` (line 122, 129–131).

**Exploit (CONFIRMED by probe).** Invoice for 10 packs, dispatched & delivered. One request:

```
POST /api/sales-returns
{ "invoiceId": "...", "date":"…", "lines":[
    {"invoiceLineId":"L","qty":6},
    {"invoiceLineId":"L","qty":6} ] }
```

Result measured: no error; on-hand rose by **+12 000 milli (12 packs)** — 2 packs above the
100 ever received — and `creditNote.totalCents = 60000` against a 50 000-cent invoice. The
receivable is clamped by `Math.max(0, …)` in `customerOutstanding` (`sales.ts:473`) so it
does not go negative, but the customer is credited more than invoiced (debt can be wiped and
overshot) and the inventory ledger is permanently corrupted with fabricated stock.

**Fix.** Aggregate `input.lines` by `invoiceLineId` before validating (or reject a repeated
id), and validate the **summed** qty per line against `prior + ΣthisRequest`. Minimal:
build `wantByLine = Map<lineId, Σqty>` first, then run the existing check once per distinct
line. (Same fix also closes the fractional-qty edge where `Math.round(qty*1000)===0` reaches
`postMovement` and throws `movement_qty` — a DoS-flavoured 500, not a corruption.)

---

### F2 — Split delivery: duplicate lineQtys over-dispatches in ONE call  **[H · CONFIRMED (service) · not HTTP-reachable yet]**

**File:** `packages/server/src/services/deliveries.ts:173` (map) and `:175–195` (loop).
**Reachability:** the only dispatch route, `POST /api/deliveries/:id/dispatch`, calls
`dispatchDelivery(ctx, req.params.id)` with **no third arg** (`commercial.ts:200–206`), and
`lineQtys` is forwarded by **no route and no web client** (grep: only `deliveries.ts` itself
references it). So the split path is currently reachable **only** by direct service calls
(tests). This is a latent defect, not a live exploit — but it is the intended shipping path
for Gap B, so it will become live the instant `req.body.lineQtys` is wired in.

**Root cause (identical class to F1, plus a second bug).** For each `lineQtys` entry the loop
recomputes `remaining = line.qty - line.qtyDelivered` from the **in-memory `line`** fetched
once at `:173`; the in-memory object is never updated, and the DB write **sets**
`qtyDelivered: line.qtyDelivered + qtyMilli` (`:193`) rather than accumulating. Two entries
for the same line each see the original `remaining`, each pass the `qtyMilli > remaining`
guard (`:181`), each post a `-qty` dispatch movement (`:182–191`), and the second `qtyDelivered`
write **overwrites** the first.

**Exploit (CONFIRMED by probe).** 10-pack line, reservation 10. One call
`lineQtys:[{L,4},{L,4}]`: measured on-hand fell by **8 000 milli (8 packs shipped)** while the
line records **`qtyDelivered = 4 000` (4)**. 8 packs physically leave; the invoice believes 4
were delivered and 6 remain. `markDelivered` then leaves the invoice **permanently
`dispatched`** — a follow-up dispatch of the "remaining 6" throws because `reduceReservation`
finds only 2 000 left on the reservation (probe F2b), so the invoice can never `complete`.

The `reduceReservation` cap (`inventory.ts:227`) is an **incidental** guard, not a real
defense: it only rolls the whole call back when the duplicated quantities **sum > the
reservation** (probe: `[6,6]` on a 10-reservation rolls back cleanly). Any duplicate set that
sums ≤ the reservation (e.g. `[4,4]`) commits the over-dispatch.

**Fix.** Aggregate `opts.lineQtys` by `invoiceLineId` (reject or sum duplicates) and validate
the summed qty against `line.qty - line.qtyDelivered` once per distinct line; drive the
`qtyDelivered` write from the accumulated per-line total, not the stale in-memory value. Do
this **before** exposing `lineQtys` on the dispatch route.

---

### F3 — Partial purchase returns  **[SOUND · CONFIRMED]**

`returns.ts:195–232`. Cumulative over-return is correctly blocked (`prior + qtyMilli >
received`, `:203`) because purchase returns take a **single scalar `qty`** per call — there is
no caller-supplied array to duplicate, so the F1/F2 class does not apply. Returning off a
**reversed/draft** receipt is refused (`:198`, lifecycle must be `posted`); **negative/zero**
qty refused (`:199`); **cross-tenant** receipt id → `getReceipt` tenant filter → `not found`
(probe F5); returning more than physically on-hand is additionally blocked by
`postMovement`'s negative-balance guard. All CONFIRMED green.

### F4 — Ledger invariant end-to-end  **[HOLDS · CONFIRMED]**

After a mixed sequence (split dispatch 6+4, a sales return, its reversal, a second return),
`recomputeBalances` returns **zero discrepancies** — cached balances equal Σ posted movements
exactly, and no balance is negative (probe F4). Reversals post genuine opposite movements
(`returns.ts:166`, `receiving.ts:176`), credit notes flip to `reversed` and drop out of both
`creditNotedByInvoice` and `customerOutstanding`. Customer outstanding == Σ max(0,
effectiveTotal − paid) with effectiveTotal = total − posted credit notes (`sales.ts:471–476`);
it never goes negative and is not double-counted. The **only** way to dent this is the F1/F2
business-quantity breach above, which corrupts *physical* meaning, not ledger arithmetic.

### F5 — Tenant isolation on returns paths  **[HOLDS · CONFIRMED]**

`createSalesReturn`/`reverseSalesReturn`/`createPurchaseReturn` resolve every id through
tenant-scoped `getInvoice`/`getReceipt`/`creditNotes.tenantId` queries; a foreign-tenant
receipt id and a foreign-tenant credit-note id are both rejected with `not found` (probe F5).
Cross-invoice line injection into a sales return is rejected by the `byId` membership check
(`returns.ts:95`, probe green). Reverse-twice is blocked by the `status==='posted'` gate
(`returns.ts:160`).

---

## 2. Lower-severity / informational

- **M — `returnedByLine` snapshot read is OUTSIDE the transaction** (`returns.ts:83`, before
  `inTx` at `:85`). Under better-sqlite3's synchronous single-threaded execution a single
  `createSalesReturn` runs read+tx with no yield, so two requests cannot interleave today and
  this is **not** exploitable — but it is a TOCTOU by construction and should be re-read inside
  the tx as defense-in-depth. (`dispatchDelivery` already reads its lines inside `inTx`.) The
  F1 dedupe fix is independent of and more important than this.
- **L — no reversal path for a dispatched delivery.** `cancelDelivery` refuses
  `dispatched`/`delivered` (`deliveries.ts:297`) and there is no `reverseDelivery`; a delivery
  dispatched in error (or the F2 over-dispatch) has **no clean undo** — the only compensation is
  a sales return. Consistent with immutability principle #5, but worth a documented correction
  workflow.
- **Informational — Gap B is implemented + unit-tested but not wired to the surface.** No route
  or web client forwards `lineQtys`; `/dispatch` only does a full dispatch. Split delivery is
  currently unusable through the app. Whoever wires it **must** apply the F2 fix first.
- **Informational — delivery service functions carry no `requirePermission`;** the gate lives
  only at the route (`commercial.ts:203`, `dispatch`/`approve`). Fine as-is, but service-layer
  callers (AI, migration, future jobs) inherit no permission check.

---

## 3. Prioritized must-fix list

1. **[H] F1 — `returns.ts` `createSalesReturn`:** aggregate/reject duplicate `invoiceLineId`
   in `lines[]`; validate summed qty per distinct line against `prior + ΣthisRequest`.
   **Reachable in production now via `POST /api/sales-returns`.** Ship before go-live.
2. **[H] F2 — `deliveries.ts` `dispatchDelivery`:** aggregate/reject duplicate `invoiceLineId`
   in `lineQtys`; accumulate `qtyDelivered` from the per-line running total, not the stale
   in-memory line. **Fix before wiring `lineQtys` into the `/dispatch` route.**
3. **[M] F1 hardening — `returns.ts`:** move the `returnedByLine` read inside `inTx` (TOCTOU
   defense-in-depth).
4. **[L] Deliveries — document/implement a dispatched-delivery correction (reversal) workflow.**

_All four are the review's must-fixes; #1 is the only one exploitable through the live HTTP
surface today._
