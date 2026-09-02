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
- **2026-08-22 — WAVE 1: GO.** Expanded 24-agent parallel execution mission approved
  (Build / Design / Research / Attack tracks).
- **2026-08-22 — Mobile design target:** ~2 GB RAM Android Go-class low-end phone.
  Performance budgets remain hard constraints (initial JS ≤75 kB gzip unless a future
  Founder-approved architecture decision changes it).
- **2026-08-22 — Offline O2 order:** RECEIVING first; DELIVERY CONFIRMATION second.
  Server stays final authority; no LWW, no silent merges, no fake sync status.
- **2026-08-22 — Language-intelligence k = 5.** A translation variant needs ≥5
  organizations before surfacing in aggregate recommendations; callers can never lower
  the floor.
- **2026-08-22 — Global language authority = Founder only initially.** A dedicated
  JENIFY Platform Language Administrator role comes later; tenant Owners customize their
  own tenant language but never approve global JENIFY translations.
- **2026-08-22 — Translation-learning model KEPT** (freedom → anonymized aggregation →
  consensus → human review → official pack → overrides allowed). Production-scale
  multi-company aggregation requires a clear consent/privacy posture first.
- **2026-08-22 — Automated mobile-viewport regression testing: APPROVED.**
- **2026-08-22 — AI-assisted translation clustering: PLANNED.** AI groups/recommends;
  human approves. Never auto-promote.
- **2026-08-22 — Ethiopia e-invoicing: VERIFY FIRST.** Build extensible integration
  boundaries; no compliance claims or certification-specific behavior from unverified
  research.
- **2026-08-22 — Henok continues separately** (Mesob testing, translation work, usability
  feedback) through a structured intake; his work never blocks platform development.
- **2026-08-27 — Two-actor rule stands; no self-approval exception.** (PR #142, HQ lane F,
  issue #139.) The canonical Operator rule that a requester cannot approve its own action is
  kept exactly as built. In the current one-human setup the Founder is the only human
  required: an AI worker originates/requests a gated action and the Founder approves or
  rejects it. If the Founder personally originates a gated action, the Founder does not
  self-approve that same action. Neither a self-approval exception nor a risk-tiered
  exception is to be added. Human identity is a separate deny-by-default registry
  (`hq_human_principals`) that starts empty and grants nothing until a Founder registers
  someone; originating work and approving work are independent rights, and neither ever
  confers execution.
- **2026-08-27 — Registry ↔ Application capability seam: the Registry may only NARROW.**
  (Issue #174 Mission C; closes the seam PR #172 deliberately left open.) When lane C's
  AI Member Registry is supplied to `HeadquarterOperations`, worker capability reads are
  the INTERSECTION of the operator specialist directory and the Registry's
  granted/effective capabilities — never advertised ones. Where both directories know a
  worker neither can widen the other, so enabling the seam can never grant a capability
  that the pre-integration behaviour would not also have granted; where only one knows
  the worker, that one answers, so existing workers are unaffected and Registry-only
  workers are still governed. Assignability is refused if EITHER source refuses. The
  Operator remains the final capability and risk authority: this layer only supplies the
  allow-list, and `operator/policy.ts` still applies risk, side-effect and approval rules
  on top. The seam is opt-in (`memberRegistry`); with no Registry supplied, behaviour is
  exactly as before.

- **2026-08-28 — HQ browser Founder identity REUSES the existing JENIFY OS login.**
  (Issue #200, Founder decision comment of 2026-08-28.) Headquarter grows no second
  password system. The acting HQ principal for a browser write is derived server-side
  from the existing `fos_session` session (`resolveSessionRecord`, which enforces
  expiry, revocation and account deactivation on every request) plus an EXPLICIT
  configured binding from `(realmId, accountId)` to a registered HQ human principal.
  Nothing is inferred from a username, display name, email, admin role or tenant
  ownership, and a request body that names an actor is REFUSED rather than
  re-attributed. A missing, malformed or ambiguous map, an unregistered or deactivated
  principal, an untrusted `Origin`, or a non-JSON content type all fail closed with no
  mutation. Authentication proves identity ONLY: `HeadquarterOperations`, the principal
  registry's originate grants, `founder_gate` policy, no-self-approval, the action
  digest, provider binding, fencing and the kill switch are unchanged and still decide
  what that identity may do. Approving an irreversible (`founder_gate` / `destructive`)
  action additionally requires step-up — a session under five minutes old, or password
  re-entry through the existing credential boundary. Denial is never step-up-gated.
  The browser write surface is exactly three routes (create order, approve, deny) plus
  two reads; there is no generic mutation endpoint and no "ask for changes", because
  the canonical model records approve or deny only. HQ routes exist only when a host
  passes an explicit control plane to `buildApp`, so an ordinary tenant deployment has
  none of them.

- **2026-09-02 — LIVE HQ CONTROL V1 is Founder-accepted and merged; JENIFY HQ is promoted to a
  first-class Jenify product.** Accepted head `36809306b2620cbc419e1b0a04bd7db05a91aaad`,
  merged to `main` as `197844a8d637622fa08c3bdce02159070965d738`. Acceptance rested on a
  Founder-operated browser proof (issue #230), not on local test claims. Phase 2 is authorised
  as PLANNING ONLY at this point: JENIFY HQ is to be separated from the historical JENIFY-OS
  structure and prepared for `hq.jenifylabs.com`, a future Jenify HQ Desktop, and a core shared
  between web and desktop. No extraction, move, merge or deployment is authorised by this
  entry. The target structure, migration order and the two Founder gates it depends on are set
  out in `docs/HEADQUARTER/PHASE_2_FIRST_CLASS_PRODUCT_PLAN.md`; the repository-boundary
  question (top-level product inside this repo first, versus its own repo immediately) and the
  hosted-identity question are Founder decisions that remain OPEN.

- **2026-09-02 — The official JENIFY HQ visual direction reference is the Drive pack
  `HQ-UI-3D`** (folder `1v8lBLeVtYYgfbegNAAbiUdgiIoKHEf6W`), comprising
  `HQ-UI-3D-REFERENCE-NOTES.md`, four reference videos, nine concept images and eight video
  frame references. Locked direction: premium, serious, futuristic — a real high-end command
  headquarters, not a game; dark architectural base, glass/metal, controlled blue/cyan light,
  strong depth, readable UI. The 3D layer is the experience layer, never decoration that hides
  controls, and real data and controls stay authoritative underneath it. Spaces:
  Home/Lobby, Command Room, Mission Room, Meeting Room, World/Network Map, Department
  Navigation. Worker states rendered in 3D (WORKING, VERIFYING, BLOCKED, WAITING FOR FOUNDER,
  COMPLETE) must represent REAL HQ state — this is binding on any 3D work and is the same
  honesty rule `ui/spatial/state.ts` already enforces (deny by default, every live-looking
  thing carries its evidence, nothing invented). The concept images are visual references, not
  final UI specs.
