import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { testDb, makeTestTenant, matrixOf, type TestTenant } from './helpers.js';
import { login, logout, resolveSession, buildSessionUser } from '../src/services/auth.js';
import { createRole, saveRoleMatrix, requirePermission, getRoleMatrix } from '../src/services/permissions.js';
import { createUser, updateUser } from '../src/services/users.js';
import { nextDocNumber, defineSequence } from '../src/services/numbering.js';
import { getSettings, saveSettings, getSettingsVersion } from '../src/services/settings.js';
import {
  registerTranslationKeys,
  getBundle,
  upsertTranslation,
  enableLanguage,
} from '../src/services/translations.js';
import { listItems } from '../src/services/masterdata.js';
import { listParties, createParty } from '../src/services/parties.js';
import { listAudit } from '../src/services/audit.js';
import type { Ctx } from '../src/services/context.js';
import { AppError } from '../src/util.js';

let db: Db;
let saltA: TestTenant;
let saltB: TestTenant;

beforeEach(() => {
  db = testDb();
  saltA = makeTestTenant(db, 'SALTA');
  saltB = makeTestTenant(db, 'SALTB');
});

describe('tenant isolation', () => {
  it('items of one tenant are invisible to the other', () => {
    expect(listItems(saltA.ownerCtx).length).toBe(2);
    expect(listItems(saltB.ownerCtx).length).toBe(2);
    const aCodes = listItems(saltA.ownerCtx).map((i) => i.id);
    const bCodes = listItems(saltB.ownerCtx).map((i) => i.id);
    expect(aCodes.filter((id) => bCodes.includes(id))).toEqual([]);
  });

  it('parties do not leak across tenants', () => {
    createParty(saltA.ownerCtx, { kind: 'customer', name: 'Customer A' });
    expect(listParties(saltA.ownerCtx).length).toBe(1);
    expect(listParties(saltB.ownerCtx).length).toBe(0);
  });

  it('document numbering is independent per tenant', () => {
    expect(nextDocNumber(saltA.ownerCtx, 'invoice')).toBe('INV-0001');
    expect(nextDocNumber(saltB.ownerCtx, 'invoice')).toBe('INV-0001');
    expect(nextDocNumber(saltA.ownerCtx, 'invoice')).toBe('INV-0002');
  });

  it('audit events stay inside their tenant', () => {
    createParty(saltA.ownerCtx, { kind: 'customer', name: 'Audited Customer' });
    const inA = listAudit(saltA.ownerCtx, { action: 'party_create' });
    const inB = listAudit(saltB.ownerCtx, { action: 'party_create' });
    expect(inA.count).toBe(1);
    expect(inB.count).toBe(0);
  });
});

describe('authentication and sessions', () => {
  it('logs in with correct credentials and resolves the session', () => {
    const result = login(db, { username: 'owner.salta', password: 'test-password' });
    expect(result.user.tenantId).toBe(saltA.tenantId);
    const resolved = resolveSession(db, result.token);
    expect(resolved?.id).toBe(saltA.ownerUserId);
  });

  it('rejects wrong password and inactive users', () => {
    expect(() => login(db, { username: 'owner.salta', password: 'wrong' })).toThrow(AppError);
    // create a second owner so we can deactivate the first
    const secondId = createUser(saltA.ownerCtx, {
      username: 'owner2.salta',
      displayName: 'Second Owner',
      password: 'test-password',
      roleId: saltA.ownerRoleId,
    });
    expect(secondId).toBeTruthy();
    updateUser(saltA.ownerCtx, saltA.ownerUserId, { active: false });
    expect(() => login(db, { username: 'owner.salta', password: 'test-password' })).toThrow(
      AppError,
    );
  });

  it('logout revokes the session', () => {
    const result = login(db, { username: 'owner.salta', password: 'test-password' });
    logout(db, result.token);
    expect(resolveSession(db, result.token)).toBeNull();
  });
});

