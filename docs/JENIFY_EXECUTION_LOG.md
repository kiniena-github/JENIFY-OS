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

### Stage 4, review round 7 — Codex

One finding, real, and the third in a row where I had made the right observation
and attached a check that did not enforce it.

**A room's ordinal was only range-checked, not matched to that room.** The text
panels are selected by `roomId` while the shell indexes its lighting by
`view.ordinal`, so the two identify a room by different keys. A document with all
seventeen ids, each once, and every ordinal in range — but two of them exchanged
between two valid rooms — passed, and then lit and pulsed the wrong buildings
beside text panels that were themselves correct. The page disagreeing with
itself is precisely what this stage exists to prevent.

The ordinal is now required to be that room's registered ordinal, from a map
built once out of the same registry the page is emitted from. The test swaps two
adjacent rooms' ordinals — both values valid, both in range, every id present —
and asserts at the shell entry point rather than at the panels, since panels were
never the half that was wrong. Reverting to the range check fails exactly that
test and none of the other 28.

**The pattern, now three deep and worth stating plainly.** Round 6's timeout was
bound to a constructor rather than to the clock. Round 6's completeness check was
weaker than what the code downstream relied on. This one sat under a comment I
had written myself — "the shell indexes its per-room state by it, so a bad
ordinal would light the wrong building" — above a check that only verified the
number was between 1 and 17. Each time the reviewer reported a class of defect, I
fixed the instance and left the class open. The observation was never the missing
part; the enforcement was.

Evidence at this commit: headquarter 1903, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS
(lit 2449 warm samples vs 0 dark, framesAfterLoss 0).

### Stage 4, self-review after round 7 — the registry constraint

Not a reviewer finding. Round 7's lesson was that three times running I had made
the right observation and written a check that enforced something weaker, so
before requesting round 8 I put that question to the rest of the guard: what does
a *well-formed* state document still get through it?

Two things did, and both are now closed:

- **`liveness` was any string.** It is a closed set of four in the contract. The
  shell falls back to dark for anything else and the CSS simply would not match,
  so nothing threw — which is exactly why it needed asserting rather than
  assuming.
- **`status` was unconstrained by the room's binding.** `hydrateRooms` is exact:
  a room bound `not_recorded` or `later_phase` always reports that kind and
  always reports `dark`, while a live-bound room reports `live` or `awaiting`.
  Both sides of the wire hold the same registry, so a document that disagrees is
  a version skew or worse — and what it produces is the failure this whole stage
  exists to prevent: a room the registry says HQ does not record, arriving as
  LIVE and rendering canonical-looking state for a capability that does not
  exist.

**The constraint immediately rejected my own evidence tool's fixture**, which had
hard-coded `status: 'live'` for all seventeen rooms including the four static
ones. That fixture had been wrong since it was written, and nothing noticed
because nothing checked: `webgl-evidence.mjs` was lighting the page with a
document the real server cannot produce and calling the result evidence. The
fixture now carries each room's real binding, and the comment beside it says why
the column exists so it cannot quietly drift back.

That is the fourth defect this stage has found in its own verification
instruments, and the pattern behind all four is the same — an instrument is a
claim about the system, and an unchecked claim decays exactly like unchecked
code.

Evidence at this commit: headquarter 1905, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS
(lit 2433 warm samples vs 0 dark, framesAfterLoss 0).

### Stage 4, review round 8 — Codex

Three findings. Two new and real; the third had already been fixed in `660e78b`
minutes earlier, from the opposite direction — I had put round 7's own lesson to
the rest of the guard and reached the same conclusion independently. That
convergence is the first sign in eight rounds that the loop is nearing its end.

**The client contract lied about the kill switch, so the type system helped
nobody.** `contracts.ts` declared `engagedScopes: string[]`; the server sends
`{ scope, reason, engagedBy, engagedAt }[]`. Both the lock banner and
`securitySection` joined that array straight into a sentence, so a partial lock
would have read "engaged for 2 scope(s): [object Object], [object Object]" — a
security control failing to name what it had locked, at the moment the name
matters most. The contract module's own docstring says these types are
"deliberately DERIVED from the server's own published shapes rather than
restated". This one was restated, and wrongly. It now points at `KillSwitchView`.

Note what did NOT catch it: `tsc` was clean before and after the type was fixed,
because `join()` is legal on any array. The existing test did not catch it either
— its fixture used plain strings, agreeing with the wrong contract, so it passed
while production would have printed `[object Object]`. A test whose fixture is a
guess proves only that the guess is self-consistent.

**A document's own header was never validated.** Seventeen perfect rooms with a
missing `generatedAt`/`mode` were applied and the stamp read "Canonical state as
of undefined" — and, far worse, an absent `killSwitch` resolved through
`lockState` to `locked: false`, which CLEARS a lock banner that was previously
and correctly visible while the rooms beside it still presented as current. A
page that quietly stops showing a lock is the worst single failure available on
this surface. Absent is not "unlocked"; it is unreadable, and unreadable now
fails closed like everything else here, with the invalidation message saying
explicitly that the lock is among what the page no longer claims.

**Two instruments were wrong in the same way this round**: the kill-switch test
fixture, and (found by my own registry constraint) the WebGL evidence fixture.
Both were hand-written claims about what the server produces, and both were
wrong for as long as they existed. Five of the defects in this stage have now
been in verification rather than in the product.

Evidence at this commit: headquarter 1908, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS.

