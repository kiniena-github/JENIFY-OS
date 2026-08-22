# JENIFY OS — Security Red Team, Round 2

> Adversarial review of the **newly committed Wave-1 engines** (branch `wave-1`,
> commits `6b1531e` + `61bb75f`): template engine, Role Experience, Shared
> Approvals, Offline Receiving sync, Migration import, and JENIFY AI (read-only).
> Author role: **jenify-qa-security** (security-permissions depth) — RED TEAM.
> Date: 2026-08-22. **Read-only**: no repo code changed except this report.
> Method: traced every new service from its route; grepped for consumers of each
> new capability; verified tenant-scoping of every param-driven resolver; checked
> the new unique indexes (migration 0008) against the idempotency/collision claims;
> cross-referenced `RED_TEAM_R1.md`, the gate reviews (M1/M2/L1 fixes), and
> `FACTORY_OS_CURRENT_STATE.md` §5. Round-1 items and already-fixed gate items are
> only re-reported where still exploitable or newly reachable.

**Severity:** C critical · H high · M medium · L low. **State:** CONFIRMED (proven by
code) · SUSPECTED (design/low-confidence or needs a not-yet-wired consumer).

---

## 0. Bottom line

**No CONFIRMED Critical exists in the new engines.** The two crown-jewel properties
they were built to hold — *experience ⊆ permissions* and *AI cannot escape the closed,
tenant-scoped catalog* — **held under attack** (F-EXP-1, F-AI-1/2 CONFIRMED safe). The
approvals engine's server-side SoD / step-role / policy-version-pin logic is sound, and
the offline replay's at-most-once idempotency is correct (tenant-scoped `opKey`, in-tx
domain-write+marker, business-rejection recorded not merged).

**The one CONFIRMED-reachable High is not new code — it is an unmet Round-1 pre-req that
the new engines now expose.** RED_TEAM_R1 §6.6 said the **D5 finiteness/magnitude guard**
"must land first" before offline replay (O-5) and were a dependency for import. It did
**not** land (register D5 still OPEN, `masterdata.ts:63`). Both new write engines —
migration `opening_inventory` import and offline `receiving.post` replay — drive
`toBaseQty`/`postMovement` with an **unbounded** quantity, so a single crafted row/op can
post a ledger movement near/over `MAX_SAFE_INTEGER` and permanently corrupt on-hand sums
on the append-only ledger (F-IMPORT-1 / F-SYNC-5).

**Scariest realistic attack on the new engines:** an authorized operator (or a forged
offline op) imports one opening-inventory line with `qty = 99999999999999`. There is no
upper bound anywhere on the path (`parseNumber` only checks `isFinite`; `postMovement`
only checks non-zero integer). `toBaseQty` multiplies by the milli factor and the movement
posts. `getOnHand` for that item/warehouse now sums a value past 2^53 — float precision is
lost, every subsequent balance for that bucket is wrong, and because the ledger is
append-only it cannot be edited away, only reversed with an equally huge counter-movement.
Same overflow lands through the offline queue with no confirm step.

**Top 3 must-fix:**
1. **F-IMPORT-1 / F-SYNC-5 (H, = D5)** — land the finiteness/magnitude guard in
   `toBaseQty`/`postMovement` (cap resulting milli magnitude), and reject import rows /
   sync payloads above a sane per-line maximum. This closes the same hole in import,
   offline replay, and normal receiving at once.
2. **F-APPR-1 (M, bank now)** — before any domain first consumes approvals, the domain
   service must compute the subject's **true magnitude server-side** and gate posting on a
   magnitude-bound check; `isApproved` today ignores magnitude and policy version entirely.
3. **F-IMPORT-4 + F-SYNC-4 (M/L)** — add a unique constraint on opening-inventory
   `documentId` (concurrent double-import), and a light rate/permission gate on
   `/api/sync/replay` (any authenticated user can spam rejected `sync_ops` rows).

---

## 1. Shared Approvals engine

