# Organization + Workforce Runtime Model

Issue #118 (HQ special lane B). Implementation: `packages/headquarter/src/organization/`,
covered by `packages/headquarter/test/organization*.test.ts`.

## What this is

A pure, deterministic, in-memory TypeScript domain engine (`createOrganizationEngine`)
that models an editable organization: departments, roles, workers (human / AI / external),
role occupancy, temporary task forces, and active task ownership with handover.

It is **not** a database module. There is no SQL, no I/O, and no randomness beyond a
monotonic in-state counter used only for auto-generated handover ids — replaying the
same call sequence against a fresh engine always produces the same state. Persistence
(SQLite, etc.) is a later concern that can serialize `OrgState` / `OrgVersion` directly,
since every type in this module is plain JSON-serializable data.

## Entities

| Entity | Notes |
|---|---|
| `Department` | Tree via `parentDepartmentId`. No "move department" op exists yet, so the tree can only ever grow acyclically — a child references a parent that must already exist. |
| `Role` | Belongs to a `departmentId`. Carries `isManagerRole` (a boolean designation, separate from `reportsToRoleId`), `reportsToRoleId` (the reporting line), `teamSizeTarget`, `maxOccupants`, `exclusivity` ('exclusive' \| 'shared'), `eligibleOccupantTypes`, and `requiredCapabilities` (capability **id refs only** — see Permissions below). |
| `OrgWorker` | `occupantType: 'human' \| 'ai' \| 'external'`. `provider` is a free-form optional string (`'chatgpt'`, `'claude'`, `'gemini'`, `'codex'`, `'jules'`, or anything not yet invented) — **pure data**, never special-cased in engine logic. `allowedCapabilities` is this module's own snapshot, captured once at `registerWorker` time. |
| `Occupant` | An assignment of one worker to one role. Deterministic id `` `${roleId}::${workerId}` `` — a worker can occupy the same role at most once (a second `assignRole` for the same pair is `duplicate_id`). |
| `TaskForce` | Explicit id, purpose, member worker ids, optional expiry. Dissolution flips a flag and never deletes the record. |
| `TaskOwnership` | `taskId -> { roleId, workerId, state }`. `state` is `'owned'` or `'handover_pending'`. |
| `Handover` | A record of one task's ownership transfer: `fromWorkerId`, `toWorkerId` (nullable until resolved), `reason`, `status: 'pending' \| 'completed'`. |

## Eligibility (deny by default)

`assignRole(roleId, workerId, actor, reason)` succeeds only if **all** of:

1. `worker.active` is true.
2. `worker.occupantType` is in `role.eligibleOccupantTypes`.
3. `role.requiredCapabilities` is a subset of `worker.allowedCapabilities` (a missing
   capability produces `capability_not_granted` with the exact missing ids in
   `error.details.missing` — proof the check is a real subset test, not a stub).
4. The role has occupancy headroom: `role.maxOccupants` not yet reached.
5. Multi-role policy allows it: if the worker already holds another role, either role
   being `'exclusive'` blocks the combination outright; otherwise the org-level
   `policy.allowMultiRolePerWorker` flag must be `true`.

This mirrors `operator/policy.ts`'s `evaluatePolicy` shape deliberately
(`eligibility.ts`'s `evaluateRoleEligibility` returns the same
`{ eligible: true } | { eligible: false; reason; details }` pattern as `PolicyDecision`)
— same "derive only from registry/allow-list data, never from what the subject claims
about itself" philosophy, applied to org roles instead of Operator capabilities.

Any capability id referenced by a role's `requiredCapabilities` or a worker's
`allowedCapabilities` must be a member of the `capabilityIds` set passed to
`createOrganizationEngine({ capabilityIds })` at construction — an unknown ref is
rejected at `defineRole` / `registerWorker` time with `unknown_capability_ref`, before it
can ever reach an eligibility check.

## Permissions: refs only, no grants (hard invariant)

**This module never grants, revokes, or mutates Operator side-effect rights.** It only:

- *reads* the `capabilityIds` set handed to it at construction, to validate that a ref is
  a known id (`Set.has()` only — never `.add()`/`.delete()`);
