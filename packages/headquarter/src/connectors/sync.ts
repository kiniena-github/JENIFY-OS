/**
 * Deterministic, idempotent connector sync.
 *
 * The engine is shared by every connector: a connector supplies a page
 * fetcher (already authorized by the caller) and a normalizer, and gets back
 * an index of references plus an honest account of what the run could and
 * could not establish.
 *
 * Guarantees this module is responsible for:
 *
 * - **Idempotency.** Running the same observations twice at the same instant
 *   produces a byte-identical index. Re-observing an item at the same
 *   revision counts as `unchanged` and rewrites nothing.
 * - **Provenance preservation.** Revision and locator history are append-only.
 *   An earlier observation is never overwritten, only superseded.
 * - **No invented deletions.** An item is only marked `missing_at_source`
 *   when the run was authoritative — complete pagination AND every item
 *   usable. A partial or malformed run leaves prior state alone.
 * - **No invented success.** Fetcher failures become typed problems and a
 *   non-`current` status; a thrown fetcher becomes `outcome_unknown`, never
 *   an empty successful listing.
 */

import {
  assertReadOnlyScope,
  connectorRecordKey,
  type ConnectorIndexEntry,
  type ConnectorProblem,
  type ConnectorScope,
  type ConnectorState,
  type ConnectorStatus,
  type ItemNormalizer,
  type ObservedItem,
  type PageFetcher,
  type SyncCounts,
  type SyncOutcome,
} from './types.js';
import { redactSecrets, sanitizeText } from './safety.js';

/* ------------------------------------------------------------------ */
/* Index                                                               */
/* ------------------------------------------------------------------ */

export interface ConnectorIndex {
  readonly connectorId: string;
  readonly entries: Map<string, ConnectorIndexEntry>;
}

export function createConnectorIndex(connectorId: string): ConnectorIndex {
  return { connectorId, entries: new Map() };
}

/** Deep copy, so a caller can diff before/after without aliasing. */
export function cloneConnectorIndex(index: ConnectorIndex): ConnectorIndex {
  const copy = createConnectorIndex(index.connectorId);
  for (const [key, entry] of index.entries) {
    copy.entries.set(key, {
      ...entry,
      provenance: { ...entry.provenance },
      revisions: entry.revisions.map((mark) => ({ ...mark })),
      locatorHistory: [...entry.locatorHistory],
      notes: [...entry.notes],
    });
  }
  return copy;
}

