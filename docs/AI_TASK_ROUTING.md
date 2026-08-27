# JENIFY multi-AI task routing

How a GitHub `[AI TASK]` issue reaches a specific AI worker — and, just as
importantly, how it is stopped when no genuine worker exists.

Related: [AI_AUTOMATION_WORKFLOW.md](AI_AUTOMATION_WORKFLOW.md) (Founder gates),
[AI_TASK_ROUTINE_TRIGGER.md](AI_TASK_ROUTINE_TRIGGER.md) (Claude routine setup),
[JENIFY_AI_TEAM_BRIDGE.md](JENIFY_AI_TEAM_BRIDGE.md) (who does what).

---

## 1. The two defects this replaced

**Defect 1 — a new instruction did not wake anyone.** Both bridge workflows
triggered only on `issues: [opened, labeled]` and `workflow_dispatch`. When a new
Founder-approved instruction was posted as a **comment** on an existing task,
nothing fired; the assigned worker stayed asleep and the task silently stalled.

**Defect 2 — every unclaimed task fell through to Claude.** The Claude workflow's
guard was:

```yaml
startsWith(github.event.issue.title, '[AI TASK]') &&
!startsWith(github.event.issue.title, '[AI TASK][GEMINI]')
```

Everything that was not Gemini matched — `[CODEX]`, `[JULES]`, `[XAI]`, a typo —
and fired Claude. Claude then correctly refused to impersonate the requested
provider, so the task produced a refusal instead of work.

---

## 2. Where the rules live

Routing rules are **not** written in YAML expressions. They live in one
unit-tested TypeScript module and the workflows call it:

| File | Role |
|---|---|
| [packages/headquarter/src/routing/providers.ts](../packages/headquarter/src/routing/providers.ts) | Provider registry: required secrets, executor workflow, result marker |
| [packages/headquarter/src/routing/route.ts](../packages/headquarter/src/routing/route.ts) | Pure decision functions: title grammar, run directive, `decideRouting` |
| [.github/scripts/decide-routing.ts](../.github/scripts/decide-routing.ts) | Actions entry point: GitHub event env → step outputs |
| [packages/headquarter/test/routing.test.ts](../packages/headquarter/test/routing.test.ts) | Proves the rules |
| [packages/headquarter/test/decide-routing-cli.test.ts](../packages/headquarter/test/decide-routing-cli.test.ts) | Proves the wiring the workflows depend on |

Each workflow keeps a cheap `if:` pre-gate purely to avoid spinning up a runner
for unrelated issues. The **authoritative** decision is always the `Decide
routing` step; every later step is gated on its output. A rule proven in the test
suite is literally the rule that runs in CI.

---

## 3. Task title grammar

```
[AI TASK] <title>                       → CLAUDE   (legacy, unchanged)
[AI TASK][CLAUDE] <title>               → CLAUDE
[AI TASK][GEMINI] <title>               → GEMINI
[AI TASK][BOTH] <title>                 → CLAUDE + GEMINI
[AI TASK][CODEX] <title>                → BLOCKED (see §5)
[AI TASK][GEMINI][REVIEWER] <title>     → GEMINI, acting as Reviewer
```

Provider and role tags are order-independent. **Role is separate from provider
identity** — `ROLE=Reviewer` can move from one provider to another by editing the
title, with no code change. Roles: `MANAGER`, `BUILDER`, `REVIEWER`, `RESEARCHER`.

An unrecognised tag is **blocked**, never quietly treated as Claude.

---

## 4. Re-triggering an existing task

Post a comment on the task containing the machine-readable directive:

```
<!-- jenify-run -->
```

Optionally redirect the run to a different provider:

```
<!-- jenify-run: GEMINI -->
```

A comment wakes a worker only when **all** of these hold:

| Guard | Rule |
|---|---|
| Directive | The comment contains `<!-- jenify-run -->`. Ordinary discussion never starts work. |
| Result marker | The comment carries **no** `jenify-*-result` marker. A worker's own report can never re-trigger it, even if the report quotes the directive while explaining it. The marker always beats the directive. |
| Author | The issue was opened by the repository owner **and** the commenter is the repository owner. |
| Actor | The actor is not a bot (checked by both `type` and a `[bot]` login suffix). |
| Task | The issue title is a routed `[AI TASK]`, and the target provider is genuinely connected. |

History is preserved: a re-triggered worker receives the whole thread and is told
that the most recent directive comment is the current instruction and everything
earlier is history.

**Loop safety** rests on three independent layers — worker comments carry a result
marker, workers post as a bot, and only the owner may trigger. Any one of the
three alone stops a loop.

**Concurrency**: each workflow uses a per-issue concurrency group with
`cancel-in-progress: false`, so two directives on the same issue queue rather than
racing or cancelling live work.

**Duplicate delivery**: a blocked notice is compared against the most recent
existing blocked notice on the issue and is not posted twice. The pre-existing
120-second open-then-label suppression is retained.

---

## 5. Fail-closed routing

A provider is connected only when **both** are true:

1. a real executor workflow exists (`executor` in the registry is not `null`), and
2. every one of its `requiredSecrets` is actually present.

Connectivity is derived at run time — it is never hard-coded to `true`. Adding a
provider to the registry does **not** make it connected.

When a requested provider is not connected, the bridge posts:

```
ROUTING BLOCKED — CODEX NOT CONNECTED
```

with the reason, and the task is **not** re-routed. No other model is substituted
and no worker is asked to impersonate the requested provider. On a mixed request
such as `[AI TASK][CLAUDE][CODEX]`, Claude does its own share and Codex is
reported blocked; Claude is never told to cover for Codex.

### Provider status

| Provider | Executor | Credential | Status |
|---|---|---|---|
| CLAUDE | `.github/workflows/ai-task-trigger.yml` | `CLAUDE_ROUTINE_URL`, `CLAUDE_ROUTINE_TOKEN` | **Operational** |
| GEMINI | `.github/workflows/ai-task-gemini.yml` | `GEMINI_API_KEY` | **Operational** |
| CODEX | none | `CODEX_API_KEY` (absent) | Not connected |
| JULES, XAI, MICROSOFT, META, MISTRAL, QWEN, DEEPSEEK, LOCAL, CUSTOM, JENIFY | none | absent | Not connected |

To connect a new provider: add its executor workflow, add its secret, and set
`executor` in the registry. Routing needs no other change.

---

## 6. Provenance

Every dispatch and every result carries a provenance block recording the
requested provider, the actual provider, the actual model, role, trigger event,
session, dispatching run, status and timestamp.

The rule is **claim only what is proven**:

- Gemini's "actual model" is the server-attested `modelVersion` from the API
  response. The existing model-verification guard still rejects a mismatch with
  no fallback.
- Claude's dispatch provenance asserts only that a routine session was
  dispatched; the executing model is attested by the worker in its own report,
  and the worker is instructed to write `unverified` rather than guess.
- Anything unproven renders as `_unverified_`.

---

## 7. Manual re-trigger

Two safe ways, neither of which requires opening a duplicate issue:

1. **Comment directive** — post `<!-- jenify-run -->` on the existing task.
2. **workflow_dispatch** — run the provider workflow with the issue number.

Both go through the same routing decision, so neither can force a blocked
provider through.

---

## 8. Verifying a change

```bash
npm run test --workspace @factoryos/headquarter   # routing rules + workflow wiring
npm run typecheck --workspace @factoryos/headquarter
python -c "import yaml,sys; [yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/ai-task-*.yml
```

**Known limitation.** For `issues` and `issue_comment` events GitHub runs the
workflow file from the **default branch**. Comment re-triggering therefore cannot
be exercised end-to-end from a feature branch — it becomes live only once this
change is merged to `main`. Everything above is proven locally by the test suite
against the exact script the workflows invoke; the first real comment re-trigger
should still be confirmed on a harmless task after merge.
