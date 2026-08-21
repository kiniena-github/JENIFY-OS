import { and, desc, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  languagePackEntries,
  languagePacks,
  roles,
  tenants,
  translationDecisions,
  translationKeys,
  translations,
} from '../db/schema.js';
import { newId, nowIso, badRequest, forbidden, notFound } from '../util.js';
import type { Ctx } from './context.js';
import { actorId, inTx } from './context.js';
import { writeAudit } from './audit.js';
import { requirePermission } from './permissions.js';

/**
 * Language intelligence: JENIFY learns from real per-company terminology
 * customization and turns it into versioned OFFICIAL language packs.
 *
 * Boundaries (Founder mandate):
 *  - A company's own overrides are private and always win over official packs.
 *  - Aggregation exposes COUNTS ONLY — never which company uses which wording.
 *  - Recommendations are ranked suggestions; ONLY an authorized human promotes
 *    a translation to official. There is no automatic promotion path.
 *  - Official packs are versioned append-only; approve/rollback create a new
 *    version, prior versions stay queryable forever.
 */

export const MIN_ORGS_FOR_RECOMMENDATION = 3;
const DOMINANT_SHARE_PCT = 60;
const CLEAR_MARGIN_PCT = 20;

/** NFC-normalize and collapse whitespace so trivially-identical variants group. */
export function normalizeTranslationValue(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Interim platform-authority rule for this single-box deployment: official
 * pack decisions require an OWNER role plus settings.approve. A dedicated
 * platform-admin identity (separate from tenant owners) is a tracked Wave 1+
 * architecture item — see docs/JENIFY_PROGRAM_STATE.md.
 */
export function requireLanguageAuthority(ctx: Ctx): void {
  requirePermission(ctx, 'settings', 'approve');
  const role = ctx.db
    .select({ isOwnerRole: roles.isOwnerRole })
    .from(roles)
    .where(and(eq(roles.tenantId, ctx.tenantId), eq(roles.id, ctx.user!.roleId)))
    .get();
  if (!role?.isOwnerRole) {
    forbidden('language_authority', 'Official language decisions require the owner role');
  }
}

export interface VariantStat {
  value: string;
  orgCount: number;
  sharePct: number; // of orgs that customized this key+language, 0-100
  sectorCount: number; // distinct sectors observed (counts only — never names of orgs)
  countryCount: number;
}

export interface KeyAggregation {
  key: string;
  keyId: string;
  en: string;
  language: string;
  totalOrgs: number;
  variants: VariantStat[]; // descending by orgCount, below-threshold variants collapsed
  otherVariantCount: number;
  otherOrgCount: number;
  officialValue: string | null;
}

interface UsageRow {
  keyId: string;
  key: string;
  en: string;
  text: string;
  tenantId: string;
  sector: string | null;
  country: string | null;
}

/**
 * Aggregate ACTIVE (non-placeholder) tenant translation usage for a language.
 * Placeholders are machine-seeded, unreviewed text — they are never counted as
 * real business usage. Output contains aggregate counts only.
 */
export function aggregateTranslationUsage(
  db: Db,
  language: string,
  opts: { key?: string; minShow?: number } = {},
): KeyAggregation[] {
  const minShow = opts.minShow ?? 1;
  const rows: UsageRow[] = db
    .select({
      keyId: translations.keyId,
      key: translationKeys.key,
      en: translationKeys.enText,
      text: translations.text,
      tenantId: translations.tenantId,
      sector: tenants.sector,
      country: tenants.country,
    })
    .from(translations)
    .innerJoin(translationKeys, eq(translations.keyId, translationKeys.id))
    .innerJoin(tenants, eq(translations.tenantId, tenants.id))
    .where(
      and(
        eq(translations.language, language),
        eq(translations.status, 'active'),
        ne(translations.text, ''),
        eq(tenants.active, true),
      ),
    )
    .all();

  const byKey = new Map<string, UsageRow[]>();
  for (const r of rows) {
    if (opts.key && r.key !== opts.key) continue;
    const list = byKey.get(r.keyId) ?? [];
    list.push(r);
    byKey.set(r.keyId, list);
  }

  const official = getOfficialEntries(db, language, {});
  const out: KeyAggregation[] = [];
  for (const [keyId, keyRows] of byKey) {
    // one voice per organization: a tenant's current value counts once
    const perTenant = new Map<string, UsageRow>();
    for (const r of keyRows) perTenant.set(r.tenantId, r);
    const totalOrgs = perTenant.size;

    const byValue = new Map<string, { orgs: number; sectors: Set<string>; countries: Set<string> }>();
    for (const r of perTenant.values()) {
      const v = normalizeTranslationValue(r.text);
      if (!v) continue;
      const agg = byValue.get(v) ?? { orgs: 0, sectors: new Set(), countries: new Set() };
      agg.orgs += 1;
      if (r.sector) agg.sectors.add(r.sector);
      if (r.country) agg.countries.add(r.country);
      byValue.set(v, agg);
    }

    const ranked = [...byValue.entries()]
      .map(([value, a]) => ({
        value,
        orgCount: a.orgs,
        sharePct: totalOrgs === 0 ? 0 : Math.round((a.orgs / totalOrgs) * 1000) / 10,
        sectorCount: a.sectors.size,
        countryCount: a.countries.size,
      }))
      .sort((x, y) => y.orgCount - x.orgCount || x.value.localeCompare(y.value));

    const shown = ranked.filter((v) => v.orgCount >= minShow);
    const hidden = ranked.filter((v) => v.orgCount < minShow);
    out.push({
      key: keyRows[0]!.key,
      keyId,
      en: keyRows[0]!.en,
      language,
      totalOrgs,
      variants: shown,
      otherVariantCount: hidden.length,
      otherOrgCount: hidden.reduce((s, v) => s + v.orgCount, 0),
      officialValue: official.get(keyId) ?? null,
    });
  }
  return out.sort((a, b) => b.totalOrgs - a.totalOrgs || a.key.localeCompare(b.key));
}

export interface CandidateRecommendation {
  key: string;
  keyId: string;
  en: string;
  language: string;
  recommended: VariantStat;
  alternatives: VariantStat[];
  totalOrgs: number;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  officialValue: string | null;
}

/**
 * Ranked candidates for human review. Never auto-promotes: the output is a
 * recommendation with an explanation, nothing more. Keys whose dominant usage
 * already equals the official value are omitted (nothing to decide).
 */
export function recommendOfficialCandidates(
  db: Db,
  language: string,
  opts: { minOrgs?: number } = {},
): CandidateRecommendation[] {
  const minOrgs = opts.minOrgs ?? MIN_ORGS_FOR_RECOMMENDATION;
  const out: CandidateRecommendation[] = [];
  for (const agg of aggregateTranslationUsage(db, language)) {
    const [top, second] = agg.variants;
    if (!top || top.orgCount < minOrgs) continue;
    if (agg.officialValue !== null && normalizeTranslationValue(agg.officialValue) === top.value) {
      continue; // dominant usage already official
    }
    const margin = top.sharePct - (second?.sharePct ?? 0);
    const reasons: string[] = [
      `highest usage: ${top.orgCount} of ${agg.totalOrgs} organizations (${top.sharePct}%)`,
    ];
    if (top.sectorCount > 1) reasons.push(`used across ${top.sectorCount} sectors`);
    if (top.countryCount > 1) reasons.push(`used across ${top.countryCount} countries`);
    if (margin >= CLEAR_MARGIN_PCT) reasons.push(`low disagreement (next variant ${margin.toFixed(1)} points behind)`);
    else reasons.push(`contested: next variant only ${margin.toFixed(1)} points behind`);
    if (agg.officialValue !== null) reasons.push('would replace the current official translation');

    let confidence: 'high' | 'medium' | 'low' = 'low';
    if (top.sharePct >= DOMINANT_SHARE_PCT && margin >= CLEAR_MARGIN_PCT) confidence = 'high';
    else if (top.sharePct >= 40) confidence = 'medium';

    out.push({
      key: agg.key,
      keyId: agg.keyId,
      en: agg.en,
      language,
      recommended: top,
      // k-suppression applies to alternatives too: a variant used by fewer
      // than minOrgs companies is one company's private wording — never shown
      alternatives: agg.variants.slice(1).filter((v) => v.orgCount >= minOrgs).slice(0, 4),
      totalOrgs: agg.totalOrgs,
      confidence,
      reasons,
      officialValue: agg.officialValue,
    });
  }
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.totalOrgs - a.totalOrgs);
}

