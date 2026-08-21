# JENIFY OFFLINE SYNC ARCHITECTURE — Contracts Report

> Workstream **R8-b** of the JENIFY OS research program · 2026-08-21 · RESEARCH + CONTRACTS ONLY — no code changes.
> Author role: jenify-offline-infra.
> **Builds on** `docs/research/OFFLINE_HARDWARE_DEPLOYMENT.md` (R8): the operating-environment facts
> (power/connectivity/devices), the competitor offline survey (§2), and deployment Profiles 1–4 are
> established there and are *not repeated* — this report defines the software contracts on top of them.
> Scope: how JENIFY tolerates temporary loss of connectivity **without ever compromising the ledger.**
> The sync engine will NOT be rushed; this document exists so it can be built safely later.

**Confidence legend:** [H] verified from primary docs/multiple sources · [M] single credible source or
search-verified summary · [L] inference or volatile claim — verify before relying on it.

---

## 0. Ground rules this design inherits (repo-verified)

From `docs/FACTORY_OS_CURRENT_STATE.md` §3 — the invariants that shape every choice below:

1. Append-only stock ledger; corrections are new movements; balances derive from the ledger.
2. Posted documents are reversed, never edited or deleted (draft → posted → reversed).
3. Integer milli-units and integer cents; versioned never-overwritten config with document snapshots.
4. Audit on every mutation; permission on every route (fail-closed); tenant from session only.
5. **Server-side financial masking** (`maskMoney`/`stripFinancial`) — never UI hiding.
6. UUIDv7 identity everywhere; stored-UTC timestamps.

**Founder mandate (hard rules for this report):** POSTED financial/inventory/production transactions
are never silently merged or overwritten; conflict rules are explicit; sync status is always honest
and visible using exactly this vocabulary:

> **SAVED LOCALLY → WAITING TO SYNC → SYNCED**, with two branch states:
> **CONFLICT — REVIEW REQUIRED** (a human must decide) and **FAILED — RETRY** (transient; retried automatically, visibly).

**What "offline" means for JENIFY — three distinct gaps, often conflated [H by construction]:**

| Gap | Who loses whom | Today | Answer |
|---|---|---|---|
| G1: Internet loss | Site loses the cloud | Irrelevant — JENIFY has no cloud dependency | Already solved by architecture (R8 §3) |
| G2: LAN loss | Browser device loses the site node | The real gap — a tablet in the yard, Wi-Fi drop, node reboot | **This report: Phases O1–O2** |
| G3: Site isolation | A site loses HQ / other sites | Future multi-site only | R8 Profile 4 direction; **Phase O3** |

Most vendors sell G1 solutions. JENIFY's differentiator is that G1 is already free; our engineering
budget goes to G2 (device ↔ node) and, later, G3 (node ↔ node).

---

## A. PWA / local-first web layer

### A.1 Service-worker caching strategies

