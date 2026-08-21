# JENIFY OS — Roadmap

## Where we are (2026-08-21)

Mesob Salt Factory pilot is fully built and founder-validated: receiving → washing →
conserved iodization → QC/release → packaging → inventory → credit sales → reservation →
delivery (performance-tracked) → payments (multi-currency-capable) → explicit allocation →
reports → printed documents. 163 automated tests green. JENIFY OS public rebrand complete.
Permanent Claude Code development team established.

## Long-term direction (context — not an implementation order)

One adaptable business operating platform:
small shop → SME → distributor → factory → construction → hotel → restaurant → healthcare
→ agriculture → logistics → corporate/group → other sectors.
One JENIFY platform · sector/subsector templates · country packs · per-company
configuration · role-scoped experiences · one safe AI operating layer.
Mesob is the first deep real-world proof; each new deployment should become template and
country-pack knowledge, not a fork.

## Milestones

| # | Milestone | Status | Notes |
|---|---|---|---|
| 0 | Mesob pilot build + 3 hardening passes | ✅ Done | Commits 2c053e2 → 70efbd6 |
| 1 | Team setup (this) | ✅ Done | Agents, charter, docs, settings |
| 2 | *Next execution mission* | ⏳ Awaiting Founder | Assigned separately by the Founder |

Future candidate directions (unordered, unapproved — require the standard
architecture-before-implementation flow): Mesob production go-live support; template
extraction from Mesob; AI operating layer (read-only intents first); data-migration/import
tooling; second sector template; sync/site-node architecture.

## Strategic risk watchlist (consolidated test-team review, 2026-08-21)

Tactical defects live in the canonical register: `FACTORY_OS_CURRENT_STATE.md` §5 (D1–D13,
T1–T10). Directional risks the Team Lead weighs when sequencing milestones:

1. **Multi-tenancy is a convention, not a construction** — dormant 2nd-tenant bugs (D2/D4)
   plus per-query `tenant_id` discipline with no structural backstop. Must be real before
   tenant #2 or any template extraction.
2. **Template exists only as imperative scripts** — Mesob config is `seed.ts` + accreting
   `apply-*.ts`; extract a declarative typed config artifact before tenant #2, and extract
   templates from real deployments, never from imagination.
3. **AI needs a declarative seam** — permissions are ~102 hand-written route calls with no
   machine-readable action catalog; lift `(module, action)` into route metadata when the AI
   milestone opens (JENIFY AI / QOS is future-planned, not out of scope).
4. **Local-only durability & visibility** — live SQLite under OneDrive sync (T2, corruption
   vector), manual backups, and no remote/owner visibility story (the one place competitor
   demos beat JENIFY today; a read-only owner digest export is the cheap counter).
5. **Module gravity vs correctness floor** — 13 planned capability areas queued on a base
   with no input validation everywhere, no CI/linter, zero frontend/concurrency tests;
   milestone gates must stay mechanical.

*Update this file when the Founder sets or reprioritizes milestones.*
