# BRIDGE-001 — Evidence Synthesis + Execution Plan

**From:** Claude (JENIFY OS Team Lead / primary technical builder)
**To:** ChatGPT (independent review), Gemini (third specialist), Founder
**Date:** 2026-08-22 · **Baseline:** `fbf39d4` on `main`, tags `checkpoint-wave1-complete`, `master-mission-complete`
**Mission:** FINAL MASTER EXECUTION DIRECTIVE — finish JENIFY OS as a complete multi-sector business OS.

---

## 0. BLOCKER — BRIDGE TRANSPORT UNAVAILABLE (honest report)

The directive (§3) says to use the EXISTING Google Drive AI Bridge. **I could not find it and
I cannot reach it:**

- No bridge directory/file in the repository (searched repo + Desktop, all file types).
- No Google Drive mount on this machine — only OneDrive.
- **No ChatGPT tool and no Gemini tool are available to this session.** I have web fetch,
  local shell, and the repo. I have no channel to either model.

**Consequence:** §49 steps 4–6 (publish to bridge → ChatGPT review → Gemini cross-check)
**cannot be executed by me**. I will NOT fabricate an independent review — a fake second
opinion is worse than none.

**Mitigation (in effect):** every bridge artifact is written to `docs/AI_BRIDGE/` in the repo
as the auditable decision record. The Founder can paste these into ChatGPT/Gemini and return
their verdicts. Independent review inside this session is provided by *separate specialist
agents with independent context* (architect / QA-security / release-QA), which is real
independence but is NOT the cross-model review the directive intends.

**Founder action needed:** either (a) point me at the real bridge path/credentials, or
(b) relay these files to ChatGPT/Gemini manually, or (c) accept in-session specialist review
as the independent layer for now. Work continues meanwhile.

---

## 1. WHAT THE EXISTING EVIDENCE SAYS (synthesis of all prior reports)

Sources read: `JENIFY_MASTER_EXECUTION_FINAL_REPORT.md`, `FACTORY_OS_CURRENT_STATE.md`,
`JENIFY_PROGRAM_STATE.md`, `JENIFY_DECISIONS.md`, `JENIFY_ROADMAP.md`, 5 sector/spine designs
in `docs/design/`, 12 research reports in `docs/research/`, 3 red-team rounds in `docs/security/`.

### Decisions already made (still binding)
- Core vs config: reusable capability in platform packages, tenant physics in config. No forks.
- Append-only ledger; posted docs reversed/corrected, never edited; integer milli-units/cents.
- Tenant isolation from session ctx only, never request body.
- AI goes through the same permission-checked services as the UI; never raw SQL.
- Language: company overrides always win; cross-company aggregation at **k=5**; human approves
  official packs.
- Offline: server is final authority; at-most-once idempotent replay; **never** LWW on ledger ops;
  5 honest sync states.
- Finance: **integrate-first** — JENIFY owns operational truth, exports to the accountant's GL.
- Mobile budget: initial JS ≤75 kB gzip (currently 69.22).

### What is genuinely implemented (verified by tests, not claims)
Template/capability engine with deterministic layered resolution + immutable versions; role
experience engine (experience ⊆ permission, proven); shared approvals engine (server-enforced,
SoD, multi-step, pinned policy version); offline O2 receiving + delivery confirmation;
migration MVP (customers/suppliers/items/opening inventory); AI read-only (16 typed intents,
no DB handle, audited) + AI draft-action substrate (preview→confirm→execute, risk-gated);
language intelligence; owner brief; sales returns/credit notes, split delivery, purchase returns.
**342 tests, 4 packages type-clean, 69.22 kB gzip.**

### What is NOT implemented (previously mislabelled as "readiness")
Wholesale, Retail, Construction were **design documents only**. Logistics/Restaurant/Pharmacy and
the other 13 sectors were research notes at best. **Zero of the 20 sector templates existed as
working product configuration.** That is the core of this mission.

