# JENIFY OS — Security Red Team, Round 4

> Adversarial review of the **sector-wave capabilities** committed in `4f52f67`
> (20 sector definitions + onboarding resolver) and `6ac5f14` (work orders +
> bookings): `packages/shared/src/sectors.ts`, `services/onboarding.ts`,
> `routes/onboarding.ts`, `services/workorders.ts`, `services/bookings.ts`,
> `routes/operations.ts`, migration `0010_condemned_bill_hollister.sql`.
> Author role: **jenify-qa-security** — RED TEAM. Date: 2026-08-23. Branch `main`, HEAD `6ac5f14`.
> **Read-only**: no repo file changed except this report. QA does not silently repair what it certifies.
>
> **Method.** Traced every new service from its route through every collaborator
> (`inventory.ts`, `masterdata.ts`, `parties.ts`, `templates.ts`, `experience.ts`,
> `permissions.ts`, `numbering.ts`, `context.ts`), then **proved or disproved each
> attack with throwaway probes** run under the OS temp dir via `npx tsx` — 4 probe
> files, ~80 attack cases, including a full **HTTP probe through `buildApp()` +
> `app.inject()` with real role-scoped session cookies**. Probes not committed:
> `…/scratchpad/probe.ts`, `probe2.ts`, `probe3.ts`, `probe4.ts`.
> Baseline verified before and after: **389 passed / 3 skipped, 25 suites,
> `npx tsc --noEmit` clean.** Every finding below is a coverage gap, not a broken test.
>
> **Severity:** C critical · H high · M medium · L low.
> **State:** CONFIRMED (proven by probe) · SUSPECTED (design-level reasoning only).

---

## 0. Bottom line

**No Criticals. Three CONFIRMED Highs, all HTTP-reachable today by an ordinary
low-privilege tenant user.** Two of them defeat the exact invariant the new code
declares in its own docstring.

- **H1 — the double-booking rule is evadable with a legal ISO-8601 timestamp.**
  Overlap is decided by **string comparison on `text` columns** with no normalisation,
  so the same instant written `…T12:00:00.000+03:00` instead of `…T09:00:00.000Z` does not
  collide. A `sales.create` user double-books a hotel room / clinic slot / restaurant table
  over `POST /api/bookings` and over `/reschedule`. The file's own comment calls this
  "the load-bearing rule, identical in every sector."
- **H2 — work-order parts consume RESERVED stock.** `issuePartToWorkOrder` posts through
  `postMovement`, which guards **on-hand ≥ 0 but not AVAILABLE**. Probe drove
  `getAvailable` to **−40 000 milli** over HTTP as a user holding only `inventory.create`.
  Stock committed to a confirmed customer invoice is silently consumed by a workshop job.
  `batches.ts` gets this right (`getAvailable`); work orders do not.
- **H3 — one booking can permanently block a resource.** `startAt`/`endAt` are never
  validated as timestamps and have no maximum duration. `{"startAt":"!","endAt":"~"}` is
  accepted (200) and thereafter **every** booking of that room returns `double_booked`.
  Self-service denial of service on any bookable resource, by any `sales.create` user.

**What held (CONFIRMED sound, no action).** Tenant isolation is clean across all four new
tables — `tenantId` is never read from a request body, and cross-tenant read/assign/book/
cancel are all blocked. Sector data integrity is genuinely sound: 20 sectors × 5 tiers
produce **zero** unknown capability ids, **zero** unresolvable stacks and **zero** conflicts,
even resolved *without* a core layer. The onboarding resolver performs **no database reads
at all** (byte-identical output against a populated vs an empty DB — no cross-tenant surface),
is immune to prototype-pollution sector ids (`Map`, not object), and provisioning is
genuinely **not routed**. The `MAX_ENTRY_QTY` / `MAX_MOVEMENT_QTY` guards **do** cover the new
parts path: negative, zero, `1e15`, `Infinity`, `NaN` and sub-milli quantities are all rejected.

---

## 1. Confirmed Highs

### H1 — Bookings: double-booking evaded by a non-`Z` ISO offset **[H · CONFIRMED · HTTP-reachable]**

**File:** `packages/server/src/services/bookings.ts:96–112` (`conflictingBookings`, the
`lt`/`gt` at `:107–108`), `:128` (`if (!(input.startAt < input.endAt))`), `:216`
(same check in `rescheduleBooking`). Reachable at `routes/operations.ts:108` and `:137`.

