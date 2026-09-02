# JENIFY HQ — Phase 2: separation into a first-class Jenify product

Status: **Stages 0 and 1 IMPLEMENTED (Founder-approved 2026-09-02). Stages 2–5 not started.**
Nothing is merged or deployed; no authentication, cookie or domain was touched.
Written 2026-09-02 against `main` = `197844a8d637622fa08c3bdce02159070965d738`
(Phase 1 LIVE HQ CONTROL V1, Founder-accepted at head `36809306`, tagged
`phase-1-accepted-36809306`).

> **Progress**
> - **Stage 0 — DONE.** `core-boundary.test.ts` + `host-port-contract.test.ts` (19 tests).
> - **Stage 1 — DONE.** `packages/hq-host` + `apps/hq-server` (24 tests). The server's
>   HQ route/host test files pass **unedited**.
> - **Stage 2 — BLOCKED on Founder Gate A** (§7). Not started.
> - **Stage 3 — absorbs open issue #227.** Not started.
> - **Stages 4–5 —** not started.

Targets this plan prepares for: `hq.jenifylabs.com`, a future Jenify HQ Desktop, and one core
shared by web and desktop. Official visual direction: the Drive `HQ-UI-3D` reference pack
(see `docs/JENIFY_DECISIONS.md`, entry of 2026-09-02).

---

## 1. What the inspection actually found

The headline is good news, and it changes the shape of this plan:

**JENIFY HQ is already an independent product hiding inside a monorepo.** It was built behind a
port boundary, and that boundary held.

| Question | Finding |
|---|---|
| Does HQ import any sibling workspace package? | **No.** Zero imports of `@factoryos/shared`, `server`, `web`, `config-mesob`. Only matches are prose in comments. |
| Does HQ escape its own directory by relative path? | **No.** No `../../../` imports. |
| What are HQ's real runtime dependencies? | `better-sqlite3` (one import, in `store/db.ts`), `uuid`, and Node builtins. That is all. |
| Does HQ read the tenant database or Drizzle schema? | **No.** It owns a separate SQLite database (`FACTORYOS_HQ_DB`) and explicitly refuses to touch `data/factoryos.sqlite`. |
| Is the UI tied to React/Vite? | **No.** The whole UI layer is pure string-in / HTML+SVG-string-out. No framework, no bundler, no DOM at build time. |
| Which way does the coupling point? | **One way only: `server` → `headquarter`.** HQ is the upstream library; the server is a host. |

Size of the product: **111 source files / ~31,400 lines**, plus **81 test files / 1752 tests**.

### The entire coupling surface

Four files and two manifest lines. Nothing else in the repo knows HQ exists.

| File | Lines | Role |
|---|---|---|
| `packages/server/src/services/headquarter-host.ts` | 201 | Reads `FACTORYOS_HQ_*` env, opens the HQ DB, builds the control plane |
| `packages/server/src/routes/headquarter.ts` | 303 | Fastify adapter: mounts `/api/hq/control/*` and the static site, supplies the ports |
| `packages/server/test/headquarter-control.test.ts` | 650 | Host-side control API tests |
| `packages/server/test/headquarter-host.test.ts` | 303 | Host-side wiring tests |
| `packages/server/package.json` | 1 line | `"@factoryos/headquarter": "*"` |
| `.github/workflows/ci.yml` | 3 steps | HQ tests, typecheck, site build |

**Consequence: the extraction is small. The hard part of Phase 2 is not moving code.**

### The one real dependency, and it is not code

HQ has **no identity of its own**. It has no user table, no password store, no session store.
It defines three ports and requires a host to implement them:

- `SessionResolverPort` — who is signed in (must re-check expiry and revocation every request)
- `CredentialVerifierPort` — password re-entry for step-up on `founder_gate` / `destructive`
- `ControlAuditPort` — the audit sink

