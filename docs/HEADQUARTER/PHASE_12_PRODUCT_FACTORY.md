# Phase 12 — The Product Factory

Built on the Phase 11 head of branch `cloud/phase-11-12-search-product-factory`
(itself on the accepted `bb46e344`, Wave 3) as the second half of the Phase 11 +
12 wave. One document for the phase, in the Phase 5+6 / Phase 7 / Phase 8 /
Phase 9 / Phase 10 / Phase 11 style.

## What Phase 12 is

HQ can record what the company is building — the product, its type, the problem
it solves and who it is for, its immutable artifact versions and its own
lifecycle — and can propose the mission structure that building it usually
takes. It does this WITHOUT becoming a second task system and WITHOUT acquiring
any way to release anything.

Module `src/application/product-command.ts` owns the vocabulary (categorical
only), the three INSERT-only tables, the digests, the pure derivations, the plan
templates and the release gate. `HeadquarterOperations` owns every gate, every
write and every enforcement-safe read.

### What Phase 12 deliberately is NOT

- **Not a second project store.** `hq_projects` (Phase 4) stays the one answer
  to "what bodies of work does the company have". A product row hangs off a
  `project_id` that must name a real, OPEN register entry at the moment it is
  written, and the reference is checked against the table rather than against a
  read anyone can patch.
- **Not a second task system.** There is no product queue, no product task
  table, no product plan-item row and no product dispatch. Real work runs on
  canonical missions and Operator tasks, through the same Founder-gated paths
  everything else uses.
- **Not task truth.** The product lifecycle describes the PRODUCT. It shares no
  member with `ActivityStatus` or `MissionStatus`, and nothing in HQ derives
  eligibility, claiming, dispatch, approval, execution or a kill-switch decision
  from it.
- **Not a release path.** Nothing in this phase can reach an adapter. Moving a
  product to `release_candidate` or `released` writes one event row and contacts
  nothing. A real publish is an EXTERNAL ACTION with exactly one route: the
  Phase 8 gateway.
- **Not a grant.** A template proposes; it never authorizes. There is no facade
  method, no route and no parameter that turns a template into work without the
  ordinary `hq.mission_command` gate applying in full.
- **Not a verifier of artifacts.** HQ never fetches an artifact, so it never
  claims to have checked one. There is deliberately no `verified` member in the
  digest-provenance vocabulary for a caller to reach for.
- **Not a paid service or a spend decision.** Nothing here opens a socket, reads
  an environment variable, names a service or adds a dependency.

## The model

### The product record — a REFERENCE, and product-domain metadata only

| Field | What it is |
|---|---|
| `projectId` | The canonical `hq_projects` row this product hangs off. A reference, never a copy. |
| `productType` | One of eight: `web`, `mobile`, `desktop`, `backend_service`, `ai_workflow`, `media_technology`, `hardware_iot_concept`, `firmware`. **Metadata plus an extension point** — it selects a plan template and nothing else. |
| `name`, `problem`, `targetUsers`, `summary` | What is being built, for whom, and why. |
| `lifecycle` | DERIVED from the append-only event ledger. Never a stored mutable column. |
| `artifacts` | The immutable version rows, with `latest` marked per (kind, name) line. |
| `history` | Every event, including superseded lifecycle states. |

`hq_products` carries **no privacy column**, and that is stated rather than
assumed: a `founder_only` product is not representable in this phase, so a
product whose very existence must be secret must not be registered here yet.
That is recorded below as a known limitation, not smuggled past as a default.

### The lifecycle — and why it is not task truth

```
idea → research → specification → architecture → build → test → review
     → release_candidate → released
```

Three properties are load-bearing and each is pinned:

1. **Disjoint from the canonical task vocabularies.** No member of this list is
   an `ActivityStatus` or a `MissionStatus`. A test asserts the disjointness
   directly, so a future state named `blocked` or `completed` fails immediately
   rather than quietly creating an ambiguity a reader would have to resolve.
