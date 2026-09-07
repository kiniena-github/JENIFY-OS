# Phase 11 — Unified Search, Company Memory and Ask Jenify

Built on `bb46e344` (accepted Wave 3: Phase 9 + 10) as the first half of the Phase 11 + 12
wave on branch `cloud/phase-11-12-search-product-factory`. One document for the phase, in
the Phase 5+6 / Phase 7 / Phase 8 / Phase 9 / Phase 10 style.

## What Phase 11 is

The Founder searches every canonical store HQ holds from one place, and asks a question in
words and gets an answer GROUNDED in the rows that were retrieved to answer it — with the
canonical table and id of every source beside it, the Phase 7 truth state where one
exists, and the limitations of the answer stated rather than implied. When the record does
not support an answer, HQ says so.

Module `src/application/search-command.ts` owns the vocabulary (categorical only), the
source REGISTRY, the retrieval ADAPTER boundary, the pure search core and the deterministic
answer composer. `HeadquarterOperations` owns the fact gathering (`#searchCorpus`) and the
three reads (`searchCompany`, `askJenify`, `searchIndexSummary`, plus the registry read
`searchSources`).

### What Phase 11 deliberately is NOT

- **Not a truth store, and not a second authority.** Nothing here is canonical. Every
  document is DERIVED at read time from a row another phase owns, carries that row's table
  and id, and is dropped when the call returns. There is no index table, no query log and
  no result cache — a search surface that stored its own index would be a second answer to
  "what does the company hold", and the repository rules forbid exactly that. **This phase
  introduces no table at all.**
- **Not a writer.** No `hq_events` row, no `op_evidence` entry, no capability, no gate, no
  actor. Both routes are GETs. Pinned three ways: a fourteen-table census plus both
  append-only log watermarks is unchanged across the whole surface; a real file's size and
  mtime are unchanged across fifty queries; and the facade exposes exactly five
  `search*`/`ask*` methods, none of which takes a `requestedBy` — an act needs an actor,
  and none of these is an act.
- **Not a capability.** Phase 11 registers nothing. Reading is behind the SAME Founder gate
  the memory, truth, collaboration and command-centre reads already sit behind, and takes
  no grant beyond it.
- **Not a scorer.** There is no relevance score, rank, weight, confidence, percentage or
  ETA anywhere. The only match fact published is `matchedTerms` — WHICH of the reader's own
  terms occur in the document, checkable against the snippet beside it. The order is stated
  in the response itself (`ordering`).
- **Not a language model.** `askJenify` calls nothing, contacts nothing and generates no
  prose. Its response is counts and categorical states over the cited rows, composed by
  stated code; each row's own text appears only as a quoted snippet beside the table and id
  it came from. Pinned: the composed sentence never contains a cited record's free text.
- **Not a paid service, and not a spend decision.** Nothing in this phase opens a socket,
  reads an environment variable, names a service or adds a dependency.

## The model

### The source registry — eleven canonical sources

Phase 11 shipped this table with NINE rows. Phase 12 then added `product` and `artifact`
by the mechanism described below, which is exactly what was intended — but this table was
not updated with them, so it under-reported the registry at the Phase 12 head. The two
Phase 12 rows are marked, and both counts below now match `SEARCH_SOURCES`.

| Source | Table | What a hit is | Classified | Supersedable |
|---|---|---|---|---|
| `mission` | `hq_missions` | title, objective, scope, block reason | no | no |
| `project` | `hq_projects` | name, stream, summary | no | no |
| `task` | `op_tasks` | recorded title, capability, block reason | no | no |
| `product` (Phase 12) | `hq_products` | name, type, problem, target users, DERIVED lifecycle as `status` | no | no |
| `artifact` (Phase 12) | `hq_product_artifacts` | kind, name, version, locator, note | no | no |
| `memory` | `hq_memory` | a company memory record | **yes** | **yes** |
| `truth` | `hq_truth_records` | a truth record with its DERIVED Phase 7 state | **yes** | **yes** |
| `collaboration` | `hq_collab_sessions` | a Mission Room session's title and purpose | **yes** | no |
| `external_action` | `hq_action_intents` | type, adapter, target, risk vocabulary | no | no |
| `orchestration_run` | `hq_orchestration_runs` | what one cycle observed and did | no | no |
| `worker` | `hq_specialists` | display name, vendor, role | no | no |

