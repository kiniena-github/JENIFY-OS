# JENIFY Historical Archive — Structure & Metadata Schema

Stream 2 deliverable (war room #41 order D, task issue #43 orders 2–5).
Implementation: `packages/headquarter/src/archive/` (schema, inventory pipeline,
views, search), covered by `packages/headquarter/test/`.

## Principles

1. **Originals are sacred.** The archive is a layer of *canonical records that
   point at* historical evidence (repo files, commits, PRs, issues, Drive
   documents). It never rewrites, moves, renames, or deletes originals.
   `sourceRef` on every record is a pointer to the untouched original.
2. **One canonical record set, many views.** Monthly browsing and
   project-evolution browsing are both derived from the same records
   (`monthlyView`, `projectEvolutionView`) — no second source of truth.
3. **Dates carry confidence.** A reconstructed date is never silently trusted:
   every date is a `{ date, confidence, source }` triple.
4. **Reconstruction is deterministic and read-only.** The same evidence always
   yields the same records; adapters never mutate their sources.

## Logical structure

Records address as:

```
archive/<year>/<month>/<project>/<category>/<record-id>
```

- `year`/`month` derive from the record's **creation** date.
- `project` — product/company area (`JENIFY-OS`, `QOS`, `Jenify News`, `Jenify Labs`, …).
- `category` — e.g. `decision`, `review`, `report`, `code-change`, `upgrade`,
  `ai-task`, `pull-request`. Categories are free-form strings, not a hardcoded
  enum, so new areas never require a schema change.

This is an addressing/browsing scheme for records — it does **not** dictate a
physical folder migration of any existing files.

## Record metadata (`ArchiveRecord`)

| Field | Meaning |
|---|---|
| `id` | Stable unique id (`pr-7`, `commit-ed20eb2`, `issue-43`, `doc-corporate-v0`). |
| `title` | Human title. |
| `project` / `category` | Placement in the logical structure. |
| `created` | `DatedValue` — when the work/document was created. |
| `evidence` | `DatedValue` — when the evidence for it was observed/recorded. |
| `version` | Human-meaningful version (`V0`, `R4`, `v1.2`); auto-extracted from titles when present. |
| `status` | `CURRENT` \| `SUPERSEDED` \| `REJECTED` \| `EXPERIMENTAL` \| `ARCHIVED`. |
| `predecessorId` / `successorIds` | Evolution links between record versions. |
| `related` | Cross-links: issue numbers, PR numbers, commit shas, artifact locators. |
| `sourceRef` | Location of the preserved original (URL or repo path; Drive id later). |
| `summary` | Short human summary (≤280 chars when auto-derived). |
| `tags` | Free-form search tags. |

`DatedValue.confidence`:

- `exact` — authoritative timestamp (Git author date, GitHub API `created_at`).
- `inferred` — derived from nearby evidence (filename, manual dating from context).
- `estimated` — fallback guess; flagged in the UI and must be reviewed before
  being trusted.

Validation: `validateArchiveRecord()` returns explicit error strings; the
inventory CLI refuses to emit invalid records.

## Status lifecycle

- New reconstructed records default to `CURRENT`.
- Declaring an evolution chain (`linkEvolutionChain(records, [oldest..newest])`)
  links predecessor/successor and marks earlier entries `SUPERSEDED`.
- Terminal statuses (`REJECTED`, `ARCHIVED`, `EXPERIMENTAL`) are never
  downgraded automatically — a chain link keeps them as-is.
- Status changes are ordinary record updates in the canonical store; original
  evidence is never edited to reflect status.

## Inventory / reconstruction pipeline

`SourceAdapter` → `EvidenceItem[]` → `reconstructArchive()` → `ArchiveRecord[]`.

Shipped adapters:

- **`createGitLogAdapter`** — parses `git log --pretty=format:'%H%x1f%aI%x1f%s%x1e'`
  output (caller runs git; the adapter is pure). Commit dates are `exact`.
- **`createGitHubExportAdapter`** — consumes a pre-exported issues/PRs JSON
  snapshot (no live API calls at reconstruction time). API dates are `exact`.
- **`createStaticExportAdapter`** — consumes any pre-exported `EvidenceItem[]`
  JSON. **This is the Drive/local-files adapter contract:** a future Drive
  connector only needs to export this shape; the pipeline stays unchanged.

CLI: `npm run inventory --workspace @factoryos/headquarter` reconstructs the
records for this repository's GitHub-visible history into
`packages/headquarter/dist/archive-inventory.json` (gitignored derived data).
Run today it reconstructs 72 records from the full commit history plus the
checked-in issue/PR snapshot (`sample-data/github-export.json`).

## Search / indexing foundation

`buildIndex(records)` builds a dependency-free inverted index over title,
summary, project, category, version, and tags. `search(index, query)` combines
free text (AND semantics over tokens) with structured filters
(`project`, `category`, `status`, `year`, `tag`).

Worked example (covered by tests): `search(index, { text: 'qos chatbot upgrade' })`
returns every QOS chatbot upgrade record across months and versions — no folder
hunting. The Archive UI page embeds the same token semantics client-side.

## Explicitly out of scope in this wave

- Moving/deleting/renaming any existing user file or Drive content (Founder-gated
  migration task required).
- Live GitHub/Drive API ingestion (exports only; connectors are a later, separately
  reviewed step).
- Any write access to original evidence.