Today `packages/server` implements all three over `fos_session`, `resolveSessionRecord`,
`verifyAccountPassword` and its rate limiter. This is not accidental — it is a recorded Founder
decision (`docs/JENIFY_DECISIONS.md`, 2026-08-28): *"Headquarter grows no second password
system."* The code states the constraint plainly:

> A browser only sends `fos_session` to the host that set it, so the only place the decision can
> actually be implemented is inside this server.

**`fos_session` is a host-only cookie** — `sameSite: 'lax'`, `secure` off loopback, and **no
`Domain` attribute**. A browser will therefore not send it to `hq.jenifylabs.com` if the session
was set by a different host. This is the single blocking issue for the stated Phase 2 target,
and it is a Founder product decision, not an engineering choice. See §7, Gate A.

### The 3D layer already has honest foundations

`src/ui/spatial/` already exists — 5 modules, ~90 KB: `world.ts` (pure floor-plan geometry),
`scene.ts` (deterministic isometric SVG renderer), `state.ts` (the honesty boundary),
`theme.ts`, `page.ts`. Its rules already match the Drive direction's binding requirement that
3D represent real state: deny by default, every live-looking thing carries its evidence, nothing
invented. `state.ts` is reusable as-is.

What it is *not* yet: interactive. Today it is server-rendered static SVG. The Drive direction
asks for camera travel between spaces and scroll/click viewpoint movement — that needs a client
runtime, which HQ does not have. That is a genuine new capability, not a restyle. Plan for it
as such (§4, Stage 4).

---

## 2. Target structure

### Naming: do not rename the packages yet

`CLAUDE.md` states: *"Internal `factoryos` identifiers are legacy-stable — do not rename them;
public branding is JENIFY OS."* Renaming `@factoryos/headquarter` → `@jenify/hq-core` would
touch every import in the 4 coupling files and their tests, produce a large diff that hides real
changes, and buys nothing a public brand surface cannot deliver. **Keep internal identifiers.
Brand the product at its public surface** (site title, domain, desktop app name). Revisit only
at the repo split, where a rename is nearly free.

### Recommended target (Phase 2 end state, still one repo)

```
packages/
  headquarter/          @factoryos/headquarter    ← UNCHANGED. The product core.
  hq-host/              @factoryos/hq-host        ← NEW. HQ's own HTTP host.
  hq-client/            @factoryos/hq-client      ← NEW, Stage 4. Browser runtime + 3D layer.
  shared/  server/  web/  config-mesob/           ← UNCHANGED JENIFY OS platform.
apps/
  hq-server/                                      ← NEW. Thin standalone binary: boots hq-host.
```

Desktop is **Phase 3**, not Phase 2. When it comes it is another consumer of the same core:

```
apps/hq-desktop/    (Tauri or Electron shell) → packages/hq-client → packages/headquarter
```

### The shared-core boundary

This already exists and should simply be made explicit and enforced:

- **Core (shared by web and desktop):** `packages/headquarter` — contracts, operator, store,
  application, routing, providers, live, archive, ui. Pure TypeScript + SQLite + Node builtins.
- **Host (web only):** `packages/hq-host` — HTTP, cookies, origins, static serving.
- **Client (shared by web and desktop):** `packages/hq-client` — the browser/3D runtime.
- **Shell (per platform):** `apps/hq-server`, later `apps/hq-desktop`.

Rule to enforce in CI: **`packages/headquarter` may never import from `hq-host`, `hq-client`, or
any JENIFY OS package.** A test asserting that is cheap and pins the whole architecture.

---

## 3. Dependency map

