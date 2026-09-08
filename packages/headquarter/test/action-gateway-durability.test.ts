/**
 * Phase 8 — the action ledger survives a real close-and-reopen of the
 * canonical database file, and a read-only handle over a pre-Phase-8 file
 * observes absence truthfully instead of migrating.
 *
 * A FILE database, not `:memory:`: the property under test is that an
 * unknown external outcome, its reserved side-effect key and every refusal
 * that depends on them are derived identically by a brand-new service
 * instance after the first connection is fully closed — the restart is
 * exactly when a lost attempt would otherwise be retried.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openHqDatabase, openHqDatabaseReadOnly } from '../src/store/db.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import {
  actionGatewaySchemaPresent,
  ensureActionGatewaySchema,
  sideEffectHolder,
} from '../src/application/action-gateway.js';
import { expectOk } from './application.fixture.js';
import { fakeAdapter, type FakeAdapter } from './action-gateway.fixture.js';

const FOUNDER = 'durability-founder';
const COO = 'durability-coo';
const CAP = 'archive.index_document';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function openOps(path: string, adapter: FakeAdapter) {
  const db = openHqDatabase(path);
  const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db), actionAdapters: [adapter] });
  return { ops, db, close: () => db.close() };
}

function configure(path: string): void {
  const configDb = openHqDatabase(path);
  new CapabilityRegistry(configDb).register({
    id: CAP,
    description: 'Index a document into the archive',
    riskClass: 'external_side_effect',
    sideEffect: true,
    idempotent: false,
  });
  const principals = new HumanPrincipalRegistry(configDb);
  principals.register({ id: FOUNDER, displayName: 'F', originateCapabilities: [CAP], approvalAuthority: true, active: true });
  principals.register({ id: COO, displayName: 'C', originateCapabilities: [], approvalAuthority: true, active: true });
  new HeadquarterStore(configDb).upsertSpecialist({
    id: 'claude',
    displayName: 'Claude',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: [CAP],
    active: true,
  });
  configDb.close();
}

describe('the action ledger across a full close and reopen', () => {
  it('an unknown outcome is still unknown after restart: no retry, identical refusals, then a human reconciles', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-action-durability-'));
    const path = join(dir, 'headquarter.sqlite');
    configure(path);

    const first = fakeAdapter({ mode: 'unknown' });
    const writer = openOps(path, first);
    const task = expectOk(
      writer.ops.createTask({ capabilityId: CAP, payload: { document: 'd' }, idempotencyKey: 'dur-1', requestedBy: 'claude' }),
    ).task;
    expectOk(writer.ops.approveTask({ taskId: task.id, founderId: COO, expectedActionDigest: taskActionDigest(task) }));
    const claimed = expectOk(writer.ops.claimNext('claude', CAP));
    expectOk(writer.ops.startTask(task.id, 'claude', claimed.fence));
    const action = expectOk(
      writer.ops.proposeAction({
        taskId: task.id,
        adapterId: 'fake.local',
        actionType: 'post_comment',
        target: 'issue/1',
        payload: { text: 'x' },
        requestedBy: FOUNDER,
      }),
    ).action;
    expectOk(writer.ops.authorizeAction({ actionId: action.id, workerId: 'claude', fence: claimed.fence }));
    const executed = expectOk(writer.ops.executeAction({ actionId: action.id, workerId: 'claude', fence: claimed.fence }));
    expect(executed.outcome).toBe('outcome_unknown');
    const before = writer.ops.getAction(action.id)!;
    const listBefore = writer.ops.listActions();
    writer.close();

    // Session two: a brand-new service instance, a fresh adapter that would succeed if called.
    const second = fakeAdapter({ mode: 'succeed' });
    const reader = openOps(path, second);
    expect(reader.ops.actionStorePresent()).toBe(true);
    const after = reader.ops.getAction(action.id)!;
    expect(after).toEqual(before);
    expect(reader.ops.listActions()).toEqual(listBefore);
    expect(after.state).toBe('outcome_unknown');
    expect(after.retryBlocked).toBe(true);
    // The side-effect key survived with the attempt that holds it.
    expect(sideEffectHolder(reader.db, `${(reader.db.prepare(`SELECT side_effect_key_base AS b FROM hq_action_intents WHERE id = ?`).get(action.id) as { b: string }).b}#1`))
      .toMatchObject({ actionId: action.id });
    // No automatic retry after the restart — the exact failure mode a restart invites.
    const retry = reader.ops.executeAction({ actionId: action.id, workerId: 'claude', fence: claimed.fence });
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe('action_outcome_unknown');
    expect(second.calls).toHaveLength(0);
    // A duplicate proposal dedupes onto the unknown action; a different action for the same effect is blocked too.
    const dup = expectOk(
      reader.ops.proposeAction({
        taskId: task.id,
        adapterId: 'fake.local',
        actionType: 'post_comment',
        target: 'issue/1',
        payload: { text: 'x' },
        requestedBy: FOUNDER,
      }),
    );
    expect(dup.deduplicated).toBe(true);
    // The rules refuse identically: the proposer cannot reconcile; a non-idempotent effect cannot be reopened.
    const self = reader.ops.reconcileAction({ actionId: action.id, decision: 'confirmed_failed', note: 'checked', requestedBy: FOUNDER });
    expect(self.ok).toBe(false);
    const reopen = reader.ops.reconcileAction({ actionId: action.id, decision: 'confirmed_not_executed', note: 'checked', requestedBy: COO });
    expect(reopen.ok).toBe(false);
    const reconciled = expectOk(
      reader.ops.reconcileAction({ actionId: action.id, decision: 'confirmed_succeeded', note: 'Found the comment on the remote.', requestedBy: COO }),
    ).action;
    expect(reconciled.state).toBe('reconciled');
    expect(reader.ops.gatewayActionHistory(task.id)).toEqual({ state: 'succeeded', actionId: action.id });
    expect(reader.ops.queue.evidence.verifyChain()).toBeNull();
    expect((reader.db.prepare(`SELECT COUNT(*) AS n FROM hq_action_events`).get() as { n: number }).n).toBe(5);
    reader.close();
  });

  it('a read-only handle over a pre-Phase-8 file observes absence; nothing is migrated', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-action-readonly-'));
    const path = join(dir, 'headquarter.sqlite');
    const writer = openHqDatabase(path);
    void new HeadquarterOperations(writer, {});
    writer.exec(`DROP TABLE IF EXISTS hq_action_events; DROP TABLE IF EXISTS hq_action_intents;`);
    writer.close();

    const readOnly = openHqDatabaseReadOnly(path);
    expect(() => ensureActionGatewaySchema(readOnly)).not.toThrow();
    expect(actionGatewaySchemaPresent(readOnly)).toBe(false);
    const ops = new HeadquarterOperations(readOnly, {});
    expect(ops.actionStorePresent()).toBe(false);
    expect(ops.listActions()).toEqual([]);
    expect(ops.getAction('anything')).toBeNull();
    expect(ops.gatewayActionHistory('anything')).toEqual({ state: 'none' });
    readOnly.close();

    const check = openHqDatabase(path);
    expect(check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_action_intents'`).get()).toBeUndefined();
    check.close();
  });
});

/**
 * Wave 5, correction round fourteen — Medium 3: a reader that RAISES on content
 * a raw writer can put in a JSON column.
 *
 * `rowToIntent` and `rowToEvent` called `JSON.parse` on six and one column and
 * let the `SyntaxError` out. Executed at the merged head `8481269`: ONE
 * permitted `INSERT` into `hq_action_intents` carrying non-JSON in a JSON column
 * made `hqReliabilityPosture()` — the Founder console's own reader — throw
 * `SyntaxError: Unexpected token 'o' … is not valid JSON` instead of refusing.
 * `assessHqIntegrity` still answered, so it is a console denial rather than a
 * latch bypass; it is the same class the commitment columns closed in round
 * twelve ("this reader must not raise on any content a raw writer can put in
 * the column"), simply not applied here.
 *
 * The row is a PERMITTED append — no trigger dropped, no DDL — which is why the
 * answer is at the reader rather than at a guard.
 */