2. **Derived, not stored.** The current state is the `toState` of the last event
   that carries one — the registration event (`idea`) until a move happens.
   There is no lifecycle column, so there is nothing for the ledger to disagree
   with, and the product row itself is INSERT-only like everything else here.
3. **Forward one step; back to anywhere earlier.** Forward-skipping is refused,
   because a product that never had a specification cannot honestly be `build`.
   Backward movement to ANY earlier state is allowed, because products genuinely
   regress — a review sends work back to build, and a released product re-enters
   build for its next version. Pretending otherwise would push people to record
   a false state, which is worse than an honest regression. Every move demands a
   note, so a regression always carries its reason.

### The Artifact Registry — immutable BY ENGINE

`hq_product_artifacts` rows are `(product_id, kind, name, version)` with a
locator, two digests, the recorder and the time. Nine kinds: `source_package`,
`specification`, `architecture_doc`, `design_artifact`, `test_report`,
`build_artifact`, `firmware_artifact`, `schema`, `release_candidate`.

**A new version is a NEW ROW, and the engine enforces it.** All three tables
carry the full Phase 7/8 trigger set: no UPDATE of any column, no DELETE, a
BEFORE INSERT guard on `id`/`seq` that closes REPLACE and UPSERT, and a second
BEFORE INSERT guard on every SECONDARY unique index. That second guard is the
one that matters most here: a REPLACE colliding on
`(product_id, kind, name, version)` deletes the standing row without any BEFORE
DELETE firing (`recursive_triggers` is off by default and connection-scoped),
and would land a different locator and digest at the same version number —
history rewritten, with nothing to show it happened. Pinned, including from a
RAW `better-sqlite3` connection that never ran this module's code, because the
triggers live in the file rather than in the process.

The version number is derived INSIDE the write transaction as `max + 1` for the
line, and backed by the unique index, so two concurrent writers cannot both land
version N and a client cannot state a version at all (the route ignores one).

**Two digests, and only one of them is HQ's.**

| Digest | What it is | What it is not |
|---|---|---|
| `contentDigest` | The sha256 the RECORDER declared for the artifact's bytes. Provenance is recorded as `declared_by_recorder`, or `not_provided`. | Not verified. HQ never fetches the artifact, so the vocabulary has no `verified` member to record. |
| `recordDigest` | sha256 over the ROW's own canonical fields, computed by HQ. | Not a hash of the artifact's bytes, and never presented as one. |

Every artifact view carries `ARTIFACT_DIGEST_STATEMENT` verbatim, so a reader
cannot mistake the first for the second.

### Templates — proposals that grant nothing

One template per product type, deliberately SHALLOW: the small set of missions
that is true of building that kind of thing at all. A firmware template that
produced a signing, certification or over-the-air step would be inventing a
business rule HQ has no knowledge behind — so each such step is named as
DELIBERATELY ABSENT instead, which is the honest form of the same information
(pinned for firmware and hardware).

The recommendation view carries `grantsAuthority: false`, `createsNothing:
true`, the canonical path (`hq.mission_command`) and `TEMPLATE_AUTHORITY_STATEMENT`.
Its shape is pinned: a proposed mission is a title, an objective and plan items
— **no id, no capability, no grant, and nothing a route could accept.** A
recommendation a route could accept would be an authorization with an innocent
name.

**Naming decision, recorded.** The facade method is `productPlanTemplate`, not
`productPlanRecommendation`, because Phase 10 pinned that NO facade method name
matches `/recommend/i`. That assertion is untouched by this phase and now guards
it too: the template is exactly the same kind of inert record Phase 10's
recommendations are, and it gets the same treatment.

### The release gate

`productReleaseReadiness` is an OBSERVATION over recorded rows, with four
categorical blockers: `lifecycle_before_release_candidate`,
`no_release_candidate_artifact`, `no_specification_artifact`,
`no_test_report_artifact`.

