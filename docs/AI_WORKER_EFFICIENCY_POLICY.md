# JENIFY AI Worker Efficiency Policy

Status: Founder-approved operating policy proposal. This policy optimizes speed, quality, and model/token usage without weakening material-risk review gates.

## 1. Default execution pattern

For ordinary work:
1. One bounded builder owns the task.
2. CI performs mechanical verification.
3. ChatGPT reviews the current head and evidence.
4. Merge only when existing repository merge gates are satisfied.

For material code (security, permissions, finance/stock, data integrity, architecture, migrations, concurrency, offline behavior, or substantial features):
1. One bounded builder.
2. CI.
3. One independent reviewer (Jules or Codex by default; Gemini when specifically useful/available).
4. ChatGPT coordinates the final technical gate.
5. Add a second independent model only for unresolved disagreement, ambiguous evidence, or genuinely high-risk work.

Founder-only gates remain unchanged.

## 2. Worker scope

Every worker mission should state:
- exact repository/PR/issue;
- bounded objective;
- owned files/modules when known;
- acceptance tests/evidence;
- explicit exclusions/collision boundaries;
- stop conditions.

Workers must not re-audit the whole repository unless the task genuinely requires repository-wide context. If another active worker owns overlapping files, stop/report rather than create parallel conflicting edits.

## 3. Model use

- Prefer the normal efficient Claude model lane for bounded implementation work (currently Fable where available under project policy).
- Escalate to Opus only when the task's complexity/risk requires it or the preferred model is unavailable under the existing fallback policy.
- Do not use multiple expensive models to repeat the same routine analysis.
- Independent models exist to challenge material work, not to duplicate every trivial task.

## 4. Testing efficiency

- During implementation, run targeted tests for the changed behavior first.
- Run the appropriate full regression/build suite on the final candidate before merge when repository policy requires it.
- Do not repeatedly rerun expensive full suites after every tiny edit when targeted evidence is sufficient during development.
- Reuse trustworthy current-head CI evidence; never claim tests from an older SHA prove a newer SHA.
- CI should own deterministic mechanical checks such as lint, formatting, typecheck, drift checks, and repeatable regressions where practical.

## 5. Reporting

Default worker completion report should be concise:
- current head SHA;
- files/modules changed;
- tests/checks and result;
- remaining blocker(s);
- next action.

Long reports are reserved for architecture, research, security analysis, model disagreement, or Founder decisions.

## 6. Review economy

Do not dispatch Jules/Codex/Gemini for docs-only, formatting-only, trivial automation/config, or low-risk wording changes unless specific risk warrants it.

For material code, require one genuinely independent current-head review. A second independent review is exceptional, not automatic.

Never weaken review because of quota pressure. High/Critical findings and unresolved correctness-threatening Medium findings block merge.

## 7. Stale and superseded work

Before spending model time on an old task/PR:
- check whether its approach is superseded;
- check whether the head changed materially;
- check whether the result is still needed.

Close or clearly mark superseded tasks/PRs when safe instead of repeatedly re-reviewing meaningless regenerated heads. Never close evidence that is still required by an active merge gate.

## 8. Parallelism

Scale by repository/module ownership, not by putting many builders on the same code.

Preferred pattern: QOS worker owns QOS; Studio worker owns Studio; News worker owns News; Quick Editor worker owns Quick Editor; JENIFY OS worker owns its bounded OS lane; Headquarter/Operator workers own explicitly separated modules.

Add workers only when there is useful non-overlapping work and enough review capacity to safely absorb their output.

## 9. Immutable safety rules

This efficiency policy does NOT authorize:
- production deployment;
- paid APIs/services/subscriptions/usage billing;
- destructive migration or direct production-data changes;
- irreversible material security changes;
- government/official commitments;
- unsupported compliance/tax/regulatory claims;
- major product-direction changes;
- secrets/credentials in GitHub;
- builder self-approval of material work.

Those remain Founder-only or subject to the existing governance gates.

## 10. Optimization objective

Optimize for completed, verified work per unit of time/model usage — not maximum number of AI calls. Remove duplicate reading, duplicate research, unnecessary full-suite reruns, overlapping builders, and verbose handoffs while preserving independent review where it materially improves correctness.