**Root cause.** `bookings.start_at` / `end_at` are `text` (`db/schema.ts:310–311`) and the
overlap predicate is a **lexicographic** comparison, in both SQLite and the JS range check.
Lexicographic order equals chronological order *only* for a single normalised format. ISO-8601
permits a UTC offset, and nothing in the service, the route, or the schema normalises or even
validates the input. Two strings denoting the identical instant therefore sort into different
positions.

**Exploit (probe H5, verbatim).** As user `salescreate` (`sales.create` + `sales.edit` only):

```
POST /api/bookings {resourceId, startAt:"2026-09-05T09:00:00.000Z",      endAt:"2026-09-05T10:00:00.000Z"}      -> 200 BKG-0001
POST /api/bookings {resourceId, startAt:"2026-09-05T12:00:00.000+03:00", endAt:"2026-09-05T13:00:00.000+03:00"} -> 200 BKG-0002
```

Both bookings occupy 09:00–10:00 UTC on the same room. The overlap test compares
`"2026-09-05T10:00:00.000Z" > "2026-09-05T12:00:00.000+03:00"` → `'0' < '2'` → false → no clash.
Probe B1b reproduces the same evasion through `POST /api/bookings/:id/reschedule`, moving a
booking **onto an occupied slot** that the Z-formatted reschedule correctly refuses.

**Why the tests miss it.** Every case in `test/workorders-bookings.test.ts` is built by
`T(h) = 2026-09-01T0h:00:00.000Z` — a single format, so lexicographic ≡ chronological throughout.

**Impact.** Two guests in one hotel room; two patients in one appointment slot; two sittings on
one table. This is the whole value proposition of the `bookings` capability for four sectors
(`hospitality`, `restaurant`, `healthcare`, `education`), and hospitality's own AI mastery model
claims it "detects overbooking risk."

**Fix.** Normalise on the way in and store one canonical form: parse with `Date.parse`, reject
`NaN`, and persist `new Date(x).toISOString()` (always `…Z`, millisecond precision, fixed width).
Do it in `createBooking` **and** `rescheduleBooking`, before the range check and before
`conflictingBookings`. Add a migration-time normalisation for any rows already written. Then add
a test whose fixtures deliberately mix `Z`, `+03:00`, and `-05:00` for the same instant.

---

### H2 — Work orders: parts issue bypasses reservations and consumes committed stock **[H · CONFIRMED · HTTP-reachable]**

**File:** `packages/server/src/services/workorders.ts:205–260`, specifically the
`postMovement` call at `:225`. Reachable at `routes/operations.ts:74–80`.

**Root cause.** `postMovement` (`services/inventory.ts:35–61`) only refuses a movement that
would push **`qtyOnHand`** below zero. It has no knowledge of `reservations`. Callers that must
respect commitments compute availability themselves — `batches.ts:85` uses
`getAvailable(...)` (`on-hand − reserved`) before consuming. `issuePartToWorkOrder` performs no
such check, so it happily draws down stock already reserved against a confirmed sales invoice.

**Exploit (probe H3, over HTTP).** 100 units received into warehouse A, all 100 reserved for a
confirmed invoice (`getAvailable` = 0). Then, as user `partsonly` holding **only**
`inventory.view` + `inventory.create` and **zero production permissions**:

```
POST /api/work-orders/{id}/parts {itemId, warehouseId, lotId, qty:40} -> 200
AVAILABLE: 0 -> -40000   (on-hand still 60 000, so postMovement never objects)
```

The sales-side dispatch that later tries to ship those reservations will find the physical stock
gone. Service-layer probe W9 reproduces it identically.

**Impact.** Silent oversell. The picker discovers it at the loading bay, not in the system. The
work-order docstring claims "a job can never consume phantom inventory" — true of the ledger's
own arithmetic, false of the business commitment layer, exactly the class of higher-level
invariant that R3/F1 was about.

**Fix.** In `issuePartToWorkOrder`, inside the `inTx`, assert
`getAvailable(tx, itemId, warehouseId, lotId) >= qtyMilli` before `postMovement` and fail with a
dedicated `insufficient_available` code (mirror `batches.ts:85–91`). If workshop jobs are meant
to be allowed to break a reservation, that must be an explicit, permission-gated,
audited override — never the default.

---