`authorizesRelease` is a literal `false` — **including when the blocker list is
empty**, which is the assertion the phase turns on. A clean readiness answer is
not an approval, not an authorization and not a release; it means only that the
record contains what a release proposal would need to reference.

## The gateway boundary

A release is an external action, and Phase 12 adds no execution seam of any
kind. There is nothing here to bypass the gateway WITH: no adapter handle, no
provider parameter, no target, no payload, no route, no facade method.

What a real release therefore looks like is unchanged from Phase 8: propose a
`publish_release` action against a canonical task, be risk-assessed, be
authorized against a bound Founder approval by the claiming worker under its
live fence, and pass the Intent Guard immediately before the call. Proven end to
end in `product-gateway-boundary`, with the product standing at `released` for
every refusal so the record demonstrably softens nothing:

| Condition | Result |
|---|---|
| public + irreversible + production scope | risk `critical`; `riskRequiresApproval` true |
| no approval on the canonical task | `approval_required_by_risk` at authorize; adapter never called |
| approval expired between authorize and execute | `action_approval_stale` |
| task payload mutated after authorization | `action_digest_mismatch` |
| worker undeclared, or redeclared after authorization | `provider_binding_mismatch` |
| any of `*`, the capability, `external_action`, `adapter:<id>`, `provider:<id>` engaged | `kill_switch_engaged` |

And the mirror image: walking a product from `idea` to `released` and
registering a `release_candidate` artifact leaves `hq_action_intents` and
`hq_action_events` untouched and calls no adapter.

## Product state is NOT task authority

The strongest claim in the phase, established three ways.

1. **Behaviourally, forward.** A task held at the Founder gate has identical
   eligibility, status, claimability and kill-switch answers before and after a
   product advances all the way to `released`.
2. **Behaviourally, in reverse.** A handle with the entire Phase 12 schema
   absent produces the same task status, the same classification and the same
   claim refusal as one with it. Absence changes nothing either, which is what
   "not authority" has to mean in both directions.
3. **Hostilely, and structurally.** A same-realm patch forging BOTH a released
   product (`getProduct`, `listProducts`) and `authorizesRelease: true`
   (`productReleaseReadiness`) is proven to have taken on all three public
   surfaces, and then proven to move no canonical decision and to buy no
   external execution. Behaviour alone cannot prove a negative about every
   future call site, so a source scan additionally pins that
   `operator/queue.ts`, `operator/policy.ts`, `operator/approvals.ts` and
   `operator/capabilities.ts` — the four modules that decide whether work may
   run — never mention a product table or the product vocabulary at all.

## The enforcement-safe read audit

Two facts in this phase decide whether a write lands, and one decides what the
UNAUTHENTICATED artifact says. All three are read through `#db` or a private
derivation; none comes from a public, patchable method.

The snapshot row was missing from this table at first, and the omission was the
defect rather than the documentation of it: `productFactorySummary` called the
public `listProducts()` on the one path that produces `hq-snapshot.json`. It now
reads `#listProductsFromStore` — the private half of `listProducts`, which
`listProductsBounded` also uses — exactly as `#searchCorpus` already read
products. **Inside the facade, no product read goes through a public method.**
The one remaining public-method read is `productDetailRoute`'s `getProduct()`,
and it is a different thing: a ROUTE calling the facade across the module
boundary, which is what every route does. Nothing disclosure-deciding rides on
it either — products carry no privacy level, and `getProduct` itself resolves
through `#productRecordFromStore`. Phase 11's "no exception: Phase 11 reads no
public prototype method at all" is a statement about Phase 11's corpus builder
and does not extend across this phase; stated here so the framing does not
bleed.

