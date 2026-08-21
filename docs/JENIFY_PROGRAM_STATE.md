# JENIFY OS — Master Program State

Maintained by the ONE Team Lead. One row per workstream. Updated at every gate.
Wave model: research starts everywhere immediately; engineering respects dependencies.

## Wave 0 — running now

### Track A · Research (parallel, read-only, each owns exactly one file in docs/research/)

| ID | Workstream | Owner (role) | Deliverable | Status |
|---|---|---|---|---|
| R1 | Africa Business OS requirements | jenify-product-research | AFRICA_BUSINESS_OS_REQUIREMENTS.md | **DONE** |
| R2 | Africa sector priority map | jenify-product-research | AFRICA_SECTOR_PRIORITY.md | **DONE** |
| R3 | Country pack intelligence (10 countries) | jenify-country-localization | AFRICA_COUNTRY_PACK_INTELLIGENCE.md | **DONE** |
| R4 | Global competitor intelligence + feature DB seed | jenify-product-research | GLOBAL_COMPETITOR_INTELLIGENCE.md + FEATURE_INTELLIGENCE.md | **DONE** (72-row seed) |
| R5 | Role experience + simplicity | jenify-ux-engineer | ROLE_EXPERIENCE_SIMPLICITY.md | **DONE** |
| R6 | Migration intelligence | jenify-data-migration | MIGRATION_INTELLIGENCE.md | **DONE** |
| R7 | AI master architecture + product | jenify-ai-engineer + jenify-ai-qos (design) | AI_MASTER_ARCHITECTURE.md | **DONE** |
| R8 | Offline / Africa hardware deployment | jenify-offline-infra | OFFLINE_HARDWARE_DEPLOYMENT.md | **DONE** |

### Track B · Engineering — Foundation Hardening (Team Lead implements; QA + Architect gate-review)

| ID | Task | Defect | Files/domain owned | Acceptance | Status |
|---|---|---|---|---|---|
| E1 | Multi-tenant login/recovery disambiguation | D4 | services/auth.ts, services/recovery.ts | 2nd tenant + shared username works via tenantCode; tests | **DONE** |
| E2 | Recovery enumeration ordering | D11 | services/recovery.ts | Unknown-user vs weak-password parity test green | **DONE** |
| E3 | Auth rate limiting (login + recover) | D10 (part) | new util + routes/auth.ts | Failed-attempt lockout 429; success unaffected; tests | **DONE** |
| E4 | Doc-number concurrency | D12 | services/numbering.ts | Atomic RETURNING; interleaved-connection test distinct | **DONE** |
| E5 | DB out of OneDrive (safe local app-data) | T2 | db/index.ts defaultDbPath + ops script | Verified copy (hash), branding moved, rollback kept, Mesob works | **DONE** (verified live) |
| E6 | Backup/restore codified | §17.F | db/index.ts + scripts | Auto daily backup + prune, manual + restore scripts verified | **DONE** |
| E7 | Permanent cross-tenant negative-path suite | §17.B | test/tenant-isolation.test.ts (new) | Tenant B can never read/mutate tenant A across all domains | **DONE** |
| E8 | Full regression + build | §17.G | — | 163+ tests green, tsc clean, bundle budget held | **DONE** (175/175) |

### Parallel isolated task

| ID | Task | Constraint | Status |
|---|---|---|---|
| P1 | Mesob remote demo for Henok (separate demo DB, Manager-level user, HTTPS tunnel) | Founder DB untouched; no deployment; stoppable | **DONE** (verified through public HTTPS tunnel) |

## Foundation Gate — **PASSED 2026-08-21**
Multi-tenant fixed ✓ · cross-tenant tests green ✓ · auth hardening green ✓ · numbering ✓ ·
DB safety resolved ✓ · backups verified ✓ · Mesob E2E green ✓ · **jenify-qa-security: PASS**
(H1 relocation guard landed; M2/M3/L1-L3 tracked) · **jenify-architect: APPROVE** (conditions
1-3 landed; C4 login-info residual tracked). Wave 1 is UNBLOCKED pending Founder direction.

## Wave M — Mobile + Offline + Language Intelligence (Founder mission 2026-08-21)

### Research (all delivered to docs/research/)

