import { and, desc, eq } from 'drizzle-orm';
import type {
  EffectiveExperience,
  ModuleId,
  QuickAction,
  RoleExperienceSpec,
} from '@factoryos/shared';
import { MODULES, hasPermission } from '@factoryos/shared';
import { roleExperiences, roles } from '../db/schema.js';
import { newId, nowIso, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId } from './context.js';
import { writeAudit } from './audit.js';
import { requirePermission } from './permissions.js';

/**
 * Role Experience Engine.
 *
 * PERMISSION vs EXPERIENCE: a role's experience spec only ever narrows or
 * reorders what the user's permissions already allow. The resolver
 * `effectiveExperience` intersects the spec with the live permission matrix, so
 * a spec can NEVER surface a module/action the user cannot access — and the
 * server still enforces RBAC independently on every route. Experience is
 * presentation; permission is authority.
 */

/** Platform-standard default nav order (generic; tenants relabel via i18n). */
const DEFAULT_NAV_ORDER: ModuleId[] = [
  'dashboard',
  'inventory',
  'production',
  'quality',
  'parties',
  'sales',
  'credit',
  'payments',
  'delivery',
  'reports',
  'users',
  'settings',
  'audit',
];

export function getRoleExperience(ctx: Ctx, roleId: string): RoleExperienceSpec | null {
  const row = ctx.db
    .select()
    .from(roleExperiences)
    .where(and(eq(roleExperiences.tenantId, ctx.tenantId), eq(roleExperiences.roleId, roleId)))
    .orderBy(desc(roleExperiences.version))
    .limit(1)
    .get();
  return row ? (row.spec as RoleExperienceSpec) : null;
}

/** Save a new version of a role's experience spec (append-only, audited). */
export function saveRoleExperience(ctx: Ctx, roleId: string, spec: RoleExperienceSpec): number {
  requirePermission(ctx, 'users', 'manage_users');
  const role = ctx.db
    .select()
    .from(roles)
    .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, roleId)))
    .get();
  if (!role) notFound('role_missing', 'Role not found');
  const latest = ctx.db
    .select({ version: roleExperiences.version })
    .from(roleExperiences)
    .where(eq(roleExperiences.roleId, roleId))
    .orderBy(desc(roleExperiences.version))
    .limit(1)
    .get();
  const version = (latest?.version ?? 0) + 1;
  ctx.db
    .insert(roleExperiences)
    .values({
      id: newId(),
      tenantId: ctx.tenantId,
      roleId,
      version,
      spec: spec as object,
      createdBy: actorId(ctx),
      createdAt: nowIso(),
    })
    .run();
  writeAudit(ctx, {
    module: 'users',
    action: 'experience_edit',
    entity: 'role',
    entityId: roleId,
    reference: role.code,
    summary: `Experience for role '${role.name}' saved as version ${version}`,
    after: spec,
  });
  return version;
}

function canView(ctx: Ctx, module: ModuleId): boolean {
  return ctx.user != null && hasPermission(ctx.user.permissions, module, 'view');
}

function actionPermitted(ctx: Ctx, a: QuickAction): boolean {
  return ctx.user != null && hasPermission(ctx.user.permissions, a.module, a.action ?? 'view');
}

/**
 * Resolve the experience actually served to the current user: the role's spec
 * intersected with the user's permissions. Anything not permitted is removed
 * here. With no spec configured, a sensible default is derived from permissions
 * and the role's dashboardFocus.
 */
export function effectiveExperience(ctx: Ctx): EffectiveExperience {
  if (!ctx.user) {
    return { homeFocus: 'dashboard', nav: [], quickActions: [], mobileActions: [], kpis: [], defaultFilters: {}, derived: true };
  }
  const spec = getRoleExperience(ctx, ctx.user.roleId);
  const role = ctx.db
    .select({ dashboardFocus: roles.dashboardFocus })
    .from(roles)
    .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, ctx.user.roleId)))
    .get();

  // permitted modules, in the spec's nav order if given, else default order
  const orderSource = spec?.nav && spec.nav.length > 0 ? spec.nav : DEFAULT_NAV_ORDER;
  const nav = orderSource.filter((m) => MODULES.includes(m) && canView(ctx, m));

  // home focus: spec, else role.dashboardFocus, else first permitted nav item
  let homeFocus: ModuleId = 'dashboard';
  if (spec?.homeFocus && canView(ctx, spec.homeFocus)) homeFocus = spec.homeFocus;
  else if (role?.dashboardFocus && canView(ctx, role.dashboardFocus as ModuleId)) homeFocus = role.dashboardFocus as ModuleId;
  else if (nav.length > 0) homeFocus = nav[0]!;

  const quickActions = (spec?.quickActions ?? []).filter((a) => actionPermitted(ctx, a));
  // mobile actions: spec's tiny verb set, else derive from the first permitted nav
  const mobileActions = (spec?.mobileActions ?? []).filter((a) => actionPermitted(ctx, a));

  return {
    homeFocus,
    nav,
    quickActions,
    mobileActions,
    kpis: spec?.kpis ?? [],
    defaultFilters: spec?.defaultFilters ?? {},
    derived: spec == null,
  };
}