describe('the action-intent reader is total over anything a raw writer can store', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to raise on non-JSON in any JSON column, and the console still answers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-action-total-'));
    dirs.push(dir);
    const dbPath = join(dir, 'headquarter.sqlite');
    const db = openHqDatabase(dbPath);
    try {
      const store = new HeadquarterStore(db);
      const ops = new HeadquarterOperations(db, { store });
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      ensureActionGatewaySchema(db);

      const raw = db as unknown as import('better-sqlite3').Database;
      const columns = (raw.prepare(`PRAGMA table_info(hq_action_intents)`).all() as {
        name: string;
        type: string;
        pk: number;
      }[]).filter((column) => column.pk === 0);
      expect(columns.length).toBeGreaterThan(0);
      // Every column gets the same unparseable text — the JSON ones included.
      // The write is PERMITTED: nothing is dropped and no rowid is chosen.
      raw
        .prepare(
          `INSERT INTO hq_action_intents (${columns.map((c) => `"${c.name}"`).join(', ')})
           VALUES (${columns.map(() => '?').join(', ')})`,
        )
        .run(
          columns.map((column) =>
            String(column.type).toUpperCase().includes('INT')
              ? (0 as never)
              : ('not json at all {' as never),
          ),
        );

      // The console answers instead of throwing, which is the whole finding.
      expect(ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      // `assessHqIntegrity` is gated on the reliability grant, which this bare
      // fixture does not hold — so what is asserted is that it ANSWERS with its
      // own refusal rather than raising the driver's parse error.
      const assessed = ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(typeof assessed.ok, 'it must ANSWER rather than raise').toBe('boolean');
      // And a reader that reaches the row itself gets the EMPTY value of the
      // shape it expects rather than a raise — the fail-safe direction, since an
      // intent whose payload reads as `{}` no longer matches its own stored
      // digest.
      const listed = ops.listActionsBounded();
      const planted = listed.actions.find((action) => action.id === 'not json at all {');
      expect(planted, 'the planted row must be readable rather than fatal').toBeDefined();
      expect(planted!.riskFactors, 'an unreadable array column reads as empty').toEqual([]);
      expect(planted!.contextEvidenceRefs).toEqual([]);
      expect(planted!.contextTruthRefs).toEqual([]);
      expect(planted!.compensation, 'an unreadable compensation is no compensation').toBeNull();
    } finally {
      db.close();
    }
  });
});
