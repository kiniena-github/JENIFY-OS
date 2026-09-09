/**
 * Browser-safe HQ snapshot (issue #200, scope A).
 *
 * The snapshot is the only artefact that leaves the machine, so these tests
 * assert on the whole thing rather than on a helper: no task payloads, no
 * secrets, no invented metrics, honest provenance, and a mode that degrades
 * to the weakest section rather than to the most flattering one.
 */

import { readFileSync } from 'node:fs';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { setupFixture, CAPS, expectOk } from './application.fixture.js';
import { founderConsole } from '../src/application/console.js';
import {
  buildHqSnapshot,
  emptyFounderConsole,
  HQ_SNAPSHOT_VERSION,
  liveSnapshotFromOperations,
  trimActivity,
  type SnapshotSources,
} from '../src/live/snapshot.js';
import { assertBrowserSafe, assertNoFabricatedFields, BrowserSafetyError } from '../src/live/redaction.js';
import { weakestMode } from '../src/live/provenance.js';
import { registerDirectOrderCapability, submitDirectOrder, DIRECT_ORDER_CAPABILITY } from '../src/live/orders.js';
import type { ActivityEvent } from '../src/contracts/events.js';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHqDatabase, openHqDatabaseReadOnly } from '../src/store/db.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { ensureApplicationSchema } from '../src/application/db.js';
import { ensurePrincipalSchema } from '../src/application/principals.js';
import { SAFE_MODE_STATEMENT } from '../src/store/integrity.js';

const NOW = '2026-08-28T12:00:00Z';
const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };

function sources(overrides: Partial<SnapshotSources> = {}): SnapshotSources {
  const provenance = { mode: 'live' as const, source: 'test', asOf: NOW };
  return {
    generatedAt: NOW,
    console: { data: emptyFounderConsole(NOW), provenance },
    connections: { data: [], provenance },
    workforce: { data: [], provenance },
    capabilities: { data: [], provenance },
    activity: { data: [], provenance },
    missions: { data: [], provenance },
    projects: { data: [], provenance },
    memory: { data: [], provenance },
    ...overrides,
  };
}

/** A minimal, browser-safe MissionBrowserView for section-shape tests. */
function missionView(id: string, createdAt: string): SnapshotSources['missions']['data'][number] {
  return {
    id,
    title: `Mission ${id}`,
    objective: 'Objective',
    scope: null,
    constraints: [],
    acceptanceCriteria: null,
    project: null,
    projectId: null,
    projectName: null,
    priority: null,
    status: 'planned',
    blockReason: null,
    dependsOn: [],
    sourceOrderTaskId: null,
    createdBy: 'founder',
    createdAt,
    updatedAt: createdAt,
    statusChangedAt: createdAt,
    statusChangedBy: 'founder',
    verification: null,
    authority: {
      riskClass: 'founder_gate',
      founderOnly: true,
      approvalFlow: 'originate_gated_no_approval_row',
    },
    planItems: [],
    intentHistory: [
      {
        seq: 0,
        kind: 'founder_order',
        actor: 'founder',
        at: createdAt,
        objective: 'Objective',
        constraints: [],
        acceptanceCriteria: null,
      },
    ],
    blockHistory: [],
  };
}

