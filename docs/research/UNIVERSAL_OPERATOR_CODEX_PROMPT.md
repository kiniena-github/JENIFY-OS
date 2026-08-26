# Codex Independent Architecture Assignment — Jenify Universal Operator

Founder-approved research/design mission. Analysis only. Do not deploy, merge to main, spend money, enable paid APIs, or make production/destructive changes.

## Context
Jenify Labs wants a hybrid Universal Operator so a single Founder command can be routed to the right AI/tool and executed across cloud workers, one or more local PCs, browser/desktop apps, media/GPU tools, and later hardware/robotics workflows. Existing workers include ChatGPT, Claude, Gemini 3.7 Flash, Jules, and Codex. GitHub is already used as a task/evidence bus.

Default policy: ZERO additional cost first. Use existing subscriptions, free/open-source/local/free-tier infrastructure. No paid AI API. Any spending requires explicit Founder approval.

## Current seven-phase concept
1. Universal Task Router — intake and routing to Claude/Gemini/Jules/Codex/cloud/local PC/etc.
2. Cloud Operator — always-on lightweight dispatcher/queue/status layer, preferably free-tier.
3. Local PC Operator — dedicated PC/laptop as the hands for browser, files, scripts, desktop apps, downloads/uploads.
4. Browser + Logged-in Services — safe use of already-authenticated browser sessions for Flow/Veo/web dashboards, with manual login and no password automation.
5. Media / GPU / Heavy Work — Blender, FFmpeg, ComfyUI/local models, video/audio/3D pipelines; local compute first, paid GPU only with explicit approval.
6. Multi-Machine Operator Network — optional coding/media/hardware machines, chosen automatically by the router.
7. Full Jenify Universal Operator — end-to-end execution from one command with research, build, test, browser/desktop actions, evidence, and result return.

## Assignment
Provide an INDEPENDENT technical plan. Do not merely review this file or agree with the phases. Challenge, merge, split, reorder, or replace them if that gives a faster, safer, higher-quality design.

Address all seven phases and answer:
- What should the final architecture be?
- Which workstreams can run in parallel?
- Fastest realistic path to a useful V1?
- Fastest realistic path to a high-quality production-grade system?
- Optimistic and realistic elapsed-time estimates for V1 and full capability, assuming AI coding workers can work in parallel and the Founder only intervenes for approval/login/physical-machine steps.
- What is the critical path, and what should NOT block V1?
- Exact free/open-source technologies or patterns for routing, queue/state, secure cloud-to-local connection, browser/desktop automation, local runtime, evidence/observability, retries, secrets, sandboxing, and multi-machine scheduling.
- How cloud and local PC should cooperate when the local PC is asleep/offline.
- How authenticated browser services should be automated without exposing passwords/cookies/tokens.
- How to isolate untrusted web content/prompt injection from privileged actions.
- How approvals should work so routine safe work is fast while spend/deploy/destructive/security-sensitive actions stop for Founder approval.
- How to use Claude/Gemini/Jules/Codex without wasteful duplication.
- What is local-first vs cloud-first?
- Biggest reliability/security risks and mitigations.
- Acceptance tests for each phase.
- What to postpone until after V1.
- Recommended day-by-day or milestone-by-milestone build order optimized for speed AND quality.

## Constraints
- No paid AI API.
- No extra recurring cost by default.
- Existing subscriptions/free tiers allowed.
- Prefer local/open source where practical.
- No production deployment/destructive action in this task.
- Do not assume one always-on local PC is the whole system; support cloud coordination plus one or more local machines.
- Fastest possible build without creating a fragile architecture that needs a rewrite.

## Required response
1. Executive verdict
2. Revised roadmap
3. Architecture/components
4. Parallel workstreams
5. Fastest V1 timeline
6. Full-system timeline
7. Phase acceptance tests
8. Major risks + mitigations
9. Zero-extra-cost stack
10. Top five Founder decisions before implementation

Separate assumptions from recommendations. Be specific and practical.