/** Entries sorted by key — the canonical, deterministic ordering. */
export function listIndexEntries(index: ConnectorIndex): ConnectorIndexEntry[] {
  return [...index.entries.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/* ------------------------------------------------------------------ */
/* Applying observations                                               */
/* ------------------------------------------------------------------ */

export interface ApplyContext {
  /** Sync-run instant, injected so the engine stays pure and testable. */
  syncAt: string;
  /**
   * True when the listing was read to the end and every item was usable.
   * Only an authoritative run may conclude an unseen item is gone.
   */
  authoritative: boolean;
}

export interface ApplyResult {
  counts: Pick<SyncCounts, 'ingested' | 'updated' | 'unchanged' | 'missing'>;
}

function mergeNotes(existing: string[], incoming: string[] | undefined): string[] {
  if (!incoming || incoming.length === 0) return existing;
  const merged = new Set(existing);
  for (const note of incoming) merged.add(note);
  return [...merged].sort();
}

/**
 * Fold observations into the index in place. Pure with respect to time: the
 * only clock is `ctx.syncAt`.
 */
export function applyObservations(
  index: ConnectorIndex,
  observations: ObservedItem[],
  ctx: ApplyContext,
): ApplyResult {
  const counts = { ingested: 0, updated: 0, unchanged: 0, missing: 0 };
  const seen = new Set<string>();

  for (const item of observations) {
    const key = connectorRecordKey(item.provenance);
    seen.add(key);
    const lifecycle = item.deletedAtSource ? ('deleted_at_source' as const) : ('active' as const);
    const existing = index.entries.get(key);

    if (!existing) {
      index.entries.set(key, {
        key,
        provenance: { ...item.provenance },
        title: item.title,
        summary: item.summary,
        lifecycle,
        sourceConfidence: item.sourceConfidence,
        dateConfidence: item.dateConfidence,
        sourceCreatedAt: item.sourceCreatedAt,
        sourceUpdatedAt: item.sourceUpdatedAt,
        firstSeenAt: ctx.syncAt,
        lastSeenAt: ctx.syncAt,
        lastSyncAt: ctx.syncAt,
        revisions: [{ revision: item.provenance.revision, observedAt: ctx.syncAt }],
        locatorHistory: [item.provenance.locator],
        linkSafe: item.linkSafe,
        notes: mergeNotes([], item.notes),
      });
      counts.ingested += 1;
      continue;
    }

    const previousRevision = existing.revisions[existing.revisions.length - 1]?.revision ?? null;
    const revisionChanged = previousRevision !== item.provenance.revision;
    const locatorChanged = existing.provenance.locator !== item.provenance.locator;
    // Copied, never aliased: mergeNotes may hand back `existing.notes` itself,
    // and pushing into that would mutate an entry a caller may still hold.
    const notes = [...mergeNotes(existing.notes, item.notes)];
    if (locatorChanged) notes.push('locator_changed_at_source');

    index.entries.set(key, {
      ...existing,
      // Provenance identity (connectorId/kind/nativeId) is fixed by the key;
      // the mutable parts are refreshed, and the old values are retained in
      // the append-only histories below.
      provenance: { ...item.provenance },
      title: item.title,
      summary: item.summary,
      lifecycle,
      sourceConfidence: item.sourceConfidence,
      dateConfidence: item.dateConfidence,
      sourceCreatedAt: item.sourceCreatedAt,
      sourceUpdatedAt: item.sourceUpdatedAt,
      lastSeenAt: ctx.syncAt,
      lastSyncAt: ctx.syncAt,
      revisions: revisionChanged
        ? [...existing.revisions, { revision: item.provenance.revision, observedAt: ctx.syncAt }]
        : existing.revisions,
      locatorHistory: locatorChanged
        ? [...existing.locatorHistory, item.provenance.locator]
        : existing.locatorHistory,
      linkSafe: item.linkSafe,
      notes: [...new Set(notes)].sort(),
    });

    if (revisionChanged) counts.updated += 1;
    else counts.unchanged += 1;
  }

  // Deletion detection — authoritative runs only. A partial run says nothing
  // about the items it never looked at.
  if (ctx.authoritative) {
    for (const [key, entry] of index.entries) {
      if (seen.has(key)) continue;
      const stillPresent = entry.lifecycle === 'active' || entry.lifecycle === 'unavailable';
      index.entries.set(key, {
        ...entry,
        lastSyncAt: ctx.syncAt,
        lifecycle: stillPresent ? 'missing_at_source' : entry.lifecycle,
        // The record itself is retained: it is a reference to evidence that
        // existed and was observed. Only its lifecycle changes.
        sourceConfidence: stillPresent ? 'cached' : entry.sourceConfidence,
      });
      if (stillPresent) counts.missing += 1;
    }
  }

  return { counts };
}

/* ------------------------------------------------------------------ */
/* Status resolution                                                   */
/* ------------------------------------------------------------------ */

const STATUS_BY_PROBLEM: Record<string, ConnectorStatus> = {
  blocked_by_policy: 'blocked',
  auth_required: 'needs_auth',
  unknown_outcome: 'outcome_unknown',
  unreachable: 'unavailable',
  rate_limited: 'partial',
  partial_pagination: 'partial',
  malformed_item: 'partial',
};

/** Most severe problem wins; a clean, complete run is the only `current`. */
export function resolveSyncStatus(input: {
  authoritative: boolean;
  problems: ConnectorProblem[];
}): ConnectorStatus {
  const order: ConnectorStatus[] = ['blocked', 'needs_auth', 'outcome_unknown', 'unavailable', 'partial'];
  let worst: ConnectorStatus | null = null;
  for (const problem of input.problems) {
    const status = STATUS_BY_PROBLEM[problem.code];
    if (!status) continue;
    if (worst === null || order.indexOf(status) < order.indexOf(worst)) worst = status;
  }
  if (worst) return worst;
  return input.authoritative ? 'current' : 'partial';
}

/* ------------------------------------------------------------------ */
/* Sync runner                                                         */
/* ------------------------------------------------------------------ */

export interface RunConnectorSyncOptions {
  connectorId: string;
  scope: ConnectorScope;
  index: ConnectorIndex;
  fetchPage: PageFetcher;
  normalize: ItemNormalizer;
  /** Sync-run instant. Injected — the engine never reads the wall clock. */
  now: string;
  startCursor?: string | null;
  /** Page ceiling; hitting it yields a resumable `partial` run, not a lie. */
  maxPages?: number;
  /** Cap on how many malformed-item problems are reported (all are counted). */
  maxReportedRejects?: number;
}

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_MAX_REPORTED_REJECTS = 25;

export async function runConnectorSync(options: RunConnectorSyncOptions): Promise<SyncOutcome> {
  const {
    connectorId,
    index,
    fetchPage,
    normalize,
    now,
    startCursor = null,
    maxPages = DEFAULT_MAX_PAGES,
    maxReportedRejects = DEFAULT_MAX_REPORTED_REJECTS,
  } = options;

  const problems: ConnectorProblem[] = [];
  const observations: ObservedItem[] = [];
  let observed = 0;
  let rejected = 0;
  let cursor: string | null = startCursor;
  let completedListing = false;
  let fetchFailed = false;

  try {
    assertReadOnlyScope(options.scope);
  } catch (error) {
    problems.push({ code: 'blocked_by_policy', message: sanitizeText(errorMessage(error), 300) });
    return finish();
  }

  for (let page = 0; page < maxPages; page += 1) {
    let result;
    try {
      result = await fetchPage(cursor);
    } catch (error) {
      // A throw tells us nothing about whether the source actually answered.
      // Reporting `unavailable` would be a guess; `outcome_unknown` is honest.
      fetchFailed = true;
      problems.push({ code: 'unknown_outcome', message: sanitizeText(errorMessage(error), 300) });
      break;
    }
    if (!result.ok) {
      fetchFailed = true;
      problems.push({ ...result.problem, message: sanitizeText(result.problem.message, 300) });
      break;
    }
    for (const raw of result.page.items) {
      observed += 1;
      const normalized = normalize(raw, now);
      if (!normalized.ok) {
        rejected += 1;
        if (problems.filter((p) => p.code === 'malformed_item').length < maxReportedRejects) {
          problems.push({ code: 'malformed_item', message: sanitizeText(normalized.reason, 200) });
        }
        continue;
      }
      observations.push(normalized.item);
    }
    cursor = result.page.nextCursor;
    if (cursor === null) {
      completedListing = true;
      break;
    }
  }

  if (!completedListing && !fetchFailed) {
    problems.push({
      code: 'partial_pagination',
      message: `Stopped after ${maxPages} page(s) with more results pending; resume from the returned cursor`,
    });
  }

  return finish();

  function finish(): SyncOutcome {
    // Authoritative requires BOTH a complete listing and zero unusable items:
    // an item we could not parse might be one we would otherwise have seen,
    // so its absence must never be read as a deletion.
    const authoritative = completedListing && !fetchFailed && rejected === 0;
    const applied = applyObservations(index, observations, { syncAt: now, authoritative });
    const counts: SyncCounts = {
      observed,
      ingested: applied.counts.ingested,
      updated: applied.counts.updated,
      unchanged: applied.counts.unchanged,
      rejected,
      missing: applied.counts.missing,
    };
    return {
      connectorId,
      status: resolveSyncStatus({ authoritative, problems }),
      startedAt: now,
      completedAt: now,
      authoritative,
      cursor: completedListing ? null : cursor,
      counts,
      problems,
      entries: listIndexEntries(index),
    };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  return redactSecrets(String(error));
}

/* ------------------------------------------------------------------ */
/* Reported state                                                      */
/* ------------------------------------------------------------------ */

export interface DescribeConnectorStateOptions {
  connectorId: string;
  /** Outcome of the most recent attempt, if there has been one. */
  lastOutcome: SyncOutcome | null;
  /** Instant of the most recent `current` run, if any (may predate lastOutcome). */
  lastSuccessfulSyncAt: string | null;
  now: string;
  /** How long a successful sync stays "fresh". */
  maxAgeMs: number;
}

/**
 * Turn sync history into the claim a reader may safely make. Health and
 * freshness are separate axes on purpose: a connector that just failed can
 * still be showing valid last-known-good data, and a connector that is
 * perfectly healthy can be showing something nobody re-confirmed today.
 */
export function describeConnectorState(options: DescribeConnectorStateOptions): ConnectorState {
  const { connectorId, lastOutcome, lastSuccessfulSyncAt, now, maxAgeMs } = options;
  const status: ConnectorStatus = lastOutcome?.status ?? 'stale';
  const nowMs = Date.parse(now);
  const successMs = lastSuccessfulSyncAt ? Date.parse(lastSuccessfulSyncAt) : Number.NaN;
  const ageMs = Number.isNaN(successMs) || Number.isNaN(nowMs) ? null : nowMs - successMs;

  const freshness = ageMs === null ? 'never_synced' : ageMs <= maxAgeMs ? 'fresh' : 'stale';

  let dataClaim: ConnectorState['dataClaim'];
  if (status === 'current' && freshness === 'fresh') dataClaim = 'confirmed_current';
  else if (status === 'partial') dataClaim = 'partial';
  else if (freshness === 'never_synced') dataClaim = 'no_data';
  else dataClaim = 'last_known_good';

  return {
    connectorId,
    // A run that succeeded but has since aged out is reported as stale, not
    // as current: "it worked an hour ago" is not "this is current".
    status: status === 'current' && freshness === 'stale' ? 'stale' : status,
    freshness,
    dataClaim,
    lastAttemptAt: lastOutcome?.completedAt ?? null,
    lastSuccessfulSyncAt,
    ageMs,
    problems: lastOutcome?.problems ?? [],
  };
}
