# JENIFY OS — Execution Log

Append-only. Newest entries last. Each entry: date, milestone, commit(s), tests, state.

## 2026-08-21 — Wave 0: research program + foundation hardening + Henok demo
Master Execution Mission started. Track A: all 8 research workstreams delivered to
docs/research/ (Africa requirements, sector priority, 10-country pack intelligence,
global competitor report + 72-row feature-intelligence dataset, role experience/simplicity,
migration intelligence, AI master architecture, offline/hardware deployment). Track B
(commit e5197c5 + gate follow-up): D4/D11/D12 fixed, auth rate limiting, DB relocated to
%LOCALAPPDATA%/JenifyOS (hash-verified, rollback kept), codified auto/manual/restore
backups, permanent cross-tenant negative-path suite. 175/175 tests green. FOUNDATION GATE
PASSED (QA: PASS, Architect: APPROVE; their conditions landed same-day). Parallel task:
isolated Mesob demo (separate VACUUM-INTO snapshot DB, rotated passwords, Henok /
Operations Manager) verified end-to-end through a Cloudflare HTTPS quick tunnel — founder
stack untouched. Wave 1 awaits Founder direction.

## 2026-08-22 — FINAL MASTER DIRECTIVE: 20 sector families + shared capabilities
Founder directive supersedes the "no sector template without a real pilot" rule: build
strong templates now from research + simulation; pilots refine later. Delivered:
(1) capability catalogue 23->33 — orders, pos, bookings, workorders, fleet, recipes,
expiry, cases, billing, timesheets; (2) ALL 20 sector families as real platform data
(packages/shared/src/sectors.ts) — micro surface, growth tiers, role experiences, AI
mastery, offline workflows — resolving through the existing template engine at every
tier; (3) onboarding resolver (Country->Sector->Size, zero-write preview, re-runnable
provisioning); (4) WORK ORDERS capability implemented (job lifecycle, tenant-scoped
assignment, technician queue, parts issue posting real ledger movements) — makes 6
sectors materially real; (5) BOOKINGS capability implemented (double-booking prevention
with half-open intervals, re-checked inside the transaction) — 4 more sectors; (6)
sector-aware AI with ENFORCED refusals for healthcare/pharmacy/government/agriculture/
mining; (7) operational-period simulations (workshop week, hotel period); (8)
CAPABILITY_STATUS so "activated but not built" can never be hidden.
Bugs found and fixed in-wave: onboarding crashed on existing role codes (now
re-runnable, never clobbers); sector tables leaked into the browser bundle (69.22->74.88
kB, fixed via subpath + permanent guard test); lot-tracked parts could be issued without
a lot; surfaceReadiness silently dropped 'api' surfaces.
342 -> 402 tests (389 server + 13 web). Budget 69.22 kB gzip unchanged. Commits
4f52f67, 6ac5f14, 7d2899c, 598ff03, 14306e2. Canonical main.
BLOCKED: the Google Drive AI Bridge does not exist and no ChatGPT/Gemini tool is
available to the session — cross-model independent review could not be performed and
was NOT faked. Artifacts written to docs/AI_BRIDGE/ for manual relay.

## 2026-08-22 — Wave 1 slice 3: AI safe-action substrate + Offline O2 #2 + Owner brief
Continued Wave 1. BUILD: (G) AI safe-action substrate — full pipeline request→intent→typed
action→permission→validation→risk→PREVIEW→confirm→domain API→verify→audit; a closed typed
action registry (no arbitrary exec, no SQL); execute is impossible without a matching preview
(HMAC confirmation token bound to tenant+user+action+params); RISK GATING — only reversible
draft actions execute this milestone, post/destructive registered-but-refuse; every preview
and execute (incl. refusals) audited. (B2) Offline O2 #2 delivery confirmation — offline
proof-of-delivery replays at-most-once through markDelivered; receiving handler hardened to
strip client-supplied receivedByUserId (server attributes to the syncing actor). (A6) Owner
daily brief — in-app what-happened/needs-attention digest composed from existing services,
financial-masked, severity-sorted (no WhatsApp dependency). 305→315 tests green. Mobile
viewport regression harness + BriefCard web component + red-team round 2 in flight (agents).

## 2026-08-22 — Wave 1 slice 2: Role Experience + Approvals + Offline Receiving + Migration + AI
Continued Wave 1 (Founder "keep moving"). Built as Core (Team Lead) with 4 parallel agents.
BUILD: (A) Role Experience Engine — experience is presentation strictly ⊆ permissions;
versioned per-role spec; effectiveExperience intersects with the live permission matrix;
web bottom-bar becomes a worker action set. (C) Shared Approvals Engine — ONE reusable
capability; server-enforced (only step-role approves), separation of duties, threshold,
multi-step, append-only action log, isApproved gates posting. (B) Offline Receiving O2
server substrate — sync_ops at-most-once idempotent replay; business rejection recorded &
surfaced, never LWW/merged; apply+marker atomic. (A4) Migration MVP — parsed→detect→map→
validate→dedupe→preview(zero-writes)→import; opening stock via audited ledger adjustments;
never invents values. (A5) JENIFY AI v0 read-only — 16 typed intents, permission-first
fail-closed, tenant-from-ctx-only, no DB handle/no raw SQL, deterministic local NL matcher
(no LLM), every invocation audited incl. refusals. (D) Perf — grouped invoicesPaidCents
kills the sales-report + customerOutstanding N+1. Migration 0008 (role_experiences,
approval_policies/requests/actions, sync_ops), additive. Agents also delivered: simulation
lab (2 business profiles, non-happy paths, ledger invariants; surfaced GAP-1 returns/
credit-note, GAP-2 single-invoice split delivery, GAP-3 partial purchase return) and the
Product Intelligence Library (Pharmacy FEFO + Logistics last-mile opportunities; Odoo 20
watch). 219→303 tests green (+3 documented skips); JS budget held (69.22 kB gzip).

