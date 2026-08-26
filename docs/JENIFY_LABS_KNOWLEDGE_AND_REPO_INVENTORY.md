# Jenify Labs — Company Knowledge & Repository Inventory (Wave 1 Proposal)

**Status:** PROPOSAL — documentation/index only. Nothing was moved, renamed,
deleted, archived, or migrated. All classifications below are *proposed* and
take effect only when the Founder approves them.
**Produced under:** JENIFY-OS issue #62 (`[AI TASK][CLAUDE] Scale-out worker —
Jenify Labs knowledge + repo inventory`), 2026-08-26.
**Method:** read-only inspection of the five GitHub-visible repositories listed
in §2 at the exact commits recorded there, plus the GitHub API (open PRs, repo
descriptions). No code was modified in any repository.

---

## 1. Coverage — what this inventory does and does not include

**Covered (5 repositories, full read-only sweep of each):**

| Repository | Default branch | Inventoried at commit | Last activity seen |
|---|---|---|---|
| `kiniena-github/JENIFY-OS` | `main` | `ed20eb2` | 2026-08-26 |
| `kiniena-github/jenify-news` | `master` | `8be8dda` | 2026-08-25 |
| `kiniena-github/jenify-studio` | `master` | `c7fdc5f` | 2026-08-25 |
| `kiniena-github/genify-studio` | `master` | `014b1be` | 2026-08-25 |
| `kiniena-github/qos-ethiopia-platform` | `master` | `16d8d2c` | 2026-08-26 |

**Explicitly NOT covered (honest gaps, not omissions):**

- **Any repository outside the five above.** The worker's GitHub access for
  this task was scoped to exactly these five repositories. If the account or
  any organization holds other repositories, they are invisible to this
  inventory and are **not** claimed to not exist.
- **Google Drive / local files.** The issue defers cloud/file organization to
  a later wave. Note: `docs/AI_BRIDGE/BRIDGE-001-evidence-synthesis.md`
  already records that the directed Google Drive AI Bridge could not be found
  (only OneDrive present), and `qos-ethiopia-platform`'s
  `intelligence/OWNERSHIP-REGISTRY.md` names a bridge path
  `G:\My Drive\AI BRIDGES\QOS`. Reconciling those is future-wave work.
- **Unmerged branch content** beyond what open PRs describe. Open PRs are
  listed as status signals (§4) but their branch trees were not swept.

---

## 2. The company picture in one view

**"Jenify Labs" barely exists on paper.** Across all five repositories the
name occurs exactly once: in `JENIFY-OS/.github/workflows/ai-task-gemini.yml`
(line ~138), as an AI reviewer persona — *"the independent Google intelligence
and technical review department for Jenify Labs."* There is no company-structure
document, no entity description, and no doc that states the relationship
between the Jenify product family and QOS Ethiopia. This inventory is the
first cross-repo company document; formalizing the entity name is a
Founder-only decision (§7).

**Product family and lineage (provenance-verified):**

```
Genify Studio 2.4.1  (genify-studio — broad 7-module AI content platform,
   │                  PySide6; mid-rebrand "Genify→Jenify" in UI strings only;
   │                  last product commit 2026-08-10)
   │
   ├── copied tree (no shared git history) ──► Jenify Studio 0.1.0
   │        (jenify-studio — editor-only successor; "the editor is the whole
   │         product"; 50 commits; actively developed to 2026-08-22)
   │
   └── source reuse (per SOURCE_REUSE_NOTES.md) ──► Jenify News 0.2.0
            (jenify-news — Scan→Create→Publish news-video app; also contains
             Jenify Quick Editor and Jenify Mobile 0.1.0 in the same repo)

JENIFY OS  (JENIFY-OS — formerly FactoryOS; local-first multi-tenant business
            operating platform; Mesob Salt Factory = tenant #1 pilot;
            independent codebase, no lineage link to the Studio/News line)

QOS Ethiopia Platform  (qos-ethiopia-platform — real business's public
            website + customer portal + local chatbot; independent codebase;
            only governance patterns are shared with the Jenify repos)
```

Two important non-links, stated so nobody infers them later:
- `jenify-ai-qos` (a JENIFY-OS agent name) means *AI quality-of-service*
  inside JENIFY OS. It is **not** related to QOS Ethiopia.
- The "broader Jenify Studio product" that `jenify-news/CLAUDE.md` calls a
  *"separate, broader future product"* is a **different concept** from the
  shipping editor in the `jenify-studio` repo (see naming conflicts, §5).

---

## 3. Proposed classification

Labels per the Founder's taxonomy: CURRENT PRODUCT / IN DEVELOPMENT /
PROTOTYPE / R&D-EXPERIMENT / FUTURE IDEA / SUPERSEDED-ABANDONED.
Rule applied: **nothing was upgraded** — a brainstorm stays a FUTURE IDEA
until real code and Founder intent say otherwise, and every "current" claim
below cites shipping evidence.

| Artifact | Proposed label | Evidence |
|---|---|---|
| **QOS Ethiopia Platform** (site + portal + chatbot) | **CURRENT PRODUCT** | Live public site (`qosethiopia.com`), v5.0.0, 4 offline test suites in verification-only CI (605+339+63+35 assertions per latest PR evidence). Caveat: independent QA rounds 2–6 all returned BLOCKED verdicts on chatbot quality — current, but under active correction. |
| **JENIFY OS** (platform) | **IN DEVELOPMENT** | Wave 1 completion audit verdict "PARTIAL"; 399 server tests green; awaiting Founder go on next milestone. |
| — Mesob Salt Factory deployment | **CURRENT PRODUCT** (pilot, tenant #1) | Founder-validated operational pilot; "the sacred regression proof." |
| — Headquarter / Universal Operator | **IN DEVELOPMENT** (unmerged) | PRs #45/#46, branch-isolated packages, both pending independent review (BLOCK verdicts being corrected). Not on `main` yet. |
| — JENIFY AI / QOS intelligence layer | **FUTURE IDEA** (Founder-designated "future planned") | Decision 2026-08-21: "major planned part of JENIFY OS," design-only until the AI milestone. Zero code exists. |
| — Sector expansions (retail, construction, hotel, healthcare…) | **FUTURE IDEA** (design docs only) | `docs/design/SECTOR_*.md`; only Manufacturing is real. |
| **Jenify News 0.2.0** (desktop) | **IN DEVELOPMENT** | Feature-complete 0.2.0 line, ~1,388 test functions on disk, but its own docs gate release on unrun Windows smoke tests and the first real paid OpenAI generation. |
| — Jenify Quick Editor | **IN DEVELOPMENT** | Real, architecturally isolated code in `jenify_news_core/quick_editor/` with ~45 test files and its own installer shortcut. (Supersedes the stale "not built" claim in `jenify-news/CLAUDE.md` §I.) |
| — Jenify Mobile 0.1.0 | **IN DEVELOPMENT** (private beta) | Android: signed APK, device-accepted. iOS: project only, no IPA. Functionally sandboxed (no publishing, no paid APIs). Not on any store, by design. |
| **Jenify Studio 0.1.0** (editor) | **IN DEVELOPMENT** | 50 commits, 415 tests claimed green, but the repo's own final report says `RELEASE: FAIL` — one open blocker (BUG-004, upstream Qt6 ffmpeg deadlock); exe/installer not built. |
| **Genify Studio 2.4.1** | **SUPERSEDED** (proposed — needs Founder confirmation, §7) | Ancestor of both Jenify Studio (copied tree) and Jenify News (source reuse). No product commit since 2026-08-10. Tension: PR #1 (2026-08-25) added CI to it, which reads as continued investment — hence Founder confirmation, not a unilateral label. |
| "Broader Jenify Studio" platform concept (in jenify-news docs) | **FUTURE IDEA** | Named only as a deferred future product; no repo, no code under that scope. |
| TikTok/Instagram/Facebook/Snapchat publishing (Jenify News) | **FUTURE IDEA** | Visible as connector targets; "live authorization/publishing is not enabled in 0.2.0." |
| Legacy platform pages inside `jenify-studio` (`genify_core/modules/`) | **SUPERSEDED-ABANDONED** (in place) | Documented as "vestigial… not reachable from the shipping app." Kept on disk for provenance; do not delete without Founder approval. |
| "FactoryOS" (name) | **SUPERSEDED** (name only) | Public rebrand to JENIFY OS 2026-08-19; internal `factoryos` identifiers deliberately legacy-stable. The *product* is not superseded — only the public name. |

Nothing in the five repositories qualified as PROTOTYPE or R&D-EXPERIMENT
under honest reading: the design-only material (sector docs, QOS AI layer,
Headquarter before merge) is either Founder-designated FUTURE IDEA or
in-review IN DEVELOPMENT work. If the Founder prefers, the
`design/particle-homepage/` mockup in qos-ethiopia-platform (PR #5) is the
one artifact that fits **PROTOTYPE** (self-contained concept, explicitly not
wired into production).

---

## 4. Per-repository inventory

### 4.1 `JENIFY-OS` — JENIFY OS (formerly FactoryOS)

- **Identity:** local-first, multi-tenant business operating platform.
  npm-workspaces TypeScript monorepo — Fastify 5 + better-sqlite3 + Drizzle
  (server), React 18 + Vite (web), `packages/config-mesob` for tenant physics.
  Version 0.1.0, private. Five principles: FAST, SIMPLE, FLEXIBLE, LOCAL,
  INTELLIGENT.
- **Knowledge docs (the richest corpus in the company):** 17 root docs —
  charter (`JENIFY_TEAM_CHARTER.md`, 24-agent model), append-only decision
  register (`JENIFY_DECISIONS.md`), roadmap, execution log, program state,
  two Wave-1 completion audits, AI bridge/routing/workflow docs, state
  snapshot + feature matrix + defects register (`FACTORY_OS_CURRENT_STATE.md`
  §5), Henok feedback intake, mobile performance budgets. Plus
  `docs/research/` (17 market/technical intelligence files), `docs/design/`
  (6 sector/capability designs), `docs/security/` (5 red-team reports).
- **Status signals:** completion verdict PARTIAL; latest verified test count
  **399 server tests passed + 3 skipped** (26 suites) + 13 web tests; tag
  `checkpoint-wave1-complete`; milestone 4 "awaiting Founder go."
- **Open PRs (10):** #28, #30, #32, #36 (research/review carriers), #45/#46
  (Stream 2 Headquarter/Operator, in correction after BLOCK reviews),
  #49/#50/#57 (Jules review reports), #51 (worker-routing policy fix).
- **Known doc drift:** `README.md` still fully FactoryOS-branded;
  `CLAUDE.md` cites "163 tests" (stale; real count 399+);
  `FACTORY_OS_FEATURE_MATRIX.md` still says QOS/AI "out of scope per founder"
  — superseded by the 2026-08-21 "FUTURE PLANNED" decision.

### 4.2 `jenify-news` — Jenify News 0.2.0 (+ Quick Editor + Mobile)

- **Identity:** Windows-first news-video app: Scan → Create → Publish.
  Python + PySide6, SQLite, FFmpeg. Vertical 1080×1920 output; YouTube is the
  only live connector. Origin recorded in `SOURCE_REUSE_NOTES.md`: began from
  Genify Studio 2.4.1 source, now separate.
- **Three deliverables in one repo:**
  1. **Jenify News** desktop app (installer `Jenify_News_Setup_0.2.0.exe`);
  2. **Jenify Quick Editor** — lightweight scene-based editor for
     Jenify-generated videos, isolated package + own entry point/spec,
     bridged by a file/manifest handoff; shipped with News in a combined
     "Jenify" suite installer;
  3. **Jenify Mobile 0.1.0** (`mobile/`) — Capacitor 6 + React companion,
     private distribution only; Android signed APK device-accepted; iOS
     project exists, no IPA; sandboxed build (no publishing, no paid calls,
     local-only data).
- **Status signals:** 95 test files / ~1,388 test functions on disk; mobile
  99 tests green. Gates its own release on unrun Windows runtime smoke tests
  and the first real paid OpenAI multi-scene generation (`CLAUDE.md` §H).
- **Open PRs (1):** #1 — CI/automation foundation (desktop suite evidence in
  that PR: **1548 passed** locally on Windows).
- **Known doc drift:** `CLAUDE.md` §I still says the Quick Editor is
  not built; the tree says otherwise. Test counts in `CLAUDE.md` (191) and
  `TEST_REPORT.md` (33) are historical snapshots, far below the current tree.

### 4.3 `jenify-studio` — Jenify Studio 0.1.0

- **Identity:** standalone, local-first professional video editor for
  Windows; "the editor is the whole product." Python + PySide6/Qt6,
  `imageio-ffmpeg`, PyInstaller/Inno packaging. Identity single-sourced in
  `genify_core/jenify/identity.py`; internal spelling stays `genify_core`
  deliberately (backward compatibility with user data).
- **Provenance:** forked-by-copy from Genify Studio (no shared commit SHAs);
  keeps its own AppData namespace (`JenifyEditor`) so it never touches
  Genify Studio user state. Large vestigial legacy-platform code retained on
  disk but unreachable.
- **Status signals:** 137 Python files / ~50.9k lines; 415 automated tests +
  43/43 real-media Windows QA claimed; **release verdict FAIL** — BUG-004
  open (upstream Qt6 ffmpeg-backend deadlock, root-caused, repro script in
  repo); PERF-001 resolved as a measurement artifact; exe/installer not
  built. 0.2.0 plan written.
- **Open PRs (1):** #1 — CI/automation foundation (flags two real pre-existing
  pyflakes findings in legacy `genify_core/gui.py` as a future AI task).

### 4.4 `genify-studio` — Genify Studio 2.4.1 (ancestor)

- **Identity:** Windows-first "AI content creation, video editing, publishing
  and automation workspace" — 7 workspace modules (Home, Create, Edit,
  Automation, Media & Analytics, Integrations & Storage, Settings) + "Ask
  Genify" assistant drawer. Python + PySide6.
- **Mid-rebrand freeze:** UI strings say "Jenify Studio 2.4.1"
  (`qt_main_window.py`), docs/packages/paths say Genify. 13 commits; Phases
  1–10 ended 2026-08-10; both successor products then continued elsewhere.
- **Status signals:** 103 Python files / ~38.3k lines; 71 non-Qt regression
  tests claimed in `TEST_REPORT.txt`; 97 tests pass per PR #1 evidence;
  social OAuth stubbed; honest caveat that Windows Qt runtime paths were
  never physically launched in the packaging environment.
- **Open PRs (1):** #1 — CI/automation foundation.
- **Inventory judgement:** primary value is now **provenance** (ancestor of
  two shipping-track products). Proposed SUPERSEDED — Founder to confirm
  (§7.1).

### 4.5 `qos-ethiopia-platform` — QOS Ethiopia Digital Platform

- **Identity:** the public face + customer portal + local chatbot of QOS,
  a real industrial-engineering business (machinery installation, factory
  relocation, automation; offices in Türkiye, Hungary, Morocco, Ethiopia).
  Node 22 + Vite 8 + React 19; 204 generated route pages; Supabase-backed
  portal; chatbot is local (no paid model APIs). v5.0.0.
- **Knowledge corpus:** 22 markdown files in `intelligence/` — verified
  capability map (GREEN/BLUE/YELLOW/RED fact classification), ownership
  registry (25-role roster, 9 active, independence rule), owner-decisions
  register, strategic synthesis, red-team + 5 QA-round reports, SEO/region/
  market research sets. `docs/` holds only `AI_AUTOMATION_WORKFLOW.md`.
  **No README.md exists in the repo.**
- **Status signals:** live production site; deployment strictly human/
  Founder-gated (CI is verification-only, "must never deploy"); four offline
  test suites green in CI; QA rounds 2–6 returned BLOCKED verdicts on
  chatbot answer quality (Round 6: 29% of natural wordings reached their
  capability) — active correction PRs open.
- **Open PRs (3):** #4 (Codex review carrier), #5 (sitemap/claims-lint/
  particle-homepage concept), #6 (QA F-12/F-15 vocabulary fix; 605/605
  chatbot tests on its head).

---

## 5. Unresolved duplicates, naming conflicts, and doc drift

These are reported, **not fixed**, in this wave:

1. **`genify-studio` vs `jenify-studio`** — one letter apart, both real
   repos, both privately CI'd as of 2026-08-25. Verified: not duplicates —
   ancestor and successor with disjoint git histories. The near-identical
   names remain a standing confusion hazard for every human and AI worker.
2. **"Jenify Studio" means two things:** (a) the shipping editor repo, and
   (b) the "separate, broader future product" named in `jenify-news/CLAUDE.md`.
   Until the Founder renames one concept, every mention needs a qualifier.
3. **Genify→Jenify rebrand is frozen mid-flight in three places:**
   genify-studio (UI says Jenify, everything else Genify); jenify-studio
   (product renamed, internals + `PROVIDER_SETUP.md` + User-Agent
   `Genify-Studio/2.4` still Genify); FactoryOS→JENIFY OS (README not
   rebranded, internals legacy-stable by decision).
4. **One repo, three products:** `jenify-news` contains Jenify News, Jenify
   Quick Editor, and Jenify Mobile. Fine operationally today; a naming/
   organization decision eventually (§6 proposes an index, not a split).
5. **Stale self-descriptions (worth a small follow-up docs task per repo):**
   - `jenify-news/CLAUDE.md` §I: Quick Editor "not built" — it is built.
   - `JENIFY-OS/CLAUDE.md`: "163 tests" vs real 399+; README still FactoryOS.
   - `FACTORY_OS_FEATURE_MATRIX.md`: QOS/AI "out of scope" vs superseding
     2026-08-21 decision.
   - Test counts differ between doc snapshots and trees in jenify-news
     (33 / 156 / 191 / ~1,388) and JENIFY-OS (121→412 chronology) — each
     number was true at its date; none is labeled with its commit.
6. **"QOS" collision:** QOS Ethiopia (the business) vs `jenify-ai-qos`
   (JENIFY OS's future AI layer). Unrelated; the shared acronym invites
   exactly the kind of accidental "upgrade by association" this inventory
   is told to prevent.
7. **"Jenify Labs" has no definition** anywhere except one workflow prompt.
   No doc states whether QOS Ethiopia work sits inside Jenify Labs, beside
   it, or is a client engagement.
8. **Drive bridge contradiction:** JENIFY-OS evidence says the Google Drive
   AI Bridge could not be found; the QOS ownership registry names a live
   `G:\My Drive\AI BRIDGES\QOS` path. Unresolved; belongs to the future
   cloud-organization wave.

---

## 6. Recommended organization map (proposal only — nothing executed)

**Principle: preserve originals and provenance.** No repo is renamed, moved,
archived, or deleted in this wave. The proposal is an *index layer*, not a
migration.

1. **Canonical company index lives here** — this file, in JENIFY-OS (already
   the de-facto governance home: charter, decisions, roadmap, AI bridge).
   Each product repo keeps its own truth; this index only points and labels.
2. **Adopt the lifecycle labels** from §3 as the standard vocabulary in all
   future docs and task issues (matching the CURRENT/SUPERSEDED/REJECTED/
   EXPERIMENTAL/ARCHIVED scheme already designed in unmerged PR #46's archive
   schema — when Stream 2 merges, this inventory should be re-expressed as
   records in that archive; this file is deliberately compatible with it).
3. **Proposed shelf map** (labels, not moves):
   - *Operating businesses:* qos-ethiopia-platform (CURRENT PRODUCT).
   - *Platform track:* JENIFY-OS (IN DEVELOPMENT; Mesob pilot CURRENT).
   - *Creator-tools track:* jenify-news (News + Quick Editor + Mobile),
     jenify-studio — all IN DEVELOPMENT.
   - *Provenance shelf:* genify-studio (SUPERSEDED, pending §7.1) — keep
     intact and read-only by convention; it is the source-of-truth ancestor
     for two product lines.
4. **Small follow-up docs tasks** (each its own reviewed PR, none started):
   fix the stale claims in §5.5; add a README to qos-ethiopia-platform;
   date/commit-stamp test-count claims when docs cite them.
5. **Defer to the Founder-gated future waves:** any repo rename/transfer/
   archive, the Drive/cloud knowledge layer, and a full account-level repo
   census (needs access beyond the five-repo scope).

---

## 7. Founder-only decisions (kept separate, as instructed)

None of these were acted on; each is a genuine gate:

1. **Confirm or reject `genify-studio` = SUPERSEDED.** Evidence points to
   superseded-ancestor, but CI was added to it on 2026-08-25, which signals
   possible continued intent. If confirmed superseded: whether to mark it
   read-only/archived on GitHub (irreversible-ish organization action —
   proposal only).
2. **Formalize the company name.** "Jenify Labs" exists only as a prompt
   persona. Adopt it officially (and where it appears publicly), or drop it.
3. **Define the QOS Ethiopia ↔ Jenify relationship** before any public or
   compliance-relevant claim is ever made. No repo currently states it.
4. **Disambiguate "Jenify Studio"** — keep the name on the shipping editor
   and rename the "broader future product" concept, or vice versa.
5. **Complete or freeze the two half-done rebrands** (Genify→Jenify UI/docs;
   FactoryOS README) — cheap, but naming is Founder-owned.
6. **Whether `jenify-news` should ever split** into separate repos for News /
   Quick Editor / Mobile (no technical urgency found; provenance argues for
   staying put until there is one).
7. **The cloud/Drive knowledge layer** — which bridge path is canonical, and
   when migration starts. Out of scope for this wave by explicit instruction.
