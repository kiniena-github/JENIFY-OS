/**
 * The hq:workforce configuration command, executed in-process (Phase 4).
 *
 * `executeWorkforceCommand` is exported precisely so these tests run the
 * command's real rule — fail-closed capability list, principal bootstrap,
 * facade-gated member/worker actions — without a subprocess and without the
 * import-time main() the other CLIs carry.
 */

import { describe, expect, it } from 'vitest';
import { executeWorkforceCommand } from '../src/cli/workforce.js';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { PROJECT_COMMAND_CAPABILITY } from '../src/application/project-command.js';
import {
  COLLABORATION_COMMAND_CAPABILITY,
  COLLABORATION_CONTRIBUTE_CAPABILITY,
  collaborationCommandCapabilityState,
  collaborationContributeCapabilityState,
} from '../src/application/collaboration-command.js';
import { capabilityRowFor } from '../src/application/service.js';

/** One shared in-memory db per test, reopened by every openDb call. */
function harness(): { db: HqDatabase; openDb: () => HqDatabase } {
  const db = openMemoryHqDatabase();
  return { db, openDb: () => db };
}

function seededFounder(db: HqDatabase): void {
  new HumanPrincipalRegistry(db).register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [],
    approvalAuthority: true,
    active: true,
  });
}

describe('capability registration is fail-closed to the known trio', () => {
  it('registers hq.project_command and reports the state honestly', () => {
    const { db, openDb } = harness();
    const result = executeWorkforceCommand(
      ['--register-capability', PROJECT_COMMAND_CAPABILITY.id],
      openDb,
    );
    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toContain('missing → enabled');
    expect(
      db.prepare(`SELECT enabled FROM op_capabilities WHERE id = ?`).get(PROJECT_COMMAND_CAPABILITY.id),
    ).toBeDefined();
  });

  it('registers the two Phase 9 collaboration trios with their reserved contracts, one per run, and reports the state honestly', () => {
    const { db, openDb } = harness();
    for (const [id, state] of [
      [COLLABORATION_COMMAND_CAPABILITY.id, collaborationCommandCapabilityState],
      [COLLABORATION_CONTRIBUTE_CAPABILITY.id, collaborationContributeCapabilityState],
    ] as const) {
      const result = executeWorkforceCommand(['--register-capability', id], openDb);
      expect(result.ok, id).toBe(true);
      expect(result.lines.join('\n')).toContain('missing → enabled');
      const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
      expect(state(capabilityRowFor(ops, id))).toBe('enabled');
    }
    const command = db.prepare(`SELECT risk_class, side_effect, idempotent FROM op_capabilities WHERE id = ?`).get(COLLABORATION_COMMAND_CAPABILITY.id);
    expect(command).toEqual({ risk_class: 'founder_gate', side_effect: 0, idempotent: 1 });
    const contribute = db.prepare(`SELECT risk_class, side_effect, idempotent FROM op_capabilities WHERE id = ?`).get(COLLABORATION_CONTRIBUTE_CAPABILITY.id);
    expect(contribute).toEqual({ risk_class: 'reversible', side_effect: 0, idempotent: 1 });
  });

  it('refuses an id outside the trio and never enables a disabled row', () => {
    const { db, openDb } = harness();
    const unknown = executeWorkforceCommand(['--register-capability', 'infra.drop_index'], openDb);
    expect(unknown.ok).toBe(false);
    expect(unknown.lines.join('\n')).toContain('Unknown capability');

    executeWorkforceCommand(['--register-capability', PROJECT_COMMAND_CAPABILITY.id], openDb);
    db.prepare(`UPDATE op_capabilities SET enabled = 0 WHERE id = ?`).run(
      PROJECT_COMMAND_CAPABILITY.id,
    );
    const again = executeWorkforceCommand(
      ['--register-capability', PROJECT_COMMAND_CAPABILITY.id],
      openDb,
    );
    expect(again.ok).toBe(true);
    expect(again.lines.join('\n')).toContain('stays DISABLED');
    const row = db
      .prepare(`SELECT enabled FROM op_capabilities WHERE id = ?`)
      .get(PROJECT_COMMAND_CAPABILITY.id) as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it('refuses zero actions and refuses two actions in one run', () => {
    const { openDb } = harness();
    expect(executeWorkforceCommand([], openDb).ok).toBe(false);
    expect(
      executeWorkforceCommand(
        ['--register-capability', PROJECT_COMMAND_CAPABILITY.id, '--register-principal', 'x'],
        openDb,
      ).ok,
    ).toBe(false);
  });
});

describe('principal bootstrap', () => {
  it('registers a principal with stated grants and authority', () => {
    const { db, openDb } = harness();
    const result = executeWorkforceCommand(
      [
        '--register-principal',
        'founder',
        '--display-name',
        'The Founder',
        '--grants',
        'hq.mission_command,hq.project_command',
        '--approval-authority',
      ],
      openDb,
    );
    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toContain('BOOTSTRAP PATH');
    const principal = new HumanPrincipalRegistry(db).get('founder')!;
    expect(principal.approvalAuthority).toBe(true);
    expect(principal.originateCapabilities).toEqual(['hq.mission_command', 'hq.project_command']);
  });

  it('re-running against an existing id is an UPSERT, stated loudly — never reported as a fresh registration', () => {
    // register() replaces the row wholesale; the CLI inherits that. This pin
    // makes the overwrite semantics INTENTIONAL (Opus Low on PR #263): a
    // re-run with omitted flags wipes grants to [], drops approval
    // authority, and forces active back to true — and the output says
    // REPLACED with the previous truth, so nothing happens silently.
    const { db, openDb } = harness();
    executeWorkforceCommand(
      [
        '--register-principal',
        'founder',
        '--display-name',
        'The Founder',
        '--grants',
        'hq.mission_command',
        '--approval-authority',
      ],
      openDb,
    );
    // Deactivate directly (registry-level state, as a maintenance act would).
    db.prepare(`UPDATE hq_human_principals SET active = 0 WHERE id = 'founder'`).run();

    const rerun = executeWorkforceCommand(['--register-principal', 'founder'], openDb);
    expect(rerun.ok).toBe(true);
    const output = rerun.lines.join('\n');
    expect(output).toContain('Principal founder REPLACED');
    expect(output).toContain('replaced wholesale');
    expect(output).toContain('previous grants [hq.mission_command]');
    expect(output).not.toContain('Principal founder registered');

    const principal = new HumanPrincipalRegistry(db).get('founder')!;
    expect(principal.originateCapabilities).toEqual([]); // --grants omitted → wiped
    expect(principal.approvalAuthority).toBe(false); // flag omitted → dropped
    expect(principal.active).toBe(true); // always written true → reactivated
  });
});

describe('facade-gated actions refuse an unauthorized asserted principal', () => {
  it('refuses member registration without --as, and with a powerless principal', () => {
    const { db, openDb } = harness();
    const memberArgs = [
      '--register-member',
      'fable-main',
      '--member-provider',
      'anthropic',
      '--member-model',
      'claude-fable-5',
      '--member-version',
      '1',
    ];
    expect(executeWorkforceCommand(memberArgs, openDb).ok).toBe(false);

    new HumanPrincipalRegistry(db).register({
      id: 'analyst',
      displayName: 'Analyst',
      originateCapabilities: [],
      approvalAuthority: false,
      active: true,
    });
    const refused = executeWorkforceCommand([...memberArgs, '--as', 'analyst'], openDb);
    expect(refused.ok).toBe(false);
    expect(refused.lines.join('\n')).toContain('refused');
  });

  it('registers a member, declares health, disables it — through the real facade', () => {
    const { db, openDb } = harness();
    seededFounder(db);
    const registered = executeWorkforceCommand(
      [
        '--register-member',
        'fable-main',
        '--as',
        'founder',
        '--member-provider',
        'anthropic',
        '--member-model',
        'claude-fable-5',
        '--member-version',
        '1',
      ],
      openDb,
    );
    expect(registered.ok).toBe(true);
    expect(registered.lines.join('\n')).toContain('anthropic:claude-fable-5:1');
    expect(registered.lines.join('\n')).toContain('health unknown');
    expect(registered.lines.join('\n')).toContain('registry-only and can execute nothing');

    const health = executeWorkforceCommand(
      ['--set-member-health', 'fable-main=healthy', '--as', 'founder'],
      openDb,
    );
    expect(health.ok).toBe(true);
    expect(health.lines.join('\n')).toContain('never a probe');

    const disabled = executeWorkforceCommand(
      ['--disable-member', 'fable-main', '--as', 'founder', '--reason', 'model retired'],
      openDb,
    );
    expect(disabled.ok).toBe(true);
  });

  it('deactivates an execution worker and refuses one holding in-flight work', () => {
    const { db, openDb } = harness();
    seededFounder(db);
    new CapabilityRegistry(db).register({
      id: 'repo.read_status',
      description: 'Read status',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    const store = new HeadquarterStore(db);
    store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: ['repo.read_status'],
      active: true,
    });
    // Give the founder an originate grant and open + claim a task, so the
    // deactivation is genuinely blocked by in-flight work.
    new HumanPrincipalRegistry(db).register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: ['repo.read_status'],
      approvalAuthority: true,
      active: true,
    });
    const ops = new HeadquarterOperations(db, { store });
    const created = ops.createTask({
      capabilityId: 'repo.read_status',
      payload: { kind: 'status' },
      requestedBy: 'founder',
    });
    expect(created.ok).toBe(true);
    expect(ops.claimNext('claude', 'repo.read_status').ok).toBe(true);

    const blocked = executeWorkforceCommand(
      ['--deactivate-worker', 'claude', '--as', 'founder', '--reason', 'mid-flight'],
      openDb,
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.lines.join('\n')).toContain('replacement_blocked');

    // Complete the read-only task; deactivation then succeeds.
    const task = ops.queue.listByStatus('assigned')[0]!;
    expect(ops.startTask(task.id, 'claude', task.fence).ok).toBe(true);
    const running = ops.queue.get(task.id)!;
    expect(ops.submitResult(task.id, 'claude', running.fence, { done: true }).ok).toBe(true);
    const deactivated = executeWorkforceCommand(
      ['--deactivate-worker', 'claude', '--as', 'founder', '--reason', 'lane closed'],
      openDb,
    );
    expect(deactivated.ok).toBe(true);
    expect(deactivated.lines.join('\n')).toContain('no reactivate action');
    expect(store.getSpecialist('claude')!.active).toBe(false);
  });
});
