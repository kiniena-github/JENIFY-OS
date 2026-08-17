// Client-side mirrors of API row shapes (pragmatic subset).

export interface Item {
  id: string;
  code: string;
  name: string;
  kind: string;
  trackingMode: string;
  baseUomId: string;
  unitWeightMilliKg: number | null;
  sellable: boolean;
  purchasable: boolean;
  attributes: Record<string, unknown> | null;
  active: boolean;
}

export interface Uom {
  id: string;
  code: string;
  name: string;
  family: string;
  factorToBase: number;
}

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  locationNote: string | null;
  active: boolean;
}

export interface Party {
  id: string;
  kind: string;
  name: string;
  partyType: string | null;
  phone: string | null;
  location: string | null;
  taxInfo: string | null;
  creditLimitCents: number | null;
  notes: string | null;
  active: boolean;
}

export interface Receipt {
  id: string;
  docNumber: string;
  date: string;
  supplierId: string;
  source: string | null;
  truckNumber: string | null;
  driverName: string | null;
  itemId: string;
  grossQty: number | null;
  netQty: number;
  entryUomId: string;
  warehouseId: string;
  lifecycle: string;
  lotId: string | null;
  createdAt: string;
}

export interface Transfer {
  id: string;
  docNumber: string;
  date: string;
  itemId: string;
  lotId: string | null;
  qty: number;
  fromWarehouseId: string;
  toWarehouseId: string;
  reason: string | null;
  lifecycle: string;
  createdAt: string;
}

export interface StockRow {
  itemId: string;
  itemCode: string;
  itemName: string;
  itemKind: string;
  unitWeightMilliKg: number | null;
  lotId: string | null;
  lotNumber: string | null;
  lotSource: string | null;
  receivedAt: string | null;
  initialQty: number | null;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  onHand: number;
  reserved: number;
  inProcess: number;
  available: number;
  status: string;
}

export interface Movement {
  id: string;
  itemId: string;
  lotId: string | null;
  warehouseId: string;
  qty: number;
  movementType: string;
  documentKind: string;
  documentId: string;
  documentNumber: string | null;
  note: string | null;
  postedAt: string;
}
