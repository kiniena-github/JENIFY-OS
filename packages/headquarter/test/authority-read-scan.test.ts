/**
 * "No authority-deciding path reads a patchable convenience surface" is
 * enforced here rather than asserted in a document (Wave 5 correction round
 * fifteen, Critical 1 / Critical 2 / High 1 / High 2 / Medium 1).
 *
 * ## The failure mode this file exists to end
 *
 * The reviewer's own summary of four rounds of the same defect:
 *
 * > a hardened read gets installed next to an unhardened sibling, and the
 * > prose then describes the hardened one as though it covered both.
 *
 * Every previous fix in this class was written as a MIGRATION OF NAMED LINES,
 * and the regression that accompanied it enumerated those same lines. So the
 * next call site — sometimes literally the next line — was never covered:
 *
 *  - `capabilityRowFor` hardened the CAPABILITY row that `control-api.ts`'s
 *    approve route reads. The TASK row it is looked up BY stayed on
 *    `ops.queue.get`, so `ops.queue.get = (id) => ({ ...real(id),
 *    capabilityId: 'bench.read_only' })` made the hardened read return an
 *    honest row for the WRONG capability: `401 step_up_required` became
 *    `200 {"ok":true,"status":"queued"}` on a stale session with a verifier
 *    rejecting every password, and `approveTask` wrote an approval with
 *    `op_kill_switch.engaged = 1` standing on the task's real capability.
 *  - `#grantOf` was a database closure; `this.#workers.assignability(workerId)`
 *    TWO LINES ABOVE it in `#gatewayGate` resolved through the exported
 *    `NarrowingWorkerDirectory` prototype. A member disabled through ordinary
 *    configuration executed an irreversible, PUBLIC external action.
 *  - `claudeDispatchEligibility` read the kill switch and the gateway history
 *    through function bindings, each with a comment saying "this verdict
 *    decides a publication" — directly beneath two reads of `ops.queue.get`
 *    and `ops.queue.capabilities.get`.
 *
 * ## What is derived
 *
 * DEFAULT DENY over the whole of `src/`. Every occurrence of a patchable
 * convenience surface must appear in `EXEMPT` with its exact count and a
 * reason. A new call site anywhere in the package — in a file that does not
 * exist yet, in a function nobody has written — fails this test the day it is
 * added, and the fix is either the enforcement-safe binding or an exemption
 * somebody has to justify in writing. That is the difference from a test that
 * lists today's call sites, which is exactly how a Critical survived two lines
 * below a hardened read.
 *
 * Counts, not booleans, for the reason `facade-write-scan.test.ts` learned the
 * hard way: a per-file boolean credits every other occurrence in the same
 * file, so a second read added inside an exempt display function would be
 * invisible.
 *
 * The second half is the RUNTIME form of the same rule, and it is derived too:
 * every exported class in the worker-directory modules has every method on its
 * prototype replaced with a lie AT ONCE, and the enforced answers must not
 * move. Nothing here names `assignability` or `allowedCapabilities`; the
 * methods come from `Object.getOwnPropertyNames` of the prototype, so a fourth
 * directory read added in a future phase is attacked without being enumerated.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture } from './application.fixture.js';
import * as ports from '../src/application/ports.js';
import * as registryDirectory from '../src/application/registry-directory.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { openMemoryHqDatabase } from '../src/store/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

/**
 * The surfaces `#200` and this phase deliberately publish as PATCHABLE reads.
 *
 * Each is safe exactly while nothing decides on it. The `key` is what an
 * exemption names; the pattern is written against the property chain rather
 * than a receiver name, so `ops.queue.get`, `deps.ops.queue.get` and
 * `this.queue.get` are all the same surface.
 */
