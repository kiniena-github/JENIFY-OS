# FACTORY OS — Architecture Plan

> Forward-looking decisions. Current facts live in [FACTORY_OS_CURRENT_STATE.md](FACTORY_OS_CURRENT_STATE.md); per-feature status in [FACTORY_OS_FEATURE_MATRIX.md](FACTORY_OS_FEATURE_MATRIX.md).

## 1. Guiding constraints

Every recommendation below is sized to reality: **one factory, one box, one SQLite file, a synchronous single-process server, no cloud, a small team.** No distributed-systems machinery (brokers, workers, websockets, microservices) until a constraint actually forces it. Every change must be reversible; the 163+ server tests are a standing gate.

## 2. Module boundaries (logical, effective now)

The 26 services group into five domains. Rule: **domain services may import Core; Core never imports a domain; cross-domain calls go through service functions, never raw table access in another domain's tables.**

| Domain | Services |
|---|---|
| **Core** (JENIFY-generic) | `auth`, `users`, `permissions`, `recovery`, `audit`, `settings`, `translations`, `numbering`, `provisioning`, `context` |
| **Inventory** | `inventory`, `stockview`, `receiving`, `transfers` |
| **Production** | `production`, `batches` (incl. QC) |
| **Commercial** | `sales`, `deliveries`, `payments`, `creditview`, `parties`, `simpletxn` |
| **Insight** | `reports`, `dashboard` (read-only over all domains); `masterdata` is shared reference data |

## 3. JENIFY Core: logical now, physical later

Auth, users/roles, audit, settings, translations, numbering, and provisioning are already tenant-generic and contain zero factory logic. They are **JENIFY Core in all but packaging**.

**Decision: do not create `packages/core` yet.** With one product and one tenant, a physical package adds versioning and release overhead for zero users. Instead:
- Enforce the import discipline in §2 (Core never imports a domain).
- Extraction trigger: the day a second JENIFY product (e.g. JENIFY Finance) actually starts, lift the Core services into `packages/core` — the one-way dependency graph makes this a file move, not a rewrite.

Future Core candidates beyond the current list: notifications outbox (§6), attachments/documents, subscription/billing (none exists), AI infrastructure (none exists, out of scope).

## 4. Milestone 2 — Costing + procurement (design)

The largest capability hole: the system counts salt and revenue but can never state a cost or a margin.

**Suppliers:** already modeled (`parties.kind = supplier|both`, `items.purchasable`). Add a supplier management surface to the existing parties UI — no new table.

**Purchase orders:** new tables `purchase_orders` (tenant, supplier, docNumber from a new `po` sequence, lifecycle draft → approved → partially_received → closed | cancelled, expected date) and `purchase_order_lines` (item, qty milli, `unitCostCents`, received qty). Approval via the existing `requirePermission` pattern (new `procurement` module in the permission matrix — additive to `MODULES`).

**Receiving link (additive columns only):** `goods_receipts.poId` (nullable — direct receipts stay legal) and per-receipt `unitCostCents`. Cost is captured at the door.

**Valuation: per-lot actual cost.** Lots already exist and FIFO allocation already runs on them — attach `unitCostCents` to the lot at receipt and the valuation model falls out naturally: inventory value = Σ(lot remaining qty × lot unit cost); COGS at invoice confirm = Σ(allocated lot qty × lot cost). No moving-average engine, no standard-cost variance system. Production batch cost = input lot cost + (M3) consumed materials; labor/overhead deferred until workforce exists.

**Explicitly deferred:** RFQs, landed cost allocation, supplier performance scoring, three-way match, AP/payables (payments are AR-only today and stay so in M2).

## 5. Milestone 3 — BOM / recipe

Iodine, packaging film, and sacks become **consumed stock** instead of typed-in form attributes:
- `stage_inputs` (stage → item, qty per output base unit, scrap %) as a declarative recipe on the existing `production_stages` — the stage chain already is the routing.
- `completeBatch` posts `production_consume` movements for recipe materials (the ledger and reservation primitives need no change).
- Keeps the generic-stage philosophy: recipes are tenant configuration, not code.
- Enables real batch costing (M4 of costing): batch cost = lot inputs + recipe materials.

## 6. Notifications: outbox table, no broker