- *copies* whatever `allowedCapabilities` array a caller hands to `registerWorker` into
  its own snapshot (`[...input.allowedCapabilities]`), and never writes back to the
  caller's object, array, or any real `WorkerDescriptor` / `CapabilityRegistry`.

Concretely: `registerWorker` accepts a plain, structurally-compatible input (id,
displayName, occupantType, provider, active, allowedCapabilities) rather than a live
`WorkerDescriptor` instance, and every field is copied by value into a new `OrgWorker`
object before being written into the (already-cloned) draft state. `defineRole` and
`registerWorker` only ever call `.has()` on the capability-id set.

Enforced and proven in `test/organization.hostile.test.ts`
(`"organization engine — org edits grant no Operator side-effect rights"`):
one test passes a **frozen** `WorkerDescriptor`-shaped object into `registerWorker` and
asserts it is byte-for-byte unchanged afterward (a real mutation attempt on a frozen ESM
object throws — the test passing at all is proof no write was attempted), and asserts the
engine's stored `allowedCapabilities` array is `!==` (not the same reference as) the
caller's array. A second test passes the `capabilityIds` `Set` itself and asserts it is
unchanged after several mutations reference capability ids.

## Versioning and rollback

Every successful mutating call appends exactly one new, immutable `OrgVersion` to an
append-only in-memory history:

```ts
interface OrgVersion {
  version: number;                 // 0, 1, 2, ... — index into history
  meta: { actor: string; at: string; reason: string; changeKind: string };
  state: OrgState;                 // full state snapshot at this version
}
```

- A **failed** mutation (any `OrgResult<T>` with `ok: false`) appends nothing — no
  partial/dirty version is ever visible.
- `version: 0` is a synthetic "initial state" version (`changeKind: 'init'`, actor
  `'system'` by default), so `getHistory()[0]` always has a real, inspectable
  actor/at/reason — there is no ambient "version -1" the caller cannot see.
- `rollbackToVersion(n, actor, reason)` does **not** truncate or rewrite history. It
  deep-clones version `n`'s state and appends it as a **brand-new** version at the end
  (`changeKind: 'rollback'`), so:
  - the version you rolled back "past" is still fully readable via `getVersion(k)`;
  - `getHistory().length` only ever grows;
  - the rollback itself is an audited event with its own actor/reason, same as any other
    mutation.
- `getVersion(n)` returns a defensive deep clone (mutating the returned object can never
  corrupt engine state); `getCurrentOrg()` (the read model, see below) is built the same
  way.

Actor/reason are validated (non-empty strings) on **every** mutating op, including
`rollbackToVersion` — there is no mutation path that skips recording who/why.

## Handover lifecycle (task-ownership preservation)

`registerTaskOwnership(taskId, roleId, workerId, actor, reason)` records that a worker
who **currently occupies** `roleId` (verified against the live `Occupant` set —
`not_occupant` otherwise) owns a task. This is deliberately stricter than "any known
worker" so ownership records can never point at a role a worker doesn't actually hold.

Two ways to move a task into `handover_pending`:

1. **Standalone**: `initiateHandover(taskId, actor, reason, toWorkerId?)` — usable any
   time a task needs to change hands without touching role occupancy at all.
2. **Automatic, via `unassignRole`**: if the worker being unassigned from a role owns any
   `'owned'`-state tasks through that role, `unassignRole` **fails** with
   `active_tasks_require_handover` (and the blocking `taskIds` in `error.details`) unless
   the caller passes `{ handover: { toWorkerId, reason } }`. When it does, every affected
   task is atomically moved to `handover_pending` (one `Handover` record per task, with
   `fromWorkerId` = the worker being removed) as part of the **same** version as the
   unassignment — there is no intermediate state where the role is vacated but the task
   still claims to be `'owned'` by someone no longer in the role. This is how a "manager
   swap during active tasks" or "removing an occupied role" both stay safe: the operation
   either fails outright (default) or produces a fully-tracked `handover_pending` state,
   never a silent orphan.

