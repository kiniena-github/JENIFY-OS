import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { tenants, translationKeys, translations, tenantLanguages, users } from '../db/schema.js';
import { newId, nowIso, notFound, badRequest } from '../util.js';
import { getOfficialEntries } from './languageIntel.js';
import type { Ctx } from './context.js';
import { actorId } from './context.js';
import { writeAudit } from './audit.js';

/**
 * English key/base strings are platform-level (developer-owned, global).
 * Tenants override per language; missing translations fall back to English.
 * Changing labels never changes business data.
 */
export function registerTranslationKeys(
  db: Db,
  keys: Array<{ key: string; en: string; module?: string }>,
): void {
  const now = nowIso();
  for (const k of keys) {
    const existing = db
      .select()
      .from(translationKeys)
      .where(eq(translationKeys.key, k.key))
      .get();
    if (existing) {
      if (existing.enText !== k.en) {
        db.update(translationKeys)
          .set({ enText: k.en, module: k.module ?? existing.module })
          .where(eq(translationKeys.id, existing.id))
          .run();
      }
    } else {
      db.insert(translationKeys)
        .values({ id: newId(), key: k.key, enText: k.en, module: k.module ?? null, createdAt: now })
        .run();
    }
  }
}

export function enableLanguage(
  ctx: Ctx,
  code: string,
  name: string,
  flagEmoji?: string,
  opts: { nativeName?: string; direction?: 'ltr' | 'rtl' } = {},
): string {
  const normalized = code.trim().toLowerCase();
  if (!normalized) badRequest('language_code', 'A language code is required');
  const existing = ctx.db
    .select()
    .from(tenantLanguages)
    .where(and(eq(tenantLanguages.tenantId, ctx.tenantId), eq(tenantLanguages.code, normalized)))
    .get();
  if (existing) {
    ctx.db
      .update(tenantLanguages)
      .set({
        name,
        nativeName: opts.nativeName ?? existing.nativeName,
        direction: opts.direction ?? existing.direction,
        flagEmoji: flagEmoji ?? existing.flagEmoji,
        enabled: true,
      })
      .where(eq(tenantLanguages.id, existing.id))
      .run();
    return existing.id;
  }
  const id = newId();
  ctx.db
    .insert(tenantLanguages)
    .values({
      id,
      tenantId: ctx.tenantId,
      code: normalized,
      name,
      nativeName: opts.nativeName ?? null,
      direction: opts.direction ?? 'ltr',
      flagEmoji: flagEmoji ?? null,
      enabled: true,
    })
    .run();
  writeAudit(ctx, {
    module: 'settings',
    action: 'language_add',
    entity: 'tenant_language',
    entityId: id,
    reference: normalized,
    summary: `Language '${name}' (${normalized}) added`,
  });
  return id;
}

/** Rename, change direction, or activate/deactivate a language. Languages are
 *  archived (disabled), never destructively deleted once translations exist. */
export function updateLanguage(
  ctx: Ctx,
  languageId: string,
  patch: { name?: string; nativeName?: string; direction?: 'ltr' | 'rtl'; flagEmoji?: string | null; enabled?: boolean },
): void {
  const row = ctx.db
    .select()
    .from(tenantLanguages)
    .where(and(eq(tenantLanguages.tenantId, ctx.tenantId), eq(tenantLanguages.id, languageId)))
    .get();
  if (!row) notFound('language_missing', 'Language not found');
  if (row.code === 'en' && patch.enabled === false) {
    badRequest('base_language', 'English is the base/fallback language and cannot be deactivated');
  }
  const before = { name: row.name, direction: row.direction, enabled: row.enabled };
  ctx.db
    .update(tenantLanguages)
    .set({
      name: patch.name ?? row.name,
      nativeName: patch.nativeName ?? row.nativeName,
      direction: patch.direction ?? row.direction,
      flagEmoji: patch.flagEmoji === undefined ? row.flagEmoji : patch.flagEmoji,
      enabled: patch.enabled ?? row.enabled,
    })
    .where(eq(tenantLanguages.id, languageId))
    .run();
  writeAudit(ctx, {
    module: 'settings',
    action: 'language_update',
    entity: 'tenant_language',
    entityId: languageId,
    reference: row.code,
    summary: `Language '${row.name}' updated`,
    before,
    after: patch,
  });
}

/**
 * True while the language has CURRENT safe dependencies: a user has it as
 * their display language, or non-empty translation values exist for it.
 * Eligibility is DYNAMIC — clearing every translation (and freeing users)
 * makes a language permanently deletable again; an empty cleared row does
 * not lock it forever.
 */
export function languageEverUsed(ctx: Ctx, code: string): boolean {
  const userWith = ctx.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, ctx.tenantId), eq(users.language, code)))
    .limit(1)
    .get();
  if (userWith) return true;
  const translated = ctx.db
    .select({ id: translations.id })
    .from(translations)
    .where(
      and(
        eq(translations.tenantId, ctx.tenantId),
        eq(translations.language, code),
        ne(translations.text, ''),
      ),
    )
    .limit(1)
    .get();
  return translated != null;
}

/**
 * Permanent delete — only for an added language that was never used.
 * English (the base/fallback) can never be deleted; anything with translation
 * history or user usage must be archived (deactivated) instead.
 */