- New `notifications` table: tenant, type, severity, payload JSON, target (role or user), `createdAt`, `readAt`/`ackedAt`.
- Written **inside the same `inTx`** as the triggering mutation (QC failure, credit breach, reorder point when M4 lands) — no event bus, no worker, no delivery race.
- Read via polled `GET /api/notifications` from the app shell (the dashboard already polls).
- Dashboard's computed alerts stay computed; only events needing acknowledgment get persisted.
- SMS/WhatsApp delivery (Africa strategy) becomes a later consumer of the same outbox — a small poller process, still no broker.

## 7. Offline / resilience strategy

Current design is correct and stays: the service worker caches the shell only and **refuses to cache `/api/` or navigations** — business data is never stale.
- Next step (when field need is proven): TanStack Query cache persistence for read resilience on flaky Wi-Fi.
- Offline **writes**: only ever for a narrow queue of shop-floor confirmations (receiving, delivery status), with server-side idempotency keys — and **never for financial documents** (invoices, payments, credit).
- Multi-site sync: out of scope until a second site exists. The groundwork (UUIDv7 PKs, append-only ledger, full audit history) is already in place.

## 8. Multi-tenancy hardening path

1. **M1 (WP3):** fix login/recovery tenant scoping and `/api/login-info` cardinality — the go-live blocker, since `init-production.ts` creates a second tenant in the same file.
2. Audit that every unique index is tenant-scoped (spot-checks pass today).
3. Per-tenant backup/export tooling.
4. Login-page tenant picker when >1 active tenant.

**Considered and rejected for now:** one SQLite file per tenant. Simpler isolation, but breaks the single-connection model, `login-info`, and provisioning-from-source; revisit only if a real second factory onboards.

## 9. QOS / AI integration points (design-only — out of scope per founder)

No runtime AI code, no AI dependencies, until the founder re-scopes. When that day comes, the data spine is already ideal:
- `audit_events` + append-only `stock_movements` + immutable `quality_tests` + versioned settings/permissions = a complete, replayable operational history.
- Integration surface: **read-only reporting views/endpoints** consumed by an external intelligence layer — QOS never gets write access and never bypasses `requirePermission`; every QOS query executes under the asking user's permission matrix (financial masking included).
- Owner Mode ("understand the factory in 30 seconds") is a presentation of the existing dashboard + reports data — no new data collection required.
- Cost-control routing (fast model → retrieval → tools → multi-agent) is an implementation detail of that future layer, not of FactoryOS.

## 10. Localization & Africa strategy (architecture is done; content isn't)

The framework is genuinely complete: global English key base (685 keys), per-tenant per-language overrides (including relabeling English itself — editable terminology works today), runtime language add with RTL support, Ethiopian calendar display, tenant timezone display, integer-cents money with per-payment FX snapshot.

Remaining work is **content and process**, not architecture: Amharic/Tigrinya fill (needs factory review), country packs as seed-style config packages (the `config-mesob` pattern *is* the country/company pack mechanism — replicate it), local tax/invoice extensions as settings domains + print templates.

## 11. Migration policy

- **Additive-only from 0005 onward**: new tables, new nullable/defaulted columns, new indexes. No column drops/renames, no data rewrites without an explicit founder-approved migration plan + backup.
- Every migration ships with its `meta/_journal.json` entry and snapshot (drizzle-kit generate).
- The lead-architect agent allocates migration numbers — two agents must never mint the same number.
- Ops scripts that touch the live DB must back up first and run in a transaction (WP6 codifies).

## 12. Roadmap

| Milestone | Content | Entry criteria | Exit criteria |
|---|---|---|---|
| **M1** | Correctness & go-live hardening (WP0–WP7, see plan) | approved | all D1–D10 closed; 163+ tests green; new regression suites landed |
| **M2** | Costing + procurement (§4) | M1 done; founder approves PO workflow design | PO → receipt → lot cost → invoice COGS traceable; margin on sales report |
| **M3** | BOM/recipe (§5) | M2 lot costing live | recipe materials consumed from stock; batch cost complete |
| **M4** | Inventory hygiene: adjustments, stock counts, reorder points, returns/credit notes; notifications outbox (§6) | M2 | adjustment + count documents audited; reorder alerts in outbox |
| **M5** | Maintenance + workforce (schema design first, founder sign-off before code) | design docs approved | TBD at design review |

Standing exit criterion for every milestone: full test suite green, feature matrix updated, no invariant (Current State §3) violated.
