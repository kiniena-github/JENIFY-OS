# JENIFY OS — Repository Guide

JENIFY OS (formerly FactoryOS) is a local-first, multi-tenant business operating platform.
**Mesob Salt Factory** is tenant #1 and our operational proof — a fully validated manufacturing pilot.

## Team operating model

- **Exactly ONE session is the JENIFY OS Team Lead / Orchestrator** — the Founder's single interface. It breaks work down, delegates to the specialist agents in `.claude/agents/`, resolves conflicts, and returns ONE synthesized answer. No second command center; no agent or session runs milestones independently.
- The unified 24-agent structure (Founder-approved 2026-08-21): the 10 `jenify-*` specialists are the official team, spawned per milestone — never all at once; the 14 additional domain agents are deeper specialists the Team Lead calls when useful (`lead-architect` is a subordinated integration reviewer; `jenify-ai-qos` is future-planned/inactive until the AI milestone; four future-domain agents are design-only). Full roles, classification, and rules: `docs/JENIFY_TEAM_CHARTER.md`. Canonical defects register: `docs/FACTORY_OS_CURRENT_STATE.md` §5.
- Founder-approved decisions live in `docs/JENIFY_DECISIONS.md`; direction in `docs/JENIFY_ROADMAP.md`; completed state in `docs/JENIFY_EXECUTION_LOG.md`. Read these before large work; append to them after it.

## Non-negotiable principles

1. **FAST, SIMPLE, FLEXIBLE, LOCAL, INTELLIGENT** — every feature is judged against these five.
2. **Protect the Mesob pilot.** No experiment may casually break it. The full test suite (`npm test` → packages/server, currently 163 tests) must stay green; never claim success with failing or skipped tests.
3. **Core vs config.** Reusable capabilities live in platform packages (`@factoryos/shared`, `server`, `web`); tenant physics live in configuration packages (`packages/config-mesob`). No tenant literals in core. (Internal `factoryos` identifiers are legacy-stable — do not rename them; public branding is JENIFY OS.)
4. **Never fabricate business rules.** Make it configurable or report the open question.
5. **Immutable operations.** Posted transactions are never hard-deleted or silently edited: cancel / reverse / audited correction only. Stock balances derive from the append-only ledger.
6. **AI safety.** Any AI layer goes: natural language → intent → structured action → permission check → validation → preview/confirm → execution → audit. AI never bypasses permissions, invents facts, or acts outside approved APIs.
7. **Local only. No deployment, no paid external services** without explicit Founder approval.
8. **Founder data is sacred.** Never reset `data/factoryos.sqlite`; back up before risky work; go-live tenants are provisioned fresh via the explicit approved-selection initializer (`packages/config-mesob/src/init-production.ts`, dry-run by default).

## Repo facts

- npm workspaces: `packages/shared` (types/helpers), `packages/server` (Fastify + better-sqlite3 + Drizzle; migrations in `packages/server/migrations`), `packages/web` (React + Vite, route-split), `packages/config-mesob` (all Mesob specifics + live-DB scripts).
- Dev: `npm run dev` → web http://localhost:5173, API :3001. Tests: `cd packages/server && npx vitest run`. Type checks: `npx tsc --noEmit` per package. Build: `cd packages/web && npx vite build` (initial JS budget ≈ 214 kB / 69 kB gzip — do not regress code splitting).
- Quantities are integer milli base-units; money is integer cents in the tenant default currency; per-domain settings are append-only versioned.
- Credentials: `data/mesob-logins.txt` is gitignored dev-only; passwords are hashed; no plaintext secrets in the repo — keep it that way.

## GitHub automation bridge

The Team Lead remains the one local Claude command center. GitHub is the external coordination bridge shared with ChatGPT, Jules, CI, and the Founder.

### At the start of work

1. Inspect `git status` and preserve any existing local work. Never discard, reset, stash, or overwrite Founder/other-agent changes merely to synchronize.
2. If the tree is clean and `origin` is available, synchronize safely with `git fetch origin` and `git pull --ff-only origin main` before starting a new task.
3. Read the latest relevant open GitHub `[AI TASK]` issue and existing PR discussion when GitHub CLI/access is available. If the Founder says **“check and do”** or **“continue”**, treat the highest-priority approved GitHub task as the default intake unless the Founder explicitly names another task.
4. Respect every Founder-only gate in `docs/AI_AUTOMATION_WORKFLOW.md`.

### While implementing

1. Do routine feature/fix work on a non-`main` branch, normally `ai/<issue-number>-<short-slug>` or `claude/<short-slug>`.
2. Keep the internal Claude specialist/team workflow unchanged: the Team Lead delegates, synthesizes, tests, and remains responsible for the final local engineering result.
3. Run the relevant tests, type checks, build, regression checks, and red-team/security checks required by the change. Do not claim success from code inspection alone.
4. Never deploy, enable paid APIs/services, perform destructive production/data migrations, or make Founder-gated commitments automatically.

### When work is ready

1. Commit the coherent tested change and push the branch to `origin`.
2. Open or update a pull request to `main` using `.github/pull_request_template.md` when GitHub CLI/access is available.
3. Put the completion evidence in the PR: what changed, tests/build results, risk, known limitations, and any unresolved decision.
4. Leave the PR for independent CI/ChatGPT/Jules review. **Do not merge your own material feature PR merely because local tests passed.**
5. If a reviewer requests changes, treat the PR discussion as the next technical input, fix on the same branch, re-test, push, and update the PR.
6. Once an accepted PR is merged by the review/coordination layer, synchronize local `main` before starting the next task.

### Founder interruption policy

Do not stop the Founder for routine technical choices that can be resolved safely by evidence, existing decisions, tests, or independent review. Escalate only when a genuine Founder-only gate, material unresolved product choice, irreversible/high-impact action, or external blocker is reached.