| Read | Reads through | Decides | Status |
|---|---|---|---|
| does the referenced project exist, and is it open | `#productProjectFact` — a direct `#db` SELECT of `hq_projects.status`, deliberately NOT `getProject()`, `listProjects()` or `#projectRecord()` | whether a product row is written at all | canonical. Pinned: a patch forging a project on `getProject` AND `listProjects` is proven to have taken on both (instance, prototype, and on a facade constructed after the patch) and buys no product row on either facade |
| the product's CURRENT lifecycle | `#productRecordFromStore` — `loadProduct`/`loadProductEvents` off `#db`, then the pure derivation — deliberately NOT `getProduct()` | whether a requested lifecycle move is legal | canonical. Pinned: a patch relabelling `getProduct` to `review` lies publicly and still cannot buy the move that only `review` would permit; the real next step still works |
| the next artifact version | `nextArtifactVersion` off `#db`, INSIDE the write transaction, backed by the unique index | which version number a row takes | canonical. The engine refuses a duplicate even under two processes |
| the product-command capability row | `#capabilityFromStore` (the existing `#private` closure), never `queue.capabilities` | whether any product write may proceed | canonical, unchanged from the Phase 4/5/7 trio |
| store presence | the constructor's `#productStorePresent` flag | whether a 0 means "absent" or "empty" | canonical, observed, never migrated |
| the register, for the unauthenticated snapshot | `#listProductsFromStore` — `loadProducts`/`loadProductEvents` off `#db`, then the pure derivation — deliberately NOT `listProducts()` | what `hq-snapshot.json`'s `productFactory` section counts | canonical. Pinned: a patch of `listProducts` proven to have taken on the public surface (instance, prototype, and on a facade constructed after the patch) moves not one byte of the published section |

The re-derivation inside `moveProductLifecycle`'s transaction is deliberate and
its cost is stated: because the state is DERIVED, there is no row to guard with
a conditional UPDATE, so a concurrent move is caught by re-reading the ledger
under the reservation and losing rather than double-applying.

## Privacy: what crosses to the unauthenticated artifact

`hq-snapshot.json` gains ONE optional section, `productFactory`, and it carries
**counts over closed vocabularies and nothing else**: `storePresent`,
`products`, `byType`, `byLifecycle`, `artifacts`, `artifactsByKind`, `note`.

No product name, problem statement, target user, artifact name, locator, digest
or id. Every text field on this register is a company plan, and the Phase 9 rule
about a session's `purpose` — and the Phase 11 rule about a search snippet —
applies unchanged: an unauthenticated artifact has no vocabulary that classifies
free text for an unauthenticated reader, so it publishes none.

**What keeps the section safe, stated precisely.** The section's SHAPE is what
does the work — it has no field for a name, a problem statement, a locator or an
id, so none can be assigned to it. But shape alone was not enough, and saying it
was, was wrong: three of the section's seven fields are MAPS whose keys came from
stored columns, and `hq_products` / `hq_product_events` / `hq_product_artifacts`
are append-only ledgers on which an APPEND is the write the triggers deliberately
permit. One legal append carrying free text in `to_state`, `product_type` or an
artifact `kind` therefore became an object KEY here — publishing that text to an
unauthenticated reader, and corrupting the count beside it, because `+= 1` on a
key the empty snapshot never created is `NaN` and `NaN` serialises as `null`.

So the maps are now closed by construction as well as by intent. Each is keyed by
its vocabulary plus exactly one extra member, `unrecognized`; every increment
passes a membership check (`isProductType` / `isProductLifecycleState` /
`isProductArtifactKind`) and the CHECKED value — never the caller's string — is
the key. A stored value outside the vocabulary is counted as what HQ actually
knows about it: that it is not one of these. Its text is never carried, and its
count is never a key. `unrecognized` is a truthful bucket, not a category of
product, and a test pins it disjoint from all three vocabularies.

