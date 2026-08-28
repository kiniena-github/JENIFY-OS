# JENIFY HQ Capability Stack

Status: **Founder-approved capability policy**. This document and `packages/headquarter/src/registry/capability-stack.ts` define what HQ may consider using. They do **not** prove that a tool is installed, authenticated, connected, licensed, funded, or currently available.

## 1. Architecture

HQ is the control center. Capabilities are deliberately separated by type:

- **Agents** — Claude Code, Antigravity, future local models/workers.
- **Skills** — reusable specialist guidance such as Frontend Design, UI/UX Pro Max, Refactoring UI, UX Heuristics, GSAP skills, Design Sprint, Hooked UX, iOS HIG, and Skill Creator.
- **MCP/connectors** — controlled bridges such as 21st and NotebookLM. A catalog entry never means the connector is live.
- **Reference sources** — Mobbin, Awwwards, Cosmos, Pinterest, NameThatUI, Skiper UI, Vengeance UI, Animmaster. These are inspiration/reference sources, not trusted data connectors.
- **Libraries** — Motion and project-specific animation/UI code libraries.
- **Media/model capabilities** — Nano Banana 2, Seedance 2, MiniMax H3, ChatCut, and later local Qwen options.
- **Governance** — canonical `CLAUDE.md`, Founder gates, approval/clarification rules, exact provider identity, evidence, and the Universal Operator.

The existing live Connection Center/provider evidence layer remains the only authority for runtime connection state. The capability catalog may narrow routing; it cannot grant Operator permission or widen execution authority.

## 2. Default premium web workflow

For a serious website/UI build, HQ should prefer this order when the required capabilities are genuinely available:

1. **Reference** — Mobbin / Awwwards / Cosmos / Pinterest / NameThatUI as useful.
2. **Design direction** — Anthropic Frontend Design + UI/UX Pro Max.
3. **Components** — 21st first; Skiper UI and Vengeance UI as secondary references.
4. **Animation** — Motion and/or GSAP only where motion improves the experience.
5. **Build** — the assigned coding worker, normally Claude Code or another explicitly routed worker.
6. **Audit** — Refactoring UI + UX Heuristics before release.
7. **Institutionalize** — when a pattern is repeatedly useful, Skill Creator may turn it into a tested Jenify-owned skill.

This is a recommendation recipe, not a bypass. Project rules, live availability, permissions, spend gates, security review, tests, accessibility, performance and independent review still apply.

## 3. Cost and account rules

- **Never auto-spend.** `paid_optional`, `usage_billed`, and `mixed` capabilities require a Founder spend decision before billable use.
- A free tier does not authorize upgrading to a paid tier.
- A model with free/open weights can still create GPU, storage, electricity, hosting or operational cost.
- Account-required capabilities are not auto-selected merely because their software/config exists.
- Existing subscriptions may be used only inside their existing authorized terms; separately metered API usage is a separate gate.

## 4. Community / external code rules

Community skills, MCP servers, installers and CLIs are untrusted external code until reviewed. Before installation or update:

1. verify the exact upstream repository;
2. inspect installer/scripts and requested permissions;
3. avoid stale forks/reposts;
4. do not put secrets in the repository, prompts, logs or evidence;
5. prefer least-privilege/local scopes;
6. keep third-party auto-update off unless explicitly accepted;
7. rerun relevant tests after any project-level integration.

NotebookLM MCP is specifically treated as **community + experimental** because it relies on unofficial/undocumented integration behavior. It must never imply Google authentication from package presence alone.

## 5. Naming / deprecation rules

- `Magic MCP` resolves to **21st MCP**; do not install a second legacy path.
- `Framer Motion` resolves to current **Motion** naming.
- TikTok/social demos are evidence candidates, not source-of-truth installation instructions.

## 6. Project Claude skill configuration

`.claude/settings.json` registers reviewed marketplaces for:

- `anthropics/skills` — official Anthropic example skills including Frontend Design and Skill Creator;
- `wondelai/skills` — community UX/product skills including Refactoring UI, UX Heuristics, Hooked UX, iOS HIG and Design Sprint;
- `greensock/gsap-skills` — official GSAP agent skills.

Anthropic marketplace auto-update is enabled. Third-party marketplaces are deliberately not auto-updated.

Project configuration can make a skill available to Claude Code, but runtime installation/trust prompts on a machine remain a real local state and must be reported truthfully.

## 7. What is deliberately NOT done by this policy layer

- no claim that 21st, NotebookLM, ChatCut, Atoms, Google tools or any provider is connected;
- no API keys/OAuth tokens/passwords stored;
- no paid plan purchased or usage billing enabled;
- no production deployment;
- no automatic browsing/scraping of reference sites;
- no local heavyweight model download;
- no weakening of Founder approval, provider identity, Registry, Operator, fencing, idempotency, evidence or independent review.

## 8. Source of truth

Machine-readable policy: `packages/headquarter/src/registry/capability-stack.ts`.

Runtime truth: the existing HQ Connection Center/provider evidence layer.

Execution authority: the existing Registry + Universal Operator + Founder approval system.