function latestOfficialPack(db: Db, language: string, scope: string, scopeValue: string) {
  return db
    .select()
    .from(languagePacks)
    .where(
      and(
        eq(languagePacks.language, language),
        eq(languagePacks.scope, scope),
        eq(languagePacks.scopeValue, scopeValue),
        eq(languagePacks.status, 'official'),
      ),
    )
    .orderBy(desc(languagePacks.version))
    .limit(1)
    .get();
}

function packEntries(db: Db, packId: string): Map<string, string> {
  const rows = db
    .select()
    .from(languagePackEntries)
    .where(eq(languagePackEntries.packId, packId))
    .all();
  return new Map(rows.map((r) => [r.keyId, r.value]));
}

/**
 * Layered official view for one language: global pack, overlaid by the
 * tenant's country variant, overlaid by its sector variant. Tenant overrides
 * are applied later by getBundle and always win.
 */
export function getOfficialEntries(
  db: Db,
  language: string,
  opts: { country?: string | null; sector?: string | null },
): Map<string, string> {
  const merged = new Map<string, string>();
  const layers: Array<[string, string]> = [['global', '']];
  if (opts.country) layers.push(['country', opts.country]);
  if (opts.sector) layers.push(['sector', opts.sector]);
  for (const [scope, scopeValue] of layers) {
    const pack = latestOfficialPack(db, language, scope, scopeValue);
    if (!pack) continue;
    for (const [keyId, value] of packEntries(db, pack.id)) merged.set(keyId, value);
  }
  return merged;
}