export function deleteLanguage(ctx: Ctx, languageId: string): void {
  const row = ctx.db
    .select()
    .from(tenantLanguages)
    .where(and(eq(tenantLanguages.tenantId, ctx.tenantId), eq(tenantLanguages.id, languageId)))
    .get();
  if (!row) notFound('language_missing', 'Language not found');
  if (row.code === 'en') {
    badRequest('base_language', 'English is the base/fallback language and cannot be deleted');
  }
  if (languageEverUsed(ctx, row.code)) {
    badRequest(
      'language_used',
      `'${row.name}' has translations or users and cannot be permanently deleted — archive it instead`,
    );
  }
  ctx.db.delete(tenantLanguages).where(eq(tenantLanguages.id, languageId)).run();
  writeAudit(ctx, {
    module: 'settings',
    action: 'language_delete',
    entity: 'tenant_language',
    entityId: languageId,
    reference: row.code,
    summary: `Unused language '${row.name}' permanently deleted`,
    before: { code: row.code, name: row.name },
  });
}

export function listLanguages(ctx: Ctx, opts: { includeDisabled?: boolean } = {}) {
  const conds = [eq(tenantLanguages.tenantId, ctx.tenantId)];
  if (!opts.includeDisabled) conds.push(eq(tenantLanguages.enabled, true));
  const rows = ctx.db
    .select()
    .from(tenantLanguages)
    .where(and(...conds))
    .all();
  // dynamic eligibility so the UI never offers an impossible Delete
  return rows.map((r) => ({
    ...r,
    deletable: r.code !== 'en' && !languageEverUsed(ctx, r.code),
  }));
}

/**
 * Full label bundle for a language, resolved through the layering contract:
 *   English base -> machine-seeded placeholder -> official JENIFY pack
 *   (global -> country -> sector) -> ACTIVE tenant override.
 * Official packs are DEFAULTS: a tenant's own deliberate wording always wins.
 * "Deliberate" means status='active' — unreviewed placeholder seeds are
 * better-than-English defaults, but a human-approved official translation
 * beats them; only a human-edited override beats official.
 */
export function getBundle(ctx: Ctx, language: string): Record<string, string> {
  const keys = ctx.db.select().from(translationKeys).all();
  const bundle: Record<string, string> = {};
  for (const k of keys) bundle[k.key] = k.enText;

  const overrides = ctx.db
    .select({
      key: translationKeys.key,
      text: translations.text,
      status: translations.status,
    })
    .from(translations)
    .innerJoin(translationKeys, eq(translations.keyId, translationKeys.id))
    .where(and(eq(translations.tenantId, ctx.tenantId), eq(translations.language, language)))
    .all();

  for (const o of overrides) {
    if (o.status === 'placeholder' && o.text.trim() !== '') bundle[o.key] = o.text;
  }
  if (language !== 'en') {
    const tenant = ctx.db
      .select({ country: tenants.country, sector: tenants.sector })
      .from(tenants)
      .where(eq(tenants.id, ctx.tenantId))
      .get();
    const official = getOfficialEntries(ctx.db, language, {
      country: tenant?.country,
      sector: tenant?.sector,
    });
    if (official.size > 0) {
      const keyById = new Map(keys.map((k) => [k.id, k.key]));
      for (const [keyId, value] of official) {
        const key = keyById.get(keyId);
        if (key && value.trim() !== '') bundle[key] = value;
      }
    }
  }
  for (const o of overrides) {
    if (o.status === 'active' && o.text.trim() !== '') bundle[o.key] = o.text;
  }
  return bundle;
}

/** Rows for the translation editor: key, English, per-language override + status. */
export function listTranslationRows(ctx: Ctx, opts: { module?: string } = {}) {
  const keys = ctx.db.select().from(translationKeys).all();
  const filtered = opts.module ? keys.filter((k) => k.module === opts.module) : keys;
  const overrides = ctx.db
    .select()
    .from(translations)
    .where(eq(translations.tenantId, ctx.tenantId))
    .all();
  const byKey = new Map<string, typeof overrides>();
  for (const o of overrides) {
    const list = byKey.get(o.keyId) ?? [];
    list.push(o);
    byKey.set(o.keyId, list);
  }
  return filtered.map((k) => ({
    key: k.key,
    module: k.module,
    en: k.enText,
    overrides: (byKey.get(k.id) ?? []).map((o) => ({
      language: o.language,
      text: o.text,
      status: o.status,
      updatedBy: o.updatedBy,
      updatedAt: o.updatedAt,
    })),
  }));
}

export function upsertTranslation(
  ctx: Ctx,
  key: string,
  language: string,
  text: string,
  status: 'placeholder' | 'active' = 'active',
): void {
  const keyRow = ctx.db.select().from(translationKeys).where(eq(translationKeys.key, key)).get();
  if (!keyRow) notFound('translation_key_missing', `Unknown translation key '${key}'`);
  const existing = ctx.db
    .select()
    .from(translations)
    .where(
      and(
        eq(translations.tenantId, ctx.tenantId),
        eq(translations.keyId, keyRow.id),
        eq(translations.language, language),
      ),
    )
    .get();
  const before = existing?.text ?? null;
  if (existing) {
    ctx.db
      .update(translations)
      .set({ text, status, updatedBy: actorId(ctx), updatedAt: nowIso() })
      .where(eq(translations.id, existing.id))
      .run();
  } else {
    ctx.db
      .insert(translations)
      .values({
        id: newId(),
        tenantId: ctx.tenantId,
        keyId: keyRow.id,
        language,
        text,
        status,
        updatedBy: actorId(ctx),
        updatedAt: nowIso(),
      })
      .run();
  }
  writeAudit(ctx, {
    module: 'settings',
    action: 'translation_edit',
    entity: 'translation',
    reference: `${key}/${language}`,
    summary: `Translation '${key}' (${language}) updated`,
    before,
    after: text,
  });
}
