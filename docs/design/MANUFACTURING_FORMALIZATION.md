# Manufacturing Formalization — Typed Production Models Blueprint

> Design-only blueprint by `production-manufacturing` (2026-08-22, Wave 1 Design track).
> No code, no migrations, no schema changes are proposed for immediate implementation.
> Source of truth for what exists today: `packages/server/src/services/production.ts`,
> `batches.ts`, `db/schema.ts` (production_stages / production_batches / quality_tests),
> `packages/config-mesob/src/seed.ts`, and the Founder decisions of 2026-08-17/19
> (stage output policies, explicit QC release gate, iodine-is-not-inventory).
>
> Purpose: preserve and GENERALIZE what the validated Mesob pilot taught us, so the
> manufacturing sector template family can grow without forking Mesob and without
> forcing process manufacturing into an assembly-shaped model.

---

## 1. The core thesis: two first-class typed production models

Manufacturing is not one thing. The platform defines **two typed production models**.
A tenant's subsector template selects which model(s) are active; both share one
common capability spine (§3). Neither model is expressed in terms of the other.

### Model A — PROCESS / BATCH (exists today; Mesob is the proof)

Material flows through a sequence of **stages** that transform a bulk quantity.
The natural unit of work is the **batch**: a dated, numbered run of one stage.

Defining characteristics (all validated in production at Mesob):

- **Stage-typed physics, never assumed.** Each stage declares:
  - `inputSource`: consume a tracked inventory **lot** (`lot`) or the bulk output of
    a **prior batch** (`prior_batch`).
  - `outputForm`: `bulk` (stays as batch balance for the next stage) or
    `packaged_items` (becomes finished inventory as a new lot).
  - `outputPolicy`: `measured` (output entered; loss derived = input − output),
    `conserved` (output = input by definition; **no invented loss**; a real measured
    variance is only ever an explicit audited correction), or `converted`
    (bulk mass → discrete units; unit-weight × units may never exceed input mass).
- **QC gates between stages.** A stage with `requiresQc` blocks downstream
  consumption until a passed test is **explicitly approved and released** by quality
  authority (two distinct events — see §7).
- **Batch genealogy.** Every batch knows its input lot or input batch; finished lots
  know their source batch; traceability walks both directions.
- **Batch-balance conservation.** A completed batch's remaining output
  (`outputQty − consumedOutputQty`) is the only quantity downstream stages may draw.
- **Declarative stage attributes.** Extra capture fields (e.g. iodine added, kg) are
  configuration (`StageAttributeDef[]`), not schema columns.

### Model B — JOB / DISCRETE / ASSEMBLY (future; design-first)

Discrete units are assembled from a **component list**. The natural unit of work is
the **work order**: make N units of item X.

Defining characteristics (none exist in code today; nothing here is committed):

- **BOM (component list).** Parent item → components with quantity **per unit**
  (contrast: a process formula is proportional per batch basis, §6).
- **Work order lifecycle.** Ordered qty → released → operations performed →
  completions posted (possibly partial) → closed. Completions create finished
  inventory; component issues consume it.
- **Operations / routing.** Ordered steps, later attached to work centers/machines.
- **Per-unit identity where needed.** Serialization (`trackingMode: 'serial'` is
  already declared platform-wide but unimplemented) matters here far more than in
  process manufacturing.
- **Issue modes.** Explicit material issue vs backflush-on-completion is a
  template/tenant configuration decision, not a hardcoded behavior.

### The non-negotiable boundary

**Do NOT force process into an assembly model.** The classic ERP failure mode is to
model washing/iodization as a "BOM with one component" and packaging as an "assembly
of salt + sack". Mesob proved why that is wrong:

- Process stages transform **one primary flow**; loss/variance semantics
  (`measured`/`conserved`) have no BOM equivalent.
- Additives can legitimately be **attribute-only** (iodine is a recorded fact, not
  consumed stock — Founder decision 2026-08-17). A BOM model would force a fake
  stock item and fake issues.
- Batch-to-batch consumption with a running balance (`consumedOutputQty`) is the
  process backbone; work orders have no such concept.

Equally: do not force discrete into batches. A furniture maker's work order for
40 chairs is not a "stage batch". Both models are first-class peers on the shared
spine below.

---

