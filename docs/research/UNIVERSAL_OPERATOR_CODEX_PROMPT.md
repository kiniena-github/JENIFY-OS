# Jenify Universal Operator — Candidate Architecture for Codex Challenge Review

Founder-approved research/design only. Do not merge to main, deploy, spend money, enable paid APIs, or make production/destructive changes.

This document is intentionally a concrete candidate architecture so Codex can challenge it. Review it as architecture/security/reliability, not style. Identify wrong assumptions, missing failure modes, unsafe boundaries, and timeline problems.

## Goals and constraints
- One Founder command from ChatGPT can route work to existing Claude, Gemini, Jules, Codex review, cloud automation, or one/more local machines.
- Zero additional recurring cost by default. Existing subscriptions, GitHub, local PCs, free/open-source tools, and free tiers first.
- No paid AI API. No spend/deploy/destructive/security-sensitive action without Founder approval.
- Local browser sessions and machine credentials must stay local.
- Design for one local PC first but allow N machines without a rewrite.

## Candidate architecture

### Phase 1 — Deterministic task router + task contract
Use GitHub Issues as the control plane and queue. Extend existing routed AI task patterns with a structured operator task block containing task id, requested capability, inputs, output/evidence spec, risk class, retry policy, and approval requirement. Use deterministic rules first; ChatGPT may choose the route at intake. Do not build an autonomous LLM router for V1.

Candidate states: `op:queued`, `op:claimed`, `op:running`, `op:needs-founder`, `op:done`, `op:failed`, `op:cancelled`. Candidate capability labels: `cap:shell`, `cap:files`, `cap:ffmpeg`, `cap:blender`, `cap:browser`, `cap:gpu`.

### Phase 2 — Reuse GitHub as cloud operator, no bespoke server initially
GitHub Issues = durable queue/state/audit; Actions = cloud triggers; comments/artifacts = evidence. Do not add a new Cloudflare/Fly/VPS dispatcher until measured GitHub limitations require one.

### Phase 3 — Pull-based local PC agent
A Python service/daemon on Windows polls GitHub over outbound HTTPS, advertises capabilities/heartbeat, atomically claims eligible work, creates a fresh per-job workspace, executes only registered job handlers, redacts evidence, posts status/results, and releases the lease. No inbound port is required. If the PC sleeps/offline, work stays queued.

Security baseline: dedicated low-privilege OS user; fine-grained GitHub credential stored in Windows Credential Manager/DPAPI; job workspaces scoped to configured roots; deny arbitrary shell by default; kill switch; lease expiry; idempotency key; max retries.

### Phase 4 — Browser operator behind stricter gates
Use Playwright with a dedicated persistent browser profile on the local machine. Founder performs login manually. Cookies/passwords/storage state never get uploaded. Site and action allowlists. Browser page text is untrusted data and cannot directly create privileged machine actions. New site/action classes require Founder approval until deliberately promoted to routine-safe automation.

### Phase 5 — Media/GPU as pluggable local job handlers
Treat FFmpeg, Blender headless, image/audio tooling, and later ComfyUI/local models as capability plugins rather than a separate orchestration system. Use local GPU/CPU first. Any paid remote GPU is a separate Founder-approved execution target, never silent fallback.

### Phase 6 — Multi-machine scheduling using same agent
Every agent has an id, capability set, heartbeat, current lease, and optional resource metadata. Eligible workers pull; one wins the claim and verifies ownership before execution. Prefer simple first-eligible scheduling at low volume; add priorities/resource-aware scheduling only after evidence of need.

### Phase 7 — End-to-end Universal Operator outcome
ChatGPT intake → structured task → cloud AI planning/review if needed → local deterministic execution → evidence → independent review/acceptance → Founder-facing result. Build DAG/workflow composition only after single-step jobs are reliable.

## Candidate approval/risk model
- Risk 0 read-only/local analysis: routine auto-run.
- Risk 1 reversible file creation/rendering inside approved workspaces: auto-run for known job types.
- Risk 2 authenticated browser actions, external uploads/posts, repo writes, new command/site capability: `op:needs-founder` unless a specific action class was pre-approved.
- Risk 3 spending, production deploy, destructive deletion, secrets/permission/security changes: always Founder approval.

LLMs plan; deterministic code acts. Untrusted web text must never be concatenated into shell commands or treated as authority to expand permissions.

## Candidate implementation stack
- Control plane / queue / audit: GitHub Issues, labels, Actions, comments.
- Local runtime: Python 3 with typed job schemas; Windows Task Scheduler/service for autostart.
- GitHub transport: REST/GraphQL over outbound HTTPS with conditional polling/backoff.
- Browser: Playwright.
- Media: FFmpeg + Blender CLI; ComfyUI/local AI later.
- Local secrets: Windows Credential Manager/DPAPI; never GitHub issues/logs.
- Sandboxing: low-privilege account + strict workspace roots + allowlisted handlers for V1; evaluate WSL2/Docker where isolation materially helps.
- Evidence: structured JSON result + sanitized logs + hashes; small artifacts via GitHub, large artifacts local or existing Drive path/manifest.
- Multi-machine: capability labels + heartbeat + lease/claim protocol.

## Candidate speed plan
- V0 technical proof: 1–2 days — GitHub task → one local agent → one safe file/FFmpeg action → evidence back.
- Useful V1: optimistic 4–7 elapsed days; realistic 2–3 weeks. Includes state machine, local agent, leases/heartbeat, safe job registry, FFmpeg/file handlers, redaction, tests, kill switch.
- Browser operator: start design in parallel, integrate after local agent is stable.
- High-quality full system incl. browser, second machine, media plugins, hardening/red-team: optimistic 4–6 weeks; realistic 8–12 weeks.

## Candidate parallel workstreams
1. Task schema/state/approval contract.
2. Local agent core + mocked GitHub tests.
3. Safe job-handler SDK + FFmpeg/files/Blender wrappers.
4. Browser security design and hostile-content test suite.
5. Evidence/redaction/chaos tests.
6. Multi-agent lease tests (design now, deploy later).

## Acceptance requirements
- Malformed/untrusted task cannot execute.
- Non-owner/unapproved task cannot cross risk gates.
- Two agents cannot execute same non-idempotent task.
- Offline PC preserves queue and reports stale heartbeat.
- Mid-job process death expires lease and retries only within policy.
- Job cannot read/write outside allowed workspace unless explicitly authorized.
- Seeded secret never appears in issue comments/logs/artifacts.
- Browser hostile page cannot cause navigation/action outside declared task and allowlist.
- Browser auth survives restart without moving credentials to cloud.
- GPU/media work routes only to capable worker.
- End-to-end demo produces complete audit/evidence trail.

## Questions for Codex
Please identify architecture-level issues and give concrete alternatives. In particular:
1. Is GitHub-as-control-plane safe/reliable enough for V1, or is there a blocking reason to add a separate cloud queue now?
2. Is pull-based local execution with leases/heartbeats sufficient to prevent duplicate or stale execution? What exact race needs handling?
3. What is missing from the prompt-injection/secrets model?
4. Is Python/Playwright a sound zero-cost choice here?
5. Which parts of the 4–7 day optimistic V1 are unrealistic or dangerously compressed?
6. Which of the original seven phases should be merged/reordered?
7. What should be postponed to maximize speed without forcing a rewrite?
8. List any P0/P1 blocking flaws and your preferred correction.

Do not suggest paid AI APIs or production deployment.