/**
 * Deterministic incremental connector sync (issue #140 / #123, HQ lane G).
 *
 * The whole point of this module is that a sync tells the truth about what it
 * actually learned. Three rules, and every branch below is one of them:
 *
 * 1. **Idempotent.** Applying the same snapshot twice changes nothing the
 *    second time. Change detection is by content digest, not by timestamp, so
 *    a retried or replayed read is a no-op rather than a stream of edits.
 * 2. **Absence is only evidence when the read was complete.** A record missing
 *    from a `partial` page, or from a read that failed outright, is NOT marked
 *    gone — the connector simply did not look there. Only a complete, current
 *    read can retire a record, and even then it is marked `unavailable`, never
 *    deleted: the provenance of what we once saw is preserved.
 * 3. **A failed read never overwrites good data with silence.** On
 *    `unavailable` / `needs_auth` / `blocked` / `outcome_unknown` the previous
 *    records stay exactly as they were, downgraded to `stale` confidence, and
 *    the state carries the real reason. The UI can then say "12 records, last
 *    confirmed 3 days ago, Drive needs re-authorization" instead of showing an
 *    empty archive as if the evidence had vanished.
 */

import type {
  ConnectorKind,
  ConnectorSnapshot,
  ConnectorState,
  IndexRecord,
  LifecycleStatus,
  SourceConfidence,
} from './types.js';
import { isConfirmedCurrent, isUnusableState } from './types.js';

export interface ConnectorSyncState {
  connector: string;
  connectorKind: ConnectorKind;
  /** Last time a read actually reached the source (`ok` or `partial`). */
  lastSyncAt: string | null;
  /** Last time a COMPLETE, successful read confirmed the whole set. */
  lastConfirmedAt: string | null;
  /** State of the most recent sync attempt. */
  lastState: ConnectorState;
  lastStateReason: string | null;
  /** Resume cursor; only advanced by a read that reached the source. */
  cursor: string | null;
  /** Index records by id, in insertion-independent (sorted) order on read. */
  records: Record<string, IndexRecord>;
}

export interface SyncPlan {
  added: string[];
  updated: string[];
  unchanged: string[];
  /** Previously known, absent from a complete read; marked `unavailable`. */
  disappeared: string[];
  /**
   * True only when this sync could confirm the complete current set. When
   * false, absent records were deliberately left alone.
   */
  authoritative: boolean;
}

export interface SyncResult {
  state: ConnectorSyncState;
  plan: SyncPlan;
}

export function initialSyncState(connector: string, connectorKind: ConnectorKind): ConnectorSyncState {
  return {
    connector,
    connectorKind,
    lastSyncAt: null,
    lastConfirmedAt: null,
    lastState: 'outcome_unknown',
    lastStateReason: 'No sync has run yet.',
    cursor: null,
    records: {},
  };
}

const EMPTY_PLAN: Omit<SyncPlan, 'authoritative'> = {
  added: [],
  updated: [],
  unchanged: [],
  disappeared: [],
};

function withConfidence(
  record: IndexRecord,
  confidence: SourceConfidence,
  lifecycle: LifecycleStatus,
  lastCheckedAt: string,
): IndexRecord {
  return {
    ...record,
    lastCheckedAt,
    provenance: { ...record.provenance, sourceConfidence: confidence, lifecycle },
  };
}

/**
 * Fold a snapshot into the previous sync state.
 *
 * Pure: the inputs are not mutated, and the same (state, snapshot) pair always
 * yields the same result — which is what makes a retry safe.
 */
