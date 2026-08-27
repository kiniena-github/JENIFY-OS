/**
 * Sync-engine behaviour: idempotency, incremental change detection,
 * pagination truthfulness, lifecycle transitions and staleness.
 *
 * Every test injects the clock (`now`) so determinism is provable rather than
 * assumed.
 */
import { describe, expect, it } from 'vitest';
import {
  applyObservations,
  cloneConnectorIndex,
  createConnectorIndex,
  describeConnectorState,
  listIndexEntries,
  resolveSyncStatus,
  runConnectorSync,
} from '../src/connectors/sync.js';
import { connectorRecordKey, type ObservedItem, type PageResult } from '../src/connectors/types.js';

const T1 = '2026-08-27T10:00:00Z';
const T2 = '2026-08-27T11:00:00Z';
const T3 = '2026-08-27T12:00:00Z';

function observation(overrides: {
  nativeId: string;
  revision: string | null;
  observedAt: string;
  title?: string;
  deletedAtSource?: boolean;
  locator?: string;
}): ObservedItem {
  return {
    provenance: {
      connectorId: 'github',
      sourceSystem: 'github.com',
      container: 'kiniena-github/JENIFY-OS',
      nativeKind: 'issue',
      nativeId: overrides.nativeId,
      locator: overrides.locator ?? `https://github.com/kiniena-github/JENIFY-OS/issues/${overrides.nativeId}`,
      revision: overrides.revision,
      observedAt: overrides.observedAt,
    },
    title: overrides.title ?? `Issue ${overrides.nativeId}`,
    summary: 'summary',
    sourceCreatedAt: '2026-08-20T08:00:00Z',
    sourceUpdatedAt: overrides.revision,
    sourceConfidence: 'confirmed',
    dateConfidence: 'exact',
    deletedAtSource: overrides.deletedAtSource ?? false,
    linkSafe: true,
  };
}

/** Fetcher over fixed pages; `null` nextCursor on the final page. */
function pagedFetcher(pages: unknown[][]): (cursor: string | null) => Promise<PageResult> {
  return async (cursor) => {
    const index = cursor === null ? 0 : Number(cursor);
    return {
      ok: true,
      page: { items: pages[index] ?? [], nextCursor: index + 1 < pages.length ? String(index + 1) : null },
    };
  };
}

const passthrough = (raw: unknown): { ok: true; item: ObservedItem } => ({
  ok: true,
  item: raw as ObservedItem,
});

describe('idempotency and duplicate ingestion', () => {
  it('indexes an item once no matter how often the same revision is observed', () => {
    const index = createConnectorIndex('github');
    const item = observation({ nativeId: '140', revision: 'r1', observedAt: T1 });

    const first = applyObservations(index, [item], { syncAt: T1, authoritative: true });
    expect(first.counts).toMatchObject({ ingested: 1, updated: 0, unchanged: 0 });

    // Same item twice inside one page set is still one record.
    const dupInSameRun = applyObservations(index, [item, item], { syncAt: T2, authoritative: true });
    expect(dupInSameRun.counts).toMatchObject({ ingested: 0, unchanged: 2 });
    expect(index.entries.size).toBe(1);

    const entry = index.entries.get(connectorRecordKey(item.provenance));
    expect(entry?.revisions).toHaveLength(1);
    expect(entry?.firstSeenAt).toBe(T1);
  });

  it('is byte-identical when the same run is replayed at the same instant', async () => {
    const items = [
      observation({ nativeId: '1', revision: 'a', observedAt: T1 }),
      observation({ nativeId: '2', revision: 'b', observedAt: T1 }),
    ];
    const runOnce = async () => {
      const index = createConnectorIndex('github');
      return runConnectorSync({
        connectorId: 'github',
        scope: 'read',
        index,
        fetchPage: pagedFetcher([items]),
        normalize: passthrough,
        now: T1,
      });
    };
    expect(JSON.stringify(await runOnce())).toBe(JSON.stringify(await runOnce()));
  });

  it('re-running a completed sync against a populated index changes nothing but timestamps', async () => {
    const items = [observation({ nativeId: '1', revision: 'a', observedAt: T1 })];
    const index = createConnectorIndex('github');
    await runConnectorSync({
      connectorId: 'github',
      scope: 'read',
      index,
      fetchPage: pagedFetcher([items]),
      normalize: passthrough,
      now: T1,
    });
    const before = cloneConnectorIndex(index);

    const retry = await runConnectorSync({
      connectorId: 'github',
      scope: 'read',
      index,
      fetchPage: pagedFetcher([items]),
      normalize: passthrough,
      now: T1,
    });

    expect(retry.counts).toMatchObject({ ingested: 0, updated: 0, unchanged: 1, missing: 0 });
    expect(listIndexEntries(index)).toEqual(listIndexEntries(before));
  });
});

