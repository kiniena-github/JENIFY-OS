# JENIFY AI — MASTER ARCHITECTURE + PRODUCT REPORT

> **Workstream R7 — JENIFY AI MASTER RESEARCH program.** 2026-08-21.
> Produced under `jenify-ai-engineer` + `jenify-ai-qos` (design lens) with `jenify-product-research` rules.
> **RESEARCH + DESIGN ONLY.** No runtime AI code exists or is proposed for immediate build; no AI
> dependencies enter any `package.json` until the Founder opens the AI milestone
> (`docs/JENIFY_DECISIONS.md`, 2026-08-21: JENIFY AI / QOS is FUTURE PLANNED, design-only until activation).
> Grounded in the actual repo at commit `70efbd6` (verified against `packages/server/src` on 2026-08-21).

---

## 0. What JENIFY AI is

JENIFY AI is an **operating layer**, not a chatbot. Its verb set is:
**ASK · ANALYZE · EXPLAIN · RECOMMEND · PREPARE · ACT · CONFIGURE · AUTOMATE.**

Target experiences (Founder examples, each mapped to a concrete design in §2.6):

| Utterance | Verb | What actually happens |
|---|---|---|
| "Who owes us money?" | ASK | Runs the existing credit overview under the asker's permissions, cites invoice numbers |
| "Why did production fall this week?" | EXPLAIN | Comparative production report queries + ranked causes, each citing real batches |
| "Create a delivery for invoice INV-0021" | PREPARE/ACT | Resolves the invoice, creates a **draft** delivery via `POST /api/deliveries` with preview + confirm |
| "Record 500 kg received from ABC Supplier" | PREPARE | Resolves supplier/item/warehouse, creates a **draft** goods receipt; posting stays a separate gated act |
| "Call Warehouse 'Store' everywhere" | CONFIGURE | Terminology change via the translations service, shown as a before/after diff an authorized human approves |
| "Every purchase above ETB 100,000 needs Finance Manager approval" | CONFIGURE | **Not fabricated**: no procurement module or approval-policy engine exists yet (M2 / open design question) — the AI says so and files the request, per non-negotiable principle 4 |

Initial AI operating language: **English**. The UI remains multilingual (685-key translation framework already live); multilingual AI (Amharic/Tigrinya understanding and answering) is a later milestone gated on the translation-fill work (Current State T8) and eval coverage.

The single permitted architecture (CLAUDE.md principle 6, `jenify-ai-engineer` charter):

```
user language → intent → business/entity resolution → context retrieval
→ structured command → permission check → validation → risk classification
→ preview → confirmation policy → execution via normal domain APIs
→ verification → audit
```

Every AI action runs **as the requesting user**, through the same API layer and permission matrix as
the normal UI. There is no AI fast path, no AI service account, no AI database handle.

---

## 1. Pipeline design — every stage mapped onto the existing codebase

The platform was built (without knowing it) as an almost ideal substrate for a safe AI layer. Each
pipeline stage below names the exact repo mechanism it rides on, and the gap where one exists.

### 1.1 Stage-by-stage mapping

| # | Stage | What it does | Existing repo mechanism it binds to | Gap to close at build time |
|---|---|---|---|---|
| 1 | **User language** | Capture utterance + surface context (page, selected record) | Web app pages (17 routes, `packages/web/src/pages`); session cookie `fos_session` | New chat/command UI component |
| 2 | **Intent** | LLM classifies the utterance into ONE catalog action id (or `clarify` / `unsupported`) using strict structured output | — (new) | Intent router prompt + the action catalog (§2) as the closed tool space |
| 3 | **Business/entity resolution** | Map "INV-0021", "ABC Supplier", "the washing stage" to real row ids | `listParties(ctx, {search})`, `listItems`, `listWarehouses`, `listInvoices`, `listDeliveries`, `listBatches`, `listStages` — all tenant-scoped, permission-gated services | Thin resolver functions per entity type: exact code/doc-number match → normalized fuzzy match → clarifying question with candidates. Never guess on multiple matches |
| 4 | **Context retrieval** | Tenant config, terminology, enabled modules, live data (§3) | `/api/ui-config`, `getSettings(ctx, domain)` (versioned), `listTranslationRows`, report/list endpoints | Context assembler that only calls permission-checked reads under the user's `Ctx` |
| 5 | **Structured command** | Typed `ActionInvocation { actionId, inputs, resolvedRefs, idempotencyKey }` | Quantities already integer milli-units, money integer cents (`@factoryos/shared` scaling helpers) — the AI emits scaled integers, never floats | Catalog input schemas (JSON Schema, `additionalProperties: false`) |
| 6 | **Permission check** | Pre-flight: does `ctx.user.permissions` hold the catalog entry's required `(module, action)` pairs? | `hasPermission(matrix, module, action)` in `@factoryos/shared` (fail-closed: literal `true` required); the authoritative check remains `requirePermission` at the route (§1.2) | Catalog carries the required permissions declaratively (closes roadmap risk #3) |
| 7 | **Validation** | Shape + business validation before anything is shown | Services already validate richly — e.g. `sales.ts`: `not_customer`, `no_lines`, `not_sellable`, `line_qty`, `discount_invalid`, `approval_required`, `due_date_required`, `insufficient_available` | Catalog schema validation runs first; service `AppError`s (`badRequest`/`notFound`/`forbidden` in `util.ts`) surface verbatim as the AI's explanation — never re-invented |
| 8 | **Risk classification** | Assign the invocation its class: READ / CREATE / UPDATE / OPERATE / CONFIGURE / SENSITIVE | The permission vocabulary already encodes risk: `view` < `create`(draft) < `edit` < `approve`/`load`/`dispatch` < `settings.edit` < `delete`/reversals/`manage_users`/`credit.approve` | Static per-catalog-entry class (§2.2) — computed at design time, not by the LLM |
| 9 | **Preview** | Show exactly what will happen before it happens | Draft→posted lifecycle **is** the preview mechanism (§1.3); settings/permissions are versioned with `before`/`after` recorded in audit | Diff renderer for CONFIGURE; effect summary ("will reserve 500 kg in Store 1") for OPERATE |
| 10 | **Confirmation policy** | None (READ) → confirm (CREATE/UPDATE) → explicit confirm (OPERATE/CONFIGURE) → typed confirm + reason (SENSITIVE) | Reversal/cancel services already **require** a `reason` argument (`cancelInvoice`, `reversePayment`, `reverseReceipt`, …) | Two-step propose→execute endpoints with a short-lived server-side proposal id (§4.5). Never an in-prompt "are you sure?" |
| 11 | **Execution via normal domain APIs** | Run the action through the real route with the user's real session | Fastify routes; in-process `app.inject()` (already the e2e test mechanism, `buildApp()` + cookie sessions in `test/e2e.test.ts`) or plain localhost HTTP | **Must go through routes, not services** — see the critical finding in §1.2 |
| 12 | **Verification** | Read back the created/changed record via a permission-checked GET; compare against the preview | `getReceipt`, `getInvoice`, `getBatch`, `listMovements({documentId})` etc. | Effect-assertion helper (status expected vs actual; doc number reported to the user) |
| 13 | **Audit** | Record who asked, what was interpreted, what ran, what resulted | `writeAudit(ctx, event)` — append-only, no update/delete path; `AuditEventInput.result` already supports `'success' | 'blocked' | 'error'` (blocked = perfect for permission refusals) | New `assistant` module id in `MODULES` + an `ai_interactions` telemetry table (§4.6) |

