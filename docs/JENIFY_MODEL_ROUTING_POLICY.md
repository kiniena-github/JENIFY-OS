# Jenify Labs AI Model Routing Policy

Status: Founder-approved operating rule.

## Core rule

Every automated or manually dispatched AI worker must use the strongest approved model for its vendor lane first, with an explicit fallback order. A worker must never silently downgrade to another model.

Every result report must include:
- exact model requested;
- exact model actually used;
- whether fallback occurred;
- fallback reason;
- whether the result should be rejected because the requested model policy could not be satisfied.

If the allowed priority list is exhausted, stop and report. Do not quietly substitute a weaker or unapproved model.

Family names such as **Fable** and **Opus** describe the approved model family priority. Reports should still include the exact configured/served identifier when the harness exposes one.

## Anthropic / Claude lane

Priority:
1. Fable
2. Opus
3. STOP and report if neither is available.

The Claude lane must not execute tasks explicitly routed to Codex, Jules, Gemini, or another named worker.

Current Claude Routine limitation: unlike the Gemini lane, the Claude routine does not expose an independent server-side model-attestation field. Claude reports the saved routine configuration plus any surfaced fallback event. This must be labeled as configuration/self-report evidence rather than falsely described as server attestation.

## OpenAI lane

Priority:
1. strongest Founder-approved OpenAI/Codex model available under the current approved plan/workflow;
2. next-best explicitly approved OpenAI model;
3. STOP and report if no approved model is available.

Do not introduce a separately billed OpenAI API or usage-based service without new Founder approval.

## Google lane

Priority:
1. strongest Founder-approved Google/Gemini model available under the current approved subscription/free lane;
2. next-best explicitly approved Google model;
3. STOP and report if no approved model is available.

For exact-pinned automated lanes that expose server/model attestation, attestation remains mandatory. Never fall back to a paid API or a different model silently.

## Worker identity rule

A route label is an identity contract:
- `[CLAUDE]` must be Claude.
- `[CODEX]` must be a real OpenAI/Codex lane or remain unexecuted.
- `[JULES]` must be a real Jules lane or remain unexecuted.
- `[GEMINI]` must be Gemini.

Any unknown or future bracketed worker tag must default to **not Claude** unless that route is deliberately added. No worker may impersonate another named worker merely because a generic automation caught the issue.

## Review independence

The model/worker that implements a material change cannot be the sole final reviewer of that same change. Review evidence must identify the real worker/model that performed the review.

## Cost rule

The permanent default remains zero-extra-cost execution: use existing subscriptions, included quotas, free tiers, local/open-source tools, and approved infrastructure first. No separately metered AI API, paid fallback, or new subscription is allowed without Founder approval.