### Stage 4, self-review after round 8 — the provenance header

Not a reviewer finding. I had put a question to round 9 — should `headerValid`
also check that `generatedAt` parses and `mode` is meaningful — and then noticed
my own reason for stopping was *"both would render as text rather than
mislead"*. That is the identical reasoning that let `[object Object]` reach a
lock banner, so it does not survive contact with this stage's own standard, and
half the question did not need a reviewer at all.

`generatedAt` must now be a real instant. The stamp says "Canonical state as of
X", and an X that is not a time makes that sentence false rather than ugly.
`mode` must be non-empty, since it is the field that tells a reader whether they
are looking at real or sample data and an empty one leaves the stamp asserting a
provenance with the provenance missing.

**What was deliberately NOT done, and pinned by a test so a later tightening
cannot quietly take it away:** `mode` is not checked against a list of known
provenance values. The server owns that vocabulary and may legitimately grow it;
a client that blanked the whole page on an unfamiliar mode would trade a cosmetic
problem for a total one. Mode is displayed as text either way, so the strict and
lenient failures differ only in blast radius — and the lenient one is smaller.
This is the second constraint on this surface capable of a false refusal, and
the reasoning for where the line sits belongs in a test rather than in a memory.

Evidence at this commit: headquarter 1910, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS.

### Stage 4, review round 9 — Codex

One finding: reject empty provenance header values. The empty-string half was
already fixed in `d2bf9b5`, pushed minutes before the review submitted — the
second convergence in two rounds, and the clearest signal yet that this loop is
running out of defects rather than out of patience.

