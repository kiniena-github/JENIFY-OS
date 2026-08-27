# AI Member Registry + Capability Registry (issue #119)

Package: `packages/headquarter` (`@factoryos/headquarter`), new subpackages
`src/registry/` and `src/providers/`. Provider-neutral by construction: no
vendor SDK, credential, or vendor-specific type appears anywhere in
`src/registry/` — every dependency on "who the AI worker is" goes through
`src/providers/directory.ts` and the plain-data contracts in
`src/providers/contracts.ts`.

## Why a second registry, not an extension of the Universal Operator's

`operator/capabilities.ts` already has a `CapabilityRegistry` and a
`RISK_CLASSES` vocabulary — but it governs named, typed **actions** a task
queue dispatches (`github.open_pr`, `archive.index_document`). This feature
answers a different, upstream question: **which AI workers (members) exist,
which real provider/model each one actually is, and which broad domains of
work (coding, image generation, browser/computer use, ...) each is trusted
to be routed at all.** A member holding the `coding` domain capability does
not bypass the operator's own deny-by-default checks for any specific
action — the two registries compose, they don't replace each other.

`MEMBER_RISK_CLASSES` intentionally reuses the same five string values as
the operator's `RISK_CLASSES` so risk language reads consistently everywhere
a Founder looks, but it is declared independently in
`registry/capabilities.ts` rather than imported, per the issue's scope rule
(this feature must not reach into `operator/` internals).

## Data model

### `hq_member_capabilities` (`registry/capabilities.ts`)

One row per capability **domain instance** a Founder/registrar has defined
as grantable at all: `id`, `domain` (one of the 14
`MEMBER_CAPABILITY_DOMAINS`), `description`, `riskClass`, `enabled`.
Registering with an unknown domain or risk class throws — this table is the
one place new domains get added, and it's a short, closed, typed list:
`coding`, `research`, `design`, `browser_computer_use`, `documents`,
`image`, `video`, `audio`, `reasoning`, `retrieval`, `connectors`,
`local_execution`, `translation`, `data_analysis`.

### `hq_ai_members` (`registry/members.ts`)

One row per AI worker instance. Key fields:

- **Identity**: `providerId` + `modelId` + `modelVersion`, combined into a
  stored `identityKey` (`provider:model:version`) computed once at
  registration and **immutable forever after** — see "Identity binding"
  below.
- **Advertised vs. granted capabilities** — the core security property of
  this feature (see next section).
- **Lifecycle**: `status` (`active` / `disabled` / `removed` / `replaced`),
  `enabled` (a simple on/off), `health` (`unknown` / `healthy` / `degraded`
  / `unavailable`) + `healthCheckedAt`.
- **Routing inputs**: `locality`, `privacyClass`, `costClass`,
  `contextWindowTokens`, `roleEligibility`, `benchmarks`.
- `toolMetadata` — an opaque JSON bag for anything provider-specific that
  isn't worth its own column (never used by permission checks or routing).

### `hq_ai_member_history` (append-only)

Every lifecycle event (`registered`, `updated`, `disabled`, `removed`,
`replaced`, `replaced_predecessor`, `assigned`, `assignment_completed`,
`role_eligibility_set`, `benchmark_recorded`, `health_updated`,
`identity_verification_failed`, ...) as one row: `memberId`, `at`, `event`,
`detail` (JSON), `actor`. **No row is ever updated or deleted.** This is the
audit trail a Founder (or a future review) can always replay.

### `hq_ai_member_assignments`

One row per unit of work handed to a member: `id`, `memberId`, `taskRef`,
`status` (`active` / `completed` / `handover_pending`), `assignedAt`,
`endedAt`. Workload is **derived**, never stored — `workloadOf(memberId)`
counts `status = 'active'` rows on read.

### `hq_member_roles`

Named role requirement definitions: `roleId`, `requiredCapabilities` (JSON
array of capability ids), `description`. A member's `roleEligibility` may
only ever include a role whose `requiredCapabilities` is a subset of that
member's own `grantedCapabilities` — enforced by `setRoleEligibility`.

All four tables are created by `registry/db.ts`'s `ensureRegistrySchema(db)`
— its own DDL, run against the existing `HqDatabase` from `store/db.ts`
without editing that file. Idempotent: safe to call on every registry
construction and repeatedly in tests.

## Security properties

### 1. Advertised vs. granted (the core rule)

Every member carries two capability lists:

- `advertisedCapabilities` — what the provider/vendor's own metadata claims
  the model can do. **Untrusted input.** Nothing in `providers/contracts.ts`
  or `providers/known.ts` is a grant of anything.
- `grantedCapabilities` — what a registrar explicitly granted, validated
  against `hq_member_capabilities` at grant time.

**Every permission check and all of `registry/routing.ts` reads
`grantedCapabilities` only.** A member that advertises `image` generation
but was never granted `image` is excluded from any request that requires
`image` — this is directly tested (`registry-routing.test.ts`, "scenario
5"). Granting a capability the member does not advertise is allowed (a
registrar may have manually verified an extra skill) but returns a warning
string; granting an unregistered or disabled capability throws outright.

### 2. Identity binding

`(providerId, modelId, modelVersion)` is fixed at `register()` and
`identityKey` is computed once. `update()` inspects the raw patch object and
throws immediately if it contains `id`, `providerId`, `modelId`,
`modelVersion`, or `identityKey` — a display-name relabel can never touch
identity. `verifyIdentity(memberId, claimed)` compares a claimed identity
against the member's registered `identityKey` and must be checked before
dispatch; a mismatch is treated as a possible impersonation attempt, is
recorded as an `identity_verification_failed` history event, and reports
not-ok with a reason.

