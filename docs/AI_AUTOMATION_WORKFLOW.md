# JENIFY OS AI Automation Workflow

## Goal
Reduce Founder involvement in routine engineering while keeping irreversible, paid, production, security, and compliance decisions under explicit Founder control.

## Shared source of truth
GitHub is the technical source of truth for code, commits, branches, pull requests, issues, and CI results.

## Roles
- **Claude Code** — primary implementation engineer on the local repository; builds, tests, refactors, and commits.
- **Jules** — independent cloud engineer/reviewer; works from the GitHub repository and should normally use isolated branches/PRs.
- **ChatGPT** — architecture, product decisions, independent review, PR/CI inspection, disagreement resolution, and task routing.
- **Founder** — business/product authority and approval gate for high-impact actions.

## Default execution loop
1. A task is recorded in GitHub with objective and acceptance criteria. Opening an `[AI TASK]` issue automatically starts the Claude "AI WORKERS" routine via the trigger bridge (`.github/workflows/ai-task-trigger.yml` — setup and re-trigger rules in `docs/AI_TASK_ROUTINE_TRIGGER.md`).
2. Primary worker implements on a non-main branch.
3. Worker runs relevant local tests before pushing.
4. A pull request is opened against `main`.
5. JENIFY CI automatically installs locked dependencies, runs tests, and builds all workspaces.
6. An independent AI reviews material changes when useful.
7. ChatGPT compares implementation, CI, and reviewer evidence and records PASS or CHANGES REQUESTED.
8. Routine low-risk work may proceed after gates pass; high-impact actions escalate to the Founder.
9. GitHub remains the durable record; do not rely on chat history as the only record of engineering state.

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
- sector-specific behavior versus reusable core primitives.

## Cost rule
The automation is designed to use existing subscriptions and free/included GitHub capabilities. Do not introduce separately billed model APIs or other paid services without explicit Founder approval.

## Current limitation
This is not yet a fully autonomous model-to-model message bus. GitHub provides the shared technical state and automation gates; Claude, Jules, and ChatGPT still have different execution environments. The workflow should minimize Founder message-carrying by putting tasks, PRs, CI evidence, and review outcomes in GitHub whenever possible.
