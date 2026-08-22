import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { testDb, makeTestTenant, type TestTenant } from './helpers.js';
import {
  normalizeParsed,
  detectEntityType,
  suggestMapping,
  previewImport,
  executeImport,
} from '../src/services/importing.js';
import { createParty, listParties } from '../src/services/parties.js';
import { listItems } from '../src/services/masterdata.js';
import { getOnHand, listMovements } from '../src/services/inventory.js';

let db: Db;
let tt: TestTenant;

beforeEach(() => {
  db = testDb();
  tt = makeTestTenant(db, 'IMPT');
});

const KG = 1000; // milli base-units per kg

// Sample sheets as string[][] (row 0 = header) — the shape a CSV/XLSX parser yields.
const customerSheet = [
  ['Customer Name', 'Phone', 'Location'],
  ['Ato Gebre', '0911111111', 'Mekelle'],
  ['Weizero Hana', '0922222222', 'Adigrat'],
];
const supplierSheet = [
  ['Supplier Name', 'Phone', 'Address'],
  ['Red Sea Salt', '0933333333', 'Afar'],
];
const itemSheet = [
  ['Code', 'Product Name', 'Unit'],
  ['SALT-COARSE', 'Coarse Salt', 'kg'],
  ['SALT-FINE', 'Fine Salt', 'kg'],
];
const openingSheet = [
  ['Item', 'Warehouse', 'Quantity', 'Unit'],
  ['RAW', 'Warehouse A', '100', 'kg'],
  ['FG1', 'A', '250', 'pc'],
];

// ---------------------------------------------------------------------------
// DETECT + MAP for each of the four entity types
// ---------------------------------------------------------------------------

describe('detect + map', () => {
  it('detects a customer sheet and maps its columns', () => {
    const table = normalizeParsed(customerSheet);
    const det = detectEntityType(table);
    expect(det.entityType).toBe('customer');
    const map = suggestMapping(table, 'customer');
    expect(map.name).toBe('Customer Name');
    expect(map.phone).toBe('Phone');
    expect(map.location).toBe('Location');
  });

  it('detects a supplier sheet (keyword disambiguates from customer)', () => {
    const table = normalizeParsed(supplierSheet);
    const det = detectEntityType(table);
    expect(det.entityType).toBe('supplier');
    const map = suggestMapping(table, 'supplier');
    expect(map.name).toBe('Supplier Name');
    expect(map.location).toBe('Address');
  });

  it('detects an item/product master sheet and maps code/name/unit', () => {
    const table = normalizeParsed(itemSheet);
    const det = detectEntityType(table);
    expect(det.entityType).toBe('item');
    const map = suggestMapping(table, 'item');
    expect(map.code).toBe('Code');
    expect(map.name).toBe('Product Name');
    expect(map.unit).toBe('Unit');
  });

  it('detects an opening-inventory sheet and maps item/warehouse/qty/unit', () => {
    const table = normalizeParsed(openingSheet);
    const det = detectEntityType(table);
    expect(det.entityType).toBe('opening_inventory');
    const map = suggestMapping(table, 'opening_inventory');
    expect(map.item).toBe('Item');
    expect(map.warehouse).toBe('Warehouse');
    expect(map.qty).toBe('Quantity');
    expect(map.unit).toBe('Unit');
  });

  it('normalizes Record<string,string>[] input the same as a matrix', () => {
    const objForm = [
      { 'Customer Name': 'Ato Gebre', Phone: '0911111111', Location: 'Mekelle' },
    ];
    const table = normalizeParsed(objForm);
    expect(table.headers).toContain('Customer Name');
    expect(detectEntityType(table).entityType).toBe('customer');
  });
});

// ---------------------------------------------------------------------------
// VALIDATE — missing required fields are row errors, never invented defaults
// ---------------------------------------------------------------------------