### 3. No hard delete, anywhere

`disable()` and `remove()` only change `status` (and `enabled`). The row,
its full `hq_ai_member_history`, and its `hq_ai_member_assignments` rows are
preserved forever. There is no delete method on `AiMemberRegistry` for
members, history, or assignments — by design, not by omission.

### 4. Deny by default for dispatch

`assign()` refuses any member that is not `status: 'active'` and `enabled`,
or whose `health` is `'unavailable'`. `disable()` immediately excludes the
member from both `assign()` and `rankMembers()` and flips its currently
`active` assignments to `handover_pending`, returning the list so nothing
silently goes unattended.

### 5. Routing never escalates permissions

`registry/routing.ts`'s `rankMembers()` is a **pure function** — no
database access, no side effects, `now` passed in explicitly for
determinism. It selects among already-granted members only: a member
missing the required granted capability is a hard exclusion
(`capability-mismatch`), never a low score. There is no code path in this
file that writes to `grantedCapabilities` or any other permission state —
routing can rank, it can never grant.

Hard filters (excluded, never ranked): not `enabled`/`active`, health
`unavailable`, capability mismatch, privacy class below the requested
floor, `local_only` policy violated by a cloud member, cost class above the
requested maximum, not eligible for the requested role.

Scoring (transparent, additive, every contribution has a reason string):
best matching benchmark evidence (a benchmark older than
`benchmarkMaxAgeDays`, default 90, contributes zero and says so), lower
workload preferred, lower cost class preferred, `prefer_local` boosts local
members over otherwise-equal cloud ones.

## Provider layer (`src/providers/`)

- `contracts.ts` — `ProviderDescriptor`, `ProviderModelInfo`,
  `ProviderAdapter` (`probeHealth`, `attest`). **No credential fields
  anywhere in this file** — auth lives entirely outside this layer, in
  whatever execution worker actually talks to the vendor. Advertised data is
  explicitly documented as untrusted input.
- `directory.ts` — `ProviderDirectory`, an in-memory
  register/get/has/list map. Business logic in `registry/` depends only on
  this directory + the contracts, never on a concrete vendor SDK. An unknown
  provider lookup returns `null`; registering a member against an unknown
  provider throws.
- `known.ts` — **data-only** seed descriptors for `openai`, `anthropic`,
  `google`, `microsoft`, `xai`, `meta-llama`, `qwen`, `deepseek`, `mistral`,
  `kimi`, `local-custom`, and `jenify-ai` (marked `kind: 'local'`, commented
  as future/planned — Jenify's own in-house model, not yet built). These
  seeds are informational only: registering one grants nothing, and each
  carries conservative, generic `advertisedCapabilities`.
- `mock.ts` — `createMockAdapter()`, a synthetic `ProviderAdapter` for tests
  and for any provider without a live probe yet. No network access.

## How to add a new provider

1. Add a `ProviderDescriptor` (real one, or extend `known.ts` for a seed) —
   `providerId`, `displayName`, `kind`, and its `advertisedModels`. No
   business logic, no credentials.
2. Implement (or reuse `createMockAdapter` for now) a `ProviderAdapter`:
   `probeHealth` and `attest`. Real network calls, if any, live entirely
   inside this adapter — never in `registry/`.
3. `providerDirectory.register(adapter)`.
4. Register whatever capability domains that provider's models should be
   trusted with in `MemberCapabilityRegistry`, if not already present.
5. `AiMemberRegistry.register({ providerId, modelId, modelVersion, ... })` —
   this is the point where a Founder/registrar explicitly grants
   capabilities; nothing upstream of this step ever does.

No file under `src/registry/` needs to change for any of this — that's the
point of the directory/contracts seam.

## No-vendor-lock-in guarantee (`registry/serialization.ts`)

`exportRegistry(db)` produces a plain JSON snapshot — `{ schemaVersion: 1,
capabilities, roles, members }` — using only the neutral fields described
above. `AiMember` itself already stores just a `providerId` string plus
plain data, never a live adapter object, so nothing vendor-specific can leak
into the snapshot.

`importRegistry(db, snapshot, { providerDirectory })` re-validates every
item — capability domain/risk class, role capability references, member
identity-key consistency, member provider existence in the target
directory, member capability references, and member id collisions in the
target database — and is **deliberately all-or-nothing**: any validation
failure returns the complete list of per-item errors and writes nothing.
This was chosen over a partial import because a partially-imported registry
would be a state that matches neither the source snapshot nor a clean
target, which is a worse debugging position than a clean rejection with a
full error list.

## Rollback note

This feature is purely additive: two new subpackages
(`src/registry/`, `src/providers/`), four new SQLite tables (via their own
DDL in `registry/db.ts`, never touching `store/db.ts`), two new export
entries in `package.json`, and two new export lines in `src/index.ts`. To
roll back: delete `src/registry/`, `src/providers/`, their test files, and
this doc; remove the two export lines from `src/index.ts` and the two
export entries from `package.json`. No existing table, file, or export is
modified in a way that depends on this feature — `hq_ai_members` and its
sibling tables simply stop being created if `ensureRegistrySchema` is never
called again.

## Tests

`packages/headquarter/test/registry-capabilities.test.ts`,
`registry-members.test.ts`, `registry-routing.test.ts`, `providers.test.ts`,
`registry-serialization.test.ts` — 59 new tests, all ten Founder scenarios
from issue #119 covered explicitly and named so each is findable by test
name (`scenario 1` … `scenario 10`), plus schema idempotency, multiple
workers of the same model coexisting, and granting an unregistered
capability throwing. `npx vitest run`: 163/163 passing (104 pre-existing +
59 new). `npx tsc --noEmit`: clean.