Two smaller consequences of the same root cause are fixed with it, upstream of
the fold. `rowToProductEvent` reads a `from_state`/`to_state` outside the
vocabulary as `null` — not a move — so `deriveProductRecord`'s
`lifecycle: ProductLifecycleState` is a checked fact rather than a cast. That
also unfreezes a product a forged append used to strand forever
(`canMoveProductLifecycle` correctly fails closed on an unrecognised `from`, and
the register has no edit or supersession path), and keeps the forged string out
of the Founder-gated search corpus, where it had been reaching a product
document's `status`. And a stored `product_type` outside the vocabulary now
produces a typed `unrecognized_product_type` refusal instead of an uncaught throw
out of `productPlanTemplateFor` that surfaced as `500 internal`.

Pinned by the exact TOP-LEVEL key set, by the exact NESTED key set of all three
maps on a POPULATED snapshot built from hostile rows, by a whole-artifact scan
for every forged string, and by asserting every count is an integer and each
map's total equals what was folded.

The provenance note states one thing explicitly, because a reader would
otherwise supply the inference themselves: a `released` COUNT is a count of
records, not evidence that anything was published — no Product Factory path can
perform an external action.

No `HQ_SNAPSHOT_VERSION` bump (the section is optional and additive).

## Search: two new sources, by the mechanism Phase 11 was shaped for

Phase 11 said its registry would take Phase 12's product/artifact register by
"one entry here plus one projection in `#searchCorpus`". That is exactly what
happened — no ranking change, no index change, no scorer, no store.

| Source | Table | What a hit is | Classified | Supersedable |
|---|---|---|---|---|
| `product` | `hq_products` | name, type, problem, target users, DERIVED lifecycle as `status` | no | no |
| `artifact` | `hq_product_artifacts` | kind, name, version, locator, note | no | no |

Both are unclassified because neither row carries a privacy column — which
keeps Phase 11's pinned "exactly three classified sources" true and untouched.

**An artifact document is `not_applicable`, never `superseded`, and that is a
decision.** A later version is a DIFFERENT document with its own number, and
both stay findable; marking version 1 `superseded` would imply HQ had retired
it, when what actually happened is that a second version exists beside it.

Pinned: a product is findable by its problem statement and cites `hq_products`
with its project ref; an artifact cites `hq_product_artifacts`; Ask Jenify
grounds an answer on a product row without putting its text in the composed
sentence; and the founder_only isolation the registry already had is unchanged
(the corpus-wide withheld count is still 3).

## Surfaces

Routes (the unchanged pipeline — origin/referer, identity scan of body AND
query, Founder resolution, `safe()`; route table **37 → 41**, write surface
**23 → 26**):

```
GET  /api/hq/control/products            ?projectId=&lifecycle=
GET  /api/hq/control/products/detail     ?productId=
POST /api/hq/control/products            register a product
POST /api/hq/control/products/lifecycle  move the product's own state
POST /api/hq/control/products/artifacts  record the NEXT artifact version
```

There is deliberately no sixth route. **No path in the whole control table
matches `/release|publish|deploy|distribute|ship/`** — pinned against the route
table itself rather than against a list a test maintains — and three invented
release paths 404.

**None of the three writes takes step-up, and that is a decision.** Step-up
guards acts whose consequence cannot be walked back: a truth acceptance, a
reconciliation of an irreversible external effect. Every write here appends to
an append-only ledger that reaches nothing outside HQ, and a lifecycle move is
corrected by moving back. Demanding a fresh credential for it would imply the
act does something it cannot do.

The `/session` controls gain ONE flag, `productCommand`, advertised from exactly
the conditions that decide the write (the originate grant AND an intact registry
row, read enforcement-safe). There is no read flag — reading takes no capability
beyond the Founder gate — and no release flag, because there is no release act
to grant.

UI: projects.html gains the Product Factory console below the project register
it references. Static markup is a mount and a note, per the site-wide
inert-markup rule. The console draws its product types, lifecycle states and
artifact kinds from the SERVER's own response, so an option HQ would refuse
cannot exist on the page. It deliberately draws no release/publish/deploy
control, no percentage, share, progress bar or ETA (a lifecycle is nine ordered
names and nothing here turns them into a number), and no "apply this plan"
button — the plan panel contains no button at all.

