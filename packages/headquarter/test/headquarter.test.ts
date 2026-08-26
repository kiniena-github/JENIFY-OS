import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { HeadquarterStore } from '../src/store/headquarter.js';

describe('headquarter store', () => {
  let db: HqDatabase;
  let hq: HeadquarterStore;

  beforeEach(() => {
    db = openMemoryHqDatabase();
    hq = new HeadquarterStore(db);
  });

  it('appends canonical events and reads them back per subject', () => {
    hq.appendEvent({
      subjectKind: 'task',
      subjectId: 't1',
      status: 'queued',
      actor: 'claude',
      summary: 'queued',
    });
    hq.appendEvent({
      subjectKind: 'task',
      subjectId: 't1',
      status: 'running',
      actor: 'claude',
      summary: 'running',
      refs: ['https://github.com/kiniena-github/JENIFY-OS/issues/42'],
    });
    const events = hq.eventsFor('task', 't1');
    expect(events).toHaveLength(2);
    expect(events[1].status).toBe('running');
    expect(events[1].refs).toEqual(['https://github.com/kiniena-github/JENIFY-OS/issues/42']);
  });

  it('rejects events with non-canonical statuses', () => {
    expect(() =>
      hq.appendEvent({
        subjectKind: 'task',
        subjectId: 't1',
        status: 'doing-stuff' as never,
        actor: 'claude',
        summary: 'bad',
      }),
    ).toThrow(/Unknown activity status/);
  });

  it('builds the command center snapshot from latest statuses', () => {
    hq.appendEvent({ subjectKind: 'task', subjectId: 'a', status: 'queued', actor: 'x', summary: 'a queued' });
    hq.appendEvent({ subjectKind: 'task', subjectId: 'a', status: 'running', actor: 'x', summary: 'a running' });
    hq.appendEvent({ subjectKind: 'task', subjectId: 'b', status: 'needs_approval', actor: 'y', summary: 'b waiting' });
    hq.appendEvent({ subjectKind: 'task', subjectId: 'c', status: 'blocked', actor: 'y', summary: 'c blocked' });
    hq.appendEvent({ subjectKind: 'task', subjectId: 'd', status: 'completed', actor: 'y', summary: 'd done' });
    hq.appendEvent({ subjectKind: 'task', subjectId: 'e', status: 'queued', actor: 'y', summary: 'e next' });
    const snap = hq.commandCenterSnapshot();
    expect(snap.lanes.now.map((i) => i.subjectId)).toEqual(['a']);
    expect(snap.lanes.waiting_for_founder.map((i) => i.subjectId)).toEqual(['b']);
    expect(snap.lanes.blocked.map((i) => i.subjectId)).toEqual(['c']);
    expect(snap.lanes.done_today.map((i) => i.subjectId)).toEqual(['d']);
    expect(snap.lanes.next.map((i) => i.subjectId)).toEqual(['e']);
  });

  it('manages projects, approvals, chats, specialists and archive refs', () => {
    const p = hq.upsertProject({
      id: 'stream2',
      name: 'Company Infrastructure',
      stream: 'company-infra',
      summary: 'Headquarter + Universal Operator',
      status: 'running',
    });
    expect(p.name).toBe('Company Infrastructure');

    const approval = hq.requestApproval({
      projectId: p.id,
      ask: 'Approve standing pre-approval for github.open_pr',
      riskClass: 'external_side_effect',
      requestedBy: 'claude',
    });
    expect(hq.pendingApprovals()).toHaveLength(1);
    expect(() => hq.decideApproval(approval.id, 'denied', null)).toThrow(/decision note/);
    const decided = hq.decideApproval(approval.id, 'approved', 'ok for this wave');
    expect(decided.decision).toBe('approved');
    expect(() => hq.decideApproval(approval.id, 'denied', 'flip')).toThrow(/already decided/);

    hq.postMessage({ threadId: 'executive-room', author: 'claude', body: 'Foundation pushed' });
    hq.postMessage({ threadId: 'dm:jules', author: 'claude', body: 'Contracts are ready for the UI' });
    expect(hq.thread('executive-room')).toHaveLength(1);
    expect(hq.thread('dm:jules')[0].body).toMatch(/Contracts/);

    hq.upsertSpecialist({
      id: 'jules',
      displayName: 'Jules',
      vendor: 'google',
      role: 'parallel_implementer',
      allowedCapabilities: ['archive.index_document'],
      active: true,
    });
    expect(hq.listSpecialists()[0].allowedCapabilities).toEqual(['archive.index_document']);

    const ref = hq.addArchiveRef({ title: 'Stream 2 kickoff', locator: 'archive://2026/08/stream2', projectId: p.id });
    expect(hq.listArchiveRefs(p.id)[0].id).toBe(ref.id);
  });
});
