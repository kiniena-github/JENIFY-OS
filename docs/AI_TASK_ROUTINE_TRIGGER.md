# AI Task → Claude Routine Trigger Bridge

## Purpose

ChatGPT (manager) records approved work as GitHub `[AI TASK]` issues. The
execution worker is the existing claude.ai Claude Code Routine **AI WORKERS**.
Anthropic's native routine GitHub-event triggers currently cover **pull
request** and **release** events, not **issues**, so creating an `[AI TASK]`
issue did not start the routine by itself.

The bridge is `.github/workflows/ai-task-trigger.yml`: a minimal GitHub
Actions job (no checkout, no build, no application code) that reacts to issue
events and sends one authenticated HTTP POST to the routine's fire endpoint.

```
ChatGPT creates "[AI TASK]" issue
        │  (issues: opened / labeled)
        ▼
GitHub Actions: AI Task Routine Bridge
        │  POST {"text": "Work the approved GitHub AI task at <issue url> ..."}
        ▼
claude.ai Routine "AI WORKERS"  →  new Claude Code web session
        │
        ▼
Claude reads the issue, works on a branch, opens a PR (normal workflow)
```

## Endpoint contract (verified against Anthropic docs, Aug 2026)

- `POST <fire URL>` where the fire URL looks like
  `https://api.anthropic.com/v1/claude_code/routines/trig_.../fire` and is
  shown in the routine's API-trigger modal at claude.ai/code/routines.
- Headers: `Authorization: Bearer <per-routine token, sk-ant-oat01-...>`,
  `anthropic-version: 2023-06-01`,
  `anthropic-beta: experimental-cc-routine-2026-04-01`,
  `Content-Type: application/json`.
- Body: `{"text": "<freeform run context, ≤ 65,536 chars>"}` — passed to the
  routine **alongside its saved prompt**.
- Success: `200` with `claude_code_session_id` / `claude_code_session_url`.
- This is the claude.ai Claude Code product surface, billed against the
  existing Claude Code subscription allowance. It is **not** the paid Claude
  Platform API; the bridge must never use `ANTHROPIC_API_KEY`.
- The dated beta header will rotate over time; Anthropic keeps the two
  previous versions working, so update the header value in the workflow when
  Anthropic announces a new one.

## When the bridge fires

| Event | Condition |
|---|---|
| Issue **opened** | Title starts with `[AI TASK]` |
| Issue **labeled** | The added label is exactly `ai-task` AND the title starts with `[AI TASK]` (used to re-trigger an existing issue, e.g. #11) |
| **workflow_dispatch** | Manual run with an `issue_number` input; refused unless that issue's title starts with `[AI TASK]` |

Duplicate protection:

- A per-issue Actions concurrency group collapses rapid repeated label
  events (only one run can wait per group; extras are cancelled).
- A `labeled` event arriving within 120 s of issue creation is skipped,
  because the `opened` event already fires the routine for new `[AI TASK]`
  issues (an issue created with the label pre-applied emits both events).
- The fire endpoint itself has **no idempotency key** — every successful POST
  creates a new session — so do **not** pre-apply the `ai-task` label in the
  issue template, and re-add the label (or use manual dispatch) only when you
  intentionally want a fresh session.

The `ai-task` label does not exist in the repo yet; GitHub creates it the
first time someone adds it from the issue sidebar (or create it under
Issues → Labels). New issues fire on the title prefix alone, so the label is
only needed for re-triggering.

## Founder-only setup (one time, private)

1. **Regenerate the routine token.** The previously displayed token must be
   treated as compromised. At claude.ai/code/routines open **AI WORKERS** →
   API trigger → generate a new token (generating a new token revokes the
   old one). Copy the fire URL and the fresh token from the modal.
2. In GitHub: **JENIFY-OS → Settings → Secrets and variables → Actions →
   New repository secret**, add:
   - `CLAUDE_ROUTINE_URL` — the full fire URL
   - `CLAUDE_ROUTINE_TOKEN` — the fresh token
3. Never paste either value into chat, an issue, a commit, a log, or a PR.
   The workflow reads them only from GitHub Secrets; GitHub masks secret
   values in logs automatically.

Token risk is bounded by design: the bearer token is scoped to this single
routine, can only start it, and grants no read access to sessions, other
routines, or account data.

## Test plan (after secrets are configured)

1. Actions → **AI Task Routine Bridge** → **Run workflow**, with
   `issue_number` set to a controlled `[AI TASK]` test issue (or `12`).
2. Confirm the job succeeds and the log prints an HTTP 200 and a
   `claude.ai/code/session_...` URL, with no credentials printed.
3. Open claude.ai/code and confirm a new **AI WORKERS** session appeared and
   received the correct repository + issue URL in its starting context.
4. Confirm Claude reads the issue and begins work in the named repository.
5. Then trigger Issue #11 by adding the `ai-task` label to it (or manual
   dispatch with `11`) — do not duplicate the issue.

## Routine prompt compatibility

The saved **AI WORKERS** prompt already says to "read the GitHub task/issue
supplied to you," and the fire endpoint passes the bridge's `text` alongside
that saved prompt, so the current prompt is sufficient to act on the supplied
issue link. One optional clarifying sentence is recommended in the Routine UI
to make the no-context fallback explicit (observed in practice: when the
routine fires with *no* supplied text, the worker must infer its intake):

> "If the trigger message names a specific repository and issue URL, work
> only that issue; if no issue is supplied, scan the open `[AI TASK]` issues
> and work the highest-priority approved one."

This tightens targeting and does not weaken any safety rule.

## Cost

- GitHub Actions: one tiny ubuntu job (a few seconds) per task issue — well
  within the free/included allowance; no paid add-ons enabled.
- Claude: routine runs draw on the existing claude.ai Claude Code
  subscription allowance (per-account daily routine-run limit applies). No
  paid Claude Platform API, no new service, no usage billing added.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Job fails at "Check routine secrets" | Secrets not added yet (Founder setup above) |
| HTTP 400 | Beta header rejected (rotate to current dated version) or the routine is paused |
| HTTP 401 | Token revoked/regenerated — update `CLAUDE_ROUTINE_TOKEN` |
| HTTP 404 | Fire URL wrong or routine deleted — update `CLAUDE_ROUTINE_URL` |
| HTTP 429 | Daily routine-run or usage limit reached; retry after the window resets |
| 500 / 503 | Transient Anthropic-side error; the job already retries twice |