`toWorkerId` may be `null` at handover time ("who picks this up is still being decided")
— the target is `null` on the `Handover` record until resolved. `completeHandover`
requires a concrete target, resolved either from the handover's own `toWorkerId` or an
explicit `resolvedToWorkerId` argument (which must agree with a non-null `toWorkerId` if
both are given). Completing a handover with no resolvable target is
`handover_invalid_state`; completing sets the task back to `state: 'owned'` under the
new worker and marks the `Handover` `'completed'` with its own actor/reason — the task is
never silently re-owned.

## Team-size target: shrink-below-headcount is a **warning**, not a rejection

`setTeamSizeTarget` accepts any non-negative integer, including one below the role's
current occupant count. This was an explicit either/or choice left to this
implementation by the issue; the choice made here is **accept + warn** rather than
reject, because "stop backfilling, let the role attrit naturally" is an ordinary org
decision, not an invalid state — nobody is removed by shrinking a target. The result
carries `{ role, warning: string | null }`; `warning` is non-null exactly when
`newTarget < currentOccupantCount`. If a future caller wants "reject on shrink below
headcount" instead, that is a policy decision for the call site (check the current
vacancy report before calling), not something baked into this engine.

## Cycle detection

Both `defineRole` (via `reportsToRoleId`) and `changeReportingLine` reject a change that
would make a role (transitively) report to itself — self-reference and any-length cycles
alike — by walking the `reportsToRoleId` chain from the proposed target and checking
whether the role being defined/changed is reachable. Department parent cycles are
structurally impossible today (a parent must already exist before a child references it,
and there is no "move department" op), but `buildOrgChart`'s tree walk still carries a
`visited` guard as defense in depth.

## Read models (additive UI-editor contract surface)

`getCurrentOrg()` returns an `OrgSnapshot` — a deep-cloned, plain-data view of the latest
version plus two derived, pure read models:

- `orgChart: OrgChartNode[]` — the department tree, each node carrying its roles with
  their current `occupants` and computed `vacancies` (`max(0, teamSizeTarget - occupants.length)`).
- `vacancies: VacancyReport[]` — a flat per-role vacancy list, for a dashboard that
  doesn't want to walk the tree.

`rolesForWorker(workerId)` is a convenience read model for "what does this worker hold
right now." All engine inputs (`DefineDepartmentInput`, `DefineRoleInput`,
`RegisterWorkerInput`, `CreateTaskForceInput`, `UnassignRoleOptions`) and outputs
(`OrgResult<T>`, `OrgSnapshot`, `OrgVersionSummary`) are plain, JSON-serializable
interfaces with no engine-instance references inside them — a future UI editor (or a
persistence adapter) can serialize/deserialize them freely without touching engine
internals.

## Errors

Every mutating op returns `OrgResult<T> = { ok: true; version; data: T } | { ok: false; error: OrgError }`
— never a thrown exception for an expected validation failure, and never a silent
no-op. `OrgError.code` is one of a closed `OrgErrorCode` union (`invalid_input`,
`duplicate_id`, `not_found`, `cycle_detected`, `unknown_capability_ref`,
`capability_not_granted`, `worker_inactive`, `occupant_type_not_eligible`,
`exclusivity_violation`, `multi_role_not_allowed`, `max_occupants_exceeded`,
`not_occupant`, `active_tasks_require_handover`, `handover_invalid_state`,
`task_force_already_dissolved`, `invalid_version`), so a UI or an automated caller can
switch on the failure reason instead of pattern-matching an error string.

## Design decisions made where the issue left a choice

- **"Manager-role designation"** is modeled as `Role.isManagerRole: boolean` (a flag on
  the role itself), kept separate from `reportsToRoleId` (the reporting line) — the issue
  named these as two different concepts and this keeps them independently settable.
- **"Removing an occupied role"** is not a separate op — there is no `deleteRole` in the
  API surface the issue specified (`defineDepartment` / `defineRole` / … / `getHistory`
  is the full list). "Removing an occupied role" is realized as `unassignRole` on a role
  that currently has an occupant with active task ownership, which already goes through
  the exact same handover-required path described above.
- **Occupant id** is the deterministic pair `` `${roleId}::${workerId}` `` rather than a
  random id, keeping the whole engine free of non-deterministic id generation (the only
  auto-generated ids are handover ids, drawn from a monotonic in-state counter).
- **Team-size shrink below headcount**: accept with a warning, not reject — see above.
