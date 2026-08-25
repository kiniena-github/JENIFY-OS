# JENIFY OS AI Automation Workflow

## Goal
Reduce Founder involvement in routine engineering and research while keeping irreversible, paid, production, security, and compliance decisions under explicit Founder control.

## Shared source of truth
GitHub is the technical source of truth for code, commits, branches, pull requests, AI tasks, AI reports, and CI results. Google Drive is the long-term company knowledge/archive layer.

## Roles
- **Claude Code / AI WORKERS** — primary engineering execution: builds, tests, refactors, reviews, and works on branches/PRs.
- **Google research lane** — independent research, market/competitor/regulatory/technical intelligence, verification, and challenge. The automatic GitHub lane is research-only.
- **Jules** — optional independent cloud engineer/reviewer; works from the GitHub repository and should normally use isolated branches/PRs.
- **ChatGPT** — command center: architecture, product decisions, task routing, cross-model comparison, PR/CI inspection, disagreement resolution, and final review.
- **Founder** — business/product authority and approval gate for high-impact actions.

## AI task routing
ChatGPT records approved work as an owner-authored GitHub issue using one of these prefixes:

- `[AI TASK]` — Claude legacy/default.
- `[AI TASK][CLAUDE]` — Claude only.
- `[AI TASK][GEMINI]` — Google research lane only.
- `[AI TASK][BOTH]` — Claude and Google independently.

Opening a routed issue is the wake-up signal. The Founder should not have to carry prompts or reports between AI products.

Detailed bridge contract: `docs/JENIFY_AI_TEAM_BRIDGE.md`.

## Default execution loop
1. ChatGPT discusses/decides the task with the Founder when needed, then records the approved objective and acceptance criteria in one routed GitHub issue.
2. GitHub automatically wakes the selected worker(s): Claude through `.github/workflows/ai-task-trigger.yml`; Google through `.github/workflows/ai-task-gemini.yml`.
3. Research/review workers post their marked report back to the same issue. Claude implementation work uses a non-main branch and PR.
4. Worker runs relevant tests before pushing implementation.
5. JENIFY CI installs locked dependencies, runs tests, and builds applicable workspaces.
6. Independent AI review is used where material risk or disagreement justifies it.
7. ChatGPT reads the actual GitHub issue/PR/CI evidence, compares Claude and Google when both were routed, and records PASS, CHANGES REQUESTED, or a business decision.
8. Routine low-risk work may proceed after gates pass; high-impact actions escalate to the Founder.
9. Important final research/decisions may be archived to Google Drive; GitHub remains the durable technical record.

## Founder-only gates
The workflow must stop and ask the Founder before:
- production deployment;
- enabling a new paid API, paid cloud service, subscription, or usage-based billing;
- destructive migrations or direct production-data changes;
- material security-architecture changes with irreversible impact;
- government/official integration commitments;
- unsupported tax/regulatory/compliance claims;
- major product-direction changes;
- other genuinely irreversible or high-impact actions.

## Main-branch rule
AI workers should not make routine feature changes directly on `main`. Use an isolated branch and pull request so CI and independent review can happen before acceptance.

## Review standard
A reviewer should challenge the change rather than merely summarize it. Check, as relevant:
- correctness and regression risk;
- tenant isolation and permissions;
- stock and financial integrity;
- concurrency and idempotency;
- offline behavior;
- performance and mobile budget;
- security and information leakage;
- duplicated capabilities or architectural drift;
- sector-specific behavior versus reusable core primitives;
- factual/source quality for research claims;
- disagreement between AI workers and why it exists.

## Cost rule
The automation is designed to use existing subscriptions and free/included GitHub/Google capabilities. Do not introduce separately billed model APIs or other paid services without explicit Founder approval.

The Google GitHub automation must use an AI Studio project with billing disabled unless the Founder explicitly approves a paid Google path. Exhausted free quota should stop the Google lane, not silently fall back to billing.

## Current platform boundary
Claude Max can be awakened PC-off through the existing Claude Code Routine fire endpoint once its private Routine token is valid. Google's paid AI Pro developer-agent access moved to Antigravity in June 2026; Antigravity consumer sign-in is currently interactive and is not a supported fresh-environment CI credential. Therefore the PC-off Google automation lane currently uses free AI Studio quota, while paid Google AI Pro remains available for Gemini app/Deep Research/NotebookLM/Antigravity work. See `docs/JENIFY_AI_TEAM_BRIDGE.md` for the migration rule.
