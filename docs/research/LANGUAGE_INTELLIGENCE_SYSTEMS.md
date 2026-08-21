# JENIFY LANGUAGE INTELLIGENCE SYSTEMS REPORT

**Workstream:** Language Intelligence System — prior-art research (research only, no code)
**Author:** jenify-country-localization (with jenify-ai-engineer support)
**Date:** 2026-08-21 · All web sources accessed 2026-08-21
**Status:** Intelligence input for Team Lead — NOT an implementation spec

---

## 0. How to read this report

**Confidence labels** on findings (house convention, same as `AFRICA_COUNTRY_PACK_INTELLIGENCE.md`):

| Label | Meaning |
|---|---|
| **HIGH** | Multiple recent, independent sources agree |
| **MED** | Single credible source, or recent but secondary sources |
| **LOW** | Conflicting, dated, or thin sourcing — treat as a lead, not a fact |

**Founder mandate being served.** Every company customizes its own terminology freely
(private, always valid). JENIFY aggregates usage *across* companies — anonymized, never
revealing which company uses what — to surface ranked consensus recommendations. A human
authorized reviewer APPROVES / REJECTS / EDITS / DEFERS / marks SECTOR-SPECIFIC / REGIONAL.
Approved terms become **versioned official JENIFY language packs** — defaults, never
mandatory. Resolution layering: **official pack → country/region variant → sector variant →
company override → user preference.** AI may cluster, dedupe, rank, and explain — it **never
auto-promotes** without human approval (CLAUDE.md principle 6 applies verbatim).

**Existing JENIFY substrate this builds on:** global `translation_keys` (stable internal
IDs) + per-tenant `translations` overrides + `tenant_languages`, English base with fallback;
languages today: English / Amharic / Tigrinya; tenant #1 (Mesob) is Ethiopian.

**The single most important structural finding up front:** the industry has already run
JENIFY's experiment at scale, twice. (1) Pure crowd voting without a human gatekeeper
(Facebook-style up/down voting) produces fast coverage but decays into brigading, dialect
wars, and low-quality dominance; every major platform that survived (Mozilla Pontoon,
Crowdin, Weblate, Transifex) converged on the *same* shape JENIFY's Founder mandated:
**open suggestion → aggregated signal → privileged human reviewer → versioned publish with
rollback**. (2) The canonical-business-terminology problem is solved by *termbases*
(Microsoft Terminology, IATE, SAPterm), not translation memories — concept-oriented entries
with per-term status (`preferred / admissible / deprecated`) and reliability ratings, not a
single "correct" string. JENIFY should therefore model its language packs as a **governed
termbase with TM-style usage evidence feeding it**, and should treat Ethiopic homophone
normalization as a first-class clustering key (Section G) — otherwise Amharic/Tigrinya
consensus counts will be split across spelling variants and the rankings will be wrong.

---

## A. Translation-memory systems (TMX, fuzzy matching, CAT leverage)

### Findings

