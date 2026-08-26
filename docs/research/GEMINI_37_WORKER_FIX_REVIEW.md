# Gemini 3.7 worker routing fix — reviewed decision

Status: implementation on branch for review/testing. Do not merge until Founder approval.

## Root cause

The Jenify Gemini workflow correctly configured `gemini-3.7-flash`, but Gemini CLI `0.55.1` has a confirmed upstream P1 resolver bug: explicit bare Flash IDs shaped like `gemini-<X.Y>-flash` can be silently rewritten to `gemini-3.5-flash`.

Upstream evidence: google-gemini/gemini-cli issue #28859 reproduces `gemini-3.7-flash -> gemini-3.5-flash` with an API key that can serve 3.7 correctly over raw REST. The issue also reports the bug in the then-current preview/nightly builds. Upstream fix PR #28893 (`fix(core): preserve explicit flash model IDs`) remains open as of 2026-08-26.

The issue #23 failure is consistent with that bug: our configuration said 3.7, while Google's quota error named `gemini-3.5-flash`.

## Independent review

- **Codex:** rejected the initial `gemini-flash-latest` + membership-only `stats.models` guard as insufficient. `stats.models` can aggregate multiple model calls; the safer temporary path is the exact free-tier REST model endpoint with server-returned `modelVersion` verification.
- **Claude:** independently recommended server-attested model verification and strict 429/503 handling. Claude also noted that CLI routing/internal helper calls can consume other model quotas, so configuration alone is not a trustworthy proof of the served model.
- **Jules:** initially proposed adding `settings.model.name`; upstream #28859 shows settings-level self-mapping does not fix this resolver bug, so that proposal was challenged and must not be merged as the final fix.

## Chosen temporary fix

Until Google's CLI fix ships in a stable release:

1. Keep the existing AI Studio key with **billing disabled**. No Vertex, no pay-as-you-go, no paid fallback.
2. Bypass Gemini CLI for this automated lane.
3. Call the exact `gemini-3.7-flash:generateContent` REST endpoint once per task.
4. Require the Google server's `modelVersion` to start with `gemini-3.7-flash`; reject any mismatch.
5. Treat HTTP 429 as a quota stop and HTTP 503 as temporary capacity failure. Do not silently switch models.
6. Use URL Context only for explicit public URLs supplied in the task. Google Search grounding is not available on the Gemini 3.7 Flash free API tier, so broader web discovery must be supplied separately rather than paid for or guessed.
7. Surface the server-attested model in the posted GitHub result.
8. When upstream #28893 lands in a stable Gemini CLI release, re-evaluate returning to the official CLI action; retain server-side verification as a regression guard.

## Why this is stronger

This removes the buggy CLI model resolver and its multi-turn/internal fallback behavior from the automated path. One task becomes one model request, which also reduces free-tier request consumption. The exact REST endpoint plus `modelVersion` makes the model identity auditable rather than inferred from client configuration.

## Remaining limitation

This free automated lane is an **independent intelligence/review worker**, not a general fresh-web search engine. It can analyze task data and explicit public URLs through URL Context. Full Google Search grounding for Gemini 3.7 is not available on the free API tier. A future subscription-authenticated persistent operator can be evaluated separately if we want to use Google AI Pro's interactive capabilities without paid API billing.