**Live surface today is small: the engine is DORMANT.** Grep confirms **no domain service
calls `openApprovalIfRequired` or `isApproved`** — the only references are the definitions
in `approvals.ts` and the route wiring of `decideApproval`/`cancelApproval`/`saveApprovalPolicy`.
Because `openApprovalIfRequired` is not wired to any route and no domain invokes it, **no
approval request can be created through the API yet**, so `decide`/`reject`/`cancel`/`history`
operate on a set that is currently empty. The findings below are therefore mostly *design
guidance to bank before the first consumer ships* — which is exactly when they bite.

Confirmed-good (gate M1/M2/L1): policy version is pinned per request and evaluated at
decide time (`approvals.ts:36-54, 214`); steps must use distinct approver roles
(`:62-65`); step-role match + separation-of-duties enforced server-side (`:219-225`);
open-status re-checked inside the tx (`:229-234`).

### F-APPR-1 — `isApproved` ignores magnitude & policy version; `openApprovalIfRequired` trusts a caller-supplied magnitude — M (CONFIRMED code property; SUSPECTED exploit, no consumer yet)
- **Where:** `services/approvals.ts:118-124` (`openApprovalIfRequired` takes
  `magnitudeMinor` from its caller; `policyRequiresApproval` gates on `magnitude >= threshold`,
  `shared/approvals.ts:53-60`) and `services/approvals.ts:307-322` (`isApproved` returns
  true iff the **latest request by `createdAt`** is `'approved'` — it never re-reads the
  subject's magnitude, the request's `magnitudeMinor`, or the policy version).
- **What / future exploit:** the engine binds an approval **decision** to a `subjectId`,
  but not to the **amount** that was approved. Two decoupling traps for the first domain
  that wires this:
  1. *Undershoot to skip.* If a domain computes `magnitudeMinor` from a client-influenced
     draft and calls `openApprovalIfRequired` with a value below the threshold, it returns
     `required:false` and **no request is created** — the domain proceeds to post whatever
     amount it likes. (Also NaN/negative magnitude → `>= threshold` is false → skip.)
  2. *Small approval covers a large post.* An approval granted for a tiny magnitude makes
     `isApproved` return true; if the subject is later edited upward before posting,
     `isApproved` still returns true — the control is silently defeated.
- **State:** CONFIRMED as a property of the code; the exploit is SUSPECTED only because no
  domain consumes the engine yet.
- **Fix (guidance to bank now):** the domain service must (a) compute the subject's true
  economic magnitude **server-side**, never accept it from the client; and (b) gate posting
  on a magnitude-aware check — add `requireApprovedFor(ctx, subjectType, subjectId, finalMagnitudeMinor)`
  that recomputes `policyRequiresApproval` against the FINAL magnitude and requires an
  approved request whose recorded `magnitudeMinor >= finalMagnitudeMinor`. Reject a subject
  edited above the approved magnitude (re-approval required). Validate `magnitudeMinor` is a
  finite non-negative integer at `openApprovalIfRequired`.

### F-APPR-2 — multiple open requests per subject; `isApproved` "latest-wins" is a loose binding — L (SUSPECTED)
- **Where:** `approvals.ts:127-174` (nothing dedupes concurrent requests for one
  `(subjectType, subjectId)`) + `:307-321` (latest-by-`createdAt` wins).
- **What:** a subject can carry several requests. A legitimately approved subject can be
  masked by a newer pending request; the "which wins" answer is purely temporal, not tied
  to the request the domain is actually holding. Racing a second `openApprovalIfRequired`
  for the same `subjectId` produces a second pending row that shadows the first.
- **Fix:** when wiring, have the domain hold the specific `requestId` and gate on **that**
  request's status, or add a partial-unique "one open request per subject" rule.