### H3 — Bookings: an unvalidated time string permanently blocks a resource **[H · CONFIRMED · HTTP-reachable]**

**File:** `packages/server/src/services/bookings.ts:127–128` (the only validation:
non-empty and `startAt < endAt`), `:216` (same for reschedule).

**Root cause.** No timestamp parsing, no format check, no maximum duration. Any pair of strings
where `a < b` lexicographically is accepted and stored, and the overlap predicate then applies
that garbage range against every real booking.

**Exploit (probe H6, over HTTP, as `sales.create`).**

```
POST /api/bookings {resourceId, startAt:"!", endAt:"~"}                    -> 200
POST /api/bookings {resourceId, startAt:"2026-09-06T09:00Z", endAt:"…10:00Z"} -> 400 double_booked
```

`"!"` (0x21) and `"~"` (0x7E) bracket every printable ASCII string, so the range swallows all
real timestamps and the room is unbookable forever (until someone finds and cancels
`BKG-000n`, whose day view shows `[!..~]`). Probe B2b confirms the same result with a perfectly
well-formed 1000-year range `0001-01-01 → 9999-12-31`, which no format validation would catch.
Probe H7 also stored `startAt:[1]` as `"1.0"` — JSON arrays are coerced to strings and accepted.

**Impact.** Any front-desk-level account can take a room, a practitioner's calendar or a class
offline indefinitely, and can do it to every resource in a loop. It also corrupts the day view.

**Fix.** Three guards, in `createBooking` and `rescheduleBooking`: (1) `typeof x === 'string'`
plus `Number.isFinite(Date.parse(x))`; (2) canonical `toISOString()` storage (see H1);
(3) a configurable maximum duration (a tenant/capability setting in the `bookings` config
namespace — never a hard-coded literal; a 400-day ceiling is a sane platform default) and a
sane bound on how far ahead a booking may start.

---

## 2. Mediums

| # | Finding | File | State |
|---|---|---|---|
| M1 | **Parts-issue authority mismatch** | `workorders.ts:210` | CONFIRMED |
| M2 | **Work-order status/existence oracle** | `workorders.ts:51–59`, `:151–157` | CONFIRMED |
| M3 | **Parts stranded when a job is cancelled** | `workorders.ts:195–199` | CONFIRMED |
| M4 | **Type-confusion quantities reach the ledger** | `workorders.ts:217,223` | CONFIRMED |
| M5 | **Five new routes 500 on a missing body** | `routes/operations.ts`, `routes/onboarding.ts` | CONFIRMED |
| M6 | **`limit` cap bypass / unpaginated booking list** | `workorders.ts:275`, `bookings.ts:235–246` | CONFIRMED |
| M7 | **Provisioning non-atomic + global layer churn** | `onboarding.ts:139–221` | CONFIRMED |
| M8 | **Onboarding clobbers the owner's role experience** | `onboarding.ts:196` | CONFIRMED |
| M9 | **`capacity` is decorative** | `bookings.ts:132`, `:96–112` | CONFIRMED |
| M10 | **`createRole` ungated; provision needs only `settings.edit`** | `permissions.ts:26`, `onboarding.ts:144` | CONFIRMED (latent) |

### M1 — Parts-issue authority mismatch **[M · CONFIRMED · HTTP-reachable]**
`issuePartToWorkOrder` requires **only** `inventory.create` (`:210`). It requires no production
authority, and it does not care whether the caller is the assignee. Probe W10/H3: a user with
zero production permissions issued parts against a job assigned to another technician, and the
resulting `work_order_parts` row and stock movement are attributed to the job. The file's own
docstring says "a technician may only advance their OWN assigned job"; parts consumption — the
part with financial consequence — is outside that rule entirely.
**Fix.** Require `production.edit` in addition to `inventory.create`, and apply the same
assignee-or-`production.approve` rule that `transition()` uses. Consider `inventory.issue`
as a dedicated fine-grained action.

### M2 — Status/existence oracle for a user with no production permission **[M · CONFIRMED · HTTP-reachable]**
`getWorkOrder` (`:51–59`) carries **no** permission check, and `transition()` validates the
status matrix at `:151` **before** calling `requirePermission` at `:157`. The `/start`,
`/complete`, `/cancel` routes have no route-level guard (`routes/operations.ts:56,62,68`).
Probe H2, as a `dashboard.view`-only account:

```
POST /api/work-orders/{draft-id}/complete  -> 400 {"error":"wo_transition","message":"A job cannot go from draft to completed"}
POST /api/work-orders/{unknown-id}/complete -> 404
POST /api/work-orders/{in-progress}/complete -> 403 Missing permission production.edit
```

Three distinguishable responses = an existence + live-status oracle over every work order in the
tenant, for an account that `GET /api/work-orders/:id` correctly 403s (probe H1). `workOrderParts_`
(`:298–305`) likewise calls `getWorkOrder` with no guard; it is saved only by its caller's route.
**Fix.** Move `requirePermission(ctx,'production','edit')` to the **top** of `transition()`,
before the status lookup, and add `requirePermission(ctx,'production','view')` inside
`getWorkOrder` (or take an explicit `{ skipPermission: true }` for internal callers).
Invariant #8 says permission on every route — these three POSTs have none.

### M3 — Parts are never returned when a job is cancelled **[M · CONFIRMED]**
Probe W8: issue 10 units to a scheduled job, then `cancelWorkOrder` → on-hand stays at 90 000,
no compensating movement, no reversal path anywhere in the service. Re-issuing to the cancelled
job is correctly blocked (W8b), so the stock is simply gone from the books with a `work_order`
document reference to a cancelled job. Same class as R3-F4 (no reversal for a dispatched
delivery), but here it is trivially reachable in normal operation — customers walk away from
quotes constantly.
**Fix.** A `returnPartFromWorkOrder` (positive compensating `issue`/`adjustment` movement,
audited, bounded by what was issued), plus a cancel-time check that refuses to cancel a job
with un-returned parts (or prompts for return), mirroring the immutable-operations principle.

### M4 — Type-confusion quantities reach the append-only ledger **[M · CONFIRMED · HTTP-reachable]**
`:217` uses `!(input.qty > 0)`, a JS comparison that coerces, and `:223` does
`Math.round(input.qty * 1000)`. Probe H4, all returning 200 and posting real movements:

| body `qty` | movement posted |
|---|---|
| `"7"` (string) | −7 000 |
| `2.5` | −2 500 |
| `true` | **−1 000** |
| `[3]` | −3 000 |
| `{"valueOf":1}` | rejected (400) |

`true` issuing one unit of stock is the D5 class arriving on a new write path. The magnitude and
finiteness guards hold (negative/zero/`1e15`/`Infinity`/`NaN`/sub-milli all rejected), so the
ledger arithmetic invariant is intact — but the ledger now records quantities derived from
booleans and arrays.
**Fix.** `if (typeof input.qty !== 'number' || !Number.isFinite(input.qty) || input.qty <= 0)`,
and add the route schema (T6 backlog) for `/api/work-orders/:id/parts`.

### M5 — Five new routes return 500 on a missing body **[M · CONFIRMED · HTTP-reachable]**
Unhandled `TypeError` on `req.body.X` when the body is absent:
`routes/operations.ts:44` (`POST /api/work-orders`), `:51` (`/assign`), `:91` (`POST /api/resources`),
`:141` (`/reschedule`), and `routes/onboarding.ts:30` (`POST /api/onboarding/recommend`, which
crashes inside `onboarding.ts:83`). The `/complete` and `/cancel` handlers correctly use `req.body?.x`;
these five do not. The global handler masks the message (`{"error":"internal"}`), so no internal
detail leaks — but a 500 on an authenticated request is a stability and log-noise problem and the
D13 hygiene item is still open.
**Fix.** `req.body ?? {}` at each site plus the missing-field `badRequest`, or route schemas.

### M6 — `limit` cap bypass and an unpaginated booking list **[M · CONFIRMED · HTTP-reachable]**
`workorders.ts:275` is `Math.min(filter.limit ?? 100, 500)` over an **unparsed query string**.
Probe P4, 620 work orders seeded against a documented 500-row cap:

```
GET /api/work-orders             -> 100 rows
GET /api/work-orders?limit=100000 -> 500 rows   (cap works)
GET /api/work-orders?limit=-1     -> 620 rows   (Math.min(-1,500) = -1; SQLite LIMIT -1 = unbounded)
GET /api/work-orders?limit=abc    -> 620 rows   (NaN -> unbounded)
```

