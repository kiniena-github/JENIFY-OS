/**
 * Watchdog / control-loop hardening (issue #219).
 *
 * These tests pin the exact failure that prompted the module: a mission that
 * is neither finished nor escalated, sitting still because something that
 * merely *looked* like progress was read as completion or as liveness.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STALE_WORKER_MS,
  actionableMissionBlockers,
  activeMissionWorkers,
  assertCanonicalLane,
  classifyMission,
  describeMissionDecision,
  shouldDispatchMission,
  type MissionControlInput,
  type MissionEvidenceItem,
} from '../src/application/mission-watchdog.js';

const LANE = 'claude/epic-pascal-ngw9m8';
const NOW = '2026-08-29T04:00:00.000Z';

function evidence(satisfiedCount: number, total = 3): MissionEvidenceItem[] {
  return Array.from({ length: total }, (_, index) => ({
    id: `item-${index + 1}`,
    label: `Evidence ${index + 1}`,
    satisfied: index < satisfiedCount,
  }));
}

function input(overrides: Partial<MissionControlInput> = {}): MissionControlInput {
  return {
    lane: LANE,
    evidence: evidence(0),
    workers: [],
    blockers: [],
    now: NOW,
    ...overrides,
  };
}

function worker(minutesAgo: number, lane = LANE, sessionId = 'session-a') {
  return {
    sessionId,
    lane,
    heartbeatAt: new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString(),
  };
}

// ---- The five states ----

describe('mission control classifies into exactly one state', () => {
  it('is COMPLETE only when every declared evidence item is satisfied', () => {
    const decision = classifyMission(input({ evidence: evidence(3) }));
    expect(decision.state).toBe('complete');
    expect(decision.action).toBe('stop');
    expect(decision.missingEvidence).toEqual([]);
  });

  it('is RUNNING when a worker on this lane has a fresh heartbeat', () => {
    const decision = classifyMission(input({ workers: [worker(2)] }));
    expect(decision.state).toBe('running');
    expect(decision.action).toBe('none');
    expect(decision.activeWorkers).toEqual(['session-a']);
  });

  it('is STALLED when the contract is unmet and no worker is proved active', () => {
    const decision = classifyMission(input({ evidence: evidence(2) }));
    expect(decision.state).toBe('stalled');
    expect(decision.action).toBe('resume_same_lane');
    expect(decision.missingEvidence).toEqual(['item-3']);
  });

  it('is FOUNDER_BLOCKED with the exact action named', () => {
    const decision = classifyMission(
      input({ blockers: [{ kind: 'founder', detail: 'Vercel account login required' }] }),
    );
    expect(decision.state).toBe('founder_blocked');
    expect(decision.action).toBe('escalate_founder');
    expect(decision.reason).toContain('Vercel account login required');
  });

  it('is EXTERNAL_BLOCKED with the exact blocker named', () => {
    const decision = classifyMission(
      input({ blockers: [{ kind: 'external', detail: 'Codex quota exhausted' }] }),
    );
    expect(decision.state).toBe('external_blocked');
    expect(decision.action).toBe('report_external');
    expect(decision.reason).toContain('Codex quota exhausted');
  });
});

// ---- The quiet stop: things that must NOT read as completion ----

describe('partial progress is never completion', () => {
  it('does not treat an empty checklist as vacuously complete', () => {
    // The trap: `every()` over an empty array is true. A mission that has
    // declared nothing has proved nothing.
    const decision = classifyMission(input({ evidence: [] }));
    expect(decision.state).toBe('stalled');
    expect(decision.action).toBe('resume_same_lane');
    expect(decision.reason).toContain('no completion contract declared');
  });

  it('does not treat "most tests passed" as complete', () => {
    for (let satisfied = 0; satisfied < 3; satisfied += 1) {
      const decision = classifyMission(input({ evidence: evidence(satisfied) }));
      expect(decision.state, `${satisfied}/3 satisfied`).not.toBe('complete');
    }
  });

  it('does not treat a finished worker session as completion', () => {
    // Worker gone AND contract unmet is the exact observed stall.
    const decision = classifyMission(input({ evidence: evidence(2), workers: [] }));
    expect(decision.state).toBe('stalled');
  });

  it('treats a non-boolean/absent satisfied flag as unsatisfied', () => {
    const hostile = [
      { id: 'a', label: 'A', satisfied: 'true' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C', satisfied: 1 },
    ] as unknown as MissionEvidenceItem[];
    const decision = classifyMission(input({ evidence: hostile }));
    expect(decision.state).toBe('stalled');
    expect(decision.missingEvidence).toEqual(['a', 'b', 'c']);
  });
});

// ---- Liveness must be proved, not assumed ----

describe('worker liveness is proved, not assumed', () => {
  it('a stale heartbeat is a quiet stop, not activity', () => {
    const stale = DEFAULT_STALE_WORKER_MS / 60_000 + 5;
    const decision = classifyMission(input({ workers: [worker(stale)] }));
    expect(decision.state).toBe('stalled');
    expect(decision.activeWorkers).toEqual([]);
  });

  it('a worker on a different lane does not keep this lane alive', () => {
    const decision = classifyMission(input({ workers: [worker(1, 'claude/some-other-lane')] }));
    expect(decision.state).toBe('stalled');
    expect(decision.activeWorkers).toEqual([]);
  });

  it('an unparseable or blank heartbeat does not count as active', () => {
    const hostile = [
      { sessionId: 'x', lane: LANE, heartbeatAt: '' },
      { sessionId: 'y', lane: LANE, heartbeatAt: 'recently' },
      { sessionId: 'z', lane: LANE },
      { sessionId: '', lane: LANE, heartbeatAt: NOW },
    ] as unknown as MissionControlInput['workers'];
    expect(activeMissionWorkers(input({ workers: hostile }))).toEqual([]);
  });

  it('clock skew cannot manufacture a stall and duplicate a live worker', () => {
    // A heartbeat slightly in the future stays active rather than being
    // arithmetically discarded.
    const decision = classifyMission(input({ workers: [worker(-3)] }));
    expect(decision.state).toBe('running');
  });

  it('honours a caller-supplied staleness window', () => {
    const tight = classifyMission(input({ workers: [worker(10)], staleWorkerAfterMs: 60_000 }));
    expect(tight.state).toBe('stalled');
    const loose = classifyMission(input({ workers: [worker(10)], staleWorkerAfterMs: 3_600_000 }));
    expect(loose.state).toBe('running');
  });
});

// ---- Precedence ----

describe('state precedence is complete > founder > external > running > stalled', () => {
  it('a leftover blocker record cannot un-finish a proved mission', () => {
    const decision = classifyMission(
      input({
        evidence: evidence(3),
        blockers: [{ kind: 'founder', detail: 'stale gate record' }],
      }),
    );
    expect(decision.state).toBe('complete');
  });

  it('a Founder gate outranks a busy worker', () => {
    // A credential decision is not resolved by letting a worker keep running.
    const decision = classifyMission(
      input({
        workers: [worker(1)],
        blockers: [{ kind: 'founder', detail: 'paid-plan approval' }],
      }),
    );
    expect(decision.state).toBe('founder_blocked');
  });

  it('a Founder gate outranks an external blocker', () => {
    const decision = classifyMission(
      input({
        blockers: [
          { kind: 'external', detail: 'quota' },
          { kind: 'founder', detail: 'DNS decision' },
        ],
      }),
    );
    expect(decision.state).toBe('founder_blocked');
  });

  it('an external blocker outranks a busy worker', () => {
    const decision = classifyMission(
      input({ workers: [worker(1)], blockers: [{ kind: 'external', detail: 'provider down' }] }),
    );
    expect(decision.state).toBe('external_blocked');
  });

  it('a detail-less blocker cannot halt the loop', () => {
    // An unactionable blocker would be the quiet stop under another name.
    const hostile = [
      { kind: 'founder', detail: '' },
      { kind: 'external', detail: '   ' },
      { kind: 'mystery', detail: 'nope' },
    ] as unknown as MissionControlInput['blockers'];
    expect(actionableMissionBlockers(hostile)).toEqual([]);
    expect(classifyMission(input({ blockers: hostile })).state).toBe('stalled');
  });
});

// ---- Duplicate-dispatch protection ----

describe('duplicate-dispatch protection', () => {
  const stalled = classifyMission(input({ evidence: evidence(2) }));

  it('dispatches a genuinely stalled mission on its canonical lane', () => {
    const result = shouldDispatchMission(stalled, { lane: LANE, dispatchKey: 'k1' });
    expect(result.dispatch).toBe(true);
  });

  it('refuses a competing lane', () => {
    const result = shouldDispatchMission(stalled, { lane: 'claude/rival', dispatchKey: 'k1' });
    expect(result.dispatch).toBe(false);
    expect(result.reason).toContain('competing lane');
  });

  it('is idempotent: a spent dispatch key never fans out a second worker', () => {
    const result = shouldDispatchMission(stalled, { lane: LANE, dispatchKey: 'k1' }, ['k1']);
    expect(result.dispatch).toBe(false);
    expect(result.reason).toContain('already spent');
  });

  it('never dispatches over a running, complete, or blocked mission', () => {
    const cases = [
      classifyMission(input({ workers: [worker(1)] })),
      classifyMission(input({ evidence: evidence(3) })),
      classifyMission(input({ blockers: [{ kind: 'founder', detail: 'login' }] })),
      classifyMission(input({ blockers: [{ kind: 'external', detail: 'quota' }] })),
    ];
    for (const decision of cases) {
      const result = shouldDispatchMission(decision, { lane: LANE, dispatchKey: 'fresh' });
      expect(result.dispatch, decision.state).toBe(false);
    }
  });

  it('requires both a lane and a dispatch key', () => {
    expect(shouldDispatchMission(stalled, { lane: '', dispatchKey: 'k' }).dispatch).toBe(false);
    expect(shouldDispatchMission(stalled, { lane: LANE, dispatchKey: '' }).dispatch).toBe(false);
  });
});

describe('canonical lane guard', () => {
  it('throws rather than returning a boolean a caller can ignore', () => {
    expect(() => assertCanonicalLane(LANE, LANE)).not.toThrow();
    expect(() => assertCanonicalLane(LANE, 'claude/rival')).toThrow(/competing mission lane/);
    expect(() => assertCanonicalLane('', LANE)).toThrow(/no canonical lane/);
  });
});

describe('decision reporting', () => {
  it('states what is outstanding rather than implying progress', () => {
    const line = describeMissionDecision(classifyMission(input({ evidence: evidence(2) })));
    expect(line).toContain('[STALLED]');
    expect(line).toContain(LANE);
    expect(line).toContain('item-3');
  });

  it('always carries a non-empty reason', () => {
    const decisions = [
      classifyMission(input({ evidence: evidence(3) })),
      classifyMission(input({ workers: [worker(1)] })),
      classifyMission(input({ evidence: evidence(1) })),
      classifyMission(input({ blockers: [{ kind: 'founder', detail: 'login' }] })),
      classifyMission(input({ blockers: [{ kind: 'external', detail: 'quota' }] })),
    ];
    for (const decision of decisions) {
      expect(decision.reason.trim().length, decision.state).toBeGreaterThan(0);
    }
  });
});