### 1.2 Critical repo finding: permission checks live in ROUTES, so execution must go through routes

Fresh count (2026-08-21): **98 `requirePermission`/`requireAnyPermission` call sites across the 6
guarded route files** (`admin` 22, `commercial` 25, `inventory` 16, `masterdata` 15, `production` 14,
`insights` 6; the roadmap's "~102" figure includes the two definitions and drift). Crucially, several
security-relevant rules exist **only** at the route layer, not in the service:

- `routes/commercial.ts:88/100` — a credit-limit override on invoice confirm requires `credit.approve` **in the route**; `confirmInvoice` itself only receives the boolean.
- `routes/commercial.ts:82-84` — custom price / discount requires `sales.approve` in the route, which then sets `input.customApproved`.
- `routes/masterdata.ts:163-181` — party identity edits vs credit-limit edits are split into different permissions **inside the route handler**.
- `routes/inventory.ts:46-49`, `routes/commercial.ts:213` — the `andPost`/`post` escalation (`create` → also needs `approve`) is a route-level check.

**Design consequence (binding):** until the declarative catalog refactor lands, the ONLY safe
execution path for AI actions is the real HTTP route with the user's real session (in-process
`app.inject` preferred on the local box — no network, same code path). Calling services directly
under a hand-built `Ctx` would silently bypass route-level guards. This is a hard invariant of the
AI layer, and it is also why the action catalog (§2) must eventually become the single declarative
source that routes *and* the AI both consume.

### 1.3 The draft/posted lifecycle is a free, already-audited preview mechanism

The platform's universal document lifecycle (`draft → posted → reversed/cancelled`,
`DOC_LIFECYCLE` in shared) and the matching permission split (`create` makes drafts; `approve`
posts them) give the AI a natural two-phase commit that requires **zero new domain code**:

- AI CREATE = create a real **draft** (discardable, visible in the normal UI, editable by humans).
- AI never auto-posts. Posting/confirm/dispatch is a separate OPERATE action with its own
  permission and its own explicit confirmation.
- If the user abandons the flow, the draft sits harmlessly where a human-created draft would sit.

This alignment means AI confirmations reuse the exact trust boundaries the Founder already
approved for humans, instead of inventing parallel AI-only ones.

---

## 2. Typed action catalog

### 2.1 Why a catalog (the repo's known gap)

`JENIFY_ROADMAP.md` risk #3: *"AI needs a declarative seam — permissions are ~102 hand-written
route calls with no machine-readable action catalog; lift `(module, action)` into route metadata
when the AI milestone opens."* The catalog is that seam. It is a **closed, enumerated, typed,
code-reviewed** list; the LLM can only select from it. Free-form actions do not exist.

### 2.2 Action classes and confirmation policy