```
                    ┌─────────────────────────────────┐
                    │   packages/headquarter (CORE)   │
                    │   111 files · 31.4k lines       │
                    │   deps: better-sqlite3, uuid    │
                    │   imports NO sibling package    │
                    └───────────────┬─────────────────┘
                       exports: /contracts /operator /store /archive
                       /connectors /ui /organization /memory /handover
                       /registry /providers /application /routing /live
                                    │
              ┌─────────────────────┼──────────────────────┐
              │                     │                      │
     ┌────────┴────────┐   ┌────────┴─────────┐   ┌────────┴────────┐
     │ packages/server │   │ packages/hq-host │   │ packages/hq-    │
     │  (TODAY'S HOST) │   │  (NEW, Stage 1)  │   │ client (Stage 4)│
     │ routes/hq.ts    │   │ same ports, no   │   │ browser + 3D    │
     │ services/hq-    │   │ tenant platform  │   └─────────────────┘
     │ host.ts         │   └────────┬─────────┘
     └────────┬────────┘            │
              │                     │
       supplies 3 ports      needs the SAME 3 ports
       over fos_session      ─── FOUNDER GATE A ───
              │              identity for a standalone origin
     ┌────────┴──────────────────────┐
     │ server/services/auth.ts       │  resolveSessionRecord
     │ server/services/ratelimit.ts  │  verifyAccountPassword
     │ server/app.ts                 │  SESSION_COOKIE (host-only)
     └───────────────────────────────┘
```

**What must move:** only the host adapter — `services/headquarter-host.ts` + `routes/headquarter.ts`
and their two test files (~1,457 lines total). That is the whole "extraction".

**What must stay shared (for now):** identity. Until Gate A is decided, the concrete session and
credential implementations stay in `packages/server` and `hq-host` consumes them through the
existing ports.

**What must not move:** `packages/headquarter` itself. It is already correct. Moving it produces
a huge diff, breaks every import, and gains nothing.

---

## 4. Migration order

Every stage ends with a green build. Every stage is independently revertible. No stage begins
before the previous one is green on `main`.

### Stage 0 — Baseline and contract pinning (no files move) — **DONE**

Delivered as planned. `phase-1-accepted-36809306` tagged; `core-boundary.test.ts` (6) pins that
the core imports no sibling package, escapes its directory by no relative path, and confines
`better-sqlite3` to `store/db.ts`; `host-port-contract.test.ts` (13) states the six host
obligations framework-free. One finding worth carrying forward: `/session` answers an
unauthenticated caller with **401 AND `ok: true`** plus `authenticated: false`, because it is the
probe a page uses to discover its own state — a host must preserve that shape rather than
flattening it into a generic error.
- Tag the accepted head: `phase-1-accepted-36809306`.
- Add `packages/headquarter/test/core-boundary.test.ts`: asserts the core imports no sibling
  package and no relative path escapes its directory. Pins the architecture before it is stressed.
- Add a **host port contract test**: the exact shape `ControlApiDeps` requires, asserted
  independently of Fastify, so any host (server, hq-host, desktop) is verified against one
  contract rather than against the server's implementation.
- Record the behaviour baseline: 1752 HQ + 483 server tests, and the 8 proven Phase 1 behaviours
  (§5) as a written checklist.
- **Risk: none. Nothing moves. Fully revertible.**

### Stage 1 — Give HQ its own host (`packages/hq-host` + `apps/hq-server`) — **DONE**

Delivered as planned, and smaller than feared. `packages/hq-host` is the old
`routes/headquarter.ts` with the two identity adapters lifted out behind `HqIdentityPort`; the
config loader moved verbatim (it never had a server dependency). `packages/server` keeps the
identical exported signatures, so `buildApp` and both host test files — 953 lines, 41 tests —
pass **unedited**. `apps/hq-server` boots HQ with no tenant platform in the process at all.

One addition beyond the move: `HeadquarterHost` now returns the opened database, so a host can
close it. The long-lived server never needed that; a standalone process does.

`apps/hq-server` ships **no identity source**, so it serves and refuses everything with 401 and
says so at boot. That is Gate A's honest shape, and a test asserts no `/login`-style route was
invented to paper over it.
- Move the two server files into `hq-host`, parameterised over the three ports.
- `packages/server` keeps a **thin re-export** so its routes, tests and env contract are
  byte-compatible. Nothing about the tenant platform changes.
