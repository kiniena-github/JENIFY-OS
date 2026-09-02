import { and, eq, ne } from 'drizzle-orm';
import { roles, users } from '../db/schema.js';
import { newId, nowIso, hashPassword, badRequest, notFound, forbidden } from '../util.js';
import type { Ctx } from './context.js';
import { actorId } from './context.js';
import { writeAudit } from './audit.js';
import {
  noIdentityRevocation,
  revokeIdentitySessions,
  type IdentityRevocation,
} from './identity-revocation.js';

/** True when the acting user currently holds an owner role. */
function callerIsOwner(ctx: Ctx): boolean {
  if (!ctx.user) return false;
  const role = ctx.db
    .select({ isOwnerRole: roles.isOwnerRole })
    .from(roles)
    .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, ctx.user.roleId)))
    .get();
  return role?.isOwnerRole === true;
}

export function listUsers(ctx: Ctx) {
  return ctx.db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      email: users.email,
      phone: users.phone,
      roleId: users.roleId,
      roleName: roles.name,
      language: users.language,
      active: users.active,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.tenantId, ctx.tenantId))
    .all();
}

export function createUser(
  ctx: Ctx,
  input: {
    username: string;
    displayName: string;
    password: string;
    roleId: string;
    email?: string;
    phone?: string;
    language?: string;
  },
): string {
  const username = input.username.trim().toLowerCase();
  if (!username || !input.password) badRequest('user_invalid', 'Username and password required');
  const role = ctx.db
    .select()
    .from(roles)
    .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, input.roleId)))
    .get();
  if (!role) badRequest('role_missing', 'Role not found');
  const dup = ctx.db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, ctx.tenantId), eq(users.username, username)))
    .get();
  if (dup) badRequest('username_taken', `Username '${username}' already exists`);
  const id = newId();
  ctx.db
    .insert(users)
    .values({
      id,
      tenantId: ctx.tenantId,
      username,
      displayName: input.displayName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      passwordHash: hashPassword(input.password),
      roleId: input.roleId,
      language: input.language ?? 'en',
      createdBy: actorId(ctx),
      createdAt: nowIso(),
    })
    .run();
  writeAudit(ctx, {
    module: 'users',
    action: 'user_create',
    entity: 'user',
    entityId: id,
    reference: username,
    summary: `User '${input.displayName}' created with role '${role.name}'`,
  });
  return id;
}

export function updateUser(
  ctx: Ctx,
  userId: string,
  patch: {
    displayName?: string;
    email?: string;
    phone?: string;
    roleId?: string;
    language?: string;
    active?: boolean;
  },
): IdentityRevocation {
  const user = ctx.db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, userId)))
    .get();
  if (!user) notFound('user_missing', 'User not found');

  // Red-team H2: a NON-OWNER with manage_users must not escalate their own
  // account by self-assigning a different (higher) role. Owners are already
  // fully privileged, so an owner changing their own role is not an escalation
  // — and legitimate owner handover (deactivate self once a second owner
  // exists) must keep working, still guarded by the last-owner check below.
  if (ctx.user && ctx.user.id === userId && !callerIsOwner(ctx)) {
    if (patch.roleId && patch.roleId !== user.roleId) {
      forbidden('self_role_change', 'You cannot change your own role');
    }
  }

  if (patch.active === false || (patch.roleId && patch.roleId !== user.roleId)) {
    assertNotLastActiveOwner(ctx, user.id, user.roleId);
  }
  if (patch.roleId) {
    const role = ctx.db
      .select()
      .from(roles)
      .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, patch.roleId)))
      .get();
    if (!role) badRequest('role_missing', 'Role not found');
  }
  const before = {
    displayName: user.displayName,
    roleId: user.roleId,
    active: user.active,
    email: user.email,
    phone: user.phone,
    language: user.language,
  };
  // Switching an account OFF ends its authority, so it ends its sessions — and
  // therefore everything derived from them. Before this, deactivation revoked
  // nothing: the identity side merely stopped resolving those sessions (because
  // `buildSessionUser` refuses an inactive account), which left no revoked row
  // for HQ propagation to notice and left the derived HQ session alive for the
  // rest of its hour. Deactivating a compromised account has to be immediate on
  // BOTH hosts.
  const deactivating = patch.active === false && user.active;
  const revocation = ctx.db.transaction((tx) => {
    const txDb = tx as unknown as typeof ctx.db;
    txDb
      .update(users)
      .set({
        displayName: patch.displayName ?? user.displayName,
        email: patch.email === undefined ? user.email : patch.email,
        phone: patch.phone === undefined ? user.phone : patch.phone,
        roleId: patch.roleId ?? user.roleId,
        language: patch.language ?? user.language,
        active: patch.active ?? user.active,
      })
      .where(eq(users.id, userId))
      .run();
    return deactivating
      ? revokeIdentitySessions(txDb, { userId }, 'account_deactivated')
      : noIdentityRevocation('account_deactivated');
  });
  writeAudit(ctx, {
    module: 'users',
    action: 'user_update',
    entity: 'user',
    entityId: userId,
    reference: user.username,
    summary: `User '${user.displayName}' updated`,
    before,
    after: patch,
  });
  return revocation;
}

export function resetPassword(ctx: Ctx, userId: string, newPassword: string): IdentityRevocation {
  const user = ctx.db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, ctx.tenantId), eq(users.id, userId)))
    .get();
  if (!user) notFound('user_missing', 'User not found');
  if (!newPassword || newPassword.length < 6) {
    badRequest('password_weak', 'Password must be at least 6 characters');
  }
  const hashed = hashPassword(newPassword);
  // A password reset signs the account out everywhere — stale sessions must
  // never survive a credential change, on this host OR on HQ. The two writes
  // commit together so there is no instant with a new password and a live old
  // session, and the returned revocation is what tells HQ.
  const revocation = ctx.db.transaction((tx) => {
    const txDb = tx as unknown as typeof ctx.db;
    txDb.update(users).set({ passwordHash: hashed }).where(eq(users.id, userId)).run();
    return revokeIdentitySessions(txDb, { userId }, 'password_reset');
  });
  writeAudit(ctx, {
    module: 'users',
    action: 'password_reset',
    entity: 'user',
    entityId: userId,
    reference: user.username,
    summary: `Password reset for '${user.displayName}'`,
  });
  return revocation;
}

/** The tenant must always keep at least one active user in the owner role. */
function assertNotLastActiveOwner(ctx: Ctx, userId: string, roleId: string): void {
  const role = ctx.db
    .select()
    .from(roles)
    .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, roleId)))
    .get();
  if (!role?.isOwnerRole) return;
  const otherActiveOwners = ctx.db
    .select({ id: users.id })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(
      and(
        eq(users.tenantId, ctx.tenantId),
        eq(users.active, true),
        eq(roles.isOwnerRole, true),
        ne(users.id, userId),
      ),
    )
    .all();
  if (otherActiveOwners.length === 0) {
    badRequest('last_owner', 'At least one active owner account must remain');
  }
}
