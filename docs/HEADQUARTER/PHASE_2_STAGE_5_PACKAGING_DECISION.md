# JENIFY HQ — Phase 2 Stage 5 Packaging Decision

Date: 2026-09-05
Status: DECIDED
Founder direction: proceed with Stage 5 evaluation; do not introduce paid services or production changes.

## Decision

**Keep JENIFY HQ inside the current JENIFY-OS monorepo for now. Do not split HQ into a separate GitHub repository in Phase 2.**

This is a packaging decision, not a statement that HQ is merely a feature of JENIFY OS. HQ remains a first-class Jenify product with its own runtime boundaries.

## Evidence from the current repository

The current workspace already separates HQ into first-class components:

- `packages/headquarter` — HQ core, contracts, application/routing/live/store/client and Founder-facing UI logic.
- `packages/hq-host` — HQ's own HTTP host; depends on `@factoryos/headquarter` and no other JENIFY OS workspace package.
- `apps/hq-server` — standalone HQ process; boots HQ without the tenant platform.

The root workspace lists these as explicit workspaces, so package-level ownership and build boundaries already exist inside the monorepo.

Stage 0 also pinned the architectural boundary: the HQ core may not import sibling workspace packages or escape its package boundary. Current CI tests HQ and its host/server seams together.

## Why not split now

A separate repository would currently add coordination cost without creating a material product benefit:

1. **HQ already boots independently.** Repo separation is not required for a standalone runtime.
2. **The package boundary is already hard enough for this phase.** `@factoryos/headquarter`, `@factoryos/hq-host`, and `@factoryos/hq-server` are explicit units.
3. **One CI pipeline still has real value.** It catches drift between HQ core, host, identity/persistence seams, and the surrounding platform before merge.
4. **A split would create version-pinning and cross-repo synchronization work now, while the product boundary is still evolving.**
5. **No current security, access-control, release-cadence, repository-size, or ownership requirement forces a separate repository.**
6. **The decision stays reversible.** If the conditions below become true, history can be preserved with `git subtree split`; no copy-paste migration is needed.

## Conditions that WOULD justify a future split

Re-evaluate a separate HQ repository when one or more of these become materially true:

- HQ has an independent release/deployment cadence that is routinely blocked by the JENIFY OS repository.
- Different teams need access to HQ and JENIFY OS with materially different repository permissions.
- Security/compliance requires repository-level isolation rather than package/runtime isolation.
- Cross-repo consumers need a versioned HQ SDK/package contract and independent release lifecycle.
- Monorepo size or CI cost becomes a measurable bottleneck that package-scoped CI cannot solve.
- Desktop/web/product lifecycle work proves that HQ is operationally independent enough that the shared CI seam is no longer worth keeping.

Until then, **monorepo is the intentional architecture, not a temporary mistake.**

## Phase 2 outcome

Stage 5 does not require a code move, repository creation, hosting purchase, DNS change, production credential, paid API, or deployment.

With this decision recorded, the Phase 2 packaging/repository question is resolved:

> **HQ stays in the monorepo as a first-class product with explicit package/app boundaries. Repo split is deferred until evidence justifies it.**