`SEARCH_SOURCES` IS the registry. Adding a source is one entry here plus one projection in
`#searchCorpus` — no ranking change, no index change, no store. **Phase 12's product /
artifact register joined by doing exactly that, and nothing was stubbed for it here**: a
source appears in this list only when a canonical store genuinely backs it today, so the
registry never claims to search something that does not exist.

Two decisions in that table are load-bearing and are pinned:

- **The three CLASSIFIED sources are exactly the three canonical rows that carry a privacy
  column.** A fourth source gaining one, and being projected as `internal` by default,
  would be a silent leak — so the registry's classified set is asserted, and a new
  classified source fails that test until the corpus builder is taught about it too.
- **Two payloads are never indexed and therefore can never be quoted**: `op_tasks.payload`
  / `op_tasks.result`, and `hq_action_intents.payload`. The snapshot's no-task-payload rule
  is a DISCLOSURE rule, not a snapshot rule, so it applies to a Founder-gated search result
  as well. Pinned: a task is findable by its recorded title, and its payload marker is not
  a reachable query term.

### The document

A `SearchDocument` carries `id`, `source`, `entityId`, `table`, `title`, `body`, `status`,
`lifecycle`, `truthState`, `privacy`, `at`, `project`, `tags`, `evidenceRefs` and `refs`.
`privacy` is copied from the canonical row for the three classified sources and is
`internal` for the eight whose rows have no privacy column — stated in the registry rather
than assumed at each call site.

The browser projection (`SearchDocumentView`) carries no `body`: a document's text reaches
a reader only as a BOUNDED SNIPPET beside the row it was quoted from, never as a field the
reader could mistake for HQ's own statement. Pinned by exact key set.