### F-APPR-3 — the approval control's own config is not approval-gated — L (by-design note)
- **Where:** `saveApprovalPolicy` requires only `settings.edit` (`approvals.ts:58`).
- **What:** a single `settings.edit` holder can publish a new policy version with
  `active:false` or a huge `thresholdMinor`, silently disabling the control with no
  second-person sign-off. Legitimate admin power, but worth surfacing: the thing that
  enforces separation-of-duties is itself changeable by one person.
- **Fix:** consider making sensitive policy edits themselves an approval subject, or at
  least audit-alert on `active:false`/threshold-raise (audit row already written, `:95`).

### F-APPR-4 — approval read routes are unpermissioned (metadata) — L (CONFIRMED, low impact)
- **Where:** `routes/admin.ts:279` (`/api/approvals/pending`), `:300` (`/api/approvals/:id/history`)
  have no `requirePermission`. History returns the full append-only action log (who
  requested/approved, comments, timestamps) to any authenticated tenant user who supplies a
  `requestId`.
- **Mitigation:** `requestId` is a `newId()` UUID (unguessable) and everything is
  tenant-scoped via `loadRequest`; `decide`/`reject` still enforce role+SoD in-service.
  `pending` only returns the actor's own queue. So this is metadata exposure gated by an
  unguessable id, not an authority bypass.
- **Fix:** add `requirePermission(ctx,'settings','view')` (or a dedicated `approvals.view`)
  on the history route for parity.

---

## 2. Offline Receiving sync (replay)

Confirmed-good: at-most-once via tenant-scoped `sync_ops_key (tenant_id, op_key)` unique
index (`schema.ts:320`, `migration 0008`); domain write + applied-marker commit in one
`inTx` (`syncops.ts:117-134`); business rejection recorded as a separate row and surfaced,
never merged/LWW (`:147-164`); duplicate replay returns the ORIGINAL recorded outcome
without re-executing (`:107-109`); the op re-runs the real permission+validation path on
the **live** server (`applyReceivingPost` calls `requirePermission` then `createReceipt`/
`postReceipt`). O-1, O-3, O-4, O-6 from RED_TEAM_R1 are satisfied.

### F-SYNC-5 — offline `receiving.post` payload is unvalidated and unbounded (O-5, ties to D5) — H (CONFIRMED)
- **Where:** `services/syncops.ts:49-56` casts `payload as ReceiptInput` with **no schema
  validation** (no `additionalProperties:false`, no finiteness/magnitude guard);
  `createReceipt` validates only `netQty > 0` and `netQty <= grossQty`
  (`receiving.ts:34,41`) — **no upper bound** — then `toBaseQty` (`masterdata.ts:63`)
  and `postMovement` (`inventory.ts:30`, only `Number.isInteger && !=0`).
- **Exploit:** queue one op with `netQty = 1e13` (or larger). It re-validates fine and
  posts a stock movement past `MAX_SAFE_INTEGER`, corrupting `getOnHand` for that
  item/warehouse — with **no confirm step**, straight off the sync queue.
- **State:** CONFIRMED reachable. RED_TEAM_R1 §6.6 named D5 as a pre-req that had to land
  **before** this engine; it did not. Register D5 (`FACTORY_OS_CURRENT_STATE.md:89`) OPEN.
- **Fix:** land the D5 guard in `toBaseQty`/`postMovement` (cap milli magnitude, e.g.
  `|milli| < 1e12`); additionally schema-validate the sync payload envelope
  (`additionalProperties:false`, typed numeric fields) so unknown fields can't ride along.

### F-SYNC-1 — `receivedByUserId` smuggle — FIXED (verified landed)
- Client-supplied `receivedByUserId` is now stripped in `applyReceivingPost`
  (`syncops.ts:53-56`) and the receipt is attributed to the syncing actor. Verified
  present. **Parity note (L):** the **online** `createReceipt` still honors
  `input.receivedByUserId ?? actorId` (`receiving.ts:69`) — a pre-existing attribution
  field (not an auth/`approvedBy` field, which is always `actorId`), but it lets the online
  caller set the "received by" label to an arbitrary string. Consider the same strip/whitelist
  there for consistency.