`listBookings` (`bookings.ts:235–246`) has **no limit at all** (probe H8) — PERF-2 class on a
brand-new endpoint.
**Fix.** `const n = Number(filter.limit); const lim = Number.isInteger(n) && n > 0 ? Math.min(n,500) : 100;`
and give `listBookings` the same bounded pagination.

### M7 — Provisioning is non-atomic and publishes a GLOBAL layer version per run **[M · CONFIRMED · CLI-only today]**
`provisionFromOnboarding` (`onboarding.ts:139–221`) is **not** wrapped in `inTx` (probe P12) and
performs, as separate transactions: publish a global sector layer (`:154`) → bind the tenant
(`:167–174`) → N × (`createRole` + `saveRoleExperience`) → audit. Probes P8/P10:

- Four onboarding runs by **one** tenant published **four global versions** of `sector.retail`
  (v1→v4, each superseding the last). Because `extends` resolves to the latest published version
  (TE-M2), one tenant re-running onboarding **changes the resolved configuration of every other
  tenant bound to that sector template**. That is cross-tenant configuration reach.
- A run that fails at step 2 has **already published** the global layer: probe P10 left
  `sector.wholesale@v1` published on a DB whose tenant ended up unbound. Failed attempts litter
  the platform registry permanently.
- The `catch {}` at `:172` (probe P13) swallows *any* error, not just "country pack missing" — it
  hid a `forbidden` authorization failure and a missing-`core` failure during probing, then
  rethrew a misleading message.

Also functional: provisioning **cannot succeed** unless a `core` layer was published separately
(`bindTenantTemplate` throws `Template 'core' not found`, probe P9/O6b), and it cannot be run with
a pure system context either, because `:144` requires a signed-in user (probe P14). The advertised
"COUNTRY → SECTOR → SIZE → … → JENIFY configured" path therefore only works in a narrow
pre-arranged state.
**Fix.** Wrap the whole composite in `inTx`; publish the sector layer only when its content
actually differs from the currently published version (content hash / deep-equal — no-op runs must
not bump the global version); narrow the `catch` to the specific missing-country-pack error;
and decide explicitly whether a tenant's onboarding may ever mutate a shared global artifact
(it should not — this is the WM5 platform-admin boundary).

### M8 — Onboarding overwrites the tenant owner's role experience **[M · CONFIRMED · latent H]**
18 of 20 sectors define a role preset with `roleCode: 'owner'` (probe S7). On re-run, the existing
owner role is correctly **reused** with its permission matrix untouched (probe P2 — INTACT, good) —
but `saveRoleExperience` at `:196` is called for reused roles too, writing a spec derived from the
preset's 3–4 live actions. Probe P3:

```
owner nav before: [dashboard,inventory,production,quality,parties,sales,credit,payments,delivery,reports,users,settings,audit]
owner nav after : [dashboard,reports,payments]        <- settings, users and audit gone
```

Today the desktop sidebar is permission-derived (`web/src/components/Layout.tsx:89`
`NAV.filter(can(...))`), so only the **mobile bottom bar** shrinks and there is no hard lockout.
The moment the shell honours `experience.nav` — which is the engine's stated purpose — this
becomes an owner self-lockout out of Settings/Users, i.e. the D3 lockout class. Related: switching
sector leaves the previous sector's roles behind with their permissions (probe P6: `cashier` with
`sales.create` survives a switch to manufacturing) and the result object never mentions them.
**Fix.** Skip presets whose matching role has `isOwnerRole = true` (never narrow an owner's
surface), report orphaned roles from the previous sector in `ProvisionResult`, and record `before`
in the `saveRoleExperience` audit entry.

### M9 — `capacity` is decorative; a shared resource can hold exactly one booking **[M · CONFIRMED]**
`createBooking` checks `partySize > resource.capacity` per booking (`:132`) but the overlap rule
(`:96–112`) is **exclusive**, so a second concurrent booking is always refused regardless of
remaining capacity. Probe B3: a capacity-30 class accepted one enrolment of 1, then refused the
second with `double_booked`. `sector.education` ships `bookings` with an `enrol` action and
`sector.restaurant` with table bookings — both need N concurrent holders on one resource.
`createResource` also accepts `capacity: 0` and `capacity: -5` (probe B3b), producing a resource
that can never be booked.
**Fix.** Decide the model explicitly: either resources are exclusive (then drop `capacity`, or
document it as "max party per booking" and validate `capacity >= 1`), or the conflict test becomes
`SUM(partySize of blocking overlaps) + newPartySize <= capacity`, computed inside the same `inTx`.
Whichever is chosen, add the test that a capacity-30 class takes 30 enrolments and refuses the 31st.