describe('changed source', () => {
  it('records a new revision without discarding the previous observation', () => {
    const index = createConnectorIndex('github');
    applyObservations(index, [observation({ nativeId: '140', revision: 'r1', observedAt: T1 })], {
      syncAt: T1,
      authoritative: true,
    });
    const result = applyObservations(
      index,
      [observation({ nativeId: '140', revision: 'r2', observedAt: T2, title: 'Retitled' })],
      { syncAt: T2, authoritative: true },
    );

    expect(result.counts.updated).toBe(1);
    const entry = index.entries.get('github:issue:140');
    expect(entry?.title).toBe('Retitled');
    expect(entry?.revisions).toEqual([
      { revision: 'r1', observedAt: T1 },
      { revision: 'r2', observedAt: T2 },
    ]);
    expect(entry?.firstSeenAt).toBe(T1);
    expect(entry?.lastSeenAt).toBe(T2);
  });

  it('keeps the original locator in history when the source reports a new one', () => {
    const index = createConnectorIndex('github');
    applyObservations(index, [observation({ nativeId: '9', revision: 'r1', observedAt: T1 })], {
      syncAt: T1,
      authoritative: true,
    });
    applyObservations(
      index,
      [
        observation({
          nativeId: '9',
          revision: 'r2',
          observedAt: T2,
          locator: 'https://github.com/kiniena-github/JENIFY-OS/pull/9',
        }),
      ],
      { syncAt: T2, authoritative: true },
    );

    const entry = index.entries.get('github:issue:9');
    expect(entry?.locatorHistory).toEqual([
      'https://github.com/kiniena-github/JENIFY-OS/issues/9',
      'https://github.com/kiniena-github/JENIFY-OS/pull/9',
    ]);
    expect(entry?.notes).toContain('locator_changed_at_source');
  });
});

describe('deleted and unavailable sources', () => {
  it('marks an item missing_at_source only after an authoritative run', () => {
    const index = createConnectorIndex('github');
    applyObservations(
      index,
      [
        observation({ nativeId: '1', revision: 'a', observedAt: T1 }),
        observation({ nativeId: '2', revision: 'b', observedAt: T1 }),
      ],
      { syncAt: T1, authoritative: true },
    );

    // Partial run that only saw #1 must NOT conclude #2 disappeared.
    const partial = applyObservations(index, [observation({ nativeId: '1', revision: 'a', observedAt: T2 })], {
      syncAt: T2,
      authoritative: false,
    });
    expect(partial.counts.missing).toBe(0);
    expect(index.entries.get('github:issue:2')?.lifecycle).toBe('active');

    // Authoritative run that did not see #2 may.
    const complete = applyObservations(index, [observation({ nativeId: '1', revision: 'a', observedAt: T3 })], {
      syncAt: T3,
      authoritative: true,
    });
    expect(complete.counts.missing).toBe(1);
    const gone = index.entries.get('github:issue:2');
    expect(gone?.lifecycle).toBe('missing_at_source');
    expect(gone?.sourceConfidence).toBe('cached');
    // The reference itself survives — evidence of what existed is not erased.
    expect(gone?.provenance.locator).toBe('https://github.com/kiniena-github/JENIFY-OS/issues/2');
    expect(gone?.revisions).toHaveLength(1);
  });

  it('honours an explicit deletion flag from the source', () => {
    const index = createConnectorIndex('drive');
    applyObservations(
      index,
      [observation({ nativeId: '7', revision: 'v1', observedAt: T1, deletedAtSource: true })],
      { syncAt: T1, authoritative: true },
    );
    expect(index.entries.get('github:issue:7')?.lifecycle).toBe('deleted_at_source');
  });

  it('restores an item to active when it reappears', () => {
    const index = createConnectorIndex('github');
    applyObservations(index, [observation({ nativeId: '1', revision: 'a', observedAt: T1 })], {
      syncAt: T1,
      authoritative: true,
    });
    applyObservations(index, [], { syncAt: T2, authoritative: true });
    expect(index.entries.get('github:issue:1')?.lifecycle).toBe('missing_at_source');

    applyObservations(index, [observation({ nativeId: '1', revision: 'a', observedAt: T3 })], {
      syncAt: T3,
      authoritative: true,
    });
    expect(index.entries.get('github:issue:1')?.lifecycle).toBe('active');
  });
});