### F-SYNC-2 — `deviceId` / `clientCreatedAt` are client-asserted and unverified — L (CONFIRMED, low impact)
- **Where:** `syncops.ts:129-131,159-162` record `deviceId` and `clientCreatedAt`
  verbatim from the payload; there is no device registry / session-device binding yet
  (RED_TEAM_R1 O-2).
- **What:** a device can forge `deviceId` (misattributing the *originating device* in the
  `sync_ops` row) and set an arbitrary `clientCreatedAt`. **`appliedBy` is derived from
  `ctx` (`actorId(tx)`), NOT forgeable**, and the ledger/audit use `ctx` + server
  `serverAppliedAt`/`postedAt` — so this is purely attributional metadata on the `sync_ops`
  table, never authority or ledger ordering. The "misattribute a posting" attack is
  DISPROVEN for the ledger and audit; it lands only on `sync_ops.deviceId`.
- **Fix:** when the device registry lands, bind `deviceId` to the session and reject a
  mismatch; keep `clientCreatedAt` display-only (already the case).

### F-SYNC-4 — any authenticated user can replay; rejected rows are unbounded & terminal — L (CONFIRMED table-growth; SUSPECTED targeted poison)
- **Where:** `routes/sync.ts:13` (`/api/sync/replay` has **no route permission**;
  authority is enforced only inside each handler); rejection insert `syncops.ts:147-164`.
- **What:** a user *without* `inventory.create/approve` can still POST ops; each attempt is
  a `forbidden` business rejection recorded as a `sync_ops` row (`status:'rejected'`, one
  per client-chosen `opKey`). This is unbounded table growth / `opKey`-slot squatting with
  no rate limit. A rejected `opKey` is terminal, so *if* an attacker could predict a
  legitimate device's future `opKey` they could pre-poison it — but `opKey` is a UUIDv7
  with random bits, so targeted poisoning is infeasible (SUSPECTED, low feasibility).
- **Fix:** add a light per-user rate budget on `/api/sync/replay`, and/or require the
  relevant module `view` at the route so unprivileged users can't spam rejected rows.

### F-SYNC-3 — opKey collision / overwrite — DISPROVEN
- Unique index is **tenant-scoped** `(tenant_id, op_key)` (`schema.ts:320`). A reused
  `opKey` with a *different* payload hits the fast path (`recordedResult`, `:107-109`) and
  returns the ORIGINAL outcome without re-executing — no overwrite, no confusion. Cross-tenant
  poisoning is impossible (tenant scoping). At-most-once holds.

---

## 3. Role Experience engine

### F-EXP-1 — experience ⊆ permissions — CONFIRMED SAFE (the property holds under attack)
- `effectiveExperience` (`services/experience.ts:110-144`) intersects every surface with the
  **live** permission matrix from `ctx.user`: `nav` is filtered by `MODULES.includes(m) &&
  canView` (`:123`), `quickActions`/`mobileActions` by `actionPermitted(a.module, a.action ?? 'view')`
  (`:131-133`). A crafted spec with unknown module strings, a huge `nav` array, or arbitrary
  `path`s can **never** surface a module/action the user lacks — unknown modules are dropped,
  a quick-action `path` is only a client nav hint, and the server still RBAC-enforces every
  route independently. `effectiveExperience` reads only the stored spec + `ctx`; it trusts no
  client input at resolve time (only `saveRoleExperience`, gated by `users.manage_users`, writes).

### F-EXP-2 — `kpis` / `defaultFilters` returned verbatim (no server-side pollution) — L (CONFIRMED, low impact)
- **Where:** `experience.ts:140-141` returns `spec.kpis` and `spec.defaultFilters` verbatim,
  unfiltered.
