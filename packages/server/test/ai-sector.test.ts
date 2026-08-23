import { beforeEach, describe, expect, it } from 'vitest';
import { SECTORS, SECTOR_BY_ID, sectorTemplateLayer } from '@factoryos/shared/sectors';
import { testDb, makeTestTenant, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import { publishTemplateLayer, bindTenantTemplate } from '../src/services/templates.js';
import { tenantSector, sectorContext, sectorRefusal, sectorCapabilityStatement } from '../src/services/aiSector.js';

let db: Db;
let tt: TestTenant;

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'AIS');
  publishTemplateLayer(tt.sysCtx, {
    templateId: 'core', kind: 'core', labelKey: 'template.core',
    activations: { parties: 'required', inventory: 'required', reports: 'required' },
  });
});

/** Bind this tenant to a sector so the AI knows which business it is inside. */
function bindSector(sectorId: string): void {
  const layer = sectorTemplateLayer(SECTOR_BY_ID.get(sectorId)!, 'small');
  publishTemplateLayer(tt.sysCtx, {
    templateId: layer.templateId, kind: 'sector', labelKey: layer.labelKey,
    extendsId: layer.extendsId, activations: layer.activations, config: layer.config,
  });
  bindTenantTemplate(tt.sysCtx, [{ templateId: 'core' }, { templateId: sectorId }]);
}

describe('AI sector mastery (§24)', () => {
  it('resolves the tenant sector from its own template binding', () => {
    expect(tenantSector(tt.ownerCtx)).toBeNull(); // unbound tenant has no sector
    bindSector('sector.hospitality');
    expect(tenantSector(tt.ownerCtx)?.id).toBe('sector.hospitality');
  });

  it('gives the assistant business + role + permission context, not a generic chatbot', () => {
    bindSector('sector.manufacturing');
    const c = sectorContext(tt.ownerCtx);
    expect(c.sectorId).toBe('sector.manufacturing');
    expect(c.mastery?.understands.join(' ')).toContain('batches');
    expect(c.capabilities).toEqual(expect.arrayContaining(['production', 'inventory']));
    expect(c.roleName).toBe('Owner');
    expect(c.availableIntents.length).toBeGreaterThan(0);
  });

  it('two different sectors give the SAME core two different mastery models', () => {
    bindSector('sector.logistics');
    const logistics = sectorContext(tt.ownerCtx).mastery!;
    const hotelTenant = makeTestTenant(db, 'HOTEL');
    const layer = sectorTemplateLayer(SECTOR_BY_ID.get('sector.hospitality')!, 'small');
    publishTemplateLayer(hotelTenant.sysCtx, {
      templateId: layer.templateId, kind: 'sector', labelKey: layer.labelKey,
      extendsId: layer.extendsId, activations: layer.activations, config: layer.config,
    });
    bindTenantTemplate(hotelTenant.sysCtx, [{ templateId: 'core' }, { templateId: 'sector.hospitality' }]);
    const hotel = sectorContext(hotelTenant.ownerCtx).mastery!;
    expect(logistics.understands.join(' ')).toContain('drivers');
    expect(hotel.understands.join(' ')).toContain('occupancy');
    expect(logistics.understands).not.toEqual(hotel.understands);
  });
});

