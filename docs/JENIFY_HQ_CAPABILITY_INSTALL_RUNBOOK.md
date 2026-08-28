# JENIFY HQ Capability Installation Runbook

This is the execution runbook for the Founder-approved capability stack. It deliberately separates **project configuration**, **local machine installation**, **account authentication**, and **billable activation**.

## Already configured in the repository

`.claude/settings.json` registers and enables these project plugin collections:

- Anthropic `anthropics/skills` → `example-skills` (includes Frontend Design and Skill Creator)
- WondelAI `wondelai/skills` → `ux-design` and `product-innovation`
- GreenSock `greensock/gsap-skills` → `gsap-skills`

When Claude Code trusts the repository, it may still require the normal local marketplace/plugin trust/install step. That local state must be verified on the actual machine.

## Local-only install candidates

These commands are examples for the actual Founder/authorized machine. Do not run them in CI just to claim the capability exists.

### UI/UX Pro Max

```bash
npm install -g ui-ux-pro-max-cli
uipro init --ai claude --global
```

Before running: inspect the current upstream release and installer. No credentials should be required.

### 21st

```bash
npm i -g @21st-dev/cli
21st login
npx @21st-dev/cli install-skill
```

`21st login` is an account/authentication gate. Free search/install allowance does not authorize AI-credit purchases or paid membership. Do not auto-spend.

### NotebookLM MCP

Community/experimental path:

```bash
pip install "notebooklm-py[mcp]"
notebooklm login
notebooklm mcp install claude-code
```

Authentication is a Google-account gate. The adapter uses unofficial/undocumented behavior, so review current upstream/security guidance first. Never commit its local credentials or session material.

## Project libraries

Motion/GSAP runtime libraries should be added only to a project that actually needs them. Do not add animation dependencies to every Jenify project merely because HQ knows about them.

## Reference websites

Mobbin, Awwwards, Cosmos, Pinterest, NameThatUI, Skiper UI, Vengeance UI and Animmaster require no HQ software installation just to remain approved reference sources. HQ must not call them “connected” unless a real reviewed connector later exists.

## Paid/usage-gated capabilities

Do not automatically purchase/activate credits, subscriptions, API billing or paid tiers for:

- 21st AI/beyond free allowance
- ChatCut
- Atoms paid tiers
- Seedance-provider usage
- Nano Banana API usage
- Hyliox
- Animmaster paid access
- any hosted/local model compute that creates new material spend

A separate Founder spend decision is required at the point billable use is actually needed.

## Verification checklist after local setup

For each installed capability, record only evidence that can actually be proved:

1. exact tool/plugin name and version/commit where available;
2. source/upstream;
3. installed scope (project/user/local);
4. authentication state without exposing tokens;
5. whether a real no-side-effect probe succeeds;
6. whether usage is free, existing-subscription, or billable;
7. any security/permission limitation;
8. test task proving the capability is actually invoked;
9. rollback/uninstall command.

Only after those checks may the live Connection Center describe the capability as genuinely available/connected.