### M10 — `createRole` is ungated and provisioning requires only `settings.edit` **[M · CONFIRMED · latent]**
`permissions.ts:26–73` contains **no** `requirePermission` (probe O10) — it is guarded solely at
the route layer. `provisionFromOnboarding` checks only `settings.edit` (`:144`) and then creates
roles carrying verbs the caller may not hold (`quality.approve`, `settings.approve`,
`production.edit`, `inventory.create`). Today this is unreachable: provisioning is not routed
(probe O5) and `bindTenantTemplate` demands an owner, which stopped a `settings.edit`-only
attacker at step 2 with no roles created (probe O9/O9b). It arms the moment provisioning is
exposed or the binding check is relaxed.
**Fix.** Add `requirePermission(ctx,'users','manage_users')` at the top of
`provisionFromOnboarding` (it is required by `saveRoleExperience` anyway, so demanding it up front
only makes the failure honest), and give `createRole` its own internal guard.

---

## 3. Lows (tracked, no immediate action)

| # | Item | File |
|---|---|---|
| L1 | `createResource` insert + audit are not wrapped in `inTx` (D3 class); `capacity` unvalidated (0/−5 accepted) | `bookings.ts:35–64` |
| L2 | `customerId` is tenant-checked but not kind-checked — a `supplier` party can be booked as a guest | `bookings.ts:129` |
| L3 | Every `UPDATE` filters on `id` only, not `(tenantId, id)` — safe today because `getWorkOrder`/`getBooking` pre-validate the tenant, but it removes the defence-in-depth every other table has | `workorders.ts:125,164`; `bookings.ts:182,220` |
| L4 | `GET /api/onboarding/sectors` is authenticated but not permission-gated — any user enumerates the full 20-sector platform catalogue and every surface id (probe H9). Platform data, not tenant data | `routes/onboarding.ts:22–25` |
| L5 | `country` has no length cap: a 500 000-char value returns a 501 714-byte response (probe H13) | `onboarding.ts:65–67` |
| L6 | `lotId` is never validated against `lots` (no tenant/item check). Fails closed — a foreign lot has no balance row, so `postMovement` rejects with `insufficient_stock` (probe W11) — but the error is misleading and traceability depends on it | `workorders.ts:220–244` |
| L7 | A `checked_in` booking can never be moved or extended (`rescheduleBooking` demands `confirmed`), so a guest extending a stay has no path (probe B5b) | `bookings.ts:215` |
| L8 | `work_order_parts_wo` index omits `tenant_id` while the query filters on it | `db/schema.ts:278` |
| L9 | `saveRoleExperience` audits `after` but never `before`, so an overwrite is not reconstructable from one audit row (prior versions do persist in `role_experiences`) | `experience.ts:84–92` |
| L10 | An invalid `GrowthTier` silently degrades to base activations rather than erroring (`order.indexOf(tier) === -1`); harmless but silent (probe O4) | `sectors.ts:743–744` |

---

## 4. Proven sound — no action required

Each of these was attacked and held.

**Tenant isolation across all four new tables (`work_orders`, `work_order_parts`,
`bookable_resources`, `bookings`).** `tenantId` is taken from `ctx`/`tx` at every insert and never
from a request body (probe T1, both files). Cross-tenant `getWorkOrder` → `404`; assigning a
foreign tenant's user → `assignee_invalid` (the explicit `assertTenantUser` guard at
`workorders.ts:101–108` is the right pattern); booking a foreign resource → `404`; reading or
cancelling a foreign booking → `404` (probes W1, W2, B4, B4b, B4c). `getItem`, `getWarehouse` and
`getParty` are all tenant-scoped.

**Sector data integrity — verified independently of the shipped tests.** Across all
**20 sectors × 5 growth tiers**: zero activations naming a capability absent from
`CAPABILITY_CATALOG`, zero `validateResolved` errors, zero resolution conflicts (probes S1–S3).
This is structurally guaranteed, not accidental — `CapabilityId` is derived from the
`CAPABILITIES` tuple and `CAPABILITY_CATALOG` is typed `Record<CapabilityId, CapabilityDef>`, so
drift is a compile error. Stronger than the shipped test: every sector layer also resolves cleanly
with **no core layer at all** (probe S4). No role preset references an unknown `ModuleId` and none
grants `manage_users`, `delete`, or `view_financial` (probes S5, S6).