/** Write a new pack version whose entries = current official entries with one change applied. */
function writePackVersion(
  ctx: Ctx,
  language: string,
  scope: string,
  scopeValue: string,
  mutate: (entries: Map<string, string>) => void,
  notes: string,
): number {
  const prior = latestOfficialPack(ctx.db, language, scope, scopeValue);
  const entries = prior ? packEntries(ctx.db, prior.id) : new Map<string, string>();
  mutate(entries);
  const latestAny = ctx.db
    .select({ version: languagePacks.version })
    .from(languagePacks)
    .where(
      and(
        eq(languagePacks.language, language),
        eq(languagePacks.scope, scope),
        eq(languagePacks.scopeValue, scopeValue),
      ),
    )
    .orderBy(desc(languagePacks.version))
    .limit(1)
    .get();
  const version = (latestAny?.version ?? 0) + 1;
  const packId = newId();
  ctx.db
    .insert(languagePacks)
    .values({
      id: packId,
      language,
      scope,
      scopeValue,
      version,
      status: 'official',
      notes,
      createdBy: actorId(ctx),
      approvedAt: nowIso(),
    })
    .run();
  for (const [keyId, value] of entries) {
    ctx.db.insert(languagePackEntries).values({ id: newId(), packId, keyId, value }).run();
  }
  if (prior) {
    ctx.db.update(languagePacks).set({ status: 'superseded' }).where(eq(languagePacks.id, prior.id)).run();
  }
  return version;
}

export const REVIEW_DECISIONS = [
  'approve',
  'reject',
  'defer',
  'sector_specific',
  'regional_variant',
] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * Record one human review decision. `approve` promotes the value into a new
 * OFFICIAL global pack version; `sector_specific`/`regional_variant` (with a
 * scopeValue and value) create a scoped variant pack; reject/defer only record
 * the decision so reviewers do not re-triage the same candidate.
 */
