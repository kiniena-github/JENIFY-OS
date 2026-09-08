/**
 * No facade WRITE resolves an authority answer through a surface a same-realm
 * caller can replace — DERIVED, not enumerated (Wave 5 correction round
 * fourteen, Criticals 1–4 and High 7).
 *
 * ## Why an enumerated test is the wrong shape here
 *
 * `PHASE_8_AUTHORITY_RISK_ACTION_GATEWAY.md:154` claimed an "audit of every
 * call site in `src/`". It was an audit of every KILL-SWITCH call site, and the
 * unqualified sentence is precisely why four Criticals survived at this head —
 * one of them six lines above a migrated read, another two lines above one:
 *
 *   - **C1** nine `queue.capabilities.get` reads decided writes.
 *     `approveTask` on a Founder-DISABLED capability was ACCEPTED under a patch
 *     and the approval was durable; `assignTask`'s `not_permitted` became
 *     ACCEPTED; `registerExecutionWorker` stored a grant for a capability that
 *     is not in `op_capabilities` at all.
 *   - **C2** `#resolveRequester` read the least-privilege grant through
 *     `SpecialistDirectoryAdapter.prototype.allowedCapabilities` (an EXPORTED
 *     class), so forging that prototype — or `HeadquarterStore.prototype.getSpecialist`
 *     underneath it — minted durable `op_tasks` rows for `infra.drop_index` and
 *     `github.open_pr` created by a worker holding neither grant.
 *   - **C3** `approveTask` took its task from `queue.get`, which
 *     `operator/queue.ts` documents verbatim as a read "enforcement does NOT
 *     dispatch through", and handed that object's `capabilityId` to the
 *     canonical `#killSwitchEngagedFromStore`: canonical closure, forged
 *     ARGUMENT. A capability-scoped kill switch was bypassed and a durable
 *     `hq_approvals risk_class=destructive` row was written.
 *   - **C4** `#gatewayGate` — the gate on `executeAction`, the one path in HQ
 *     that makes a real external side effect — read `assignability` through the
 *     same exported prototype two lines above the hardened `#grantOf`. A worker
 *     with `active = 0` executed `publish_release` (public, irreversible, no
 *     compensation) with the adapter called once.
 *
 * Every one of those is a call site an instance-by-instance audit walked past.
 * So this file asks the question by DERIVATION, twice over:
 *
 *  1. **From the source.** Over the same `writeClassifiedMethods()` fixpoint
 *     `facade-write-scan.test.ts` computes, no method that can reach a write —
 *     nor any `#private` helper it reaches — may mention a patchable authority
 *     surface. Exemptions are named WITH their reason; there is no silent one.
 *  2. **From the prototypes.** For every exported class in
 *     `application/ports.ts` and `store/headquarter.ts`, every prototype method
 *     is forged in turn with the answer it gives for the MOST privileged
 *     subject, and an authority battery must refuse identically to the control
 *     run. A method added to either class tomorrow is covered on the day it is
 *     added; a method this cannot probe is REPORTED rather than skipped.
 *
 * The behavioural pins for the four reproductions are at the bottom, because a
 * derivation that passes for the wrong reason is worth exactly nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import { gatewayFixture, startedTask, authorizedAction } from './action-gateway.fixture.js';
import { calleeGraph, methodBodies, methodSlices, writeClassifiedMethods } from './facade-call-graph.js';
import { classMemberSlices } from './source-members.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import { OperatorQueue } from '../src/operator/queue.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import * as portsModule from '../src/application/ports.js';
import * as storeModule from '../src/store/headquarter.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(HERE, '..', 'src', 'application', 'service.ts');

// ---------------------------------------------------------------------------
// 1. The source derivation
// ---------------------------------------------------------------------------

/**
 * The surfaces `operator/queue.ts` and `application/ports.ts` document as
 * DELIBERATELY patchable — safe for a caller that is displaying, never for one
 * that is deciding.
 *
 * Spelled as the property access, so a new call site anywhere in the class's
 * write-reachable graph is caught by shape rather than by having been thought of.
 */