## 2026-08-22 — Wave 1 (GO): template engine + security hardening + parallel program
Founder authorized Wave 1 + expanded 24-agent parallel mission. Repo: main fast-forwarded to
d1d9707, tag checkpoint-pre-wave1, DB snapshot verified. Branch `wave-1`. Applied 12 Founder
decisions (k=5 language floor landed). BUILD (W1-A1 template engine): shared capability catalog +
pure deterministic resolution algebra (resolve/validate/diff), immutable versioned template layers,
tenant bindings, company-overrides-win layering; Mesob formalized as Core→Manufacturing→Process→
Salt→Ethiopia with a dummy Testland pack proving Ethiopia is not hard-coded (migration 0006; 14
tests). Security (red-team must-fix): H1 rate-limit source-IP ceiling, H2 self-escalation guards
(owner-exempt), D3 atomic recovery (6 regression tests). Perf: migration 0007 indexes. DESIGN
(5 blueprints), RESEARCH (e-invoicing verification, war room R2, AI sim library), ATTACK (red team,
perf, UX elimination) all delivered. 197→217 tests green; JS budget held (69.08 kB). No deploy.

## 2026-08-21 — Wave M: mobile + offline + language intelligence (first slice)
Founder expansion mission. Research: MOBILE_LOWEND_UX.md, OFFLINE_SYNC_ARCHITECTURE.md
(O1/O2/O3 phased contract; CRDT/LWW rejected for ledgers), LANGUAGE_INTELLIGENCE_
SYSTEMS.md (usage-not-voting consensus; Ethiopic normalization; k-suppression).
Engineering: migration 0005 (language_packs, language_pack_entries, translation_
decisions, tenant sector/country/region); languageIntel service (aggregation counts-only,
recommendations, human-only approve/reject/defer/sector/regional/rollback, versioned
packs, layered getBundle resolution); /api/language-intel/* owner-authority routes;
mobile bottom nav + 48px touch targets + translated-label-safe layouts; offline
banner + sync-status vocabulary (Phase O1); @fastify/compress; MOBILE_PERFORMANCE_
BASELINE.md with budgets. QA scenarios 5–10 automated. 175→193 tests green; initial
JS budget held (69.08 kB gzip). Sync engine deliberately NOT built (contracts only).

## 2026-08-17 — Phases 1–6: full local build (FactoryOS + Mesob tenant)
Commits through `ac1fefe`. Monorepo (shared/server/web/config-mesob), core platform,
Mesob configuration, commercial flow, reports, E2E validation. 88 tests green.

## 2026-08-18 — QC fix
Commit `2c053e2`. Quality Management role split, explicit Approve & Release gate,
immutable retests, configurable target ppm. Live data preserved.

## 2026-08-19 — Master fix (core + Mesob hardening & performance)
Commit `67c2ab5`, tag `checkpoint-pre-masterfix`. Conserved-stage physics (IOD-0001
corrected via audited mechanism), stage output policies, audit UX, dynamic warehouses/
languages, per-user themes, EC calendar, print/PDF documents, PWA, code splitting
(344.65→210 kB initial JS). 101→121 tests green. Migration 0002.

## 2026-08-19 — Master fix #2 (founder validation follow-up + go-live readiness)
Commit `90a1591`, tag `checkpoint-pre-masterfix2`. Warehouse/language delete-vs-archive,
quantity precision policy, payment references, reversed-payment presentation, delivery
performance, operator/supervisor split, report redesigns, branding snapshots,
tenant-branded login, recovery codes, last-owner protection, setup wizard, fresh-tenant
provisioning. 121→145 tests green. Migration 0003.

## 2026-08-19 — Final master fix (JENIFY OS rebrand + polish + go-live hardening)
Commit `70efbd6`, tag `checkpoint-pre-final-masterfix`. Public rebrand to JENIFY OS,
dynamic language eligibility, simple multi-currency, editable timezone, wizard item/stage
editing, approved-selection provisioning with dry-run, recovery session-invalidation +
code UX, About panel, report field additions, UI polish. 145→163 tests green.
Migration 0004. Founder E2E validation: PASS.

## 2026-08-21 — Team consolidation (Founder-approved unified structure)
Two concurrent setup sessions were reconciled into ONE command structure: one Founder-facing
Team Lead session; 10 official `jenify-*` specialists; 14 deeper domain specialists retained
and classified (leadership-subordinated / overlapping-depth / unique-future); `lead-architect`
demoted to deep integration reviewer; `jenify-ai-qos` marked FUTURE PLANNED (AI milestone).
Audit material consolidated: `FACTORY_OS_CURRENT_STATE.md` §5 is the canonical defects
register, extended with test-team findings D11 (recovery enumeration ordering), D12
(doc-number allocation race), D13 (error-surface hygiene); strategic watchlist added to
`JENIFY_ROADMAP.md`. Test-team read-only review (architect + qa-security + product):
163/163 tests independently re-verified green. No product code modified; Milestone 1
implementation NOT started.

## 2026-08-21 — Team setup (this session)
Permanent Claude Code development team: Team Lead operating model, 10 project specialists
in `.claude/agents/`, `CLAUDE.md`, charter/decisions/roadmap/log docs,
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` enabled in project settings (takes effect on new
sessions; this session ran the documented subagent fallback). Read-only test-team review
executed (architect + qa-security + product-research); findings recorded, nothing
implemented. Dev servers left running at http://localhost:5173. Current baseline:
commit `70efbd6` + team files, 163 server tests green.

## 2026-08-26 — Order Capability increment 1 (issue #80 / mission #4)
Post-R4 implementation lane started. New reusable sales-order domain
(`packages/server/src/services/orders.ts`): draft (frozen price/VAT snapshot via the
shared pricing helpers extracted from invoices) → confirm (FIFO lot reservations through
the new shared `allocateLotsFifo` primitive — same allocator the invoice uses, so order
commitments are visible to every per-lot availability check) → partial/full invoicing
(atomic reservation hand-off to a confirmed invoice, cumulative-rounding discount
carry-over, credit limit enforced at the invoice) → cancel (releases the remainder).
Offline idempotent order capture added as sync op `order.create` (server re-checks
permissions; client approval flags never trusted). Routes under `/api/orders` with
sales-module permissions + financial masking. Migration 0011 (additive: sales_orders,
sales_order_lines, sales_invoices.order_id). 17 new regression tests
(test/orders.test.ts): reserved-stock protection, confirm rollback atomicity, partial
fulfilment, discount exactness, credit limit/override, tenant isolation + identifier
non-leakage, idempotent replay, hostile numeric/date input. 442 tests green (3 pre-existing
documented skips), 4 packages type-clean, web bundle unchanged (69.22 kB gzip — no web
code in this increment). PR opened for independent Jules + ChatGPT review; not self-merged.

## 2026-08-26 — Stream 2: Headquarter UI + Archive foundation (issue #43)
New isolated workspace `packages/headquarter` (branch `claude/serene-hopper-xhlhon`, PR to
follow): canonical activity/event model (war-room #41 order B), Founder dashboard views
(NOW / DONE TODAY / BLOCKED / WAITING FOR FOUNDER / NEXT), worker status, project
cards/timelines, historical-archive metadata schema (year/month/project/category, date
confidence, CURRENT/SUPERSEDED/REJECTED/EXPERIMENTAL/ARCHIVED, predecessor/successor
links), read-only inventory/reconstruction pipeline over git log + GitHub exports (Drive
adapter contract prepared), monthly + project-evolution views, inverted-index search
foundation, and a 7-page framework-free static HQ site. 31 new tests green; server suite
399 passed + 3 pre-existing skips; web bundle unchanged at 69.22 kB gzip. Docs:
`docs/HEADQUARTER/ARCHIVE_SCHEMA.md`, `docs/HEADQUARTER/HEADQUARTER_UI.md`. No Mesob
package or operator/control-plane file touched; originals preserved; local-only.

## 2026-08-28 — Headquarter advanced UI/UX upgrade (issue #138)
Founder-approved executive UI direction implemented across all seven Headquarter
pages, on the existing framework-free renderers — no backend redesign, no new runtime
dependency, no new state. New `src/ui/theme.ts` (one dark premium design system as a CSS
string), `src/ui/components.ts` (escaping-by-default fragments: status chips, identity
avatars, KPI cards, meters, scroll-contained table wrappers), `src/ui/archive-search.ts`
(search semantics as plain functions that are unit-tested AND serialized into the page,
so the browser cannot drift from the tests), and new derived read models in
`src/ui/views.ts` (`projectBoard`/`projectHealth`, `founderAttentionQueue`,
`activityFeed`, `specialistProfiles`) — all computed from the SAME canonical
ActivityEvent/ApprovalRequest/ChatMessage/WorkerDescriptor contracts. Command Center
gained a KPI strip, a Founder attention queue, a live activity feed and an AI workforce
strip; Projects became a portfolio board with health/progress/blocker/next; Executive
Room and Direct Chats gained AI identities (vendor + role) and a real context panel;
Specialist Directory surfaces granted capabilities and recorded workload; Founder
Approvals became risk-weighted decision cards. Fixed the known archive UX inconsistency:
search, filters, the ranked result list and the Evolution chains now share one match set.

Truthfulness boundaries preserved and test-locked: no `<button>` and no `<form>` on any
page, Approve/Reject/Ask-for-changes drawn as inert `aria-disabled` placeholders labelled
"not wired", no fabricated cost/token/sentiment/ETA fields, provenance note shown at the
top of every page as well as the footer, and "as of" derived from the newest timestamp in
the bundle rather than wall-clock time (renders stay byte-reproducible).

The confirmed 390px horizontal-overflow defect is eliminated, not masked: `overflow-x:
hidden` is banned and asserted absent. New `tools/ui-evidence.mjs` measures
`documentElement.scrollWidth <= innerWidth` (and `body`) for all 7 pages at 1440/1024/
414/390/360/320 px — 42/42 OK — exercises the archive search interaction in a real
browser (8/8 OK) and writes the screenshot set. Playwright is deliberately not a package
dependency; CI keeps the structural equivalents in `test/ui-responsive.test.ts`.
777 headquarter tests green (was 665 on main; +112), `tsc --noEmit` clean. No Mesob/server/web package,
migration, credential or CI workflow touched; local only, nothing deployed.

## 2026-08-28 — LIVE HQ CONTROL V1 (issue #200)
The read-only Headquarter UI became operational in the four ways the mission defined,
without weakening a single existing authority boundary. New `packages/headquarter/src/live/`
holds the whole seam: `provenance.ts` (the live/reconstructed/sample vocabulary every
snapshot section carries), `redaction.ts` (fail-closed browser-safety guard),
`connections.ts` (Connection Center), `orders.ts` (Direct Orders), `snapshot.ts` (the
browser-safe projection). One new HQ page — Connections — brings the site to eight; all
seven existing pages are unchanged in purpose and pass their original assertions.

**Scope A — live data.** `liveSnapshotFromOperations()` projects canonical state
(`founderConsole` over `op_tasks`/`hq_approvals`, the specialist directory, the capability
registry, `hq_events`) into a versioned JSON snapshot with per-section provenance and an
overall mode that degrades to the WEAKEST section, so one sample section can never let a
bundle render as LIVE. Task payloads never cross the boundary: `ConsoleTask` carries none
and nothing reaches past it. Activity `detail` is whitelisted to project/title and refs are
filtered to https, so arbitrary worker-written detail and local filesystem paths cannot leak.
`assertBrowserSafe` + `assertNoFabricatedFields` run on every snapshot and THROW rather than
publish. The pages poll `hq-snapshot.json` every 20s and report LIVE / UPDATED / OFFLINE /
ERROR truthfully — the chip starts at CHECKING, never at LIVE, and an unreachable snapshot
degrades to OFFLINE instead of claiming freshness it has not verified. New CLI
`npm run hq:snapshot`.

**Scope B — Direct Orders.** `submitDirectOrder()` is a thin seam over the existing
`HeadquarterOperations.createTask`: no table write, no bypass, no new authority. The single
narrow capability `hq.direct_order` is `founder_gate` — the one risk class
`operator/policy.ts` refuses to let a standing pre-approval override — because a free-text
instruction is unclassifiable in advance and the only honest class for it is the highest one.
Every order therefore parks in `needs_approval` with an action digest and executes nothing.
Routing is truthful and fails closed: AUTO picks only from providers evidence shows are
connected, and an explicit CLAUDE or CODEX never silently becomes the other. Idempotency is
derived from (requester, route, project, instruction), so a double submit dedupes.

**Scope C — Connection Center.** State is EVIDENCE-derived, never descriptor-derived. The
catalogue (Anthropic/Claude, OpenAI/Codex, Google/Gemini, GitHub, Vercel, Supabase, Google
Workspace) holds only the questions; answers come from a `ConnectionProbe`, and a descriptor
without a probe is `not_connected`. AI providers reuse `routing/providers.ts`
`providerConnectivity`, so the page and the router cannot diverge; Codex reports LOCAL-ONLY
rather than connected, preserving the truth that it is unavailable to CI and to a hosted
preview. Advertised capabilities become effective only with evidence — enforced centrally, so
an over-eager future adapter cannot promote its own claims. Only secret PRESENCE is read;
fact NAMES are rendered, values never are. No Disconnect control is drawn anywhere in V1
because HQ holds no credential store to revoke from.

**Scope D — approvals stay read-only. SECURITY GATE, unresolved.** Headquarter has no
authenticated Founder session, and `createTask`/`approveTask` authorize by resolving the
actor against the human-principal registry. A browser write would have to trust a
client-supplied principal id (impersonation) or ship a new auth boundary invented under
automation. Neither was done. Approvals remain read-only, the Direct Order composer is drawn
inert with the blocker stated in the UI itself, and the working write path is the local CLI
`npm run hq:order` — a trusted-local-admin/maintenance interface, NOT an authenticated
Founder path (see the correction below).

**Correction after the PR #201 review (same day).** The review was right that the CLI
overclaimed: `--as <id>` accepts a caller-supplied principal id bound to nothing — not the OS
user, not the process owner, not a credential — so describing the OS session as "the
authentication" was false. The interface is now classified for what it is, in code
(`live/local-trust.ts`) rather than in prose that can drift: a trusted-local-admin /
maintenance path for someone who already holds full local access to the HQ database, and who
therefore gains no authority from it. Three fail-closed consequences: `ActorAuthentication`
has NO value that claims authentication (only `unauthenticated` and
`unauthenticated_local_assertion`), so no caller can assert one; the default is the weakest
value; and the CLI refuses to run under CI at all — with no override — and otherwise requires
an explicit `--local-admin` acknowledgement, so an unattended script cannot place
principal-attributed orders. Every order now records its `actorAuthentication` in the payload,
which puts it inside the action digest the approver echoes back. The containment for an
impersonated assertion is the two canonical rules, both untouched and now hostile-tested:
deny-by-default (an unregistered, ungranted, inactive or worker id opens NOTHING) and
no-self-approval (the asserted principal is exactly the one barred from approving the order
it opened, so a local assertion can never manufacture an approved action — a second, genuinely
present approval-authorized human must decide it, seeing the recorded assertion).

**Readiness, stated truthfully: issue #200 V1 is NOT fully accepted.** HQ is not
Founder-operable from a browser while the composer is inert and approvals are read-only, and
the CLI does not close that gap because it authenticates nobody either. A real HQ
authentication boundary remains an open Founder-gated security decision; scopes A, B
(server-side), C, the mobile/UX work, the tests and the preview-ready build are complete.

Two real defects were found by the new tests and fixed. (1) The evidence log's secret
heuristic missed quoted credentials in free text: it ran on the JSON encoding, where
`api_key: "…"` becomes `api_key: \"…\"` and the backslash defeats the pattern. The browser
guard now also scans each raw string. (2) An order's title defaulted to the instruction's
first line, which published Founder-typed content to the browser as a side effect of writing
the instruction; the default is now a neutral `Direct order → <PROVIDER>` label, and a title
is published only when its author deliberately chose one.

895 headquarter tests green (787 on main; +91 for V1, +17 for the actor-trust correction),
server 442 passed + 3 pre-existing skips,
`tsc --noEmit` clean in headquarter/server/shared/web, web bundle unchanged at 69.22 kB gzip.
Browser evidence: 48/48 no-horizontal-overflow at 1440/1024/414/390/360/320 px across all
eight pages, archive interaction 8/8. Local only — nothing deployed, no paid service enabled,
no migration, no credential change, no CI workflow touched.

**Second correction round: four P1 findings from the Codex exact-head review of `90dd0b9`
(same day).** All four were real, all four are fixed on the same PR branch, each with hostile
regression coverage.

1. **The resolved provider is now an execution authority, not payload metadata.** An order
   routed to CLAUDE could still be claimed out of the shared `hq.direct_order` queue by a
   CODEX worker: no-substitution held at creation and evaporated at the execution boundary.
   New `operator/provider-binding.ts` defines the reserved `executionProvider` payload key and
   a DECLARED worker→provider map (`op_worker_providers`); `OperatorQueue.claim` and `start`
   both refuse any worker that is not declared as the bound provider, loudly and with an
   evidence record. The mapping is declared, never inferred — a worker's `vendor` string says
   who makes it, not which executor runs it, and guessing `openai → CODEX` would be an
   invented business rule. Deny by default in both directions: an undeclared worker, and a
   malformed binding, execute nothing. Because the key lives in the payload it is inside the
   action digest, so the provider cannot be swapped between approval and execution.
2. **Registration can no longer re-enable a disabled capability.** `CapabilityRegistry.register`
   wrote `enabled = excluded.enabled` (default 1), and the CLI called it on the way to
   submitting an order — so disabling `hq.direct_order`, the way a deployment stops direct
   orders, was silently undone by the next order. `register` now leaves `enabled` alone unless
   a caller states it explicitly; `hq:order` no longer registers anything, and registration is
   a separate `--register-capability` run that also respects a disabled state. Invocation fails
   closed with `capability_not_registered` / `capability_disabled`.
3. **LIVE now requires an exact snapshot/render match.** The freshness chip treated everything
   "not newer" as LIVE, so an OLDER snapshot rendered as LIVE. The decision is now one shared
   piece of source embedded in the page and executed directly by the tests: exact match → LIVE,
   newer → UPDATED, older or merely equal-but-differently-written → STALE, unreadable → ERROR.
4. **Credential presence is configuration, not connectivity.** A generic integration with all
   its facts present was reported `connected` and granted its advertised capabilities — a
   descriptor-shaped claim wearing evidence's clothes. New `configured` state: presence is setup
   evidence, grants nothing, and carries no verification timestamp. `connected` now requires a
   verifying method — the routing lane's own dispatch contract for AI providers, or a real live
   check — and `assessConnections` downgrades any probe that claims otherwise, so a third-party
   adapter cannot restore the defect. Expired / revoked / malformed / wrong-project / unreachable
   are representable through the `ConnectionVerifier` seam; V1 registers no verifiers, because
   a real one would make a network call.

925 headquarter tests green (895 before this round; +30 hostile tests across
`test/provider-binding.test.ts`, `test/capability-registration.test.ts` and additions to the
connections/UI suites), server 442 passed + 3 pre-existing skips, `tsc --noEmit` clean in
headquarter/server/shared/web, web bundle unchanged at 215.66 kB / 69.22 kB gzip, browser
evidence 48/48 at 1440/1024/414/390/360/320 px across all eight pages, archive interaction 8/8.
The browser Founder-auth gate is unchanged and still open: the composer stays inert, approvals
stay read-only, and issue #200 V1 is still NOT marked accepted.

**Follow-up on the same correction round: freshness is not truthfulness.** The exact-match
rule for LIVE left one case open. The static preview ships a `sample` snapshot whose
`generatedAt` is by construction the render instant, so it matched exactly and the chip
announced LIVE over demonstration data — next to a provenance chip correctly reading SAMPLE.
`freshnessVerdict` now also reads the snapshot's own `mode`: a bundle that says it is
`sample` or `reconstructed` is reported by that provenance, however exactly its timestamp
matches. A snapshot that states no mode, and a genuinely `live` one, are unchanged.

## LIVE HQ CONTROL V1 — FOUNDER-ACCEPTED AND MERGED (2026-09-02)

**Phase 1 is closed and accepted.** This supersedes the "issue #200 V1 is still NOT marked
accepted" statement earlier in this log, which was true when written and is now historical.

- Accepted head: `36809306b2620cbc419e1b0a04bd7db05a91aaad` (PR #228).
- Merge commit on `main`: `197844a8d637622fa08c3bdce02159070965d738`.
- Acceptance basis: a Founder-gated browser proof on a real Edge session (issue #230, stages
  A–F), not a code-inspection claim.

**What the correction round closed.** Three defects, each with its own commit and its own
hostile regression suite:

1. **Connection Center dispatch truth** (`5952e30`). The Connections page reported CLAUDE as
   NOT CONNECTED because it read workflow-secret presence only, while the host observed the
   authenticated `gh` transport as dispatchable. The page now derives its verdict from the same
   `dispatchAvailability` / provider-routing seam that governs real dispatch eligibility — one
   source of truth, no second probe — and states the live answer first, with the
   workflow-secret view retained after it as provenance. New state `dispatchable`
   ("Dispatchable — unverified") keeps an unverified transport from being overclaimed as
   `connected`. 7 tests.
2. **Expired-approval stranding** (`52d057f`). A task whose one-hour Founder approval expired
   sat at `queued` forever: eligibility refused before claim, and the browser flow only
   approves `needs_approval`. `returnForFreshApproval` now routes such a task back to
   `needs_approval` through the canonical execution boundary — no raw SQL, no auto-approve,
   `--check-only` still read-only. Action-digest binding, no-self-approval, provider binding,
   single-use approval nonce, claim fencing and the stale approval as immutable audit evidence
   are all preserved; a digest/claim-binding mismatch still goes to `blocked`, not back for
   re-approval. 13 tests.
3. **Founder-facing route truth** (`7229b9d`). Found by the Founder at the gate: Connections
   said "Dispatchable — unverified" while the Command Center said "Blocked — not connected",
   same host, same instant. Live route verdicts were rendered only inside the Direct Order
   composer, which requires the `hq.direct_order` originate grant — so a Founder signing in to
   APPROVE (correctly holding no such grant) saw build-time markup only. Route availability is
   a fact about the world, not a control: it is now patched outside the grant branch, so both
   pages answer from the same `/session` `routes` field. The grant still governs the control.
   7 tests.

A fourth commit (`b82bc07`) pinned `commercial.test.ts › derives credit statuses` to a fixed
evaluation date. `creditOverview` read the wall clock internally, so on 2026-09-01 a fixture
invoice due 2026-08-31 correctly aged from `partial` into `overdue` and broke the assertion.
The date is now an optional third parameter defaulting to the identical expression, so all six
production call sites are unchanged in source and behaviour. No business rule was altered to
make CI green. A fifth (`3680930`) restored LF line endings in `render.ts`, which had been
rewritten as CRLF and made the largest file in the PR unreviewable.

**Evidence at the accepted head:** headquarter 1752 tests green (80 files); server 483 passed,
3 pre-existing skips, 0 failed; `tsc --noEmit` clean in headquarter, server and web; web bundle
215.66 kB / 69.22 kB gzip with code splitting unchanged; exact-head CI green
([run 33646927534](https://github.com/kiniena-github/JENIFY-OS/actions/runs/33646927534)).
Exactly one real external dispatch was performed in the whole proof — a read-only GitHub issue
read — and the Founder's pristine proof worktree and databases were verified byte-identical
before and after.

**Still open, carried into Phase 2:** issue #227 (Hosted JENIFY HQ V1, Founder-approved
2026-08-30) and issue #231 (harmless GitHub proof). Phase 2 planning is recorded in
`docs/HEADQUARTER/PHASE_2_FIRST_CLASS_PRODUCT_PLAN.md`.

---

## 2026-09-04 — Phase 2 Stage 4: browser client runtime + immersive live 3D HQ (issue #250)

Branch `claude/phase-2-stage-4-client-runtime-3d`, from merged Stage 3 main `416954c`.
Implementation only. Nothing merged, deployed, promoted, activated or billed.

### What changed, and why it is the point of the stage

Before this stage every HQ page was a photograph. `build-site.ts` projected a data bundle
into HTML, and the only question the browser ever asked the server was "is this photograph
out of date?" — which is why the freshness chip has a state reading `UPDATED — page not
rebuilt`. The pages could not show current state even in principle.

**1. An authenticated read route.** `GET /api/hq/control/state` (`live/control-api.ts`)
answers a Founder session with canonical state read from the live database. It reuses
`liveSnapshotFromOperations`, the same builder the polled snapshot uses, so it inherits the
guarantees already proven for that artefact: no task payloads, no secrets
(`assertBrowserSafe`), and no invented metric (`assertNoFabricatedFields` refuses
cost/token/ETA/progress shapes on the wire). It is READ ONLY — the write surface is still
the same three POSTs — and it is served even where a deployment mounts HQ read-only,
because refusing the read alongside the writes would leave a correctly-configured safe
deployment with a blank building.

**2. A typed client runtime** — `packages/headquarter/src/client/` (`@factoryos/headquarter/client`):
`rooms.ts` (the seventeen approved destinations, their bindings and their procedural
placement), `contracts.ts` (the wire shapes), `hydrate.ts` (pure canonical-state → room
views), `access.ts` (the access and lock decisions, as browser source executed by the
tests), `runtime.ts` (the emitted hydration runtime), `webgl.ts` (the shell), `page.ts`,
`theme.ts`.

**3. `immersive.html`** — a tenth HQ page carrying all seventeen rooms, hydrated from the
authenticated route. It takes no bundle data at all: `renderImmersiveHq` has no data
parameter, so a build that happened to hold a rich sample bundle *cannot* make the page
look busier than HQ actually is.

### The honesty boundary, moved forward rather than merely preserved

Room projection happens on the SERVER, inside the Founder gate, and the browser renders
text it was handed. That was deliberate: projecting in the browser would have meant two
implementations of "what does the Mission Room show" — one in TypeScript that the tests
exercise, one in the emitted string that actually ships — and no-fake-state is exactly the
property that rots when the tested copy and the shipped copy are different code.

Each room declares in code where its content may come from. Thirteen are `live` and name
their section. Four are not, and say so at length rather than being filled in: **Meeting
Room** (`not_recorded` — transcript text is deliberately off the client boundary, the same
rule that keeps an order's instruction text server-side), **Research / R&D**
(`not_recorded` — HQ records tasks, not task *classes*, so any research/delivery split
would be invented), **Product Factory** and **Company Memory / Ask Jenify** (`later_phase`).
**Department Navigation** is live but precisely worded: `src/organization/` models
departments, but it is an in-memory engine with no store binding and nothing in the
canonical database persists it, so the room shows the registered *role* of every specialist
— the real recorded lanes — and says HQ has no separate department registry.

Liveness (`active` / `attention` / `quiet` / `dark`) is computed from canonical counts in
`hydrate.ts` and is the only thing that lights a room or moves anything in it. A registry
`active` FLAG does not light the AI Workforce room: it means the registry permits that
worker to hold work, not that it is holding any.

### The 3D shell

Raw WebGL, no dependency, no external asset, ~1.2k procedural triangles, three complete
routes through the page: full motion; reduced motion (instant camera cuts, frozen shader
clock, render loop stops itself); and no WebGL at all (the canvas is removed and the page
is the complete server-rendered document — all seventeen rooms, every metric, every row).
The motion toggle is created by the shell script rather than rendered into the page, which
keeps the site-wide "static markup carries no control" invariant literally true and is also
correct: with no WebGL there is no camera to slow down. Rationale for not taking Three.js,
and for the module landing inside `@factoryos/headquarter` rather than as `packages/hq-client`,
is recorded in `docs/HEADQUARTER/PHASE_2_FIRST_CLASS_PRODUCT_PLAN.md` §4 Stage 4.

### Evidence

Headquarter **1879 tests green, 88 files** (was 1771/82 at the Stage 3 head); hq-host **206**
(was 203); hq-server 20; server 569 passed, 3 pre-existing skips; `tsc --noEmit` clean in
headquarter, hq-host and hq-server; `npm run build:site` renders 10 pages; `npm run build`
clean with the web bundle unchanged at 215.66 kB / 69.22 kB gzip (no file under
`packages/web` was touched).

New suites: `client-rooms` (the seventeen, their routes, and a procedural layout checked for
overlap), `client-hydration` (no-fake-state, asserted over every room rather than a sample),
`client-access` (the shipped access and lock decisions, executed), `client-state-route` (the
route end to end, including a real order changing what the next read answers and a refusal
changing nothing), `client-shell` (feature detection, motion policy, geometry containment in
each room's own frame, page budget), and `client-immersive-page` — which loads the REAL
emitted page into a DOM, lets its own scripts run, and answers every request from the REAL
control API. That last suite exists for the reason `command-center-live-composer.test.ts`
exists: string-level tests can all be green while the page a Founder opens shows nothing.

Four pre-existing assertions were updated because their subject genuinely changed: the page
count (9 → 10), the emitted artefact count (10 → 11), and the control route table (5 → 6, the
addition being a read). One was strengthened: the fetch call-site audit now also allow-lists
`read()` targets, so the runtime's indirection over `fetch` is not a hole in it.

### Not done, and stated as not done

No Founder visual acceptance pass. The approved visual DNA is a 17-screen reference set the
Founder holds locally as image files; this runtime could not read them, so the building was
built from the issue's written design language and the existing HQ UI. The reference
comparison is a Founder step and remains open.

### Stage 4, review round 1 — Codex on `7e87392`, fixed at `9aeec65`

Four findings. Three were real, and one was not — but chasing the one that was
not produced more than the three that were.

**Real, P1: stale views relit the building after invalidation.** The text panels
were cleared on session expiry or a failed state read; the cached views the 3D
shell is driven from were not, and the `hashchange` handler reapplied them. A
signed-out reader navigating between rooms would have watched a lit HQ built
from state they were no longer entitled to see — which defeats the exact
property this stage exists to establish. `clearRooms` now drops the cache
first. The regression test goes at the SHELL entry point rather than at the
DOM, because asserting on the panels is what missed it.

**Real, P2: the page stayed half-current after a failed state read.** The
non-ready session branch cleared the rooms, the lock banner and the state
stamp; the two state-failure branches cleared only the rooms. The page then
said nothing was current while still asserting when it was current and whether
HQ was locked. All three now call one `invalidate()`, so the asymmetry is
unrepresentable rather than merely fixed.

**Real, P2: the Command Room contradicted its own metrics.** Approvals are the
Approvals room's subject, so the Command Room does not list them — but it
counts them and goes to `attention` for them. Immediately after an order is
submitted, the ordinary case, it read "HQ is holding nothing" beneath a metric
reading 1, in a room lit amber. The empty message is now approval-aware, and a
second test asserts the plain wording still appears when HQ genuinely is empty.

**Not real, P1: "WebGL 2 rejects GLSL ES 1.00 shaders."** It does not —
`#version 300 es` is what opts into 3.00, and a WebGL 2 context compiles both.
Rather than reply with a specification citation, the claim was verified:
`packages/headquarter/tools/webgl-evidence.mjs` (`npm run evidence:webgl`)
opens the BUILT page in real Chromium, answers its control-API calls, and pulls
the shader sources out of the page's own inline script so the check cannot pass
while the shipped shaders fail. Result on ANGLE/SwiftShader: WebGL 2 context,
both shaders compiled with empty info logs, program linked, all six attributes
bound, canvas demonstrably drawing.

**That tool then earned its place three times over**, finding defects no DOM
test can see:

- an empty red lock banner on every unlocked page — `[hidden]` in the UA
  stylesheet loses to `.provenance-banner { display: flex }`. The element WAS
  hidden and every assertion about it passed;
- the liveness tint applied to the whole room volume, so entering a room showed
  a wall of colour rather than a lit space;
- lit facades clipping every channel to 1.0 and turning WHITE, losing the one
  thing their colour carries — which liveness the room is in.

It also caught two defects in ITSELF before they could become false findings:
`readPixels` and `drawImage` both return a cleared buffer once a frame without
`preserveDrawingBuffer` has been composited (so an early run reported "nothing
was drawn" beside a screenshot showing the building), and the first highlight
rolloff compressed the whole range and made the building murky. Both are
recorded in the tool.

This closes the "no real-browser GPU verification" limitation this entry opened
with. The Founder visual acceptance pass against the 17 reference images
remains open and is unchanged by any of it.

### Stage 4, review rounds 2 and 3 — Codex, fixed at `12be3c2` and `258bc3f`

Six more findings, all real. Round 2 contained the most consequential defect on
this branch, and round 3 contained the most useful one.

**Round 2, and the lesson in it.** Every box roof and the standalone atrium
floor were wound against their own normals (`+X × +Z` is `-Y`), so with
back-face culling they were removed the moment the camera was above them —
which is where the camera always is. The building had been rendering roofless
and groundless since the first commit.

The lesson is not the bug; it is that **I had looked at browser screenshots of
this scene three times and read the result as a lighting problem.** Two rounds
went into emissive multipliers, a highlight rolloff, and then narrowing that
rolloff to a knee — chasing murk that was missing geometry. Having a real
browser in the loop was necessary and was not sufficient: it showed the symptom
and I supplied the wrong cause. The regression test is therefore the general
invariant rather than the specific case — every triangle's geometric normal
must agree in DIRECTION with its supplied normal, over the whole buffer, since
a sign flip is precisely the bug.

Round 2 also found that the atrium had no geometry bound to Main Home's slot,
so the one room the page opens on could never light whatever HQ was doing; and
sixteen focusable anchors inside an `aria-hidden` overlay, which removes a
subtree from the accessibility tree but not from sequential focus.

**Round 3, and the finding that mattered most.** `tools/webgl-evidence.mjs`
collected each room's liveness and never asserted on it — so the instrument
being used to answer the other findings could print PASS while the state-driven
lighting it existed to prove was broken. It now asserts, and the assertion was
negative-controlled by breaking hydration (stubbed state route returning 500):
the run exits 1 and names every room that stayed dark. The control that does
NOT work is recorded in the tool as well, because it bounds the claim: editing
a fixture liveness changes both what the page is sent and what it is compared
against, so it passes. The assertion's power is over hydration failing, not
over the fixture being wrong about itself.

Round 3 also found Analytics going dark while displaying four non-zero counts,
because its presence came from the task buckets alone while its binding and its
metrics cover the workforce, capability, connection and activity sections too.

One round-3 finding — routing malformed state through full invalidation — was
already fixed in `b6caedc`, found by putting my own review-request question to
the code instead of leaving it for the reviewer.

All ten review threads across the three rounds are answered and resolved.

### Stage 4, review round 4 — Codex, fixed at `3d54ff1`

Three findings, all real, all in the same family: things that are DERIVED from a
state document and therefore have to be surrendered with it.

**Per-room provenance survived invalidation.** `invalidate()` cleared the rooms,
the lock banner and the global stamp; each room's own provenance line went on
printing the previous document's "as of <instant> · provenance live". Now reset
to the binding's own source, taken from `hydrateRooms(null, null)` — the same
function `build-site.ts` uses — so an invalidated page and a freshly-served page
say exactly the same thing rather than having two wordings that can drift.

**Context loss after startup left a dead canvas claiming to be the building.**
Detection covered only a context already lost at creation; a later GPU reset
left the canvas in place with the status still reporting the headquarters
active. The shell now takes the documented fallback. Rebuilding was rejected
deliberately: a half-restored building — right geometry, stale lighting — looks
like it is working, which is worse than an honest absence.

**The evidence tool verified the DOM and I called it verifying the building.**
Its round-3 liveness assertion read `data-liveness` off the text panels, which
the client runtime writes; with the shell silently not uploading, every panel
attribute stays correct and the tool prints PASS over a completely dark
building. It now loads the page twice — mixed fixture, then all rooms dark — and
compares the composited canvases, which is a fact about the GPU rather than
about the DOM.

**The pattern across four rounds, stated plainly.** Nine of ten findings were
real. Two of them were against the verification instrument itself, both times
because I had described a check as proving more than it did. The habit that
came out of it: every new check in this stage is now negative-controlled — the
thing it watches is deliberately broken and the check is required to fail —
and where a control does NOT work, that limit is recorded next to the check.
Removing the `bufferSubData` upload leaves every DOM assertion passing and
fails only the differential; `WEBGL_lose_context` drives a real context loss
and the fallback is checked, including that all seventeen rooms survive it.

All thirteen review threads across four rounds are answered and resolved.

### Stage 4, review round 5 — Codex

Four findings. Three were real defects in the runtime and the shell; the fourth
was against the evidence tool again, and chasing it down found a fifth problem
that nobody had reported.

**A stalled read wedged the runtime open.** A fetch that connects and then
neither resolves nor rejects left `inFlight` true forever: every later poll was
discarded, the last hydrated rooms stayed on screen looking current, and not
even a session expiry could take them down. A fail-closed runtime that silence
can wedge open is not fail-closed. Every read is now bounded by an
`AbortController` at `CLIENT_READ_TIMEOUT_MS` (12s — longer than a Founder-gated
state read on a loaded host, shorter than the 20s poll), with an `inFlight`
deadline behind it for browsers with no `AbortController`.

**A partial state document was applied piecemeal.** The guard asked only whether
`rooms` was an array, so a 200 carrying an incomplete or duplicated set updated
the panels it supplied and left the rest showing the PREVIOUS document — with
the global stamp advanced to the new one. The page presented two instants as
one. `roomsComplete()` now requires exactly the registered seventeen, each
once, before anything is applied.

**The shell kept drawing after losing its context.** Disposal stopped the render
loop, but the runtime holds its own references to `__hqShellApply` and
`__hqShellGoTo` and calls them on every poll and every hash change: the next
successful poll ran buffer operations against a lost context and then called
`wake()`, and because a lit room sets `anyMotion` the loop ran forever against a
canvas no longer in the document. A `disposed` flag, set first in the
`webglcontextlost` handler, now closes every entry point.

**The GPU differential compared two different viewpoints.** The lit frame was
captured after an earlier step had flown the camera to `#/room/approvals` while
the control frame was captured at the home camera, so the "differential" varied
the viewpoint as well as the lighting. Both captures now happen at the home
camera — and that change immediately produced a FALSE FAILURE, which was the
more useful finding. The cause was mine, not Codex's: the amber test also
demanded `r > 70`, an absolute brightness taken when the measurement was made
from the close approvals camera. From the home camera the same amber roofs sit
around (40, 35, 24) — plainly amber in the saved frame — so the tool reported
"room lighting is not reaching the GPU" against a renderer that was working.
A viewpoint-dependent brightness cut has no place in a differential. The test is
now the scale-free channel comparison alone (`r - b >= 8`), with the all-dark
frame as its floor: that frame measures 0 at every margin from 4 upward, peak
`r - b` of -5, because every colour in the scene — fog, facades, cyan structure,
label chips — is blue-dominant. Lit measures ~2,430 of 37,158 samples, peak +22.

Two guards came out of that false failure. A capture is now required to contain
structure (`bright > 100`) before its amber count is allowed to mean anything,
which separates "the building is unlit" from "the measurement is empty" — the
exact confusion that produced the false failure. And the tool now refuses to run
against a site build older than `src/client/`: the first attempt at the buffer
negative control returned a confident PASS because the deletion was sitting in
`src/` while the browser was being shown the previous build. An instrument that
reports on code other than the code in front of you is worse than no instrument.

**Controls run for this round**, each against a rebuilt site: suppressing
`gl.bufferSubData` fails the differential with `bright` still at 385 (captured,
genuinely unlit); suppressing the `disposed` flag takes `framesAfterLoss` from 0
to 136; reverting `roomsComplete` to the array check and dropping the abort
signal fails the three new runtime tests and none of the other 23 in that suite.

Evidence at this commit: headquarter 1900, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS on
Chromium/SwiftShader.

### Stage 4, review round 6 — Codex

Two findings, both real, both the same shape as findings already fixed — and
both reachable because the earlier fix stopped one step short of the guarantee
it claimed.

**The read timeout only bound browsers that have `AbortController`.** Round 5
armed a timer whose callback did nothing when there was no controller to abort,
so on such a browser the read still never settled. The `inFlightSince` deadline
would eventually let a new poll start, but it neither invalidated what was on
screen nor cancelled the abandoned promise: stale canonical state stayed visible
through repeated stalls, and a late answer from an abandoned read could land on
top of a newer one. A guarantee that holds only where a constructor happens to
exist is not a guarantee. The timeout now resolves the read itself, and the
abort is an optimisation on top of it. A generation counter was added with it,
so a superseded cycle cannot write the page when its answer finally arrives.

**Completeness checked the seventeen ids and stopped there.** A version-skewed
200 carrying all seventeen ids with one room missing `metrics` passed, then threw
at `view.metrics.length` part way through the render loop — after earlier panels
had already been mutated — and the throw was caught by a handler that only
cleared `inFlight`. The same mixed old/new page with the same stale stamp and
lock, reached by a different door. The whole `RoomView` shape is now validated
for every entry before any panel is touched, and the outer catch invalidates
instead of walking away.

The negative control for the second one printed the predicted failure verbatim:
`Cannot read properties of undefined (reading 'length')`. It also showed that the
outer-catch change alone would have invalidated the page — but only *after* the
mutation had happened, which is why the pre-validation is the fix and the catch
is the backstop. Both are kept, and the two paths word themselves differently so
a test can tell which one ran.

**A process note worth more than either fix.** When the round-6 request first
came back with "To use Codex here, create an environment for this repo", I
recorded it as a configuration state and wrote that retrying would not clear it.
The review then arrived ten minutes later. The evidence I had — one bot message,
and no review at this SHA — supported "the review has not run", and I stated a
cause I had not established. Reporting the blocker promptly was right; asserting
its permanence was not, and that was corrected on the PR.

Evidence at this commit: headquarter 1902, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS
(lit 2436 warm samples vs 0 dark, framesAfterLoss 0).