| ID | Workstream | Owner (role) | Deliverable | Status |
|---|---|---|---|---|
| M-R1 | Low-end Android / African device+network realities / mobile ERP UX / multilingual mobile UX | jenify-ux-engineer + jenify-product-research | MOBILE_LOWEND_UX.md | **DONE** |
| M-R2 | PWA/local-first, SQLite site architecture, sync models, offline conflict handling for ledgers | jenify-offline-infra | OFFLINE_SYNC_ARCHITECTURE.md (phased O1/O2/O3 contract) | **DONE** |
| M-R3 | Translation memory/termbases, crowdsourced models, HITL approval, consensus ranking, anonymization | jenify-country-localization + jenify-ai-engineer | LANGUAGE_INTELLIGENCE_SYSTEMS.md | **DONE** |

### Engineering (stable-architecture subset; Team Lead implements, QA+Architect gate-review)

| ID | Task | Status |
|---|---|---|
| M-E1 | Mobile performance baseline + budgets | **DONE** — docs/MOBILE_PERFORMANCE_BASELINE.md |
| M-E2 | API response compression (low-bandwidth standard) | **DONE** — @fastify/compress, >1 kB |
| M-E3 | Role-scoped mobile bottom navigation + 48 px touch targets + translated-label-safe layouts | **DONE** — responsive substrate; worker-mode profile awaits Role Experience Engine (Wave 1) |
| M-E4 | Offline state UX primitives (honest status vocabulary: local/pending/synced/conflict/failed + offline banner) | **DONE** — Phase O1 substrate; no queued writes yet (deliberate) |
| M-E5 | Language usage aggregation (counts only, one-org-one-voice, k-suppression) | **DONE** — services/languageIntel.ts |
| M-E6 | Versioned official language packs + layered resolution (base→official→country→sector→company override) | **DONE** — migration 0005, getBundle layering |
| M-E7 | Candidate recommendation + human approve/reject/defer/sector/regional/rollback workflow (owner-authority only, audited) | **DONE** — routes /api/language-intel/* |
| M-E8 | QA scenarios 5–10 automated (100 simulated companies → dominance → approval → override survival → inheritance → rollback) | **DONE** — test/language-intel.test.ts, 18 tests |
| M-E9 | Mesob regression | **DONE** — 193/193 tests green |

**Deliberately deferred (contracts not ready / Founder input needed):** sync engine
(O2 queued writes, O3 site-node — contracts written in M-R2), Ethiopic homophone
normalization ruleset (clustering-only, per M-R3), frontend viewport test harness
(needs WP7 harness decision), Ethiopic font subset shipping, AI variant clustering
(AI milestone), platform-admin identity separate from tenant owner.

**Interim language-authority rule (architect-reviewed 2026-08-21):** official-pack
decisions require owner role + settings.approve. Acceptable ONLY on the single-box
deployment. **Hard exit criteria — all required before any true multi-company
hosting:** (1) dedicated platform-admin principal in a separate realm; tenant
owners get 403 on all /api/language-intel/*; (2) server-side k-suppression floor
already enforced (callers can raise k, never lower it); (3) Founder decision on
consent posture (opt-in vs disclosure) for usage aggregation; (4) aggregation-job
separation — reads tenant translations, writes only an anonymized store; (5)
platform-level identity semantics for createdBy/decidedBy (today: tenant-scoped
user ids, no realm qualifier).

## Wave 1 (BLOCKED until gate) — planned
Core configuration/template substrate · Country-pack substrate (Ethiopia formalized + dummy second pack) ·
Terminology engine · Role-experience engine · AI safe-action architecture (from R7) · Migration/import foundation (from R6).

## Wave 2 (BLOCKED until core/template contracts stabilize) — planned
Manufacturing template formalization · Retail template · Wholesale/Distribution template ·
Construction/Projects template · AI read-only intelligence · Onboarding resolver · Excel/CSV MVP · Offline/sync substrate.

## Standing rules
No uncoordinated overlapping edits (one owner per file/domain per task) · research never
auto-becomes features (Team Lead + Architect classify: Core / capability / sector / subsector /
country / company / AI / later / reject) · Mesob stays green · no deploy · checkpoints before
structural work (current: tag `checkpoint-pre-wave0`, backup `backup-2026-08-21-pre-wave0.sqlite`).