Canonical strategy set [H]: **cache-first** for the versioned app shell (JS/CSS/icons),
**network-only** for mutations, and for business reads either network-first or
stale-while-revalidate — with the industry warning that SW-cached API responses easily become
*silently* stale ([MagicBell offline-first guide](https://www.magicbell.com/blog/offline-first-pwas-service-worker-caching-strategies)).

Our `packages/web/public/sw.js` is already the correct conservative baseline [H — repo-verified]:
static shell cache-first, `/api/` and navigation always network. **Keep API responses OUT of the
service-worker cache permanently.** Two reasons:

- The SW cache is invisible to the app: it cannot attach "as of 14:32" staleness metadata, cannot be
  scoped per user/role, and survives logout unless explicitly purged. An SW-cached `/api/stock`
  response shown as if live is precisely the *dishonest status* the Founder mandate forbids.
- Offline reads belong in the **application layer** (A.2), where TanStack Query already owns caching:
  `packages/web/src/lib/queries.ts` wraps every read in `useQuery`, and every cache entry carries
  `dataUpdatedAt` — a free, honest staleness timestamp. Persisting that cache (official
  `@tanstack/react-query-persist-client` + an IndexedDB persister) gives offline reads *with
  provenance* for a few hundred lines, no new data layer [H — repo-verified seam, M — persister effort].

### A.2 Local stores: IndexedDB vs OPFS/Wasm-SQLite vs localStorage

| Store | Verdict for JENIFY | Why |
|---|---|---|
| localStorage | Never for business data | Synchronous, ~5 MB, string-only, no transactions [H] |
| **IndexedDB** | **Yes — O1 read cache + O2 op queue** | Async, transactional, structured, universal support; the boring default [H] |
| OPFS + SQLite Wasm | No (revisit only if a true device-local relational store is ever justified) | Real SQLite in-browser, much faster than IndexedDB for bulk I/O (sync access handles are worker-only) ([Chrome Developers](https://developer.chrome.com/blog/sqlite-wasm-in-the-browser-backed-by-the-origin-private-file-system), [RxDB comparison](https://rxdb.info/articles/localstorage-indexeddb-cookies-opfs-sqlite-wasm.html)) [H]. But it invites the mistake we reject: a second ledger in the browser. Our client state is a *cache + queue*, small by design; IndexedDB is sufficient and simpler [H — design judgment] |

**The doctrine (from R8 §2, Odoo lesson): browser storage is a cache and a mailbox, never a ledger.**
Everything client-side must be losable: losing the device store may lose *unsynced queued ops*
(which is why the queue is small, capped, and its age visible — C.3), never posted data.

### A.3 Background Sync API — treat as enhancement, never foundation

- One-shot Background Sync (`SyncManager`) is **Chromium-only**: Chrome/Edge/Samsung Internet on
  desktop + Android; **no Safari (any), no Firefox** — ~76% global support
  ([caniuse](https://caniuse.com/background-sync), [LambdaTest matrix](https://www.lambdatest.com/web-technologies/background-sync)) [H].
- Even where supported, the OS may delay or coalesce sync events, and the browser can terminate
  service workers aggressively on low-RAM devices [M].

**Contract:** the portable baseline is a **foreground queue**: IndexedDB queue drained on app open,
on `online` events, and on a visible-timer while the app is open. Where `SyncManager` exists it is
registered as a bonus drain trigger. Correctness never depends on the SW being alive [H — this is
also the standard fallback pattern per the caniuse/community guidance above].

### A.4 Real-world limits on low-end Android (the Mesob device class — R8 §1.3)

- **Quota:** Chromium allows up to ~60% of free disk per origin; Safari is far tighter (~1 GB
  desktop, less on iOS) ([MDN storage quotas & eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)) [H].
  On a cheap tablet with 32 GB flash that is nearly full — the realistic case — the effective quota
  is small and **eviction is LRU by origin under disk pressure** [H].
- **`navigator.storage.persist()`** exempts the origin from eviction, but granting is heuristic
  (site engagement, PWA installed); Chrome data shows automatic eviction is rare in practice
  ([web.dev persistent storage](https://web.dev/articles/persistent-storage)) [H]. Request it at
  login on installed devices; **display, never assume, the result**.
- **Safari/WebKit deletes all script-writable storage (IndexedDB included) after 7 days of non-use**
  for non-installed sites; home-screen-installed web apps are exempt
  ([Michael Tsai / WebKit summary](https://mjtsai.com/blog/2020/03/26/safari-13-1-third-party-cookie-blocking-and-7-day-script-writeable-storage/)) [H].
  Consequence: on any iOS device, JENIFY offline features require **installed-PWA mode**; a Safari
  tab is read-cache-only with a warning.
- Low-end Android (Go-class, ≤3 GB RAM): browser tabs and service workers are killed under memory
  pressure; large JS payloads hurt most ([Android Go optimization](https://pinakinvox.com/blog/android-go-apps-how-to-optimize-your-software-for-low-spec-devices), [PWA bottlenecks](https://www.hashstudioz.com/blog/why-do-some-pwas-feel-slower-than-native-apps-solving-performance-bottlenecks/)) [M].
  Our 69 kB gzip initial bundle budget is a genuine offline asset — protect it.

**Failure modes:** cache evicted mid-shift (must degrade to "no local copy", never to wrong data);
user clears browsing data (queued ops gone — cap queue size, show queue age, encourage drain before
shift end); private/incognito windows (storage ephemeral — detect and refuse offline mode) [H].

**RECOMMENDED JENIFY APPROACH (A):** keep `sw.js` shell-only forever; add an IndexedDB-persisted
TanStack Query cache with mandatory "as of &lt;time&gt;" staleness labels and an offline banner; foreground
op queue with Background Sync as opportunistic enhancement; `storage.persist()` requested and
surfaced; installed-PWA required for offline duty on iOS; every client store losable by design.

---

## B. Local site/server architecture

### B.1 What actually fits a synchronous better-sqlite3 Fastify server

Survey of the SQLite-ecosystem options against our stack (single-writer WAL better-sqlite3, all
writes inside `inTx`, services enforcing permissions/validation/audit):

| Option | Model | Fit verdict |
|---|---|---|
| **Tally-style LAN single server** | One box owns the data; devices are thin clients | **Already our topology** (R8 §2, §4 Profile 2/3). Massively validated; the base of everything below [H] |
| **PouchDB/CouchDB** | Per-document revision trees; every replica accepts writes; conflicts kept, a **deterministic-but-arbitrary winner** is auto-picked (longest revision history, then ASCII-highest rev) ([CouchDB replication & conflicts](https://docs.couchdb.org/en/stable/replication/conflicts.html), [PouchDB conflicts guide](https://pouchdb.com/guides/conflicts.html)) [H] | **Rejected.** "Arbitrary winner" on an invoice is silent overwrite by another name; enforcing app-level invariants (stock ≥ 0, doc-number uniqueness, permissions) across independently-writable replicas is exactly the trap. Would also replace our entire storage layer |
| **Litestream** | Continuous WAL streaming to object storage / second disk — **disaster recovery, not multi-writer sync**; explicitly positions itself vs read-replica tools ([litestream.io/alternatives](https://litestream.io/alternatives/), [how it works](https://litestream.io/how-it-works/)) [H] | **Adopt for its actual job**: continuous local backup of the site node to a second disk/USB (R8 §5 already recommends this). Not a sync engine — zero conflict semantics |
| **LiteFS** | FUSE filesystem replicating SQLite pages, single-writer primary + read replicas; pre-1.0, Fly.io deprioritized, LiteFS Cloud sunset Oct 2024 ([2025 VPS comparison](https://onidel.com/blog/sqlite-replication-vps-2025)) [M] | **Rejected**: Linux/FUSE-only (we deploy on Windows laptops/mini-PCs), read-replicas don't solve offline *writes*, project momentum gone |
| **Turso/libSQL embedded replicas** | Local replica for reads; **writes are forwarded to the remote primary** and require connectivity; managed cloud service ([Turso embedded replicas overview](https://botmonster.com/web-dev/turso-libsql-sqlite-edge-embedded-replicas/)) [M] | **Rejected**: writes-need-network defeats the purpose, and a paid cloud dependency violates principle 7 (local only) |
| **ElectricSQL (next)** | **Read-path sync only**: streams Postgres subsets ("shapes") to clients; **writes go through your own API** — deliberately out of scope for the engine ([PowerSync comparison](https://powersync.com/blog/electricsql-electric-next-vs-powersync)) [M] | Not adoptable (Postgres-based) — but its *philosophy* is exactly ours: sync engines should move reads; writes belong to the application's validated API [H — design endorsement] |
| **PowerSync** | Postgres→client-SQLite read sync + a client **upload queue** whose writes are applied by *your backend* with full validation ([PowerSync architecture](https://powersync.com/blog/electricsql-vs-powersync)) [M] | Not adoptable (Postgres + hosted service) — but independently validates the O2 shape: local queue, backend-authoritative writes |

### B.2 The conclusion the survey forces

**No off-the-shelf SQLite sync layer fits, and none is needed.** Every credible modern system
(ElectricSQL, PowerSync, Replicache — C.1) converges on the same shape: **the server's database
remains the sole authority; clients hold a read cache plus an outbound operation queue; "sync" is a
pair of application-level HTTP endpoints, not database-level replication.** Our synchronous
better-sqlite3 server is actually an *advantage* here: applying a queued op is just calling the same
service function the online route calls, inside the same `inTx`, with the same permission check and
audit write — total ordering per site for free from the single-writer model [H — design conclusion].

**Performance:** a day of Mesob business events is well under 1 MB (R8 §1.2); queue drain is tens of
small POSTs; the SQLite write path (~thousands of simple tx/sec on N100-class hardware) is orders of
magnitude above need [H for volume math, M for hardware figure].

**RECOMMENDED JENIFY APPROACH (B):** topology stays Tally-shaped (site node owns the ledger;
devices are browsers — R8 Profiles 2/3, gated on T3). Sync is two first-party Fastify endpoints
(`push ops` / `pull changes` — contracts in C.3) plus Litestream-class continuous local backup as a
separate, unrelated concern. No CouchDB, no FUSE, no cloud replicas, no second ledger anywhere.

---

## C. Synchronization models for business ledgers

### C.1 The four models, compared for ledgers specifically

| Model | How it merges | Ledger verdict |
|---|---|---|
| **Op-log / command queue + server-side replay** | Client records *intents* ("post receipt X"), server replays each through full validation and either applies or rejects; client state is then rebased on server truth. This is Replicache's model: speculative client mutations, **authoritative server mutations whose result completely replaces the speculative one**, unconfirmed ops replayed like a git rebase ([Replicache docs](https://doc.replicache.dev/byob/local-mutations)) [H] | **CORRECT for JENIFY.** The server remains the only party that ever *posts*; offline changes are proposals until acknowledged. Maps 1:1 onto our existing service layer |
| **CRDT** | Every replica accepts writes; mathematically guaranteed convergence by merging | **WRONG for postings** — see C.2 |
| **Last-write-wins** | Highest timestamp silently overwrites | **FORBIDDEN.** Silent data loss as a design principle; also depends on client clocks, which we must never trust for ledger ordering [H] |
| **Append-only ledger merge (site/stream ownership)** | Each writer owns disjoint streams; merging is interleaving, conflicts structurally impossible | **CORRECT for G3 (site↔site)** — R8 Profile 4: only the owning site posts to its own warehouses/sequences; events ship verbatim; corrections travel as new reversal events [H — design] |

The right architecture uses **two** of these: op-log replay for device→node (the device is *not* a
trusted writer), and append-only stream shipping for node→node (each node *is* the trusted writer
for its own streams).

### C.2 Why CRDTs are the wrong tool for financial postings

- **CRDTs merge; they never reject.** Their guarantee is convergence, not correctness: all concurrent
  writes are accepted and deterministically combined. But ledgers live on **global invariants that
  span replicas**: balance ≥ 0, stock ≥ 0, credit limit not exceeded, one sequential document number,
  permission checked *at commit time*. The classic demonstration: balance 100, one offline client
  spends 70, another spends 40 — both locally valid, the converged balance is −10. Convergence
  achieved, business rule destroyed ([Loro, "When Not to Use CRDTs"](https://loro.dev/docs/concepts/when_not_crdt)) [M — 403 on direct fetch; consistent with the literature below].
- The academic literature is explicit that upholding such invariants requires coordination or
  resource pre-partitioning — escrow/bounded-counter CRDTs that pre-allocate spending/decrement
  rights per replica ([CRDT overview, Preguiça 2018](https://arxiv.org/pdf/1806.10254);
  [Kleppmann-school local-first invariants work](https://programming-group.com/assets/pdf/papers/2024_Consistent-Local-First-Software-Enforcing-Safety-and-Invariants-for-Local-First-Applications.pdf)) [H].
  Escrow *could* work for stock ("tablet may issue up to 50 bags offline") — but that is quota
  management wearing a research costume: enormous machinery to avoid a queue that resolves in
  seconds once the LAN returns.
- CRDTs also cannot express **cross-entity atomicity** (invoice + stock movement + balance must post
  together or not at all) — our services do this in one `inTx` today; no mainstream CRDT does [H].
- Where CRDTs *are* right: collaborative text, presence, whiteboards — high-frequency concurrent
  edits to the same object where any merged state is acceptable. No JENIFY entity has that shape;
  our closest case (concurrent master-data edits) is better served by explicit versioning + human
  review (D) [H — design judgment].

**Verdict: no CRDTs anywhere in the JENIFY sync path.** This also rules out CRDT-based frameworks
(Automerge, Yjs-persistence, Loro) as sync foundations.

### C.3 The op-log contract (what O2/O3 will implement — defined now, built later)

**Op envelope [H — design]:**

```
{
  opId:        UUIDv7          // generated at capture; THE idempotency key, immutable across retries
  deviceId:    UUIDv7          // registered per device (E.2)
  seq:         integer         // per-device monotonic sequence (FIFO order)
  opType:      string          // e.g. "receipt.create_draft" — an approved catalog, not arbitrary SQL
  payload:     object          // integer units/cents; validated schema per opType
  capturedAt:  ISO-8601 UTC    // display metadata ONLY — never ledger ordering
  authRef:     session token   // whose permissions the server re-checks at REPLAY time
}
```

Key rules, each mapped to a known failure mode
([idempotency/retry-storm/dead-letter field guide](https://dev.to/salazarismo/the-hidden-problems-of-offline-first-sync-idempotency-retry-storms-and-dead-letters-1no8),
[AWS retry-with-backoff pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/retry-backoff.html)) [H unless noted]:

1. **Idempotency = intent identity.** `opId` is minted once when the user confirms the action and
   never regenerated on retry. Server keeps a `sync_ops` table (`tenant_id, op_id PK, device_id,
   result_status, result_ref, applied_at`); a duplicate `opId` returns the recorded result without
   re-executing. This is the *only* defense that makes "double-posted stock receipt" structurally
   impossible — the cardinal sin of ledger sync.
2. **Server-side replay through the full pipeline.** Applying an op = calling the same service as
   the online route: permission check (fail-closed, against *current* role config), input validation,
   business validation, `inTx`, `writeAudit`. An op is never "imported" — it is *re-requested*. The
   audit row records both `capturedAt` (device time, display) and `appliedAt` (server time, truth).
3. **Ordering.** Per-device strict FIFO (`seq`); cross-device order is server arrival order — the
   single-writer SQLite node makes this total and unambiguous. Client clocks never order the ledger;
   document numbers are assigned only at server post time (D12's atomic `UPDATE…RETURNING` already
   fixed the race).
4. **Acknowledgement.** Push response is per-op, explicit, and terminal:
   `applied {serverRef}` → **SYNCED** · `rejected {code, reason}` → **CONFLICT — REVIEW REQUIRED**
   (human decision) · transport/5xx → no ack → stays **WAITING TO SYNC** / **FAILED — RETRY**.
   Business rejection is NEVER retried automatically — retrying a rejection is how double-posts and
   retry storms are born; only transport failures retry.
5. **Retry: exponential backoff + full jitter**, capped (e.g. 1 s → 2 → 4 → … → 5 min max), reset on
   `online` event or app foreground. Queue-level, not per-op-parallel (FIFO preserved).
6. **Safe reconnect = push, then pull, then rebase.** Client pushes unacked ops, pulls server changes
   from its stored cursor (`lastServerSeq`), replaces local cache with server truth, and re-applies
   only still-unacked ops as speculative overlays (Replicache's rebase discipline, [H]). A reconnect
   after 3 days must behave identically to one after 3 seconds.
7. **Poison ops park, visibly.** An op that fails validation repeatedly or whose `opType` version is
   no longer accepted becomes **CONFLICT — REVIEW REQUIRED**, is removed from the drain path, and is
   preserved (a dead-letter with a face). Subsequent ops that *depended* on it (same document chain)
   park with it; independent ops continue. No silent dead-letter queues.
8. **Queue limits are policy, visible, Square-style** (R8 §2: 72 h expiry, caps): max queue age and
   size per device; a queue older than the policy window blocks *new* offline captures (not the
   drain) and yells at the user. An offline queue nobody looks at is a liability, not a feature.

**Failure modes this contract closes [H]:** duplicate posting (1), permission drift while offline
(2 — replay re-checks), clock skew (3), lost ack / re-send ambiguity (1+4), retry storms (4+5),
zombie queue after long disconnection (6+8), one bad op silently blocking a shift's work (7).

**RECOMMENDED JENIFY APPROACH (C):** op-log capture on devices; server-side authoritative replay
through existing services; UUIDv7 `opId` idempotency table; per-device FIFO + server-arrival total
order; explicit per-op acks driving the five honest statuses; backoff+jitter on transport only;
append-only stream shipping reserved for future node↔node (G3). No CRDTs, no LWW, no merge code path
for any posted document — ever.

---

## D. Conflict handling for ERP data

### D.1 Entity-class taxonomy (the heart of the contract)

| Class | Entities (JENIFY today) | Offline policy | Conflict story |
|---|---|---|---|
| **R — Reads** | Dashboards, stock view, lists, reports, printed docs | Cache freely (masked payloads only — E) | No conflicts; only *staleness*, always labeled "as of &lt;time&gt;" |
| **D — Own drafts** | Draft receipts/invoices; unsubmitted forms | Auto-sync; a draft belongs to one user | Same draft edited on two devices of the same user → newest-wins is acceptable *for drafts only*, with the losing version kept in history [M — UX judgment]; escalate to CONFLICT only if both diverged materially |
| **M — Master data & config** | Items, parties, prices, credit limits, role matrices, settings | **Read-only offline in O1/O2.** Edits online-only (or queued as *proposals* later) | Optimistic concurrency: every edit carries the base version (our config is already append-only versioned); base ≠ current → **CONFLICT — REVIEW REQUIRED**. No field-level auto-merge for anything financial (price, credit limit, VAT): two half-merged edits to a price list is a business incident, not a convenience [H — design] |
| **L — Ledger postings** | Stock movements, goods receipts, transfers, production output, QC posts, invoices (posting), deliveries | **Queue-and-validate** (O2 subset, then O3). The device never posts; it proposes. Server replay validates against *current* stock/credit/status | Merge conflicts are structurally impossible (single poster). The conflict class that remains is **stale-world rejection**: "batch already closed", "stock insufficient", "customer over credit limit since you went offline" → **CONFLICT — REVIEW REQUIRED** with reason + one-tap re-entry with fresh data. Never auto-adjusted to fit |
| **X — High-risk / irreversible** | Payments, reversals/cancellations, user/role/permission admin, settings changes, go-live ops | **Online-only, permanently** (LAN-online to the node in O3 counts as online) | None — the class exists precisely so these never enter a queue. Mirrors Square capping/expiring offline payments and Loyverse disabling refunds offline (R8 §2) [H] |

Class X is the deliberately boring, defensible line: **money movement and authority changes require
a live conversation with the ledger.** Everything the yard/production floor actually needs during a
Wi-Fi drop lives in D and L.

### D.2 Status state machine (the mandated vocabulary, made precise)

```
capture ──► SAVED LOCALLY ──► WAITING TO SYNC ──► (push) ──► SYNCED
                                    │                          ▲
                                    ├── transport failure ──► FAILED — RETRY ── backoff ──┘ (auto)
                                    └── business rejection / version mismatch ──► CONFLICT — REVIEW REQUIRED ── human ──► re-entry (new opId) or discard (audited)
```

Honesty rules [H — mandate-derived]: the status is per-record AND aggregated in one global chip
("3 waiting · 1 needs review"); SYNCED is only ever set on server ack, never optimistically; a
CONFLICT can only leave the state by explicit human action, which is itself audited; discarding a
conflicted op requires the same permission the op would have needed.

### D.3 Reviewer UX patterns (what good looks like)

- **A conflict inbox, not a modal ambush**: reviewable queue with age, device, user, and reason;
  ordered oldest-first; badge on the nav. Modeled on SAP's ErrorArchive *concept* done right — SAP
  stores failed offline requests in an ErrorArchive the app must surface; when vendors skip that UI,
  requests rot invisibly and field users lose work, the #1 documented failure of offline SAP MDK
  deployments ([SAP offline OData error/conflict docs](https://help.sap.com/doc/c2d571df73104f72b9f1b73e06c5609a/Latest/en-US/docs/user-guide/odata/Offline_OData_Handling_Errors_And_Conflicts.html),
  [MobilitySAP field report](https://mobilitysap.com/en/resources/offline-sap-mdk/)) [H/M].
- **Class M conflicts**: side-by-side base/mine/theirs with per-field provenance; resolution options
  are *keep mine / keep theirs / edit fresh* — never automatic blending. Oracle Field Service ships
  exactly this manual-resolution screen for offline collisions ([Oracle FS docs](https://docs.oracle.com/en/cloud/saas/field-service/faaca/t-resolve-conflict.html)) [M].
- **Class L rejections**: show the op as captured, the server's reason, and the *current* state of
  the world (live stock, batch status), then offer prefilled re-entry as a new op. The user's typing
  is never thrown away; the ledger is never bent to fit it.
- **Who reviews**: conflicts route to the capturing user for re-entry, escalate to a supervisor
  permission (`sync.review` module/action in our matrix) after a policy age — matching our existing
  role-split doctrine (QC release gate precedent) [H — design].

### D.4 How competitors actually behave (delta to R8 §2 — conflict lens only)

| System | Conflict behavior | Where it fails |
|---|---|---|
| SAP Mobile Services / Offline OData | ETag optimistic concurrency; failed uploads land in ErrorArchive with error categories (network vs contract violation vs business logic) — a genuinely correct taxonomy ([SAP troubleshooting docs](https://help.sap.com/doc/f53c64b93e5140918d676b927a3cd65b/Cloud/en-US/docs-en/guides/features/offline/common/handling-errors-and-conflicts/offline-errors-troubleshooting.html)) [H] | Resolution UX is left to each app team; in practice the archive is unsurfaced and users never learn their work didn't land [M]. Lesson: **the taxonomy is table stakes; the surfaced inbox is the product** |
| Odoo POS | Orders queue in the browser; sync on reconnect; no real conflict model (orders are inserts) | Queue lives in evictable browser storage — cache clear/crash loses paid orders (R8 §2) [H]. Lesson: the queue must be small, visible, aged, and the device must never be the only holder of money-relevant data longer than necessary |
| Tally | Avoids device conflicts entirely: one LAN server, thin clients; multi-site is manual export/import of data between company files | The manual transfer path is unaudited and error-prone in practice [M]. Lesson: our G3 answer (signed append-only event shipping, R8 Profile 4) is "Tally sneakernet, made honest" |
| Square / Loyverse | No merges — capability reduction offline + caps/expiry on the risky class (R8 §2) [H] | Expired offline payments are simply lost (Square) — harsh but *explicit*. Lesson: Class X online-only + visible queue limits beat clever recovery |
| Field-service suites (Oracle FS, SAP FSM, FieldPro class) | Offline capture of visits/orders; manual conflict screens for master-data collisions | Conflict screens exist but training is the bottleneck; unreviewed conflicts pile up [M]. Lesson: route conflicts to a *person with an incentive* (supervisor escalation), not just a screen |

**RECOMMENDED JENIFY APPROACH (D):** adopt the five-class taxonomy (R/D/M/L/X) as a permanent
contract annotated per entity in code; the five-status state machine exactly as mandated; conflict
inbox + supervisor escalation as the reviewer UX; SAP's error taxonomy (transport / contract /
business) internally, mapped to FAILED — RETRY vs CONFLICT — REVIEW REQUIRED externally; Class X
never queues, ever.

---

## E. Security of offline caches on shared / lost devices

### E.1 Threat model (ordered by likelihood at a Mesob-class site)

1. **Shared device, many staff** — one yard tablet used by warehouse + production roles across shifts.
2. **Lost/stolen phone or tablet** with cached business data (prices, customer debts, volumes).
3. **Curious insider** with physical access — IndexedDB/OPFS are plaintext on disk at the app layer;
   browser tools read them trivially. OWASP ranks exactly this (unencrypted local DBs and caches) as
   Mobile Top-10 **M9: Insecure Data Storage** ([OWASP M9](https://owasp.org/www-project-mobile-top-10/2023-risks/m9-insecure-data-storage)) [H].
   Android full-disk/file-based encryption protects a *powered-off* device only; an unlocked device
   protects nothing [H].
4. XSS reading the cache — mitigated primarily by not putting secrets there at all.

### E.2 Patterns, and what JENIFY already gets free

- **The strongest control already exists: server-side masking (invariant 5).** The client can only
  ever cache what the server already decided that role may see — `maskMoney`/`stripFinancial` run
  before any byte reaches the device. Contract: **the offline cache stores server responses verbatim,
  post-masking; the client never caches an unmasked superset for later filtering.** A stolen
  warehouse tablet therefore leaks no prices/debts because it never received them [H — repo-verified
  mechanism; the contract makes it permanent].
- **Cache partitioning:** cache keys include `tenantId + userId + role-permission version`. Role or
  permission-version change invalidates the partition; logout **purges** it (drafts/queue survive
  only in encrypted form). No cross-user cache reads on shared devices [H — design].
- **Encryption at rest for what remains:** encrypt IndexedDB payloads (read cache + op queue) with
  AES-GCM via WebCrypto; the data key is wrapped and the wrapping key is **non-extractable**, stored
  as a CryptoKey in IndexedDB — extractable by no script, usable only in place — optionally re-wrapped
  by a short numeric PIN for unlock-offline ([Corella, Storing Cryptographic Keys in Persistent
  Browser Storage](https://icmconference.org/wp-content/uploads/A33a-Corella.pdf), [secure-webstore](https://github.com/AKASHAorg/secure-webstore)) [H mechanism].
  Honest limit [H]: a non-extractable key stops *casual and insider* extraction, not a determined
  attacker with the unlocked device — which is why masking-before-caching (above) carries the real
  weight, and why Class X data never exists client-side at all.
- **Offline session policy:** cookie sessions cannot be revoked while offline — accept it,
  bound it. Contract: offline access runs on a device-local grace window (configurable, e.g. 72 h)
  gated by a local PIN that unwraps the cache key; past the window the cache locks (queue retained,
  encrypted) until the node is reachable and the session re-validates. On reconnect the server can
  return `device_disowned` (admin marked the device lost), which triggers immediate client-side
  purge of cache + queue before anything else happens. This mirrors the server-invalidated-key
  pattern for lost devices in enterprise offline vaults [M].
- **Device registry:** O2 introduces `deviceId`; O3 makes it a first-class admin object (name,
  user-binding, last-seen, *disown* button). Disowning is an audited admin action.
- **Never on the device:** passwords, recovery codes, role matrices, other users' data, unmasked
  financial payloads, audit history. The op queue holds the user's *own captured intents* only.

### E.3 Minimalism is the security architecture

R8 §4 established that today "a stolen tablet loses zero business data" because tablets hold
nothing. Every offline feature spends that safety. The taxonomy in D.1 is therefore also the
security budget: Class R cached masked, Class D/L queued encrypted and small, Class M/X never
stored. Offline capability is granted **per device and per role** (a yard tablet gets receiving
drafts; the owner's phone gets read-cache dashboards; a shared counter phone gets nothing) — an
explicit admin choice, not a default [H — design].

**RECOMMENDED JENIFY APPROACH (E):** masked-payloads-only caching (contractual, tested); per
user+role-version cache partitions purged on logout/role change; AES-GCM encryption of cache+queue
under a non-extractable wrapped key with PIN unlock; 72 h-class offline grace window then lock;
device registry with audited disown-and-purge on reconnect; Class X data never cached. Threat-model
honesty in the UI: "offline mode stores limited data on this device" shown at enablement.

---

## F. Proposed phased contract

Sequencing note: **O1 is deliberately tiny and could ride with any UI milestone; O2 begins only
after Milestone 1 hardening lands (D5 validation, WP7 frontend test harness) — the op replay
pipeline leans on both; O3 is gated on T3 (LAN serving) + a jenify-architect review of the D/C
contracts, per offline-infra rule 2.** No phase starts without Founder go.

### Phase O1 — Honest offline reading (cache + status, zero writes)

**Scope:** persisted TanStack Query cache (IndexedDB) for Class R reads; global connectivity/status
chip; "as of &lt;time&gt;" staleness labels on every cached view; offline banner; `storage.persist()`
request + surfaced result; logout purge; installed-PWA guidance for iOS. `sw.js` unchanged
(shell-only). **Non-goals:** any write while offline; any new server endpoint; encryption (nothing
cached beyond what the logged-in role already saw on screen — masking is already in force).

**Acceptance criteria:**
- Airplane-mode: previously visited dashboards/lists render from cache, each visibly labeled with
  its data timestamp; never presented as live; unvisited views show an honest "no local copy" state.
- Cached payloads are byte-identical to the masked server responses (test asserts no unmasked field
  ever enters the persister).
- Logout (and login as a different user) leaves zero readable cache from the prior user.
- Cache eviction/clear degrades to "no local copy" — no crash, no stale-as-live.
- Status chip states: ONLINE / OFFLINE — SHOWING SAVED DATA; reconnect refetches and clears labels.
- Server suite untouched and green (163+); initial-bundle budget not regressed; frontend tests cover
  the persister, purge, and staleness label.

### Phase O2 — Queued idempotent writes (small safe subset)

**Scope:** IndexedDB op queue + the C.3 envelope; server `POST /api/sync/ops` (+ `sync_ops`
idempotency table, additive migration) replaying through existing services; the five-status state
machine end-to-end; conflict inbox v1; backoff+jitter drain (foreground; Background Sync as
enhancement); queue age/size caps with visible policy; AES-GCM queue encryption + PIN unlock +
offline grace window; `deviceId` registration. **Subset (Class D + one L probe):** create/edit *own
drafts* of goods receipts and invoices, and draft-stage capture for production/QC — **posting of
anything remains online-only; Class X untouched; master data read-only offline.**
**Non-goals:** offline posting, payments, master-data edits, multi-device merge, node↔node sync.

**Acceptance criteria:**
- Capture offline → SAVED LOCALLY → WAITING TO SYNC → reconnect → SYNCED, with server-side audit
  rows carrying capturedAt + appliedAt; document numbers assigned only at (online) posting.
- Replaying the same push twice (and a crafted duplicate `opId`) yields exactly one application and
  returns the recorded ack — proven by a two-connection idempotency test.
- Permission revoked while offline → op rejected at replay → CONFLICT — REVIEW REQUIRED with reason;
  nothing partially applied.
- Stale-world rejection (e.g. draft's warehouse deactivated) surfaces in the conflict inbox with
  prefilled re-entry; discard requires permission and writes an audit event.
- Kill the browser mid-drain, clear ack race: no duplicate, no lost op (queue survives restart).
- Queue past policy age blocks new offline capture with an explicit message; drain still allowed.
- Device store inspected raw: queue + cache ciphertext only; wrong PIN locks, never wipes silently;
  `device_disowned` on reconnect purges before any drain.
- Full server suite green; new suite covers replay, idempotency, rejection taxonomy mapping
  (transport→FAILED — RETRY, business→CONFLICT — REVIEW REQUIRED).

### Phase O3 — Site-server multi-device (and the road to multi-site)

**Scope:** productized LAN node (T3 + service supervision, per R8 Profile 2/3) so *devices* are
normally LAN-online and O1/O2 become the *degraded* mode, not the norm; device registry admin UI
(bind, last-seen, disown); `GET /api/sync/changes?cursor=` pull endpoint for cache priming/rebase;
supervisor conflict escalation (`sync.review`); concurrency tests at 2–6 devices (numbering, credit,
stock races — D12 regression class). **Direction-setting only (build gated on jenify-architect +
Founder):** node↔node G3 sync as signed append-only event shipping with site-owned streams (R8
Profile 4), USB sneakernet as first-class transport, HQ-owned master data. **Non-goals:** any
node↔node engine code, cloud relays, two sites posting to one warehouse — the last is rejected
permanently, not deferred.

**Acceptance criteria:**
- 2–6 devices posting concurrently against the node: no duplicate document numbers, no lost
  postings, no cross-tenant/role leakage; ledger recompute (`recomputeBalances`) shows zero drift.
- Wi-Fi loss mid-shift on one device: it degrades to O1/O2 behavior and reconciles on reconnect with
  correct statuses; the node and other devices are unaffected.
- Node reboot (power cut) mid-drain: WAL recovery clean; devices resume from cursors; idempotency
  holds across the restart.
- Disown flow: lost tablet marked disowned → next contact purges it; audit trail complete.
- Restore drill (R8 §5) re-run under O3: standby node from snapshot; devices re-point and reconcile
  without duplicate application of previously-acked ops (acks are in the snapshot's `sync_ops`).

---

## G. Open questions for the Founder / Team Lead

1. Offline capture priorities on the floor: which two or three real Mesob moments hurt most today
   (truck at the gate with Wi-Fi down? stage output at the far shed?) — O2's subset should be chosen
   from observed pain, not from this desk.
2. Offline grace window and queue-age policy values (proposed defaults: 72 h grace, 48 h max queue
   age) — business decision, Square-style explicitness.
3. PIN-unlock acceptability for shared yard tablets (vs. full re-login when offline).
4. Confirm Class X membership — especially: are *deliveries* confirmations ever needed offline
   (they touch stock), or is the gate always within LAN reach once Profile 3 ships?

---

## Team Lead summary (12 lines)

1. Three different "offlines": internet loss (already solved — no cloud), device↔node LAN loss (the real gap; O1/O2), site↔site (future; O3/R8 Profile 4). Budget goes to the middle one.
2. PWA layer: keep `sw.js` shell-only forever; offline reads live in a persisted TanStack Query cache with mandatory "as of" labels; Background Sync API is Chromium-only — foreground queue is the portable baseline; browser storage is evictable, so everything client-side stays losable by design.
3. Off-the-shelf sync (CouchDB/PouchDB, LiteFS, Turso replicas, ElectricSQL, PowerSync) all fail our constraints — but they converge on our answer: server DB stays sole authority, clients hold cache + op queue, sync is two first-party HTTP endpoints on our own Fastify API.
4. Sync model: op-log with server-side authoritative replay (Replicache-style rebase) for device→node; append-only site-owned stream shipping for future node→node. CRDTs are rejected with cause — they merge and never reject, and ledgers live on global invariants (balance/stock ≥ 0, sequential numbers, commit-time permissions) that merging destroys. LWW is forbidden outright.
5. Idempotency contract: UUIDv7 `opId` minted at capture, server `sync_ops` table replays-once and returns the recorded ack; business rejections never auto-retry; backoff+jitter for transport only; reconnect = push → pull-from-cursor → rebase.
6. Conflict taxonomy (permanent): Reads cache with staleness · own Drafts auto-sync · Master data read-only offline, version-checked, human-reviewed · Ledger postings queue-and-validate, never merged · payments/reversals/admin are online-only forever.
7. The five mandated statuses map to a precise state machine; SYNCED only on server ack; CONFLICT leaves only by audited human action; conflict inbox + supervisor escalation is the UX (SAP's taxonomy is right, its unsurfaced ErrorArchive is the cautionary tale).
8. Security: server-side masking already means devices can only cache what the role may see — made contractual; caches partitioned per user+role-version, purged on logout; AES-GCM under a non-extractable wrapped key with PIN unlock; 72 h offline grace; device registry with audited disown-and-purge.
9. Phases: O1 honest read cache (tiny, no server change) → O2 queued idempotent writes for drafts only (after M1 hardening; server replay endpoint + idempotency table) → O3 LAN site node multi-device (gated on T3 + architect review), with node↔node as direction only.
10. Each phase has explicit acceptance criteria including double-push idempotency proof, permission-drift rejection, mid-drain crash recovery, and restore-drill compatibility.
11. Nothing here rushes the engine: O1 ships value alone; O2/O3 contracts are now defined tightly enough that a future implementer cannot accidentally build a merging ledger.
12. Open for Founder: which floor moments need offline capture first, grace-window/queue-age values, PIN acceptability, and whether delivery confirmation must ever work offline.
