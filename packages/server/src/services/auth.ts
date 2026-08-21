import { and, eq } from 'drizzle-orm';
import type { SessionUser } from '@factoryos/shared';
import type { Db } from '../db/index.js';
import { roles, sessions, tenants, users } from '../db/schema.js';
import { newId, nowIso, randomToken, verifyPassword, AppError } from '../util.js';
import { getRoleMatrix } from './permissions.js';
import { writeAudit } from './audit.js';
import type { Ctx } from './context.js';

const SESSION_HOURS = 12;
const SESSION_HOURS_REMEMBER = 24 * 30;

export interface LoginResult {
  token: string;
  user: SessionUser;
  expiresAt: string;
}

export function login(
  db: Db,
  input: {
    username: string;
    password: string;
    tenantCode?: string;
    remember?: boolean;
    userAgent?: string;
  },
): LoginResult {
  const candidates = db
    .select()
    .from(users)
    .where(eq(users.username, input.username.trim().toLowerCase()))
    .all();
  // Disambiguation is by tenant CODE ('mesob'), which must be resolved to the
  // tenant's id before matching — comparing the code against the UUID directly
  // (the old bug, D4) could never match and locked out shared usernames.
  const tenantScope = input.tenantCode
    ? db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, input.tenantCode)).get()?.id
    : undefined;
  const user =
    candidates.length === 1
      ? tenantScope && candidates[0].tenantId !== tenantScope
        ? undefined
        : candidates[0]
      : candidates.find((u) => u.tenantId === tenantScope);

  const fail = (reason: string): AppError => {
    if (user) {
      const ctx: Ctx = { db, tenantId: user.tenantId, user: null };
      writeAudit(ctx, {
        module: 'users',
        action: 'login_failed',
        entity: 'user',
        entityId: user.id,
        summary: `Failed sign-in for '${input.username}' (${reason})`,
        result: 'blocked',
      });
    }
    return new AppError(401, 'invalid_credentials', 'Invalid username or password');
  };

  if (!user) throw fail('unknown user');
  if (!user.active) throw fail('inactive account');
  if (!verifyPassword(input.password, user.passwordHash)) throw fail('wrong password');

  const hours = input.remember ? SESSION_HOURS_REMEMBER : SESSION_HOURS;
  const token = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + hours * 3600_000).toISOString();
  db.insert(sessions)
    .values({
      id: newId(),
      tenantId: user.tenantId,
      userId: user.id,
      token,
      createdAt: now.toISOString(),
      expiresAt,
      userAgent: input.userAgent ?? null,
    })
    .run();
  db.update(users).set({ lastLoginAt: now.toISOString() }).where(eq(users.id, user.id)).run();

  const sessionUser = buildSessionUser(db, user.id)!;
  const ctx: Ctx = { db, tenantId: user.tenantId, user: sessionUser };
  writeAudit(ctx, {
    module: 'users',
    action: 'login',
    entity: 'user',
    entityId: user.id,
    summary: `${user.displayName} signed in`,
  });
  return { token, user: sessionUser, expiresAt };
}

export function logout(db: Db, token: string): void {
  const session = db.select().from(sessions).where(eq(sessions.token, token)).get();
  if (!session || session.revokedAt) return;
  db.update(sessions).set({ revokedAt: nowIso() }).where(eq(sessions.id, session.id)).run();
  const user = buildSessionUser(db, session.userId);
  if (user) {
    writeAudit(
      { db, tenantId: session.tenantId, user },
      {
        module: 'users',
        action: 'logout',
        entity: 'user',
        entityId: session.userId,
        summary: `${user.displayName} signed out`,
      },
    );
  }
}

export function resolveSession(db: Db, token: string): SessionUser | null {
  const session = db.select().from(sessions).where(eq(sessions.token, token)).get();
  if (!session || session.revokedAt) return null;
  if (session.expiresAt < nowIso()) return null;
  const user = buildSessionUser(db, session.userId);
  if (!user) return null;
  return user;
}

/** Load user + role + latest permission matrix. Permissions re-evaluate on every request. */
export function buildSessionUser(db: Db, userId: string): SessionUser | null {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || !user.active) return null;
  const role = db
    .select()
    .from(roles)
    .where(and(eq(roles.tenantId, user.tenantId), eq(roles.id, user.roleId)))
    .get();
  if (!role) return null;
  const ctx: Ctx = { db, tenantId: user.tenantId, user: null };
  return {
    id: user.id,
    tenantId: user.tenantId,
    username: user.username,
    displayName: user.displayName,
    roleId: role.id,
    roleName: role.name,
    permissions: getRoleMatrix(ctx, role.id),
    language: user.language,
    theme: (user.theme as 'light' | 'dark' | 'system') ?? 'system',
  };
}