export function decideTranslation(
  ctx: Ctx,
  input: {
    key: string;
    language: string;
    decision: ReviewDecision;
    value?: string;
    reason?: string;
    scopeValue?: string; // sector code / country code for scoped decisions
  },
): { packVersion: number | null } {
  requireLanguageAuthority(ctx);
  if (!REVIEW_DECISIONS.includes(input.decision)) {
    badRequest('decision', `Unknown review decision '${String(input.decision)}'`);
  }
  if (!input.language?.trim()) badRequest('language_code', 'A language code is required');
  if (input.value !== undefined && input.value.length > 500) {
    badRequest('translation_value', 'Translation values are limited to 500 characters');
  }
  if (input.reason !== undefined && input.reason.length > 500) {
    badRequest('reason', 'Reasons are limited to 500 characters');
  }
  if (input.scopeValue !== undefined && input.scopeValue.length > 64) {
    badRequest('scope_value', 'Sector/country codes are limited to 64 characters');
  }
  const keyRow = ctx.db
    .select()
    .from(translationKeys)
    .where(eq(translationKeys.key, input.key))
    .get();
  if (!keyRow) notFound('translation_key_missing', `Unknown translation key '${input.key}'`);

  const value = input.value === undefined ? undefined : normalizeTranslationValue(input.value);
  let scope = 'global';
  let scopeValue = '';
  if (input.decision === 'sector_specific') {
    scope = 'sector';
    scopeValue = (input.scopeValue ?? '').trim();
  } else if (input.decision === 'regional_variant') {
    scope = 'country';
    scopeValue = (input.scopeValue ?? '').trim();
  }

  const producesPack =
    input.decision === 'approve' ||
    ((input.decision === 'sector_specific' || input.decision === 'regional_variant') && value);
  if (producesPack) {
    if (!value) badRequest('translation_value', 'A translation value is required to approve');
    if (scope !== 'global' && !scopeValue) {
      badRequest('scope_value', 'A sector/country code is required for a scoped decision');
    }
  }

  // one atomic unit: pack version + entries + supersede + decision + audit
  return inTx(ctx, (tx) => {
    let packVersion: number | null = null;
    let previousValue: string | null = null;
    if (producesPack) {
      const prior = latestOfficialPack(tx.db, input.language, scope, scopeValue);
      previousValue = prior ? (packEntries(tx.db, prior.id).get(keyRow.id) ?? null) : null;
      packVersion = writePackVersion(
        tx,
        input.language,
        scope,
        scopeValue,
        (entries) => entries.set(keyRow.id, value!),
        `${input.decision}: '${input.key}' — ${input.reason ?? 'no reason given'}`,
      );
    }

    tx.db
      .insert(translationDecisions)
      .values({
        id: newId(),
        keyId: keyRow.id,
        language: input.language,
        scope,
        scopeValue,
        decision: input.decision,
        value: value ?? null,
        previousValue,
        reason: input.reason ?? null,
        decidedBy: actorId(tx),
        decidedAt: nowIso(),
        packVersion,
      })
      .run();
    writeAudit(tx, {
      module: 'settings',
      action: 'language_pack_decision',
      entity: 'translation_key',
      entityId: keyRow.id,
      reference: `${input.key}/${input.language}`,
      summary: `Translation review '${input.key}' (${input.language}): ${input.decision}${packVersion ? ` → pack v${packVersion}` : ''}`,
      before: previousValue,
      after: value ?? null,
      reason: input.reason,
    });
    return { packVersion };
  });
}

/**
 * Roll back the official translation of one key to its value in the previous
 * pack version (or remove it, restoring English/base fallback, if the key was
 * not official before). Produces a NEW pack version — history is preserved.
 */
