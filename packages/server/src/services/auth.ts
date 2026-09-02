import { and, eq } from 'drizzle-orm';
import type { SessionUser } from '@factoryos/shared';
import type { Db } from '../db/index.js';
import { roles, sessions, tenants, users } from '../db/schema.js';
import { newId, nowIso, randomToken, verifyPassword, AppError } from '../util.js';
import { getRoleMatrix } from './permissions.js';
import { writeAudit } from './audit.js';
import type { Ctx } from './context.js';

/**
 * Resolve which candidate account a login/recovery attempt refers to.
 * Disambiguation is by tenant CODE ('mesob') resolved to the tenant id —
 * comparing the code against the UUID directly (the old D4 bug) never
 * matched. FAIL-CLOSED rules: an explicitly supplied tenantCode that does
 * not resolve to a tenant rejects the attempt even for a unique username;
 * a shared username with no (or an unresolved) code matches nothing.
 */
export function resolveUserByTenantCode<T extends { tenantId: string }>(
  db: Db,
  candidates: T[],
  tenantCode: string | undefined,
): T | undefined {
  if (tenantCode !== undefined) {
    const tenant = db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, tenantCode)).get();
    if (!tenant) return undefined; // explicit scope that resolves nowhere: reject
    return candidates.find((u) => u.tenantId === tenant.id);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

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
  const user = resolveUserByTenantCode(db, candidates, input.tenantCode);

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
  return resolveSessionRecord(db, token)?.user ?? null;
}

/**
 * The session behind a token, WITH the timestamps that bound it.
 *
 * `resolveSession` answers "who is this" and is all the tenant app needs.
 * Headquarter's Founder boundary additionally needs to know how OLD the
 * session is, because a long-lived cookie on an unattended machine is not
 * consent to an irreversible action — see `verifyStepUp` in
 * `@factoryos/headquarter`'s `live/auth.ts`.
 *
 * Deliberately the single implementation of session validity, with
 * `resolveSession` delegating to it: expiry and revocation are checked in
 * exactly one place, so the two callers cannot drift into different answers
 * about whether a session is still good.
 */
export interface SessionRecord {
  /**
   * Opaque session id — NOT the token.
   *
   * Added for the HQ sign-in bridge (Phase 2, Stage 2): an HQ session records
   * the identity session it derives from, so signing out here can revoke it
   * there. The id travels; the token never does, so a stolen HQ database yields
   * no usable credential for this server.
   */
  id: string;
  user: SessionUser;
  /** When this session was established. */
  establishedAt: string;
  expiresAt: string;
}

export function resolveSessionRecord(db: Db, token: string): SessionRecord | null {
  const session = db.select().from(sessions).where(eq(sessions.token, token)).get();
  if (!session || session.revokedAt) return null;
  if (session.expiresAt < nowIso()) return null;
  const user = buildSessionUser(db, session.userId);
  if (!user) return null;
  return { id: session.id, user, establishedAt: session.createdAt, expiresAt: session.expiresAt };
}

/**
 * Re-verify a signed-in account's own password, for step-up confirmation.
 *
 * Not a login: it mints no session, extends nothing, and is never reachable
 * without an already-authenticated session — it only answers whether the
 * person at the keyboard still knows the password. A deactivated account
 * fails closed even if its session has not yet expired.
 */
/**
 * The identifier the rate limiter buckets an account's password failures
 * under — the stored username, which `createUser` already lower-cases, so it
 * matches the key `/api/auth/login` builds from the submitted username.
 *
 * It exists so a second password surface can charge the SAME per-account
 * bucket as sign-in rather than opening a parallel one. Returns null for an
 * unknown or deactivated account, so a caller that cannot name a bucket fails
 * closed instead of falling back to an unbudgeted path.
 */
export function accountLoginIdentifier(db: Db, userId: string): string | null {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || !user.active) return null;
  return user.username;
}

export function verifyAccountPassword(db: Db, userId: string, password: string): boolean {
  if (!password) return false;
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || !user.active) return false;
  return verifyPassword(password, user.passwordHash);
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
