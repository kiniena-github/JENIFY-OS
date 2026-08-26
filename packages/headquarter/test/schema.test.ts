import { describe, expect, it } from 'vitest';
import {
  archivePath,
  archivePeriod,
  validateArchiveRecord,
  type ArchiveRecord,
} from '../src/archive/schema.js';
import { validateActivityEvent, type ActivityEvent } from '../src/events.js';

const record: ArchiveRecord = {
  id: 'doc-1',
  title: 'QOS chatbot upgrade plan',
  project: 'QOS',
  category: 'upgrade',
  created: { date: '2026-08-26T07:43:51Z', confidence: 'exact', source: 'github-api' },
  evidence: { date: '2026-08-26T07:43:51Z', confidence: 'exact', source: 'github-api' },
  version: 'v2',
  status: 'CURRENT',
  predecessorId: null,
  successorIds: [],
  related: { pullRequests: [36] },
  sourceRef: 'https://github.com/kiniena-github/JENIFY-OS/pull/36',
  summary: 'Upgrade plan',
  tags: ['qos'],
};

describe('archive schema', () => {
  it('accepts a complete record', () => {
    expect(validateArchiveRecord(record)).toEqual([]);
  });

  it('rejects missing fields, bad status, and bad dates', () => {
    const bad = {
      ...record,
      id: '',
      status: 'FINAL' as never,
      created: { date: 'yesterday', confidence: 'high' as never },
      sourceRef: '',
    };
    const errors = validateArchiveRecord(bad);
    expect(errors).toContain('id is required');
    expect(errors.some((error) => error.startsWith('status must be'))).toBe(true);
    expect(errors).toContain('created.date must be an ISO-8601 date');
    expect(errors.some((error) => error.startsWith('created.confidence'))).toBe(true);
    expect(errors).toContain('sourceRef is required');
  });

  it('derives the year/month/project/category archive path', () => {
    expect(archivePeriod(record)).toEqual({ year: '2026', month: '08' });
    expect(archivePath(record)).toBe('archive/2026/08/QOS/upgrade/doc-1');
  });
});

describe('activity event validation', () => {
  it('accepts a valid event and rejects unknown statuses', () => {
    const event: ActivityEvent = {
      id: 'e1',
      taskId: 'JENIFY-OS#43',
      project: 'JENIFY-OS',
      title: 'Stream 2',
      worker: 'claude',
      status: 'running',
      occurredAt: '2026-08-26T10:30:00Z',
    };
    expect(validateActivityEvent(event)).toEqual([]);
    expect(validateActivityEvent({ ...event, status: 'doing' as never })).toHaveLength(1);
    expect(validateActivityEvent({ ...event, occurredAt: '26/08/2026' })).toHaveLength(1);
  });
});
