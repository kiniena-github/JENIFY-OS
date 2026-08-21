import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { testDb, makeTestTenant, matrixOf, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import { tenants, translationKeys, translations } from '../src/db/schema.js';
import { newId, nowIso } from '../src/util.js';
import {
  registerTranslationKeys,
  upsertTranslation,
  getBundle,
} from '../src/services/translations.js';
import {
  aggregateTranslationUsage,
  recommendOfficialCandidates,
  decideTranslation,
  rollbackOfficialTranslation,
  languagePackHistory,
  normalizeTranslationValue,
} from '../src/services/languageIntel.js';
import { createRole } from '../src/services/permissions.js';
import { createUser } from '../src/services/users.js';
import { buildSessionUser } from '../src/services/auth.js';
import type { Ctx } from '../src/services/context.js';

/**
 * QA simulation scenarios 5-10 of the Mobile+Offline+Language mission:
 * many companies contribute translation variants; one becomes dominant; a
 * human language authority approves an official translation; overrides
 * survive; new companies inherit; rollback restores without destroying
 * history. Plus privacy (counts only) and authority guards.
 */

const KEY = 'nav.inventory';
const AM = 'am';
// Distinct Amharic-script variants (values are what matters, not linguistic accuracy)
const VARIANT_A = 'ዕቃ ግምጃ ቤት';
const VARIANT_B = 'ኢንቬንቶሪ';
const VARIANT_C = 'የዕቃ ዝርዝር';

let db: Db;
let tt: TestTenant; // the reviewing platform tenant ("JENIFY HQ" stand-in)

/** Insert a bare simulated company with one active am-translation for KEY. */
function simulateCompany(
  db: Db,
  n: number,
  text: string,
  opts: { sector?: string; country?: string } = {},
): string {
  const id = newId();
  db.insert(tenants)
    .values({
      id,
      code: `SIM${n}`,
      name: `Simulated Co ${n}`,
      currency: 'ETB',
      timezone: 'Africa/Addis_Ababa',
      sector: opts.sector ?? null,
      country: opts.country ?? null,
      createdAt: nowIso(),
    })
    .run();
  const keyRow = db.select().from(translationKeys).where(eq(translationKeys.key, KEY)).get()!;
  db.insert(translations)
    .values({
      id: newId(),
      tenantId: id,
      keyId: keyRow.id,
      language: AM,
      text,
      status: 'active',
      updatedAt: nowIso(),
    })
    .run();
  return id;
}

/** Mission example distribution: A=73 orgs, B=14, C=5, other singleton variants=8. */
function seedHundredCompanies(db: Db): void {
  const sectors = ['manufacturing', 'retail', 'wholesale', 'construction'];
  let n = 0;
  for (let i = 0; i < 73; i++) simulateCompany(db, n++, VARIANT_A, { sector: sectors[i % 4], country: 'ET' });
  for (let i = 0; i < 14; i++) simulateCompany(db, n++, VARIANT_B, { sector: sectors[i % 2], country: 'ET' });
  for (let i = 0; i < 5; i++) simulateCompany(db, n++, VARIANT_C, { sector: 'retail', country: 'ET' });
  for (let i = 0; i < 8; i++) simulateCompany(db, n++, `ልዩ-${i}`, { sector: 'retail', country: 'ET' });
}

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'HQ');
  registerTranslationKeys(db, [{ key: KEY, en: 'Inventory', module: 'inventory' }]);
});

