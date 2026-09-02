# JENIFY HQ - CURRENT STATUS

**Status date:** 2026-09-02  
**Purpose:** Live implementation handoff for humans and coding agents. This file changes frequently. It is not the architecture blueprint.

## 1. Current Mission

**LIVE HQ CONTROL V1** remains the active engineering proof mission.

Goal: prove a safe, truthful Founder -> HQ -> approval -> designated worker -> harmless external GitHub action -> result/evidence loop before declaring the HQ control foundation accepted.

**Final V1 is NOT accepted yet.**

## 2. Repository Truth

Repository: `kiniena-github/JENIFY-OS`

- `main`: `85184a3be819fe1dede2f320cf43c6bad8603a6e`
- PR #228: open, unmerged, mergeable
- PR #228 branch: `ai/225-connection-center-dispatch-truth`
- PR #228 base SHA: `85184a3be819fe1dede2f320cf43c6bad8603a6e`
- PR #228 head SHA: `52d057fea90b716a81921f5774a51057a28195c8`
- PR #228: 2 commits, 9 changed files

PR #228 contains two correction areas:
1. Connection Center live CLAUDE truth: `/hq/connections.html` uses the same live dispatch-availability seam as Command Center rather than misleading build-time workflow-secret presence.
2. Expired approval recovery: a real dispatch attempt with an expired approval can truthfully refuse external dispatch while returning the task to `needs_approval` for fresh approval without claiming/publishing/consuming the old approval.

## 3. CI / Test Truth

Latest exact-head GitHub Actions run for `52d057f...` is JENIFY CI run #374 and is failing.

Known cause from the correction round: an unrelated date-sensitive server test (`packages/server/test/commercial.test.ts`, credit status fixture) reads the real wall clock and flips after its fixture due date. HQ-local tests/typechecks/build passed in the correction round; the server suite reported one unrelated failing test.

Do **not** change business logic merely to make CI green. A narrow test-only date stabilization should be handled separately and only with explicit direction.

## 4. Safety / Authority Lock

Until Final V1 proof is complete:
- no automatic merge of PR #228
- no production deployment or DNS change
- no destructive rollback, force push or history rewrite
- no credential exposure/change unless explicitly authorized
- no blind retry of a possibly side-effecting external action
- one active coding builder per correction round
- workstation/browser proof must not be replaced by CLI-only claims

PR #225 was merged before full Founder-workstation Final V1 proof. Do not treat that merge alone as Founder acceptance.

## 5. Existing Proof Environment

Keep the original pristine proof worktree untouched. It represents the old accepted-base proof state.

For the correction proof, create a **new isolated worktree at exact SHA `52d057f...`** and copy proof databases to a new proof directory. Do not mutate the original proof databases/worktree.

The proof already established historically:
- real Edge Command Center composer
- canonical proof task creation
- originator cannot self-approve
- second Founder approval path in browser
- authenticated local GitHub CLI transport
- CLAUDE worker configuration / read-only claimability check
- check-only refusal without side effects after approval expiry

The historical approval is now expired and must not be reused as current authority.

## 6. Remaining Final V1 Gates

1. New isolated corrected-SHA proof worktree and rebuild.
2. Real Edge Connection Center proof: CLAUDE truth matches Command Center.
3. Expired-approval recovery on copied DB using a real non-check dispatch attempt; expected no GitHub side effect and task returns to `needs_approval`.
4. Fresh second-Founder approval in browser.
5. Check-only proves ELIGIBLE + CLAIMABLE and still performs no dispatch.
6. Exact-head CI becomes clean or the unrelated failure is formally cleared with evidence.
7. Review real adapter path.
8. Exactly one harmless real GitHub dispatch.
9. Prove designated worker claim/fence and one-time authority.
10. Prove durable evidence and duplicate/retrigger refusal.
11. Inspect result-ingest correlation path before ingest.
12. Ingest legitimate result and prove correlation to exact task/run.
13. Preview-ready evidence package.
14. Founder Final V1 acceptance.

## 7. Next Safe Action

**Do not real-dispatch yet.**

Next implementation action after documentation lock:
1. Create new isolated proof worktree at `52d057fea90b716a81921f5774a51057a28195c8`.
2. Copy proof DBs to a new proof directory.
3. Rebuild HQ site/server from that exact SHA.
4. Perform the real Edge Connection Center truth check.
5. Review the exact expired-approval recovery command and side effects before running the intentional refusal/recovery step.

## 8. Documentation Read Order

Before HQ coding work, read:
1. `JENIFY-HQ-BLUEPRINT-ARCHITECTURE.md`
2. `JENIFY-HQ-IMPLEMENTATION-MASTER-PLAN.md`
3. `JENIFY-HQ-CURRENT-STATUS.md`

Blueprint = what HQ is.  
Implementation Plan = how it is built.  
Current Status = where work stands right now.
