import { and, desc, eq } from 'drizzle-orm';
import type { ActionId, ModuleId, PermissionMatrix } from '@factoryos/shared';
import { hasPermission } from '@factoryos/shared';
import { rolePermissions, roles } from '../db/schema.js';
import { newId, nowIso, badRequest, forbidden, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId } from './context.js';
import { writeAudit } from './audit.js';

export function getRoleMatrix(ctx: Ctx, roleId: string): PermissionMatrix {
  const row = ctx.db
    .select()
    .from(rolePermissions)
    .where(and(eq(rolePermissions.tenantId, ctx.tenantId), eq(rolePermissions.roleId, roleId)))
    .orderBy(desc(rolePermissions.version))
    .limit(1)
    .get();
  return (row?.matrix as PermissionMatrix) ?? {};
}

export function listRoles(ctx: Ctx) {
  const all = ctx.db.select().from(roles).where(eq(roles.tenantId, ctx.tenantId)).all();
  return all.map((r) => ({ ...r, matrix: getRoleMatrix(ctx, r.id) }));
}

export function createRole(
  ctx: Ctx,
  input: {
    code: string;
    name: string;
    description?: string;
    dashboardFocus?: ModuleId;
    isOwnerRole?: boolean;
    matrix: PermissionMatrix;
  },
) {
  const id = newId();
  ctx.db
    .insert(roles)
    .values({
      id,
      tenantId: ctx.tenantId,
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      dashboardFocus: input.dashboardFocus ?? null,
      isOwnerRole: input.isOwnerRole ?? false,
      createdAt: nowIso(),
    })
    .run();
  ctx.db
    .insert(rolePermissions)
    .values({
      id: newId(),
      tenantId: ctx.tenantId,
      roleId: id,
      version: 1,
      matrix: input.matrix as object,
      createdBy: actorId(ctx),
      createdAt: nowIso(),
    })
    .run();
  writeAudit(ctx, {
    module: 'users',
    action: 'role_create',
    entity: 'role',
    entityId: id,
    reference: input.code,
    summary: `Role '${input.name}' created`,
    after: input.matrix,
  });
  return id;
}

/** Save a new version of a role's permission matrix (never edits history). */
export function saveRoleMatrix(ctx: Ctx, roleId: string, matrix: PermissionMatrix): number {
  const role = ctx.db
    .select()
    .from(roles)
    .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, roleId)))
    .get();
  if (!role) notFound('role_missing', 'Role not found');
  // Red-team H2: a NON-OWNER must not rewrite the permissions of their OWN
  // role — otherwise manage_users is silently equivalent to granting yourself
  // every permission. Owners are already fully privileged (and the owner
  // role's user-management authority is separately protected below), so this
  // guard binds non-owners only; editing OTHER roles is always allowed.
  if (ctx.user && ctx.user.roleId === roleId && !role.isOwnerRole) {
    forbidden('self_permission_edit', 'You cannot edit the permissions of your own role');
  }
  if (role.isOwnerRole) {
    // The owner role must never lose the authority to manage users/permissions,
    // otherwise the tenant can lock itself out permanently.
    if (!hasPermission(matrix, 'users', 'manage_users') || !hasPermission(matrix, 'users', 'view')) {
      badRequest(
        'owner_lockout',
        'The owner role must keep user-management permissions',
      );
    }
  }
  const before = getRoleMatrix(ctx, roleId);
  const latest = ctx.db
    .select()
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId))
    .orderBy(desc(rolePermissions.version))
    .limit(1)
    .get();
  const version = (latest?.version ?? 0) + 1;
  ctx.db
    .insert(rolePermissions)
    .values({
      id: newId(),
      tenantId: ctx.tenantId,
      roleId,
      version,
      matrix: matrix as object,
      createdBy: actorId(ctx),
      createdAt: nowIso(),
    })
    .run();
  writeAudit(ctx, {
    module: 'users',
    action: 'permission_edit',
    entity: 'role',
    entityId: roleId,
    reference: role.code,
    summary: `Permissions for role '${role.name}' saved as version ${version}`,
    before,
    after: matrix,
  });
  return version;
}

/** Guard used by every protected route/service. */
export function requirePermission(ctx: Ctx, module: ModuleId, action: ActionId | string): void {
  if (!ctx.user) forbidden('unauthenticated', 'Sign in required');
  if (!hasPermission(ctx.user.permissions, module, action)) {
    forbidden('forbidden', `Missing permission ${module}.${action}`);
  }
}

/** Passes when the user holds ANY of the listed actions on the module. */
export function requireAnyPermission(
  ctx: Ctx,
  module: ModuleId,
  actions: Array<ActionId | string>,
): void {
  if (!ctx.user) forbidden('unauthenticated', 'Sign in required');
  if (!actions.some((a) => hasPermission(ctx.user!.permissions, module, a))) {
    forbidden('forbidden', `Missing permission ${module}.${actions.join('|')}`);
  }
}

export function canViewFinancial(ctx: Ctx, module: ModuleId): boolean {
  return ctx.user != null && hasPermission(ctx.user.permissions, module, 'view_financial');
}
