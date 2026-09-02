# Codex Independent Review Assignment — QOS Full Upgrade

Founder-approved planning/review only. Do not deploy, merge to main, spend money, enable paid APIs, touch QOS production/data/auth/DNS, or make destructive changes.

## Objective
Produce the strongest possible independent architecture/security/execution review for finishing the entire QOS Ethiopia website upgrade in the shortest safe elapsed time. ChatGPT HQ will compare your view with Claude, Gemini, Jules and its own plan before any implementation begins.

## Verified current state
- Target repo: `kiniena-github/qos-ethiopia-platform`, default branch `master`.
- Latest governance commit visible: `28e65d8a283dac3b30ae63d4c1a5e5ec990f1c97`.
- Six black-box chatbot QA rounds exist. Round 6 was RELEASE-BLOCKED: only 32/109 alternative natural phrasings (29%) reached intended capabilities, with multiple data-integrity failures. A framing layer was added after Round 6 (`6296d0c...`), and latest reported suites were 591/591 chatbot, 339/339 holdout, 35/35 reasoning, 63/63 Knowledge Manager, but no later independent black-box round is visible.
- Absolute chatbot rule: no price, estimate, range, rate, discount or quotation figure. Pricing is QOS-team only.
- Owner factual gaps remain: payment terms, quotation-process confirmation, subcontracting, safety record, warranty, insurance, client references/flagship projects, founding year/headcount, certification scopes, Russia/North America posture, named partners, date/duration commitments, Portal disclosure, Poly Cert fee policy, regional handoff routing. Safe refusal/handoff exists today.
- SEO research/strategy is complete, but the strategy states items 5–25 are not implemented. Tier 1: deepen six core commercial pages, localized commercial URLs/hreflang with real translations, four Ethiopia opportunity pages, no-price cost-driver page, Search Console/analytics.
- Technical SEO baseline is otherwise strong.
- Public site, Client Portal, Admin Portal and Knowledge Manager foundations already exist.
- QOS automation PR #1 is open, verification-only CI passed, no application code or deployment.
- Antigravity-style homepage mockup issue #2 remains open without a deliverable.
- Production/Supabase/Auth/DNS are Founder-gated and untouched.

## Founder objective
Finish the entire QOS website + chatbot + Client + Admin + Knowledge Manager + SEO/conversion system as fast as possible using maximum parallel AI force, but without duplicate work or fragile architecture. ChatGPT coordinates, Claude is primary builder, Jules is bounded parallel engineer, Codex is independent reviewer/security challenger, Gemini is multilingual/large-context/research reviewer when available, and CI + fresh black-box QA are used aggressively.

## Review targets
Challenge the plan at architecture/security/reliability/release level and give concrete alternatives.

1. What should not be rebuilt because it already exists and is sufficiently strong?
2. What is actually release-blocking right now?
3. For the chatbot, choose deterministic/framing, reasoning/model layer, or hybrid. How do we improve semantic generalization across EN/TR/FR/AR/AM without weakening pricing/fact-safety rules?
4. How should we test intent/generalization rather than add phrases endlessly?
5. What parallel workstreams can safely run simultaneously? Identify file/area collision risks.
6. How should source-freeze, branch isolation, QA snapshots and merge order work so independent black-box QA remains valid?
7. How should Claude and Jules split implementation work, and where must Codex/Gemini remain independent rather than edit?
8. How should Tier-1 SEO be implemented without bundle bloat, doorway-page risk, weak translations or unverified claims?
9. What final Client/Admin/Knowledge/contact/handoff tests are mandatory?
10. What security/privacy/rate-limit/prompt-injection/auth/role/data-integrity/performance/browser/mobile checks are mandatory before production?
11. Which Founder business-answer gaps are true release blockers and which can safely remain explicit handoffs?
12. How should PR #1 and the homepage mockup task be handled?
13. Give aggressive best-case HOURS and realistic HOURS if all workers are parallel today. Flag any estimate that is technically dishonest.
14. What is mandatory pre-launch versus post-launch final-limit upgrade?
15. Define one objective DONE gate.

## Required response
- Executive verdict
- Critical blockers
- Do-not-rebuild list
- Parallel lane architecture with owners
- Chatbot architecture recommendation
- QA/generalization strategy
- SEO/content strategy
- Portal/Admin/Knowledge/contact validation
- Security/reliability/performance gate
- Founder decision matrix
- Hour-by-hour fastest schedule
- Merge/integration order
- Release acceptance matrix
- Post-launch upgrades
- P0/P1/P2 risks with mitigations
- Final recommendation to ChatGPT HQ

Focus on concrete P0/P1 risks, race/collision conditions, unsafe assumptions, over-optimistic timelines and architectural shortcuts that would force rework. No paid API suggestions.