| Class | Meaning | Confirmation policy | Reversibility | Examples |
|---|---|---|---|---|
| **READ** | Query/report/explain; zero writes (except the platform's own `report_run`-style audit) | None — answer immediately, with citations | n/a | today's sales, who owes money, stock levels, why production fell |
| **CREATE** | New **draft** document or master-data record | Preview card + one confirm click | Draft: discard/cancel freely | draft receipt, draft invoice, draft delivery, new customer |
| **UPDATE** | Edit a **draft** or non-financial master data field | Preview diff + one confirm click | Re-editable | fix draft qty, update customer phone |
| **OPERATE** | State transitions that post to the ledger or move a workflow | Explicit confirm showing computed effects (stock reserved, credit consumed) | Only via audited reversal | post receipt, confirm invoice, dispatch delivery, complete batch, release QC |
| **CONFIGURE** | Tenant configuration: terminology, settings, sequences, stages, pricing | Before/after **diff preview**; approval by a human holding `settings.edit`; versioned save (rollback = save prior version as a new version) | Versioned — old versions permanent | rename Warehouse→Store, VAT rate, price category |
| **SENSITIVE** | Financial postings/allocations/reversals, cancellations of posted docs, credit overrides, permission/user changes, deletions | Typed confirmation (re-type the doc number / role name) + **mandatory reason** + fresh permission check at execute time; never batched, never automated | Reversal-of-reversal only; some irreversible (permanent language delete) | reverse payment, cancel posted invoice, credit-limit override, save role matrix |

Two structural rules:
1. **The class is static metadata**, assigned at design time per catalog entry — the LLM never
   chooses how risky its own action is.
2. **SENSITIVE actions are opt-in per deployment**: the initial catalog ships them disabled
   (`enabled: false`), so "AI can reverse a payment" requires an explicit Founder/tenant decision,
   not just a permission.

### 2.3 Per-action schema (the machine-readable record)

```ts
interface CatalogAction {
  id: string;                      // 'create_delivery', stable forever
  title: string;                   // translation KEY, so tenant terminology applies
  class: 'READ'|'CREATE'|'UPDATE'|'OPERATE'|'CONFIGURE'|'SENSITIVE';
  module: ModuleId;                // existing 13-module vocabulary from @factoryos/shared
  requiredPermissions: Array<{ module: ModuleId; action: ActionId | string }>;
                                   // ALL must hold; mirrors the route's guards exactly
  anyOfPermissions?: Array<{ module: ModuleId; action: string }>;
                                   // for requireAnyPermission routes (delivery load/dispatch)
  inputSchema: JsonSchema;         // strict: additionalProperties:false, required[], integer
                                   // milli-units and cents, enum-constrained where possible
  entityRefs: Array<{ field: string; kind: 'party'|'item'|'warehouse'|'invoice'|'delivery'
                     |'batch'|'stage'|'user'|'language'|'payment'|'receipt' }>;
                                   // which inputs pass through resolvers (§1.1 stage 3)
  binding: { method: 'GET'|'POST'|'PATCH'|'PUT'|'DELETE'; path: string };
                                   // the REAL route; execution is app.inject with user session
  confirmation: 'none'|'confirm'|'explicit'|'typed_with_reason';
  audit: { action: string };       // assistant-module audit action written alongside the
                                   // domain's own writeAudit (double-entry: intent + effect)
  reversibility: 'read'|'draft_discardable'|'versioned'|'reversal_only'|'irreversible';
  errorHandling: 'clarify'|'abort_explain'|'suggest_alternative';
                                   // what the assistant does when the service rejects
  enabled: boolean;                // SENSITIVE entries default false
  sideEffectSummary: string;       // translation key template for the preview card
}
```

### 2.4 Recommended format and location

- **Format: a TypeScript const array with `satisfies CatalogAction[]`** — not YAML/JSON files.
  Rationale: it compiles against the real `ModuleId`/`ActionId` types (typos in permissions become
  build errors), it can be snapshot-tested against the routes, and JSON Schema for the LLM tool
  definitions is *generated* from it. This follows the repo's "core vs config" pattern: the
  catalog is core vocabulary, like `MODULES` itself.
- **Location:**
  - Action metadata (everything except `binding`): `packages/shared/src/actions.ts` — shared may
    hold it because it contains zero tenant literals, and web needs it to render previews,
    permission-aware command palettes, and confirmation UIs.
  - Route bindings + executor: `packages/server/src/ai/catalog-bindings.ts` (server-only).
  - Per-tenant enablement/overrides (e.g. Mesob disables SENSITIVE, relabels titles): a versioned
    `tenant_settings` domain `assistant` — using the existing `saveSettings` versioning, so every
    change to what the AI may do is itself audited and rollback-able.
- **Contract test (build-time guarantee):** a vitest suite walks the catalog and asserts, per
  entry, that invoking `binding.path` **without** each required permission yields 403 and **with**
  them yields non-403 — the catalog can then never drift from the 98 hand-written guards. This
  test is the bridge that later lets the team refactor routes to *consume* the catalog
  (declarative `requirePermission` from metadata) with zero behavior change, retiring the
  hand-written-guard gap (roadmap risk #3) for the whole platform, not just the AI.

### 2.5 Initial catalog (v1 candidate — every entry verified against a real route)

READ (bind to `routes/insights.ts`, list endpoints; all already audit `report_run` or are cheap lists):

| id | Binding | Permissions | Notes |
|---|---|---|---|
| `q_dashboard` | GET `/api/dashboard` | dashboard.view (+dashboard.view_financial for money) | financial nulled server-side otherwise |
| `q_sales` | GET `/api/reports/sales` | reports.view + reports.view_financial | period + customer filter |
| `q_credit_outstanding` | GET `/api/credit` · `/api/reports/credit` | credit.view (+view_financial) / reports.view_financial | "who owes us money" |
| `q_stock` | GET `/api/stock` | inventory.view | raw/finished, by warehouse |
| `q_movements` | GET `/api/movements` | inventory.view | item/lot/document drill-down |
| `q_production` | GET `/api/reports/production` | reports.view | per stage, period comparison for WHY |
| `q_quality` | GET `/api/reports/quality` + `/api/batches?status=` | reports.view / production.view | failed / awaiting release |
| `q_deliveries` | GET `/api/deliveries` + `/api/reports/delivery` | delivery.view / reports.view | overdue via `deliveryPerformance` |
| `q_payments` | GET `/api/payments` | payments.view + payments.view_financial | route requires both |
| `q_doc_lookup` | GET by doc number via lists | module's `view` | resolve INV-/GRN-/DEL- prefixes |
| `q_audit` | GET `/api/audit` | audit.view | "what happened yesterday", search |
| `q_parties` | GET `/api/parties` | parties.view (credit limit masked without view_financial) | |

CREATE / UPDATE (drafts and master data):

| id | Class | Binding | Permissions |
|---|---|---|---|
| `create_receipt_draft` | CREATE | POST `/api/receipts` (never `andPost`) | inventory.create |
| `create_invoice_draft` | CREATE | POST `/api/invoices` (never `andConfirm`; custom price → +sales.approve, mirrored from route) | sales.create |
| `create_delivery_draft` | CREATE | POST `/api/deliveries` | delivery.create |
| `create_customer` | CREATE | POST `/api/parties` | parties.create |
| `create_payment_draft` | CREATE | POST `/api/payments` (never `post:true`) | payments.create |
| `update_draft_receipt` | UPDATE | PATCH `/api/receipts/:id` | inventory.edit |
| `update_party_profile` | UPDATE | PATCH `/api/parties/:id` (identity fields ONLY — credit limit is SENSITIVE) | parties.edit |

OPERATE (each = the posting half the drafts deliberately excluded):

| id | Binding | Permissions |
|---|---|---|
| `post_receipt` | POST `/api/receipts/:id/post` | inventory.approve |
| `confirm_invoice` | POST `/api/invoices/:id/confirm` (no creditOverride — that variant is SENSITIVE) | sales.edit |
| `dispatch_delivery` | POST `/api/deliveries/:id/dispatch` | delivery.dispatch OR delivery.approve |
| `complete_batch` | POST `/api/batches/:id/complete` | production.edit |
| `release_qc` | POST `/api/batches/:id/qc-approve` | quality.approve |

CONFIGURE:

| id | Binding | Permissions | Preview |
|---|---|---|---|
| `rename_term` | PUT `/api/translations` (per key) | settings.edit | list of affected keys, before → after, per language |
| `save_settings_domain` | PUT `/api/settings/:domain` | settings.edit | JSON diff vs current version; saved as version N+1 |
| `define_sequence` | PUT `/api/sequences` | settings.edit | old vs new prefix/padding |

SENSITIVE (shipped **disabled**; each already forces a reason in the service layer):
`reverse_receipt`, `reverse_transfer`, `reverse_payment`, `cancel_posted_invoice`,
`confirm_invoice_with_credit_override` (+credit.approve), `post_payment`/`allocate_payment`
(payments.approve), `set_credit_limit` (parties.view_financial + parties.approve),
`save_role_matrix` (users.manage_users; owner-lockout guard already server-side),
`create_user`/`reset_password` (users.manage_users), `delete_language`/`delete_warehouse`
(settings.delete).

### 2.6 The Founder examples, resolved end-to-end

- **"Who owes us money?"** → `q_credit_outstanding` → `creditOverview(ctx)` under the asker's
  matrix. A user without `credit.view_financial` gets the same server-side masking the UI gets
  (`maskMoney` nulls the cents fields): the AI can honestly say *"you don't have financial
  visibility for this — ask Finance"* because the model itself never received the numbers (§4.2).
- **"Why did production fall this week?"** → `q_production` twice (this week vs prior week) +
  `q_quality` + `q_movements` → deterministic comparison (input tonnage, batch count, loss, QC
  blocks, raw-stock starvation) → narrative that cites batch numbers and movement documents.
  The WHY is computed from real deltas; the LLM only narrates and ranks them.
- **"Create a delivery for invoice INV-0021"** → resolver: invoice by doc number → catalog
  `create_delivery_draft` → preview (customer, items, source warehouse, expected date missing →
  clarifying question) → confirm → `POST /api/deliveries` as the user → verification read-back →
  "Draft delivery DEL-0107 created for INV-0021; dispatch needs the Dispatch permission."
- **"Record 500 kg received from ABC Supplier"** → resolvers: party (kind supplier), item
  (ambiguous if multiple raw materials → ask), warehouse (default from context or ask) → 500 kg →
  `500000` milli-kg → `create_receipt_draft` → preview → confirm → draft GRN. Posting offered only
  if the user holds `inventory.approve`, as a second explicit step.
- **"Call Warehouse 'Store' everywhere"** → `rename_term` → the terminology framework already
  supports relabeling English itself (Architecture Plan §10) → preview: every translation key whose
  English text contains "Warehouse" with before → after, per enabled language → human approves →
  `upsertTranslation` per key, each audited (`translation_edit`). Documents are unaffected
  retroactively (branding/settings snapshots).
- **"Every purchase above ETB 100,000 needs Finance Manager approval"** → honest refusal +
  proposal: purchases/PO do not exist yet (Missing Capabilities → M2) and no threshold-approval
  policy engine exists in any module. The AI records the request, and this report flags the design:
  a versioned `tenant_settings` domain `approval_policies` (list of `{docType, condition
  {field, op, valueCents}, requiredPermission or roleId}`) evaluated inside the relevant service's
  post/confirm path — a **core** feature humans configure and the AI merely proposes, to be
  designed with M2 procurement. Until then: *"not configurable yet"* is the only correct answer
  (never fabricate business rules — principle 4).

---

## 3. Context & knowledge: how the AI knows things

Everything the AI "knows" is retrieved live through authorized reads under the requesting user's
`Ctx` at answer time. Nothing is memorized, nothing is guessed, nothing is fine-tuned on tenant
data.

| Knowledge | Source of truth | Access path | Permission |
|---|---|---|---|
| Tenant identity, branding, calendar | `tenants` row + `branding`/`general` settings | `/api/ui-config` | any signed-in user |
| Enabled modules / simple-item screens | `modules` settings domain | `/api/ui-config` | any signed-in user |
| Terminology (what THIS tenant calls things) | `translations` + `translation_keys` | `listTranslationRows` | settings.view for full dump; the user-visible label set ships in the web bundle already |
| Roles & what the asker may do | `role_permissions` (versioned) | `ctx.user.permissions` in session | implicit |
| Live operational data | ledger/doc tables | the READ catalog (reports, lists) | per-module `view` (+`view_financial`) |
| History ("what happened / who did it") | `audit_events` (append-only) | `/api/audit` | audit.view — users without it get a refusal, not a workaround |
| Physics/config (stages, items, warehouses, VAT, pricing) | masterdata + versioned settings | list endpoints + `/api/settings/:domain` | inventory.view / settings.view |
| Country pack / sector template | `config-mesob` pattern (the pack mechanism per Architecture Plan §10) | future: template metadata exposed as read endpoints | future |
| Policies (credit limits, QC gates) | party rows, stage config (`requiresQc`, output policies) | existing reads | per-module view |

Design points:

1. **Terminology is bidirectional.** Tenant labels feed the NLU (so "Store" resolves to the
   warehouse module after the Mesob rename) *and* the NLG (the AI must answer using the tenant's
   words — `title` fields in the catalog are translation keys for exactly this reason).
2. **No vector database, no RAG store, in v1.** The data is structured and small (single SQLite
   file); deterministic tool-based retrieval through the catalog is more accurate, cheaper, and
   inherits permissions for free. External research (§6) shows the semantic-layer/registry approach
   beating free retrieval for ERP data. Revisit embeddings only for free-text fields (notes,
   audit summaries) if search quality demands it later.
3. **Context minimization.** Each turn sends the model: the fixed system contract, the catalog tool
   schemas, the tenant vocabulary snippet, the page context, and only the tool results the model
   requested — already masked by the server for that user. The model never receives whole-table
   dumps, other tenants' rows (impossible anyway — `tenantId` comes only from the session), or
   figures the user's matrix would mask in the UI.
4. **Unknowns are stated as unknown.** If a question needs a capability that doesn't exist
   (costing, POs, machine data — Current State §6), the contracted answer shape is: what IS known
   (cited), what is not recorded, and which planned milestone covers it.

---

## 4. Hard safety invariants — with enforcement mechanisms, not just rules

Each invariant names the *mechanism* that makes violation structurally impossible or detectable,
following the guardrail literature's rule that safety must live outside the model (§6.6).

### 4.1 Never arbitrary SQL / never outside approved APIs
- **Mechanism: capability containment.** The AI orchestrator process/module holds **no** `Db`
  handle and no import path to `drizzle`/`better-sqlite3`. Its only effectors are (a) the catalog
  executor, which accepts a catalog id + schema-validated inputs and performs `app.inject` on the
  bound route, and (b) nothing else. Text-to-SQL is rejected as an architecture (evidence §6.5).
- Strict tool schemas (`additionalProperties: false`, required fields, enums) — malformed model
  output fails validation before touching any route.
- Code review + the §2.4 contract test gate every catalog addition; `jenify-qa-security` reviews
  every mutating entry (per `jenify-ai-engineer` charter).

### 4.2 Never bypass RBAC, tenant isolation, or financial masking
- **Mechanism: the AI has no identity.** Every request runs with the asking user's session cookie;
  `requireCtx` derives `tenantId` from the session (Current State invariant #6); the route's
  `requirePermission` calls fire exactly as for the UI. There is no AI role, no elevated token,
  nothing to steal or confuse.
- Defense in depth: catalog pre-flight check (good UX: "you can't do that") + authoritative route
  check (fail-closed `hasPermission`) + services' own guards.
- **Masking happens before the model sees data**: `maskMoney`/`stripFinancial` run server-side in
  the route the tool call hits, so a user without `view_financial` cannot phrase their way to
  numbers — the LLM literally never received them. This converts an LLM-safety problem into the
  already-tested server-side masking invariant (Current State invariant #5).

### 4.3 Never fabricate transactions, values, or business facts
- **Mechanism: citation-required answer contract + figure verifier.** Every material figure or
  record in an answer must carry a citation (doc number / entity id) originating from a tool
  result in the same turn. A deterministic post-processor extracts numerals/doc-numbers from the
  draft answer and checks membership in (or arithmetic derivability from) the turn's tool outputs;
  failures are regenerated or downgraded to "insufficient data". This is a cheap non-LLM gate.
- The eval suite (§7.5) includes adversarial "bait" prompts (asking about nonexistent invoices,
  inviting invented totals) with refusal as the required behavior.

### 4.4 Never modify posted history
- **Mechanism: the capability does not exist.** No route can hard-edit or hard-delete posted
  documents, movements, audit rows, or QC tests (Current State invariants #1, #4, #7, #9). The
  catalog can only bind to routes that exist. Reversals/corrections are distinct SENSITIVE
  actions, disabled by default, reason-mandatory in the service signature itself.

### 4.5 Never destructive/sensitive action without explicit human approval
- **Mechanism: structural two-step confirmation (server-side state), never in-prompt.**
  `POST /api/assistant/propose` runs the pipeline through preview and stores a proposal row
  `{id, userId, actionId, validatedInputs, previewHash, expiresAt ≈ 5 min}`;
  `POST /api/assistant/execute {proposalId}` verifies same-user + unexpired + hash match,
  **re-runs the permission checks**, then executes. The execute endpoint refuses raw action JSON
  for any confirm-required class, so neither a manipulated model nor a manipulated client can skip
  the preview. Matches the staging + short-lived-token pattern from current guardrail practice (§6.6).
- Idempotency: the proposal id doubles as the idempotency key; a proposal executes at most once
  (every write safe against double-fire — §6.6 best practice).
- SENSITIVE adds typed confirmation (re-type the document number) + mandatory reason, and is
  disabled per §2.2 until explicitly enabled per tenant.

### 4.6 Everything audited
- **Mechanism: double-entry audit.** The domain service writes its normal audit event (unchanged);
  the assistant layer writes a linked `assistant`-module event: user, surface, raw utterance,
  interpreted intent, catalog id + inputs, and `result: success | blocked | error` — `blocked` is the
  existing enum value for permission refusals, so refused AI attempts become visible in the
  existing Audit page with zero schema strain. Additive change required: append `'assistant'` to
  `MODULES` in shared (additive, migration-free — the column is text).
- A separate `ai_interactions` table (design) captures telemetry the audit log shouldn't carry:
  model used, latency, token cost, outcome class — feeding the QOS cost/accuracy tracking mandate.

### 4.7 Never runtime code or instructions from tenant data (prompt injection)
- **Mechanism: instruction/data separation + blast-radius capping.** The system contract is fixed
  at build time; tenant-authored strings (party names, notes, translation values, audit summaries)
  enter only inside tool-result data blocks explicitly framed as untrusted data. But the real
  defense is architectural, per the design-patterns literature (§6.6): even a *successful*
  injection can only select catalog actions, as the same user, behind the same permission checks
  and the same human confirmation gates — i.e. it can do nothing the user couldn't do by clicking,
  and nothing mutating without the human seeing a preview. No `eval`, no plugin loading, no
  model-authored code paths, ever.
- The AI also refuses meta-instructions from content ("ignore your rules" inside a customer note
  is treated as text about a customer), and the eval suite carries injection fixtures.

### 4.8 Additional operational guards
- **Per-user and per-tenant rate + spend budgets** on assistant endpoints (also mitigates D10's
  missing rate limiting for this new surface from day one).
- **Kill switch**: tenant setting `assistant.enabled` and per-role gating via a new
  `assistant` permission module (`view` = may use the AI at all; `act` = may execute non-READ
  proposals; granted per role in the existing matrix editor — the Owner decides who gets AI).
- **Data egress is a Founder decision**: calling a hosted LLM sends tenant data off the box, which
  intersects principle 7 (no paid external services without approval). Milestone entry therefore
  requires an explicit Founder decision on provider, data handling, and budget, recorded in
  `JENIFY_DECISIONS.md`. Mitigations: context minimization (§3.3), per-user masking before egress,
  and no training-on-data API terms.

---

## 5. Surfaces

| # | Surface | What it is | Depends on |
|---|---|---|---|
| S1 | **Global chat panel** | Dockable panel in the app shell (`Layout.tsx`); full pipeline; the reference surface | Catalog READ + orchestrator |
| S2 | **Owner executive briefing** | "Understand the factory in 30 seconds" + "three things needing your attention": narrated dashboard + alerts + deltas, on-demand at first | S1 plumbing; dashboard/alerts already computed in `dashboard.ts` |
| S3 | **"Ask JENIFY" per page** | Same chat, pre-scoped with page context (route + filters), e.g. ReportsPage asks about the visible report | S1 (near-free) |
| S4 | **Command bar** | Ctrl-K single-line: NL or fuzzy action names → catalog actions with previews; power-user speed | Catalog CREATE/OPERATE + propose/execute |
| S5 | **Contextual record assistant** | On a record (invoice, batch): suggested next actions + record-scoped questions ("create the delivery for this one") | S3 + S4 |
| S6 | **Proactive alerts / daily briefing push** | Scheduled evaluation → notifications: low stock, overdue credit, anomaly explanations | Notifications outbox (Architecture Plan §6, platform M4) |
| S7 | **Voice** | Speech in/out, Amharic/Tigrinya | Multilingual AI milestone + ASR maturity for Ethiopic languages — explicitly later |

**Recommended build order: S1 → S2 → S3 → S4 → S5 → S6 → S7.**
Rationale: S1 exercises the whole safe pipeline on read-only value; S2 is the highest-Founder-value
presentation over data that *already exists* (the QOS mandate names it, and the roadmap watchlist
calls an owner digest "the cheap counter" to competitor demos); S3 is nearly free once S1 ships;
S4/S5 arrive with the first mutating milestone; S6 waits for the outbox so alerts are persistent,
not recomputed-on-read; S7 is deliberately last.

---

## 6. External research — what competitors do, what works, what fails

Method: web research 2026-08-21 (`jenify-product-research` rules: sources cited, verified facts vs
inference labeled, no proprietary code examined). Confidence: **H**igh / **M**edium / **L**ow.

### 6.1 Microsoft Copilot in Business Central / Dynamics 365 — the closest benchmark [H]
- Direction: from chat assist to **task-scoped agents** (Sales Order Agent, Payables Agent) that
  execute defined workflows with human review points; 2026 wave 1 adds a low-code agent
  designer. ([Microsoft Learn — agents overview](https://learn.microsoft.com/en-us/dynamics365/copilot/ai-get-started); [2026 release wave 1](https://www.microsoft.com/en-us/dynamics-365/blog/business-leader/2026/03/18/2026-release-wave-1-plans-for-microsoft-dynamics-365-microsoft-power-platform-and-copilot-studio-offerings/))
- What works: agents on **defined workflows** (not open-ended chat); ~70+ accuracy test cases per
  agent; phased rollout keeping manual review on until measured accuracy earns trust; thumbs
  up/down feedback capture. ([SOA FAQ](https://learn.microsoft.com/en-us/dynamics365/business-central/faqs-sales-order-taker-agent); [agent design best practices](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/ai/ai-development-toolkit-best-practices))
- What fails: entity **matching errors** (wrong customer/item) are the dominant failure and the
  main trust-destroyer; accuracy is hostage to master-data quality; full automation too early
  causes rework and relationship damage. ([erpsoftwareblog, Aug 2026](https://erpsoftwareblog.com/2026/08/deploying-ai-agents-for-dynamics-365-business-central-what-you-must-know-first/))
- **JENIFY takeaways:** resolution ambiguity must clarify, never guess (already §1.1 stage 3);
  ship review-always first and *measure* before relaxing; per-intent accuracy test suites are
  non-negotiable.

### 6.2 SAP Joule [M-H]
- 40+ agents / ~2,400 skills across finance, supply chain, procurement, HR; grounded via SAP
  Business Data Cloud + RAG; one consistent assistant across all SAP apps; Joule Studio agent
  builder GA Q1 2026. ([SAP AI agents](https://www.sap.com/products/artificial-intelligence/ai-agents.html); [SAP Architecture Center](https://architecture.learning.sap.com/docs/ref-arch/ae6821); [SAVIC 2026](https://www.savictech.com/insights/sap-joule-agentic-platform-40-agents-2026/))
- What works: **grounding in governed enterprise data** as the accuracy lever; single assistant
  identity across the whole suite (no per-module chatbots).
- What fails for JENIFY's market (inference): enterprise-scale complexity, consultant dependency,
  cloud-only, cost — exactly the weaknesses JENIFY wins by not repeating. Peer-to-peer external
  agent orchestration still immature even at SAP (inbound calls planned Q4 2026).
- **JENIFY takeaways:** one assistant, everywhere in the product, speaking governed data — but
  achieved with a catalog of dozens of actions, not thousands of skills; smallest version that
  captures the value.

### 6.3 Odoo [M]
- Native AI is point-features (lead scoring, forecasting, smart data entry); conversational AI is
  largely **third-party ChatGPT modules and an MCP server**, with no unified permission-aware
  action layer. ([Zehntech 2026 guide](https://www.zehntech.com/odoo-ai-integration-2026-complete-guide/); [Odoo apps store listings](https://apps.odoo.com/apps/modules/18.0/is_chatgpt_integration))
- What fails: bolted-on chat that bypasses the ERP's own workflow/permission semantics; fragmented
  per-module AI with no shared safety model (inference from module descriptions).
- **JENIFY takeaway:** the integrated, permission-native operating layer is a genuine
  differentiator — no mid-market competitor has it as of this research.

### 6.4 Zoho Zia [M]
- Ask Zia turns NL into reports/charts; Agent Studio exposes 700+ actions; agent marketplace.
  Documented limits: customization ceilings, generated workflows need human review for small
  errors, answers need verification. ([Zoho — Ask Zia](https://www.zoho.com/crm/ask-zia.html); [Zenatta review](https://zenatta.com/zoho-crm-ask-zia-feature/); [reply.io review 2026](https://reply.io/blog/zoho-ai-review/))
- **JENIFY takeaways:** NL→report/chart is the proven high-value, low-risk entry point (validates
  READ-first); "AI drafts, human reviews" is what users actually accept in SMB software.

### 6.5 ERPNext / Frappe [H]
- Core ships no native AI; the ecosystem's answer is **Frappe Assistant Core** — an open-source MCP
  bridge exposing ~24 tools (document CRUD, search, reports, workflows) to any LLM.
  ([GitHub — Frappe_Assistant_Core](https://github.com/buildswithpaul/Frappe_Assistant_Core); [mith.tech 2026](https://mith.tech/blog/does-erpnext-have-ai-features))
- Closest architectural analog to JENIFY's plan (tools over ERP APIs), and a caution: exposing
  *generic document CRUD* as tools has no risk classes, no confirmation tiers, no draft-only
  discipline — a safety and trust gap JENIFY's typed catalog is specifically designed to beat.
- Text-to-SQL as the alternative is now broadly rejected for enterprise use: syntactically valid
  but semantically harmful queries, tenant-isolation and access-control bypass, unbounded scans;
  registry/semantic-layer + governed API calls is the converging consensus. ([K2View](https://www.k2view.com/blog/llm-text-to-sql/); [Kniesel Labs — ERP text-to-SQL](https://kniesel-labs.de/en/blog/erp-ai-text-to-sql-semantic-layer/); [REGAL, arXiv:2603.03018](https://arxiv.org/pdf/2603.03018); [Atlan 2026](https://atlan.com/know/ai-agent/data-for-ai/text-to-sql-for-enterprise/))

### 6.6 LLM tool-calling architecture best practices (cross-vendor consensus) [H]
- **Strict structured outputs / typed function calling** with `additionalProperties: false` and
  validated inputs; schema-invalid calls rejected pre-execution (Anthropic strict tool use; skill
  reference cached 2026-06).
- **Guardrails as gates outside the model**: pre-LLM (input), post-LLM (output/action validation),
  never trusting in-prompt compliance. ([Arthur](https://www.arthur.ai/blog/best-practices-for-building-agents-guardrails); [Wiz](https://www.wiz.io/academy/ai-security/llm-guardrails); [Datadog](https://www.datadoghq.com/blog/llm-guardrails-best-practices/))
- **Structural two-step confirmation** for irreversible actions: staging + short-lived
  confirmation token, separated endpoints — adopted in §4.5. ([AWS/dev.to guardrails pattern](https://dev.to/aws/ai-agent-guardrails-rules-that-llms-cannot-bypass-596d))
- **Idempotent writes with idempotency keys**; least-privilege per-role tool exposure; read-only
  tools inherently safer → read-first rollouts. (same sources)
- **Prompt-injection defense by design**, not by filtering alone: constrain the action space so a
  compromised model turn cannot exceed the user's own authority. ([Design Patterns for Securing LLM Agents, arXiv:2506.08837](https://arxiv.org/pdf/2506.08837))
- **Eval-first shipping**: golden intent→action test sets, refusal tests, and measured accuracy
  before automation expands (Microsoft's 70+ cases/agent, §6.1).

**Net competitive read:** everyone validates the direction; nobody in JENIFY's segment combines
(a) permission-native execution as the user, (b) typed risk-classed actions with draft-first
writes, and (c) African-SME constraints (cost routing, English-first with tenant terminology,
local-first data). That combination is the moat.

---

## 7. Milestone plan

Naming: **AI-M1 … AI-M4**, distinct from platform milestones M1–M5. Standing exit criteria for
every AI milestone: full server suite green (163+), the AI eval suite green, no Current State §3
invariant violated, feature matrix + decision log updated.

### Entry gate for AI-M1 (Founder decisions + platform prerequisites)
1. Founder opens the AI milestone and approves: LLM provider, spend budget, and the data-egress
   position (§4.8) — recorded in `JENIFY_DECISIONS.md`.
2. Platform Milestone 1 hardening lands first — specifically D4 (multi-tenant auth scoping) and
   D5/WP4 (choke-point input validation), since the assistant adds a new programmatic caller of
   every route. The catalog's strict schemas then *reduce* net risk by becoming an extra
   validation layer (and a path to retiring T6).

### AI-M1 — Read-only intelligence ("the analyst") — exact scope in the final section
Global chat (S1) + on-demand Owner briefing (S2), English, READ catalog only, citations mandatory,
permission refusals exercised, everything audited. Zero mutating intents. Deliverables include the
catalog + resolvers + contract tests + eval suite + `assistant` permission module.

### AI-M2 — Low-risk draft actions ("the clerk")
CREATE/UPDATE catalog entries (drafts + master data), propose→execute confirmation flow (§4.5),
command bar (S4), idempotency, per-intent `jenify-qa-security` review of permission + confirmation
paths (charter requirement). Success metric: % of AI drafts posted unchanged by humans (adopting
Microsoft's "measure edits before automating more", §6.1).

### AI-M3 — Operate + configure ("the operator")
OPERATE entries (posting/confirm/dispatch/QC release) with explicit-confirm previews of computed
effects; CONFIGURE entries with diff previews (terminology, settings); record assistant (S5);
SENSITIVE entries designed but still disabled by default. Approval-policy engine design lands with
platform M2 procurement (see §2.6 last row).

### AI-M4 — Proactive brain ("the advisor")
Owner Daily Briefing on schedule; low-stock prediction (needs reorder points — platform M4 —
or explicit thresholds in settings until then); overdue-credit warnings; anomaly explanations with
WHY (comparative ledger/report deltas, cited). Depends on the notifications outbox (Architecture
Plan §6). Batch/scheduled generation runs off-peak at batch pricing.

### 7.5 Eval & quality harness (starts in AI-M1, grows every milestone)
- Golden set per intent: utterance → expected catalog id + inputs (deterministic asserts, vitest,
  same in-memory-tenant helpers the server tests use).
- Permission-refusal matrix: every intent × every seeded Mesob role (8 roles) asserting 403/refusal
  where the matrix says so — mirrors the existing e2e role tests.
- No-fabrication set: nonexistent documents, bait questions, injection fixtures in tenant data.
- Audit-emission asserts: every executed eval case leaves the expected assistant + domain events.
- Live telemetry: `ai_interactions` records model, latency, cost, outcome — the QOS
  latency/accuracy/cost/failure tracking mandate.

### 7.6 Cost & model routing (QOS cost-control mandate, design-only)
- **Tiered routing:** (T1) intent classification + entity resolution prompts → small fast model
  (e.g. Haiku-class, ~$1/M input tokens at research date); (T2) answer narration over tool results
  and WHY analyses → mid-tier (Sonnet-class, ~$3/M); (T3) rare multi-step investigations and the
  daily briefing composition → large model (Opus-class, ~$5/M), never by default. Prices from the
  provider reference cached 2026-06; re-verify at milestone start.
- **Prompt caching:** the system contract + catalog tool schemas are a stable prefix — cache them
  (≈90% input-cost reduction on the fixed portion); volatile context goes after the cache
  breakpoint. Catalog stability is therefore also a cost feature.
- **Batch pricing** (~50%) for scheduled briefing/alert generation.
- **Budget enforcement:** per-tenant monthly token budget in the `assistant` settings domain;
  hard-stop with a clear message; costs surfaced to the Owner (trust through transparency).
- **Connectivity reality (African relevance):** hosted LLMs need internet; the platform is
  local-first. Design: the AI degrades gracefully (assistant offline ⇒ core system untouched);
  briefing falls back to the non-LLM dashboard/alerts rendering (all S2 facts are computed
  server-side anyway — the LLM only narrates). Local small-model fallback is a watch item, not a
  commitment.

---

## 8. Open questions for the Founder / Team Lead

1. LLM provider + budget + data-egress approval (blocking, §4.8 / AI-M1 entry gate).
2. Should `assistant` become the 14th module in `MODULES` (recommended, additive) in a pre-AI
   platform change, so role matrices can be prepared early?
3. Approval-policy engine (threshold approvals): design together with platform M2 procurement?
4. Mesob pilot users for AI-M1 feedback: Owner + which two roles?
5. When to schedule the route→catalog declarative refactor (after the §2.4 contract test proves
   parity) — AI-M2 or a platform hardening pass?

---

## TEAM LEAD SUMMARY (15 lines)

1. JENIFY AI is designed as a permission-native operating layer: NL → typed catalog action → the user's own session → existing routes → audit. No AI code exists yet; this is design only.
2. Critical repo finding: real permission rules live in the 98 route-level guard calls (credit override, custom-price approval, party identity/credit split) — so AI execution MUST go through the routes (in-process inject with the user's session), never direct service calls.
3. The draft→posted lifecycle plus the create/approve permission split gives us AI previews and confirmations for free: AI writes drafts; posting is always a separate, explicitly confirmed, separately permissioned act.
4. The typed action catalog (READ/CREATE/UPDATE/OPERATE/CONFIGURE/SENSITIVE) is a compile-checked TypeScript const in `packages/shared`, with server-side route bindings, strict JSON Schemas, per-entry confirmation/audit/reversibility policy — and a contract test that locks it to the routes' actual guards.
5. That same catalog closes the roadmap's declared gap (risk #3: "~102 hand-written permission calls, no machine-readable catalog") and can later drive the routes themselves.
6. Safety is mechanical, not aspirational: no DB handle in the AI layer, no AI identity, server-side masking before the model sees data, server-side two-step propose→execute with expiring proposal ids, figure-citation verification, SENSITIVE actions shipped disabled, kill switch + per-role assistant permissions.
7. Context is always live authorized queries (settings, terminology, reports, audit) under the asker's matrix — no vector store, no guessing; unknowns are reported as unknowns (the ETB 100,000 approval-policy example is honestly "not configurable yet" and filed as an M2 design item).
8. Surfaces build order: global chat → Owner briefing → Ask-JENIFY-per-page → command bar → record assistant → proactive alerts (needs M4 outbox) → voice last.
9. Research: Microsoft BC agents prove task-scoped agents + phased trust + per-agent eval suites; SAP Joule proves grounding + one-assistant-everywhere; Odoo/Zoho show bolted-on or point AI; ERPNext's MCP bridge validates tools-over-APIs but lacks risk classes — our typed, draft-first catalog is the differentiator; text-to-SQL is rejected industry-wide.
10. Cost: tiered model routing (small for intent parsing, mid for narration, large rarely), prompt-caching the stable catalog prefix, batch pricing for scheduled briefings, per-tenant budgets, graceful offline degradation.
11. Milestones: AI-M1 read-only analyst → AI-M2 draft clerk → AI-M3 operator/configurator → AI-M4 proactive advisor, each gated on evals (intent accuracy, permission refusal, no-fabrication, audit emission).
12. Entry gate before any build: Founder decision on LLM provider/spend/data egress, plus platform M1 hardening (D4 auth scoping, D5 validation) landing first.
13. Recommended additive platform prep: add an `assistant` module to `MODULES` so Owners can gate AI per role in the existing matrix editor.
14. Nothing in this design touches the Mesob pilot, adds dependencies, or violates any Current State §3 invariant.
15. Exact AI-M1 scope follows below — it is deliberately small, high-value, and entirely read-only.

---

## RECOMMENDED SCOPE — AI MILESTONE 1 (read-only)

**Surfaces:** S1 global chat panel + S2 on-demand Owner briefing ("Brief me"). English only.

**Intents (16, all READ, all bound to existing endpoints):**
`q_dashboard`, `q_sales` (today/period), `q_credit_outstanding` ("who owes us money"),
`q_overdue_invoices`, `q_customer_balance`, `q_stock` (raw/finished, by warehouse),
`q_movements` (item/lot/document history), `q_production` (today/period, per stage),
`q_production_compare` ("why did production fall" — computed deltas, narrated causes),
`q_quality` (failed/awaiting release), `q_deliveries` (open/overdue via performance),
`q_payments`, `q_doc_lookup` (INV-/GRN-/DEL-/batch numbers), `q_parties`,
`q_audit` ("what happened yesterday", audit.view holders only),
`q_owner_briefing` (dashboard + alerts + top-3 attention items, cited).

**Contract:** every answer cites real record identifiers; financials masked server-side per
`view_financial`; out-of-permission → clean refusal (audited as `result: 'blocked'`); unknown /
unsupported → stated as such with the covering milestone named. Ambiguous entities → clarifying
question with candidates, never a guess.

**Infrastructure delivered:** action catalog v1 (READ entries + full schema incl. disabled classes),
entity resolvers, context assembler, `assistant` module permission (`view`), catalog↔route contract
test, eval suite (golden intents × 8 Mesob roles × refusal × no-fabrication × audit emission),
`ai_interactions` telemetry table, per-tenant budget + kill switch, tiered model routing with
prompt caching.

**Explicitly OUT of AI-M1:** any mutating action (no CREATE/UPDATE/OPERATE/CONFIGURE/SENSITIVE
execution), proactive/scheduled runs, command bar, voice, non-English AI, embeddings/RAG stores,
any route refactor. AI-M1 writes nothing to any business table — its only writes are its own
telemetry and audit events.