### Key research findings that still matter
- **Odoo 20's mobile is a READ-ONLY offline cache** (confirmed from Odoo's own docs). JENIFY's
  queued-write offline is a real, unbreached moat. Do not race Odoo on AI marketing.
- **Consultant-in-the-critical-path is the sharpest validated wedge** — Mesob went live with no
  external consultant; documented Odoo/ERPNext SMB failures cluster on cost/complexity.
- **Tally's only structural weakness is mobile** (keyboard-bound by design).
- **8/10 researched African countries mandate certified e-invoicing.** Uganda EFRIS now covers
  manufacturing; Kenya eTIMS live. Ethiopia Directive 1142 confirmed real, schedule unpublished.
- No pan-African mobile-money API → reconcile-first with thin per-country adapters.
- Cheapest next sectors by reuse: Professional Services, Real Estate, Pharmacy (FEFO on the
  existing lot engine), Logistics last-mile (POD/COD on the shipped delivery+payment spine).

### Outdated assumptions this directive supersedes
| Old rule | New rule (directive wins) |
|---|---|
| "Never build a sector template without a real pilot" | Build strong templates NOW from research + simulation; pilots refine later |
| "Sector work is DESIGN until a customer appears" | Sector work must become working product capability |
| Gemini = emergency only | Gemini = active third specialist |

### Contradictions / debt found
- Platform-standard template layers live in the *tenant* package `config-mesob` (architect TE-L3).
  **Fixing now** — they move to the platform (`@factoryos/shared`) as part of this wave.
- Company-layer template override is domain-blob level, not key-level semantic (TE-H2).
- `/api/stock` and `/api/credit` are unpaginated (perf, hits distributor scale first).
- Payables are not a first-class ledger (purchase-return payable impact is informational only).

---

## 2. MY RECOMMENDATION (Claude's independent opinion — challenge this)

**Do not build 20 sector "apps".** The engine already proves the right shape: a sector is
*capability activation + configuration + role experiences + AI mastery*, resolved through one
core. So the execution order that maximises real working product per unit of risk is:

**Wave 1 — Shared capability expansion (highest leverage).** Ten new capability IDs that
recur across the 20 sectors: `orders`, `pos`, `bookings`, `workorders`, `fleet`, `recipes`,
`expiry`, `cases`, `billing`, `timesheets`. Every sector then *activates* rather than *forks*.

**Wave 2 — All 20 sector templates as real, resolvable platform data**: activation map, simple
surface (4–6 verbs), progressive growth tiers, role-experience presets, AI mastery model —
published through the existing immutable template engine and served by the existing APIs.

**Wave 3 — Deep workflow implementation, sector cluster by cluster**, starting with the trade
spine (wholesale/retail) where ~85% already exists, then jobs/bookings clusters.

**Wave 4 — Onboarding resolver** (Country→Sector→Size→configured) on top of Wave 2 data.

**Honesty rule I will hold myself to (§41):** a sector counts as DONE only when its defined
workflows actually run. Wave 2 produces *configured, resolving, role-scoped templates* — that
is real product capability, but for most sectors I will report **PARTIAL** until their
sector-specific workflows exist. I will not inflate the scorecard.

**Risk I want challenged:** 20 sectors × deep workflows is not achievable at high quality in
one push. My plan deliberately front-loads shared capability + configuration breadth, then
depth per cluster. An alternative is fewer sectors at full depth. I believe breadth-then-depth
is right because the directive demands all 20 exist and because depth without the shared
primitives would force copy-paste forks — the one thing §12 forbids.

---

## 3. QUESTIONS FOR CHATGPT / GEMINI

1. Is breadth-first (all 20 configured, then depth per cluster) correct, or should we ship
   fewer sectors at full depth first?
2. Is the 10-capability expansion the right decomposition, or is it over/under-factored?
3. Does "integrate-first finance" still hold when sectors like Real Estate (leases) and
   Utilities (metered billing) need recurring billing?
4. Which sectors are unsafe to ship without local legal review (Healthcare, Pharmacy,
   Government) and should therefore stay explicitly PARTIAL/administrative-only?
5. Any Africa-specific requirement the prior research missed?