// ---------------------------------------------------------------------------
// The safety property: sector limits are ENFORCED, not merely documented
// ---------------------------------------------------------------------------
describe('sector guard rails (§27) — hard refusals', () => {
  it('a healthcare tenant REFUSES clinical questions however phrased', () => {
    bindSector('sector.healthcare');
    for (const q of [
      'what is the right dosage for this patient',
      'can you diagnose these symptoms',
      'what treatment do you recommend',
      'should I prescribe antibiotics',
    ]) {
      const r = sectorRefusal(tt.ownerCtx, q);
      expect(r, `should refuse: ${q}`).not.toBeNull();
      expect(r!.refused).toBe(true);
      expect(r!.reason).toMatch(/qualified professional/);
    }
  });

  it('a healthcare tenant still ANSWERS legitimate administrative questions', () => {
    bindSector('sector.healthcare');
    expect(sectorRefusal(tt.ownerCtx, 'who has unpaid bills')).toBeNull();
    expect(sectorRefusal(tt.ownerCtx, 'how many appointments today')).toBeNull();
  });

  it('a pharmacy REFUSES medical advice but answers stock questions', () => {
    bindSector('sector.pharmacy');
    expect(sectorRefusal(tt.ownerCtx, 'what dose should this customer take')).not.toBeNull();
    expect(sectorRefusal(tt.ownerCtx, 'is it safe to take with alcohol')).not.toBeNull();
    expect(sectorRefusal(tt.ownerCtx, 'what medicines expire this month')).toBeNull();
  });

  it('a government tenant REFUSES to decide a citizen case', () => {
    bindSector('sector.government');
    expect(sectorRefusal(tt.ownerCtx, 'approve the application for this citizen')).not.toBeNull();
    expect(sectorRefusal(tt.ownerCtx, 'deny the application')).not.toBeNull();
    expect(sectorRefusal(tt.ownerCtx, 'how many open cases are there')).toBeNull();
  });

  it('agriculture refuses chemical dosing advice; mining refuses safety clearance', () => {
    bindSector('sector.agriculture');
    expect(sectorRefusal(tt.ownerCtx, 'what pesticide dose should I use')).not.toBeNull();
    const mine = makeTestTenant(db, 'MINE');
    const layer = sectorTemplateLayer(SECTOR_BY_ID.get('sector.mining')!, 'advanced');
    publishTemplateLayer(mine.sysCtx, {
      templateId: layer.templateId, kind: 'sector', labelKey: layer.labelKey,
      extendsId: layer.extendsId, activations: layer.activations, config: layer.config,
    });
    publishTemplateLayer(mine.sysCtx, { templateId: 'core', kind: 'core', labelKey: 'template.core', activations: { parties: 'required', inventory: 'required', reports: 'required' } });
    bindTenantTemplate(mine.sysCtx, [{ templateId: 'core' }, { templateId: 'sector.mining' }]);
    expect(sectorRefusal(mine.ownerCtx, 'is it safe to enter shaft 3')).not.toBeNull();
  });

  it('an unguarded sector (retail) refuses nothing by keyword — guards are opt-in per risk', () => {
    bindSector('sector.retail');
    expect(sectorRefusal(tt.ownerCtx, 'what sold today')).toBeNull();
    expect(sectorRefusal(tt.ownerCtx, 'anything at all')).toBeNull();
  });

  it('every safety-critical sector declares ENFORCEABLE guards, not just prose', () => {
    for (const id of ['sector.healthcare', 'sector.pharmacy', 'sector.government', 'sector.agriculture', 'sector.mining']) {
      const s = SECTOR_BY_ID.get(id)!;
      expect(s.ai.guardKeywords?.length, `${id} needs enforceable guards`).toBeGreaterThan(0);
    }
  });

  it('the capability statement is honest about limits', () => {
    bindSector('sector.healthcare');
    const st = sectorCapabilityStatement(tt.ownerCtx);
    expect(st.willNeverDo.join(' ').toLowerCase()).toContain('clinical');
    expect(st.canAnswer.length).toBeGreaterThan(0);
  });

  it('an unbound tenant has no sector guard and no sector claims', () => {
    expect(sectorRefusal(tt.ownerCtx, 'diagnose me')).toBeNull();
    expect(sectorCapabilityStatement(tt.ownerCtx).sectorId).toBeNull();
  });

  it('all 20 sectors declare an AI mastery model with explicit limits', () => {
    for (const s of SECTORS) {
      expect(s.ai.neverDoes.length, s.id).toBeGreaterThan(0);
      expect(s.ai.answers.length, s.id).toBeGreaterThan(0);
    }
  });
});
