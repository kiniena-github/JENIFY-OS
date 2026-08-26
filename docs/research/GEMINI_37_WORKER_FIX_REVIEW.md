# Gemini 3.7 worker routing fix — review brief

Status: diagnosis / proposed workaround only. Do not merge or deploy until reviewed.

## Observed failure

The Jenify Gemini workflow pins `gemini_model: gemini-3.7-flash` with Gemini CLI `0.55.1`. Issue #22 smoke test succeeded, but issue #23 later failed after 503 retries and then a free-tier 429 explicitly attributed to `gemini-3.5-flash`.

The pinned Google `run-gemini-cli` action sets `GEMINI_MODEL` and invokes Gemini CLI without an explicit `--model` argument. Current Gemini CLI docs say `GEMINI_MODEL` should still take precedence over settings/defaults.

## Upstream finding

Google Gemini CLI issue #28859 reproduces a v0.55.1 bug where explicit bare Flash IDs shaped like `gemini-<X.Y>-flash` are silently rewritten to `gemini-3.5-flash`, including the valid `gemini-3.7-flash`. The reporter verified the raw Gemini REST endpoint correctly serves 3.7 using the same key. The bug also reproduces in the then-current preview/nightly builds.

Upstream PR #28893 (`fix(core): preserve explicit flash model IDs`) is open and specifically fixes this resolver bug. It has not yet landed in the current stable CLI.

The same upstream reproduction found that `gemini-flash-latest` currently passes through and is served by `gemini-3.7-flash` instead of being rewritten.

## Proposed temporary Jenify workaround

Until an upstream CLI release containing #28893 is available:

1. Keep billing disabled and continue AI Studio free-tier authentication only.
2. Keep Gemini CLI pinned to stable `0.55.1` rather than switching to preview/nightly builds that have the same bug.
3. Change the workflow model input from `gemini-3.7-flash` to `gemini-flash-latest` as a temporary transport alias.
4. Add a post-run verification step that parses `gemini-artifacts/stdout.log` and requires `stats.models` to contain `gemini-3.7-flash`; if it does not, mark the result unverified/fail instead of silently claiming 3.7.
5. Surface the served model in the GitHub result comment for auditability.
6. When upstream #28893 ships in stable Gemini CLI, update the pinned CLI version, restore the explicit `gemini-3.7-flash` model ID, and retain runtime verification as a regression guard.
7. Treat 429 quota exhaustion as a hard stop. Do not use paid API/Vertex/pay-as-you-go fallback. Avoid immediately rerunning quota failures.

## Review request

Please challenge this workaround. In particular check whether the alias + runtime-stat verification is the safest minimal fix, whether model routing/sub-agents can make `stats.models` ambiguous, and whether a direct free-tier REST call would be safer than Gemini CLI until the upstream fix ships.
