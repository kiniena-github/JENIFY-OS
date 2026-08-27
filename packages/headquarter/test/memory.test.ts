import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { validateArchiveRecord } from '../src/archive/schema.js';
import { asArchiveRecord, MemoryStore, searchMemory, validateMemoryRecord, type MemoryRecordInput } from '../src/memory/index.js';
import type { NewActivityEvent } from '../src/contracts/events.js';

function baseInput(overrides: Partial<MemoryRecordInput> = {}): MemoryRecordInput {
  return {
    kind: 'decision',
    title: 'Adopt Drizzle for headquarter migrations',
    body: 'We will move hq DB DDL to drizzle migrations in a follow-up.',
    status: 'CURRENT',
    recorded: { date: '2026-08-20', confidence: 'exact', source: 'chat log' },
    recordedBy: 'claude',
    project: 'JENIFY-OS',
    ...overrides,
  };
}

describe('memory store', () => {
  let db: HqDatabase;
  let events: NewActivityEvent[];
  let store: MemoryStore;

  beforeEach(() => {
    db = openMemoryHqDatabase();
    events = [];
    store = new MemoryStore(db, (e) => events.push(e));
  });

  it('records a memory entry and reads it back', () => {
    const rec = store.record(baseInput());
    expect(rec.id).toBeTruthy();
    expect(rec.status).toBe('CURRENT');
    expect(rec.privacy).toBe('internal');
    expect(store.get(rec.id)).toEqual(rec);
    expect(store.listByProject('JENIFY-OS').map((r) => r.id)).toEqual([rec.id]);
    expect(store.listCurrent('decision').map((r) => r.id)).toEqual([rec.id]);
  });

  it('rejects an invalid record before ever writing it', () => {
    expect(() => store.record(baseInput({ title: '' }))).toThrow(/Invalid memory record/);
    expect(store.listByProject('JENIFY-OS')).toHaveLength(0);
  });

  it('validateMemoryRecord mirrors validateArchiveRecord style: an array of clear error strings', () => {
    const errors = validateMemoryRecord({
      id: '',
      kind: 'not-a-kind' as never,
      title: '',
      body: '',
      status: 'not-a-status' as never,
      recorded: { date: 'not-a-date', confidence: 'not-a-confidence' as never },
      recordedBy: '',
      project: '',
      related: {},
      sourceRefs: 'oops' as never,
      tags: 'oops' as never,
      privacy: 'not-a-privacy' as never,
    });
    expect(errors.length).toBeGreaterThan(5);
    expect(errors.some((e) => e.includes('kind must be one of'))).toBe(true);
    expect(errors.some((e) => e.includes('status must be one of'))).toBe(true);
  });

  // issue #120 rule: "no copying secrets into memory"
  it('rejects secret-like content in a memory record', () => {
    expect(() =>
      store.record(baseInput({ body: 'Use api_key: sk-abcdefghijklmnop123456 to call the provider' })),
    ).toThrow(/secret-like content/);
    expect(store.listByProject('JENIFY-OS')).toHaveLength(0);
  });

  // Spec C item 6 (part 1): duplicate CURRENT decision throws.
  it('throws on a duplicate CURRENT decision (same kind+project+title) instead of silently duplicating', () => {
    store.record(baseInput());
    expect(() => store.record(baseInput())).toThrow(/identical CURRENT decision memory already exists/i);
  });

  // Spec C item 6 (part 2): supersede flips predecessor, links supersededBy, history preserved and retrievable.
  it('supersede flips the predecessor to SUPERSEDED, links supersededBy, and preserves full history', () => {
    const v1 = store.record(baseInput());
    const v2 = store.record(
      baseInput({
        id: 'decision-v2',
        title: 'Adopt Drizzle for headquarter migrations (revised)',
        supersedes: v1.id,
        recorded: { date: '2026-08-25', confidence: 'exact' },
      }),
    );

    const predecessor = store.get(v1.id)!;
    expect(predecessor.status).toBe('SUPERSEDED');
    expect(predecessor.supersededBy).toEqual([v2.id]);
    expect(v2.status).toBe('CURRENT');
    expect(v2.supersedes).toBe(v1.id);

    // Immutability: the predecessor row's own content is untouched, only status/supersededBy changed.
    expect(predecessor.title).toBe(v1.title);
    expect(predecessor.body).toBe(v1.body);

    const history = store.history(v2.id);
    expect(history.map((r) => r.id)).toEqual([v1.id, v2.id]);
    expect(store.history(v1.id).map((r) => r.id)).toEqual([v1.id, v2.id]);

    // Audited: onEvent fired for the supersede.
    expect(events.some((e) => e.summary.includes(`${v1.id} superseded by ${v2.id}`))).toBe(true);
  });

  it('supersede requires the predecessor to exist and to currently be CURRENT', () => {
    expect(() => store.record(baseInput({ id: 'orphan', supersedes: 'does-not-exist' }))).toThrow(/unknown memory record/i);

    const v1 = store.record(baseInput());
    store.record(baseInput({ id: 'v2', title: 'v2', supersedes: v1.id }));
    // v1 is now SUPERSEDED; superseding it again must fail.
    expect(() => store.record(baseInput({ id: 'v3', title: 'v3', supersedes: v1.id }))).toThrow(/not CURRENT/);
  });

  // Spec C item 7: archive linkage.
  it('projects a memory record into a valid ArchiveRecord and finds it through the existing archive search engine', () => {
    const decision = store.record(
      baseInput({ tags: ['migrations', 'drizzle'], sourceRefs: ['https://github.com/kiniena-github/JENIFY-OS/issues/120'] }),
    );
    const blocker = store.record(
      baseInput({
        id: 'blocker-1',
        kind: 'blocker',
        title: 'Awaiting Founder sign-off on schema change',
        body: 'Blocked until the Founder approves the migration plan.',
        tags: ['migrations'],
      }),
    );

    const archived = asArchiveRecord(decision);
    expect(validateArchiveRecord(archived)).toEqual([]);
    expect(archived.id).toBe(`memory-${decision.id}`);
    expect(archived.category).toBe('decision');
    expect(archived.sourceRef).toBe('https://github.com/kiniena-github/JENIFY-OS/issues/120');

    const all = store.listAll();
    const byText = searchMemory(all, { text: 'drizzle' });
    expect(byText.map((h) => h.record.id)).toEqual([archived.id]);

    const byTagAndCategory = searchMemory(all, { tag: 'migrations', category: 'blocker' });
    expect(byTagAndCategory.map((h) => h.record.id)).toEqual([`memory-${blocker.id}`]);

    const byProjectStatus = searchMemory(all, { project: 'JENIFY-OS', status: 'CURRENT' });
    expect(byProjectStatus.map((h) => h.record.id).sort()).toEqual([archived.id, `memory-${blocker.id}`].sort());
  });

  it('asArchiveRecord uses a synthetic sourceRef when no sourceRefs were given, so search/browse never breaks on a missing pointer', () => {
    const rec = store.record(baseInput({ id: 'no-refs' }));
    const archived = asArchiveRecord(rec);
    expect(archived.sourceRef).toBe(`hq://memory/${rec.id}`);
    expect(validateArchiveRecord(archived)).toEqual([]);
  });
});