describe('pagination truthfulness', () => {
  it('reads every page and reports a complete run as current', async () => {
    const index = createConnectorIndex('github');
    const outcome = await runConnectorSync({
      connectorId: 'github',
      scope: 'read',
      index,
      fetchPage: pagedFetcher([
        [observation({ nativeId: '1', revision: 'a', observedAt: T1 })],
        [observation({ nativeId: '2', revision: 'b', observedAt: T1 })],
      ]),
      normalize: passthrough,
      now: T1,
    });

    expect(outcome.status).toBe('current');
    expect(outcome.authoritative).toBe(true);
    expect(outcome.cursor).toBeNull();
    expect(outcome.counts).toMatchObject({ observed: 2, ingested: 2 });
  });

  it('reports partial (never current) and returns a resume cursor when capped', async () => {
    const index = createConnectorIndex('github');
    const outcome = await runConnectorSync({
      connectorId: 'github',
      scope: 'read',
      index,
      fetchPage: pagedFetcher([
        [observation({ nativeId: '1', revision: 'a', observedAt: T1 })],
        [observation({ nativeId: '2', revision: 'b', observedAt: T1 })],
      ]),
      normalize: passthrough,
      now: T1,
      maxPages: 1,
    });

    expect(outcome.status).toBe('partial');
    expect(outcome.authoritative).toBe(false);
    expect(outcome.cursor).toBe('1');
    expect(outcome.problems.map((p) => p.code)).toContain('partial_pagination');
  });

  it('resumes deterministically from the returned cursor', async () => {
    const index = createConnectorIndex('github');
    const pages = [
      [observation({ nativeId: '1', revision: 'a', observedAt: T1 })],
      [observation({ nativeId: '2', revision: 'b', observedAt: T1 })],
    ];
    const first = await runConnectorSync({
      connectorId: 'github',
      scope: 'read',
      index,
      fetchPage: pagedFetcher(pages),
      normalize: passthrough,
      now: T1,
      maxPages: 1,
    });
    const second = await runConnectorSync({
      connectorId: 'github',
      scope: 'read',
      index,
      fetchPage: pagedFetcher(pages),
      normalize: passthrough,
      now: T2,
      startCursor: first.cursor,
    });

    expect(second.status).toBe('current');
    expect(second.counts.ingested).toBe(1);
    expect(listIndexEntries(index).map((e) => e.key)).toEqual(['github:issue:1', 'github:issue:2']);
  });
});