- `apps/hq-server` boots HQ alone, on its own port, against `FACTORYOS_HQ_DB`.
- Identity in this stage is still the server's: `apps/hq-server` runs in the same process as, or
  behind, the existing auth. **No new origin yet, so no cookie problem yet.**
- **Proves: HQ can boot without the tenant platform.** This is the extraction, and it is small.

### Stage 2 — FOUNDER GATE A: identity for a standalone origin (§7)
No code until decided. Then implement the chosen option and its regression tests.

**Gate A was decided A-4 on 2026-09-02** (shared Jenify identity, separate host-only HQ
session) and Stage 2 was implemented on `claude/phase-2-hq-first-class-prep` (PR #236).
Exact-head CI was green on `ef12d0d`, and an independent Codex review of that same head found
**four P1 security/correctness defects**. All four were treated as blockers and fixed in a
correction round (issue #237), each with hostile tests that fail against the code they correct:

1. **A redeemed ticket is bound to its own round trip.** HQ's callback checked `state` against
   its own cookie but then redeemed the ticket alone, so a ticket captured out of a URL could
   be replayed from an attacker's browser, whose own state cookie matched their own callback.
   The redeem call now carries the callback state, and the identity host compares it to the
   state stored with the ticket before consuming it. (Trap D in `hq-host/src/sso/contract.ts`.)
2. **A ticket does not outlive its session.** Signing out between authorize and redeem left an
   unconsumed ticket that could still mint a NEW HQ session for the rest of its TTL, because no
   derived HQ session existed yet for logout propagation to revoke. Closed at both ends:
   sign-out invalidates that session's outstanding tickets in the same transaction that revokes
   it, and redemption independently re-checks that the origin session is still live (which also
   covers expiry, admin revocation and a deactivated account). (Trap E.)
3. **The shipped identity process actually carries the bridge.** `buildApp` accepted an `ssoHq`
   plane and `apps/hq-server` called the identity endpoints, but `packages/server/src/index.ts`
   never built one — only tests did — so the two real processes could not complete a handoff at
   all. The composition is now `packages/server/src/compose.ts`, configured fail-closed from
   `FACTORYOS_SSO_HQ*` by `services/sso-hq-host.ts`, with the entrypoint's own seam under test.
4. **The back channel may not be cleartext.** `HQ_SSO_IDENTITY_ORIGIN` accepted plaintext
   `http://` to any host, which would have sent the service credential and the relayed Founder
   step-up password in the clear. HTTPS is now required except to a genuine loopback address,
   enforced in `hq-host/src/sso/origin.ts`, in both environment loaders, and at
   `httpBackChannel` construction so no future wiring can bypass it.

No production deployment, DNS change, paid service or production credential was involved, and
Stage 3 has not been started.

### Stage 3 — Durable hosted persistence
Already scoped by open issue **#227** (Founder-approved 2026-08-30). Do not duplicate that
mission — Phase 2 should *absorb* it. Requirement stands: preserve atomicity, idempotency,
fencing, approval-digest binding, dispatch evidence and audit history; do not rely on ephemeral
serverless filesystem state; provider-neutral code and tests first, then stop at the Founder gate
for any paid/irreversible service choice.

### Stage 4 — Client runtime and the 3D experience layer (`packages/hq-client`)
- New package; the static server-rendered site **remains the fallback and stays truthful**.
- Reuse `ui/spatial/state.ts` unchanged as the honesty boundary — 3D shows real state or nothing.
- Feature-flagged. The Drive concept images are references, not specs.
- Keep the existing enforced invariants (§5) — they must survive into any client runtime.

### Stage 5 — FOUNDER GATE B: repo split, only if still wanted (§6)
If taken, use `git subtree split` to preserve history, never a copy-paste of files.

### Phase 3 — Desktop
`apps/hq-desktop` over the same core and client. Not Phase 2.

---

## 5. Tests required

**Nothing ships until the Phase 1 behaviour set still passes.** These are the eight behaviours
the Founder accepted; each already has coverage, and each must be re-proved after every stage:

1. Browser Direct Order creates a canonical task.
2. Distinct Founder approval; no-self-approval holds.
3. Password step-up for `founder_gate` / `destructive`; denial never step-up-gated.
4. Worker eligibility / `--check-only` truth, with no state mutation.
5. Real dispatch with no provider substitution.
6. Durable duplicate / re-trigger refusal.
7. Legitimate result ingest and correlation.
8. Truthful live snapshot, Connection Center freshness, and route truth that does not depend on
   who is looking (the issue #230 finding).

Plus the invariants already enforced and easy to lose in a move:

- **Site-wide script invariants** (`control-console.test.ts`): no `innerHTML` / `outerHTML` /
  `insertAdjacentHTML` / `document.write`; fetch targets allow-listed; no `<form>`, `<button>`
  or inline `on*=` in static HTML.
- **Responsive/accessibility invariants** (`ui-responsive.test.ts`): no fixed pixel width above
  the narrowest viewport; mobile-first media queries only; motion off under
  `prefers-reduced-motion`.
- **Spatial honesty** (`spatial-truth.test.ts`): deny by default; evidence for every live-looking
  thing; nothing invented.
- **Approval semantics**: digest binding, single-use nonce, claim fencing, provider binding,
  stale approvals immutable as audit evidence.

New tests this plan requires:

| Stage | Test |
|---|---|
| 0 | Core boundary — no sibling imports, no path escapes |
| 0 | Host port contract — framework-independent `ControlApiDeps` shape |
| 1 | `apps/hq-server` boots and serves HQ with the tenant platform absent |
| 1 | `packages/server`'s HQ routes unchanged (existing 953 lines must pass untouched) |
| 1 | Mesob regression: full server suite green, HQ off by default |
| 2 | Identity: cross-origin refusal, cookie scope, CSRF/origin allow-list, step-up preserved |
| 3 | Persistence: atomicity, idempotency, fencing, audit history under the new adapter |
| 4 | 3D shows no state the canonical data does not support; static fallback still truthful |

Gate for every stage: HQ suite green, server suite green, all typechecks clean, web bundle
within budget (215.66 kB / 69.22 kB gzip), **exact-head CI green** — never a local claim alone.

---

## 6. Own repo now, or top-level product inside this repo first?

**Recommendation: top-level product inside the current repo first. Split later, at Gate B, and
only if still wanted.**

Reasons:

1. **Identity is unresolved.** Splitting repos before Gate A forces the worst outcome: either
   duplicate the auth system (which a standing Founder decision forbids) or build cross-origin
   SSO under split-repo pressure. Decide identity first; the repo boundary is downstream of it.
2. **CI currently proves the seam.** One pipeline runs HQ's 1752 tests and the server's 483
   together, so a drift between HQ's ports and the server's adapter fails immediately. Splitting
   now removes exactly the check that protects the most fragile surface, and replaces it with
   version-pinning and cross-repo coordination.
3. **The package boundary already exists.** npm workspaces plus the `exports` map already give
   HQ a hard interface, and the inspection proves the core respects it. A repo split would add
   process, not architecture.
4. **Reversibility.** Promoting in-repo is trivially revertible. A repo split is not, and
   `git subtree split` done later loses nothing — history is preserved whenever it is taken.
5. **#227 is in flight.** Hosted HQ will substantially change persistence and auth. Splitting
   mid-flight doubles coordination cost for no benefit.
6. **It matches the Founder's own constraint** — avoid unnecessary rewrites.

Nothing in the Phase 2 targets requires a separate repo. `hq.jenifylabs.com` needs a host and a
DNS record, not a repository. Desktop needs a shell package. Both work in-repo.

**Split when these are all true:** Gate A decided and implemented; hosted HQ running and stable;
HQ release cadence genuinely diverging from JENIFY OS; and someone other than the Founder needs
repo access to one but not the other.

---

## 7. Founder gates, risks and blockers

### GATE A — Identity for a standalone origin *(blocking for `hq.jenifylabs.com`)*

`fos_session` is host-only. HQ at a different host cannot see it. Three options:

| | Option | What it costs | Security note |
|---|---|---|---|
| **A-1** | **Same origin.** Serve HQ under the existing app's origin (e.g. `/hq`). | Cheapest. Zero auth change. Preserves the 2026-08-28 decision exactly. | Strongest. Nothing widens. |
| **A-2** *(recommended)* | **Parent-domain cookie.** App at `app.jenifylabs.com`, HQ at `hq.jenifylabs.com`, cookie `Domain=.jenifylabs.com`. | Small, contained change to cookie issuance + origin allow-list. Gives the Founder the requested hostname and one password system. | Cookie becomes visible to **every** `jenifylabs.com` subdomain. Acceptable only if all subdomains are trusted and the allow-list (`FACTORYOS_HQ_ALLOWED_ORIGINS`) stays strict. Must be a deliberate decision. |
| **A-3** | **HQ gets its own identity provider.** | Most work; **contradicts the standing 2026-08-28 decision** and needs it formally amended. | A second credential system is a second thing to get wrong. |

Recommend **A-2**, with **A-1** as the fallback if any untrusted subdomain will ever exist.
This is a Founder decision and I have not made it.

### GATE B — Repo split (§6). Recommended: defer.

### Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Cookie/identity choice made implicitly by a deploy rather than deliberately | **High** | Gate A before any hosting work. Written decision in `JENIFY_DECISIONS.md` first. |
| Host extraction silently drifts from HQ's ports | High | Stage 0 port contract test; server keeps a thin re-export in Stage 1; both suites stay in one CI. |
| `better-sqlite3` is a native module | Medium | Blocks serverless hosting (already flagged in #227) and complicates desktop packaging. Resolve in Stage 3 behind the store interface, not ad hoc. |
| The 3D layer starts showing invented state | Medium | `ui/spatial/state.ts` is the only state authority; `spatial-truth.test.ts` must gate every 3D change. The Drive notes make this binding too. |
| Mesob pilot disturbed by HQ work | Medium | HQ is opt-in (`FACTORYOS_HQ_CONTROL=1`); default-off behaviour is already tested. Full server suite is a gate at every stage. Never touch `data/factoryos.sqlite`. |
| Renaming packages for branding creates churn that hides real changes | Low | Keep internal `factoryos` identifiers (CLAUDE.md rule). Brand the public surface only. |
| Issue #227 and Phase 2 diverge into two competing plans | Medium | Absorb #227 as Stage 3 rather than running it separately. |

### Non-blocking open items

- Issues #230 and #231 remain open; #231 has a task deliberately left `running`.
- Nothing in Phase 2 requires paid services. Any hosting, DNS or external database that does is a
  separate explicit Founder gate (CLAUDE.md rule 7).

---

## 8. Verdict

**READY TO START PHASE 2 IMPLEMENTATION — Stage 0 and Stage 1 only.**

Ready because: the core is already independent and proven (1752 tests); the coupling is four
files pointing one way; the extraction is small and mechanically safe; and Stages 0–1 move no
product code, need no Founder decision, touch no credential, and are fully revertible.

**NOT READY for Stages 2–5.** Stage 2 is blocked on **Gate A** — a real Founder product decision
about identity and origin that cannot be inferred from the code, and which the standing
2026-08-28 decision constrains. Stage 3 must absorb open issue #227 rather than duplicate it.
Stage 5 should be deferred until Gate A is implemented and hosted HQ is stable.