describe('scenario 5+6 — aggregation across 100 companies with a dominant variant', () => {
  it('ranks variants with counts and shares, counts each org once', () => {
    seedHundredCompanies(db);
    const [agg] = aggregateTranslationUsage(db, AM, { key: KEY });
    expect(agg).toBeDefined();
    expect(agg!.totalOrgs).toBe(100);
    expect(agg!.variants[0]).toMatchObject({ value: VARIANT_A, orgCount: 73, sharePct: 73 });
    expect(agg!.variants[1]).toMatchObject({ value: VARIANT_B, orgCount: 14 });
    expect(agg!.variants[2]).toMatchObject({ value: VARIANT_C, orgCount: 5 });
  });

  it('groups whitespace/unicode-normalization-equal spellings as one variant', () => {
    simulateCompany(db, 500, `  ${VARIANT_A}  `);
    simulateCompany(db, 501, VARIANT_A.normalize('NFD')); // decomposed form
    simulateCompany(db, 502, VARIANT_A);
    const [agg] = aggregateTranslationUsage(db, AM, { key: KEY });
    expect(agg!.variants[0]!.orgCount).toBe(3);
    expect(normalizeTranslationValue(` a  b `)).toBe('a b');
  });

  it('ignores machine-seeded placeholders and inactive tenants', () => {
    const active = simulateCompany(db, 600, VARIANT_A);
    const placeholderTenant = simulateCompany(db, 601, VARIANT_B);
    db.update(translations)
      .set({ status: 'placeholder' })
      .where(eq(translations.tenantId, placeholderTenant))
      .run();
    const inactive = simulateCompany(db, 602, VARIANT_C);
    db.update(tenants).set({ active: false }).where(eq(tenants.id, inactive)).run();
    const [agg] = aggregateTranslationUsage(db, AM, { key: KEY });
    expect(agg!.totalOrgs).toBe(1);
    expect(agg!.variants).toHaveLength(1);
    expect(agg!.variants[0]!.value).toBe(VARIANT_A);
    expect(active).toBeTruthy();
  });

  it('privacy: output contains counts only — no tenant ids or names anywhere', () => {
    seedHundredCompanies(db);
    const serialized = JSON.stringify(aggregateTranslationUsage(db, AM));
    expect(serialized).not.toContain('SIM');
    expect(serialized).not.toContain('Simulated Co');
    const anyTenantId = db.select({ id: tenants.id }).from(tenants).all()[5]!.id;
    expect(serialized).not.toContain(anyTenantId);
  });

  it('privacy: minShow threshold collapses rare variants into an anonymous bucket', () => {
    seedHundredCompanies(db);
    const [agg] = aggregateTranslationUsage(db, AM, { key: KEY, minShow: 6 });
    // only A (73) and B (14) clear the threshold; C (5) + 8 singletons collapse
    expect(agg!.variants.map((v) => v.value)).toEqual([VARIANT_A, VARIANT_B]);
    expect(agg!.otherVariantCount).toBe(9);
    expect(agg!.otherOrgCount).toBe(13);
  });

  it('recommends the dominant variant with high confidence and explains why', () => {
    seedHundredCompanies(db);
    const recs = recommendOfficialCandidates(db, AM);
    const rec = recs.find((r) => r.key === KEY)!;
    expect(rec.recommended.value).toBe(VARIANT_A);
    expect(rec.confidence).toBe('high');
    expect(rec.reasons.join(' ')).toContain('73 of 100');
    expect(rec.reasons.join(' ')).toContain('sectors');
    expect(rec.totalOrgs).toBe(100);
  });

  it('withholds recommendations below the minimum-organization threshold', () => {
    simulateCompany(db, 700, VARIANT_A);
    simulateCompany(db, 701, VARIANT_A);
    expect(recommendOfficialCandidates(db, AM)).toHaveLength(0); // 2 orgs < 3
  });
});

