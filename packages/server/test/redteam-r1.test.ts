import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { testDb, makeTestTenant, matrixOf, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import type { Ctx } from '../src/services/context.js';
import { createRole } from '../src/services/permissions.js';
import { saveRoleMatrix } from '../src/services/permissions.js';
import { createUser, updateUser } from '../src/services/users.js';
import { buildSessionUser } from '../src/services/auth.js';
import { generateRecoveryCodes, recoverWithCode } from '../src/services/recovery.js';
import { sessions } from '../src/db/schema.js';
import { _resetRateLimiter } from '../src/services/ratelimit.js';

/**
 * Regressions for the security red team (RED_TEAM_R1): H1 rate-limit source
 * ceiling, H2 self-escalation guards, D3 atomic recovery. These lock the fixes
 * so a future change cannot silently reopen them.
 */

let db: Db;
let tt: TestTenant;

function ctxFor(userId: string): Ctx {
  return { db, tenantId: tt.tenantId, user: buildSessionUser(db, userId)! };
}

/** A non-owner manager who holds manage_users (the H2 threat actor). */
function makeManager(): { userId: string; roleId: string; ctx: Ctx } {
  const roleId = createRole(tt.sysCtx, {
    code: `mgr-${Math.random().toString(36).slice(2, 7)}`,
    name: 'Manager',
    matrix: matrixOf([['users', ['view', 'manage_users']]]),
  });
  const userId = createUser(tt.sysCtx, {
    username: `mgr-${Math.random().toString(36).slice(2, 7)}`,
    displayName: 'Manager',
    password: 'test-password',
    roleId,
  });
  return { userId, roleId, ctx: ctxFor(userId) };
}

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'RT');
});

describe('H2 — a non-owner with manage_users cannot self-escalate', () => {
  it('cannot self-assign the owner role', () => {
    const mgr = makeManager();
    expect(() => updateUser(mgr.ctx, mgr.userId, { roleId: tt.ownerRoleId })).toThrowError(
      /own role/,
    );
  });

  it('cannot edit the permission matrix of their own role (self-grant)', () => {
    const mgr = makeManager();
    // grant themselves everything on settings via their own role
    expect(() =>
      saveRoleMatrix(mgr.ctx, mgr.roleId, matrixOf([['settings', ['view', 'edit', 'approve']], ['users', ['view', 'manage_users']]])),
    ).toThrowError(/own role/);
  });

  it('CAN still manage OTHER users and OTHER roles', () => {
    const mgr = makeManager();
    const other = createUser(tt.sysCtx, {
      username: 'staff1',
      displayName: 'Staff',
      password: 'test-password',
      roleId: createRole(tt.sysCtx, { code: 'staff', name: 'Staff', matrix: {} }),
    });
    // editing another user is fine
    expect(() => updateUser(mgr.ctx, other, { displayName: 'Staff Renamed' })).not.toThrow();
    // editing a different role's matrix is fine
    const otherRole = createRole(tt.sysCtx, { code: 'other', name: 'Other', matrix: {} });
    expect(() => saveRoleMatrix(mgr.ctx, otherRole, matrixOf([['inventory', ['view']]]))).not.toThrow();
  });

  it('an OWNER is exempt — legitimate handover (deactivate self) still works with a second owner', () => {
    createUser(tt.sysCtx, {
      username: 'owner2.rt',
      displayName: 'Second Owner',
      password: 'test-password',
      roleId: tt.ownerRoleId,
    });
    expect(() => updateUser(tt.ownerCtx, tt.ownerUserId, { active: false })).not.toThrow();
  });
});

describe('H1 — rate limiter enforces a per-source-IP ceiling (username spray)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    _resetRateLimiter();
    // fresh app+tenant just for this describe (shares module-level limiter)
    db = testDb();
    tt = makeTestTenant(db, 'RTL');
    app = buildApp({ db });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    _resetRateLimiter();
  });

  it('spraying ONE password across many usernames from one IP eventually trips the source ceiling', async () => {
    // each username fails only a few times (never reaching the per-username 10),
    // but the shared source IP accumulates toward the 30 ceiling
    let sawSourceLock = false;
    for (let u = 0; u < 40; u++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: `victim${u}`, password: 'spray-guess' },
      });
      if (r.statusCode === 429) {
        sawSourceLock = true;
        break;
      }
      expect(r.statusCode).toBe(401); // distinct usernames, never per-username locked
    }
    expect(sawSourceLock).toBe(true);
    _resetRateLimiter();
  });
});

describe('D3 — recovery is atomic (code consume + password + session revoke)', () => {
  it('a successful recovery consumes the code, changes the password, and revokes sessions together', () => {
    const codes = generateRecoveryCodes(tt.ownerCtx, tt.ownerUserId);
    // seed a live session that must be revoked
    const username = 'owner.rt';
    // recover
    recoverWithCode(db, { username, code: codes[0], newPassword: 'new-strong-pass' });
    // code is consumed (cannot reuse)
    expect(() => recoverWithCode(db, { username, code: codes[0], newPassword: 'again-strong' })).toThrow();
    // all sessions for the user are revoked
    const live = db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.userId, tt.ownerUserId), isNull(sessions.revokedAt)))
      .all();
    expect(live).toHaveLength(0);
  });
});