Rooms / the spatial shell: **deliberately unchanged.** A product register is
standing canonical state, so unlike Phase 11 it would fit a room — but the
seventeen approved rooms project the OPERATIONAL picture (what HQ is holding,
what needs the Founder), and a room that lit up for a lifecycle move would be
showing motion where none happened. No `ROOM_SECTIONS` change, no `hydrate.ts`
change, no `rooms.ts` change.

## What is canonical vs derived

| Canonical (written here) | Derived (never stored) |
|---|---|
| `hq_products` — one INSERT-only row per product | `lifecycle`, `lifecycleChangedAt`, `lifecycleChangedBy` — from `hq_product_events` |
| `hq_product_events` — INSERT-only history (`registered`, `lifecycle_moved`, `artifact_versioned`) | `latest` per artifact line, `artifactTotal` |
| `hq_product_artifacts` — INSERT-only version rows | the plan template's proposal — a value, computed per read, stored nowhere |
| | release readiness and its blockers — a fold over the derived record |
| | the snapshot counts |

| Canonical (referenced, never written by this phase) |
|---|
| `hq_projects` (Phase 4) — read to validate the reference; never created, edited or reopened here |
| `hq_missions`, `op_tasks`, `hq_approvals`, `hq_action_*` — untouched by every product path |

Each write commits its row, its history event, its `hq_events` audit entry and
its `op_evidence` entry in ONE reservation. A refusal writes nothing (pinned by
a fifteen-table census plus both log watermarks across every refusal path).

## What is NOT built (deliberately)

- **No release, publish, deploy or distribute path of any kind.** This wave
  performed no release and cannot.
- **No product edit.** Name, problem, target users, type and project reference
  are fixed at registration, because the whole register is append-only. A
  correction is a decision about how history should be amended, and that is a
  Founder decision this phase does not take for them. (Cost stated below.)
- **No `founder_only` product.** The register has no privacy level.
- **No product deletion or archival.**
- **No per-type specialty engine.** The product type selects a template; there
  is no firmware toolchain, no store submission, no hardware sourcing and no
  certification step, because HQ holds no knowledge behind any of them.
- **No artifact content.** HQ records that an artifact exists and where; it
  never stores, fetches, verifies or serves its bytes.
- **No product-to-mission link table.** A product's work is the canonical
  project's missions; a second linkage would be the beginning of a second task
  system.
- **No CLI, no spatial room, no snapshot version bump, no new dependency.**

## Known limitations (honest)

- **A registered product cannot be corrected in place.** A typo in a name is
  permanent until a future phase adds a Founder-gated supersession (the Phase 7
  shape). This is the deliberate cost of an append-only register, and it is the
  most likely thing a first real user will hit.
- **`contentDigest` is a claim, not a check.** Nothing prevents a recorder from
  declaring a digest that does not match the artifact. HQ records the claim and
  its provenance and says so on every view; it cannot do better without
  fetching the artifact, which is a capability this phase does not have.
- **A locator is not validated and not resolved.** It is bounded text that
  passes the credential scan. HQ does not check that it points anywhere.
- **The lifecycle has no `abandoned` or `cancelled` state.** A product that dies
  regresses to an earlier state or simply stops moving; nothing records "this
  will not be built". Stated rather than invented, because the right vocabulary
  for that is a product decision.
- **Readiness blockers are the four the record can actually check.** They say
  nothing about quality, completeness or fitness — a registered `test_report`
  clears `no_test_report_artifact` whatever it contains.
- **`listProducts` derives every product's whole record per call**, exactly as
  `#commandFacts` and `#searchCorpus` do. Fine at HQ scale (the Phase 7/8/9/10/11
  note); a large register would want an indexed derivation.