## 2. What exactly generalizes FROM Mesob (concept-by-concept map)

Every concept in today's implementation, mapped to the generalized model.

| Today (schema / service) | Generalized concept | Verdict |
|---|---|---|
| `production_stages` table (code, sequence, inputSource, outputForm, outputPolicy, requiresQc, priorStageId, attributes, docSeqKey) | **Process Route Stage** — a node in a tenant's process route. Already fully generic: nothing salt-specific in the table. | **Stays as-is.** Conceptually renamed "stage definition" → "process route stage"; later a named `process_route` groups stages instead of the implicit linear `priorStageId` chain. |
| `production_batches` lifecycle draft → in_progress → completed / cancelled; reservation on start; consume movement on completion | **Process Batch** — the Model A execution document. | **Stays as-is.** This is the platform-default batch engine, not Mesob code. |
| `outputPolicy` = measured / conserved / converted (+ `correctBatchOutput` audited variance) | **Stage physics vocabulary** for all process subsectors (dairy, oil, flour, beverages, chemicals…). | **Stays; promoted to subsector-template vocabulary.** The *assignment* of a policy to a stage is template/tenant config. |
| `qcStatus` incl. `passed_pending_release`; `recordQualityTest` + `approveQualityTest` two-step | **Platform-default QC release gate** (§7). | **Stays; becomes the default for BOTH models.** |
| `quality_tests` immutable attempts, `attemptNumber`, `previousTestId` retest chain | **QC attempt ledger.** | **Stays as-is** (invariant #4 in CURRENT_STATE §3). Generalizes by adding configured *test types* (§7); today's single free-text target/result is the degenerate one-test-type case. |
| `batchGenealogy` backward/forward walk (lot → batch → batch → finished lot) | **Traceability graph.** | **Stays; extends** to work orders/serials when Model B lands. Today's one-parent-per-batch walk becomes a multi-parent graph only when merge-inputs are approved (§9 Q2). |
| `outputBalance = outputQty − consumedOutputQty` | **Batch balance** — Model A's conservation primitive. | **Stays as-is.** |
| Reservation on `startBatch`, consume-on-complete via `postMovement` (`production_consume` / `production_output`) | **Materials-to-ledger contract** — production only ever touches stock through the append-only movement ledger. | **Stays as-is for both models.** Model B work orders must use the identical contract. |
| `StageAttributeDef` declarative capture fields | **Configured capture attributes** — generic mechanism. | **Stays.** Each subsector template ships its own attribute definitions. |
| `unitWeightMilliKg` check (units × unit-weight ≤ input mass) on `converted` stages | **Mass-conservation guard for conversion.** | **Stays; subsector templates decide** whether finished items carry unit weights. |
| `docSeqKey` per stage → `nextDocNumber` | **Per-document-kind numbering** (existing platform primitive). | **Stays.** Prefixes (WSH-/IOD-/PKG-) are template config. |
| `operatorName` / `supervisorName` free text on batches and tests | Placeholder for **workforce identity** (M5 design-first). | **Stays free text for now.** Do NOT generalize into a workforce module prematurely (CURRENT_STATE §6 says design first). |
| Stage codes `washing` / `iodization` / `packaging`, sequence 1-2-3, iodization=conserved+QC | **Salt sub-subsector template content.** | **NOT core. NOT subsector.** Lives only in the Salt template layer (§4). |
| `iodine_added_kg` attribute; iodine-is-not-inventory | Salt template attribute + a salt-template *choice* of consumption mode. | **NOT core.** The general model must support BOTH attribute-only additives and consumed-stock additives (§6); salt chose attribute-only. |
| Items RAW-SALT / SALT-500G/1KG/50KG, unit weights, Afdera supplier, warehouses A/B/C | Tenant/template master data. | **NOT core.** Item *archetypes* (raw bulk material, packed SKU with unit weight) belong to the salt template; concrete items are tenant data. |
| `production` settings key `iodization.target…` (default QC target) | **QC test-type target source** (§7). | Mechanism generalizes (per-domain versioned settings already exist); the iodine key itself is salt-template. |
| Roles: Production Operator / Production Supervisor / Quality Management with the exact permission split in `seed.ts` | **Manufacturing-sector role archetypes** (§8). | **Generalizes to the sector layer** (the split is universal); role names/translations are template content. |

**Summary:** the engine (`batches.ts`) is already generic — Mesob taught us the
vocabulary and we wrote zero salt-specific server code. Formalization is therefore
mostly (a) naming the model "PROCESS/BATCH" explicitly, (b) extracting Mesob's
`seed.ts` stage/item/role content into a declarative Salt template artifact
(roadmap risk #2: templates must stop being imperative scripts), and (c) defining
Model B alongside — not rewriting Model A.

---

## 3. Common capability spine (shared by both models)

Capabilities every manufacturing tenant gets, with per-model expression:

| Capability | Model A (process/batch) | Model B (job/discrete) |
|---|---|---|
| **Materials consumption** | Lot reservation on start; `production_consume` movement on completion; prior-batch draw via batch balance | Component issues against a work order (explicit or backflush) posting the same movement kinds |
| **Work stages** | Process route stages (sequence, physics, QC flags) | Routing operations on the work order |
| **Output** | Bulk balance or packaged lot (`production_output`) | Work-order completions creating finished lots/serials |
| **Scrap / loss** | `measured` loss (derived), `conserved` variance via audited correction, `unitsRejected` on packaging | Rejected units / scrapped components per operation, same audited-correction discipline |
| **QC** | Stage-level `requiresQc` gate | Operation-level and/or final-inspection gate — same test/attempt/release machinery (§7) |
| **Traceability** | Lot → batch chain → finished lot genealogy | Component lots/serials → work order → finished unit genealogy; same graph API |
| **Packaging** | `converted` stage producing packed SKUs | Final operation producing packed SKUs; same unit-weight guard where configured |
| **Costing foundation** (design only — see below) | Cost attaches at consumption/completion points | Same points: issues + completions |
| **Serialization** | Rarely needed (lot-level identity suffices for bulk) | First-class where template enables it (`trackingMode: 'serial'` exists, unimplemented) |
| **Machines / work centers** (M5, design-first) | Stage ↔ work-center association (capacity later) | Operation ↔ work-center association |

**Costing foundation (design only — no costing engine yet, M2 owns the engine):**
the formalization only fixes the seams so M2 does not require schema surgery:
1. All money is integer cents in the tenant default currency (existing invariant).
2. Cost enters at exactly the points where quantity already moves: material
   consumption (movement rows), batch/work-order completion (output rows), and
   loss/scrap (derived rows). No new event types are needed for costing.
3. Cost figures, when they exist, are **snapshots** on posted documents (same
   pattern as `pricingVersion` / `vatSnapshot`), never live lookups.
4. Costing method (FIFO-from-lots vs moving average vs standard) is an open
   Founder/product question (§9 Q4) — nothing in this blueprint presumes one.

---

## 4. Sector template structure: which config lives at which layer

Three layers, strictly additive (child layers add/select, never patch core
behavior). Extraction must come **from the real Mesob deployment**, not from
imagination (roadmap risk #2).

### Layer 1 — Manufacturing (sector)

- Enables the production module family + common capability spine (§3).
- Role archetypes: Production Operator / Production Supervisor / Quality (§8),
  including the record-vs-release permission split.
- QC machinery with **approve-and-release as the platform default gate** (§7).
- Traceability/genealogy APIs; production document kinds & audit vocabulary.
- Costing seams (§3) — dormant until M2.
- Declares that a subsector must select at least one production model (A and/or B —
  a plant can run both, e.g. a food processor that also assembles gift packs).

### Layer 2 — Process Manufacturing (subsector)

- Selects **Model A** as primary.
- The stage-physics vocabulary as the configuration surface: measured / conserved /
  converted; lot vs prior-batch input; bulk vs packaged output.
- Route archetype: linear stage chain (v1; branching is §9 Q2).
- **Formula/recipe BOM type** (proportions + tolerances, §6) — as opposed to the
  discrete component-list BOM type.
- Additive consumption modes: `attribute_only` and `stock` both available.
- Bulk mass UoM family defaults (kg/quintal/ton) and milli-base conventions.
- Batch documents per stage with per-stage numbering sequences.

*(Sibling subsector, for contrast: Discrete Manufacturing selects Model B, the
component-list BOM type, work orders, optional serialization.)*

### Layer 3 — Salt (sub-subsector; extracted from Mesob)

- The concrete stage graph: washing (lot-input, measured) → iodization
  (prior-batch, **conserved**, requiresQc) → packaging (prior-batch, converted,
  outputs = packed SKUs).
- The `iodine_added_kg` required stage attribute; the salt-template decision that
  iodine is attribute-only, not consumed stock.
- QC test type "iodine level" with its target sourced from the versioned
  `production` settings domain.
- Item archetypes: raw bulk salt (lot-tracked, sellable in bulk — a locked Mesob
  business fact that stays a template *option*, not an assumption), packed iodized
  SKUs with unit weights, packaging material archetype (sacks).
- Numbering prefixes (WSH-/IOD-/PKG-/RAW-…), stage/attribute translation keys
  (en/am/ti).
- Regulatory notes only as **open verification items** — Ethiopian iodization
  compliance targets follow the "VERIFY FIRST" posture (decision 2026-08-22 on
  e-invoicing); we never fabricate a legal threshold into a template.

**Rule of thumb:** if `batches.ts` would need an `if`, it's in the wrong layer.
Core reads configuration; subsector defines vocabulary and model selection;
sub-subsector defines actual physics, items, tests, and words.

---

## 5. Where Mesob's implementation must NOT be generalized

Explicit anti-goals, so Wave-1 enthusiasm doesn't sand off validated sharp edges:

1. **No invented loss.** `conserved` means output = input, full stop. No template
   may ship a "standard yield %" that auto-writes loss. Variance is always a
   measured, reasoned, audited correction (`correctBatchOutput` pattern).
2. **No automatic QC release.** A passed test never releases by itself, in any
   sector. Subsectors may *tighten* (extra approvals), never loosen to
   auto-release without a Founder decision.
3. **Iodine-as-attribute is a salt choice, not a platform rule** — and equally,
   attribute-only additives must remain possible forever; formalizing recipes
   (§6) must not retroactively force iodine into stock.
4. **Free-text operator/supervisor names stay** until the workforce milestone
   designs identity properly. Generalizing them into half a workforce module now
   creates the exact "giant generic ERP" the architect exists to prevent.
5. **Batches stay ad hoc** (no forced manufacturing orders / scheduling) until
   M3+ decides the demand link (§9 Q3).
6. **No costing engine** — seams only (§3).
7. **One output SKU per packaging batch** stays; producing three pack sizes from
   one iodization batch is three packaging batches drawing one balance. This is
   simpler and fully traceable; multi-line completion is a future question, not a
   default.

---

## 6. BOM / formula design (schema sketch — fields only, no code)

Two distinct BOM types, one per model. Both versioned append-only (like
`tenant_settings` / `role_permissions`), both snapshot-referenced by the documents
posted under them. All quantities integer milli base-units.

### 6a. Process FORMULA (recipe — proportions + tolerances) — Model A

Attached to a process route stage (or the route as a whole). Expresses *ratios
against a basis*, not per-unit counts.

**`process_formulas`** (versioned):
- `id`, `tenantId`, `code`, `nameKey`
- `version` (append-only; new version = new row), `status` (draft | active | retired)
- `stageId` (or `routeId` + stage code) — where the formula applies
- `basisQty` — reference quantity the proportions are stated against
  (e.g. per 1 000 000 milli-kg = 1 t of primary input)
- `basisUomId`
- `notes`, `createdBy`, `createdAt`

**`process_formula_lines`**:
- `id`, `formulaId`, `lineNo`
- `lineKind` — `primary_input` | `additive` | `packaging_material`
- `consumptionMode` — `stock` (reserves/consumes a lot via the ledger) |
  `attribute_only` (recorded fact, no inventory touch — the iodine pattern)
- `itemId` (required when `consumptionMode = stock`)
- `attributeKey` (required when `attribute_only`; must match a stage attribute)
- `qtyPerBasis` — milli base-units per `basisQty`
- `uomId`
- `toleranceMinusPermille`, `tolerancePlusPermille` — acceptable deviation band;
  out-of-band capture at batch completion → warning or supervisor approval
  (enforcement level is template config)
- `scrapAllowancePermille` (optional, informational until costing)

The formula does NOT replace stage physics: `outputPolicy` still governs mass;
the formula governs *what accompanies* the primary flow and in what proportion.
Mesob v1 maps cleanly: iodization formula = one `additive` line,
`attribute_only`, `iodine_added_kg`, qtyPerBasis from today's settings target,
tolerance from the same settings — i.e. today's behavior is the degenerate case.

### 6b. Discrete BOM (component list) — Model B

Attached to a parent item. Expresses *counts per unit produced*.

**`boms`** (versioned):
- `id`, `tenantId`, `parentItemId`, `version`, `status`
- `outputQtyPerRun` (normally 1 unit), `routeId` (optional operations link)
- `notes`, `createdBy`, `createdAt`

**`bom_lines`**:
- `id`, `bomId`, `lineNo`
- `componentItemId`, `qtyPerUnit` (milli), `uomId`
- `issueMode` — `explicit` | `backflush`
- `position` / `referenceDesignator` (optional)
- `scrapAllowancePermille` (optional)
- `substituteGroup` (optional, future)

**`work_orders`** (Model B execution document — sketch only):
- `id`, `tenantId`, `docNumber`, `date`, `itemId`, `bomId` + `bomVersion`
  (snapshot), `qtyOrdered` (milli), `qtyCompleted`, `qtyRejected`,
  `status` (draft | released | in_progress | completed | cancelled),
  `outputWarehouseId`, `outputLotId` / serial links, QC fields identical in shape
  to `production_batches` (`qcStatus`, `qcApprovedBy/At`), people/meta/audit
  fields identical to the batch pattern.

---

## 7. QC generalization (Mesob's approve-and-release = platform default)

What exists and is proven: immutable attempt rows, `attemptNumber` +
`previousTestId` retest chain, statuses passed | failed | retest_required,
`passed_pending_release` on the batch, and a **separate explicit approve step**
(`approveQualityTest`) that alone flips the gate to `passed`. This two-step —
*result* is a fact, *release* is a decision — is the platform default for all
manufacturing, both models.

Generalization adds three configuration surfaces (design only):

1. **Test type definitions** (per template/tenant):
   `quality_test_types`: `id`, `tenantId`, `code`, `nameKey`, `method` (free text /
   SOP ref), `resultKind` (`numeric` | `text` | `pass_fail`), `unit`,
   `targetSource` (`fixed` | `settings_key` | `formula_line`), `targetValue` /
   `targetSettingsKey`, `minTolerance`, `maxTolerance`, `active`.
   Today's single implicit test becomes the salt template's "iodine level" type
   (numeric, target from the `production` settings domain). `quality_tests` gains
   a `testTypeId` concept; existing free-text `targetLevel`/`actualResult` remain
   the compatible degenerate case.
2. **Sampling** (later; do not overbuild): default remains "one result set per
   batch" (Mesob reality). The design leaves room for `sampling_plans` —
   `scope` (per_batch | per_n_units | per_lot | time_interval), `sampleSize`,
   `requiredTests[]` — activated per template when a real deployment needs it.
   No sampling engine before a real tenant demands one (never fabricate rules).
3. **Release gates as configuration:** a gate = *which* tests must be passed +
   *who* may release. Stage-level `requiresQc` is the v1 gate; the generalized
   gate lists required test types and keeps the release permission in the
   `quality.approve` permission — recorded-by and released-by remain distinct
   identities (Founder decision 2026-08-19). Failed/retest states block
   immediately, exactly as today.

Invariants carried forward unchanged: attempts are never mutated; a released
result is final (`qc_final` guard); downstream consumption re-checks the gate at
consume time (both `createBatch` and `completeBatch` verify — belt and braces).

---

## 8. Roles and experiences

Sector-layer role archetypes (extracted from Mesob's validated split):

| Role | Owns | Must NOT |
|---|---|---|
| **Production Operator** | Create/start/complete batches (later: work orders), record material issues, outputs, losses/rejects, stage attributes; view QC status | Record or approve QC; correct completed outputs; export |
| **Production Supervisor** | Everything Operator has + approve, audited output corrections, cancellations, exports | Approve/release QC (separate authority) |
| **Quality** | Record test attempts, approve & release, QC exports; view production | Create or complete production documents |

Mesob's permission matrix (`production: view/create/edit` for Operator, `+approve/
export` for Supervisor, `quality: create/edit/approve` only for Quality) is the
sector default; templates rename/translate, they don't re-split.

**Mobile production worker experience** (per the standing mobile-first mandate and
`MOBILE_PERFORMANCE_BASELINE.md` budgets; ~2 GB Android Go target):

- A task-list-first screen ("My work"), not a data grid: open batches at my
  stage(s), each a large tap target with status color.
- Five verbs, one screen each, minimal typing, numeric keypads:
  **Start work** (pick source lot/batch from a short filtered list, quantity),
  **Record material** (confirm reserved input / formula additive with tolerance
  hinting), **Record output** (bulk kg or packed units + rejected units),
  **Record loss** (measured stages only — shown as derived, confirmed, never
  silently invented), **See QC status** (read-only gate state: pending / awaiting
  release / released / failed — the worker sees *why* the next stage is blocked).
- Supervisor mobile adds approve/correct with reason capture; Quality mobile adds
  record-test + approve-and-release (two separate actions, never one button).
- Offline posture: production posting follows the O2 doctrine (server is final
  authority, no silent merges). Whether production capture joins receiving/
  delivery in the offline queue is a Founder question (§9 Q7) — until then,
  production writes are online-only with honest connectivity status.
- Role-scoped payloads: the operator app ships no financial data, no admin
  surface; server-side masking stays authoritative (invariant #5).

---

## 9. Open Founder / product questions

1. **Additive consumption mode for salt at scale.** Iodine is attribute-only
   today (locked decision). When Mesob starts *purchasing* KIO₃ through the
   system (procurement/costing, M2), does iodine become a `stock`-mode formula
   line, or stay attribute-only with cost handled elsewhere? Both are supported
   by §6a — the choice is business, not technical.
2. **Route shape.** Is a linear stage chain enough for the process subsector v1?
   Today one batch draws from exactly **one** source batch (split many-from-one
   works; **merge** one-from-many does not). Which real subsector (dairy?
   beverages?) forces merge/blend, and do we wait for that real tenant?
3. **Manufacturing orders.** Do process batches stay ad hoc (current, validated)
   or gain demand-linked orders/scheduling in M3+ — and if so, is the order a
   thin grouping shell over batches rather than a new execution engine?
4. **Costing method (M2 input).** FIFO from lots vs moving average vs standard
   cost — and where does loss/variance cost land (period expense vs absorbed
   into output)? This blueprint only guarantees the seams (§3).
5. **Tolerance enforcement.** When a batch's recorded additive falls outside the
   formula tolerance band: warn, require supervisor approval, or hard-block?
   Per-template setting proposed; default needs a Founder call.
6. **Serialization scope.** Which target subsectors actually need per-unit serial
   tracking (electronics assembly? equipment?) — enough to justify implementing
   the declared-but-dormant `trackingMode: 'serial'` in the Model B milestone?
7. **Offline production capture.** O2 ordered receiving first, delivery second.
   Is mobile production capture (start/complete/QC-view) the third offline
   candidate, or does production stay online-only at the factory (where LAN is
   local anyway)?
8. **Regulatory targets.** Ethiopian salt-iodization compliance values for the
   Salt template: VERIFY FIRST with real sources before any number enters the
   template; until verified, targets remain tenant-entered settings (as today).
9. **Workforce link timing.** When operator identity becomes real (M5), do
   historical free-text names stay as-recorded (immutability) with linkage only
   going forward? (Proposed: yes — posted documents never rewrite.)

---

## 10. Relationship to other Wave-1 design work

- **Template extraction** (jenify-template-engineer): §2's "NOT core" column plus
  §4's Salt layer is the extraction shopping list; the declarative template
  artifact should express exactly those, through the same service APIs `seed.ts`
  uses today.
- **Costing** (finance-costing, M2): consumes §3 seams and §9 Q4.
- **Mobile** (jenify-ux-engineer / frontend-ux): §8 mobile worker verbs are the
  production slice of the mobile mission; budgets unchanged.
- **Retail / wholesale blueprints** (design-retail, design-wholesale, same wave):
  no overlap expected in production; shared touchpoints are items/lots/pricing —
  the Team Lead arbitrates any collision on item archetypes.

*Design only. Any implementation follows the standard flow: architect challenge →
smallest safe milestone → Founder direction → execute with tests green.*
