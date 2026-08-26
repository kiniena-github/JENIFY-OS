# Headquarter + Universal Operator — Foundation Architecture (Stream 2, Wave 1)

Status: PROPOSED — branch-isolated foundation awaiting independent review (Codex, issue #44).
Source of authority: war room #41, Claude build-lead task #42, Jules task #43.
Implementation: `packages/headquarter` (`@factoryos/headquarter`), branch `claude/serene-hopper-54gbzb`.

## 1. What this wave delivers

A private, branch-isolated backend foundation for Headquarter.JENIFYLABS.com and the
Universal Operator control plane. No deployment, no DNS, no public surface, no paid
services. It is a library package with its own SQLite store; an HTTP/UI layer comes later.

## 2. Key architecture decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | New workspace package `@factoryos/headquarter`, separate from `@factoryos/server` | Protect the Mesob pilot (CLAUDE.md rule 2): zero changes to server code or tests; company-infra concerns must not couple to tenant business logic. |
| D2 | Separate SQLite database (`data/headquarter.sqlite` by default, in-memory in tests) | Founder data is sacred (rule 8): Headquarter must be physically unable to touch `data/factoryos.sqlite`. |
| D3 | Append-only canonical event log as source of truth; dashboards are derived read models | War room order B: one canonical activity model; reconstruction and audit need immutable facts, not mutable status fields. |
| D4 | The nine canonical statuses with an explicit legal-transition table | Prevents parallel status vocabularies across Claude/Jules/Codex work; illegal transitions throw. |
| D5 | Capability registry is the only authority on risk; workers cannot self-declare safety | War room safety rule; policy engine reads risk class from the registry, never from task payloads. |
| D6 | Deny-by-default + per-worker capability allow-lists (least privilege) | Issue #42 order 4. |
| D7 | Atomic claim via conditional UPDATE + monotonic fencing token + leases | Exactly-one executor; a stale/zombie worker's writes are rejected after re-claim. |
| D8 | Side-effect tasks require idempotency keys; duplicate enqueue deduplicates | Safe reprocessing of real-world actions. |
| D9 | Expired lease on a running side-effect task ⇒ `outcome_unknown`; resolution only via explicit reconciliation (`confirmed_done` / `confirmed_failed` / `confirmed_not_executed`, the latter only for idempotent capabilities) | War room rule: uncertain completion is never blindly retried. |
| D10 | Hash-chained append-only evidence log with `verifyChain()` tamper detection | Every operator decision/execution attempt is auditable; deletion or edit breaks the chain. |
| D11 | Kill switch: global (`*`) and per-capability scopes, blocking all new claims | Founder emergency stop, issue #42 order 4. |
| D12 | No arbitrary-command capability exists; capabilities are named, typed actions | Issue #42 order 5. The control plane (this package) never executes anything itself — it only queues, gates, fences, and records. |
| D13 | Vendor-neutral `WorkerAdapter` seam; Claude/Codex/Jules/Google are registry entries | Issue #42 order 6: no vendor hard-coded as the system. |
| D14 | Plain better-sqlite3 + explicit DDL (no drizzle) for the foundation | Smaller review surface for wave 1; migration to drizzle-kit is a recorded follow-up, not a constraint. |
| D15 | Founder approval binds to the exact immutable action: SHA-256 digest of the canonical serialized task (task id + capability + payload + idempotency key) + expiry + single-use nonce, re-validated at the claim/start execution boundary | Issue #53 correction A (gate G5): an approval must not survive payload/capability mutation, expiry, or replay. Digest mismatch blocks the task; missing/expired/consumed approvals send it back to `needs_approval` for a fresh decision. |
| D15b | Approval consumption binds to the legitimate claim: consuming the single-use nonce at claim time atomically records `consumed_by` (worker), `consumed_fence` (the claim's fencing token) and `consumed_claim_nonce` (a random per-claim nonce also stamped on the task row); `start()` verifies all three against the current worker/fence/task nonce in addition to decision, digest, expiry and fencing | Issue #77 (Jules review #72, HIGH): a consumed approval must prove it was consumed by the claim now executing. A consumed approval reattached to a forced assigned state, a different worker, or a resurrected released claim fails the binding and blocks the task as hostile (`approval_claim_binding_mismatch`); the issue #71 expired-at-start path stays `needs_approval` because a legitimate claim's binding passes before the time-box rejects. Claim release (sweep/requeue/boundary rejection) clears the task's claim nonce so a stale claim can never be restored onto its old approval. |
| D16 | Side-effect execution results are review-gated: the executing worker's `complete()` lands in `reviewState: pending` (status stays `running`, lease released), and only an independent reviewer — never the executing/submitting/requesting worker, never `system` — can pass it through `review_passed` to terminal `completed` | Issue #53 correction B: builder != final reviewer. The legal-transition table stays capability-blind and necessary-but-not-sufficient; the queue adds capability-aware enforcement. Reconciliation of `outcome_unknown` requires the same reviewer independence. Read-only capabilities still complete directly. |

## 3. Module map (war room order C)

Backend contracts + store implemented in this wave; UI is Jules-owned (#43).

- **Command Center** — `commandCenterSnapshot()` maps latest canonical status per subject to the Founder's five lanes: NOW (running/assigned), DONE TODAY (completed today), BLOCKED (blocked/review_failed/outcome_unknown), WAITING FOR FOUNDER (needs_approval), NEXT (queued).
- **Projects** — `hq_projects` records keyed by stream.
- **Executive Room / Direct Chats** — `hq_chat_messages` threads (`executive-room`, `dm:<workerId>`).
- **Specialist Directory** — `hq_specialists` = persisted `WorkerDescriptor`s incl. capability allow-lists.
- **Founder Approval Center** — `hq_approvals`; denial requires a note; decisions are immutable once made.
- **Archive/Knowledge** — `hq_archive_refs` holds stable references (opaque locators) into the Jules-owned archive store, so the two implementations do not collide.

## 4. Separation of planes (issue #42 order 5)

```
Control plane   (this package)  — queue, policy, fencing, evidence, kill switch. Holds NO credentials.
Session broker  (future)        — vendor session/browser management. Isolated credential custody.
Execution workers (future)      — implement one capability each, least privilege, report via events.
```

Credentials never enter the control plane: task payloads, events, and evidence entries are
screened by a secret-pattern guard (`assertNoSecretLikeContent`) as a backstop; the primary
rule is that the broker/worker environments are the only credential holders.

## 5. Security assumptions (for Codex review, #44)

1. SQLite file permissions are the storage trust boundary in the local-first MVP; there is no network listener in this package.
2. The secret-pattern guard is best-effort (regex heuristics), not a DLP system — the review should treat "no credentials in payloads" as a process rule enforced at worker boundaries.
3. `founder` / `system` actors are trusted strings in this wave; authenticated Founder identity arrives with the HTTP layer, which must reuse the server package's existing auth/session machinery rather than inventing new auth.
4. Risk-class registration changes are code-reviewed, Founder-gated changes by convention; the registry API itself does not yet require an approval to mutate.
5. `sweepExpiredLeases()` and reconciliation are invoked by a scheduler/human in later waves; nothing here runs autonomously.

## 6. File/module ownership vs Jules (#43)

Claude-owned (this package): `src/contracts/**`, `src/operator/**`, `src/store/**`, this document.
Jules-owned: Headquarter UI views, archive metadata schema + reconstruction pipeline, search/indexing.
Interface between the two: the contracts in `src/contracts/` and the read models on `HeadquarterStore`; archive collision is avoided via opaque `ArchiveRef.locator`.

## 6b. Canonical-contract ownership — integration base for PR #46 (issue #53 correction D)

PR #45 and PR #46 both scaffolded `packages/headquarter` and independently defined the
event model. Resolution (Founder-approved via issue #53):

- **This branch's corrected `src/contracts/` (events, workers, modules) and package
  scaffolding are the SINGLE canonical integration base.** The nine canonical statuses,
  the legal-transition table, and the queue-level enforcement in D15/D16 are the one
  event model every layer binds to.
- **PR #46 is NOT absorbed here.** Its archive/UI implementation (dashboard views,
  archive metadata schema, reconstruction pipeline, search, static HQ site) remains its
  own deliverable and must be **rebased/adapted onto this corrected contract**:
  - drop #46's duplicate workspace scaffolding (`packages/headquarter/package.json`,
    `tsconfig.json`, root workspace entry) in favour of this branch's;
  - replace #46's locally-defined `ActivityEvent`/status types with imports from
    `@factoryos/headquarter/contracts`;
  - keep #46's archive/UI modules in non-colliding paths (e.g. `src/archive/`,
    `src/ui/`, `site/`) — nothing in this branch occupies those;
  - #46's read-only Founder Approvals page must render the D15/D15b approval fields
    (`actionDigest`, `expiresAt`, `consumedAt`, `decidedBy`, `consumedBy`,
    `consumedFence`, `consumedClaimNonce`) and must not offer
    approve/reject actions — decisions stay in the operator control plane;
  - re-run the combined test/build suite on the post-integration head before that
    integrated result is accepted.

## 7. Deliberately NOT built this wave

- No HTTP routes, UI, or deployment target (no DNS, no hosting).
- No execution workers, no session/browser broker, no vendor API calls.
- No scheduler/daemon; all operations are explicit function calls.
- No credential storage of any kind.
- No self-merge: the PR waits for independent review.

## 8. Test evidence

- `packages/headquarter`: 67 vitest tests across events/policy/queue/evidence/store plus
  `test/security.test.ts` — 31 hostile security regression tests for D15/D15b/D16 (approval
  digest binding, expiry — including expiry revalidated at execution start (issue #71) —
  single-use nonce/replay rejection, claim-binding of consumption (issue #77: reattach to a
  forced assigned state or different worker, claim path skipped entirely, forged/stale claim
  nonce, resurrected released claim), post-approval mutation via
  direct SQL, cross-task approval riding, self-approval, self-review, self-reconciliation,
  review-pending sweep safety). All passing.
- `packages/server`: full existing suite re-run — see PR #45 validation section for the
  current counts on the corrected head.
- `tsc --noEmit` clean for `headquarter` and `server`.

## 9. Rollback

The change is additive: one new package plus one workspace entry in the root
`package.json`. Reverting the PR removes it completely; no existing behavior, schema, or
data is modified.