The half that was NOT convergence is the one worth recording. Codex added that
`mode` should ideally be restricted to the server's `live | reconstructed |
sample` vocabulary. I had explicitly argued against exactly that one round
earlier, and pinned my reasoning in a test: the server owns the vocabulary and
may grow it, so a client checking a hard-coded list would blank a legitimate
page.

**That reasoning was wrong, and wrong in a way this branch had already been
taught once.** I framed it as strict versus lenient, when the real question was
where the truth lives. `SOURCE_MODE_LABELS` is a `Record<SourceMode, string>`,
so TypeScript already requires a key for every mode the server can emit; the
vocabulary can be emitted from it at build time and grows in the same build the
union does. There was no drift to trade against and therefore no dilemma — the
same "derive, do not restate" lesson that the kill-switch contract taught in
round 8, applied one round later to a decision I had already made confidently in
the opposite direction.

The test that asserted an unknown mode is accepted is now inverted, and a second
test asserts the emitted list equals `Object.keys(SOURCE_MODE_LABELS)` — because
a stale copy of that list would cause a false refusal that blanks the page, which
is the failure mode the constraint itself is meant to avoid. Both are
negative-controlled independently: relaxing the check fails the refusal test;
hard-coding a wrong list fails the drift test.

Evidence at this commit: headquarter 1911, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS.

### Stage 4, review round 10 — Codex

Two findings, both real, both fixed.

**A static room could carry content while its light was correct.**
`statusAllowed` pinned the status and the liveness of a `not_recorded` or
`later_phase` room and stopped there, so a document could keep NOT RECORDED and
`dark` while supplying perfectly valid metrics — and `renderRoom` would put
canonical-looking numbers underneath a chip still saying the subject is not
recorded. `hydrateRoom` guarantees those collections are empty for a static
binding; the guard now enforces what that guarantees rather than a weaker
neighbouring property. Same shape as round 7's ordinal, one level further in.

**The motion toggle changed the policy and nothing else.** The preference is an
INPUT to the per-room pulse flags and to `anyMotion`, and `applyViews` is the
only place either is computed — but both handlers changed `motion` and called
`wake()`, which redraws with the old flags. Reduced → full left active and
attention rooms frozen until the next poll, up to twenty seconds later. Full →
reduced left `anyMotion` true, so the loop went on scheduling frames forever
against a deliberately frozen shader clock — which also made this module's own
docstring false where it promises the render loop stops itself under reduced
motion. The shell now remembers the last state it was given and recomputes from
it whenever either the button or the OS media query changes.

**The evidence fixture was caught claiming something the server cannot produce,
for the second time.** It gave every room a metric, including the four static
ones. The first time was `status: 'live'` on all seventeen. Both were found by a
constraint added to the CLIENT rather than by anything watching the tool, which
is the strongest argument yet for keeping the client strict: the strictness
audits the fixtures too. That is six defects in this stage's verification
instruments.

Evidence at this commit: headquarter 1913, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS
(lit 2430 warm samples vs 0 dark, framesAfterLoss 0).

**On `accessVerdict`,** which I have asked three reviews to look at and none has
reached: I read it adversarially myself rather than keep asking. Every path fails
closed — transport error first, explicit 401/503/403, anything else non-200 to
malformed, and `ready` reachable only with no transport error, status 200, a
readable object, and strict `=== true` on both `ok` and `founder`. Existing
coverage already includes the truthy-but-not-true variants and pins that
`authenticated` never substitutes for `founder`. A negative result from the
author is worth less than one from a reviewer, so the request stands — but it is
recorded rather than left as an open unknown.

**Round 10 follow-up — the motion toggle, observed rather than asserted.** In
the review reply I noted that the regression test for the motion fix is
structural, that it therefore does not observe a frame count changing after a
toggle, and that extending `evidence:webgl` to do so was possible but not done.
Leaving it there would have been leaving a known gap for later, so it is done:
the tool now clicks the real button in a real browser and counts frames.

    "motion": {
      "startLabel": "Motion: full",      "framesFullMotion": 33,
      "reducedLabel": "Motion: reduced", "framesReducedMotion": 0,
      "restoredLabel": "Motion: full",   "framesRestored": 33
    }

Zero is the number that matters: it is the shell's own documented promise —
"the render loop then stops itself, so an idle tab costs no GPU at all" —
finally measured instead of claimed. Negative-controlled by reverting either
handler to a bare `wake()`, which reports `framesReducedMotion: 35` and fails.

The check also guards its own premise: if the loop is not running under full
motion in the first place, the reduced-motion measurement proves nothing, so
`framesFullMotion > 10` is asserted before the zero is allowed to mean anything.
That is the same lesson the differential's `bright > 100` guard encodes — a
measurement that cannot distinguish "working correctly" from "not measuring" is
not evidence.

### Stage 4, review round 11 — Codex

One finding, and the best no-fake-state catch since the roofs: **navigation
selection was lighting rooms.**

The vertex shader carried `vGlow = aState.a * pulse + aPulse.y * 0.45`, so the
room the current route selected glowed harder regardless of its canonical state.
A dark room, selected, rendered at roughly eight times the emissive output of an
unselected dark room — and Main Home is the DEFAULT route, so on an empty HQ the
very first thing a Founder saw was a lit room that HQ was holding nothing in,
directly beneath a legend reading "a dark room is a room HQ is holding nothing
in". The building was contradicting the sentence printed beside it.

Selection is now an edge in a fixed neutral colour, carried on its own varying
and added after the glow term. Two properties keep it unmistakable for liveness,
and both are asserted: it never multiplies the state tint, so it cannot borrow a
state colour; and it rides the rim term, so it outlines the room rather than
filling it. The legend now describes it, because a building with a visual
vocabulary should explain all of it rather than most of it.

**On what the test does and does not prove.** It is structural — the emitted
shader source must not put `aPulse.y` into `vGlow`, and the selection colour must
be a literal rather than `vTint`. A pixel-level check was considered and
deliberately not built: isolating one room's pixels while changing only the
selection needs either a camera move (the round-5 confound) or a per-room mask
this tool does not have, and a fragile measurement that could report a false
failure is worse than an honest structural test with its limits written down.
Shader compile, link and the lit/dark differential are all re-verified in a real
browser, so the change is known not to have broken the rendering path.

Evidence at this commit: headquarter 1914, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS
(shaders compiled and linked, lit 2441 warm samples vs 0 dark, motion
36/0/35, framesAfterLoss 0).

### Stage 4, review round 12 — Codex

Two findings, both real, and both the same recurring shape: I had enforced a
SUBSET of what `hydrateRoom` guarantees. That is now the fifth round in which the
observation was right and the enforcement was narrower than the invariant, so
this time one of the fixes is structural rather than another field check.

**`awaiting` was accepted from the wire.** It means "no state document has been
read yet" — what the static build ships, from `hydrateRooms(null, null)`. The
state route always calls `hydrateRooms` with a real state, so a fetched document
can never legitimately contain it. Accepting it let a payload render canonical
metrics and lit rooms underneath a NO STATE READ chip while advancing the
provenance stamp: the page claiming it had read nothing and showing what it read,
simultaneously. Live-bound rooms must now be exactly `live`.

**A response could rewrite what a static room says.** I had pinned status, then
liveness, then metrics and rows — and a fabricated `emptyMessage` still walked
through and replaced the registry-backed NOT RECORDED explanation with server
text. Adding a fourth and fifth field check was the losing game. Static panels
are now **never re-rendered from the wire at all**: their statement comes from
the registry, does not depend on a session, and the server-rendered sentence is
already the right one. They are still validated — the shell reads their ordinal
and liveness, and a document that omits or malforms one is still refused whole —
but nothing in a response can reach their text. This also matches what
`clearRooms` has always done with those panels.

The lesson, stated once more because five rounds have now taught it: when a
reviewer names a class of defect, the fix is to enforce the invariant, not to
close the instance. Where the invariant is "this text never comes from the wire",
the enforcement is to stop reading it from the wire — not to compare it against
what it should have been.

Evidence at this commit: headquarter 1916, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS
(lit 2439 vs 0 dark, motion 31/0/33, framesAfterLoss 0).

### Stage 4, after round 12 — a guard against the defect this branch keeps producing

Not a reviewer finding. Rounds 7, 8, 10, 11 and 12 were all the same shape: a
field arrives from the wire, something downstream reads it, and the validator
happens not to check that particular one. Each was caught by review, one field
per round. Reviewing harder is not a fix for that; the fix is to make it
impossible to read a field nobody validated.

`client-immersive-page` now derives BOTH sets from the shipped source rather than
from a list anyone maintains: every `view.x` / `metric.x` / `row.x` / `chip.x`
that the rendering path and the 3D shell touch, against every one the validators
touch. A field consumed without a check fails in the same commit that adds it,
rather than in someone's next review round.

Negative-controlled by dropping `isText(view.provenance)` from `roomViewValid`:
the test fails and names the field —

    read from a state document but never validated: provenance

It also guards its own extraction: if the source markers drift and nothing is
found, `consumed.size > 8` fails rather than the test silently passing on an
empty set. That check exists because an emptily-passing test is the exact failure
mode that made the round-3 evidence tool useless, and this file has now written
that lesson down three times.

What this does NOT cover, stated so it is not read as more than it is: it sees
property access by literal name, so a field read through a computed key would
escape it, and it says nothing about whether a validated field is validated
*correctly* — only that something checks it. The per-field tests remain the proof
of correctness; this is the proof of coverage.

Evidence at this commit: headquarter 1917, hq-host 206; `evidence:webgl` PASS.

### Stage 4, review round 13 — Codex

One finding, wrong in **both** directions, and each direction a different kind of
lie. The Mission Room derived its liveness by matching raw `task.status` against
hand-kept sets instead of reading canonical bucket membership.

- **A task awaiting independent review keeps status `running`**, but
  `founderConsole` files it in `pendingReviews` and deliberately excludes it from
  `inFlight`. Matching the status marked the room `active` and pulsed it —
  motion asserting a worker held a task the canonical console says nobody is
  executing. Fabricated activity, which is the single thing this stage exists to
  make impossible.
- **`review_failed` is canonically blocked** — `blocked` is built as
  `byStatus('blocked')` plus `byStatus('review_failed')` — but it was missing
  from `ATTENTION_STATUSES`, so the Mission Room sat quiet while Home and the
  Command Room, which read the bucket, showed attention. Two rooms describing one
  task differently.

Mission now uses exactly the arithmetic the Command Room already used
(`ops.blocked + ops.outcomeUnknown + ops.approvals` for attention,
`ops.inFlight` for active), so the two cannot diverge by construction rather
than by agreement. `review_failed` was added to `ATTENTION_STATUSES`, which now
only tones chips and per-status metrics and no longer decides whether anything
is lit.

**`RUNNING_STATUSES` was deleted rather than left unused.** It held
`['assigned', 'running']` and looked like the obvious way to ask "is a worker
holding this task" — which is precisely how the defect happened. An unused
shortcut with a plausible name is the next person's mistake waiting to happen,
and the comment left in its place says so.

Three tests, and the third is the one that matters: beyond the two reported
cases, a property test walks six bucket combinations and requires the Mission and
Command rooms to agree on whether they are lit. All three fail against the old
derivation.

Evidence at this commit: headquarter 1920, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS.

### Stage 4, after round 13 — the sweep, actually done

In the round-14 request I named as my first item "the other rooms' liveness, with
round 13's lens", and admitted it was "exactly the sweep I keep believing I have
done and keep being shown I have not". So it was done rather than left as a
question, room by room:

- **Home, Command, Mission, Approvals, Founder Office, Analytics** — all read
  canonical bucket counts. Correct, and Mission and Command now agree by
  construction rather than by coincidence.
- **AI Workforce, Departments, Resources, Projects** — presence only, no status
  interpretation at all.
- **World Network / Connections** — reads `connection.state` directly, which is
  the canonical field for a descriptor. There is no bucket to disagree with.
- **Security Center** — derives from the canonical kill-switch record and the
  server's own control grant. No re-interpretation.

One thing fell out, and it is the same shape as round 13 twice over.
`activitySection` derived `attention` by matching `ATTENTION_STATUSES` against
`event.status` — but an activity event is a HISTORICAL log entry, and its status
is the status at the time of the event, not a statement about now. A room lit
from that would claim something needs a human because something once did.

It never ran: `'activity'` was the one declared `RoomSection` that **no room was
bound to**. So it was dead code, with a plausible name, already containing the
defect. Deleted for the reason `RUNNING_STATUSES` was deleted one round earlier.

A new test reads the declared `RoomSection` union **out of the source** and
requires every member to be bound by a live room, so an unreachable section
fails immediately instead of sitting there looking maintained. Negative-controlled
by re-declaring `'activity'`: it fails and names it.

Evidence at this commit: headquarter 1921, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS.

### Stage 4, review round 14 — Codex

Two findings, both real, and both land squarely on work I had just declared
finished.

**Analytics ignored approvals.** `attention: stopped` counted blocked and
outcome-unknown only, so an approval-only HQ left this room QUIET while Home,
Command, Mission, Approvals and Founder Office all ranked the same approval as
attention — five rooms amber and one not, over one task. Worse with running work
present: Analytics went `active`, which under the documented
attention-over-active ordering reads as "work is moving and nothing needs you".

The uncomfortable part is that **my own sweep one commit earlier read this room
and declared it sound.** It was not. Reading each room in turn is not the same
as comparing them against one another, and I had done the first while claiming
the second.

**The Command Room went dark over a pending review.** With `pendingReviews` the
only populated bucket, it was absent from rows, attention and active, so
`present: rows.length` was 0 — the room said "HQ is holding nothing" while Home
and Mission said quiet, because the task IS recorded. Presence now includes
approvals and pending reviews, an "Awaiting review" metric was added so a
non-dark room always shows the reader why, and the empty message names whichever
of the two is holding work.

**And the finding against my own test.** My round-13 cross-room check compared
only `lit()` — "both lit or both unlit" — so a DARK room contradicting two QUIET
ones passed straight through it. A consistency check that collapses the very
distinction the page depends on is not a consistency check. It now asserts exact
liveness equality across Home, Command and Mission, and in that form it catches
the Command defect on its own.

That is the seventh time the enforcement was narrower than the invariant, and
the second time the narrow thing was a test I had written to prevent exactly
this class.

Evidence at this commit: headquarter 1923, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS.

### Stage 4, review round 15 — Codex

One finding, and the **third** against a guard I built rather than against the
product. The section-binding test read the declared `RoomSection` union by
regex-scanning `rooms.ts` for `'(\w+)'`. A section named `'audit-log'` would
have been skipped entirely — and the guard's own sanity check still passed on the
members it did match, so it would have gone on reporting that every section was
bound while silently not checking one.

The fix is the lesson this branch keeps re-teaching, applied to a test this time
rather than to the client: **derive, do not parse.** `ROOM_SECTIONS` is now an
exported runtime tuple and `RoomSection` is `(typeof ROOM_SECTIONS)[number]`, so
`tsc` keeps the two identical by construction and there is nothing left to scan.
Any name a TypeScript string literal can hold is covered, because no name is
being matched.

Controlled with Codex's own example: adding `'audit-log'` to the tuple without
binding it fails and names it. A second test asserts the other direction — every
bound section is declared — because the guard looked one way, and looking one way
is how three of these findings happened.

**The tally, stated plainly.** Fifteen rounds, thirty-three findings, thirty-two
real. Nine of them were in verification rather than in the product: three in the
evidence tool, two in its fixtures, one in a test fixture that agreed with a
wrong contract, and three in guards written specifically to stop a recurring
class. Every guard has caught real defects and was worth building. Every one of
them also needed the reviewer to find its gap first, which is the honest summary
of this branch: the instruments improve, and they improve *after* someone else
shows me where they were thin.

Evidence at this commit: headquarter 1924, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS.

### Stage 4, after round 15 — the invariant behind rounds 1, 3 and 14

Not a reviewer finding. In the round-16 request I named the empty messages as a
place I had fixed twice by instance and never checked generally. Rather than read
the other twelve rooms — which is exactly what failed in round 14 — it is now a
test over every live room at once.

The invariant, taken straight from the page's own legend: **a dark room is a room
HQ is holding nothing in.** So a dark room may not display a non-zero count or a
row, and a room that is not dark must display something that explains why.
Rounds 1, 3 and 14 were all instances of that one property, each fixed correctly
and none of them preventing the next.

Eight canonical-state scenarios, every live room checked in both directions.

**It found something on its first run**, and the right answer was to leave the
code alone. The Founder Office renders a row while dark — but that row is the
SESSION's resolved principal, who you are, not something HQ is holding. The
existing comment already said so: lighting the office for it would mean an empty
HQ never looks empty, and would light a room for "you exist" rather than for
recorded work. That is the no-fake-state rule beating visual tidiness, and it is
correct.

So the exemption is recorded in the test with its reasoning — and kept narrow.
The office's numeric metric, tasks held at the gate, is still required to be zero
when it is dark, so a dark Founder Office with a real approval waiting still
fails. Verified by forcing exactly that: the check names the room and the count.
Only the identity row is forgiven.

Evidence at this commit: headquarter 1926, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip.

### Stage 4, review round 16 — Codex

Two findings, both in the two rooms I had named in the round-16 request as the
place nothing on this branch could cross-check. Asking was right; the rooms were
wrong.

**The legend told the Founder something false.** It said a pulsing room "holds
work the canonical queue records as running or stopped" — true of the task rooms
and false of two others. The Security Center reaches `attention` for an engaged
kill switch or an untrusted request origin; the World Network and Settings rooms
for a failing integration. All three with an entirely empty queue, and the shell
pulses every attention room. So a deployment-posture pulse was being explained as
proof of queue work.

A page whose entire claim is that it never asserts more than canonical state
supports cannot afford a legend that asserts more than the lighting supports.
The note now says what a pulse means room by room, and a test holds it to that —
including that the page actually renders the note, since asserting the constant
alone would pass if the page stopped using it.

**Connection attention was a narrower list than the canonical mapping.** The
filter named `error` and `expired` only, so `configured` or `setup_required` —
ordinary outcomes of `assessConnections` — left both connection-backed rooms
quiet and reported "Needing attention: 0". `CONNECTION_STATE_TONE` already
classifies both as warnings.

The part worth recording: **that mapping's docstring exists because this exact
defect was caught once before**, on another surface, and says so — "a
half-finished integration raised a flag in one place and left the floor reading
Quiet". I wrote a narrower list beside the constant created to prevent it. The
count and the row chip now both derive from the mapping, so a row and a count
cannot disagree about one integration, and a test asserts both directions so this
cannot become "always attention".

Evidence at this commit: headquarter 1931, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS.

### Stage 4, after round 16 — the duplication I had only offered to fix

On the round-16 thread I noted that "Proven reachable" still wrote out
`connected || local_only`, duplicating `LIT_CONNECTION_STATES` in the spatial
floor's presentation layer, and offered to move it *if the reviewer agreed*.

That was the wrong shape of answer. Two lists agreeing by luck is the same
restatement pattern as the finding directly above it in the same round, and this
branch has now been taught "derive, do not restate" seven times. Offering to fix
it is not fixing it.

`LIT_CONNECTION_STATES` now lives in `live/connections.ts` beside
`CONNECTION_STATE_TONE` — where that mapping's docstring already referred to it —
and both the spatial floor and the client read the one list. The floor re-exports
it so its existing importers are untouched.

**The control worth recording, because my first one proved nothing.** Changing
the constant and re-running made the client test pass: expectation and behaviour
both derive from the constant, so they moved together. That is a tautology, not
evidence. The control that means something is re-hardcoding the client while the
constant differs — then it fails, by name:

    local_only: expected 1 to be +0

The spatial floor's own test fails under the constant change alone, which is what
shows the floor follows it too.

Evidence at this commit: headquarter 1932, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); `tsc --noEmit` clean in headquarter, hq-host, server and
web; web bundle unchanged at 215.66 kB / 69.22 kB gzip; `evidence:webgl` PASS.

### Stage 4, after round 16 — sweeping for tautological tests

In the round-17 request I asked Codex where else on this branch a test derives its
expectation from the same source as the behaviour it checks, having nearly filed
exactly such a test as evidence. Asking without looking would have been the same
error one level up, so the sweep was done.

**No worthless tautology found.** Three tests do share a source between
expectation and behaviour, and all three are sound for what they claim — but each
claims less than its name suggests, so the limit is now written beside it:

- **`LIT_CONNECTION_STATES`** (reachability): proves the client still FOLLOWS the
  canonical list, not that the list is right. Changing the constant moves both
  sides together and proves nothing; the control that means something is
  re-hardcoding the consumer while the constant differs.
- **`SOURCE_MODE_LABELS`** (provenance vocabulary drift): identical shape. It
  catches a runtime that has stopped deriving and gone back to a copy, which is
  what it exists for.
- **`CLIENT_FETCH_TARGETS`** (fetch allow-list): exported by the same module that
  writes the fetches, so it proves the page reaches nothing the runtime has not
  DECLARED — not that the declared set is right. Adding a path to both would
  pass. That is the intended semantics of an allow-list, and the same test's
  independent half — no absolute URL, no write route — is not derived from the
  constant.

The general lesson, since this branch keeps producing it in new costumes: a test
whose expectation shares a source with the behaviour is invisible when it is
worthless, because it is always green. The only way to tell the useful ones from
the hollow ones is to name what breaking each side would do — which is what a
negative control is, and why "I ran a control" is not the same claim as "I ran a
control that could have failed".

Evidence at this commit: headquarter 1932, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); no behaviour changed — comments only.

### Codex round 17 — the sweep's own subject was one of its blind spots (`45bfac4`)

Two findings, both real, both fixed. They are one defect in two places: an
enforcement narrower than the invariant behind it — the seventh round on this
branch to produce that shape.

**The reachability test.** One commit earlier I swept every test that shares a
source with its subject and recorded three of them as "sound for what they
claim". The reachability test was the first on that list. Codex read the same
test and found what the sweep did not: it covered five of the eight
`ConnectionState`s, so `not_connected`, `expired` and `setup_required` were
never asked about at all. Re-hardcoding the client to light any of those three
stayed green, and a ninth state needed no test change. The limit I wrote beside
it was accurate about the *derivation* and silent about the *coverage*, which
made it read as a smaller problem than it was.

It is now a literal `Record<ConnectionState, boolean>` judgement, written
independently of `LIT_CONNECTION_STATES`, with a second test holding the
constant to it. `Record` closes the new-state hole at the type level: adding a
state fails `tsc` on the test file until someone decides, there, whether it may
be drawn reachable.

**The attention hint.** "Needing attention" started counting every state
`CONNECTION_STATE_TONE` warns on — a round-16 fix — while its hint went on
saying "Reported error or expired credential". So a `configured` integration
made HQ report 1 needing attention and explain that 1 as a failure. On a page
whose single claim is that it never asserts more than canonical state supports,
that is the worst direction to be wrong in. Hint and filter now read one derived
list.

**Controls that could fail** (the distinction the previous commit named and this
round shows I applied incompletely):

- client re-hardcoded to light `setup_required` → `expected 1 to be +0`
- `LIT_CONNECTION_STATES` widened to `dispatchable` → *both* tests fail, so the
  expectation is independent of the constant rather than derived from it
- old hint text restored → `configured (warn): expected false to be true`
- a ninth `ConnectionState` added → `tsc` fails at `client-hydration.test.ts:766`

**The lesson, stated plainly.** I audited these tests for the wrong property. I
asked "does the expectation derive from the behaviour" and answered it
correctly; I did not ask "does it cover the whole domain", and that was the live
defect. A guard written to close one class of gap is not evidence about a class
it was not looking for — and saying "no worthless tautology found" invited a
reader to believe the sweep had checked more than it had.

Evidence at this commit: headquarter 1934, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); four typechecks clean; `npm run build`; `build:site`;
`evidence:webgl` PASS (warm 5119 lit / 0 dark, frames 33 / 0 / 32, 17 rooms
still present after context loss).

### Codex round 18 — three over-claims, one of them in the page's own chrome (`dda08a9`)

Three findings, all real, all fixed.

1. **The immersive page wore the bundle's provenance.** It forwarded `data.note`
   and `data.sourceMode` into the shell, so a site built from a sample bundle
   printed a SAMPLE chip and the bundle's caveat at the top of a page whose
   runtime stamps the live document it just read as `provenance live`. Two
   provenance claims about one page, one of them about data the page does not
   hold. The comment directly above the call said "It takes NO bundle data on
   purpose" — I wrote that comment and then passed two pieces of bundle data on
   the next line. The parameters are gone; the page now states its own truth.

2. **Analytics named four sources for five numbers.** It displayed
   "Integrations known" from `state.connections.data` and counted those rows
   toward its liveness, while its binding source omitted connections. The
   unnamed section could light the room.

3. **Tone was validated as text only.** A version-skewed document carrying
   `tone: 'critical'` rendered `class="kpi tone-critical"` — a rule the
   stylesheet does not have — so the metric kept its number and lost its
   colour, on a page still stamped as current. Liveness and provenance mode
   were already checked against closed sets; tone was the third and was not.
   `RoomTone` and `RoomLiveness` are now `as const` tuples with the types
   derived from them, and the runtime's sets are emitted from those tuples. The
   liveness list had been typed out by hand and happened to be right — a
   passing restatement, which is exactly the shape this branch keeps punishing.

**The guard for finding 2 is behavioural, not textual.** Asserting the corrected
sentence would say nothing about the next section someone wires in, so the test
populates one state section at a time, checks whether the room's rendered output
moves, and requires the room's provenance to name any section that moved it. It
flagged a second room on its first run — the Security Center, which reads
connection auth mechanisms and says so in prose rather than by key. That is a
false positive of a too-literal matcher, not a defect, and the fix was to accept
stems: a source line is a sentence a Founder reads, and bending it toward field
names to satisfy a test would make the page worse.

**A seventh backtick-in-an-emitted-comment**, caught by `tsc` this time. The
class is now well past the point where discipline is the answer; noting it here
because the count is the argument for a lint rule if it happens again.

Evidence at this commit: headquarter 1936, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); four typechecks clean; `npm run build`; `build:site`;
`evidence:webgl` PASS.

### Codex round 19 — the build's clock on a page that reads HQ live (`b7ce153`)

Two findings; one was already fixed by the previous commit (row-chip tones —
`chipValid` calls `toneValid` as of `dda08a9`), one was new and real.

**The freshness poll.** Round 18 removed the bundle's provenance note and
source-mode chip from the immersive page. It did not remove the bundle
timestamp, and that is what `shell()` uses to install the `hq-snapshot.json`
poll — whose verdicts are `UPDATED — page not rebuilt`, `OFFLINE — build-time
data` and `SAMPLE — not live data`. Any of those could appear in the header
above rooms hydrated live from the control API: a stale-build warning over
current state. The chip beside it read `As of 2026-08-26T10:30:00Z`, because
`buildSite` passes the newest instant in the bundle — so this file's own
docstring, defending the timestamp as "about THIS RENDER", was wrong on its
face and had been since the first commit.

`renderImmersiveHq()` now takes nothing. `asOf` is optional on the shell, and
omitting it drops the as-of chip, the freshness chip, the "checking whether a
newer snapshot exists" line and the poll as one unit.

**Worth recording: I fixed this defect one layer at a time across two rounds.**
Round 18's finding was "bundle provenance on a live page", and I removed the two
parameters that were named in it. The timestamp was the same defect, in the same
call, and I did not ask what else in that call came from the bundle. Reading the
finding rather than the invariant behind it is the branch's recurring shape, and
this time it cost a round.

**A guard that skipped what it claimed to check.** While the as-of chip was
being removed, the "never conveys status by colour alone" test dropped to zero
matches on this page — its pattern required `class` to be the LAST attribute, so
every chip carrying another was silently skipped, including all seventeen
`data-hq-room-status` chips. It has been reporting coverage of a page it was
not checking. Widened, and controlled both ways: a labelless chip with an
attribute passes under the old pattern and fails under the new one.

Evidence at this commit: headquarter 1936, hq-host 206, hq-server 20, server 569
(3 pre-existing skips); four typechecks clean; `npm run build`; `build:site`;
`evidence:webgl` PASS.

### Stage 4 stands blocked on review capacity, not on code (`147a387`)

Round 20 could not run. Codex answered the request with *"You have reached your
Codex usage limits for code reviews."* That is the observation; the reset time is
not known and is not being guessed here — an earlier outage on this PR was
diagnosed by assertion rather than evidence, and the diagnosis was wrong within
ten minutes.

State at this head: JENIFY CI green on the exact SHA, every finding across
nineteen Codex rounds fixed, answered and resolved, no open review thread.
headquarter 1936, hq-host 206, hq-server 20, server 569 (3 pre-existing skips);
four typechecks clean; `npm run build`; `build:site`; `evidence:webgl` PASS.

**Stage 4 is deliberately NOT reported complete.** The loop ends at green
exact-head CI *and* a fresh review with no material findings. Half of that is
unavailable, and this branch has specific evidence that the half I have is not a
substitute for the half I do not: rounds 17, 18 and 19 each found real defects on
a head whose CI was green, and two of them found defects in guards I had audited
myself and recorded as sound. A test that under-enforces is invisible precisely
because it stays green, which is why my own assurance about test quality here
should count for less than the reviewer's.

Founder-gated and untouched: visual acceptance against the 17 reference images,
and the merge decision.

### Codex round 20 — the plan was calling Stage 4 done (`855dcc8`)

The quota cleared and the review ran on `26e92d9`. One finding, against the
commit immediately above this one.

`PHASE_2_FIRST_CLASS_PRODUCT_PLAN.md` had Stage 4's heading as **DONE** while
its own Progress block, six lines into the same file, said *"Stages 4–5 — not
started"*. So the entry I had just written recording Stage 4 as deliberately
incomplete was contradicted by the canonical plan — the document a Founder
consults to decide what is left to do — and contradicted in the direction that
presents an unmet gate as satisfied.

Neither line was right, and the honest status is neither. Stage 4 is implemented
and technically verified; it is **not accepted**, because Founder visual
acceptance against the `HQ-UI-3D` reference pack has not happened and cannot
happen in an automated session — those images are local to the Founder's
workstation and were never read by the implementation. Both places say that now,
and the heading states plainly that Stage 4 becomes DONE when a Founder records
acceptance, not when its tests pass.

**Guarded, because the class is worse than the instance.** The plan is a
markdown file: nothing compiled it, no test read it, and it had been carrying a
false completion claim with no check behind it. Of everything on this branch it
has the longest shelf life and the widest audience.
`test/phase-2-plan-status.test.ts` now requires the two status lines to agree
about DONE-ness per stage, asserts it found both lines for all six stages so it
cannot silently match nothing, and asserts its own negation handling directly —
a guard that read "becomes DONE when a Founder records acceptance" as a DONE
claim would push the honest wording out of the document to stay green.

**The pattern, one more time.** Every earlier round found a page asserting more
than canonical state supported. This one found the *plan* doing it, about the
work itself. The reviewer had to read a documentation file nobody was checking
to see it, which is the same lesson as rounds 15, 17 and 19: the enforcement was
narrower than the invariant, and the unenforced part is where the false claim
lived.

Evidence at this commit: headquarter 1939 (89 files), hq-host 206, hq-server 20,
server 569 (3 pre-existing skips); typechecks clean; `npm run build`.

### Stage 4 technically cleared at `029a9c3` — Founder acceptance is what remains

The Codex quota cleared and round 20 ran on `26e92d9`, finding the plan
contradiction recorded above. With that fixed, an independent substitute review
(ChatGPT, in the reviewer role the Founder authorized while Codex was
unavailable) covered the material browser/runtime surface — authenticated state
reads, access and lock fail-closed logic, whole-document validation,
stale-response and timeout handling, canonical room derivation, static-room
truth boundaries, provenance handling, the WebGL upload/motion/context-loss
lifecycle, and the real-browser evidence instrumentation — and found **no
additional material P0/P1/P2 defect**. A second pass over the documentation
delta found none either.

Verified here against the primary source rather than taken from the review
comment: JENIFY CI run **33923080697** completed **success** on head
`029a9c36ce9d477ff0edc9b44dc7faf2911209f7`.

**Twenty review rounds, and the shape of the branch in one line:** every round
found the same class of defect — an enforcement narrower than the invariant
behind it — and the last one found it in the plan document rather than in the
product. That is the artefact worth keeping from this work, more than any
individual fix.

**Stage 4 is technically verified and NOT accepted.** Founder visual acceptance
against the 17 approved HQ references cannot be performed by any automated
session — the references are local to the Founder's workstation and were never
read by this implementation, so nothing in the visual layer was verified against
them. Merge and deployment remain Founder-gated and untouched: PR #251 is open
and unmerged, `main` is unchanged, nothing was deployed or promoted, and no paid
service was enabled.

## Phase 3 — Founder Command + Mission Core (local Fable main-builder pass)

**2026-09-05.** Branch `local/phase-3-founder-command-mission-core` from accepted main
`9f98723` (issues #254 binding requirements, #255 local handoff — this lane is the sole
Phase 3 integrator; the dispatched cloud session on #254 is reference-only and nothing from
it was merged). Main builder: genuine Fable 5, stated per the model requirement.

**What was built.** The canonical Mission aggregate above tasks: 8-state lifecycle vocabulary
(`contracts/mission.ts`, structural map fixed, all transitions Founder-driven in this phase),
module-owned schema (`hq_missions`, append-only `hq_mission_intents`/`hq_mission_events`,
`hq_mission_plan_items`), the CONFIGURATION-vs-INVOCATION capability trio for
`hq.mission_command`, seven facade methods, four exact-match control routes through the
unchanged pipeline (hq-host adapter: zero changes, proven through a real Fastify instance),
the shared `missionBrowserView` projection feeding both the routes and the snapshot's new
missions section, the Mission Room rebound to real missions (semantic change recorded, the
bucket-agreement invariant replaced on record), a Command Room mission-decision metric on the
same status set, and two script-created consoles (Founder Command on index.html; mission
list/detail/lifecycle/amend on projects.html) under the emitted-markup-stays-inert rule.
Decisions recorded in `docs/JENIFY_DECISIONS.md` (2026-09-05): write-surface widening,
"mission" reconciliation, verified-as-recorded-Founder-decision, no step-up on mission writes
(revisit at Phase 4+), mission writes not kill-switch-gated, raw-order isolation.

**What is deliberately NOT here.** No orchestrator, no dynamic teams, no evidence engine, no
machine verification, no queue priority (claiming stays strictly FIFO — test-pinned), no
watchdog wiring, no pause/resume states. Zero missions renders as zero; later-phase
capability says later instead of being simulated.

**Local verification on the Founder workstation (Windows).** Focused suites all green:
mission-contracts 17, application.mission-core 36, live-mission-routes 21, mission-consoles 9
(JSDOM against the real control API), mission-durability 2, immersive-page 46 (three Phase 3
additions), client/snapshot suites 205 across the rebind, hq-host host-contract 19.
Known environmental caveats, identical on the unmodified base: 6 hq-host persistence tests
are POSIX-only (`/proc/self/mountinfo`, directory-fd fsync) and fail on Windows; the
hq-server hosted-restart mission rows are Linux-gated; occasional subprocess-timeout flakes
in codex-lane/routing suites under full-suite load pass in isolation. Ubuntu exact-head CI is
the authority for all of these. Full-matrix results and the exact frozen SHA are recorded in
the Phase 3 PR; merge remains gated on independent review and the Founder.