- **TMX (Translation Memory eXchange)** is the XML open standard (originally LISA/OSCAR)
  for storing and exchanging translation memories between CAT tools: translation units =
  source/target segment pairs plus metadata (creation date, project, tool). (HIGH —
  [Maxprograms](https://www.maxprograms.com/articles/tmx.html),
  [Locize](https://www.locize.com/file-formats/tmx))
- **Fuzzy matching**: TMs retrieve not only identical segments but approximate matches —
  differing in word order, morphology, case, or spelling — scored as a similarity
  percentage; translators see ranked suggestions with the diff highlighted. (HIGH —
  [XTM](https://getting-started.training.xtm.cloud/en/nomenclature-reference/translation-memory,-machine-translation-and-terminologies/translation-memory--tm-.html),
  [AbroadLink](https://abroadlink.com/blog/exchange-of-translation-memories-the-tmx-format))
- **Leverage model** in SDL Trados / memoQ / OmegaT-class tools: 100% (and "context/101%")
  matches are near-free reuse; fuzzy bands (e.g., 75–99%) are partially-paid edits; below a
  threshold the TM is silent. The economic logic — *reuse beats retranslation, consistency
  is a by-product* — is the core value. (HIGH —
  [Taia](https://taia.io/product/translation-memory/),
  [Smartling](https://help.smartling.com/hc/en-us/articles/115003176934-Using-Translation-Memory-in-the-CAT-Tool))
- Fuzzy matching in classic CAT tools is **character/word-edit-distance based**, which
  under-performs on morphologically rich languages (Amharic/Tigrinya verbs inflect
  heavily); this is a known weakness, mitigated by normalization/stemming before matching.
  (MED — inference from the fuzzy-matching literature above plus Section G sources)

### Best patterns · failure modes · risks · performance

- **Best patterns:** segment-level reuse with match-percentage bands; TM metadata
  (origin, date, project) carried with every unit; TMX as the neutral import/export format
  so no vendor lock-in.
- **Failure modes:** TM poisoning — one bad translation approved once propagates forever
  as a 100% match; "leverage rot" when source strings change meaning but the TM still
  fires; context-free segment reuse producing wrong-in-context text.
- **Security risks:** TMs leak content. Shared/cloud TMs have repeatedly exposed one
  client's confidential text to another; the standard mitigations are client-private TMs,
  group permissions, role-based access and audit trails. (HIGH —
  [EC Knowledge Centre on Translation](https://knowledge-centre-translation-interpretation.ec.europa.eu/en/content/confidential-not-all-why-does-your-translation-tool-secretly-store-your-data),
  [Argo Translation](https://www.argotrans.com/blog/how-secure-is-your-translation-data-really))
  This maps 1:1 onto JENIFY's cross-tenant boundary: a tenant's term choices are
  business-confidential (they can reveal product lines, processes, org structure).
- **Performance:** exact-match lookup is a hash/index hit; fuzzy matching is the expensive
  part (n-gram/edit-distance indexes — see the classic inverted-index/n-gram patents,
  [USPTO 6,131,082](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/6131082)).
  At JENIFY's scale (UI terms, thousands of keys — not documents with millions of
  segments) this is trivially cheap if matching is done against **normalized forms**
  precomputed at write time, not per query.

### RECOMMENDED JENIFY APPROACH — A

JENIFY does not need a full TM (it translates a bounded key catalogue, not free documents).
Borrow three TM ideas only: (1) **store a normalized form beside every tenant translation**
at write time (the "index" that makes cheap matching possible); (2) treat **cross-tenant
identical normalized forms as the "100% match" signal** feeding aggregation; (3) support
**TMX/TBX export of official packs** later so external professional translators can work
in their own CAT tools. Never share raw per-tenant translations across tenants — only
aggregates (Section F).

---

## B. Terminology-management systems (TBX, Microsoft Terminology, SAPterm, IATE)

### Findings

- **TBX (TermBase eXchange, ISO 30042:2019, ext. ISO/TS 24634:2024)** is the international
  standard for exchanging termbases: concept-oriented XML, core structure + declared
  data-category constraints; TBX-Basic is the pragmatic subset. (HIGH —
  [ISO 30042:2019](https://www.iso.org/standard/62510.html),
  [tbxinfo.net](https://www.tbxinfo.net/), [terminorgs.net](https://terminorgs.net/TBX.html))
  Key structural idea: **a termbase entry is a *concept*, holding multiple terms per
  language, each with its own status** — not one "correct" string.
- **Microsoft Terminology**: ~30,000 English IT terms in ~100 languages (Amharic among
  them), downloadable in **TBX**; the Language Portal (terminology + UI-string search +
  per-language style guides + community feedback) ran for years, then was shut down
  30 Jun 2023 and folded into Microsoft Learn ("Microsoft language resources"), with
  search still available. (HIGH —
  [Microsoft Learn](https://learn.microsoft.com/en-us/globalization/reference/microsoft-terminology),
  [Slator](https://slator.com/microsoft-kills-off-beloved-language-portal/),
  [About Translation](https://www.aboutranslation.com/2023/07/how-to-access-microsoft-terminology-now.html))
  Governance lesson: even Microsoft ran terminology as *published canonical collections +
  style guides + a feedback loop*, with internal terminologists deciding — the community
  proposed, employees disposed.
- **IATE** (EU inter-institutional termbase) is the strongest public governance precedent:
  terms carry a **reliability code** (untested / minimal / reliable / very reliable) and an
  **evaluation** (preferable / admissible / discarded / obsolete / proposed), are organized
  by **domain**, and are governed by a management group with defined validation workflows.
  (HIGH — [IATE FAQ](https://iate.europa.eu/faq),
  [datos.gob.es overview](https://datos.gob.es/en/blog/discover-iate-european-unions-inter-institutional-terminology-bas),
  [CdT](https://cdt.europa.eu/en/news/launch-new-iate-release-new-chapter-eu-terminology-management))
- **SAPterm** is SAP's equivalent canonical business-terminology base, long referenced
  alongside IATE and Microsoft as a downloadable/queryable vendor termbase. (MED —
  [translartisan resource roundup](https://translartisan.wordpress.com/2023/07/25/looking-for-microsoft-multilingual-resources/))
  SAP's per-domain, per-language canonical business vocabulary ("purchase order",
  "goods receipt") is precisely the genre JENIFY's packs will define for African languages
  — where, for Amharic/Tigrinya *business* terminology, **no vendor-grade public termbase
  exists at comparable depth** (Section G). This gap is JENIFY's opportunity and moat.

### Best patterns · failure modes · risks · performance

- **Best patterns:** concept-oriented entries; **term status as a first-class field**
  (preferred / admissible / deprecated — never delete a rejected term, mark it); domain
  (sector) tagging on entries; reliability/confidence rating separate from status; style
  guides published *with* the termbase; TBX for interchange.
- **Failure modes:** termbase bloat (thousands of near-duplicate entries nobody curates);
  status fields unused so everything is "proposed" forever; terminology divorced from
  usage (canonical term nobody actually uses — IATE mitigates via translator feedback,
  JENIFY can do better: it *measures* usage).
- **Security risks:** low for the termbase itself; the risk is in what feeds it (Section F).
- **Performance:** termbases are small (10³–10⁵ entries); irrelevant at JENIFY scale.
  The costly part is governance labor, not compute — design the reviewer workflow to
  minimize decisions per week (batching, ranked queues).

### RECOMMENDED JENIFY APPROACH — B

Model official packs as a **governed termbase keyed by JENIFY's existing
`translation_keys`** (the key *is* the concept ID — this is already concept-oriented,
which is the right foundation). Adopt IATE's two-axis vocabulary wholesale: an
**evaluation/status** axis on decisions (approved-preferred / approved-admissible /
rejected / deferred / sector-specific / regional — matching the Founder's verbs) and a
**reliability/confidence** axis computed from usage evidence (Section E). Keep rejected
variants stored with status, never deleted (audit + prevents re-proposal loops). Plan
TBX export per pack version for future professional review.

---

## C. Crowdsourced translation models and their failure modes

### Findings

- **Facebook community translation** (from 2008): users submitted translations for UI
  phrases; other users voted up/down "Reddit-style"; winning translations went live —
  fast coverage of dozens of languages, and Facebook even filed a patent on the model.
  (HIGH — [TechCrunch](https://techcrunch.com/2009/08/26/facebook-files-for-patent-on-crowdsourced-translations/),
  [crowdsourcing-translations patent](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/10025780),
  [Fernández-Costales study of Facebook user-translators](https://www.academia.edu/82633417/A_study_into_the_motivations_of_internet_users_contributing_to_translation_crowdsourcing_the_case_of_Polish_Facebook_user_translators))
- **Twitter Translation Center** (2009/2011–2017): 400k+ volunteers translated the UI;
  Twitter **stopped new sign-ups 1 Nov 2017** and wound the program down — volunteer
  supply and moderation cost did not scale with the platform. (HIGH —
  [Twitter blog](https://blog.x.com/en_us/a/2011/it-takes-a-community-to-translate-twitter),
  [translate.twitter.com closure notice](https://translate.twitter.com/))
- **Duolingo Incubator** (volunteer course builders): shut down 2021; Duolingo's own
  post-mortem: volunteer-supported creation "is not sustainable long-term" once the
  company monetizes the output (fairness) and once quality demands standardized templates
  and deadlines volunteers can't be held to. (HIGH —
  [Duolingo blog](https://blog.duolingo.com/ending-honoring-our-volunteer-contributor-program-2/),
  [Cherish Study recap](https://cherishstudy.com/what-happened-to-the-duolingo-incubator/))
- **Launchpad/Rosetta (Ubuntu)**: chronic, documented quality problems — open suggestion
  flood, review teams unable to keep up, unhelpful/slow review UI; community repeatedly
  proposed migrating to Weblate. (HIGH —
  [Ubuntu wiki QA page](https://wiki.ubuntu.com/Translations/KnowledgeBase/QualityAssurance),
  [Rosetta open-week log](https://wiki.ubuntu.com/MeetingLogs/openweekedgy/Rosetta2),
  [Ubuntu discourse: use Weblate instead](https://discourse.ubuntu.com/t/ubuntu-should-use-weblate-instead-of-launchpad-rosetta/14944))
- **Vote brigading** is a named, studied failure of crowd voting: coordinated groups
  boost/sink options, a participation-bias problem that "decreases the reliability of the
  aggregated score"; research shows plain majority voting fails in noisy environments and
  is beaten by better aggregation. (HIGH —
  [Wikipedia: Vote brigading](https://en.wikipedia.org/wiki/Vote_brigading),
  [arXiv 1204.3516 "When majority voting fails"](https://arxiv.org/pdf/1204.3516))
- **Dialect/orthography wars**: Wikipedia's language editions are the canonical case —
  Serbo-Croatian split into four editions; the Croatian edition suffered outright
  **governance capture** by an ideological editor clique; Moldovan Wikipedia was proposed
  for closure amid script/identity fights; Serbian Wikipedia had to ship a per-reader
  script-transliteration toggle rather than pick a winner. (HIGH —
  [arXiv 2311.03616 governance-capture study](https://arxiv.org/pdf/2311.03616),
  [Meta-Wiki Moldovan closure proposal](https://meta.wikimedia.org/wiki/Proposals_for_closing_projects/Closure_of_Moldovan_Wikipedia),
  [Serbo-Croatian Wikipedia](https://en.wikipedia.org/wiki/Serbo-Croatian_Wikipedia))
  Direct relevance: Amharic vs Tigrinya term preferences, and *within* each language,
  regional/orthographic variants, are exactly the kind of dispute that must be **modeled as
  legitimate coexisting variants** (regional/sector marks), not fought to a single winner.
- **Contributor burnout**: the Facebook/Skype motivation research and Duolingo's shutdown
  both show intrinsic motivation decays when work feels extractive, unacknowledged, or
  endless. (MED-HIGH —
  [Mesipuu, Facebook & Skype study](https://www.researchgate.net/publication/262868146_Translation_crowdsourcing_and_user-translator_motivation_at_Facebook_and_Skype),
  Duolingo blog above)

### Best patterns · failure modes · risks · performance — and the JENIFY twist

- **Best patterns that survived:** crowd as *signal*, humans as *gate* (every surviving
  platform, Section D); small trusted reviewer groups per language; feedback to
  contributors (their term became official → visible acknowledgment).
- **Failure modes:** brigading; low-quality dominance (confident wrong translations win
  votes); dialect wars; review-queue flood (Rosetta); burnout; extraction resentment.
- **Security risks:** crowd channels are open injection paths — offensive/malicious text,
  spam, and (for JENIFY) strings that could carry markup/scripts into UIs. All candidate
  text must be treated as untrusted input, length-limited, and rendered inert.
- **JENIFY's structural advantage (assessment):** JENIFY's "crowd" is **not volunteers —
  it is paying companies naming their own business reality for their own benefit.** Usage
  is a *revealed preference*, not a vote that can be brigaded cheaply (a company would
  have to actually operate with a term to move the count — and multi-tenant weighting,
  Section E, caps any one company at weight 1). Burnout doesn't apply; extraction-fairness
  mostly doesn't apply (companies get the packs back as free defaults). The failure modes
  that DO transfer: dialect wars (solve with regional/sector variant marks, never a forced
  winner), reviewer-queue flood (solve with thresholds + ranked batching), and low-quality
  dominance (solve because company overrides always win locally — a "wrong" official
  default never breaks anyone).

### RECOMMENDED JENIFY APPROACH — C

Do not build voting. **Usage counts are the only crowd signal**, weighted per-company
(one company = one voice per term, regardless of user count), with minimum-company
thresholds before anything is even shown to the reviewer. Model regional and sector
variants as first-class *coexisting* outcomes (the Founder's SECTOR-SPECIFIC / REGIONAL
verbs) so no dialect ever needs to "lose". Close the loop visibly: when a term ships in an
official pack, tenants that used it can be told "your terminology shaped the official
Amharic pack" — without ever telling anyone *which other* companies used what.

---

## D. Modern localization platforms' approval workflows

### Findings

- **Mozilla Pontoon**: contributors without Translator rights can only **suggest**;
  users with Translator rights review — approve (green save/checkmark), **reject**
  (kept, marked rejected), or delete; only approved translations land in version control.
  Team roles per locale; "translator" badge. (HIGH —
  [Mozilla l10n docs](https://mozilla-l10n.github.io/localizer-documentation/tools/pontoon/translate.html),
  [Pontoon translation workspace](https://pontoon.mozilla.org/docs/localizer/translation-workspace/))
- **Crowdin**: pipeline = suggest → community **vote** → proofreader review/approve in
  side-by-side mode; role split manager / translator / proofreader, scoped per target
  language; **QA checks** (placeholders, punctuation, length, and **glossary-term
  compliance**) warn at save-time and surface unresolved issues at the Proofread step;
  reports chart approvals vs votes over time. (HIGH —
  [Crowdin QA checks](https://support.crowdin.com/project-settings/qa-checks/),
  [Crowdin editor](https://support.crowdin.com/online-editor/),
  [Crowdin blog on QA](https://crowdin.com/blog/translation-quality-assurance))
- **Weblate**: comparable suggestion/vote/review flow with configurable per-project
  automation, generally less workflow-customizable than Crowdin. (MED —
  [StackShare comparison](https://stackshare.io/stackups/crowdin-vs-weblate))
- **Transifex**: configurable review workflow — review once or twice ("Proofread" as a
  second gate); full per-string **history** of translate/review/proofread/revert events;
  TM can be restricted to **reviewed translations only**. (HIGH —
  [Transifex workflows](https://help.transifex.com/en/articles/6407662-manage-translation-workflows),
  [Transifex editor tools](https://help.transifex.com/en/articles/6318944-other-tools-in-the-editor))
- **Lokalise**: **project snapshots** (point-in-time restore of a whole project) plus
  per-translation **history with roll-back to any previous version**, including bulk
  "restore to last history" actions; team-shared TM. (HIGH —
  [Lokalise snapshots](https://docs.lokalise.com/en/articles/1400540-project-snapshots),
  [Lokalise translation history](https://docs.lokalise.com/en/articles/2107561-translation-history))

### Best patterns · failure modes · risks · performance

- **Best patterns:** strict privilege split (suggesting is open; approving is a role);
  reject-but-keep (rejected suggestions stay visible with status); machine QA *before*
  human review (cheap checks filter the queue); glossary-consistency checks as warnings,
  not blocks; **two artifacts of versioning** — per-string history for surgical rollback
  AND whole-set snapshots for catastrophic rollback; only-reviewed-content feeds reuse
  (Transifex's reviewed-only TM = JENIFY's "only approved terms enter packs").
- **Failure modes:** review bottleneck when one proofreader gates everything (Rosetta's
  death); QA-check fatigue if checks are noisy; snapshot restores that silently drop
  attached metadata (Lokalise excludes workflows/history from snapshots — a warning to
  define exactly what a JENIFY pack version contains). (MED)
- **Security risks:** privilege escalation paths (who grants Translator?); audit gaps on
  approvals. JENIFY already has permissions + audit infrastructure — reviewer actions must
  go through it like any other privileged operation.
- **Performance:** all these platforms are DB-backed CRUD at modest scale; the pattern to
  copy is **precomputed review queues** (ranked candidate lists materialized by a batch
  job) rather than computing rankings on page load.

### RECOMMENDED JENIFY APPROACH — D

Copy the converged pipeline, minus voting: **aggregate (batch) → auto-QA filter →
ranked review queue → privileged human decision → versioned publish**. Reviewer authority
is a normal JENIFY permission (`language.pack.review`, say), audited like any transaction.
Auto-QA before the reviewer sees anything: placeholder integrity, length bounds, script
sanity (Ethiopic chars for am/ti), duplicate-of-already-decided detection. Versioning:
immutable pack versions (whole-set snapshots) + append-only decision history (per-term
audit) — both, like Lokalise/Transifex, because they answer different failure scenarios.

---

## E. Human-in-the-loop consensus and ranking algorithms

### Findings

- **Raw frequency ranking is the wrong default.** The "how not to sort by average rating"
  result: an option with 1/1 positive signal beats 900/1000 on naive average; the fix used
  by Reddit/Yelp is the **Wilson score lower confidence bound** — rank by the lower bound
  of the estimated true proportion, so small samples are automatically penalized and
  confidence tightens as evidence grows. (HIGH —
  [Evan Miller](https://www.evanmiller.org/how-not-to-sort-by-average-rating.html),
  [Reddit ranking analysis](https://medium.com/hacking-and-gonzo/how-reddit-ranking-algorithms-work-ef111e33d0d9),
  [Possibly Wrong revisit](https://possiblywrong.wordpress.com/2014/05/31/reddits-comment-ranking-algorithm-revisited/))
- **Majority voting fails under noise**; aggregation schemes that weight by contributor
  reliability or use tournament/elimination selection outperform it. (HIGH —
  [arXiv 1204.3516](https://arxiv.org/pdf/1204.3516))
- **Weighting unit matters**: for JENIFY the honest unit is the **company** (tenant), not
  the user or the raw event — otherwise one large tenant with 500 users dominates 72 small
  ones. Usage *share within* a tenant (do its users actually see/keep this override?) is a
  secondary quality signal. (Assessment — follows from participation-bias literature above.)
- **Spelling-variant clustering before counting** is mandatory for Ethiopic: Amharic
  homophone characters (ሀ/ሃ/ሐ/ሓ/ኀ/ኃ → one sound) mean the *same word* appears in several
  valid spellings; counting surface forms splits the consensus and mis-ranks (Section G).
  Cluster on the normalized form; count the cluster; recommend the cluster's most common
  surface form as display text. (HIGH for the phenomenon — Section G sources; assessment
  for the counting consequence)
- **Minimum-sample thresholds** (don't recommend from 2 companies) and **stratification**
  (compute consensus per country and per sector, not just globally) are standard practice
  in disclosure-controlled aggregate statistics (Section F sources: minimum cell sizes of
  3–30 are the documented range). (HIGH)
- **IATE's two-axis precedent** (Section B) shows status and confidence must be separate:
  a reviewer-approved term can still be "minimal reliability" until usage confirms it.

### Best patterns · failure modes · risks · performance

- **Best patterns:** Wilson-style lower-bound score over **company-weighted** usage
  proportions; cluster-then-count on normalized forms; per-stratum (country, sector)
  recomputation with the reviewer seeing *both* global and stratum views ("82% globally,
  but 95% in manufacturing/Ethiopia"); minimum-company thresholds gating visibility;
  confidence displayed to the reviewer, never as auto-approval.
- **Failure modes:** over-normalization merging genuinely different words into one cluster
  (Section G — homophone merging measurably *hurts* some Amharic semantics); premature
  recommendations from tiny samples; Simpson's-paradox strata (globally A wins, in every
  sector B wins) — always show stratified views.
- **Security risks:** a company deliberately spraying a term across its config to game
  counts — neutralized by company-level weighting (max weight 1) and the human gate.
- **Performance:** all scoring is **batch, offline** (a periodic aggregation job), never
  in the request path. At realistic scale (10³ keys × 10¹–10³ tenants × ≤3 languages)
  this is seconds of SQLite/SQL work. Do not build streaming/real-time consensus.

### RECOMMENDED JENIFY APPROACH — E

Per (key, language, stratum): cluster tenant translations on **normalized form** → count
**distinct companies** per cluster → compute usage share and a **Wilson lower-bound
confidence score** (companies-using-variant / companies-with-any-custom-term for the key)
→ apply minimum-company threshold (start k=5 globally, k=3 within a declared sector/country
stratum — Founder-tunable) → emit at most the top N clusters per key as candidates, ranked
by lower bound, each with an AI-written *explanation* (what the cluster contains, where it
dominates, spelling variants merged) — explanation only; the decision verbs remain human.

---

## F. Privacy and anonymization boundaries for cross-tenant aggregation

### Findings

- **k-anonymity minimum-count thresholds** are the established mechanism for releasing
  aggregates safely: an aggregate is only shown when at least k distinct contributors are
  behind it; below k it is suppressed. Documented practice: minimum cell sizes range
  **3–30**, with k=10 a common operating point (MDS mobility data returns "-1" below 10);
  dynamic-k schemes raise k when composition risk is higher. (HIGH —
  [MDS Data Redaction](https://github.com/openmobilityfoundation/mobility-data-specification/wiki/MDS-Data-Redaction),
  [K-Anonymous A/B Testing, arXiv 2501.14329](https://arxiv.org/html/2501.14329),
  [Dynamic K-Anonymity](https://www.tdcommons.org/dpubs_series/10641/))
- **Rare values are fingerprints.** A term used by exactly one company identifies that
  company to anyone who knows its vocabulary (a competitor, an ex-employee reviewer). The
  attribute-inference literature stresses that low counts combined with outside knowledge
  re-identify; suppression below threshold plus coarse strata is the defense. (HIGH —
  [arXiv 2507.01710](https://arxiv.org/pdf/2507.01710), MDS above)
- **Composition/intersection attacks**: publishing the same data cut by many dimensions
  (country × sector × size × month) lets intersections isolate one tenant even when each
  cut passes k. Fewer, coarser dimensions and dynamic k are the mitigations. (HIGH —
  Dynamic K-Anonymity above)
- **B2B telemetry norms**: aggregate-only collection, contractual transparency (tenants
  told what is aggregated and why), opt-out/opt-in controls, and role-restricted access
  to even the aggregates are the expected baseline; the translation industry's own
  confidentiality practice (client-private TMs, NDAs, RBAC, audit trails — Section A
  sources) reinforces this. (MED-HIGH)

### Best patterns · failure modes · risks · performance

- **Best patterns:** aggregate at the **company** grain with k-threshold *before*
  materialization (sub-k variants never leave the aggregation job as rows the reviewer
  can see — at most a "suppressed variants: 4" count); strata limited to **country and
  sector only**, both coarse; no timestamps finer than a period bucket; reviewer UI shows
  counts and shares, never tenant lists; the aggregation output table contains **no tenant
  IDs at all** (structurally incapable of leaking, not policy-capable).
- **Failure modes:** "just this once" debugging views that show which tenant uses a term;
  k applied at display time but raw per-tenant variant rows queryable by staff; strata
  proliferation re-identifying via intersection.
- **Security risks:** the reviewer is inside the trust boundary — reviewer actions must be
  audited; aggregation job must run with read access to tenant translations but write
  access only to the anonymized aggregate store; candidate text is untrusted input
  (Section C).
- **Performance:** trivial at batch time; k-suppression is a HAVING clause.
- **Consent posture (Founder decision needed):** whether cross-tenant terminology
  aggregation is default-on-with-disclosure or opt-in per tenant is a policy choice, not a
  technical one. Given "Founder data is sacred," recommend an explicit per-tenant
  `share_terminology_signals` flag, default decided by the Founder, honored by the
  aggregation job. (Assessment)

### RECOMMENDED JENIFY APPROACH — F

Hard rules: (1) aggregation job is the **only** code path that reads across tenants'
`translations`; (2) its output tables carry **zero tenant identifiers**; (3) k-threshold
enforced inside the job (start k=5 global / k=3 in-stratum; below k, only a suppressed
count survives); (4) strata = country + sector only; (5) per-tenant sharing flag honored;
(6) reviewer sees "73 companies, 82% of usage" — never names; (7) all reviewer access and
decisions audited. These rules cost nothing in performance and make the Founder's
"anonymized — never revealing Company X" promise structural.

---

## G. Amharic / Tigrinya specifics

### Findings

- **Homophone/orthographic variance is real, systematic, and named.** Ethiopic has
  multiple character series with identical modern pronunciation — e.g., ሀ/ሃ/ሐ/ሓ/ኀ/ኃ all
  "ha"; ሰ/ሠ "se"; አ/ዐ "a"; ጸ/ፀ "tse" — so one word has several *valid* spellings in the
  wild. Standard Amharic NLP practice is to normalize homophones to a single
  representative (the SERA ASCII transcription maps them together). (HIGH —
  [Amharic preprocessing walkthrough](https://medium.com/@tariktesfa9090/preprocessing-amharic-language-texts-for-nlp-applications-step-by-step-89d383fa69af),
  [SERA](https://www.researchgate.net/publication/2682324_The_System_for_Ethiopic_Representation_in_ASCII),
  [normalization table](https://www.researchgate.net/figure/Amharic-character-normalization-with-their-variant-adopted-and-modified-from-39_tbl2_374055202))
- **Normalization measurably helps matching but can hurt meaning**: normalization improves
  Amharic↔English MT and downstream tasks, but homophone normalization can *degrade*
  semantic models in some settings because a few spelling pairs are meaning-bearing.
  (HIGH — [arXiv 2210.15224](https://arxiv.org/pdf/2210.15224),
  [IEEE 9672229, Impacts of Homophone Normalization](https://ieeexplore.ieee.org/document/9672229/))
  ⇒ normalize for **clustering keys only**; never rewrite what the tenant typed; always
  display a real surface form.
- **Gemination is phonemic but unwritten.** Amharic/Tigrinya gemination (consonant
  doubling) is not marked in normal orthography; Unicode has U+135F ETHIOPIC COMBINING
  GEMINATION MARK (and U+030E is sometimes used) but they appear only in didactic/special
  text. Practical consequence: gemination marks, if present, must be **stripped during
  normalization**, and two spellings differing only by such marks are the same variant.
  (HIGH — [r12a Amharic orthography notes](https://r12a.github.io/scripts/ethi/am),
  [Unicode U+135F](https://www.fileformat.info/info/unicode/char/135f/index.htm))
- **NLP resources exist and are usable**: HornMorpho (morphological analyzer/generator for
  Amharic, Tigrinya, Oromo — finite-state, Python), Amharic corpora, EthioLLM multilingual
  models, and a 2025 survey of Tigrinya NLP mapping the (thin but growing) tool landscape.
  Tigrinya is markedly lower-resourced than Amharic. (HIGH —
  [HornMorpho](https://github.com/adamsamson/HornMorpho2.5),
  [EthioLLM, arXiv 2403.13737](https://arxiv.org/pdf/2403.13737),
  [Tigrinya NLP survey, arXiv 2507.17974](https://arxiv.org/pdf/2507.17974))
- **Business-terminology precedents are thin — that's the moat.** Microsoft ships Amharic
  in its ~100-language terminology collection (TBX) and Windows has had Ethiopic support
  since Vista ('Nyala' font) with Amharic/Tigrinya IMEs; but Tigrinya is **absent from
  Word Translate** and has only partial Office support; CLDR carries Tigrinya locale data.
  No public SAPterm/IATE-grade *business* termbase exists for Amharic or Tigrinya.
  (MED-HIGH — [Microsoft Terminology](https://learn.microsoft.com/en-us/globalization/reference/microsoft-terminology),
  [Tigrinya IME](https://learn.microsoft.com/en-us/globalization/input/tigrinya-ime),
  [MS Q&A on Tigrinya translate](https://learn.microsoft.com/en-us/answers/questions/4840919/translate-into-tigrinya-(-)),
  [CLDR ti](https://www.unicode.org/cldr/charts/44/summary/ti.html))
- **Bootstrap sources for the first official packs**: Microsoft's Amharic TBX collection
  (IT-domain seed, license permitting — verify terms of use), CLDR (dates, numbers,
  currency display), Mesob's own validated Amharic/Tigrinya terminology as tenant #1
  evidence. (MED — assessment plus sources above)

### Best patterns · failure modes · risks · performance

- **Best patterns:** deterministic, table-driven Ethiopic normalizer (homophone folding +
  gemination/length-mark stripping + whitespace/punct folding), versioned so clusters can
  be rebuilt when the table changes; per-language rules (Amharic and Tigrinya fold
  differently — ⇒ ruleset keyed by language); keep raw text forever.
- **Failure modes:** over-merging meaning-bearing pairs (mitigation: reviewer sees cluster
  members and can split a cluster / mark variants regional); treating Amharic and Tigrinya
  as one normalization space; font coverage gaps in PDFs (already solved in JENIFY with
  Noto Sans Ethiopic — keep it that way).
- **Security risks:** none specific beyond untrusted-input handling; Ethiopic homoglyph
  spoofing is theoretically possible in reviewer UI but low-stakes here. (LOW)
- **Performance:** normalization is a per-character table lookup — O(n) at write time,
  negligible; HornMorpho-class morphological analysis is heavier and **not needed for
  v1** (cluster on orthographic normalization first; morphology is a future refinement
  if inflected variants split clusters in practice).

### RECOMMENDED JENIFY APPROACH — G

Ship a small versioned `ethiopic-normalize` ruleset (per language) inside the platform:
homophone folding per the standard Amharic tables, gemination/vowel-length mark stripping,
whitespace/punctuation folding. Use it *only* to compute `normalized_form` for clustering
and duplicate detection — tenant-entered text is never rewritten. Seed the first official
Amharic pack from Mesob-validated terminology + (license-checked) Microsoft Amharic TBX +
CLDR formats; treat Tigrinya as a second pack sharing the process but with its own ruleset
and lower initial thresholds (fewer tenants will use it at first). Publicly, this makes
JENIFY the de-facto Amharic/Tigrinya *business software* termbase — a real moat, per the
Section B gap.

---

## H. Recommended minimal data model (fields only — no code, no migration numbers)

Naming is indicative; the Team Lead / jenify-architect own final names and placement.
All tables are **additive** to the existing `translation_keys` / `translations` /
`tenant_languages` substrate, which is untouched. Decision tables are **append-only**
(principle 5); pack versions are **immutable once published**.

### H.1 Variant aggregation (anonymized — contains NO tenant identifiers)

**`term_usage_aggregates`** — one row per (key, language, stratum, variant cluster) per run
- `id`
- `aggregation_run_id`
- `translation_key_id`
- `language_code`
- `stratum_type` (global | country | sector), `stratum_code` (nullable)
- `cluster_id` (stable hash of `normalized_form` + ruleset version)
- `normalized_form`
- `display_form` (most common surface spelling in cluster)
- `company_count` (distinct tenants; only rows with `company_count ≥ k` are written)
- `usage_share` (company-weighted share of tenants customizing this key in this stratum)
- `suppressed_variant_count`, `suppressed_company_count` (below-k remainder, counts only)

**`aggregation_runs`**
- `id`, `run_at`, `min_k_global`, `min_k_stratum`, `normalizer_ruleset_version`,
  `input_window_start/end`, `tenants_in_scope_count`, `status`, `notes`

*(Tenant-side, one field, not a table: `share_terminology_signals` flag per tenant,
honored by the run — Founder sets the default.)*

### H.2 Candidate recommendation (the reviewer's queue)

**`pack_candidates`**
- `id`, `created_from_run_id`, `created_at`
- `translation_key_id`, `language_code`
- `cluster_id`, `proposed_text` (display form; reviewer-editable via decision)
- `company_count`, `usage_share`, `confidence_score` (Wilson lower bound), `rank`
- `stratum_type`, `stratum_code` (which slice this recommendation is for)
- `scope_suggestion` (global | country | sector — AI/heuristic suggestion only)
- `qa_flags` (placeholder/length/script check results)
- `ai_explanation` (advisory text: what was clustered, where it dominates)
- `status` (open | decided | superseded | withdrawn)

**`candidate_cluster_members`** — so the reviewer can inspect/split a cluster
- `candidate_id`, `surface_form`, `company_count`, `is_proposed_display_form`

### H.3 Review decision (append-only; audited; the ONLY promotion path)

**`pack_review_decisions`**
- `id`, `candidate_id`, `reviewer_user_id`, `decided_at`
- `decision` (approve | reject | edit_approve | defer | mark_sector | mark_regional)
- `final_text` (on approve/edit_approve — what enters the pack)
- `final_scope_type` (global | country | sector), `final_scope_code`
- `term_status` (preferred | admissible) — IATE-style; rejected/deferred keep no text
- `reason_notes`
- `supersedes_decision_id` (corrections are new rows, never edits)
- `defer_until_run_id` (nullable — resurface deferrals with fresh evidence)

### H.4 Versioned official packs with rollback (defaults — company overrides always win)

**`language_packs`**
- `id`, `language_code`, `scope_type` (official | country | sector), `scope_code`,
  `title`, `created_at`

**`language_pack_versions`** — immutable once `published`
- `id`, `pack_id`, `version_number` (monotonic per pack)
- `status` (draft | published | superseded | rolled_back)
- `published_by_user_id`, `published_at`
- `entry_count`, `content_checksum`
- `rolled_back_to_version_id` (nullable — rollback = publish a new version that reuses an
  older version's entries; nothing is deleted)
- `changelog_notes`

**`language_pack_entries`** — the pack content, frozen per version
- `pack_version_id`, `translation_key_id`, `text`, `term_status`
  (preferred | admissible), `source_decision_id` (provenance to H.3),
  `normalized_form`

**Resolution order (runtime, per key per user):** official pack → country/region variant
pack → sector variant pack → company `translations` override → user preference. Packs are
read as defaults at the fallback layer where English base currently sits behind tenant
overrides — the existing tenant-override-wins behavior is preserved by construction.

---

## I. Cross-cutting verdict against the five principles

- **FAST** — all intelligence is batch/offline; runtime adds only ordered fallback reads
  of small immutable pack tables; normalization is O(n) at write time.
- **SIMPLE** — four concerns, four small table groups; no voting subsystem, no streaming,
  no per-request scoring; reviewer workflow reuses existing permissions/audit.
- **FLEXIBLE** — scope/stratum fields make country/sector variants data, not code; k,
  thresholds, and normalizer rulesets are versioned config.
- **LOCAL** — aggregation runs where the data lives; packs ship as local data; no external
  service required (Microsoft TBX / CLDR are one-time seed imports, license-checked).
- **INTELLIGENT** — AI clusters, ranks, and explains; humans decide; provenance from pack
  entry back to decision back to (anonymous) evidence is complete.

**Open questions for the Founder / Team Lead** (not fabricated as answers here):
(1) sharing-flag default (opt-in vs default-on-with-disclosure); (2) initial k values;
(3) who holds reviewer authority per language (internal vs contracted native-speaker
reviewers — Tigrinya especially); (4) Microsoft Terminology license terms for seeding
`[VERIFY]` before any import; (5) whether pack updates notify tenants ("new official
Amharic pack v3 available") or apply silently at the default layer.