- **What:** these are not intersected with anything (they're presentation hints). This is
  **not** server-side prototype pollution — the spec is a JSON round-trip (Drizzle
  `stringify`/`parse`), which materializes a `__proto__` key as an own enumerable property
  rather than polluting `Object.prototype`, and the server never spreads `defaultFilters`
  into another object. Writing a spec requires the trusted `users.manage_users`. Residual
  risk is only if the **client** shell unsafely merges `defaultFilters` (e.g. spreads it into
  a query object) with a `__proto__`/`constructor` key present.
- **Fix:** have the web shell treat `defaultFilters` as opaque string values and ignore
  `__proto__`/`constructor`/`prototype` keys; optionally validate the spec shape on save.

### F-EXP-3 — `saveRoleExperience` latest-version query is not tenant-scoped — L (CONFIRMED, benign)
- **Where:** `experience.ts:64-70` filters the `latest` version by `roleId` only (and the
  `role_experiences_ver` unique index is `(role_id, version)`, `schema.ts:241`), unlike the
  tenant-scoped pattern used elsewhere. Benign because `roleId` is a globally-unique UUID, so
  cross-tenant collision cannot occur — but it is an inconsistency worth hardening
  (add `eq(tenantId)`) for defense-in-depth.

---

## 4. JENIFY AI (read-only)

### F-AI-1 — cross-tenant read via param-trusting resolver — DISPROVEN (CONFIRMED safe)
- `IntentParams` has **no** `tenantId` field (`ai.ts:58-69`); `answerIntent` derives scope
  from `ctx` only and runs every `requiredPermissions` check fail-closed **before** any data
  access (`:709-735`). Audited each param-driven resolver: `creditOverview`
  (`creditview.ts:33` always `eq(tenantId)`, `customerId` is an *additional* filter),
  `listMovements` (`inventory.ts:289`), `rawStockReport`/`finishedInventoryReport`
  (`reports.ts:38,44,382,389` all tenant-scoped; `warehouseId` is a post-filter over
  already-tenant-scoped rows), `getOnHand` (`inventory.ts:102`). A foreign
  `customerId`/`lotId`/`itemId`/`warehouseId` therefore returns **empty**, never another
  tenant's data. `read.parties.customer_360` additionally guards with `getParty` (tenant-scoped
  `notFound`) before touching credit (`ai.ts:631`). Cross-tenant read is closed.

### F-AI-2 — prompt-injection / capability escape / text-to-SQL — DISPROVEN (CONFIRMED safe)
- `ai.ts` imports **no** `Db`/ORM/`better-sqlite3` and issues no query — it calls only
  existing tenant-scoped read services. The NL matcher (`matchIntent`, `:832-867`) is
  deterministic keyword matching over a **closed** rule set, with up-front refusal of
  instruction-override / SQL / secret-exfil markers (`:817-847`); a successful "injection"
  can at most select an in-catalog intent, which still runs `requirePermission` + server-side
  `canViewFinancial` masking. `matchIntent` returns `params:{}` (it never extracts ids from
  free text), so the NL path cannot inject `warehouseId`/`customerId`. Financial masking
  happens server-side before bytes are returned (`ai.ts:730-732` + per-intent `showMoney`).

### F-AI-3 — no assistant kill-switch / rate budget; one unaudited trivial path — L (CONFIRMED)
- **Where:** `routes/assistant.ts` — every `answerIntent` call is audited incl. refusals
  (good), but there is **no `assistant.enabled` kill switch, no `assistant` module
  permission, and no per-user/per-tenant rate or spend budget** (RED_TEAM_R1 AI-9). Any
  authenticated user can call `/api/assistant/ask` repeatedly; each runs potentially heavy
  reads (`dashboard()`, multi-report packs). Because it is read-only and local (no LLM cost),
  impact is compute-DoS only → Low. A request with neither `intentId` nor `utterance` throws
  400 **unaudited** (`assistant.ts:51`) — nothing executed, negligible.
- **Fix:** add an `assistant` module gate + a light rate budget from day one, as AI-9
  recommended, before the layer grows any write intents.

---

## 5. Migration import

