# The Codex execution / review lane

Status: **genuinely connected, locally.** Verified 2026-08-27 by real execution,
not by inspection.

This document records what Codex actually is in JENIFY, what it can and cannot
do, and what the Founder must do to keep it working.

---

## 1. What Codex actually is here

| | |
|---|---|
| Binary | `C:\Users\k\AppData\Local\OpenAI\Codex\bin\<version>\codex.exe` |
| CLI version | `codex-cli 0.147.0-alpha.6.5` |
| Auth | `auth_mode = "chatgpt"` — the existing **ChatGPT subscription session** |
| API key | **None.** `OPENAI_API_KEY` is null in `~/.codex/auth.json` |
| Model | `gpt-5.6-sol` (server-side default for the session) |

Two consequences follow, and both matter:

**No new paid service was enabled.** Codex runs on the ChatGPT subscription the
Founder already pays for, the same way the Claude lane runs on the existing
claude.ai Routine allowance. No API key was created, no billing was turned on.
This satisfies principle 7 (local only, no paid external services without
Founder approval).

**Codex cannot run in GitHub Actions.** The credential is an OAuth session in a
local file, not a secret that can be handed to a runner. Putting it in a GitHub
secret would be a credential-sharing decision the Founder has not made, and the
session refreshes locally in a way a runner could not maintain. So CODEX is
`executorKind: 'local-cli'`, CI observes none of its local facts, and a GitHub
Actions run **fails closed** for CODEX rather than substituting another AI.

---

## 2. Running a review

```bash
# is Codex connected right now, and who currently holds each role?
npm -w @factoryos/headquarter run codex:probe

# review one exact commit
npm -w @factoryos/headquarter run codex:review -- \
  --sha <40-char-SHA> \
  --repo <path-to-a-checkout-at-that-SHA> \
  --base origin/main \
  --pr 153 \
  --out review.md
```

Exit codes: `0` PASS · `2` BLOCK · `1` the review did not happen (and nothing is
attributed to Codex).

The checkout must **already be at the requested SHA**. That is deliberate — see
§4.

---

## 3. What the reviewer returns

A structured verdict, schema-enforced by `codex exec --output-schema`:

- `verdict`: `PASS` | `BLOCK`
- `findings[]`: severity (`CRITICAL`/`HIGH`/`MEDIUM`/`LOW`), category, title,
  file, line, concrete evidence
- `testConcerns[]`, `securityConcerns[]`, `recommendation`

Fail-closed parsing rules:

- An empty, unparseable, or verdict-less result is a **failure**, never a PASS.
- A stated `PASS` that carries `CRITICAL` or `HIGH` findings is **upgraded to
  BLOCK**. Severity evidence outranks the summary label, so a reviewer cannot
  wave through a defect it just documented.

---

## 4. The four guarantees

These are enforced in code, not requested in a prompt.

1. **Read-only.** The CLI is always spawned with `--sandbox read-only`. There is
   no code path that omits it, and `buildCodexExecArgs` is a pure function with
   a test asserting exactly that.
2. **Worktree unchanged.** `HEAD` and `git status --porcelain` are captured
   before and after. Any difference rejects the result, even if the review
   itself looks fine.
3. **Exact SHA, twice.** The checkout is verified to be at the requested commit
   *before* Codex starts, and the commit the Codex runtime recorded for its own
   worktree is verified *after*. A runtime that attests a different commit — or
   attests none at all — is rejected. An unproven target is treated as a stale
   review, not assumed to match.
4. **No substitution.** If Codex is unavailable, the lane returns a failure. It
   never calls another provider, and `actualProvider` stays `null` unless a real
   Codex process attested itself.

---

## 5. Provenance

Taken only from what the Codex runtime attested about itself:

| Source | Fields |
|---|---|
| `session_meta` in the session rollout | session id, CLI version, `model_provider`, cwd, **git commit hash**, branch, repository URL |
| `turn_context` | **actual model** (`gpt-5.6-sol`) |
| `codex exec --json` events | thread id, token usage |

Anything not attested renders as `_unverified_`. Requested provider and actual
provider are separate rows, so a disagreement is visible rather than smoothed
over.

---

## 6. Failure modes and what they mean

| Kind | Meaning |
|---|---|
| `not_connected` | No Codex CLI or no local session. `ROUTING BLOCKED — CODEX NOT CONNECTED`. |
| `quota_exhausted` | The ChatGPT allowance is spent. **Nothing is wrong with the reviewed code.** Re-run after the reset time Codex names. |
| `provider_error` | Codex itself errored (server fault, etc.), reported in its own words. |
| `sha_mismatch` | The checkout, or the runtime's attestation, is not the requested commit. |
| `no_sha_attested` | The runtime did not say what it reviewed. Rejected, not assumed. |
| `worktree_mutated` | The reviewer changed the code it was reviewing. Rejected. |
| `unparseable_result` / `empty_result` | No usable verdict. Never treated as PASS. |
| `provider_mismatch` | The runner was handed a non-CODEX request and refused it. |

A quota refusal is reported verbatim, including the reset time, because
"try again at 11:25 PM" is actionable and a truncated stderr tail is not.

---

## 7. Keeping it working

The Codex session token in `~/.codex/auth.json` refreshes automatically while
the Codex app is used. If the lane starts reporting `not_connected`:

```bash
codex login          # one-time, opens a browser
npm -w @factoryos/headquarter run codex:probe   # confirm
```

No secret ever enters the repository. The probe reads `auth.json` only to learn
which **auth mode** is configured; token values are never returned, logged, or
written anywhere.

---

## 8. Known limits

- **Local only.** Codex cannot review from CI (§1). PR reviews are dispatched
  from the Founder workstation.
- **Subscription quota is shared** with the Founder's interactive ChatGPT and
  Codex use. A long interactive session can exhaust the allowance the review
  lane depends on.
- **Reasoning effort.** The workstation config pins `model_reasoning_effort =
  "ultra"`, which is far too slow for a fast reviewer (>10 min on one PR). The
  lane sets `medium` by default and exposes `--effort` to override.