describe('scenario 7 — human approval creates a versioned official pack', () => {
  it('approve records who/when/why and produces pack v1', () => {
    seedHundredCompanies(db);
    const { packVersion } = decideTranslation(tt.ownerCtx, {
      key: KEY,
      language: AM,
      decision: 'approve',
      value: VARIANT_A,
      reason: 'Dominant usage, reviewed by language admin',
    });
    expect(packVersion).toBe(1);
    const history = languagePackHistory(db, AM);
    expect(history.packs[0]).toMatchObject({ version: 1, status: 'official', scope: 'global' });
    expect(history.decisions[0]).toMatchObject({
      key: KEY,
      decision: 'approve',
      value: VARIANT_A,
      previousValue: null,
      decidedBy: tt.ownerUserId,
    });
    expect(history.decisions[0]!.reason).toContain('language admin');
  });

  it('reject/defer record decisions without creating any pack', () => {
    seedHundredCompanies(db);
    decideTranslation(tt.ownerCtx, { key: KEY, language: AM, decision: 'reject', value: VARIANT_B, reason: 'misspelling' });
    decideTranslation(tt.ownerCtx, { key: KEY, language: AM, decision: 'defer' });
    const history = languagePackHistory(db, AM);
    expect(history.packs).toHaveLength(0);
    expect(history.decisions.map((d) => d.decision)).toEqual(['defer', 'reject']);
  });

  it('a dominant variant that is already official is not re-recommended', () => {
    seedHundredCompanies(db);
    decideTranslation(tt.ownerCtx, { key: KEY, language: AM, decision: 'approve', value: VARIANT_A, reason: 'r' });
    expect(recommendOfficialCandidates(db, AM).find((r) => r.key === KEY)).toBeUndefined();
  });

  it('sector-specific decision creates a scoped variant pack that only that sector resolves', () => {
    decideTranslation(tt.ownerCtx, { key: KEY, language: AM, decision: 'approve', value: VARIANT_A, reason: 'global' });
    decideTranslation(tt.ownerCtx, {
      key: KEY,
      language: AM,
      decision: 'sector_specific',
      value: VARIANT_C,
      scopeValue: 'retail',
      reason: 'retail wording',
    });
    // manufacturing tenant sees the global value; retail tenant sees the sector variant
    db.update(tenants).set({ sector: 'manufacturing' }).where(eq(tenants.id, tt.tenantId)).run();
    expect(getBundle(tt.ownerCtx, AM)[KEY]).toBe(VARIANT_A);
    db.update(tenants).set({ sector: 'retail' }).where(eq(tenants.id, tt.tenantId)).run();
    expect(getBundle(tt.ownerCtx, AM)[KEY]).toBe(VARIANT_C);
  });
});

describe('authority guard — official decisions are human + owner-role only', () => {
  it('a manager with settings edit (but not owner role) is rejected', () => {
    const managerRole = createRole(tt.sysCtx, {
      code: 'mgr',
      name: 'Manager',
      matrix: matrixOf([['settings', ['view', 'edit', 'approve']]]),
    });
    const managerId = createUser(tt.sysCtx, {
      username: 'mgr',
      displayName: 'Manager',
      password: 'test-password',
      roleId: managerRole,
    });
    const mgrCtx: Ctx = { db, tenantId: tt.tenantId, user: buildSessionUser(db, managerId)! };
    expect(() =>
      decideTranslation(mgrCtx, { key: KEY, language: AM, decision: 'approve', value: VARIANT_A, reason: 'x' }),
    ).toThrowError(/owner role/);
    expect(() =>
      rollbackOfficialTranslation(mgrCtx, { key: KEY, language: AM, reason: 'x' }),
    ).toThrowError(/owner role/);
  });

  it('approve without a value is rejected', () => {
    expect(() =>
      decideTranslation(tt.ownerCtx, { key: KEY, language: AM, decision: 'approve', reason: 'x' }),
    ).toThrowError(/value is required/);
  });

  it('unknown decisions and oversized inputs never reach the append-only ledger', () => {
    expect(() =>
      decideTranslation(tt.ownerCtx, {
        key: KEY,
        language: AM,
        // route bodies are unvalidated JSON — the service is the enforcement point
        decision: 'promote_everything' as never,
        value: VARIANT_A,
      }),
    ).toThrowError(/Unknown review decision/);
    expect(() =>
      decideTranslation(tt.ownerCtx, {
        key: KEY,
        language: AM,
        decision: 'approve',
        value: 'x'.repeat(501),
      }),
    ).toThrowError(/500 characters/);
    expect(() =>
      decideTranslation(tt.ownerCtx, {
        key: KEY,
        language: '  ',
        decision: 'approve',
        value: VARIANT_A,
      }),
    ).toThrowError(/language code/);
    expect(languagePackHistory(db, AM).decisions).toHaveLength(0);
  });

  it('k-suppression extends to recommendation alternatives', () => {
    seedHundredCompanies(db);
    const rec = recommendOfficialCandidates(db, AM).find((r) => r.key === KEY)!;
    // B (14 orgs) and C (5 orgs) may appear; the 8 single-company variants never
    expect(rec.alternatives.map((v) => v.value)).toEqual([VARIANT_B, VARIANT_C]);
    expect(rec.alternatives.every((v) => v.orgCount >= 3)).toBe(true);
  });
});

