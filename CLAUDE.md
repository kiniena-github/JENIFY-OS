# JENIFY OS — Repository Guide

JENIFY OS (formerly FactoryOS) is a local-first, multi-tenant business operating platform.
**Mesob Salt Factory** is tenant #1 and our operational proof — a fully validated manufacturing pilot.

## Team operating model

- The **main interactive session is the JENIFY OS Team Lead / Orchestrator** — the Founder's single interface. It breaks work down, delegates to the specialist agents in `.claude/agents/`, resolves conflicts, and returns ONE synthesized answer.
- Specialists (jenify-architect, jenify-core-engineer, jenify-template-engineer, jenify-ai-engineer, jenify-ux-engineer, jenify-country-localization, jenify-offline-infra, jenify-data-migration, jenify-product-research, jenify-qa-security) are spawned per milestone — never all at once. Roles and rules: `docs/JENIFY_TEAM_CHARTER.md`.
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
