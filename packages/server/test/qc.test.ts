import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Db } from '../src/db/index.js';
import { testDb, makeTestTenant, makeProcessStages, matrixOf, type TestTenant } from './helpers.js';
import { createRole } from '../src/services/permissions.js';
import { createUser } from '../src/services/users.js';
import { createParty } from '../src/services/parties.js';
import { saveSettings, getSettings } from '../src/services/settings.js';
import { createReceipt, postReceipt, getReceipt } from '../src/services/receiving.js';
import { createBatch, completeBatch, getBatch, listQualityTests } from '../src/services/batches.js';
import { listAudit } from '../src/services/audit.js';
import { nowIso } from '../src/util.js';

/**
 * QC role split and release gate (Mesob business rule):
 *  - Production Operator records iodization but can NEITHER record QC tests
 *    NOR release batches.
 *  - Quality Management records tests/retests and performs the explicit
 *    Approve & Release; only released batches are packagable.
 *  - Failed results are immutable; retests are new linked records.
 *  - The configured target ppm is preserved on each recorded test.
 */

const TODAY = nowIso().slice(0, 10);

let db: Db;
let tt: TestTenant;
let other: TestTenant;
let app: FastifyInstance;
let iodId: string;
const cookies: Record<string, string> = {};

async function login(username: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'test-password' },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers['set-cookie'];
  cookies[username] = (Array.isArray(setCookie) ? setCookie[0] : setCookie!).split(';')[0];
}

async function call(user: string, method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({ method, url, payload: payload as object, headers: { cookie: cookies[user] } });
}

async function ok(user: string, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await call(user, method, url, payload);
  expect(res.statusCode, `${method} ${url} -> ${res.body}`).toBe(200);
  return res.json();
}

beforeAll(async () => {
  db = testDb();
  tt = makeTestTenant(db, 'QCA');
  other = makeTestTenant(db, 'QCB');
  makeProcessStages(tt);

  // configurable quality target (Mesob pattern)
  saveSettings(tt.sysCtx, 'production', { iodization: { targetPpm: '30-40 ppm' } });

  // Mesob-style role split
  const operatorRole = createRole(tt.sysCtx, {
    code: 'production',
    name: 'Production Operator',
    matrix: matrixOf([
      ['dashboard', ['view']],
      ['inventory', ['view']],
      ['production', ['view', 'create', 'edit']],
      ['quality', ['view']], // may see results, never record or release
      ['reports', ['view']],
    ]),
  });
  const qualityRole = createRole(tt.sysCtx, {
    code: 'quality',
    name: 'Quality Management',
    matrix: matrixOf([
      ['dashboard', ['view']],
      ['inventory', ['view']],
      ['production', ['view']],
      ['quality', ['view', 'create', 'edit', 'approve', 'export']],
      ['reports', ['view', 'export']],
    ]),
  });
  createUser(tt.sysCtx, {
    username: 'operator.qc',
    displayName: 'Production Operator',
    password: 'test-password',
    roleId: operatorRole,
  });
  createUser(tt.sysCtx, {
    username: 'quality.qc',
    displayName: 'Quality Manager',
    password: 'test-password',
    roleId: qualityRole,
  });

  // washed material to iodize
  const supplierId = createParty(tt.ownerCtx, { kind: 'supplier', name: 'Supplier' });
  const { id: rcv } = createReceipt(tt.ownerCtx, {
    supplierId,
    date: TODAY,
    itemId: tt.items.raw,
    entryUomId: tt.uoms.kg,
    netQty: 5000,
    warehouseId: tt.warehouses.a,
    truckNumber: 'T1',
    driverName: 'D1',
  });
  postReceipt(tt.ownerCtx, rcv);
  const lotId = getReceipt(tt.ownerCtx, rcv).lotId!;
  const { id: washId } = createBatch(tt.ownerCtx, {
    stageCode: 'washing',
    date: TODAY,
    inputLotId: lotId,
    inputWarehouseId: tt.warehouses.a,
    inputQty: 5000,
    inputUomId: tt.uoms.kg,
  });
  completeBatch(tt.ownerCtx, washId, { outputQty: 4600 });

  app = buildApp({ db });
  await app.ready();
  await login('operator.qc');
  await login('quality.qc');
  await login(`owner.${'QCA'.toLowerCase()}`);

  // the operator records the iodization itself (allowed)
  const created = await ok('operator.qc', 'POST', '/api/batches', {
    stageCode: 'iodization',
    date: TODAY,
    inputBatchId: washId,
    inputBatchQty: 4600,
    attributes: { iodine_added_kg: 0.21 },
  });
  iodId = created.id;
  await ok('operator.qc', 'POST', `/api/batches/${iodId}/complete`, {});
});

afterAll(async () => {
  await app.close();
});