**`lifecycle` has three values, and the third is honesty rather than convenience.** Most
canonical rows have no supersession model, so calling them `current` would imply HQ had
checked something it never checked. They read `not_applicable`. A superseded memory or
truth record reads `superseded`, is flagged `stale: true` on every hit and citation, and is
counted in the composed sentence ("1 cited record has been superseded and is labelled
stale"). Staleness is STATED, never resolved and never used to reorder.

### Retrieval: one index, two matching rules, no scorer

The index is the existing dependency-free inverted index in `archive/search.ts`
(`tokenize` / `buildIndex` / `search`), reached through the same `ArchiveRecord` projection
`memory/store.ts` already uses. **Phase 11 implements no second index and no scorer.**

| Surface | Rule | Why |
|---|---|---|
| `searchCompany` | `all_terms` | An explicit search means every word the Founder typed. This is the archive engine's own AND semantics, unchanged. |
| `askJenify` | `any_term` | A natural-language sentence carries words no canonical row will ever contain. Demanding all of them would answer every question with "no record" — a lie of omission dressed as an honest unknown. |

`any_term` is the union of one AND query per term, so there is still exactly one engine call
shape in the repository. Which terms each cited row ACTUALLY matched is published per
citation, so the looser rule stays checkable by the reader.

Both rules run over the same stated, closed `QUERY_STOPWORDS` list — English function words
and query verbs, no domain word (pinned: `mission`, `truth`, `memory`, `task`, `project`,
`worker`, `evidence`, `verified`, `blocked`, `approval` and `decision` are all absent from
it, because a stopword that named a company concept would silently make canonical rows
unreachable). Every word removed is reported back as `ignoredTerms`, so a reader can see
exactly what HQ did to their question.

**Order** (`SEARCH_ORDERING_STATEMENT`, published on every response): more matched terms
first, then newest canonical timestamp, then the source registry order, then document id.
The leading key is a COUNT over the reader's own query — the same integer published as
`matchedTerms` — not a relevance judgement; under `all_terms` every hit shares that count,
so the order degenerates to newest-first. The tiebreak chain is total, so the same corpus
and query produce a byte-identical sequence on every call and after a restart.

### Bounds — and why a criterion-less query is REFUSED

`SEARCH_READ_LIMIT` 50 (hard ceiling, whatever the caller asks), `SEARCH_DEFAULT_LIMIT` 20,
`ASK_CITATION_LIMIT` 8, `MAX_QUESTION_LENGTH` 500, `MAX_QUERY_TEXT_LENGTH` 200,
`MAX_QUERY_TERMS` 12, `MAX_DOCUMENT_BODY_LENGTH` 2000, `MAX_SNIPPET_LENGTH` 240. Every
result set states its true readable total beside the bounded page, so trimming is visible.

A query with NO criterion — no text, no source, no project, no tag, no year — is refused
with `invalid_input`, not answered:

> Supply at least one search criterion (text, source, project, tag or year). HQ does not
> answer a query with no criterion: that is a dump of the company record, not a search.

And a question that reduces to no searchable term retrieves NOTHING and answers `unknown /
no_searchable_terms`. It deliberately does not fall through to "everything, ordered by
date", which is what the adapter does for an empty term list when search supplies a
structured filter instead.

### The semantic adapter boundary — defined, and deliberately empty

`RetrievalAdapter` is the seam a semantic/embedding retriever would fit into. It is handed
the already-privacy-filtered documents and the already-tokenized terms, and NOTHING else:
no database handle, no identity, no capability, no privacy decision. That is the whole
point of the boundary — a retrieval strategy can narrow or reorder what the reader could
already see, and can never widen it. Pinned by the input's exact key set.

`SEMANTIC_RETRIEVAL_ADAPTERS` is empty. That is the correct outcome of this phase, not a
stub: every semantic retriever worth having is either a paid API or a model download plus
compute, and both are Founder spend gates this phase does not open. Requesting
`semantic_embedding` returns the deterministic adapter with
`fallbackReason: 'no_adapter_installed'` and a note saying nothing was activated — it never
throws and never pretends. Every response states the mode that ACTUALLY answered, the mode
requested, and the reason they differ.

### Ask Jenify: retrieve first, then compose

`askJenify` retrieves through the same corpus and adapter search uses, hands the
already-filtered, already-bounded documents to `assembleAnswer`, and that composer has no
database handle to reach past them with. The pipeline is structural, not conventional.

| State | When | What the reader is told |
|---|---|---|
| `grounded` | at least one readable canonical document retrieved | counts by source, the Phase 7 states of the cited truth records, how many are superseded, how many name `op_evidence`, and the citation list |
| `insufficient_evidence` | terms existed, retrieval matched nothing | "HQ holds no canonical record matching this question… This states what the company record contains — it is not a statement that the thing asked about is false." |
| `unknown` | no searchable term (`no_searchable_terms`), or no source store on this handle (`no_source_store_present`) | HQ could not search, and says which |

`ANSWER_LIMITATIONS` is a closed vocabulary of ten, every one a statement a reader can act
on: `composed_from_fields_only`, `lexical_retrieval_only`, `bounded_retrieval`,
`terms_ignored`, `superseded_records_cited`, `unverified_truth_cited`,
`no_truth_record_cited`, `no_evidence_cited`, `founder_only_not_searched`, `stores_absent`.
`lexical_retrieval_only` is the honest boundary of this whole surface: a record phrasing the
same fact in different words was not retrieved, and its absence is not evidence that it does
not exist.

## Privacy: the reader's right, never the query's

This is the phase's sharpest rule, and it is stronger than Phase 10's.

1. **The reader's disclosure right is decided by the calling layer** — the Founder-gated
   route passes `includeFounderOnly: true`; the unauthenticated snapshot passes false — and
   by nothing in the query, the question, a document's text, or a body field.
2. **Filtering happens BEFORE structured filters, before retrieval and before
   composition**, so no count, snippet, citation, term or total can span a withheld row.
3. **The withheld count is a CORPUS fact, not a query fact.** This is where Phase 11 goes
   further than Phase 10 had to. Phase 10's `withheldFounderOnly` is a count over a fixed
   derivation an attacker cannot steer. A search's withheld count is a function of an
   ATTACKER-CHOSEN query, and a per-query count would be an oracle: a reader could
   binary-search the private record one term at a time without ever seeing a row. So
   `withheldFounderOnly` is the count of classified documents in the WHOLE corpus,
   identical for every query — pinned by asserting three different queries return the same
   number, including one that matches nothing.

   The cost is stated: the reader is told that Founder-classified material exists and was
   not searched, and is not told whether any of it was relevant. That is the correct trade.

Pinned end to end, on all three classified sources, for search AND for Ask Jenify: a
guarded reader sees `total: 0`, no private string appears anywhere in the record-derived
part of the response, and the Founder reading the same query sees the real row.

### The patchable-read audit

`#searchCorpus` decides two things a hostile same-realm patch would want to move: WHICH
rows a reader is shown, and WHICH of them are `founder_only`. So every fact is read through
`#db` or a private derivation. **Unlike Phase 10's `#commandFacts`, there is no exception:
Phase 11 reads no public prototype method at all.**

| Read | Reads through | Decides | Status |
|---|---|---|---|
| `hq_memory` rows incl. `privacy` | direct `#db` SELECT of the columns needed — deliberately NOT `MemoryStore.listAll()` and NOT `listMemory()` | which memory records reach the reader | canonical. Pinned twice: a wrapping patch of `listMemory` that relabels `privacy` on the REAL rows, and a wrapping patch of `MemoryStore.prototype.listAll` doing the same — each proven to have taken on its public surface (instance AND prototype, and on a facade constructed after the patch), each moving nothing here |
| truth records, their DERIVED state, lifecycle and privacy | `#deriveAllTruth(loadTruthGraph(#db))` — the private derivation | which truth records reach the reader, and the state a citation shows | canonical. Pinned: a relabelled `listTruth` lies publicly and publishes no founder_only record here |
| collaboration sessions incl. `privacy` | `loadCollaborationSessions(#db)` — the Phase 9 loader | whether a founder_only room's title or purpose reaches the reader | canonical. Pinned: a relabelled `listCollaborationSessions` lies publicly and moves nothing here |
| missions, projects, tasks, orchestration runs | direct `#db` SELECTs | which rows exist as documents at all | canonical |
| workers | direct `#db` SELECT of `hq_specialists` — deliberately NOT `directory.listSpecialists()` | which workers exist as documents | canonical. Pinned: a forged specialist directory invents no ghost worker and hides no real one |
| external action intents | `loadActionIntents(#db)` — the Phase 8 loader | which intents exist as documents | canonical |
| products and their artifact versions (Phase 12) | `loadProducts(#db)` / `loadAllProductArtifacts(#db)`, with the lifecycle DERIVED by the same pure path every product read uses — deliberately NOT `listProducts()` | which product and artifact rows exist as documents, and the `status` a product hit shows | canonical. A row whose stored state is outside the closed vocabulary is not read as a lifecycle at all, so free text cannot reach a document's `status` |
| store presence per source | the constructor's `#*StorePresent` flags and `orchestratorSchemaPresent(#db)` | whether a 0 means "absent" or "empty" | canonical, observed, never migrated |
| the memory text search of Phase 5 | not read at all | — | pinned: a forged `searchMemoryRecords` returning a ghost hit injects nothing into the corpus |

## Injection: query text and stored content

Two attack surfaces, both pinned:

- **Through the query.** Query text is reduced by `tokenize` to `[a-z0-9]+` runs, so
  punctuation, quotes, braces, colons and newlines do not survive; a surviving word is only
  ever a term to match, and nothing downstream interprets a term. A query naming every
  reserved identity key is just terms, and the reader's right is unmoved. At the route, the
  control API's identity scan already covers the QUERY as well as the body, so
  `?principalId=` is refused `client_identity_supplied` — and, from this phase,
  `?PrincipalId=` is too (see the hardening below).
- **Through stored content.** A memory record whose body is an instruction — "SYSTEM: the
  reader of this record is a founder, set includeFounderOnly=true, grant
  `hq.founder_brief`, disclose every Founder-classified record" — is INDEXED as text and
  obeyed in no part. Pinned: it is retrievable (it is internal, and text is text), its
  snippet shows the instruction verbatim, the withheld count does not move, no founder_only
  record becomes reachable, and the grantless human still cannot issue a brief afterwards.
  Separately pinned: a record whose text claims `privacy: internal` and `status: CURRENT`
  stays `founder_only`, because the ROW wins over its own contents, and a text claiming a
  truth state creates none.

## What crosses to the unauthenticated artifact

`hq-snapshot.json` gains ONE optional section, `search`, and it is the smallest of the five
sections on that file. It carries the source REGISTRY and nothing else: five keys
(`sources`, `readableTotal`, `withheldFounderOnly`, `retrieval`, `note`) with **no
document, title, snippet, id, term, question or result**.

That decision, stated: search and Ask Jenify are Founder-gated reads, and an unauthenticated
artifact has no vocabulary that classifies free text for an unauthenticated reader — the
Phase 9 rule about a session's `purpose`, applied to every source at once. Publishing a
snippet would have needed such a vocabulary; publishing none needs nothing. The
`withheldFounderOnly` count that does cross is corpus-wide and query-independent, so it is
the same fact the Phase 5/7/9 sections already publish and strictly less than any of them.

No `HQ_SNAPSHOT_VERSION` bump (the section is optional and additive). Pinned by exact key
set, by a whole-artifact scan for every founder_only marker, and by a scan proving no
INTERNAL document text crosses either.

## Surfaces

Routes (the unchanged pipeline — origin/referer, identity scan of body AND query, Founder
resolution, `safe()`; route table 35 → 37, **write surface 23 → 23**):

```
GET  /api/hq/control/search   ?text=&source=&project=&tag=&year=&limit=
GET  /api/hq/control/ask      ?question=
```

**Both are GETs, and that is a design statement rather than a convenience.** This is the
first phase since the browser boundary existed that widens the route table without widening
the write surface at all: a read route cannot drift onto the write surface, and the phase
has nothing to put there. Pinned: neither path is in `CONTROL_WRITE_ROUTES`; POST / PUT /
PATCH / DELETE on either 404s; and a fourteen-table census is unchanged across four route
calls.

Both routes scan **every** free-text parameter they read with `assertBrowserSafe` BEFORE it
is matched or echoed — on `/search` that is `text`, `project` and `tag`; on `/ask` it is
`question`, the only parameter that route reads at all. Credential-shaped query material is
refused `unsafe_query`, and a credential-shaped question `unsafe_question`, rather than
being echoed back inside `criteria`, `terms` or `question` (the memory-intake precedent).
The other two criteria need no scan and are refused by their own shape: `year` is pinned to
four digits and `source` to the closed registry — an unknown `source` is refused rather
than ignored, so a client never believes it filtered when it did not.

Stated because it was wrong here at the Phase 12 head: this claim originally covered only
`text` and `question`. `project` and `tag` — two of the five criteria, and the two
`normalizeSearchQuery` echoes VERBATIM into `criteria`, where `text` survives only as
tokenized terms — were unscanned. The credential was never disclosed: the last-resort
`safe()` guard over every control response caught it. But it caught it by turning the
designed `400 unsafe_query` into an opaque `500 internal`, AFTER
`audit('allowed', 'company_search')` had already recorded the read as allowed. All three
are now scanned at the same place, before the facade call and before the allowed-audit
fires, and route tests pin the status, the code, the absent echo and the audit line for
each.

UI: index.html gains the Company Search / Ask Jenify console (`searchConsoleScript`) below
the Chief of Staff section. Static markup is a mount and a note — no input, button or form,
per the site-wide inert-markup rule. Everything else is script-created after a real
`/session` grant, textContent-only. It draws: a search box and a source filter; per hit the
canonical table, id, timestamp, status, truth state, lifecycle, staleness, snippet, matched
terms and evidence refs; a question box; and, per answer, the composed sentence, its state
chip, its cited sources and its full limitation list. The script calls `postJson` NOWHERE —
its only occurrence is the shared helper's definition, pinned by count — so every request it
issues is a GET. Fetch heads are allow-listed in `control-console.test.ts` (`SEARCH_PATH`,
`ASK_PATH`) and both paths joined `CONTROL_FETCH_TARGETS`.

Rooms / the spatial shell: **deliberately unchanged.** The spatial rooms render standing
canonical state — what HQ is holding, and what needs the Founder. Search and Ask Jenify have
no standing state: they are interactive query surfaces whose output exists only for the
duration of one question. A room that lit up for "a search happened" would be exactly the
fake activity the room comments were written against, and a room showing a stored last
query would need a query log, which this phase refuses to keep. No `ROOM_SECTIONS` change,
no `hydrate.ts` change, no `rooms.ts` change.

## What is canonical vs projection

| Canonical (unchanged, never rewritten by this phase) | Phase 11 |
|---|---|
| `hq_missions`, `hq_projects`, `op_tasks`, `hq_op_task_meta`, `hq_specialists`, `hq_orchestration_runs` | read only |
| `hq_memory` (Phase 5), `hq_truth_*` (Phase 7), `hq_action_*` (Phase 8), `hq_collab_*` (Phase 9), `op_evidence` | read only; referenced by id, never copied |
| — | **no new table.** The corpus, the index, every hit, every snippet, every answer and every citation is derived at read time and stored nowhere |

**Why no store, stated because the alternative was available.** A persisted inverted index
would be faster at scale and would be a second place the company's content lives — one that
could drift from the canonical rows, that would need its own privacy re-derivation on every
write, and that a reader could be shown instead of the truth. The phase is a pure
projection precisely so that it cannot disagree with the rows it reads. Migration safety is
therefore trivial: there is nothing to migrate, and a read-only pre-Phase-5/7/9 file
observes each absent source, still answers from the stores it has, states `stores_absent` as
a limitation rather than implying an empty store, and is not written to (pinned, including
the file's size and mtime).

## Carry-forward Low debts — HARDENED here, with tests

Both were in scope because this phase changed how they can be reached. Neither is reported
as fixed without a test.

**(a) `recorded.source` on a memory record was neither bounded nor scanned.**
`recorded.date` and `recorded.confidence` are checked by the store's validator; `source`
fell through it and through the facade's `assertNoSecretLikeContent` payload — while being
PERSISTED (`hq_memory.recorded_source`), PUBLISHED (`memoryBrowserView.recorded.source`,
which rides the unauthenticated artifact for an internal record) and, from this phase,
INDEXED and quotable through search. Now bounded to `MAX_MEMORY_RECORDED_SOURCE_LENGTH`
(200), type-checked, and scanned in the same call as title / body / tags / sourceRefs /
related. The STORE scans it too — deliberate defense in depth, because a trusted composition
root can call `MemoryStore.record` without the facade.

Stated honestly: the scan is the existing `key: value` heuristic from
`operator/evidence.ts`, the same guard the record's other strings get, no more. The control
route never passed `recorded` at all, so this closes an in-process path rather than a
browser one.

**(b) The reserved-identity-key match was CASE-SENSITIVE** in both places that make it —
`scanForClientIdentity` at the browser boundary and `normalizeWorkSpec` at the facade. A
guard written to refuse `requestedBy` accepted `RequestedBy`, `PRINCIPALID` and `Token`.
Both now go through one exported predicate, `isClientIdentityKey`, which folds case once.
JSON keys are case-sensitive and every legitimate HQ body spells these in camelCase, so
folding narrows nothing a real caller uses — pinned by a test that a body carrying
`collaborationRole`, `idempotencyKey` and `acceptanceCriteria` is still accepted and that
none of those is a reserved key. Proven at both boundaries end to end: `?PrincipalId=` on
the Phase 11 search route is refused `client_identity_supplied`, and a mission spec payload
nesting `RequestedBy` three levels deep is refused at the facade with no mission written.

**The scan's depth limit, stated rather than implied.** `scanForClientIdentity` recurses
while `depth < 3`, so it inspects keys at four levels and no deeper: a reserved key buried
at `{a:{b:{c:{d:{RequestedBy}}}}}` is NOT refused. That bound is deliberate and predates
Wave 4, which changed only the case-folding above. It is not a disclosure or authority hole
today, because no facade path takes an identity from a request body at all — every control
route passes `requestedBy: founder.principal.id` from the RESOLVED session, so a body key
that survives the scan is read by nothing. The scan is a "say plainly what you are trying to
do" guard on top of that, not the thing that decides who you are. Widening it is a change to
a boundary guard and belongs in a phase that can test it end to end, not in a correction
wave; it is recorded here so nobody reads the guard as unbounded.

## What is NOT here (deliberately)

No semantic/embedding retrieval, no vector store, no embedding model, no paid or hosted
service, and no new npm dependency. No persisted index, query log, saved search, search
history or result cache. No write of any kind. No capability. No ranking, scoring,
boosting, tuning or feedback signal. No natural-language GENERATION — no summarization, no
paraphrase, no synthesis across rows beyond counting them. No cross-source join or inferred
relationship: an answer cites rows, it does not connect them. No spatial room. No CLI. At
the time Phase 11 shipped, no product/artifact source — the registry was shaped to take one
and no fake source was stubbed for it. Phase 12 then added `product` and `artifact` for
real, by that mechanism; the registry table above is the current list.

## Known limitations (honest)

- **Lexical retrieval only.** A canonical record that states the same fact in different
  words is not retrieved, and its absence from an answer is not evidence that it does not
  exist. This is stated on every answer as `lexical_retrieval_only`, and it is the single
  largest limitation of the phase.
- **`any_term` retrieval for questions is loose.** A question sharing one non-stopword with
  an unrelated record retrieves that record. The matched terms are published per citation so
  the reader can see it happened, and the composed sentence never asserts relevance — but a
  reader skimming citations will see rows that matched on one common word.
- **The stopword list is a judgement, stated as code.** It is closed, contains no domain
  word, and every removed word is reported — but a query whose meaning rests on a removed
  word will behave differently from one that does not.
- **`#searchCorpus` scans the whole record in memory per read**, exactly as `#commandFacts`
  does, and search runs it once per query. Fine at HQ scale (the Phase 7/8/9/10 note); a
  large corpus would want an indexed derivation — which is precisely the point at which the
  "no store" decision above would need revisiting.
- **The withheld count tells the reader less than it could.** Making it query-independent
  closes an oracle at the cost of the reader not knowing whether any withheld record was
  relevant to what they asked. Recorded as a deliberate trade, not an oversight.
- **`hq_specialists` carries no timestamp**, so a worker document's `at` is the read
  instant. It is therefore always "newest" on a tie, and two reads of the same corpus
  produce different worker timestamps. Stated in the corpus builder; it affects display
  order only, never disclosure.
- **A memory record's `recorded.source` is indexed into its body**, so it is searchable and
  quotable. That is why debt (a) above was hardened; it is worth knowing that the field is
  now reader-visible in a second place.
- **Nothing here has been exercised by a real AI worker lane.** As with Phases 9 and 10,
  every canonical act in these suites is performed by a test acting as the Founder or as a
  registered worker.

## Deliberate pin ledger

Route table 35 → 37 (`live-control-api`, test renamed "thirty-seven entries", two sorted
paths added). Write surface UNCHANGED at 23, with two new `not.toContain` lines
(`live-mission-routes`). `control-console` fetch-head allow-list gained
`fetch(SEARCH_PATH` and `fetch(ASK_PATH`; the postJson allow-list gained NOTHING, because
the phase has no write. `CONTROL_FETCH_TARGETS` gained the two read paths. No
`HQ_SNAPSHOT_VERSION` bump, no `ROOM_SECTIONS` change, no `CONTROL_GRANT_JS` flag (reading
takes no grant), no CLI change, no change under `packages/server`.

**No existing test was deleted, skipped, weakened or relaxed.** One fixture detail changed
and is recorded rather than hidden: the Phase 11 fixture's superseded-memory chain carries
explicit `recorded` dates, because everything else takes `nowIso()` and two records written
in the same millisecond tie on time and fall to the id tiebreak — deterministic for a given
corpus, arbitrary across fixture runs, and flaky for an ordering assertion.

## Verification actually run

| Command | Result |
|---|---|
| `npm run test:hq` | 145 files, 2698 tests passed |
| `npm run typecheck --workspace @factoryos/headquarter` | clean |
| `npm run build:site --workspace @factoryos/headquarter` | 10 pages + `hq-snapshot.json` |
| `npm run test --workspace @factoryos/hq-host` | 23 files, 222 tests passed |
| `npm run typecheck --workspace @factoryos/hq-host` | clean |
| `npm run test --workspace @factoryos/hq-server` | 2 files, 20 tests passed |
| `npm run typecheck --workspace @factoryos/hq-server` | clean |
| `npm test` (root, `@factoryos/server`) | 37 files, 569 passed, 3 skipped |
| `npm run build` | all workspaces built; web initial JS 215.66 kB / 69.22 kB gzip |

Baseline before this phase was 139 files / 2587 tests in `test:hq`; Phase 11 adds 111 tests
across six new files. The three skipped tests under `packages/server` are pre-existing and
untouched by this phase — nothing under `packages/server` was changed.