export function rollbackOfficialTranslation(
  ctx: Ctx,
  input: { key: string; language: string; reason: string; scope?: string; scopeValue?: string },
): { packVersion: number } {
  requireLanguageAuthority(ctx);
  if (!input.reason?.trim()) badRequest('rollback_reason', 'A rollback reason is required');
  if (input.reason.length > 500) badRequest('reason', 'Reasons are limited to 500 characters');
  const keyRow = ctx.db
    .select()
    .from(translationKeys)
    .where(eq(translationKeys.key, input.key))
    .get();
  if (!keyRow) notFound('translation_key_missing', `Unknown translation key '${input.key}'`);
  const scope = input.scope ?? 'global';
  const scopeValue = input.scopeValue ?? '';

  // one atomic unit: read snapshot + new version + supersede + decision + audit
  return inTx(ctx, (tx) => {
    const current = latestOfficialPack(tx.db, input.language, scope, scopeValue);
    if (!current) notFound('pack_missing', 'No official pack exists for this language/scope');
    const currentValue = packEntries(tx.db, current.id).get(keyRow.id);
    if (currentValue === undefined) {
      badRequest('not_official', `'${input.key}' has no official translation to roll back`);
    }
    const previous = tx.db
      .select()
      .from(languagePacks)
      .where(
        and(
          eq(languagePacks.language, input.language),
          eq(languagePacks.scope, scope),
          eq(languagePacks.scopeValue, scopeValue),
          ne(languagePacks.id, current.id),
        ),
      )
      .orderBy(desc(languagePacks.version))
      .limit(1)
      .get();
    const restored = previous ? (packEntries(tx.db, previous.id).get(keyRow.id) ?? null) : null;

    const packVersion = writePackVersion(
      tx,
      input.language,
      scope,
      scopeValue,
      (entries) => {
        if (restored === null) entries.delete(keyRow.id);
        else entries.set(keyRow.id, restored);
      },
      `rollback: '${input.key}' — ${input.reason}`,
    );
    tx.db
      .insert(translationDecisions)
      .values({
        id: newId(),
        keyId: keyRow.id,
        language: input.language,
        scope,
        scopeValue,
        decision: 'rollback',
        value: restored,
        previousValue: currentValue,
        reason: input.reason,
        decidedBy: actorId(tx),
        decidedAt: nowIso(),
        packVersion,
      })
      .run();
    writeAudit(tx, {
      module: 'settings',
      action: 'language_pack_rollback',
      entity: 'translation_key',
      entityId: keyRow.id,
      reference: `${input.key}/${input.language}`,
      summary: `Official translation '${input.key}' (${input.language}) rolled back to ${restored === null ? 'base fallback' : `'${restored}'`} (pack v${packVersion})`,
      before: currentValue,
      after: restored,
      reason: input.reason,
    });
    return { packVersion };
  });
}

/** Version history + full decision ledger for a language (all scopes). */
export function languagePackHistory(db: Db, language: string) {
  const packs = db
    .select()
    .from(languagePacks)
    .where(eq(languagePacks.language, language))
    .orderBy(desc(languagePacks.version))
    .all()
    .map((p) => ({ ...p, entryCount: packEntries(db, p.id).size }));
  const decisions = db
    .select({
      id: translationDecisions.id,
      key: translationKeys.key,
      language: translationDecisions.language,
      scope: translationDecisions.scope,
      scopeValue: translationDecisions.scopeValue,
      decision: translationDecisions.decision,
      value: translationDecisions.value,
      previousValue: translationDecisions.previousValue,
      reason: translationDecisions.reason,
      decidedBy: translationDecisions.decidedBy,
      decidedAt: translationDecisions.decidedAt,
      packVersion: translationDecisions.packVersion,
    })
    .from(translationDecisions)
    .innerJoin(translationKeys, eq(translationDecisions.keyId, translationKeys.id))
    .where(eq(translationDecisions.language, language))
    // UUIDv7 id as tiebreaker: same-millisecond decisions keep insertion order
    .orderBy(desc(translationDecisions.decidedAt), desc(translationDecisions.id))
    .all();
  return { packs, decisions };
}