describe('QC role split', () => {
  it('production operator cannot record a QC test', async () => {
    const res = await call('operator.qc', 'POST', `/api/batches/${iodId}/qc-test`, {
      actualResult: '35 ppm',
      status: 'passed',
      date: TODAY,
    });
    expect(res.statusCode).toBe(403);
  });

  it('production operator cannot approve/release', async () => {
    const res = await call('operator.qc', 'POST', `/api/batches/${iodId}/qc-approve`);
    expect(res.statusCode).toBe(403);
  });

  it('operator still sees the batch and its QC state', async () => {
    const detail = await ok('operator.qc', 'GET', `/api/batches/${iodId}`);
    expect(detail.batch.qcStatus).toBe('pending');
  });
});

describe('fail → blocked → retest → pass → release gate', () => {
  it('quality management records a FAILED test with the configured target', async () => {
    await ok('quality.qc', 'POST', `/api/batches/${iodId}/qc-test`, {
      targetLevel: '30-40 ppm',
      actualResult: '22 ppm',
      status: 'failed',
      operatorName: 'Quality Manager',
      date: TODAY,
    });
    expect(getBatch(tt.ownerCtx, iodId).qcStatus).toBe('failed');
  });

  it('failed batch is not selectable for packaging and cannot be consumed', async () => {
    const sources = await ok('quality.qc', 'GET', '/api/production/sources?forStage=packaging');
    expect(sources.length).toBe(0);
    const res = await call('owner.qca', 'POST', '/api/batches', {
      stageCode: 'packaging',
      date: TODAY,
      inputBatchId: iodId,
      inputBatchQty: 1000,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/quality/i);
  });

  it('retest creates a second linked record; the failed original is untouched', async () => {
    await ok('quality.qc', 'POST', `/api/batches/${iodId}/qc-test`, {
      targetLevel: '30-40 ppm',
      actualResult: '34 ppm',
      status: 'passed',
      operatorName: 'Quality Manager',
      date: TODAY,
    });
    const tests = listQualityTests(tt.ownerCtx, iodId); // newest first
    expect(tests.length).toBe(2);
    expect(tests[1].attemptNumber).toBe(1);
    expect(tests[1].status).toBe('failed');
    expect(tests[1].actualResult).toBe('22 ppm');
    expect(tests[0].attemptNumber).toBe(2);
    expect(tests[0].status).toBe('passed');
    expect(tests[0].previousTestId).toBe(tests[1].id);
  });

  it('a passed test WITHOUT release still blocks packaging', async () => {
    expect(getBatch(tt.ownerCtx, iodId).qcStatus).toBe('passed_pending_release');
    const sources = await ok('quality.qc', 'GET', '/api/production/sources?forStage=packaging');
    expect(sources.length).toBe(0);
    const res = await call('owner.qca', 'POST', '/api/batches', {
      stageCode: 'packaging',
      date: TODAY,
      inputBatchId: iodId,
      inputBatchQty: 1000,
    });
    expect(res.statusCode).toBe(400);
  });

  it('operator still cannot release even after the pass', async () => {
    const res = await call('operator.qc', 'POST', `/api/batches/${iodId}/qc-approve`);
    expect(res.statusCode).toBe(403);
  });

  it('quality management releases; the batch becomes packagable', async () => {
    await ok('quality.qc', 'POST', `/api/batches/${iodId}/qc-approve`);
    const batch = getBatch(tt.ownerCtx, iodId);
    expect(batch.qcStatus).toBe('passed');
    expect(batch.qcApprovedAt).toBeTruthy();
    const sources = await ok('quality.qc', 'GET', '/api/production/sources?forStage=packaging');
    expect(sources.map((s: { id: string }) => s.id)).toContain(iodId);
    // and a packaging draft can now consume it
    const created = await call('owner.qca', 'POST', '/api/batches', {
      stageCode: 'packaging',
      date: TODAY,
      inputBatchId: iodId,
      inputBatchQty: 1000,
    });
    expect(created.statusCode).toBe(200);
  });

  it('every QC action produced an audit event', () => {
    expect(listAudit(tt.ownerCtx, { action: 'qc_test', entityId: iodId }).count).toBe(2);
    expect(listAudit(tt.ownerCtx, { action: 'qc_approve', entityId: iodId }).count).toBe(1);
  });
});

describe('target configuration and tenant isolation', () => {
  it('recorded tests keep their target even after the configuration changes', () => {
    saveSettings(tt.ownerCtx, 'production', { iodization: { targetPpm: '25-35 ppm' } });
    const latest = getSettings<{ iodization: { targetPpm: string } }>(tt.ownerCtx, 'production');
    expect(latest?.data.iodization.targetPpm).toBe('25-35 ppm');
    const tests = listQualityTests(tt.ownerCtx, iodId);
    for (const test of tests) expect(test.targetLevel).toBe('30-40 ppm');
  });

  it('QC data is invisible to another tenant', () => {
    expect(() => getBatch(other.ownerCtx, iodId)).toThrow();
    expect(listQualityTests(other.ownerCtx, iodId).length).toBe(0);
    expect(listAudit(other.ownerCtx, { action: 'qc_test' }).count).toBe(0);
  });
});