const SURFACES: readonly { key: string; pattern: RegExp }[] = [
  { key: 'queue.get', pattern: /\.queue\s*\.\s*get\s*\(/g },
  { key: 'queue.capabilities.get', pattern: /\.queue\s*\.\s*capabilities\s*\.\s*get\s*\(/g },
  { key: 'queue.capabilities.list', pattern: /\.queue\s*\.\s*capabilities\s*\.\s*list\s*\(/g },
  { key: 'queue.killSwitchEngaged', pattern: /\.queue\s*\.\s*killSwitchEngaged\s*\(/g },
  { key: 'queue.evidence', pattern: /\.queue\s*\.\s*evidence\s*\./g },
  { key: 'workers.assignability', pattern: /\.workers\s*\.\s*assignability\s*\(/g },
  { key: 'workers.allowedCapabilities', pattern: /\.workers\s*\.\s*allowedCapabilities\s*\(/g },
  { key: 'workers.isRegistered', pattern: /\.workers\s*\.\s*isRegistered\s*\(/g },
];

/**
 * Where the surfaces are DEFINED and published, which is not a read of them.
 *
 * `operator/queue.ts` declares `get`, `capabilities`, `evidence` and
 * `killSwitchEngaged`; `application/service.ts` publishes the `workers` read
 * view. Both are matched by the property-chain patterns above and neither is a
 * caller. Named as files rather than lines so the exclusion cannot rot.
 */
const DEFINITION_FILES = new Set([path.join('src', 'operator', 'queue.ts')]);

/**
 * Every remaining read of a patchable surface in `src/`, with its exact count
 * and the reason it is not an authority.
 *
 * Asserted by EQUALITY in both directions: a new read anywhere fails, and an
 * exemption that stops being reachable fails too, so this list cannot rot into
 * a list of things that used to be true.
 *
 * ### `service.ts` → `queue.killSwitchEngaged` × 3
 *
 * All three are inside `#missionExecutionState`, the Mission Room's derived
 * READ projection. This is the exemption `kill-switch-enforcement-safe.test.ts`
 * already carries a behavioural proof for: with the delegate forged, the
 * projection reports the lie AND `orchestrateMission`'s apply cycle — the
 * write beside it — still reads `#killSwitchEngagedFromStore` and refuses
 * `kill_switch_engaged` with `op_tasks` empty. A lie here misinforms the
 * patcher's own display and moves nothing that is enforced.
 *
 * ### `snapshot.ts` → `queue.capabilities.list` × 1
 *
 * The capability CATALOGUE, rendered into the live snapshot. There is no
 * enforcement-safe `list` counterpart and there should not be one: every
 * decision in the package is about ONE named capability and reads it through
 * `capabilityRowFor`. Nothing downstream of the snapshot decides anything —
 * `snapshot.ts` builds a body for a browser — and a forged catalogue changes
 * what the patcher sees rendered, not what any gate permits.
 */
const EXEMPT: Readonly<Record<string, number>> = {
  'src/application/service.ts::queue.killSwitchEngaged': 3,
  'src/live/snapshot.ts::queue.capabilities.list': 1,
};

/** Every `.ts` file under `src/`, as repo-relative paths. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) found.push(full);
    }
  };
  walk(SRC);
  return found.sort();
}

/**
 * Blank out comments, preserving line structure.
 *
 * Comments are where the migration's REASONS live — every hardened call site
 * carries a note naming the surface it no longer reads — so a scan that
 * counted them would report the fix as the defect.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, before: string) => before + ' '.repeat(match.length - before.length));
}

/** `<relative file>::<surface key>` → occurrences, over all of `src/`. */
function patchableReads(): Record<string, number> {
  const counts: Record<string, number> = {};
  const root = path.join(HERE, '..');
  for (const file of sourceFiles()) {
    const relative = path.relative(root, file);
    if (DEFINITION_FILES.has(relative)) continue;
    const source = withoutComments(fs.readFileSync(file, 'utf8'));
    for (const { key, pattern } of SURFACES) {
      const matches = source.match(new RegExp(pattern.source, 'g'));
      if (!matches) continue;
      // The `workers` read view service.ts publishes for callers and tests is
      // the surface itself, not a read of it: `allowedCapabilities: (workerId)
      // => this.#workers.allowedCapabilities(workerId)` has no `.workers.` on
      // the left. Nothing to exclude — the pattern already misses `#workers`,
      // which is the private, prototype-free triple.
      counts[`${relative.split(path.sep).join('/')}::${key}`] = matches.length;
    }
  }
  return counts;
}

describe('no authority-deciding path reads a patchable convenience surface', () => {
  it('finds exactly the reads that are exempted, with the counts the exemptions state', () => {
    expect(patchableReads()).toEqual(EXEMPT);
  });

  it('scans the whole package, so a file added in a future phase is covered by construction', () => {
    // The derivation is worth nothing if it reads three files. Both halves are
    // asserted: it walks the real tree, and it can actually SEE the surfaces
    // (a regex that matched nothing would also produce an empty result).
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(80);
    const root = path.join(HERE, '..');
    expect(files.map((f) => path.relative(root, f).split(path.sep).join('/'))).toContain(
      'src/application/service.ts',
    );
    const queue = withoutComments(
      fs.readFileSync(path.join(SRC, 'operator', 'queue.ts'), 'utf8'),
    );
    expect(queue.match(/\bget\s*\(id: string\): OperatorTask \| null/)).not.toBeNull();
  });

  it('publishes an enforcement-safe counterpart for every surface an authority needs', () => {
    // The exemptions above are only defensible because a migration TARGET
    // exists for each surface a decision reads. Derived from the module rather
    // than asserted: these are ES module bindings, so an importer cannot
    // replace them, and a missing one would mean a future call site had
    // nowhere to go but the patchable read.
    const service = fs.readFileSync(path.join(SRC, 'application', 'service.ts'), 'utf8');
    for (const binding of [
      'export function taskRowFor(',
      'export function capabilityRowFor(',
      'export function killSwitchEngagedFor(',
      'export function taskEvidenceRowsFor(',
      'export function gatewayActionHistoryFor(',
    ]) {
      expect(service, binding).toContain(binding);
    }
  });
});

/**
 * The runtime half. Every exported class in the two worker-directory modules
 * has EVERY prototype method replaced with a maximally permissive lie, all at
 * once, and the enforced answers must not move.
 *
 * Derived, not enumerated: the classes come from the module namespace and the
 * methods from `Object.getOwnPropertyNames` of each prototype. A fourth read
 * added to `WorkerDirectoryPort` in a future phase is attacked here without
 * anybody remembering to add it, which is the property the previous
 * regressions did not have.
 */
function withEveryDirectoryPrototypeLying<T>(body: () => T): T {
  const lies: Record<string, unknown> = {
    isRegistered: () => true,
    allowedCapabilities: () => [CAPS.indexDoc, CAPS.openPr, CAPS.readStatus, CAPS.dropIndex],
    assignability: () => ({ assignable: true }),
  };
  const saved: { proto: Record<string, unknown>; name: string; had: boolean; value: unknown }[] = [];
  for (const namespace of [ports, registryDirectory] as unknown as Record<string, unknown>[]) {
    for (const exported of Object.values(namespace)) {
      if (typeof exported !== 'function') continue;
      const proto = (exported as { prototype?: object }).prototype;
      if (!proto) continue;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const replacement = lies[name];
        if (replacement === undefined) continue;
        const target = proto as Record<string, unknown>;
        saved.push({
          proto: target,
          name,
          had: Object.prototype.hasOwnProperty.call(target, name),
          value: target[name],
        });
        target[name] = replacement;
      }
    }
  }
  // The attack has to actually take, or the test proves nothing.
  expect(saved.length).toBeGreaterThanOrEqual(6);
  try {
    return body();
  } finally {
    for (const { proto, name, had, value } of saved) {
      if (had) proto[name] = value;
      else delete proto[name];
    }
  }
}

describe('a lying worker-directory prototype changes nothing that is enforced', () => {
  it('refuses a claim by a worker the directory says holds nothing, in every composition', () => {
    // All three compositions `HeadquarterOperations` supports, because the
    // defect was that ONE of them (the `memberRegistry` branch) silently opted
    // out of the database-backed read.
    for (const composition of ['default', 'memberRegistry'] as const) {
      const db = openMemoryHqDatabase();
      const store = new HeadquarterStore(db);
      const members = new Map<string, unknown>();
      const ops = new HeadquarterOperations(db, {
        store,
        policyCtx: { preApprovedCapabilities: new Set<string>([CAPS.openPr]) },
        ...(composition === 'memberRegistry'
          ? {
              memberRegistry: {
                get: (id: string) => (members.get(id) ?? null) as never,
                listAssignments: () => [],
              },
            }
          : {}),
      });
      new CapabilityRegistry(db).register({
        id: CAPS.openPr,
        description: 'Open a branch-isolated PR',
        riskClass: 'external_side_effect',
        sideEffect: true,
        idempotent: true,
      });
      // Registered and ACTIVE, granted nothing. Least privilege is the only
      // thing between this worker and the task.
      store.upsertSpecialist({
        id: 'claude',
        displayName: 'Claude',
        vendor: 'anthropic',
        role: 'build_lead',
        allowedCapabilities: [],
        active: true,
      });
      members.set('claude', {
        id: 'claude',
        effectiveCapabilities: [],
        status: 'active',
        enabled: true,
        replacedById: null,
      });
      new HumanPrincipalRegistry(db).register({
        id: 'founder',
        displayName: 'Founder',
        originateCapabilities: [CAPS.openPr],
        approvalAuthority: true,
        active: true,
      });
      expectOk(
        ops.createTask({
          capabilityId: CAPS.openPr,
          payload: { pr: 1 },
          idempotencyKey: 'k1',
          requestedBy: 'founder',
        }),
      );

      const baseline = ops.claimNext('claude', CAPS.openPr);
      expect(baseline.ok, composition).toBe(false);
      if (!baseline.ok) expect(baseline.error.code, composition).toBe('not_permitted');

      const forged = withEveryDirectoryPrototypeLying(() => ops.claimNext('claude', CAPS.openPr));
      expect(forged.ok, composition).toBe(false);
      if (!forged.ok) expect(forged.error.code, composition).toBe('not_permitted');
      expect(
        (db.prepare(`SELECT claimed_by FROM op_tasks LIMIT 1`).get() as { claimed_by: string | null })
          .claimed_by,
        composition,
      ).toBeNull();
    }
  });

  it('refuses a DISABLED worker every read the facade publishes an answer for', () => {
    const fx = setupFixture();
    fx.store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: [CAPS.readStatus, CAPS.openPr, CAPS.indexDoc, CAPS.dropIndex],
      active: false,
    });
    const baseline = fx.ops.workers.assignability('claude');
    expect(baseline).toEqual({ assignable: false, reason: 'worker_inactive' });
    const forged = withEveryDirectoryPrototypeLying(() => fx.ops.workers.assignability('claude'));
    expect(forged).toEqual({ assignable: false, reason: 'worker_inactive' });
  });
});
