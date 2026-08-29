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
  --local-admin --task <taskId> --repo <owner>/<name> --as-worker <workerId> \
  [--role BUILDER|REVIEWER|MANAGER|RESEARCHER] [--db <path>] [--check-only]
```

`--as-worker` is **required** to dispatch (issue #224, Founder decision
approving option 1). The handoff claims the canonical task for that registered
worker before publishing, so the external execution is answerable to a real
fence and a consumed approval instead of leaving the task independently
claimable.

`--check-only` prints eligibility, dispatch history and the observed transport
state, publishes nothing, and needs no worker. Run it first.

There is deliberately **no default repository**: dispatching publishes the
order's instruction into a repository, so the repository is always chosen
explicitly.

## A blocked order is remembered, not lost (issue #224)

Placing an order and dispatching it are separate acts, and #200's sequence is
create-then-report. So an **explicit** order to a provider that cannot dispatch
today is still CREATED: it lands in `needs_approval` under the same
`founder_gate` class, carries the same digest, executes nothing, and is bound to
the provider that was asked for — so only a worker declared as that provider
could ever claim it. The submission response says `dispatchBlocked: true` with
the missing fact NAMES, and the Founder console marks the card BLOCKED.

That block is derived live, never stored on the task: it is a fact about the
world, not about the action, so an order placed while `CLAUDE_ROUTINE_*` was
absent stops reading as blocked the moment those secrets exist — with no write
to the task and no change to the digest an approver echoes back. The creation
is additionally recorded as a `direct_order_dispatch_blocked` evidence entry.

Because the order's idempotency key is derived from the **bound** provider
rather than the resolved one, the same order placed again once the provider is
back deduplicates onto the same canonical task. One order, one task, whether or
not the provider was reachable when it was written down.

**`AUTO` with nothing connected is recorded too**, against the first entry in
the declared `AUTO_ROUTE_PREFERENCE`. That is not substitution — substitution
means satisfying a request for one *named* provider with a different one, and
AUTO names none — and the preference order is a deterministic product decision
rather than a guess. The receipt still reports `resolved: null`, so nothing
claims a provider was available.

The trade, stated plainly: the binding is fixed once written, because it lives
inside the digest a Founder approves. An order blocked on the first preference
stays blocked on it even if a later preference connects first; the Founder then
places an explicit order for the provider that is up.

## The handoff claims the task (issue #224)

Publishing used to hand the instruction to the GitHub workflow **without**
claiming the canonical task: it stayed `queued` with its single-use approval
unconsumed. A worker declared as CLAUDE could therefore claim and execute the
same approved action while the workflow executed the published copy — bound to
no fence and no consumed approval. Two executions of one Founder-approved
action.

The handoff now takes the canonical claim for an explicitly **designated
executor worker**, inside the same transaction as the dispatch reservation:

- **Dispatch never mints, guesses, impersonates or assumes a worker identity.**
  The caller names one with `--as-worker`. Creating that worker and declaring it
  as CLAUDE are separate, Founder-gated configuration acts.
- The claim goes through `HeadquarterOperations.claimNext` — the path carrying
  human-execution rejection, assignability, the capability allow-list, the kill
  switch, assignment intent, provider binding and approval consumption. No table
  write, no second copy of any gate.
- It claims **that specific task**, never "whatever is next", so a handoff can
  never seize an unrelated order.
- Every way the claim can fail — worker missing, inactive, misdeclared, lacking
  the capability, refused by binding, approval unusable — **publishes nothing**
  and rolls the reservation back, leaving the task exactly as it was.

Two consequences worth knowing before operating it:

1. **A clean publication failure releases the claim to `needs_approval`**, not
   to `queued`. The claim consumed the single-use approval, so re-dispatching
   genuinely needs a fresh Founder decision. That is the honest cost of binding
   an external execution to an approval, not an oversight.
2. **An UNCERTAIN outcome leaves the task claimed.** Its lease (6 hours by
   default) expires into `outcome_unknown` — the canonical "handed out, never
   heard back" state — which is exactly where a silent external execution
   belongs.

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

Three things make that guard real rather than nominal:

- **The reservation is atomic.** The "already dispatched?" read and the
  `attempted` append happen inside one IMMEDIATE write transaction
  (`EvidenceLog.reserve`), so two dispatch processes on the same database cannot
  both see `none` and both publish.
- **A guard that cannot be written stops the dispatch.** If the reservation
  cannot be recorded, nothing is published (`evidence_unavailable`). If the
  issue was created and the `succeeded` entry cannot be recorded, HQ refuses
  with `dispatch_unrecorded` and hands over the issue URL rather than claiming a
  success it cannot evidence — and the attempt stays open, so the next dispatch
  refuses.
- **Timing decides what may be claimed.** A `gh` process that never started
  created nothing (`unavailable`, retryable). One that started and was then
  killed — a timeout above all — may already have created the issue, so it is
  `unreadable_response`: outcome unknown, attempt left open.

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

**Which surfaces show it.** `npm run hq:snapshot` — the local CLI that refreshes
the Connection Center's live data on the Founder workstation — wires the real
transport, so the page's live refresh reports the observed state. The static
site build (`build:site`) deliberately does not: it runs in CI, where spawning
`gh` would observe a runner rather than the Founder's machine, so the
build-time render keeps its honest configuration-only answer. A host wiring its
own surface uses `connectionProbesWithGitHubDispatch(transport)`.

## Credentials

Nothing in this lane reads, renders, logs, copies or transmits a token value.
The Founder's existing `gh` session is reused as-is; what HQ reports is presence
and identity — a binary was found, a live check succeeded, the account is the
observed login. There is no code path that accepts a token as an argument.

Every `gh` invocation is **host-qualified to `github.com`** (`DISPATCH_HOST`),
for both the auth check and the issue creation. A bare `owner/repo` would
otherwise resolve against `GH_HOST`, so a workstation configured for GitHub
Enterprise would have published the instruction — irreversibly — to that host
instead.

## Publication is a real consequence

`live/orders.ts` deliberately keeps a Founder's instruction off the browser
snapshot. Dispatching to a GitHub-hosted executor **publishes** that instruction
to the target repository, because that is what the executor reads. That is
stated rather than buried: the target is always explicit, the rendered issue is
re-scanned by `assertBrowserSafe`, and a body that trips the guard refuses
instead of publishing something that cannot be unpublished.
