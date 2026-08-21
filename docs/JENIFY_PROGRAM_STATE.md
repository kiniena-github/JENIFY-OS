# JENIFY OS — Master Program State

Maintained by the ONE Team Lead. One row per workstream. Updated at every gate.
Wave model: research starts everywhere immediately; engineering respects dependencies.

## Wave 0 — running now

### Track A · Research (parallel, read-only, each owns exactly one file in docs/research/)

| ID | Workstream | Owner (role) | Deliverable | Status |
|---|---|---|---|---|
| R1 | Africa Business OS requirements | jenify-product-research | AFRICA_BUSINESS_OS_REQUIREMENTS.md | RUNNING |
| R2 | Africa sector priority map | jenify-product-research | AFRICA_SECTOR_PRIORITY.md | RUNNING |
| R3 | Country pack intelligence (10 countries) | jenify-country-localization | AFRICA_COUNTRY_PACK_INTELLIGENCE.md | RUNNING |
| R4 | Global competitor intelligence + feature DB seed | jenify-product-research | GLOBAL_COMPETITOR_INTELLIGENCE.md + FEATURE_INTELLIGENCE.md | RUNNING |
| R5 | Role experience + simplicity | jenify-ux-engineer | ROLE_EXPERIENCE_SIMPLICITY.md | RUNNING |
| R6 | Migration intelligence | jenify-data-migration | MIGRATION_INTELLIGENCE.md | RUNNING |
| R7 | AI master architecture + product | jenify-ai-engineer + jenify-ai-qos (design) | AI_MASTER_ARCHITECTURE.md | RUNNING |
| R8 | Offline / Africa hardware deployment | jenify-offline-infra | OFFLINE_HARDWARE_DEPLOYMENT.md | RUNNING |

### Track B · Engineering — Foundation Hardening (Team Lead implements; QA + Architect gate-review)

| ID | Task | Defect | Files/domain owned | Acceptance | Status |
|---|---|---|---|---|---|
| E1 | Multi-tenant login/recovery disambiguation | D4 | services/auth.ts, services/recovery.ts | 2nd tenant + shared username works via tenantCode; tests | IN PROGRESS |
| E2 | Recovery enumeration ordering | D11 | services/recovery.ts | Unknown-user vs weak-password parity test green | IN PROGRESS |
| E3 | Auth rate limiting (login + recover) | D10 (part) | new util + routes/auth.ts | Failed-attempt lockout 429; success unaffected; tests | IN PROGRESS |
| E4 | Doc-number concurrency | D12 | services/numbering.ts | Atomic RETURNING; interleaved-connection test distinct | IN PROGRESS |
| E5 | DB out of OneDrive (safe local app-data) | T2 | db/index.ts defaultDbPath + ops script | Verified copy (hash), branding moved, rollback kept, Mesob works | IN PROGRESS |
| E6 | Backup/restore codified | §17.F | db/index.ts + scripts | Auto daily backup + prune, manual + restore scripts verified | IN PROGRESS |
| E7 | Permanent cross-tenant negative-path suite | §17.B | test/tenant-isolation.test.ts (new) | Tenant B can never read/mutate tenant A across all domains | IN PROGRESS |
| E8 | Full regression + build | §17.G | — | 163+ tests green, tsc clean, bundle budget held | PENDING |

### Parallel isolated task

| ID | Task | Constraint | Status |
|---|---|---|---|
| P1 | Mesob remote demo for Henok (separate demo DB, Manager-level user, HTTPS tunnel) | Founder DB untouched; no deployment; stoppable | PENDING (after E-track stabilizes code) |

## Foundation Gate (blocks Wave 1)
Multi-tenant fixed · cross-tenant tests green · auth hardening green · numbering green ·
DB safety resolved · backups verified · Mesob E2E green · jenify-qa-security approval ·
jenify-architect approval. **Research continues regardless.**

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
