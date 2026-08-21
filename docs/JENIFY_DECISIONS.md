# JENIFY OS — Founder-Approved Decisions

Append-only. Each entry: date, decision, rationale. Newest last.

- **2026-08-17 — Platform, not app.** Reusable core (typed primitives) + configuration
  packages; Mesob is tenant #1, provisioned through public APIs only. No Mesob literals in core.
- **2026-08-17 — Append-only stock ledger.** Balances always derived; posted documents are
  never hard-deleted or silently edited (cancel/reverse/audited correction only).
- **2026-08-17 — Iodine is not inventory.** Recorded as a batch attribute, not a stock item.
- **2026-08-17 — Payments allocate across multiple invoices**, with explicit visible
  remainder; allocation is always an explicit user action.
- **2026-08-17 — Local-first, sync-ready.** Offline/local deployment, UUIDv7 ids, no cloud
  sync engine yet, no paid external services.
- **2026-08-19 — Stage output policies.** Stages are measured / conserved / converted;
  iodization is CONSERVED (no invented loss); variance only via audited correction.
- **2026-08-19 — Explicit QC release gate.** A passed test alone is not a release; QC result
  and release status are separate concepts. Production Operator, Production Supervisor, and
  Quality Management are separate roles/identities.
- **2026-08-19 — Payment references required** for all non-cash methods; duplicates blocked
  per method. Reversed payments are never allocatable.
- **2026-08-19 — Delete vs archive.** Permanent deletion only for never-used entities
  (warehouses, languages); anything with current dependencies archives. Language eligibility
  is DYNAMIC (clearing translations re-enables deletion). English is protected.
- **2026-08-19 — Branding snapshots.** Issued documents keep their issuance branding
  version; transaction data is immutable regardless.
- **2026-08-19 — Owner recovery without backdoors.** Hashed one-time recovery codes, shown
  once, session-revoking, audited; last active Owner cannot be deactivated/demoted; no
  universal password ever.
- **2026-08-19 — Public rebrand to JENIFY OS.** Tenant identity stays primary ("Mesob Salt
  Factory — Powered by JENIFY OS"); internal `factoryos` identifiers stay for compatibility.
- **2026-08-19 — Simple multi-currency.** Accounting stays in the tenant default currency;
  foreign payments convert once at a configured snapshotted rate. No forex engine.
- **2026-08-19 — Go-live from explicit approved configuration only.** Fresh production
  tenants copy an explicitly approved selection (dry-run preview first); Founder test history
  is NEVER carried to production (Henok gets a clean tenant). Real opening balances enter via
  proper opening documents later.
- **2026-08-21 — Permanent Claude Code team established.** Main session = Team Lead /
  orchestrator; ten project specialists in `.claude/agents/`; one Founder conversation.
- **2026-08-21 — Unified 24-agent structure approved.** Exactly ONE Founder-facing Team
  Lead session; the 10 `jenify-*` agents are the official team; the 14 domain agents remain
  as deeper specialists the Team Lead calls when useful; `lead-architect` is subordinated to
  a deep-integration-reviewer role. No duplicate leadership, no independent milestones, no
  uncoordinated repo edits. All 24 definitions preserved.
- **2026-08-21 — JENIFY AI / QOS is FUTURE PLANNED, not out of scope.** It is a major
  planned part of JENIFY OS; `jenify-ai-qos` stays inactive (design-only) until the Founder
  explicitly starts the AI milestone. Supersedes the earlier "QOS out of scope" framing.