Confirmed-good: preview performs zero writes (`previewImport` uses only reads + pure
`processRow`; `toBaseQty` is a pure `getUom`+`Math.round`); negative/zero qty rejected
(`importing.ts:582`); a missing required field is a row error, never a fabricated default
(`:519-526`); opening inventory posts only through `postMovement` (append-only, audited)
inside a single tx (`:717-782`).

### F-IMPORT-1 — opening-inventory qty has no magnitude guard (= D5) — H (CONFIRMED reachable)
- **Where:** `importing.ts:579-587` — `parseNumber` (`:232-249`) enforces only `isFinite`;
  `qtyNum <= 0` is rejected but there is **no upper bound**; `toBaseQty`
  (`masterdata.ts:63`, register **D5**) = `Math.round(entryQty * factorToBase)` →
  `postMovement` (`inventory.ts:30`, only non-zero-integer check).
- **Exploit:** import one row with `qty = 99999999999999`. It validates, converts to a huge
  milli value, and posts a movement past `MAX_SAFE_INTEGER`. `getOnHand` for that
  item/warehouse now sums with lost float precision — permanently, on the append-only
  ledger. Same root as F-SYNC-5 and normal receiving (`receiving.ts:34`).
- **State:** CONFIRMED; register D5 OPEN; RED_TEAM_R1 §6.6 flagged it as a pre-req for
  exactly these engines.
- **Fix:** land the D5 finiteness/magnitude guard centrally in `toBaseQty`/`postMovement`
  (cap milli magnitude) and reject import rows above a sane per-line max in `processRow`.

### F-IMPORT-4 — concurrent double-import (no unique constraint on opening documentId) — M (SUSPECTED)
- **Where:** dedup relies on `ref.openingDocIds` loaded at preview
  (`importing.ts:479-481`) + the `openingDocId(item,wh,lot)` written as
  `stock_movements.document_id`. But `movements_doc` is a **non-unique** index
  `(tenant_id, document_kind, document_id)` (`schema.ts:526`) — there is no DB uniqueness.
- **Exploit:** two concurrent `executeImport` calls of the same file both preview (each sees
  no existing docId) and both insert → **two** opening-balance movements for the same
  item/warehouse/lot. Idempotency is purely application-level and races across requests.
  SUSPECTED (needs concurrency; same authorized user).
- **Fix:** add a unique index on `(tenant_id, document_kind, document_id)` for opening
  inventory (or perform the dedup read inside the same tx as the insert).

### F-IMPORT-2/3 — preview writes / cross-tenant id smuggle / prototype pollution — DISPROVEN (CONFIRMED safe)
- **Preview zero-write:** confirmed (reads + pure functions only). `/api/import/detect`
  is unpermissioned but only echoes the client's own parsed input — no tenant data. (Low
  note: gate it too for consistency.)
- **Cross-tenant item/warehouse:** rows carry names/codes resolved against **tenant-scoped**
  ref data (`listItems`/`listWarehouses(ctx)`); resolved ids (`__itemId`/`__warehouseId`)
  are set **only** from server lookups (`importing.ts:590-591`) and are never read back from
  the file — the CLEAN loop iterates `ENTITY_FIELDS` only (`:513-516`), so even a malicious
  `opts.mapping` key like `__itemId` is never consulted. A foreign id cannot be referenced.
- **Prototype pollution via headers→mapping keys:** `cleaned` is a fresh object written only
  under `ENTITY_FIELDS` field names; a `__proto__` header would be a mapping *value* (source
  column name), never an assignment key. Safe.

---

## 6. Template engine

### F-TMPL-1 — reaching `publishTemplateLayer` / cross-tenant `bindTenantTemplate` from tenant context — DISPROVEN (CONFIRMED safe)
- **Wiring:** only `/api/template/resolved` and `/api/template/layers` are routed, both GET,
  both `settings.view` (`admin.ts:227-237`). **`publishTemplateLayer` and `bindTenantTemplate`
  are not wired to any route** (grep-verified).
