# AI Task → Claude Routine Trigger Bridge

## Purpose

ChatGPT records approved work as routed GitHub AI-task issues. The Claude execution worker is the existing claude.ai Claude Code Routine **AI WORKERS**.

The bridge is `.github/workflows/ai-task-trigger.yml`: a minimal GitHub Actions job that reacts to Claude-routed issue events and sends one authenticated HTTP POST to the Routine fire endpoint.

The cross-model routing contract is documented in `docs/JENIFY_AI_TEAM_BRIDGE.md`.

## Claude routing

| Title prefix | Claude fires? |
|---|---|
| `[AI TASK]` | Yes — legacy/default Claude route |
| `[AI TASK][CLAUDE]` | Yes |
| `[AI TASK][BOTH]` | Yes — Google runs independently in its own workflow |
| `[AI TASK][GEMINI]` | No — Google-only route |

Automatic issue-triggered work is accepted only when the issue was created by the repository owner. A manual `workflow_dispatch` also validates the issue title and owner before firing.

## Result handoff

The fire message now instructs AI WORKERS to write its final report back to the **same GitHub issue**, beginning with:

```html
<!-- jenify-claude-result -->
```

followed by:

```text
## Claude Engineering / Review Report
```

This removes Founder copy/paste from the Claude → ChatGPT handoff. ChatGPT can read the actual issue comment directly.

## Endpoint contract

- `POST <fire URL>` shown in the AI WORKERS Routine API-trigger view.
- Headers include the per-Routine bearer token, `anthropic-version: 2023-06-01`, the current supported Claude Code Routine beta header, and JSON content type.
- Body is `{"text": "<run context>"}` and is passed alongside the Routine's saved prompt.
- Success returns HTTP `200` with a Claude Code session id/url.
- This uses the claude.ai Claude Code product surface and the existing Claude subscription allowance. It deliberately does **not** use `ANTHROPIC_API_KEY` or the paid Claude Platform API.

## When the bridge fires

| Event | Condition |
|---|---|
| Issue **opened** | Owner-authored title is Claude-routed |
| Issue **labeled** | Added label is exactly `ai-task`, title is Claude-routed, owner authored |
| **workflow_dispatch** | Manual issue number; workflow validates route + owner |

Duplicate protection:

- Per-issue Actions concurrency prevents parallel duplicate runs.
- A label event within 120 seconds of issue creation is skipped because the opened event already handles the task.
- The Routine fire endpoint has no idempotency key; intentional re-triggering creates a fresh session.

## Founder-only private setup

The live post-merge test on **2026-08-25** reached Anthropic but returned **HTTP 401**, so the stored Routine authentication is not valid yet.

One-time repair:

1. In claude.ai/code/routines open **AI WORKERS** → API trigger.
2. Regenerate the Routine token and obtain the matching fire URL/token from the same view.
3. In GitHub repository Actions secrets replace:
   - `CLAUDE_ROUTINE_URL`
   - `CLAUDE_ROUTINE_TOKEN`
4. Never paste either value into ChatGPT, an issue, a commit, a PR, or a log.

The bearer token is private infrastructure material. ChatGPT does not need to see it.

## Controlled live test

Because issue-event workflows run from the default branch, the exact live trigger can only be tested after the workflow version is merged to `main`.

After private secret repair and reviewed merge:

1. Create an owner-authored test issue such as `[AI TASK][CLAUDE] Bridge smoke test`, or use controlled manual dispatch.
2. Verify Actions reports HTTP `200` and a new AI WORKERS session URL.
3. Verify Claude reads the correct issue.
4. Verify Claude posts the marked `<!-- jenify-claude-result -->` report back to the same issue.
5. Verify no credential appears in logs or comments.

For the full two-model smoke test use `[AI TASK][BOTH]` and the acceptance criteria in `docs/JENIFY_AI_TEAM_BRIDGE.md`.

## Cost

- GitHub Actions: small included workflow job.
- Claude: existing Claude Max / Claude Code subscription allowance.
- No paid Claude API is used.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Missing-secret failure | `CLAUDE_ROUTINE_URL` / `CLAUDE_ROUTINE_TOKEN` not configured |
| HTTP 400 | Routine paused or Routine beta/version contract changed |
| HTTP 401 | Routine token revoked, stale, or mismatched with URL |
| HTTP 404 | Wrong fire URL or deleted Routine |
| HTTP 429 | Routine/session allowance exhausted |
| HTTP 500 / 503 | Transient Anthropic error; workflow retries |