describe('shape and provenance', () => {
  it('stamps a version and the instant it was generated', () => {
    const snapshot = buildHqSnapshot(sources());
    expect(snapshot.snapshotVersion).toBe(HQ_SNAPSHOT_VERSION);
    expect(snapshot.generatedAt).toBe(NOW);
  });

  it('carries per-section provenance naming what was actually read', () => {
    const { ops } = setupFixture();
    const snapshot = liveSnapshotFromOperations(ops, { now: NOW });
    expect(snapshot.operations.provenance.source).toContain('op_tasks');
    expect(snapshot.workforce.provenance.source).toContain('hq_specialists');
    expect(snapshot.capabilities.provenance.source).toContain('op_capabilities');
    expect(snapshot.activity.provenance.source).toContain('hq_events');
    for (const key of ['operations', 'workforce', 'capabilities', 'activity'] as const) {
      expect(snapshot[key].provenance.asOf).toBe(NOW);
    }
  });

  it('takes the WEAKEST mode across sections, so one sample cannot render as LIVE', () => {
    const live = { mode: 'live' as const, source: 't', asOf: NOW };
    const sample = { mode: 'sample' as const, source: 't', asOf: NOW };
    const mixed = buildHqSnapshot(
      sources({
        console: { data: emptyFounderConsole(NOW), provenance: live },
        activity: { data: [], provenance: sample },
      }),
    );
    expect(mixed.mode).toBe('sample');
    expect(weakestMode(['live', 'reconstructed'])).toBe('reconstructed');
    expect(weakestMode(['live', 'live'])).toBe('live');
  });

  it('derives a live snapshot straight from a running operations facade', () => {
    const { ops } = setupFixture();
    const snapshot = liveSnapshotFromOperations(ops, { now: NOW, env: CLAUDE_ONLY });
    expect(snapshot.mode).toBe('live');
    expect(snapshot.workforce.data.map((worker) => worker.id).sort()).toEqual([
      'claude',
      'codex',
      'jules',
      'retired-bot',
    ]);
    expect(snapshot.capabilities.data.map((capability) => capability.id)).toContain(CAPS.openPr);
    // Connection state is probed independently of the snapshot's own mode —
    // and routing evidence reaches DISPATCHABLE, never connected (Codex
    // round-3 P1 #3).
    const claude = snapshot.connections.data.find((entry) => entry.id === 'anthropic-claude')!;
    expect(claude.state).toBe('dispatchable');
    expect(claude.effectiveCapabilities).toEqual([]);
  });
});

