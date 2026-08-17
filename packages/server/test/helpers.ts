import type { ActionId, ModuleId, PermissionMatrix } from '@factoryos/shared';
import { ACTIONS, MODULES } from '@factoryos/shared';
import { createDb, type Db } from '../src/db/index.js';
import type { Ctx } from '../src/services/context.js';
import { createTenant } from '../src/services/provisioning.js';
import { createRole } from '../src/services/permissions.js';
import { createUser } from '../src/services/users.js';
import { buildSessionUser } from '../src/services/auth.js';
import { createUom, createItem, createWarehouse } from '../src/services/masterdata.js';
import { defineSequence } from '../src/services/numbering.js';

export function testDb(): Db {
  return createDb(':memory:');
}

export function fullMatrix(): PermissionMatrix {
  const m: PermissionMatrix = {};
  for (const mod of MODULES) {
    m[mod] = {};
    for (const act of ACTIONS) m[mod]![act] = true;
  }
  return m;
}

export function matrixOf(entries: Array<[ModuleId, ActionId[]]>): PermissionMatrix {
  const m: PermissionMatrix = {};
  for (const [mod, acts] of entries) {
    m[mod] = {};
    for (const a of acts) m[mod]![a] = true;
  }
  return m;
}

export interface TestTenant {
  db: Db;
  tenantId: string;
  /** system ctx (no user) for provisioning */
  sysCtx: Ctx;
  /** ctx authenticated as the owner */
  ownerCtx: Ctx;
  ownerRoleId: string;
  ownerUserId: string;
  uoms: { kg: string; ton: string; quintal: string; piece: string };
  items: { raw: string; pack1kg: string };
  warehouses: { a: string; b: string; c: string };
}

/** Provision a complete process-manufacturing test tenant ("SaltCo"). */
export function makeTestTenant(db: Db, code: string): TestTenant {
  const { tenantId, ctx: sysCtx } = createTenant(db, {
    code,
    name: `${code} Test Factory`,
    currency: 'ETB',
    timezone: 'Africa/Addis_Ababa',
  });

  const ownerRoleId = createRole(sysCtx, {
    code: 'owner',
    name: 'Owner',
    isOwnerRole: true,
    matrix: fullMatrix(),
  });
  const ownerUserId = createUser(sysCtx, {
    username: `owner.${code.toLowerCase()}`,
    displayName: `${code} Owner`,
    password: 'test-password',
    roleId: ownerRoleId,
  });
  const ownerUser = buildSessionUser(db, ownerUserId)!;
  const ownerCtx: Ctx = { db, tenantId, user: ownerUser };

  const kg = createUom(sysCtx, { code: 'kg', name: 'Kilogram', family: 'mass', factorToBase: 1 });
  const ton = createUom(sysCtx, { code: 't', name: 'Ton', family: 'mass', factorToBase: 1000 });
  const quintal = createUom(sysCtx, {
    code: 'q',
    name: 'Quintal',
    family: 'mass',
    factorToBase: 100,
  });
  const piece = createUom(sysCtx, {
    code: 'pc',
    name: 'Piece',
    family: 'count',
    factorToBase: 1,
  });

  const raw = createItem(sysCtx, {
    code: 'RAW',
    name: 'Raw Material',
    kind: 'raw_material',
    trackingMode: 'lot',
    baseUomId: kg,
    purchasable: true,
    sellable: true,
  });
  const pack1kg = createItem(sysCtx, {
    code: 'FG1',
    name: 'Finished 1kg',
    kind: 'finished_good',
    trackingMode: 'lot',
    baseUomId: piece,
    unitWeightKg: 1,
    sellable: true,
  });

  const a = createWarehouse(sysCtx, { code: 'A', name: 'Warehouse A' });
  const b = createWarehouse(sysCtx, { code: 'B', name: 'Warehouse B' });
  const c = createWarehouse(sysCtx, { code: 'C', name: 'Warehouse C' });

  for (const [key, prefix] of [
    ['receiving', 'RCV-'],
    ['lot.raw', 'RAW-'],
    ['transfer', 'TRF-'],
    ['invoice', 'INV-'],
    ['delivery', 'DEL-'],
    ['payment', 'PAY-'],
  ] as const) {
    defineSequence(sysCtx, key, prefix, 4);
  }

  return {
    db,
    tenantId,
    sysCtx,
    ownerCtx,
    ownerRoleId,
    ownerUserId,
    uoms: { kg, ton, quintal, piece },
    items: { raw, pack1kg },
    warehouses: { a, b, c },
  };
}