describe('failures never become success', () => {
  it('surfaces a fetcher-reported auth failure as needs_auth with no ingestion', async () => {
    const index = createConnectorIndex('github');
    const outcome = await runConnectorSync({
      connectorId: 'github',
      scope: 'read',
      index,
      fetchPage: async () => ({ ok: false, problem: { code: 'auth_required', message: 'token rejected' } }),
      normalize: passthrough,
      now: T1,
    });

    expect(outcome.status).toBe('needs_auth');
    expect(outcome.authoritative).toBe(false);
    expect(outcome.counts.ingested).toBe(0);
    expect(index.entries.size).toBe(0);
  });

  it('reports a thrown fetcher as outcome_unknown rather than an empty current listing', async () => {
    const index = createConnectorIndex('github');
    applyObservations(index, [observation({ nativeId: '1', revision: 'a', observedAt: T1 })], {
      syncAt: T1,
      authoritative: true,
    });

    const outcome = await runConnectorSync({
      connectorId: 'github',
      scope: 'read',
      index,
      fetchPage: async () => {
        throw new Error('socket hang up');
      },
      normalize: passthrough,
      now: T2,
    });

    expect(outcome.status).toBe('outcome_unknown');
    expect(outcome.authoritative).toBe(false);
    // Crucially: the previously known item is NOT marked missing.
    expect(index.entries.get('github:issue:1')?.lifecycle).toBe('active');
  });

  it('treats a listing containing unusable items as non-authoritative', async () => {
    const index = createConnectorIndex('github');
    applyObservations(index, [observation({ nativeId: '1', revision: 'a', observedAt: T1 })], {
      syncAt: T1,
      authoritative: true,
    });

    const outcome = await runConnectorSync({
      connectorId: 'github',
      scope: 'read',
      index,
      fetchPage: pagedFetcher([[{ broken: true }]]),
      normalize: () => ({ ok: false, reason: 'unparseable' }),
      now: T2,
    });

    expect(outcome.counts.rejected).toBe(1);
    expect(outcome.authoritative).toBe(false);
    expect(outcome.status).toBe('partial');
    // An item we could not parse might be the one we would otherwise have
    // seen, so nothing may be declared missing.
    expect(index.entries.get('github:issue:1')?.lifecycle).toBe('active');
  });

  it('ranks the most severe problem when several occur', () => {
    expect(
      resolveSyncStatus({
        authoritative: false,
        problems: [
          { code: 'partial_pagination', message: '' },
          { code: 'auth_required', message: '' },
        ],
      }),
    ).toBe('needs_auth');
    expect(resolveSyncStatus({ authoritative: true, problems: [] })).toBe('current');
    expect(resolveSyncStatus({ authoritative: false, problems: [] })).toBe('partial');
  });
});

describe('stale vs confirmed connector state', () => {
  const HOUR = 60 * 60 * 1000;
  const outcome = {
    connectorId: 'github',
    status: 'current' as const,
    startedAt: T1,
    completedAt: T1,
    authoritative: true,
    cursor: null,
    counts: { observed: 1, ingested: 1, updated: 0, unchanged: 0, rejected: 0, missing: 0 },
    problems: [],
    entries: [],
  };

  it('claims confirmed_current only inside the freshness window', () => {
    const fresh = describeConnectorState({
      connectorId: 'github',
      lastOutcome: outcome,
      lastSuccessfulSyncAt: T1,
      now: T2,
      maxAgeMs: 2 * HOUR,
    });
    expect(fresh).toMatchObject({ status: 'current', freshness: 'fresh', dataClaim: 'confirmed_current' });
  });

  it('downgrades a successful-but-aged sync to stale/last_known_good', () => {
    const aged = describeConnectorState({
      connectorId: 'github',
      lastOutcome: outcome,
      lastSuccessfulSyncAt: T1,
      now: '2026-08-29T10:00:00Z',
      maxAgeMs: 2 * HOUR,
    });
    expect(aged).toMatchObject({ status: 'stale', freshness: 'stale', dataClaim: 'last_known_good' });
    expect(aged.ageMs).toBe(48 * HOUR);
  });

  it('reports no_data when the connector has never synced successfully', () => {
    const never = describeConnectorState({
      connectorId: 'drive',
      lastOutcome: { ...outcome, connectorId: 'drive', status: 'needs_auth' },
      lastSuccessfulSyncAt: null,
      now: T2,
      maxAgeMs: HOUR,
    });
    expect(never).toMatchObject({ status: 'needs_auth', freshness: 'never_synced', dataClaim: 'no_data' });
  });

  it('keeps last_known_good separate from confirmed data after a failure', () => {
    const failed = describeConnectorState({
      connectorId: 'github',
      lastOutcome: { ...outcome, status: 'unavailable' },
      lastSuccessfulSyncAt: T1,
      now: T2,
      maxAgeMs: 2 * HOUR,
    });
    expect(failed).toMatchObject({ status: 'unavailable', dataClaim: 'last_known_good' });
  });
});