describe('the Phase 4 sections travel the live path truthfully', () => {
  it('carries the project register, provider declarations and member enrichment', async () => {
    const fixture = setupFixture();
    const { registerProjectCommandCapability, PROJECT_COMMAND_CAPABILITY } = await import(
      '../src/application/project-command.js'
    );
    const { registerMissionCommandCapability, MISSION_COMMAND_CAPABILITY } = await import(
      '../src/application/mission-command.js'
    );
    const { AiMemberRegistry } = await import('../src/registry/members.js');
    const { MemberCapabilityRegistry } = await import('../src/registry/capabilities.js');
    const { ProviderDirectory } = await import('../src/providers/directory.js');
    const { declaredOnlyAdapter } = await import('../src/providers/declared.js');
    const { HeadquarterOperations } = await import('../src/application/service.js');
    const { HeadquarterStore } = await import('../src/store/headquarter.js');

    registerProjectCommandCapability(fixture.db);
    registerMissionCommandCapability(fixture.db);
    fixture.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [PROJECT_COMMAND_CAPABILITY.id, MISSION_COMMAND_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const providers = new ProviderDirectory();
    providers.register(
      declaredOnlyAdapter({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'cloud',
        advertisedModels: [],
      }),
    );
    const registry = new AiMemberRegistry(
      fixture.db,
      providers,
      new MemberCapabilityRegistry(fixture.db),
    );
    const ops = new HeadquarterOperations(fixture.db, {
      store: new HeadquarterStore(fixture.db),
      aiMemberRegistry: registry,
    });

    const projectId = (() => {
      const created = ops.createProject({
        name: 'JENIFY OS',
        purpose: 'The platform program',
        stream: 'jenify-os',
        requestedBy: 'founder',
      });
      if (!created.ok) throw new Error(created.error.message);
      return created.data.project.id;
    })();
    const commanded = ops.commandMission({
      title: 'Ship Phase 4',
      objective: 'Projects, tasks and the workforce become first-class',
      projectId,
      requestedBy: 'founder',
    });
    expect(commanded.ok).toBe(true);
    expect(
      ops.declareWorkerProvider({ workerId: 'claude', providerId: 'CLAUDE', founderId: 'founder' })
        .ok,
    ).toBe(true);
    expect(
      ops.registerAiMember({
        id: 'claude',
        displayName: 'Claude member record',
        providerId: 'anthropic',
        modelId: 'claude-fable-5',
        modelVersion: '1',
        workerType: 'execution',
        locality: 'cloud',
        privacyClass: 'internal',
        costClass: 'high',
        founderId: 'founder',
      }).ok,
    ).toBe(true);

    const snapshot = liveSnapshotFromOperations(ops, { now: NOW, env: CLAUDE_ONLY });
    expect(snapshot.counts.projects).toBe(1);
    const project = snapshot.projects.data[0]!;
    expect(project.name).toBe('JENIFY OS');
    expect(project.status).toBe('active');
    expect(project.missions.map((m) => m.title)).toEqual(['Ship Phase 4']);
    // The mission section carries the SAME relationship through the shared view.
    const mission = snapshot.missions.data[0]!;
    expect(mission.projectId).toBe(projectId);
    expect(mission.projectName).toBe('JENIFY OS');

    const claude = snapshot.workforce.data.find((worker) => worker.id === 'claude')!;
    // Declared truth, not inference; dispatchability unobserved here => null.
    expect(claude.provider).toEqual({ declaredId: 'CLAUDE', dispatchable: null });
    expect(claude.member!.identityKey).toBe('anthropic:claude-fable-5:1');
    expect(claude.member!.health).toBe('unknown'); // nothing probed, nothing claimed
    // Workers with no declaration and no member record say so with nulls.
    const codex = snapshot.workforce.data.find((worker) => worker.id === 'codex')!;
    expect(codex.provider).toBeNull();
    expect(codex.member).toBeNull();
  });
});

describe('what the snapshot must never contain', () => {
  it('never carries a task payload — an order instruction stays server-side', () => {
    const fixture = setupFixture();
    registerDirectOrderCapability(fixture.db);
    fixture.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const secretish = 'Rotate the warehouse door code to 8891 before Friday.';
    const order = submitDirectOrder(
      fixture.ops,
      { instruction: secretish, route: 'CLAUDE', requestedBy: 'founder' },
      CLAUDE_ONLY,
    );
    expect(order.ok).toBe(true);

    const snapshot = liveSnapshotFromOperations(fixture.ops, { now: NOW, env: CLAUDE_ONLY });
    const serialized = JSON.stringify(snapshot);
    // The task is visible and gated; its contents are not published.
    expect(snapshot.counts.approvals).toBe(1);
    expect(serialized).not.toContain(secretish);
    expect(serialized).not.toContain('8891');
    expect(serialized).not.toContain('"payload"');
    // The order is labelled neutrally unless its author chose a title.
    expect(snapshot.operations.data.approvals[0]!.title).toBe('Direct order → CLAUDE');
  });

  /**
   * Wave 5 correction round four, Critical C1 — end to end, through the one
   * order field that genuinely reaches the browser.
   *
   * The reviewer ran exactly this and got the artifact BUILT with the
   * credential on it: `assertBrowserSafe` is the only thing between a memory
   * body and the world-readable `hq-snapshot.json`, and a C0/C1 control
   * character, a hyphen homoglyph or an underscore-joined prefix each walked
   * straight through it. A plain `sk-...` correctly refused the order.
   *
   * The assertion is that the ORDER is refused — the same answer the plain form
   * already got — which is strictly better than a refused snapshot: nothing
   * poisoned is stored in the first place.
   */
  it('refuses an order title carrying a credential hidden by a control character, a dash homoglyph or a prefix', () => {
    const hidden = [
      `sk-${String.fromCharCode(0x01)}AAAAAAAAAAAAAAAAAAAA`,
      `sk-${String.fromCharCode(0x1f)}AAAAAAAAAAAAAAAAAAAA`,
      `sk-${String.fromCharCode(0x7f)}AAAAAAAAAAAAAAAAAAAA`,
      `sk-${String.fromCharCode(0x90)}AAAAAAAAAAAAAAAAAAAA`,
      'sk‐AAAAAAAAAAAAAAAAAAAA',
      'OPENAI_KEY_sk-AAAAAAAAAAAAAAAAAAAA',
    ];
    for (const title of hidden) {
      const fixture = setupFixture();
      registerDirectOrderCapability(fixture.db);
      fixture.principals.register({
        id: 'founder',
        displayName: 'Founder',
        originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
        approvalAuthority: true,
        active: true,
      });
      const order = submitDirectOrder(
        fixture.ops,
        { instruction: 'Routine work.', title, route: 'CLAUDE', requestedBy: 'founder' },
        CLAUDE_ONLY,
      );
      // Refused at the write, exactly as the plain `sk-...` form already was.
      expect(order.ok, JSON.stringify(title)).toBe(false);
      // And nothing reached the unauthenticated artifact either.
      const snapshot = liveSnapshotFromOperations(fixture.ops, { now: NOW, env: CLAUDE_ONLY });
      expect(JSON.stringify(snapshot), JSON.stringify(title)).not.toContain('AAAAAAAAAAAAAAAAAAAA');
    }
  });

  it('publishes a title only when its author deliberately chose one', () => {
    const fixture = setupFixture();
    registerDirectOrderCapability(fixture.db);
    fixture.principals.register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    submitDirectOrder(
      fixture.ops,
      {
        instruction: 'Sensitive detail nobody chose to publish.',
        title: 'Q3 maintenance plan',
        route: 'CLAUDE',
        requestedBy: 'founder',
      },
      CLAUDE_ONLY,
    );
    const snapshot = liveSnapshotFromOperations(fixture.ops, { now: NOW, env: CLAUDE_ONLY });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).toContain('Q3 maintenance plan');
    expect(serialized).not.toContain('Sensitive detail');
  });

  it('refuses to build at all when a section carries a credential', () => {
    const provenance = { mode: 'live' as const, source: 'test', asOf: NOW };
    expect(() =>
      buildHqSnapshot(
        sources({
          workforce: {
            data: [
              {
                id: 'leaky',
                displayName: 'Leaky',
                vendor: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
                role: 'build_lead',
                allowedCapabilities: [],
                active: true,
              },
            ],
            provenance,
          },
        }),
      ),
    ).toThrow(BrowserSafetyError);
  });

  it('proves a real snapshot passes both guards', () => {
    const { ops } = setupFixture();
    const snapshot = liveSnapshotFromOperations(ops, { now: NOW, env: CLAUDE_ONLY });
    expect(() => assertBrowserSafe(snapshot)).not.toThrow();
    expect(() => assertNoFabricatedFields(snapshot)).not.toThrow();
  });

  it('refuses a fabricated mission metric — the concept-art numbers stay out (Phase 3)', () => {
    // The HQ-UI-3D reference concepts show progress bars and budgets. HQ
    // measures neither, so a missions section that grew such a field must
    // fail the build, never reach a browser.
    const provenance = { mode: 'live' as const, source: 'test', asOf: NOW };
    expect(() =>
      buildHqSnapshot(
        sources({
          missions: {
            data: [{ id: 'mission-x', title: 'X', progressPercent: 62 } as never],
            provenance,
          },
        }),
      ),
    ).toThrow(BrowserSafetyError);
  });

  it('publishes no cost, token, ETA or sentiment field anywhere', () => {
    const { ops } = setupFixture();
    const serialized = JSON.stringify(liveSnapshotFromOperations(ops, { now: NOW }));
    for (const forbidden of ['"cost"', '"tokens"', '"eta"', '"sentiment"', '"progressPercent"']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('activity trimming', () => {
  const event = (seq: number, extra: Partial<ActivityEvent> = {}): ActivityEvent =>
    ({
      seq,
      id: `e${seq}`,
      at: `2026-08-2${seq}T00:00:00Z`,
      actor: 'claude',
      subjectKind: 'task',
      subjectId: `t${seq}`,
      status: 'running',
      summary: `event ${seq}`,
      detail: { project: 'mesob', title: 'A title', internalPath: '/home/founder/.codex/auth.json' },
      refs: ['https://example.test/pr/1', '/local/path/secret.txt'],
      ...extra,
    }) as ActivityEvent;

  it('keeps only whitelisted detail fields, so arbitrary worker detail cannot leak', () => {
    const [entry] = trimActivity([event(1)]);
    expect(entry!.project).toBe('mesob');
    expect(entry!.title).toBe('A title');
    expect(JSON.stringify(entry)).not.toContain('internalPath');
    expect(JSON.stringify(entry)).not.toContain('auth.json');
  });

  it('drops non-https refs, which would expose the machine’s layout', () => {
    const [entry] = trimActivity([event(1)]);
    expect(entry!.refs).toEqual(['https://example.test/pr/1']);
  });

  it('returns the newest events first, bounded by the limit', () => {
    const entries = trimActivity([event(1), event(3), event(2)], 2);
    expect(entries.map((e) => e.seq)).toEqual([3, 2]);
  });
});

describe('reproducibility', () => {
  it('produces identical bytes for identical inputs', () => {
    const { ops } = setupFixture();
    const a = liveSnapshotFromOperations(ops, { now: NOW, env: CLAUDE_ONLY });
    const b = liveSnapshotFromOperations(ops, { now: NOW, env: CLAUDE_ONLY });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('counts match the console it projected', () => {
    const fixture = setupFixture();
    expectOk(
      fixture.ops.createTask({
        capabilityId: CAPS.indexDoc,
        payload: { doc: 'x' },
        idempotencyKey: 'k1',
        requestedBy: 'claude',
      }),
    );
    const snapshot = liveSnapshotFromOperations(fixture.ops, { now: NOW });
    const console_ = founderConsole(fixture.ops, new Date(NOW));
    expect(snapshot.counts.approvals).toBe(console_.approvals.length);
    expect(snapshot.counts.queued).toBe(console_.queued.length);
  });
});

/**
 * Open Codex finding — the snapshot tool's database open.
 *
 * `src/cli/snapshot.ts` describes itself as read-only, but it used to open the
 * store with `openHqDatabase`, which is a MIGRATING open: it creates the file
 * when absent, switches the journal to WAL and applies DDL. So a tool whose
 * whole contract is "project the Founder's state and touch nothing" altered
 * that state's schema on every run, and a typo in `--db` created an empty
 * database that was then published as LIVE HQ state.
 */
describe('projecting the store never writes to it', () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'hq-ro-')), 'headquarter.sqlite');

  it('refuses a write at the connection, not merely by convention', () => {
    const path = tmp();
    openHqDatabase(path).close();
    const ro = openHqDatabaseReadOnly(path);
    expect(() =>
      ro
        .prepare(
          `INSERT INTO hq_events (id, at, subject_kind, subject_id, status, actor, summary)
           VALUES ('x', 'now', 'task', 't', 'queued', 'nobody', 'should never land')`,
        )
        .run(),
    ).toThrow(/readonly/i);
    expect(() => ro.exec(`CREATE TABLE sneaky (a TEXT)`)).toThrow(/readonly/i);
    ro.close();
  });

  it('reports a database that is not there instead of creating one', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hq-ro-')), 'typo.sqlite');
    expect(() => openHqDatabaseReadOnly(path)).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('still projects a real snapshot over the read-only handle', () => {
    // The guarantee is worth nothing if the read path cannot run under it.
    const path = tmp();
    const writable = openHqDatabase(path);
    const seeded = new HeadquarterOperations(writable);
    new CapabilityRegistry(writable).register({
      id: 'repo.read_status',
      description: 'Read repo/CI status',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    writable.close();

    const ro = openHqDatabaseReadOnly(path);
    const snapshot = liveSnapshotFromOperations(new HeadquarterOperations(ro), {
      now: NOW,
      env: CLAUDE_ONLY,
    });
    expect(snapshot.mode).toBe('live');
    expect(snapshot.capabilities.data.map((c) => c.id)).toContain('repo.read_status');
    ro.close();
  });

  it('projects a truthful snapshot over a read-only PRE-PHASE-3 database', () => {
    // Opus second-pass finding (M2) on `cee771f`: the constructor ran mission
    // DDL unconditionally, so hq:snapshot over a read-only pre-Phase-3 file
    // threw SQLITE_READONLY before it could project anything. Schema init now
    // never writes through a read-only handle, and the absent mission store
    // is REPRESENTED — zero rows with provenance saying why — not migrated.
    const path = tmp();
    const writable = openHqDatabase(path);
    // A Phase 2 store: foundation + application + principal schema, and
    // deliberately NO mission tables.
    ensureApplicationSchema(writable);
    ensurePrincipalSchema(writable);
    writable.close();

    const ro = openHqDatabaseReadOnly(path);
    const ops = new HeadquarterOperations(ro);
    expect(ops.missionStorePresent()).toBe(false);
    expect(ops.listMissions()).toEqual([]);
    expect(ops.getMission('mission-anything')).toBeNull();
    expect(ops.getMissionIntentHistory('mission-anything')).toEqual([]);

    const snapshot = liveSnapshotFromOperations(ops, { now: NOW, env: CLAUDE_ONLY });
    expect(snapshot.counts.missions).toBe(0);
    expect(snapshot.missions.data).toEqual([]);
    expect(snapshot.missions.provenance.note).toContain('predates the Phase 3 mission tables');

    // The Phase 4 register follows the same absence rule: the foundation
    // hq_projects table exists in this file, but the Phase 4 schema (the
    // append-only event log) does not, and a read-only handle never creates
    // it — so the section states absence rather than an empty register.
    expect(ops.projectStorePresent()).toBe(false);
    expect(ops.listProjects()).toEqual([]);
    expect(ops.getProject('project-anything')).toBeNull();
    expect(snapshot.counts.projects).toBe(0);
    expect(snapshot.projects.data).toEqual([]);
    expect(snapshot.projects.provenance.note).toContain('predates the Phase 4 project schema');

    // Truthful means UNTOUCHED: nothing on the read-only path migrated the
    // file — the mission tables still do not exist.
    expect(
      ro
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_missions'`)
        .get(),
    ).toBeUndefined();
    ro.close();
  });
});

describe('the mission section bound (opt-in, honest)', () => {
  it('bounds the section to the newest N while counts and provenance keep the total', () => {
    const missions = [
      missionView('mission-a', '2026-09-01T00:00:00Z'),
      missionView('mission-b', '2026-09-02T00:00:00Z'),
      missionView('mission-c', '2026-09-03T00:00:00Z'),
    ];
    const provenance = { mode: 'live' as const, source: 'test', asOf: NOW };
    const snapshot = buildHqSnapshot(
      sources({ missions: { data: missions, provenance }, missionLimit: 2 }),
    );
    // The NEWEST two survive, still oldest-first for display stability…
    expect(snapshot.missions.data.map((m) => m.id)).toEqual(['mission-b', 'mission-c']);
    // …the count reports the TOTAL, not the trimmed length…
    expect(snapshot.counts.missions).toBe(3);
    // …and the provenance states exactly what was dropped.
    expect(snapshot.missions.provenance.note).toContain('newest 2 of 3');
  });

  it('changes nothing when no limit is passed — the live /state path stays unbounded', () => {
    const missions = [
      missionView('mission-a', '2026-09-01T00:00:00Z'),
      missionView('mission-b', '2026-09-02T00:00:00Z'),
    ];
    const provenance = { mode: 'live' as const, source: 'test', asOf: NOW };
    const snapshot = buildHqSnapshot(sources({ missions: { data: missions, provenance } }));
    expect(snapshot.missions.data).toHaveLength(2);
    expect(snapshot.missions.provenance.note).toBeUndefined();
  });
});

/**
 * Codex exact-head finding on `f221826` (P1). `build-site.ts` renders a data
 * file and never opens the HQ store, so its operational section is
 * `emptyFounderConsole`. A bundle setting `sourceMode: 'live'` nonetheless
 * stamped LIVE provenance on that empty section — and because the emitted
 * snapshot shares the HTML's `asOf`, the browser freshness poll then reported
 * LIVE over state nothing had read.
 *
 * The rule enforced here is the same one the browser applies at the far end of
 * the pipeline: only positive live provenance may say LIVE, and only a build
 * that actually opened the store can establish it.
 */
describe('a static build cannot claim live operational provenance', () => {
  const buildSiteScript = readFileSync(
    fileURLToPath(new URL('../src/cli/build-site.ts', import.meta.url)),
    'utf8',
  );

  it('forces every SYNTHETIC section non-live, not just the console one', () => {
    // The rule is about provenance, not about one section: data that came out
    // of the bundle may carry the bundle's mode; data fabricated here may not.
    // The capability section is `data: []` and was missed the first time.
    const capabilityBlock = buildSiteScript.slice(
      buildSiteScript.indexOf('  capabilities: {'),
      buildSiteScript.indexOf('  activity: {'),
    );
    expect(capabilityBlock).toContain('staticSectionMode(data.sourceMode)');
    expect(capabilityBlock).not.toContain("mode: data.sourceMode ?? 'sample'");
    // And the sections that ARE the bundle's data keep the bundle's claim.
    const workforceBlock = buildSiteScript.slice(
      buildSiteScript.indexOf('  workforce: {'),
      buildSiteScript.indexOf('  capabilities: {'),
    );
    expect(workforceBlock).toContain("mode: data.sourceMode ?? 'sample'");
  });

  it('never passes a bundle-declared live mode through to the console section', () => {
    // Scoped to the CONSOLE block, which is the section that is empty by
    // construction. The other sections genuinely are the bundle's own data, so
    // the bundle's own mode is the right claim for them — and the overall
    // snapshot mode degrades to the weakest section regardless, so forcing this
    // one is what stops the bundle announcing LIVE.
    const consoleBlock = buildSiteScript.slice(
      buildSiteScript.indexOf('  console: {'),
      buildSiteScript.indexOf('  connections: {'),
    );
    expect(consoleBlock).toContain('staticSectionMode(data.sourceMode)');
    expect(consoleBlock).not.toContain("mode: data.sourceMode ?? 'sample'");
    expect(consoleBlock).toContain('emptyFounderConsole');
  });

  it('downgrades live to sample and preserves reconstructed', () => {
    // Executed rather than grepped: the shipped mapping is the tested one.
    const body = buildSiteScript.slice(buildSiteScript.indexOf('function staticSectionMode'));
    const source = body.slice(0, body.indexOf('\n}') + 2);
    const staticSectionMode = new Function(
      `${source.replace(/: SourceMode \| undefined/, '').replace(/: SourceMode/, '')}; return staticSectionMode;`,
    )() as (m: string | undefined) => string;
    expect(staticSectionMode('live')).toBe('sample');
    expect(staticSectionMode(undefined)).toBe('sample');
    expect(staticSectionMode('sample')).toBe('sample');
    expect(staticSectionMode('reconstructed')).toBe('reconstructed');
  });
});

/**
 * Wave 5 correction round fifteen, MEDIUM 2 — what safe mode MEANS is served on
 * the artifact that states it.
 *
 * Three shipped sentences said `SAFE_MODE_STATEMENT` is served on the
 * unauthenticated `hq-snapshot.json`: its own docblock in `store/integrity.ts`,
 * the durability note in `application/service.ts`, and Phase 13's round-fourteen
 * entry. Executed at `c23dd0a` with safe mode genuinely engaged, the statement
 * was on NO part of the snapshot — full text false, the mid-ledger clause false,
 * even the opening words "Safe mode is a statement" false. It reached
 * `#integrityView()` only, which is behind `assessHqIntegrity` and
 * `hqReliabilityPosture`, both authenticated, plus the refusal message.
 *
 * The choice made was to widen the artifact rather than narrow the sentence: the
 * statement is a fixed constant carrying no per-file data, and an unauthenticated
 * reader who sees `safeMode: true` with no explanation is exactly the reader it
 * was written for. This pins that choice both ways — the statement is there, and
 * it is the SAME constant rather than a second paraphrase that could drift.
 */
describe('the unauthenticated snapshot carries the safe-mode statement it is said to carry', () => {
  it('serves SAFE_MODE_STATEMENT verbatim in the reliability section', () => {
    const fx = setupFixture();
    const snapshot = liveSnapshotFromOperations(fx.ops, { now: NOW, mode: 'live' });
    const section = snapshot.reliability;
    expect(section, 'the snapshot carries no reliability section').toBeDefined();
    expect(section!.data.safeModeStatement).toBe(SAFE_MODE_STATEMENT);
    // Verbatim on the SERIALIZED artifact, which is what
    // `cli/snapshot.ts` writes — a field that survives `JSON.stringify` is the
    // claim, not a field that exists on the object.
    expect(JSON.stringify(snapshot)).toContain('Safe mode is a statement about');
  });

  it('is one constant, not a paraphrase the two surfaces can drift apart on', () => {
    const fx = setupFixture();
    const snapshot = liveSnapshotFromOperations(fx.ops, { now: NOW, mode: 'live' });
    // The authenticated view and the unauthenticated artifact must carry the
    // identical string. Two spellings of "what safe mode means" is exactly the
    // second truth this codebase refuses everywhere else.
    const authenticated = fx.ops.hqReliabilityPosture().integrity.safeModeStatement;
    expect(snapshot.reliability!.data.safeModeStatement).toBe(authenticated);
  });

  it('still says it when safe mode is actually engaged, which is when it matters', () => {
    const fx = setupFixture();
    // A dropped append-only guard is the cheapest genuine engagement.
    fx.db.exec('DROP TRIGGER trg_op_evidence_no_erase');
    const restarted = new HeadquarterOperations(fx.db, { store: fx.store });
    const snapshot = liveSnapshotFromOperations(restarted, { now: NOW, mode: 'live' });
    expect(snapshot.reliability!.data.safeMode).toBe(true);
    expect(snapshot.reliability!.data.safeModeStatement).toBe(SAFE_MODE_STATEMENT);
  });

  it('adds no per-file data: the statement carries no path, id or finding detail', () => {
    // Why widening the artifact was safe. The constant is fixed text; if a
    // future edit interpolated anything into it, this fails.
    expect(SAFE_MODE_STATEMENT).not.toMatch(/[/\\][A-Za-z0-9_.-]+\.sqlite/);
    expect(SAFE_MODE_STATEMENT).not.toContain('${');
    expect(SAFE_MODE_STATEMENT.length).toBeGreaterThan(500);
  });
});