describe('HTTP route guards — /api/language-intel/*', () => {
  async function loginCookie(app: ReturnType<typeof buildApp>, username: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password: 'test-password' },
    });
    expect(res.statusCode).toBe(200);
    const raw = res.headers['set-cookie'];
    return (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!;
  }

  it('non-owner gets 403 on every endpoint; owner passes; k-floor and language param hold over HTTP', async () => {
    seedHundredCompanies(db);
    const managerRole = createRole(tt.sysCtx, {
      code: 'mgr2',
      name: 'Manager2',
      matrix: matrixOf([['settings', ['view', 'edit', 'approve']]]),
    });
    createUser(tt.sysCtx, {
      username: 'mgr.http',
      displayName: 'Manager Http',
      password: 'test-password',
      roleId: managerRole,
    });
    const app = buildApp({ db });
    const owner = await loginCookie(app, `owner.${'HQ'.toLowerCase()}`);
    const mgr = await loginCookie(app, 'mgr.http');

    const endpoints: Array<[string, string, unknown?]> = [
      ['GET', `/api/language-intel/aggregate?language=${AM}`],
      ['GET', `/api/language-intel/recommendations?language=${AM}`],
      ['GET', `/api/language-intel/history?language=${AM}`],
      ['POST', '/api/language-intel/decision', { key: KEY, language: AM, decision: 'approve', value: VARIANT_A, reason: 'r' }],
      ['POST', '/api/language-intel/rollback', { key: KEY, language: AM, reason: 'r' }],
    ];
    for (const [method, url, payload] of endpoints) {
      const res = await app.inject({ method: method as 'GET' | 'POST', url, payload: payload as object, headers: { cookie: mgr } });
      expect(res.statusCode, `${method} ${url} as manager`).toBe(403);
    }

    // owner: aggregate works, and requesting minShow=1 cannot lower the k-floor
    const agg = await app.inject({
      method: 'GET',
      url: `/api/language-intel/aggregate?language=${AM}&minShow=1`,
      headers: { cookie: owner },
    });
    expect(agg.statusCode).toBe(200);
    const rows = agg.json() as Array<{ variants: Array<{ orgCount: number }>; otherVariantCount: number }>;
    const forKey = rows.find((r) => (r as { key?: string }).key === KEY)!;
    expect(forKey.variants.every((v) => v.orgCount >= 3)).toBe(true);
    expect(forKey.otherVariantCount).toBeGreaterThan(0); // singletons stayed suppressed

    // missing language param is a 400, not a 500
    const missing = await app.inject({
      method: 'GET',
      url: '/api/language-intel/aggregate',
      headers: { cookie: owner },
    });
    expect(missing.statusCode).toBe(400);

    // owner decision over HTTP succeeds end-to-end
    const decide = await app.inject({
      method: 'POST',
      url: '/api/language-intel/decision',
      payload: { key: KEY, language: AM, decision: 'approve', value: VARIANT_A, reason: 'via http' },
      headers: { cookie: owner },
    });
    expect(decide.statusCode).toBe(200);
    expect((decide.json() as { packVersion: number }).packVersion).toBe(1);
    await app.close();
  });
});