- **No `founder_only` product**, as above: a stealth product must not be
  registered until the register carries a privacy level.
- **Nothing here has been exercised by a real AI worker lane.** As with Phases
  9, 10 and 11, every canonical act in these suites is performed by a test
  acting as the Founder or as a registered worker.

## Carry-forward Low debt

**From Phase 11, unchanged and still open** — recorded here rather than restated
as fixed, because this phase did not touch either:

- **Lexical retrieval only.** A canonical record phrasing the same fact in
  different words is not retrieved, and its absence from an answer is not
  evidence that it does not exist. The two new sources inherit this exactly.
- **`any_term` retrieval for questions is loose**, and the stopword list is a
  judgement stated as code.
- **The withheld count tells the reader less than it could** — query-independent
  by design, at the cost of not knowing whether any withheld record was
  relevant.
- **`hq_specialists` carries no timestamp**, so a worker document's `at` is the
  read instant.
- **`#searchCorpus` scans the whole record in memory per read.** Phase 12 adds
  two more sources to that scan; the note is now slightly more true than it was.

Phase 11's two HARDENED debts (`recorded.source` bounding/scanning, and the
case-sensitive reserved-identity-key match) stay fixed and were not re-opened.

**New Low debt from this phase**: the product-edit gap and the absent
`founder_only` level, both listed under limitations above. Neither is reported
as anything other than open.

## Deliberate pin ledger

Route table 37 → 41 (`live-control-api`, test renamed "forty-one entries", four
sorted paths added). Write surface 23 → 26 (`live-mission-routes`, three
`toContain` lines plus one `not.toContain` for the detail read). Console
`control-console.test.ts`: the fetch allow-list gained `fetch(PRODUCTS_PATH` and
`fetch(PRODUCT_DETAIL_PATH`; the postJson allow-list gained `PRODUCTS_PATH`,
`PRODUCT_LIFECYCLE_PATH` and `PRODUCT_ARTIFACTS_PATH`, and its title moved from
"twenty-three" to "twenty-six". `CONTROL_FETCH_TARGETS` gained the four product
paths. `CONTROL_GRANT_JS` gained one flag, `productCommand`. No
`HQ_SNAPSHOT_VERSION` bump, no `ROOM_SECTIONS` change, no CLI change, no change
under `packages/server`.

Phase 10's assertion that no facade method matches `/recommend/i` was left
EXACTLY as it was, and the Phase 12 method was named `productPlanTemplate` to
respect it — the intent of that test (a proposal must never look like a handle
on an act) is precisely this phase's intent too.

**No existing test was deleted, skipped, weakened or relaxed.** One product-code
change came out of writing the console suite and is recorded rather than hidden:
the console's write outcome moved to a banner OUTSIDE the register list, because
a successful write reloads the register and the in-card line was being wiped
before it could be read.

## Verification actually run

| Command | Result |
|---|---|
| `npm run test:hq` | 151 files, 2794 tests passed |
| `npm run typecheck --workspace @factoryos/headquarter` | clean |
| `npm run build:site --workspace @factoryos/headquarter` | 10 pages + `hq-snapshot.json` |
| `npm run test --workspace @factoryos/hq-host` | 23 files, 222 tests passed |
| `npm run typecheck --workspace @factoryos/hq-host` | clean |
| `npm run test --workspace @factoryos/hq-server` | 2 files, 20 tests passed |
| `npm run typecheck --workspace @factoryos/hq-server` | clean |
| `npm test` (root, `@factoryos/server`) | 37 files, 569 passed, 3 skipped |
| `npm run build` | all workspaces built; web initial JS 215.66 kB / 69.22 kB gzip (unchanged) |

Baseline before this phase was 145 files / 2698 tests in `test:hq`; Phase 12
adds 96 tests across six new files plus one shared fixture. The three skipped
tests under `packages/server` are pre-existing and untouched — nothing under
`packages/server` was changed.
