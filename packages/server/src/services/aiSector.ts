import type { SectorAIMastery, SectorDefinition } from '@factoryos/shared/sectors';
import { SECTOR_BY_ID } from '@factoryos/shared/sectors';
import type { CapabilityId } from '@factoryos/shared';
import type { Ctx } from './context.js';
import { activeBinding, resolveTenantConfig } from './templates.js';
import { availableIntents } from './ai.js';
import { listActionCatalog } from './aiActions.js';

/**
 * Sector mastery for JENIFY AI (§24, §27).
 *
 * JENIFY AI is not a chatbot bolted onto a product: before it answers anything
 * it knows WHICH BUSINESS it is inside. This module resolves that context from
 * the tenant's own template binding — so a hotel's assistant reasons about
 * rooms and arrivals while a factory's reasons about batches and yield, from
 * ONE core with no per-sector fork.
 *
 * It also turns the sector's prose limits into an ENFORCED refusal. A clinic's
 * assistant must not answer a clinical question no matter how it is phrased,
 * and prose in a design document cannot stop that — `sectorRefusal()` runs
 * BEFORE any intent is matched or executed.
 */

export interface SectorContext {
  sectorId: string | null;
  labelKey: string | null;
  mastery: SectorAIMastery | null;
  /** capabilities actually active for this tenant (drives what AI can discuss) */
  capabilities: CapabilityId[];
  /** intents this specific user may run (permission-filtered) */
  availableIntents: string[];
  /** low-risk actions the AI may prepare for this user */
  availableActions: string[];
  /** the user's role — AI answers are role-aware, not just tenant-aware */
  roleName: string | null;
}

/** The sector a tenant is bound to, if any (first sector.* layer in its stack). */
export function tenantSector(ctx: Ctx): SectorDefinition | null {
  const binding = activeBinding(ctx.db, ctx.tenantId);
  if (!binding) return null;
  for (const layer of binding) {
    const sector = SECTOR_BY_ID.get(layer.templateId);
    if (sector) return sector;
  }
  return null;
}

/** Everything the assistant needs to reason inside THIS business, for THIS user. */
export function sectorContext(ctx: Ctx): SectorContext {
  const sector = tenantSector(ctx);
  const capabilities = resolveTenantConfig(ctx.db, ctx.tenantId).activeCapabilities;
  const executable = new Set(listActionCatalog().filter((a) => a.executable).map((a) => a.id));
  return {
    sectorId: sector?.id ?? null,
    labelKey: sector?.labelKey ?? null,
    mastery: sector?.ai ?? null,
    capabilities,
    availableIntents: availableIntents(ctx),
    availableActions: [...executable],
    roleName: ctx.user?.roleName ?? null,
  };
}

export interface SectorRefusal {
  refused: true;
  reason: string;
  /** the sector limit that triggered the refusal, for the audit trail */
  limit: string;
  sectorId: string;
}

/**
 * Hard sector guard. Returns a refusal when the request touches something this
 * sector's AI must NEVER do (clinical advice in healthcare, deciding a citizen
 * case in government, dosing advice in pharmacy/agriculture, safety clearance
 * in mining). Runs before intent matching, so no downstream path can bypass it.
 *
 * This is deliberately conservative: it refuses on keyword contact rather than
 * trying to judge intent. A false refusal is a minor annoyance; a clinical
 * answer from a business system is not.
 */
export function sectorRefusal(ctx: Ctx, utterance: string): SectorRefusal | null {
  const sector = tenantSector(ctx);
  if (!sector?.ai.guardKeywords?.length) return null;
  const text = utterance.toLowerCase();
  const hit = sector.ai.guardKeywords.find((k) => text.includes(k.toLowerCase()));
  if (!hit) return null;
  return {
    refused: true,
    sectorId: sector.id,
    limit: sector.ai.neverDoes[0] ?? 'out of scope for this sector',
    reason:
      `That is outside what JENIFY can answer for this business. ` +
      `This assistant covers operational and administrative questions only — ` +
      `it must not ${sector.ai.neverDoes[0] ?? 'act outside its scope'}. ` +
      `Please consult a qualified professional.`,
  };
}

/**
 * A plain-language description of what the assistant can do here — used to
 * introduce the AI honestly instead of implying unlimited capability.
 */
export function sectorCapabilityStatement(ctx: Ctx): {
  sectorId: string | null;
  canAnswer: string[];
  canDetect: string[];
  canPrepare: string[];
  willNeverDo: string[];
} {
  const sector = tenantSector(ctx);
  return {
    sectorId: sector?.id ?? null,
    canAnswer: sector?.ai.answers ?? [],
    canDetect: sector?.ai.detects ?? [],
    canPrepare: sector?.ai.prepares ?? [],
    willNeverDo: sector?.ai.neverDoes ?? [],
  };
}
