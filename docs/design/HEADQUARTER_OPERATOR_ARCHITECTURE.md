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

## 7. Deliberately NOT built this wave

- No HTTP routes, UI, or deployment target (no DNS, no hosting).
- No execution workers, no session/browser broker, no vendor API calls.
- No scheduler/daemon; all operations are explicit function calls.
- No credential storage of any kind.
- No self-merge: the PR waits for independent review.

## 8. Test evidence

- `packages/headquarter`: 36 vitest tests across events/policy/queue/evidence/store (all passing).
- `packages/server`: full existing suite re-run — 399 passed, 3 skipped (pre-existing), 0 failed.
- `tsc --noEmit` clean for `headquarter` and `server`.

## 9. Rollback

The change is additive: one new package plus one workspace entry in the root
`package.json`. Reverting the PR removes it completely; no existing behavior, schema, or
data is modified.
