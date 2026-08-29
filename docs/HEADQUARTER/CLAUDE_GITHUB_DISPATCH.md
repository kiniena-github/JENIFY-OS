# Claude dispatch — carrying a canonical HQ order to the existing GitHub workflow

Issue #221, a correction to the LIVE HQ CONTROL V1 mission (#200).

This document is the operator-facing half. The reasoning lives next to the code
in `packages/headquarter/src/providers/claude/`.

## The gap this closes

A Founder direct order routed to CLAUDE became a canonical, Founder-gated,
evidenced task — and then stopped. Claude's only real executor is
`.github/workflows/ai-task-trigger.yml`, which is woken by a GitHub **issue**,
and HQ had no transport from an approved task to that issue. The order sat
approved and unrun while the Connection Center honestly reported
`provider_not_connected`.

Two things were explicitly **not** done:

- **Setting `CLAUDE_ROUTINE_URL` / `CLAUDE_ROUTINE_TOKEN` in the local HQ
  process.** Those are the names `routing/providers.ts` checks, so supplying
  them locally would flip CLAUDE to "connected" and make orders placeable while
  changing nothing about whether the work could actually run. That manufactures
  the appearance of connectivity.
- **A second Claude executor.** #200 says the existing workflow is operational
  and must be reused. A local Claude lane would be a second Claude identity with
  its own provenance and its own gaps.

What was added is the smallest missing piece: a dispatch adapter that takes an
already-canonical, already-approved, CLAUDE-bound task and emits the
`[AI TASK][CLAUDE]` issue contract that workflow already understands.

## Where each thing decides

| Concern | Owner | Not this |
|---|---|---|
| Creating / classifying / gating an order | `live/orders.ts`, `HeadquarterOperations` | the adapter creates nothing |
| Which provider may execute | `operator/provider-binding.ts` (`executionProvider`, inside the approved digest) | the adapter never chooses or substitutes |
| Whether an action is approved *now* | `operator/approvals.ts` `validateApproval` against the current digest | the adapter re-uses it, it does not re-derive it |
| Whether an issue exists already | the append-only `op_evidence` log | no new table, nothing editable |
| Reaching GitHub | `providers/claude/transport.ts` | HQ holds no credential of its own |
| Reviewing / completing the work | the Operator's independent-review path | correlation records a report, it does not pass one |

## Dispatching

Dispatch runs on the Founder workstation, because that is where the
authenticated GitHub session lives — the same reason the Codex review lane is
local. It is a trusted-local-admin interface (`--local-admin`, refused under CI),
and it attributes nothing to a human because it decides nothing on a human's
behalf.

```
npm run hq:dispatch-claude --workspace @factoryos/headquarter -- \
  --local-admin --task <taskId> --repo <owner>/<name> \
  [--role BUILDER|REVIEWER|MANAGER|RESEARCHER] [--db <path>] [--check-only]
```

`--check-only` prints eligibility, dispatch history and the observed transport
state, and publishes nothing. Run it first.

There is deliberately **no default repository**: dispatching publishes the
order's instruction into a repository, so the repository is always chosen
explicitly.

## What has to be true before anything is published

In order, and any "no" refuses without creating an issue:

1. the task exists, and its capability is registered and enabled;
2. the kill switch is clear for that capability;
3. the task is **bound to CLAUDE** — a task bound to another provider, or to
   none, is refused rather than sent down this lane;
4. it is **eligible to execute now**: `queued`, and where the capability requires
   approval, carrying a Founder approval that is approved, unexpired, unconsumed
   and bound to the task's current action digest;
5. it has not already been dispatched, and no earlier attempt is unresolved;
6. a transport exists, is **authenticated**, and its account is the **owner of
   the target repository** — the workflow only routes AI tasks opened by the
   repository owner, so an issue opened as anyone else would be a public
   artefact no worker ever runs;
7. the rendered issue passes the same credential guard the browser boundary uses.

Every refusal is written to the append-only evidence log, so a dispatch that did
not happen is visible rather than silent.

## Idempotency, and the uncertain case

"Did I already do this?" is answered from the evidence log, not from memory:

- a prior `claude_github_dispatch_succeeded` entry returns the **same** issue
  instead of opening a second one;
- an `attempted` entry with no terminal entry after it means HQ asked GitHub to
  create an issue and never learned the outcome. That is
  `dispatch_outcome_unknown`, and it **refuses** — the same rule the queue
  applies to an `outcome_unknown` execution. Somebody looks at the repository
  and resolves it explicitly (`resolveUnknownDispatch`): `found` records the real
  issue, `not_dispatched` records a failure so a fresh dispatch is a first one.
  There is no "assume it worked" and no "assume it didn't".

## Reporting back

The issue body carries a machine-readable correlation block naming the HQ task,
its capability and its approved action digest. `correlateClaudeResult` verifies
that HQ really dispatched *that* issue in *that* repository, that the reporting
provider is CLAUDE, and that the body still names the same task — then records
the correlation on the canonical task.

It records that a report **arrived**. It does not review, pass, or complete the
task: the party that did the work is never the party that declares it done.

## Connection Center

The `github` row is answered by a transport-backed probe with four honest
states:

| Observation | State |
|---|---|
| no transport mechanism here | `not_connected` |
| a `gh` binary exists, nothing was asked of GitHub | `configured` |
| a live check ran and found no session | `setup_required` |
| a live check ran and confirmed a session | `connected` |

`gh auth status` genuinely asks GitHub about the session, which is what
separates `connected` here from the `dispatchable` states elsewhere. It is still
narrow: it establishes an authenticated **identity**, not permission to open an
issue in any particular repository. So the row grants **no** effective
capability, and repository-level authority is settled where it matters — at
dispatch, which refuses when the account does not own the target.

## Credentials

Nothing in this lane reads, renders, logs, copies or transmits a token value.
The Founder's existing `gh` session is reused as-is; what HQ reports is presence
and identity — a binary was found, a live check succeeded, the account is
`<login>`. There is no code path that accepts a token as an argument.

## Publication is a real consequence

`live/orders.ts` deliberately keeps a Founder's instruction off the browser
snapshot. Dispatching to a GitHub-hosted executor **publishes** that instruction
to the target repository, because that is what the executor reads. That is
stated rather than buried: the target is always explicit, the rendered issue is
re-scanned by `assertBrowserSafe`, and a body that trips the guard refuses
instead of publishing something that cannot be unpublished.