const PATCHABLE_AUTHORITY_READS: readonly { pattern: RegExp; surface: string }[] = [
  { pattern: /this\.queue\.capabilities\b/g, surface: 'queue.capabilities' },
  { pattern: /this\.queue\.get\s*\(/g, surface: 'queue.get' },
  { pattern: /this\.queue\.killSwitchEngaged\s*\(/g, surface: 'queue.killSwitchEngaged' },
  { pattern: /this\.queue\.approvalFor\s*\(/g, surface: 'queue.approvalFor' },
  { pattern: /this\.queue\.evidence\b/g, surface: 'queue.evidence' },
  { pattern: /this\.#workers\.\w+\s*\(/g, surface: '#workers (an exported directory prototype)' },
  {
    pattern: /this\.#store\.getSpecialist\s*\(/g,
    surface: '#store.getSpecialist (an exported store prototype)',
  },
];

/**
 * The named, reasoned exemptions. A member appears here only when the read it
 * makes on a patchable surface decides nothing — and the reason is written
 * down, because "it is only a display" is a claim that has been wrong twice in
 * this wave.
 */
const EXEMPT_MEMBERS: ReadonlyMap<string, string> = new Map([
  [
    'constructor',
    'The composition root itself. It ASSIGNS the enforcement closures — `#grantOf`, ' +
      '`#isRegisteredWorker`, `#assignabilityOf` — and their delegate branch names `#workers` ' +
      'because a composition that supplied its own `WorkerDirectoryPort` IS the authority for ' +
      'that construction. Reading it here is the definition, not a use.',
  ],
]);

/**
 * The member bodies WITHOUT comments, and with the constructor as its own
 * slice.
 *
 * Both corrections are load-bearing, and both were found by running this guard
 * rather than by reasoning about it:
 *
 *  - `facade-call-graph.ts` excludes `constructor` as a control word, so the
 *    constructor's body — which legitimately NAMES `#workers` while ASSIGNING
 *    the enforcement closures — folds into whichever member precedes it and is
 *    reported against that member's name. Slicing with the constructor visible
 *    gives every other member its true body and lets the constructor be
 *    exempted by name, with its reason.
 *  - A comment that QUOTES a patchable read (`assessHqIntegrity`'s "the
 *    `#private` closure, NEVER `this.queue.evidence.verifyChain()`") is prose
 *    about the very migration this guard enforces. Scanning it would make the
 *    guard punish the documentation of its own rule.
 */
function withoutComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

const CONSTRUCTOR_AWARE_EXCLUDE = new Set([
  'if',
  'for',
  'switch',
  'while',
  'catch',
  'return',
  'do',
  'else',
  'try',
]);

function bodiesForScanning(): Map<string, { body: string; line: number }> {
  const source = fs.readFileSync(SERVICE, 'utf8');
  const classStart = source
    .split('\n')
    .findIndex((line) => /^export class HeadquarterOperations\b/.test(line));
  const byName = new Map<string, { body: string; line: number }>();
  for (const slice of classMemberSlices(source, {
    fromLine: classStart,
    exclude: CONSTRUCTOR_AWARE_EXCLUDE,
  })) {
    const existing = byName.get(slice.name);
    byName.set(slice.name, {
      body: (existing?.body ?? '') + withoutComments(slice.body),
      line: existing?.line ?? slice.line,
    });
  }
  return byName;
}

interface Offence {
  member: string;
  via: string;
  surface: string;
  line: number;
}

/**
 * Every member reachable from a write-classified public method, including the
 * `#private` helpers — which is where a patchable read hides from a per-body
 * scan.
 */
function writeReachableMembers(): Map<string, string[]> {
  const bodies = methodBodies();
  const callees = calleeGraph(bodies);
  const reached = new Map<string, string[]>();
  for (const entry of writeClassifiedMethods()) {
    const stack = [entry];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const name = stack.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      if (!reached.has(name)) reached.set(name, []);
      reached.get(name)!.push(entry);
      for (const callee of callees.get(name) ?? []) stack.push(callee);
    }
  }
  return reached;
}

describe('no write-reaching facade code reads authority from a patchable surface', () => {
  it('derives the answer from the write fixpoint, not from a list of call sites', () => {
    const reachable = writeReachableMembers();
    const byName = bodiesForScanning();
    const offences: Offence[] = [];
    for (const [member, entries] of reachable) {
      if (EXEMPT_MEMBERS.has(member)) continue;
      const slice = byName.get(member);
      if (!slice) continue;
      for (const { pattern, surface } of PATCHABLE_AUTHORITY_READS) {
        for (const match of slice.body.matchAll(pattern)) {
          const line = slice.line + slice.body.slice(0, match.index).split('\n').length;
          offences.push({ member, via: entries.sort()[0], surface, line });
        }
      }
    }
    expect(
      offences.map(
        (offence) =>
          `service.ts:${offence.line} ${offence.member} reads ${offence.surface} ` +
          `(reachable from the write ${offence.via})`,
      ),
    ).toEqual([]);
  });

  it('is not vacuous: the fixpoint really reaches deep into the class', () => {
    const reachable = writeReachableMembers();
    // A floor, not a count — a count in a test is the thing that has gone stale
    // over and over in this wave. What matters is that the closure is large and
    // contains the members the four Criticals actually lived in.
    expect(reachable.size).toBeGreaterThan(120);
    for (const member of [
      'approveTask',
      'denyTask',
      'createTask',
      'assignTask',
      'claimNext',
      'startTask',
      'registerExecutionWorker',
      'executeAction',
      'proposeAction',
      '#gatewayGate',
      '#resolveRequester',
    ]) {
      expect(reachable.has(member), `${member} is not classified as write-reaching`).toBe(true);
    }
  });

  it('every exemption names a member that still exists, and states a reason', () => {
    const names = new Set(methodSlices().map((slice) => slice.name));
    for (const [member, reason] of EXEMPT_MEMBERS) {
      // `constructor` is filtered out of the slices as a control word, so it is
      // checked against the source directly.
      const present = names.has(member) || fs.readFileSync(SERVICE, 'utf8').includes(`  ${member}(`);
      expect(present, `${member} is exempted but no longer exists`).toBe(true);
      expect(reason.length, `${member}'s exemption states no reason`).toBeGreaterThan(80);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The prototype derivation
// ---------------------------------------------------------------------------

/** Every exported class of the two modules that carry worker authority. */
function authorityClasses(): { module: string; name: string; klass: new (...args: never[]) => object }[] {
  const found: { module: string; name: string; klass: new (...args: never[]) => object }[] = [];
  for (const [moduleName, namespace] of [
    ['application/ports.ts', portsModule as unknown as Record<string, unknown>],
    ['store/headquarter.ts', storeModule as unknown as Record<string, unknown>],
  ] as const) {
    for (const [name, value] of Object.entries(namespace)) {
      if (typeof value === 'function' && /^\s*class\s/.test(Function.prototype.toString.call(value))) {
        found.push({ module: moduleName, name, klass: value as new (...args: never[]) => object });
      }
    }
  }
  return found;
}

/** Every own, non-constructor prototype method of a class. */
function prototypeMethods(klass: new (...args: never[]) => object): string[] {
  const proto = klass.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).filter((name) => {
    if (name === 'constructor') return false;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    return typeof descriptor?.value === 'function';
  });
}

/**
 * The authority battery: every refusal here is a Founder decision or a
 * least-privilege rule, and every one of them was reachable through a forged
 * prototype at the frozen head.
 *
 * Returns a stable, comparable transcript rather than a set of assertions, so
 * the control run and each forged run are compared as WHOLE answers — a forgery
 * that changes an error MESSAGE is as much a finding as one that changes the
 * code.
 */
function authorityTranscript(): { outcomes: string; codes: string } {
  const fx: Fixture = setupFixture();
  const lines: string[] = [];
  // The compared transcript records ACCEPTED-or-REFUSED, not WHICH refusal.
  //
  // That is the security property, and the distinction is not cosmetic: forging
  // `HeadquarterStore.prototype.getSpecialist` to the privileged answer makes
  // `registerExecutionWorker` report `invalid_input` ("already registered")
  // instead of `unknown_capability`, because the duplicate check runs first. The
  // command still refuses and still stores nothing — a STRICTER answer, not an
  // escalation — and pinning the code would fail on a forgery that made HQ
  // safer. What may never move is refused -> ACCEPTED, or a durable row count.
  // The control run's exact codes ARE pinned, separately, below: without that
  // this would compare two vacuous transcripts.
  const codes: string[] = [];
  const say = (label: string, result: { ok: boolean; error?: { code: string } }): void => {
    lines.push(`${label}: ${result.ok ? 'ACCEPTED' : 'REFUSED'}`);
    codes.push(`${label}: ${result.ok ? 'ACCEPTED' : (result.error?.code ?? 'refused')}`);
  };
  try {
    // Least privilege: `codex` holds only `repo.read_status`.
    say(
      'createTask codex -> infra.drop_index',
      fx.ops.createTask({
        capabilityId: CAPS.dropIndex,
        payload: { index: 'i' },
        idempotencyKey: 'esr-1',
        requestedBy: 'codex',
      }),
    );
    say('claimNext codex -> infra.drop_index', fx.ops.claimNext('codex', CAPS.dropIndex));
    // Assignability: `retired-bot` is `active = 0`.
    const task = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.indexDoc,
        payload: { document: 'd' },
        idempotencyKey: 'esr-2',
        requestedBy: 'claude',
      }),
    ).task;
    say('assignTask -> retired-bot', fx.ops.assignTask(task.id, 'retired-bot', 'founder'));
    say('startTask -> retired-bot', fx.ops.startTask(task.id, 'retired-bot', 1));
    // A capability the registry does not define is never granted.
    say(
      'registerExecutionWorker w/ unknown capability',
      fx.ops.registerExecutionWorker({
        workerId: 'ghost',
        displayName: 'Ghost',
        vendor: 'nobody',
        role: 'specialist_tool',
        allowedCapabilities: ['infra.nuke_everything'],
        founderId: 'founder',
      }),
    );
    // The Founder's stop, capability-scoped.
    expectOk(fx.ops.engageKillSwitch(CAPS.indexDoc, 'founder', 'index lane paused'));
    say(
      'approveTask under an engaged kill switch',
      fx.ops.approveTask({
        taskId: task.id,
        founderId: 'coo',
        expectedActionDigest: taskActionDigest(task),
      }),
    );
    expectOk(fx.ops.releaseKillSwitch(CAPS.indexDoc, 'founder'));
    // The Founder disabling a capability.
    fx.db.prepare(`UPDATE op_capabilities SET enabled = 0 WHERE id = ?`).run(CAPS.indexDoc);
    say(
      'approveTask on a DISABLED capability',
      fx.ops.approveTask({
        taskId: task.id,
        founderId: 'coo',
        expectedActionDigest: taskActionDigest(task),
      }),
    );
    // The durable half. An authority defect that leaves no row is still a
    // defect, but every one of the four Criticals left one, and a row count is
    // the fact a forgery cannot argue with.
    for (const [label, sql] of [
      ['durable approvals', `SELECT COUNT(*) AS n FROM hq_approvals`],
      ['durable tasks by codex', `SELECT COUNT(*) AS n FROM op_tasks WHERE created_by = 'codex'`],
      ['stored specialists', `SELECT COUNT(*) AS n FROM hq_specialists`],
      ['stored grants for ghost', `SELECT COUNT(*) AS n FROM hq_specialists WHERE id = 'ghost'`],
      ['inactive specialists still inactive', `SELECT COUNT(*) AS n FROM hq_specialists WHERE active = 0`],
    ] as const) {
      const line = `${label}: ${(fx.db.prepare(sql).get() as { n: number }).n}`;
      lines.push(line);
      codes.push(line);
    }
  } finally {
    fx.db.close();
  }
  return { outcomes: lines.join('\n'), codes: codes.join('\n') };
}

/** The one external-side-effect battery: a DEACTIVATED worker must never execute. */
function gatewayTranscript(): string {
  const fx = gatewayFixture();
  try {
    const started = startedTask(fx);
    const actionId = authorizedAction(fx, started, {
      actionType: 'publish_release',
      target: 'releases/v9',
      payload: { tag: 'v9' },
    });
    // The FOUNDER deactivates the worker after authorization — the canonical stop.
    fx.db.prepare(`UPDATE hq_specialists SET active = 0 WHERE id = ?`).run(started.worker);
    const executed = fx.ops.executeAction({
      actionId,
      workerId: started.worker,
      fence: started.fence,
    });
    return [
      `executeAction: ${executed.ok ? 'ACCEPTED' : executed.error.code}`,
      `adapter calls: ${fx.adapter.calls.length}`,
      `action states: ${JSON.stringify(
        (
          fx.db
            .prepare(`SELECT DISTINCT state FROM hq_action_events ORDER BY state`)
            .all() as { state: string }[]
        ).map((row) => row.state),
      )}`,
    ].join('\n');
  } finally {
    fx.db.close();
  }
}

describe('forging any prototype of the worker-authority classes changes no facade write', () => {
  const classes = authorityClasses();

  it('enumerates the exported classes at all', () => {
    const names = classes.map((entry) => `${entry.module}:${entry.name}`).sort();
    // A floor plus the two the reproductions used. Deliberately not an equality:
    // a class ADDED to either module must be swept, not fail this line.
    expect(names).toContain('application/ports.ts:SpecialistDirectoryAdapter');
    expect(names).toContain('store/headquarter.ts:HeadquarterStore');
    expect(names.length).toBeGreaterThanOrEqual(2);
  });

  it('forges every prototype method in turn, and the authority answers do not move', () => {
    const control = authorityTranscript();
    const controlGateway = gatewayTranscript();
    // The control run is the baseline everything is compared to, so it has to
    // be the RIGHT baseline: every one of these refusals is load-bearing.
    expect(control).toContain('createTask codex -> infra.drop_index: enqueue_rejected');
    expect(control).toContain('claimNext codex -> infra.drop_index: not_permitted');
    expect(control).toContain('assignTask -> retired-bot: worker_not_assignable');
    expect(control).toContain('startTask -> retired-bot: worker_not_assignable');
    expect(control).toContain('registerExecutionWorker w/ unknown capability: unknown_capability');
    expect(control).toContain('approveTask under an engaged kill switch: kill_switch_engaged');
    expect(control).toContain('approveTask on a DISABLED capability: capability_disabled');
    expect(control).toContain('durable approvals: 0');
    expect(control).toContain('durable tasks by codex: 0');
    expect(controlGateway).toContain('executeAction: worker_not_assignable');
    expect(controlGateway).toContain('adapter calls: 0');

    const unprobeable: string[] = [];
    const moved: string[] = [];
    for (const { module, name, klass } of classes) {
      for (const method of prototypeMethods(klass)) {
        const proto = klass.prototype as Record<string, unknown>;
        const original = proto[method] as (...args: unknown[]) => unknown;
        // The forgery is DERIVED: the answer the real method gives for the most
        // privileged subject in the fixture. That is exactly the shape the
        // reproductions used — make the directory report a privileged answer —
        // and it needs no knowledge of the method's return type. The probe runs
        // against a THROWAWAY database so a method that turns out to write
        // cannot touch the fixture the battery uses.
        let privileged: unknown;
        const probe = setupFixture();
        try {
          const instance =
            name === 'HeadquarterStore'
              ? new HeadquarterStore(probe.db)
              : new (klass as new (store: HeadquarterStore) => object)(new HeadquarterStore(probe.db));
          privileged = (instance as Record<string, unknown>)[method] instanceof Function
            ? (original as (this: object, ...args: unknown[]) => unknown).call(instance, 'claude')
            : undefined;
        } catch {
          unprobeable.push(`${module}:${name}.${method}`);
          continue;
        } finally {
          probe.db.close();
        }
        proto[method] = () => privileged;
        try {
          const forged = authorityTranscript();
          if (forged !== control) {
            moved.push(`${module}:${name}.${method}\n--- control\n${control}\n--- forged\n${forged}`);
          }
          const forgedGateway = gatewayTranscript();
          if (forgedGateway !== controlGateway) {
            moved.push(
              `${module}:${name}.${method} (gateway)\n--- control\n${controlGateway}\n--- forged\n${forgedGateway}`,
            );
          }
        } finally {
          proto[method] = original;
        }
      }
    }
    expect(moved).toEqual([]);
    // A method this cannot probe is REPORTED, never silently skipped — a
    // silently skipped check is what "audit of every call site" meant.
    // `HeadquarterStore` is mostly multi-argument writers, so the list is long
    // and its length is not the property; what matters is that the two methods
    // the reproductions forged are NOT in it.
    for (const forged of [
      'application/ports.ts:SpecialistDirectoryAdapter.allowedCapabilities',
      'application/ports.ts:SpecialistDirectoryAdapter.assignability',
      'application/ports.ts:SpecialistDirectoryAdapter.isRegistered',
      'store/headquarter.ts:HeadquarterStore.getSpecialist',
    ]) {
      expect(unprobeable, `${forged} was not actually forged`).not.toContain(forged);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The four reproductions, pinned behaviourally
// ---------------------------------------------------------------------------

/** Forge an own-property read on the queue instance AND on the prototype. */
function withForgedQueueRead<T>(fx: Fixture, forge: (queue: Record<string, unknown>) => () => void, fn: () => T): T {
  const queue = fx.ops.queue as unknown as Record<string, unknown>;
  const restore = forge(queue);
  try {
    return fn();
  } finally {
    restore();
  }
}

describe('the four reproductions, pinned', () => {
  it('C1: a forged queue.capabilities.get does not approve on a Founder-disabled capability', () => {
    const fx = setupFixture();
    try {
      const task = expectOk(
        fx.ops.createTask({
          capabilityId: CAPS.indexDoc,
          payload: { document: 'd' },
          idempotencyKey: 'c1',
          requestedBy: 'claude',
        }),
      ).task;
      const digest = taskActionDigest(task);
      fx.db.prepare(`UPDATE op_capabilities SET enabled = 0 WHERE id = ?`).run(CAPS.indexDoc);
      // The reserved definition — the exact lie #219 was found with: the
      // capability as it was BEFORE the Founder disabled it.
      const reserved = {
        id: CAPS.indexDoc,
        description: 'Index a document in the archive',
        riskClass: 'external_side_effect' as const,
        sideEffect: true,
        idempotent: true,
        enabled: true,
      };
      const forged = withForgedQueueRead(
        fx,
        (queue) => {
          const capabilities = queue.capabilities as Record<string, unknown>;
          const original = capabilities.get;
          capabilities.get = () => reserved;
          return () => {
            capabilities.get = original;
          };
        },
        () => fx.ops.approveTask({ taskId: task.id, founderId: 'coo', expectedActionDigest: digest }),
      );
      expect(forged.ok).toBe(false);
      if (!forged.ok) expect(forged.error.code).toBe('capability_disabled');
      expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_approvals`).get() as { n: number }).n).toBe(0);
    } finally {
      fx.db.close();
    }
  });

  it('C3: a forged queue.get does not approve under an engaged capability kill switch', () => {
    const fx = setupFixture();
    try {
      const task = expectOk(
        fx.ops.createTask({
          capabilityId: CAPS.dropIndex,
          payload: { index: 'i' },
          idempotencyKey: 'c3',
          requestedBy: 'claude',
        }),
      ).task;
      const digest = taskActionDigest(task);
      expectOk(fx.ops.engageKillSwitch(CAPS.dropIndex, 'founder', 'stop'));
      // The forgery names a DIFFERENT capability, so the canonical closure is
      // handed a clean scope: closure canonical, argument forged.
      const decoy = { ...task, capabilityId: CAPS.readStatus };
      const proto = OperatorQueue.prototype as unknown as Record<string, unknown>;
      const savedProto = proto.get;
      proto.get = () => decoy;
      const forged = withForgedQueueRead(
        fx,
        (queue) => {
          const original = queue.get;
          queue.get = () => decoy;
          return () => {
            queue.get = original;
          };
        },
        () => fx.ops.approveTask({ taskId: task.id, founderId: 'coo', expectedActionDigest: digest }),
      );
      proto.get = savedProto;
      expect(forged.ok).toBe(false);
      if (!forged.ok) expect(forged.error.code).toBe('kill_switch_engaged');
      expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_approvals`).get() as { n: number }).n).toBe(0);
      expect(
        (fx.db.prepare(`SELECT engaged FROM op_kill_switch WHERE scope = ?`).get(CAPS.dropIndex) as {
          engaged: number;
        }).engaged,
      ).toBe(1);
    } finally {
      fx.db.close();
    }
  });

  it('C2: forging either prototype mints no task for a capability the worker was never granted', () => {
    for (const forge of [
      () => {
        const proto = portsModule.SpecialistDirectoryAdapter.prototype as unknown as Record<string, unknown>;
        const saved = proto.allowedCapabilities;
        proto.allowedCapabilities = () => [CAPS.dropIndex, CAPS.openPr, CAPS.readStatus];
        return () => {
          proto.allowedCapabilities = saved;
        };
      },
      () => {
        const proto = HeadquarterStore.prototype as unknown as Record<string, unknown>;
        const saved = proto.getSpecialist;
        proto.getSpecialist = (id: string) => ({
          id,
          displayName: id,
          vendor: 'forged',
          role: 'build_lead',
          allowedCapabilities: [CAPS.dropIndex, CAPS.openPr, CAPS.readStatus],
          active: true,
        });
        return () => {
          proto.getSpecialist = saved;
        };
      },
    ]) {
      const fx = setupFixture();
      const restore = forge();
      try {
        const created = fx.ops.createTask({
          capabilityId: CAPS.dropIndex,
          payload: { index: 'i' },
          idempotencyKey: 'c2',
          requestedBy: 'codex',
        });
        expect(created.ok).toBe(false);
        if (!created.ok) expect(created.error.code).toBe('enqueue_rejected');
      } finally {
        restore();
        expect(
          (
            fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks WHERE created_by = 'codex'`).get() as {
              n: number;
            }
          ).n,
        ).toBe(0);
        fx.db.close();
      }
    }
  });

  it('C4: a DEACTIVATED worker executes no external action, whatever the directory prototype says', () => {
    const proto = portsModule.SpecialistDirectoryAdapter.prototype as unknown as Record<string, unknown>;
    const saved = proto.assignability;
    proto.assignability = () => ({ assignable: true });
    try {
      const transcript = gatewayTranscript();
      expect(transcript).toContain('executeAction: worker_not_assignable');
      expect(transcript).toContain('adapter calls: 0');
      expect(transcript).not.toContain('succeeded');
    } finally {
      proto.assignability = saved;
    }
  });

  it('the CONTROL path still works — this refuses forgeries, not ordinary work', () => {
    const fx = gatewayFixture();
    try {
      const started = startedTask(fx);
      const actionId = authorizedAction(fx, started, {
        actionType: 'publish_release',
        target: 'releases/v10',
        payload: { tag: 'v10' },
      });
      expectOk(fx.ops.executeAction({ actionId, workerId: started.worker, fence: started.fence }));
      expect(fx.adapter.calls.length).toBe(1);
    } finally {
      fx.db.close();
    }
  });
});
