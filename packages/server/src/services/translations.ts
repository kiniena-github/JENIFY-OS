import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { translationKeys, translations, tenantLanguages } from '../db/schema.js';
import { newId, nowIso, notFound } from '../util.js';
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
): void {
  const existing = ctx.db
    .select()
    .from(tenantLanguages)
    .where(and(eq(tenantLanguages.tenantId, ctx.tenantId), eq(tenantLanguages.code, code)))
    .get();
  if (existing) {
    ctx.db
      .update(tenantLanguages)
      .set({ name, flagEmoji: flagEmoji ?? existing.flagEmoji, enabled: true })
      .where(eq(tenantLanguages.id, existing.id))
      .run();
    return;
  }
  ctx.db
    .insert(tenantLanguages)
    .values({
      id: newId(),
      tenantId: ctx.tenantId,
      code,
      name,
      flagEmoji: flagEmoji ?? null,
      enabled: true,
    })
    .run();
}

export function listLanguages(ctx: Ctx) {
  return ctx.db
    .select()
    .from(tenantLanguages)
    .where(and(eq(tenantLanguages.tenantId, ctx.tenantId), eq(tenantLanguages.enabled, true)))
    .all();
}

/**
 * Full label bundle for a language: tenant override else English fallback.
 * Overrides apply to 'en' as well, so a tenant can relabel terminology
 * (e.g. "Receiving" -> "Raw Salt Receiving") without touching platform code.
 */
export function getBundle(ctx: Ctx, language: string): Record<string, string> {
  const keys = ctx.db.select().from(translationKeys).all();
  const bundle: Record<string, string> = {};
  for (const k of keys) bundle[k.key] = k.enText;
  const overrides = ctx.db
    .select({
      key: translationKeys.key,
      text: translations.text,
    })
    .from(translations)
    .innerJoin(translationKeys, eq(translations.keyId, translationKeys.id))
    .where(and(eq(translations.tenantId, ctx.tenantId), eq(translations.language, language)))
    .all();
  for (const o of overrides) {
    if (o.text.trim() !== '') bundle[o.key] = o.text;
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
