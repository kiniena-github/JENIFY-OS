# Headquarter connectors — GitHub and Google Drive

Special lane G (issue #123, executed as retry #140). Implemented in
`packages/headquarter/src/connectors/**`, exported as
`@factoryos/headquarter/connectors`.

A connector reads an external source of evidence and produces **index records
that point at the original**. It does not copy, move, rename, rewrite or delete
source evidence, and it does not perform any outbound mutation.

---

## 1. What exists

| Connector | Status | Source-native kinds | Scope |
|---|---|---|---|
| `github` | implemented | `repository`, `issue`, `pull_request`, `commit` | read |
| `drive` | implemented | `drive_file`, `drive_folder` | read |
| `gmail` | planned (extension point only) | — | read |
| `calendar` | planned (extension point only) | — | read |
| `jenify-web` | planned (extension point only) | — | read |
| `jenify-products` | planned (extension point only) | — | read |
| `media` | planned (extension point only) | — | read |

`assertConnectorImplemented(id)` refuses a planned or unknown connector with a
`connector_not_implemented` policy error. A planned connector never returns an
empty-but-successful result that could be mistaken for "there is nothing there".

## 2. Design rules

1. **Read-first, least privilege.** `CONNECTOR_SCOPES` contains exactly one
   value, `read`. There is no type in this lane that can express a write, and
   `assertReadOnlyScope` blocks any sync attempted with another scope *before*
   the fetcher is called.
2. **Credentials never enter this package.** A connector receives pages from an
   already-authorized `PageFetcher` supplied by the caller. Configuration
   describes *what* to read, never *how* to authenticate:
   `assertNoCredentialFields` refuses any config carrying a credential-shaped
   key at any nesting depth, and `assertNoSecretMaterial` / `redactSecrets`
   keep token-shaped strings out of index records and error messages.
3. **Originals are preserved.** Index entries carry the source-native id, the
   revision marker and a locator. Revision history and locator history are
   append-only — a later observation never overwrites an earlier one.
4. **Locators are constructed, not trusted.** The canonical link is built from
   validated components (`owner/repo` + number/sha, or a validated Drive file
   id). A payload `html_url`/`webViewLink` that disagrees, or that uses a
   non-`https` scheme, is recorded as a note and downgrades source confidence to
   `reported` — it never becomes the locator.
5. **Failures never become success.** A fetcher failure becomes a typed
   problem and a non-`current` status; a *thrown* fetcher becomes
   `outcome_unknown`, because a throw tells us nothing about whether the source
   answered.
6. **Confirmed-current is a claim, not a default.** Every entry carries source
   confidence, date confidence, lifecycle, and last-sync metadata.

## 3. Determinism and idempotency

The sync engine takes its clock as an argument (`now`) — it never reads the
wall clock. Consequences:

- Replaying the same run at the same instant produces a byte-identical index.
- Re-observing an item at the same revision counts as `unchanged` and rewrites
  nothing.
- The idempotency key is `<connectorId>:<nativeKind>:<nativeId>`.
- Pagination is resumable: a capped run returns `status: 'partial'` and a
  cursor, and resuming from that cursor completes the listing.

### Deletion detection requires an authoritative run

A run is `authoritative` only when **both**:

- the listing was read to the end (`nextCursor === null`, no fetch failure), and
- **every** item in it was usable (`rejected === 0`).

Only an authoritative run may mark a previously-known item `missing_at_source`.
A partial run, a failed run, or a run containing an item we could not parse says
nothing about the items it did not see, so prior state is left alone. An item
that reappears returns to `active`.

Records are never removed from the index. A deleted or vanished source becomes
`deleted_at_source` / `missing_at_source` with `sourceConfidence: 'cached'`, and
maps to archive status `ARCHIVED` — the reference to what once existed survives.

## 4. State vocabulary

`ConnectorStatus` — outcome of the last attempt:
`current` · `partial` · `stale` · `unavailable` · `needs_auth` · `blocked` ·
`outcome_unknown`. Only `current` may be presented as confirmed live data
(`isConfirmedCurrent`).

`ConnectorDataClaim` — what a reader may honestly say, from
`describeConnectorState`:

| Claim | Meaning |
|---|---|
| `confirmed_current` | last sync succeeded **and** is inside the freshness window |
| `last_known_good` | data is real but nobody re-confirmed it recently, or the last attempt failed |
| `partial` | only part of the source was read |
| `no_data` | the connector has never synced successfully |

Health and freshness are separate axes on purpose: a successful sync that has
aged past `maxAgeMs` is reported as `stale` / `last_known_good`, not `current`.

`ConnectorLifecycle` (per item): `active` · `deleted_at_source` ·
`missing_at_source` · `unavailable`.

`SourceConfidence`: `confirmed` · `reported` · `cached` · `unverified`.
`DateConfidence` reuses the archive schema's `exact` / `inferred` / `estimated`.

## 5. Drive authorization

`DriveConnectorConfig.authState` is explicit: `authorized`, `needs_auth`, or
`unknown`. When it is not `authorized`, `syncDrive` returns a truthful outcome
(`needs_auth` / `outcome_unknown`) **without calling the fetcher** and without
touching the index — it never returns an empty listing that could be read as
"the folder is empty", and it never marks known files missing because
authorization lapsed.

## 6. Archive integration

Connector output crosses into the existing inventory pipeline through
`toEvidenceItems` / `createConnectorSourceAdapter`, which emit the
`EvidenceItem` shape `reconstructArchive` already consumes — exactly the seam
`createStaticExportAdapter` anticipated. There is no second reconstruction path
and no duplicated schema.

Two small additive changes were made to `src/archive/inventory.ts` to support
this without weakening it:

- `EvidenceItem.dateSource` gained `'drive-api'` (treated as authoritative).
- `EvidenceItem.dateConfidence?` was added as an explicit override, so an
  adapter that already knows how much its date can be trusted (a Drive file
  with only a modification time is `inferred`, not `exact`) is not second-guessed
  by `confidenceFor`. Existing callers are unaffected: without the field the
  previous derivation applies.

Archive ids are namespaced `<connectorId>-<nativeKind>-<nativeId>` so a GitHub
issue number and a Drive file id cannot collide, and tags carry
`lifecycle:` / `source-confidence:` / `date-confidence:` qualifiers downstream.

## 7. Known limitations

- **No transport.** This lane ships adapters, not HTTP clients. The caller
  supplies `fetchPage`; wiring it to a live GitHub or Drive session (and the
  authorization that implies) is a separate, Founder-gated step.
- **No persistence.** `ConnectorIndex` is in-memory. Persisting it (SQLite
  table, migration, HQ store integration) is deliberately out of lane G scope —
  it touches store internals this lane was told not to edit.
- **No UI.** The archive UI renders connector-derived records through the
  existing archive views; there is no connector status panel yet.
- **Revision markers are source-reported.** For GitHub issues/PRs the revision
  is `updated_at`; a source that fails to bump it would be seen as unchanged.
  Commits use the sha and are therefore exact.
- **Drive change tokens are not used.** Incremental sync is listing-based; the
  Drive `changes.list` API would be more efficient and is a future improvement.
- **Timestamps do not distinguish item age from sync age at item level.**
  `lastSeenAt` / `lastSyncAt` are run-scoped, which is sufficient for the
  current staleness model.

## 8. Rollback

The lane is additive: one new directory (`src/connectors/`), one export entry,
five new test files, this document, and the two additive `inventory.ts` lines
described above. Reverting the merge commit removes it completely; nothing in
the existing organization, member, memory, Operator, archive or UI state
machines was modified, and no persisted schema or migration was introduced.

## 9. Tests

`packages/headquarter/test/connectors.*.test.ts` (98 tests):

| File | Covers |
|---|---|
| `connectors.sync.test.ts` | duplicate ingestion, replay idempotency, changed source, provenance/locator history, deleted vs missing vs partial, pagination + resume, failure truthfulness, staleness |
| `connectors.github.test.ts` | exact provenance, canonical locators, spoofed/`javascript:` `html_url`, malformed numbers/shas, cross-repo rejection, incremental update |
| `connectors.drive.test.ts` | id validation, revision preference, trashed files, folder kind, `needs_auth` / `unknown` auth, credential-config refusal, incremental sync |
| `connectors.security.test.ts` | secret detection/redaction/refusal (8 token shapes), XSS and link-safety, embedded credentials, scope enforcement, planned-connector refusal |
| `connectors.bridge.test.ts` | archive-record validity, `sourceRef` preservation, id namespacing, date-confidence carry-through, ARCHIVED on vanish, determinism |