**Onboarding resolver leaks nothing.** `recommendConfiguration` performs **no database reads
whatsoever** — byte-identical output against a fully populated tenant DB and an empty one (probe
O3), so there is no cross-tenant enumeration surface. `SECTOR_BY_ID` is a `Map`, so `__proto__`,
`constructor`, `toString` and `''` are all rejected as unknown sectors (probe O1). A SQL-payload
`country` is echoed as an inert template-stack string and the `bookings` table survives intact
(probe O2) — every query in the new code is Drizzle-parameterised. `POST /api/onboarding/recommend`
and `/growth` correctly demand `settings.view` (probe H10). Provisioning is **not reachable from
any route file** (probe O5) and its system-context guard rejects a tenant user passed as
`systemCtx` (probe O6).

**Quantity guards cover the new path.** The R2 `MAX_ENTRY_QTY`/`MAX_MOVEMENT_QTY` work does protect
`issuePartToWorkOrder`: `-5` → `wo_part_qty`; `0` → `wo_part_qty`; `1e15` → `movement_qty_range`;
`Infinity` → `movement_qty`; `NaN` → `wo_part_qty`; `0.0004` (rounds to zero milli) → `movement_qty`
(probe W7). No path pushes a balance toward `MAX_SAFE_INTEGER`.

**Lifecycle and permission gates.** `draft → completed` is refused (probe W6); a completed job
cannot be cancelled; parts cannot be issued to a completed or cancelled job (W8b); a technician
cannot advance a colleague's job without `production.approve` (W4); a `dashboard.view`-only user
cannot create or list work orders; a `sales.view`-only user cannot check a booking in (B8); a
cancelled booking can be neither checked in nor rescheduled (B5); zero-length and inverted booking
ranges are refused (B6). Every state change on both entities writes an audit row —
`work_order_{create,assign,in_progress,completed,cancelled,part_issue}` and
`booking_{create,checked_in,completed,cancelled,no_show,reschedule}` plus `resource_create`
(probes W12, B9). Audit coverage on the new mutations is complete.

**Concurrency (SUSPECTED sound).** The double-booking re-check sits inside `inTx`
(`bookings.ts:136–141`) and `better-sqlite3` is synchronous on a single-threaded Node process, so
no two `createBooking` calls can interleave **within the server process** — the check genuinely
holds under the single-connection model. The residual is the known D10 item: `inTx` uses a
deferred `BEGIN`, so a *second OS process* touching the same DB file (an ops script, a second
server instance) could read-then-write across the check. `BEGIN IMMEDIATE` would close it. Not
newly introduced by this code; noted so it is not mistaken for proven-safe.

---

## 5. Prioritised must-fix list

**Before the bookings capability is put in front of any real tenant:**

1. **H1** — normalise `startAt`/`endAt` to canonical `toISOString()` in `createBooking` and
   `rescheduleBooking`, with mixed-offset tests. *The double-booking rule is currently decorative.*
2. **H3** — validate both timestamps with `Date.parse` and impose a configurable maximum duration.
   (Same code site as H1 — fix them together.)

**Before work orders are put in front of any real tenant:**

3. **H2** — check `getAvailable` (not just on-hand) inside `issuePartToWorkOrder`'s transaction.
4. **M1** — require `production.edit` + the assignee/`production.approve` rule for parts issue.
5. **M2** — move `requirePermission` above the status check in `transition()`; guard `getWorkOrder`.

**Before the next slice ships:**

6. **M4** — real numeric type guard on `qty`; **M5** — `req.body ?? {}` on the five crashing routes;
   **M6** — bound `limit` and paginate `listBookings`.
7. **M3** — a parts-return path, or refuse to cancel a job holding un-returned parts.

**Before a second tenant is onboarded through the resolver:**

8. **M7** — wrap `provisionFromOnboarding` in `inTx`, publish a global layer version only on real
   content change, and narrow the blind `catch`.
9. **M8** — never rewrite an `isOwnerRole` role's experience; **M10** — require `manage_users`.

**M9** (capacity semantics) is a product decision, not a patch: decide whether a bookable resource
is exclusive or shared before `sector.education` or `sector.restaurant` is sold.
