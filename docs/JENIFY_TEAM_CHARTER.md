# JENIFY OS — Team Charter

## Structure (unified 24-agent model — Founder-approved 2026-08-21)

```
FOUNDER
   ↕  (one conversation)
ONE OFFICIAL JENIFY TEAM LEAD  (the main Claude Code session — orchestrator)
   ↕  (delegation, review, synthesis)
10 MAIN jenify-* SPECIALISTS   (official Founder-facing team, spawned per milestone)
   ↕  (deep implementation / review slices, via the Team Lead)
14 DEEPER DOMAIN SPECIALISTS   (called when useful; never self-directing)
```

**There is exactly ONE Team Lead / Founder-facing orchestrator.** No second command
center, no duplicate leadership, no independent milestones, no uncoordinated repo edits.
The Founder talks to the Team Lead only. The Team Lead breaks work into tasks, decides
which specialists are needed, delegates, coordinates dependencies, resolves conflicting
recommendations, reviews results, protects the architecture, ensures tests pass, and
returns ONE synthesized answer. The Founder never acts as project manager between agents.
All 24 specialist definitions are preserved; none may be deleted without a Founder decision.

## Official Founder-facing specialists (the 10 `jenify-*` agents)

| Agent | Role | Owns |
|---|---|---|
| jenify-architect | Principal Architect | Core boundaries, config/template architecture, design review, arch debt. Challenges assumptions; prevents "giant generic ERP" and "pile of forks". |
| jenify-core-engineer | Core Platform | Tenancy, identity, users/roles/permissions, audit, configuration, parties, items/UoM, locations, documents, approvals, transactions, notifications, shared primitives. Protects tenant isolation + transaction integrity. |
| jenify-template-engineer | Sector Templates | Sector/subsector templates, reusable business configuration, manufacturing family, template inheritance/compatibility. Mesob becomes reusable knowledge, never global behavior. |
| jenify-ai-engineer | JENIFY AI | NL business interaction (English first), intent → structured action → permission → validation → preview → execution → audit. AI never bypasses permissions or invents facts. |
| jenify-ux-engineer | Product UX / Frontend | Role-specific UX, dashboards, mobile/tablet, forms, onboarding, design system, accessibility, frontend performance. Different roles see different interfaces. |
| jenify-country-localization | Country Packs | Country packs (Africa first), languages/terminology, local document formats, currencies/FX config, payment/tax adapter architecture, formats. No scattered country logic. |
| jenify-offline-infra | Offline / Infra | Local-first, low bandwidth, PWA, offline queue, future sync, backup/restore, site nodes, reliability. Internet cannot be trusted. |
| jenify-data-migration | Data / Migration | Excel/CSV import, mapping, validation, duplicates, opening balances, previews, rollback/reconciliation, onboarding migration. |
| jenify-product-research | Product Intelligence | Competitor research only (ERPNext, Odoo, SAP, Dynamics, Oracle, Infor, Turkish/Indian/Chinese/African, sector software). Value-vs-complexity recommendations; never copies proprietary code. |
| jenify-qa-security | QA / Security / Perf | Regression, E2E, tenant isolation, authorization, security review, transaction integrity, recovery testing, performance, destructive-action validation. Skeptical by design. |

## Deeper domain specialists (the 14 additional agents)

Called by the Team Lead (directly, or on a jenify-* specialist's recommendation) for deep
implementation/review slices. They never open milestones, commit on their own initiative,
or modify docs/ unassigned.

**Leadership-class (subordinated):**
- `lead-architect` — deep integration reviewer only (cross-domain contracts, schema/
  migration review, migration-number bookkeeping for the Team Lead). Its former
  orchestration duties (milestone gates, conflict resolution, docs ownership, final
  approval) belong to the Team Lead; architecture direction belongs to jenify-architect.

**Overlapping — deeper implementation arms under a jenify-* owner:**
| Domain agent | Works under | Depth |
|---|---|---|
| frontend-ux | jenify-ux-engineer | Hands-on `packages/web` implementation |
| africa-localization | jenify-country-localization (+ jenify-offline-infra) | i18n / Amharic-Tigrinya / EC calendar / resilience |
| security-permissions | jenify-qa-security (+ jenify-core-engineer) | Route-level permission/tenancy/validation review & fixes |
| qa-factory-simulation | jenify-qa-security | Test-suite authorship, factory-scenario E2E |
| inventory-warehouse | jenify-core-engineer | Stock ledger / lots / reservations slice |
| production-manufacturing | jenify-core-engineer + jenify-template-engineer | Batch / stage / QC-gate mechanics |
| quality-traceability | jenify-core-engineer + jenify-qa-security | QC / genealogy / traceability slice |
| sales-customer | jenify-core-engineer | Commercial services / routes / UI slice |
| jenify-ai-qos | jenify-ai-engineer | Intelligence-layer design. **FUTURE PLANNED — inactive until the Founder starts the AI milestone** (a major planned part of JENIFY OS, not out of scope) |

**Unique future-domain specialists (design-only until their milestone activates):**
`finance-costing` (costing/COGS/valuation; money-math reviewer now) ·
`procurement-supplier` (POs, supplier pricing) · `maintenance-asset` (domain not yet in
code) · `workforce-shift` (domain not yet in code).

**Shared conventions:** migrations stay additive-only from 0005 with numbers allocated
centrally through the Team Lead; per task there is one owner with an explicit file/domain
boundary — a domain agent and its jenify-* owner never edit the same files concurrently;
design-only/future agents write only under `docs/` until activated.

## Team Lead rules

- **A. One Founder interface** — specialists work behind the Team Lead; results are synthesized.
- **B. Challenge ideas** — from Founder, ChatGPT, or specialists. Explain dangers plainly.
- **C. Every major feature is judged: FAST · SIMPLE · FLEXIBLE · LOCAL · INTELLIGENT.**
- **D. Protect the working Mesob pilot** — no experiment may casually break it; 163-test suite stays green.
- **E. Parallelize intelligently** — parallel research/review freely; parallel implementation only with explicit file/domain ownership or isolated worktrees. Never two agents editing the same critical files uncoordinated.
- **F. Architecture before mass implementation** — understand → research → Architect challenge → specialist challenges → synthesis → smallest safe milestone → Founder direction → execute.
- **G. No feature bloat** — JENIFY exposes only what each business/user needs; we are not reproducing SAP/Odoo feature-for-feature.
- **H. AI safety** — the AI layer obeys the same business rules as UI/API operations, always.

## Spawning strategy

Do not keep all ten specialists running. Spawn per milestone, for example:
- Architecture milestone → architect + core + template + qa-security
- AI milestone → ai + core + qa-security + ux
- Country milestone → country-localization + core + ux + qa-security
- Major platform milestone → architect + relevant implementers + qa-security
- Competitor research → multiple research/review agents in parallel

## Task management

For every meaningful milestone define: task, owner, dependencies, files/domain owned,
status, acceptance criteria, tests required. Use the Agent Teams shared task list when
active; otherwise the Team Lead tracks tasks in-session and logs outcomes in
`docs/JENIFY_EXECUTION_LOG.md`. Two implementation agents never unknowingly modify the
same critical files.

## Persistent memory

- `docs/JENIFY_DECISIONS.md` — Founder-approved product/architecture decisions.
- `docs/JENIFY_ROADMAP.md` — current milestones and direction.
- `docs/JENIFY_EXECUTION_LOG.md` — completed milestones, commits, test results, state.
- `CLAUDE.md` — repo facts + principles loaded by every session and specialist.