describe('permissions', () => {
  function limitedCtx(tt: TestTenant, matrix = matrixOf([['inventory', ['view']]])): Ctx {
    const roleId = createRole(tt.sysCtx, {
      code: `limited-${Math.random().toString(36).slice(2, 7)}`,
      name: 'Limited',
      matrix,
    });
    const userId = createUser(tt.sysCtx, {
      username: `limited${Math.random().toString(36).slice(2, 7)}`,
      displayName: 'Limited User',
      password: 'test-password',
      roleId,
    });
    return { db: tt.db, tenantId: tt.tenantId, user: buildSessionUser(tt.db, userId) };
  }

  it('blocks actions the role does not have', () => {
    const ctx = limitedCtx(saltA);
    expect(() => requirePermission(ctx, 'inventory', 'view')).not.toThrow();
    expect(() => requirePermission(ctx, 'inventory', 'create')).toThrow(AppError);
    expect(() => requirePermission(ctx, 'payments', 'view')).toThrow(AppError);
    expect(() => requirePermission(ctx, 'sales', 'view_financial')).toThrow(AppError);
  });

  it('matrix edits are versioned and take effect on next evaluation', () => {
    const roleId = createRole(saltA.sysCtx, {
      code: 'evolving',
      name: 'Evolving',
      matrix: matrixOf([['inventory', ['view']]]),
    });
    const v2 = saveRoleMatrix(saltA.ownerCtx, roleId, matrixOf([['inventory', ['view', 'create']]]));
    expect(v2).toBe(2);
    const matrix = getRoleMatrix(saltA.ownerCtx, roleId);
    expect(matrix.inventory?.create).toBe(true);
  });

  it('owner role cannot lose user-management authority', () => {
    expect(() =>
      saveRoleMatrix(saltA.ownerCtx, saltA.ownerRoleId, matrixOf([['inventory', ['view']]])),
    ).toThrow(AppError);
  });

  it('the last active owner cannot be deactivated', () => {
    expect(() => updateUser(saltA.ownerCtx, saltA.ownerUserId, { active: false })).toThrow(
      AppError,
    );
  });
});

describe('document numbering', () => {
  it('produces configured prefix + padded sequence', () => {
    expect(nextDocNumber(saltA.ownerCtx, 'receiving')).toBe('RCV-0001');
    expect(nextDocNumber(saltA.ownerCtx, 'receiving')).toBe('RCV-0002');
  });

  it('prefix can be reconfigured without resetting the counter', () => {
    nextDocNumber(saltA.ownerCtx, 'receiving');
    defineSequence(saltA.ownerCtx, 'receiving', 'REC-', 5);
    expect(nextDocNumber(saltA.ownerCtx, 'receiving')).toBe('REC-00002');
  });

  it('unknown sequences fail loudly', () => {
    expect(() => nextDocNumber(saltA.ownerCtx, 'nope')).toThrow(AppError);
  });
});

describe('versioned settings', () => {
  it('each save creates a new version and history is preserved', () => {
    expect(getSettings(saltA.ownerCtx, 'vat')).toBeNull();
    saveSettings(saltA.ownerCtx, 'vat', { enabled: true, ratePct: 15 });
    saveSettings(saltA.ownerCtx, 'vat', { enabled: true, ratePct: 12 });
    const latest = getSettings<{ ratePct: number }>(saltA.ownerCtx, 'vat');
    expect(latest?.version).toBe(2);
    expect(latest?.data.ratePct).toBe(12);
    const v1 = getSettingsVersion<{ ratePct: number }>(saltA.ownerCtx, 'vat', 1);
    expect(v1?.data.ratePct).toBe(15);
  });

  it('settings are tenant-scoped', () => {
    saveSettings(saltA.ownerCtx, 'vat', { ratePct: 15 });
    expect(getSettings(saltB.ownerCtx, 'vat')).toBeNull();
  });
});

describe('translations', () => {
  it('falls back to English when no override exists', () => {
    registerTranslationKeys(db, [{ key: 'nav.dashboard', en: 'Dashboard', module: 'shell' }]);
    enableLanguage(saltA.ownerCtx, 'am', 'Amharic');
    const bundle = getBundle(saltA.ownerCtx, 'am');
    expect(bundle['nav.dashboard']).toBe('Dashboard');
  });

  it('tenant override wins and stays tenant-scoped', () => {
    registerTranslationKeys(db, [{ key: 'nav.dashboard', en: 'Dashboard', module: 'shell' }]);
    upsertTranslation(saltA.ownerCtx, 'nav.dashboard', 'am', 'ዳሽቦርድ');
    expect(getBundle(saltA.ownerCtx, 'am')['nav.dashboard']).toBe('ዳሽቦርድ');
    expect(getBundle(saltB.ownerCtx, 'am')['nav.dashboard']).toBe('Dashboard');
    // English base is never affected by overrides
    expect(getBundle(saltA.ownerCtx, 'en')['nav.dashboard']).toBe('Dashboard');
  });
});
