import crypto from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { recoveryCodes, sessions, tenants, users } from '../db/schema.js';
import { newId, nowIso, hashPassword, badRequest, AppError } from '../util.js';
import type { Ctx } from './context.js';
import { actorId } from './context.js';
import { writeAudit } from './audit.js';

/**
 * Owner emergency recovery — offline, local, no paid services and no
 * universal password. Codes are generated in a batch, shown exactly once,
 * and stored only as SHA-256 hashes. Using one resets the password in the
 * same step (the forced change), consumes the code, and writes a permanent
 * security audit event. Email/SMS OTP can plug in later as an adapter; the
 * code path here never depends on external services.
 */

const CODE_COUNT = 8;

function formatCode(): string {
  // XXXX-XXXX-XXXX from an unambiguous alphabet (no 0/O/1/I)
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const raw = crypto.randomBytes(12);
  const chars = [...raw].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8, 12).join('')}`;
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

/**
 * Generate a fresh batch of recovery codes for a user. All previously unused
 * codes are revoked so exactly one batch is ever valid. Returns the plaintext
 * codes ONCE — they are never stored or retrievable again.
 */
export function generateRecoveryCodes(ctx: Ctx, userId: string): string[] {
  const user = ctx.db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, userId)))
    .get();
  if (!user) badRequest('user_missing', 'User not found');
  const now = nowIso();
  ctx.db
    .update(recoveryCodes)
    .set({ revokedAt: now })
    .where(
      and(
        eq(recoveryCodes.tenantId, ctx.tenantId),
        eq(recoveryCodes.userId, userId),
        isNull(recoveryCodes.usedAt),
        isNull(recoveryCodes.revokedAt),
      ),
    )
    .run();
  const codes: string[] = [];
  for (let i = 0; i < CODE_COUNT; i++) {
    const code = formatCode();
    codes.push(code);
    ctx.db
      .insert(recoveryCodes)
      .values({
        id: newId(),
        tenantId: ctx.tenantId,
        userId,
        codeHash: hashCode(code),
        createdBy: actorId(ctx),
        createdAt: now,
      })
      .run();
  }
  writeAudit(ctx, {
    module: 'users',
    action: 'recovery_codes_generate',
    entity: 'user',
    entityId: userId,
    reference: user.username,
    summary: `${CODE_COUNT} emergency recovery codes issued for '${user.displayName}' (previous unused codes revoked)`,
  });
  return codes;
}

/**
 * Public recovery: username + one unused code + the new password. The old
 * password is never revealed; the used code is consumed immediately.
 */
export function recoverWithCode(
  db: Db,
  input: { username: string; code: string; newPassword: string; tenantCode?: string },
): void {
  // Input validation happens BEFORE any account lookup so the response can
  // never become a username-existence oracle (same 400 for everyone).
  if (!input.newPassword || input.newPassword.length < 6) {
    badRequest('password_weak', 'New password must be at least 6 characters');
  }
  // Multi-tenant boxes disambiguate by tenant CODE resolved to its id; a shared
  // username with no disambiguator fails closed rather than picking a tenant.
  const candidates = db
    .select()
    .from(users)
    .where(eq(users.username, input.username.trim().toLowerCase()))
    .all();
  const tenantScope = input.tenantCode
    ? db.select({ id: tenants.id }).from(tenants).where(eq(tenants.code, input.tenantCode)).get()?.id
    : undefined;
  const user =
    candidates.length === 1
      ? tenantScope && candidates[0].tenantId !== tenantScope
        ? undefined
        : candidates[0]
      : candidates.find((u) => u.tenantId === tenantScope);
  const fail = (): never => {
    if (user) {
      writeAudit(
        { db, tenantId: user.tenantId, user: null },
        {
          module: 'users',
          action: 'recovery_failed',
          entity: 'user',
          entityId: user.id,
          summary: `Failed recovery attempt for '${input.username}'`,
          result: 'blocked',
        },
      );
    }
    throw new AppError(401, 'recovery_invalid', 'Invalid username or recovery code');
  };
  if (!user || !user.active) fail();
  const match = db
    .select()
    .from(recoveryCodes)
    .where(
      and(
        eq(recoveryCodes.tenantId, user!.tenantId),
        eq(recoveryCodes.userId, user!.id),
        eq(recoveryCodes.codeHash, hashCode(input.code)),
        isNull(recoveryCodes.usedAt),
        isNull(recoveryCodes.revokedAt),
      ),
    )
    .get();
  if (!match) fail();
  const now = nowIso();
  db.update(recoveryCodes).set({ usedAt: now }).where(eq(recoveryCodes.id, match!.id)).run();
  db.update(users).set({ passwordHash: hashPassword(input.newPassword) }).where(eq(users.id, user!.id)).run();
  // every previously authenticated session is invalidated immediately
  db.update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, user!.id), isNull(sessions.revokedAt)))
    .run();
  writeAudit(
    { db, tenantId: user!.tenantId, user: null },
    {
      module: 'users',
      action: 'recovery_used',
      entity: 'user',
      entityId: user!.id,
      reference: user!.username,
      summary: `Emergency recovery code used for '${user!.displayName}' — password changed, code consumed`,
    },
  );
}

/** Count of currently valid (unused, unrevoked) codes — for the settings UI. */
export function countActiveRecoveryCodes(ctx: Ctx, userId: string): number {
  return ctx.db
    .select({ id: recoveryCodes.id })
    .from(recoveryCodes)
    .where(
      and(
        eq(recoveryCodes.tenantId, ctx.tenantId),
        eq(recoveryCodes.userId, userId),
        isNull(recoveryCodes.usedAt),
        isNull(recoveryCodes.revokedAt),
      ),
    )
    .all().length;
}
