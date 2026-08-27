# Headquarter connectors — GitHub and Google Drive (lane G)

Issue #140 (retry of #123), child of war room #117. Scope: `packages/headquarter/src/connectors/**`.

Headquarter's archive answers "what do we actually have evidence for?". Connectors are how
external evidence gets into that answer **without moving, editing, or copying the evidence
itself**. A connector produces an *index*: a reference plus provenance, pointing back at an
untouched original.

## What a connector is (and is not)

| It is | It is not |
|---|---|
| A pure function from already-fetched source metadata to index records | A network client — it opens no sockets |
| Read-only by construction | A writer: no outbound GitHub or Drive mutation exists in this lane |
| Explicit about what it could and could not confirm | A cache that shows old data as if it were current |
| A source *for the existing archive pipeline* (`archive/inventory.ts`) | A second, parallel ingestion pipeline |

The caller — a CLI, an MCP tool call, or a saved export — performs the actual read and hands the
result to the connector. That split is deliberate: it keeps ingestion deterministic and unit
testable, and it makes it structurally impossible for a token to reach this code.

## Modules

| File | Responsibility |
|---|---|
| `types.ts` | Connector kinds, states, confidence/lifecycle vocabulary, `Provenance`, `IndexRecord`, `ConnectorSnapshot` |
| `safety.ts` | Secret scrubbing, untrusted-text sanitization, locator link safety, content digests |
| `github.ts` | Issue / pull request / commit ingestion for a repository |
| `drive.ts` | Google Drive file ingestion over an existing read-only access path |
| `sync.ts` | Deterministic incremental sync, idempotency, staleness, truthful reporting |
| `registry.ts` | Registered connectors + declared-but-unbuilt extension points; least-privilege enforcement |

## Truthfulness rules

These are the rules the tests exist to defend:

1. **Only `state: 'ok'` with `complete: true` asserts confirmed-current data.** Everything else —
   `partial`, `stale`, `unavailable`, `needs_auth`, `blocked`, `outcome_unknown` — is surfaced as
   itself, with the caller's real reason attached.
2. **A failed read never overwrites good data with silence.** Previous records are retained with
   their provenance and downgraded to `unconfirmed`; `lastConfirmedAt` does not move forward.
3. **Absence is evidence only in a complete read.** A record missing from a partial page is left
   alone. A record missing from a complete read is marked `unavailable` — never deleted.
4. **No date is ever invented.** A missing or malformed source date yields `dateConfidence:
   'estimated'` and the archive pipeline's own flagged fallback.
5. **No item is ever invented.** Unidentifiable items are dropped and reported as a
   `malformed_metadata` issue rather than being given a synthetic id.

## Security posture

- **Credentials never enter this code.** `AccessDescriptor` carries a fixed `read_only` mode, scope
  *labels*, and an optional non-secret account label. `assertNoSecretMaterial` throws if anything
  credential-shaped is passed, and every finished snapshot is re-checked before it is returned.
- **Untrusted input is scrubbed, not trusted.** Values under credential-looking keys are dropped
  outright; credential shapes in free text (`ghp_…`, `ya29.…`, PEM headers, `password: …`) are
  replaced with `[redacted]` and reported as a `secret_material` issue.
- **Identifiers beat URLs.** A source-supplied `html_url` / `webViewLink` is accepted only when it
  matches the item's own identifiers; otherwise the canonical URL is derived locally (GitHub) or an
  inert `drive://<id>` locator is used (Drive), and an `identity_mismatch` issue is raised.
- **Link safety is decided once.** `classifyLocator` marks a locator linkable only for a well-formed
  `https:` URL with no embedded credentials on an allowlisted host. `ui/render.ts` independently
  re-checks the scheme at render time (issue #106), so the two defenses are not one.
- **Least privilege is enforced, not promised.** `ConnectorRegistry.register` rejects any connector
  whose declared scopes contain `write`, `append`, `modify`, `delete`, `admin`, `send`, `manage`,
  `full_control` or `compose`.
- **Privacy.** Drive owner email addresses are deliberately not indexed; a display name is enough
  for attribution.

## Extension points

`CONNECTOR_KINDS` already declares `gmail`, `calendar`, `jenify_web`, `jenify_products` and
`media`. `ConnectorRegistry.list()` reports them as `planned` so a caller can never mistake
"not built yet" for "nothing found". A later lane adds an adapter that returns a
`ConnectorSnapshot` and inherits provenance, sync, staleness and safety unchanged — no new
pipeline, no changes to `sync.ts`.

## Known limitations

- **No fetching.** Connectors do not page, retry, or rate-limit; the caller does, and reports what
  it achieved via `page.complete` / `page.cursor` / `failure`. A caller that lies about
  completeness will cause records to be retired incorrectly — that trust boundary is explicit.
- **Sync state is not persisted here.** `ConnectorSyncState` is a plain serializable value. Wiring
  it into the Headquarter store is deliberately out of this lane's scope, so no schema, migration
  or state machine is duplicated.
- **Summaries are bounded** at 280 characters, matching the archive record shape. Full issue and
  document bodies are not copied — the locator is the way to the original.
- **Secret redaction can produce false positives** in free text (e.g. a document that literally
  contains `password: <something>`). The trade was made deliberately: an over-redacted summary
  fragment is recoverable from the original; a leaked credential is not.
- **`drive://<id>` locators are inert by design** and render as text, not links.
- **Staleness is advisory**: `applyStaleness` must be called with the current time by whoever
  presents the data; nothing here runs on a timer.

## Rollback

Self-contained and additive. Reverting the PR removes `packages/headquarter/src/connectors/**`,
its two test files, this document, the `./connectors` export in `package.json`, one line in
`src/index.ts`, and the two-line `drive-api` addition to `archive/inventory.ts` (a new
`dateSource` value plus its `exact`-confidence mapping). No database schema, no migration, no
persisted state, and no changes to organization, member, memory or Operator internals — so
nothing else depends on it and there is nothing to migrate back.