describe('layering: placeholder seeds sit below official packs', () => {
  it('official beats an unreviewed placeholder; a deliberate (active) override beats official', () => {
    // machine-seeded placeholder (e.g. Mesob am/ti seed rows)
    upsertTranslation(tt.ownerCtx, KEY, AM, 'ያልተገመገመ ዘር', 'placeholder');
    expect(getBundle(tt.ownerCtx, AM)[KEY]).toBe('ያልተገመገመ ዘር'); // better than English until review
    decideTranslation(tt.ownerCtx, { key: KEY, language: AM, decision: 'approve', value: VARIANT_A, reason: 'r' });
    expect(getBundle(tt.ownerCtx, AM)[KEY]).toBe(VARIANT_A); // official wins over placeholder
    upsertTranslation(tt.ownerCtx, KEY, AM, 'የኛ ቃል', 'active');
    expect(getBundle(tt.ownerCtx, AM)[KEY]).toBe('የኛ ቃል'); // deliberate wording always wins
  });
});

describe('scenarios 8+9 — layering: overrides survive, new companies inherit', () => {
  it('a company override still wins after an official pack changes', () => {
    upsertTranslation(tt.ownerCtx, KEY, AM, 'የመሶብ ግምጃ', 'active'); // company's own wording
    decideTranslation(tt.ownerCtx, { key: KEY, language: AM, decision: 'approve', value: VARIANT_A, reason: 'r' });
    expect(getBundle(tt.ownerCtx, AM)[KEY]).toBe('የመሶብ ግምጃ');
  });

  it('a company without an override receives the official translation automatically', () => {
    decideTranslation(tt.ownerCtx, { key: KEY, language: AM, decision: 'approve', value: VARIANT_A, reason: 'r' });
    const fresh = makeTestTenant(db, 'NEWCO');
    expect(getBundle(fresh.ownerCtx, AM)[KEY]).toBe(VARIANT_A);
    // and English base remains untouched for languages without packs
    expect(getBundle(fresh.ownerCtx, 'en')[KEY]).toBe('Inventory');
  });
});

describe('scenario 10 — rollback preserves history', () => {
  it('rolling back a second approval restores the first value in a NEW version', () => {
    decideTranslation(tt.ownerCtx, { key: KEY, language: AM, decision: 'approve', value: VARIANT_A, reason: 'first' });
    decideTranslation(tt.ownerCtx, { key: KEY, language: AM, decision: 'approve', value: VARIANT_B, reason: 'second (wrong)' });
    const fresh = makeTestTenant(db, 'OBSERVER');
    expect(getBundle(fresh.ownerCtx, AM)[KEY]).toBe(VARIANT_B);

    const { packVersion } = rollbackOfficialTranslation(tt.ownerCtx, {
      key: KEY,
      language: AM,
      reason: 'second approval was a mistake',
    });
    expect(packVersion).toBe(3);
    expect(getBundle(fresh.ownerCtx, AM)[KEY]).toBe(VARIANT_A);

    const history = languagePackHistory(db, AM);
    expect(history.packs.map((p) => [p.version, p.status])).toEqual([
      [3, 'official'],
      [2, 'superseded'],
      [1, 'superseded'],
    ]);
    const rb = history.decisions.find((d) => d.decision === 'rollback')!;
    expect(rb).toMatchObject({ previousValue: VARIANT_B, value: VARIANT_A });
    expect(rb.reason).toContain('mistake');
  });

  it('rolling back the only approval removes the entry and restores base fallback', () => {
    decideTranslation(tt.ownerCtx, { key: KEY, language: AM, decision: 'approve', value: VARIANT_A, reason: 'r' });
    rollbackOfficialTranslation(tt.ownerCtx, { key: KEY, language: AM, reason: 'not ready' });
    expect(getBundle(tt.ownerCtx, AM)[KEY]).toBe('Inventory');
  });

  it('rollback demands a reason and an existing official entry', () => {
    expect(() =>
      rollbackOfficialTranslation(tt.ownerCtx, { key: KEY, language: AM, reason: '' }),
    ).toThrowError(/reason/);
    decideTranslation(tt.ownerCtx, { key: KEY, language: AM, decision: 'approve', value: VARIANT_A, reason: 'r' });
    registerTranslationKeys(db, [{ key: 'nav.other', en: 'Other' }]);
    expect(() =>
      rollbackOfficialTranslation(tt.ownerCtx, { key: 'nav.other', language: AM, reason: 'x' }),
    ).toThrowError(/no official translation/);
  });
});
