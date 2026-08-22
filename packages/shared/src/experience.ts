// Role Experience vocabulary.
// PERMISSION (RBAC) = what a user is ALLOWED to do — authoritative, server-side.
// EXPERIENCE       = what a user NORMALLY sees and how they work — presentation.
// The engine's core safety property: experience can only ever narrow or reorder
// what permissions already allow. It NEVER grants access. Resolution intersects
// the role's experience with the user's real permissions.

import type { ModuleId } from './index.js';

/** A one-tap action surfaced on a home screen or the mobile worker bar. */
export interface QuickAction {
  /** stable id, e.g. 'receive', 'move', 'count' */
  id: string;
  labelKey: string; // translation key
  /** the route the UI navigates to, e.g. '/receiving' */
  path: string;
  /** module+action this requires — used to hide it when not permitted */
  module: ModuleId;
  action?: string; // defaults to 'view'
  icon?: string;
}

/**
 * A role's configured experience. Every field is OPTIONAL — an absent field
 * falls back to a permission-derived default, so a brand-new tenant works with
 * no experience configured at all.
 */
export interface RoleExperienceSpec {
  /** primary module the home screen focuses on (e.g. warehouse -> inventory) */
  homeFocus?: ModuleId;
  /** ordered nav subset; empty/absent = every module the user may view */
  nav?: ModuleId[];
  /** desktop/home quick actions */
  quickActions?: QuickAction[];
  /** mobile worker bar — the deliberately tiny verb set (e.g. RECEIVE/MOVE/
   *  ISSUE/COUNT/LOOKUP). Absent = derive from nav. */
  mobileActions?: QuickAction[];
  /** KPI ids to show on the role home */
  kpis?: string[];
  /** default filter values for the role's primary screens */
  defaultFilters?: Record<string, string>;
}

/**
 * The resolved experience actually sent to the client: the role's spec after
 * intersection with the user's permissions. Anything the user cannot `view`
 * has already been removed here — the client renders this verbatim and the
 * server has still enforced RBAC independently on every route.
 */
export interface EffectiveExperience {
  homeFocus: ModuleId;
  nav: ModuleId[];
  quickActions: QuickAction[];
  mobileActions: QuickAction[];
  kpis: string[];
  defaultFilters: Record<string, string>;
  /** true when derived from permissions because no spec was configured */
  derived: boolean;
}