export function syncConnector(
  previous: ConnectorSyncState,
  snapshot: ConnectorSnapshot,
  options: { now?: string } = {},
): SyncResult {
  if (snapshot.connector !== previous.connector) {
    throw new Error(
      `syncConnector: snapshot for "${snapshot.connector}" cannot be applied to state for "${previous.connector}"`,
    );
  }
  const now = options.now ?? snapshot.observedAt;

  // --- Rule 3: a read that never reached the source changes no records. ---
  if (isUnusableState(snapshot.state)) {
    const records: Record<string, IndexRecord> = {};
    for (const [id, record] of Object.entries(previous.records)) {
      // Keep the record and its provenance; say plainly that it is no longer
      // confirmed. lastCheckedAt is NOT advanced: we did not check it.
      records[id] = {
        ...record,
        provenance: { ...record.provenance, sourceConfidence: 'unconfirmed' },
      };
    }
    return {
      state: {
        ...previous,
        lastState: snapshot.state,
        lastStateReason: snapshot.stateReason,
        // lastSyncAt / lastConfirmedAt / cursor deliberately unchanged.
        records,
      },
      plan: { ...EMPTY_PLAN, authoritative: false },
    };
  }

  const authoritative = isConfirmedCurrent(snapshot.state, snapshot.complete);
  const confidence: SourceConfidence = authoritative ? 'confirmed' : 'partial';

  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const records: Record<string, IndexRecord> = { ...previous.records };

  for (const incoming of snapshot.records) {
    const existing = previous.records[incoming.id];
    const next = withConfidence(incoming, confidence, incoming.provenance.lifecycle, now);
    if (!existing) {
      added.push(incoming.id);
    } else if (existing.digest !== incoming.digest) {
      updated.push(incoming.id);
    } else {
      unchanged.push(incoming.id);
    }
    records[incoming.id] = next;
  }

  // --- Rule 2: only a complete read may retire a record. ---
  const seen = new Set(snapshot.records.map((record) => record.id));
  const disappeared: string[] = [];
  if (authoritative) {
    for (const [id, record] of Object.entries(previous.records)) {
      if (seen.has(id)) continue;
      disappeared.push(id);
      records[id] = {
        ...record,
        lastCheckedAt: now,
        provenance: {
          ...record.provenance,
          // observedAt stays at the last time it was actually seen.
          sourceConfidence: 'confirmed',
          lifecycle: 'unavailable',
        },
      };
    }
  }

  return {
    state: {
      ...previous,
      lastSyncAt: now,
      lastConfirmedAt: authoritative ? now : previous.lastConfirmedAt,
      lastState: snapshot.state,
      lastStateReason: snapshot.stateReason,
      cursor: snapshot.cursor,
      records,
    },
    plan: {
      added: added.sort(),
      updated: updated.sort(),
      unchanged: unchanged.sort(),
      disappeared: disappeared.sort(),
      authoritative,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Staleness                                                           */
/* ------------------------------------------------------------------ */

/** Default freshness budget: data older than a day is presented as stale. */
export const DEFAULT_FRESHNESS_BUDGET_MS = 24 * 60 * 60_000;

export interface StalenessReport {
  stale: boolean;
  /** Age of the last CONFIRMED read in ms; null when there has never been one. */
  ageMs: number | null;
  reason: string | null;
}

export function evaluateStaleness(
  state: ConnectorSyncState,
  now: string,
  budgetMs: number = DEFAULT_FRESHNESS_BUDGET_MS,
): StalenessReport {
  if (!state.lastConfirmedAt) {
    return { stale: true, ageMs: null, reason: 'No complete read has ever confirmed this source.' };
  }
  const ageMs = Date.parse(now) - Date.parse(state.lastConfirmedAt);
  if (!Number.isFinite(ageMs)) {
    return { stale: true, ageMs: null, reason: 'Last confirmation time is unreadable.' };
  }
  if (ageMs > budgetMs) {
    return {
      stale: true,
      ageMs,
      reason: `Last confirmed ${Math.floor(ageMs / 60_000)} minutes ago, beyond the ${Math.floor(
        budgetMs / 60_000,
      )} minute freshness budget.`,
    };
  }
  return { stale: false, ageMs, reason: null };
}

/**
 * Apply a staleness verdict to the state: records keep their content and
 * provenance but stop claiming to be confirmed-current. Applying this to a
 * fresh state is a no-op, so it is safe to call on every read.
 */
export function applyStaleness(
  state: ConnectorSyncState,
  now: string,
  budgetMs: number = DEFAULT_FRESHNESS_BUDGET_MS,
): ConnectorSyncState {
  const report = evaluateStaleness(state, now, budgetMs);
  if (!report.stale) return state;
  const records: Record<string, IndexRecord> = {};
  for (const [id, record] of Object.entries(state.records)) {
    records[id] = {
      ...record,
      provenance: {
        ...record.provenance,
        sourceConfidence: record.provenance.sourceConfidence === 'unconfirmed' ? 'unconfirmed' : 'stale',
        // A deleted/unavailable record does not become "stale": the source
        // already told us what happened to it.
        lifecycle: record.provenance.lifecycle === 'active' ? 'stale' : record.provenance.lifecycle,
      },
    };
  }
  return {
    ...state,
    lastState: isUnusableState(state.lastState) ? state.lastState : 'stale',
    lastStateReason: report.reason,
    records,
  };
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

/** Records currently backed by a confirmed, current read — nothing else. */
export function confirmedRecords(state: ConnectorSyncState): IndexRecord[] {
  return listRecords(state).filter(
    (record) => record.provenance.sourceConfidence === 'confirmed' && record.provenance.lifecycle === 'active',
  );
}

/** All records, deterministically ordered by id. */
export function listRecords(state: ConnectorSyncState): IndexRecord[] {
  return Object.values(state.records).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * One honest line about a connector, for the Founder-facing UI. It never says
 * "up to date" unless the last read actually confirmed the whole set.
 */
export function summarizeConnectorState(state: ConnectorSyncState): string {
  const total = Object.keys(state.records).length;
  const confirmed = confirmedRecords(state).length;
  const head = `${state.connector}: ${state.lastState}`;
  const counts = `${confirmed} of ${total} record(s) confirmed current`;
  const when = state.lastConfirmedAt
    ? `last complete confirmation ${state.lastConfirmedAt}`
    : 'never fully confirmed';
  const why = state.lastStateReason ? ` — ${state.lastStateReason}` : '';
  return `${head}; ${counts}; ${when}${why}`;
}

/**
 * Evidence items for the existing archive reconstruction pipeline
 * (`archive/inventory.ts`). Connectors add a source to that pipeline; they do
 * not fork it. Retired and source-deleted records are excluded by default so
 * the archive never presents vanished evidence as live.
 */
export function toEvidenceItems(
  state: ConnectorSyncState,
  options: { includeInactive?: boolean } = {},
): IndexRecord['evidence'][] {
  const records = options.includeInactive
    ? listRecords(state)
    : listRecords(state).filter((record) => record.provenance.lifecycle !== 'unavailable' && record.provenance.lifecycle !== 'deleted');
  return records.map((record) => ({ ...record.evidence }));
}

/**
 * Provenance note for `ui/render.ts`'s archive banner: states in plain words
 * where the rows came from and how much of it is actually confirmed.
 */
export function provenanceNote(states: ConnectorSyncState[]): string {
  if (states.length === 0) return 'No connectors configured.';
  return states.map(summarizeConnectorState).join(' | ');
}
