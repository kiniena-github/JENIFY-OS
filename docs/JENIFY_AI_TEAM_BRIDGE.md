# JENIFY AI Team Bridge

## Goal

Make Jenify's three-AI workflow operate without the Founder copying prompts or reports between ChatGPT, Claude, and Google.

GitHub Issues are the live task/message bus. Google Drive remains the long-term company knowledge/archive layer. GitHub remains the technical source of truth for code and engineering evidence.

## Routing contract

ChatGPT creates one owner-authored issue using one of these exact title prefixes:

| Prefix | Automatic workers |
|---|---|
| `[AI TASK]` | Claude only (legacy/default) |
| `[AI TASK][CLAUDE]` | Claude only |
| `[AI TASK][GEMINI]` | Google Gemini research lane only |
| `[AI TASK][BOTH]` | Claude and Google independently |

The Founder should not have to open Claude or Google and say "check the bridge". The issue event is the wake-up signal.

## Automatic flow

```text
Founder -> ChatGPT
             |
             | creates routed GitHub issue
             v
      +------ GitHub Issue ------+
      |                          |
      v                          v
Claude AI WORKERS          Gemini research lane
(existing Max Routine)     (Google official GitHub Action)
      |                          |
      | issue comment            | issue comment
      v                          v
      +------ same issue --------+
                 |
                 v
              ChatGPT
       compares both reports
                 |
                 v
        final decision / next task
```

### Claude result marker

Claude must post its final report to the same issue beginning with:

```html
<!-- jenify-claude-result -->
```

### Google result marker

The Gemini workflow posts its result to the same issue beginning with:

```html
<!-- jenify-gemini-result -->
```

These markers let ChatGPT locate the two independent reports reliably.

## Security model

- Automatic issue-triggered work only accepts tasks created by the repository owner.
- Secrets stay in GitHub Actions Secrets and must never be pasted into ChatGPT, Claude messages, issues, commits, PRs, or logs.
- Gemini automation has `contents: read` only; it cannot push code from this workflow.
- Gemini's role here is research, verification, criticism, and independent analysis. Implementation belongs to the engineering lane unless an explicitly reviewed future workflow says otherwise.
- Claude continues to use a branch/PR for implementation and the normal CI/review gates.
- No production deployment, destructive migration, separately billed API, paid cloud resource, material security change, or official/compliance commitment may be introduced without Founder approval.

## Cost model: zero extra payment

### Claude

`.github/workflows/ai-task-trigger.yml` calls the existing claude.ai **AI WORKERS** Routine fire endpoint. This consumes the existing Claude Max / Claude Code subscription allowance and deliberately does not use `ANTHROPIC_API_KEY`.

### Google automatic lane

`.github/workflows/ai-task-gemini.yml` uses Google's official `google-github-actions/run-gemini-cli` action with an AI Studio `GEMINI_API_KEY`.

The key must come from a Google AI Studio project with **billing disabled**. This means:

- free-of-charge Gemini API quota only;
- no Vertex AI;
- no pay-as-you-go fallback;
- if the free quota is exhausted, the automation fails/stops instead of charging money.

### Why the automatic lane is not using the Google AI Pro subscription directly

Google changed its developer-agent product in 2026. Starting June 18, 2026, Google AI Pro/Ultra subscription access moved away from Gemini CLI to Antigravity / Antigravity CLI. Antigravity CLI can use the paid subscription after Google sign-in, but its consumer authentication is interactive and does not currently provide a supported fresh-environment/headless CI authentication path. An ephemeral GitHub-hosted runner therefore cannot safely use the Pro subscription credential by itself.

Until Google ships supported headless subscription authentication, the corporate-safe PC-off choice is:

- Google AI Pro: Gemini app, Deep Research, NotebookLM, Antigravity and other subscription features;
- automatic GitHub research lane: free AI Studio quota with billing disabled.

If supported headless Antigravity subscription auth becomes available later, replace the free-key lane so the automation consumes the paid Google subscription directly.

## One-time private activation

### 1. Repair Claude Routine authentication

The bridge reached Anthropic successfully on 2026-08-25 but the live test returned HTTP 401. Regenerate the AI WORKERS Routine fire token and copy the matching URL/token from the same Routine API-trigger view into these GitHub Actions secrets:

- `CLAUDE_ROUTINE_URL`
- `CLAUDE_ROUTINE_TOKEN`

Never send either value to another AI or chat.

### 2. Add the free Google automation credential

Create a Google AI Studio API key in a project that has billing disabled, then store it directly in GitHub Actions Secrets as:

- `GEMINI_API_KEY`

Do not paste the key into chat.

### 3. Merge and controlled test

After independent review/CI passes, merge the bridge to `main`, then create one owner-authored test issue:

```text
[AI TASK][BOTH] Bridge smoke test
```

The acceptance criteria are:

1. Claude workflow starts and receives HTTP 200 from the AI WORKERS Routine.
2. Google workflow succeeds without a paid Google Cloud credential.
3. Claude posts `<!-- jenify-claude-result -->` to the test issue.
4. Google posts `<!-- jenify-gemini-result -->` to the test issue.
5. No credential appears in Actions logs or issue comments.
6. ChatGPT can read both reports from the issue without Founder copy/paste.

Only after all six pass is the bridge considered fully automatic.

## ChatGPT routing policy

ChatGPT should route economically instead of waking every model for every task:

- engineering implementation -> `[AI TASK][CLAUDE]`;
- market / competitor / regulation / supplier / scientific research -> `[AI TASK][GEMINI]`;
- important architecture, product direction, contentious research, release review, or independent challenge -> `[AI TASK][BOTH]`;
- small legacy engineering tasks may remain `[AI TASK]`.

This preserves speed and quota while still using cross-model disagreement where it adds real value.

## Re-triggering

The existing `ai-task` label can intentionally re-trigger a routed issue after the initial 120-second duplicate-protection window. Manual `workflow_dispatch` is also available for controlled recovery/testing.

Do not repeatedly re-trigger a task merely to obtain a different answer. Record disagreement and let ChatGPT decide whether a second round is justified.