- **`publishTemplateLayer`** is system-only: `ctx.user !== null → forbidden`
  (`templates.ts:64-66`), so no tenant user — owner or not — can publish a global layer even
  if a route were wired.
- **`bindTenantTemplate`** requires `settings.edit` + `isOwnerRole` (`templates.ts:225-234`)
  and writes only `ctx.tenantId`'s binding (`tenantId` from `ctx`, `:257`) — it cannot target
  another tenant, and `layers` reference *global* template ids (there is no per-tenant template
  ownership to cross). Binding "another tenant" is impossible by construction.
- **Guidance:** when these are eventually wired, keep `publishTemplateLayer` behind the
  platform-admin principal (WM5) and never expose it on a tenant route; keep `bindTenantTemplate`
  owner-gated.

---

## 7. Prioritized must-fix list

**Do first (the one CONFIRMED-reachable High):**
1. **F-IMPORT-1 / F-SYNC-5 (H, = D5, OPEN)** — land the finiteness/magnitude guard in
   `toBaseQty` (`masterdata.ts:63`) and `postMovement` (`inventory.ts:30`); reject import
   rows and sync payloads above a sane per-line maximum. One fix closes import, offline
   replay, and normal receiving. Add `additionalProperties:false` payload validation to the
   sync envelope while there.

**Bank before the first consumer ships (design guardrails):**
2. **F-APPR-1 (M)** — the domain that first consumes approvals must compute magnitude
   **server-side** and gate posting on a magnitude-bound check
   (`requireApprovedFor(...finalMagnitudeMinor)`); `isApproved` must not be used alone.
3. **F-APPR-2/3/4 (L)** — dedupe open requests per subject / hold the specific `requestId`;
   audit-alert on policy disable; permission-gate the approval history route.

**Hardening (Wave-1, lower urgency):**
4. **F-IMPORT-4 (M)** — unique index on opening-inventory `documentId` (concurrent double-import).
5. **F-SYNC-4 (L)** — rate/permission-gate `/api/sync/replay`; **F-SYNC-2 (L)** — bind
   `deviceId` to the session when the device registry lands; **F-SYNC-1 parity (L)** — strip
   `receivedByUserId` on the online receiving path too.
6. **F-AI-3 (L)** — add the `assistant` module gate + rate/spend budget and kill switch
   before any write intents.
7. **F-EXP-2/3 (L)** — client ignores `__proto__` in `defaultFilters`; tenant-scope the
   `saveRoleExperience` latest-version query.

---

## 8. Register cross-reference

| Item | Prior status | Round-2 verification |
|---|---|---|
| **D5** magnitude/finiteness guard | OPEN (H, WP4) | Confirmed still OPEN and **now reachable** via import (F-IMPORT-1) and offline replay (F-SYNC-5); it was RED_TEAM_R1 §6.6's pre-req for these engines. |
| Approvals M1 (pin policy version) / M2 (distinct roles) / L1 (in-tx recheck) | fixed at gate | Confirmed present and correct (`approvals.ts:36-54,62-65,229-234`). |
| Offline O-1/O-3/O-4/O-6 (idempotency, live re-validation, rejection recorded, no auto-retry) | design targets | Confirmed satisfied in `syncops.ts`. |
| Experience ⊆ permissions; AI closed-catalog + tenant scope | safety claims | Confirmed hold under attack (F-EXP-1, F-AI-1/2). |
| `receivedByUserId` offline smuggle | (new) | Fixed mid-review by Team Lead (`syncops.ts:53-56`), verified; online-path parity noted. |

---

*End of Red Team Round 2. Read-only review; no repo code modified except this report.
Next round should re-test D5 after the guard lands (import + offline + receiving negative
tests at `1e13`), and re-audit the approvals engine the moment a domain first wires
`openApprovalIfRequired`/`isApproved` — that is where F-APPR-1 turns from latent to live.*

