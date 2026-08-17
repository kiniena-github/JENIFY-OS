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

export interface StageAttrDef {
  key: string;
  labelKey: string;
  type: 'number' | 'text';
  unit?: string;
  required?: boolean;
}

export interface Stage {
  id: string;
  code: string;
  nameKey: string;
  sequence: number;
  inputSource: 'lot' | 'prior_batch';
  outputForm: 'bulk' | 'packaged_items';
  requiresQc: boolean;
  inputItemId: string | null;
  priorStageId: string | null;
  outputItemIds: string[] | null;
  attributes: StageAttrDef[] | null;
  docSeqKey: string;
}

export interface Batch {
  id: string;
  stageId: string;
  docNumber: string;
  date: string;
  status: string;
  inputLotId: string | null;
  inputBatchId: string | null;
  inputWarehouseId: string | null;
  inputQty: number;
  outputQty: number | null;
  lossQty: number | null;
  consumedOutputQty: number;
  outputItemId: string | null;
  unitsProduced: number | null;
  unitsRejected: number | null;
  outputWarehouseId: string | null;
  outputLotId: string | null;
  qcStatus: string;
  qcApprovedAt: string | null;
  operatorName: string | null;
  attributes: Record<string, unknown> | null;
  notes: string | null;
  createdAt: string;
}

export interface QualityTest {
  id: string;
  batchId: string;
  attemptNumber: number;
  targetLevel: string | null;
  actualResult: string;
  status: string;
  operatorName: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  date: string;
  notes: string | null;
}

export interface GenealogyNode {
  kind: 'lot' | 'batch';
  id: string;
  label: string;
  detail: string;
}

export interface Invoice {
  id: string;
  docNumber: string;
  date: string;
  customerId: string;
  status: string;
  paymentTerm: string;
  priceCategory: string;
  subtotalCents: number | null;
  discountCents: number | null;
  vatCents: number | null;
  totalCents: number | null;
  paidCents: number | null;
  dueDate: string | null;
  fulfillment: string;
  notes: string | null;
  createdAt: string;
}

export interface InvoiceLine {
  id: string;
  invoiceId: string;
  itemId: string;
  lotId: string | null;
  warehouseId: string;
  qty: number;
  entryUomId: string;
  unitPriceCents: number | null;
  priceSource: string | null;
  discountCents: number | null;
  lineSubtotalCents: number | null;
  reservationId: string | null;
}

export interface Delivery {
  id: string;
  docNumber: string;
  invoiceId: string;
  customerId: string;
  status: string;
  deliveryType: string;
  destination: string | null;
  truckNumber: string | null;
  driverName: string | null;
  driverPhone: string | null;
  dispatchDate: string | null;
  expectedDate: string | null;
  actualDate: string | null;
  receivedBy: string | null;
  notes: string | null;
  createdAt: string;
}

export interface Payment {
  id: string;
  docNumber: string;
  date: string;
  customerId: string;
  amountCents: number;
  method: string;
  referenceNumber: string | null;
  notes: string | null;
  status: string;
  allocatedCents: number;
  createdAt: string;
}

export interface CreditRow {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  saleDate: string;
  dueDate: string | null;
  totalCents: number | null;
  paidCents: number | null;
  remainingCents: number | null;
  lastPaymentDate: string | null;
  status: string;
}

export interface CreditOverview {
  rows: CreditRow[];
  outstandingCents: number | null;
  overdueCents: number | null;
  dueThisWeekCents: number | null;
}

export interface PricingInfo {
  pricing: {
    version: number;
    data: {
      categories: string[];
      customPrice?: { requiresApproval?: boolean };
      discount?: { requiresApproval?: boolean };
      prices: Record<string, Record<string, number | null>>;
    };
  } | null;
  vat: { version: number; data: { enabled: boolean; ratePct: number } } | null;
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