describe('validation', () => {
  it('flags a missing required name as a row error and invents nothing', () => {
    const sheet = [
      ['Customer Name', 'Phone', 'Location'],
      ['', '0911111111', 'Mekelle'], // no name
      ['Ato Kebede', '0944444444', 'Wukro'],
    ];
    const plan = previewImport(tt.ownerCtx, sheet);
    expect(plan.entityType).toBe('customer');
    const bad = plan.rows[0];
    expect(bad.status).toBe('error');
    expect(bad.errors.some((e) => e.field === 'name')).toBe(true);
    // no fabricated value — the cleaned name stays absent
    expect(bad.cleaned.name).toBeUndefined();
    expect(plan.rows[1].status).toBe('ready');
  });

  it('rejects an item whose unit is not a known UoM (never invents a factor)', () => {
    const sheet = [
      ['Code', 'Product Name', 'Unit'],
      ['X1', 'Mystery Item', 'furlong'],
    ];
    const plan = previewImport(tt.ownerCtx, sheet);
    expect(plan.rows[0].status).toBe('error');
    expect(plan.rows[0].errors.some((e) => e.field === 'unit')).toBe(true);
  });

  it('rejects opening inventory for an unknown item or warehouse', () => {
    const sheet = [
      ['Item', 'Warehouse', 'Quantity'],
      ['GHOST', 'A', '10'],
      ['RAW', 'NoSuchStore', '10'],
    ];
    const plan = previewImport(tt.ownerCtx, sheet);
    expect(plan.rows[0].errors.some((e) => e.field === 'item')).toBe(true);
    expect(plan.rows[1].errors.some((e) => e.field === 'warehouse')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DEDUPLICATE — existing tenant data + within-file
// ---------------------------------------------------------------------------

describe('deduplication', () => {
  it('skips an existing customer and an in-file duplicate', () => {
    // existing customer in the DB
    createParty(tt.ownerCtx, { kind: 'customer', name: 'Ato Gebre', phone: '0911111111' });

    const sheet = [
      ['Customer Name', 'Phone', 'Location'],
      ['Ato Gebre', '0911111111', 'Mekelle'], // already exists
      ['Weizero Hana', '0922222222', 'Adigrat'], // new
      ['Weizero Hana', '0922222222', 'Adigrat'], // in-file duplicate of the new one
    ];
    const plan = previewImport(tt.ownerCtx, sheet);
    expect(plan.rows[0].status).toBe('duplicate');
    expect(plan.rows[0].duplicateOf).toBe('existing');
    expect(plan.rows[1].status).toBe('ready');
    expect(plan.rows[2].status).toBe('duplicate');
    expect(plan.rows[2].duplicateOf).toBe('in-file');
    expect(plan.counts).toMatchObject({ total: 3, ready: 1, duplicates: 2, errors: 0 });
  });
});

// ---------------------------------------------------------------------------
// PREVIEW — performs ZERO writes
// ---------------------------------------------------------------------------

describe('preview is read-only', () => {
  it('creates nothing when previewing customers', () => {
    const before = listParties(tt.ownerCtx, { kind: 'customer' }).length;
    previewImport(tt.ownerCtx, customerSheet);
    const after = listParties(tt.ownerCtx, { kind: 'customer' }).length;
    expect(after).toBe(before);
  });

  it('posts no movements when previewing opening inventory', () => {
    const before = listMovements(tt.ownerCtx, { documentKind: 'opening_inventory' }).length;
    const plan = previewImport(tt.ownerCtx, openingSheet);
    expect(plan.entityType).toBe('opening_inventory');
    expect(plan.counts.ready).toBe(2);
    const after = listMovements(tt.ownerCtx, { documentKind: 'opening_inventory' }).length;
    expect(after).toBe(before);
    // on-hand untouched by preview
    expect(getOnHand(tt.ownerCtx, tt.items.raw)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// IMPORT + RECONCILE
// ---------------------------------------------------------------------------

describe('import execution', () => {
  it('creates customers and reconciles counts', () => {
    const res = executeImport(tt.ownerCtx, customerSheet);
    expect(res.entityType).toBe('customer');
    expect(res.created).toBe(2);
    expect(res.reconcile.ok).toBe(true);
    expect(res.reconcile.expectedCreated).toBe(res.reconcile.actualCreated);
    const names = listParties(tt.ownerCtx, { kind: 'customer' }).map((p) => p.name);
    expect(names).toContain('Ato Gebre');
    expect(names).toContain('Weizero Hana');
  });

  it('creates items with the mapped base unit', () => {
    const res = executeImport(tt.ownerCtx, itemSheet);
    expect(res.created).toBe(2);
    const items = listItems(tt.ownerCtx);
    const coarse = items.find((i) => i.code === 'SALT-COARSE');
    expect(coarse).toBeTruthy();
    expect(coarse!.baseUomId).toBe(tt.uoms.kg);
  });

  it('posts opening inventory through the ledger and balances reflect it', () => {
    const res = executeImport(tt.ownerCtx, openingSheet);
    expect(res.entityType).toBe('opening_inventory');
    expect(res.created).toBe(2);

    // ledger shows audited adjustment movements
    const movs = listMovements(tt.ownerCtx, { documentKind: 'opening_inventory' });
    expect(movs.length).toBe(2);
    expect(movs.every((m) => m.movementType === 'adjustment')).toBe(true);

    // balances reflect the declared opening quantities
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(100 * KG);
    expect(getOnHand(tt.ownerCtx, tt.items.pack1kg, tt.warehouses.a)).toBe(250 * KG);

    // reconcile: source totals match the ledger
    expect(res.reconcile.ok).toBe(true);
    expect(res.reconcile.expectedQtyMilli).toBe(res.reconcile.actualQtyMilli);
    expect(res.reconcile.actualQtyMilli).toBe(350 * KG);
  });

  it('converts opening quantities through the mapped unit of measure', () => {
    const sheet = [
      ['Item', 'Warehouse', 'Quantity', 'Unit'],
      ['RAW', 'A', '2', 't'], // 2 tons -> 2000 kg
    ];
    const res = executeImport(tt.ownerCtx, sheet);
    expect(res.created).toBe(1);
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(2000 * KG);
  });
});

// ---------------------------------------------------------------------------
// IDEMPOTENCY — re-running the same file creates no duplicates
// ---------------------------------------------------------------------------

describe('idempotent re-import', () => {
  it('re-importing the same customer file creates nothing the second time', () => {
    const first = executeImport(tt.ownerCtx, customerSheet);
    expect(first.created).toBe(2);
    const countAfterFirst = listParties(tt.ownerCtx, { kind: 'customer' }).length;

    const second = executeImport(tt.ownerCtx, customerSheet);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(2);
    expect(listParties(tt.ownerCtx, { kind: 'customer' }).length).toBe(countAfterFirst);
  });

  it('re-importing the same opening-inventory file does not double-post the ledger', () => {
    const first = executeImport(tt.ownerCtx, openingSheet);
    expect(first.created).toBe(2);
    const onHandAfterFirst = getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a);

    const second = executeImport(tt.ownerCtx, openingSheet);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.plan.rows.every((r) => r.status === 'duplicate')).toBe(true);
    // balances unchanged; no second batch of movements
    expect(getOnHand(tt.ownerCtx, tt.items.raw, tt.warehouses.a)).toBe(onHandAfterFirst);
    expect(listMovements(tt.ownerCtx, { documentKind: 'opening_inventory' }).length).toBe(2);
  });
});
