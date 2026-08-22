/**
 * JENIFY OS — Import Engine (MVP)
 * ================================
 *
 * A reusable, tenant-scoped import pipeline for onboarding a business's existing
 * records (customers, suppliers, items/products) and their opening inventory.
 *
 * Pipeline (all pure/testable functions over already-parsed rows):
 *
 *   UPLOAD(parsed)  -> normalizeParsed()      turn string[][] | Record<>[] into a table
 *   DETECT/CLASSIFY -> detectEntityType()     guess the entity from the column names
 *   MAP             -> suggestMapping()        propose column -> field (REPLACEABLE: an
 *                                              AI mapper can drop in here later)
 *   CLEAN           -> processRow() (internal) trim / NFC / number & phone normalize
 *   VALIDATE        -> processRow()            per-field rules; row-level errors, NEVER invent
 *   DEDUPLICATE     -> processRow()            against existing tenant data + within the file
 *   PREVIEW         -> previewImport()         what WOULD happen — performs ZERO writes
 *   IMPORT          -> executeImport()         transactional; delegates to the audited create
 *                                              services; opening inventory posts audited
 *                                              adjustment movements through the ledger
 *   RECONCILE       -> executeImport().reconcile   counts + inventory totals match
 *
 * HARD RULES honoured here:
 *  - A missing REQUIRED field is a row error, never a fabricated default.
 *  - Preview writes nothing.
 *  - Import is idempotent-safe: re-running the same file creates no duplicates
 *    (dedup catches existing rows on the second pass).
 *  - Everything is tenant-scoped through `ctx`.
 *  - Opening inventory is posted ONLY through `postMovement` (append-only ledger),
 *    as an audited `adjustment` movement — never a raw balance write.
 *
 * This module owns NO new DB tables — staging is in-memory for the MVP.
 * It calls only existing audited services (parties / masterdata / inventory /
 * numbering / audit); it performs no raw inserts of business data.
 */

import type { ItemKind, PartyKind } from '@factoryos/shared';
import { ITEM_KINDS } from '@factoryos/shared';
import type { Ctx } from './context.js';
import { inTx } from './context.js';
import { createParty, listParties } from './parties.js';
import { createItem, createUom, listItems, listUoms, listWarehouses, toBaseQty } from './masterdata.js';
import { createLot, listMovements, postMovement, getOnHand } from './inventory.js';
import { defineSequence, nextDocNumber } from './numbering.js';
import { writeAudit } from './audit.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EntityType = 'customer' | 'supplier' | 'item' | 'opening_inventory';

/** Rows accepted from the route/parser: a matrix (row 0 = headers) or objects. */
export type ParsedInput = string[][] | Array<Record<string, string>>;

/** Canonical field name -> the source column header it was mapped from. */
export type FieldMapping = Record<string, string>;

export interface NormalizedTable {
  headers: string[];
  rows: Array<Record<string, string>>;
}

export interface FieldDef {
  field: string;
  required: boolean;
  /** normalized synonyms (English + light Amharic/Tigrinya) used for auto-mapping */
  aliases: string[];
}

export interface DetectionResult {
  entityType: EntityType;
  /** 0..1 — how dominant the winning guess is; low means "please confirm". */
  confidence: number;
  scores: Record<EntityType, number>;
}

export type RowStatus = 'ready' | 'error' | 'duplicate';

export interface RowError {
  field: string;
  message: string;
}

export interface ProcessedRow {
  /** 1-based index among data rows (header excluded). */
  rowNumber: number;
  raw: Record<string, string>;
  /** mapped + cleaned field values (post-CLEAN). */
  cleaned: Record<string, string>;
  status: RowStatus;
  errors: RowError[];
  /** set when status === 'duplicate' */
  duplicateOf?: 'existing' | 'in-file';
  /** opening inventory only: resolved milli base-unit quantity */
  qtyMilli?: number;
}

export interface ImportCounts {
  total: number;
  ready: number;
  errors: number;
  duplicates: number;
}

export interface ImportPlan {
  entityType: EntityType;
  detection: DetectionResult;
  mapping: FieldMapping;
  rows: ProcessedRow[];
  counts: ImportCounts;
  /** opening inventory only: source-side control totals for reconciliation */
  controlTotals?: {
    totalQtyMilli: number;
    byItemWarehouse: Record<string, number>;
  };
}

export interface ReconcileResult {
  ok: boolean;
  expectedCreated: number;
  actualCreated: number;
  /** opening inventory only */
  expectedQtyMilli?: number;
  actualQtyMilli?: number;
  discrepancies: string[];
}

export interface ImportResult {
  entityType: EntityType;
  created: number;
  skipped: number; // duplicates
  failed: number; // rows held with errors
  createdIds: string[];
  plan: ImportPlan;
  reconcile: ReconcileResult;
}

export interface ImportOptions {
  /** Override the auto-detected entity type (the human confirm step). */
  entityType?: EntityType;
  /** Override the auto-suggested mapping (user- or AI-supplied). */
  mapping?: FieldMapping;
  /**
   * Constant-fill warehouse (code, name, or id) applied to every opening-inventory
   * row that has no warehouse column. "All rows -> Main Store" from research §3.3.
   */
  warehouse?: string;
}

// ---------------------------------------------------------------------------
// Field schemas + synonym dictionaries (the whole MAP intelligence lives here)
// ---------------------------------------------------------------------------

/**
 * Per-entity field definitions. Required fields drive VALIDATE; aliases drive
 * both DETECT and MAP. This is deliberately data, not code, so a smarter
 * (AI-assisted) mapper can be swapped in without touching the pipeline.
 */
export const ENTITY_FIELDS: Record<EntityType, FieldDef[]> = {
  customer: [
    { field: 'name', required: true, aliases: ['name', 'customer name', 'client name', 'full name', 'party', 'sim'] },
    { field: 'phone', required: false, aliases: ['phone', 'phone number', 'phone no', 'mobile', 'tel', 'telephone', 'contact', 'simi'] },
    { field: 'location', required: false, aliases: ['location', 'address', 'city', 'town', 'area', 'place'] },
    { field: 'creditLimit', required: false, aliases: ['credit limit', 'credit', 'limit'] },
    { field: 'notes', required: false, aliases: ['note', 'notes', 'remark', 'remarks', 'comment'] },
  ],
  supplier: [
    { field: 'name', required: true, aliases: ['name', 'supplier name', 'vendor name', 'full name', 'party'] },
    { field: 'phone', required: false, aliases: ['phone', 'phone number', 'phone no', 'mobile', 'tel', 'telephone', 'contact'] },
    { field: 'location', required: false, aliases: ['location', 'address', 'city', 'town', 'area', 'place'] },
    { field: 'notes', required: false, aliases: ['note', 'notes', 'remark', 'remarks', 'comment'] },
  ],
  item: [
    { field: 'code', required: true, aliases: ['code', 'item code', 'product code', 'sku'] },
    { field: 'name', required: true, aliases: ['name', 'item name', 'product name', 'item', 'product'] },
    { field: 'unit', required: true, aliases: ['unit', 'uom', 'unit of measure', 'units', 'measure'] },
    { field: 'kind', required: false, aliases: ['kind', 'item type', 'product type', 'category', 'type'] },
    { field: 'sellable', required: false, aliases: ['sellable', 'sell', 'for sale', 'saleable'] },
    { field: 'purchasable', required: false, aliases: ['purchasable', 'buy', 'purchase', 'buyable'] },
  ],
  opening_inventory: [
    { field: 'item', required: true, aliases: ['item', 'item name', 'product', 'product name', 'item code', 'product code', 'code', 'sku'] },
    { field: 'warehouse', required: true, aliases: ['warehouse', 'store', 'stock location', 'godown', 'location'] },
    { field: 'qty', required: true, aliases: ['qty', 'quantity', 'quantity on hand', 'on hand', 'stock', 'balance', 'count', 'opening qty', 'opening quantity'] },
    { field: 'unit', required: false, aliases: ['unit', 'uom', 'unit of measure', 'measure'] },
    { field: 'lot', required: false, aliases: ['lot', 'lot number', 'lot no', 'batch', 'batch number'] },
  ],
};

/** Keyword hints that separate the two look-alike party sheets. */
const SUPPLIER_KEYWORDS = ['supplier', 'vendor'];
const CUSTOMER_KEYWORDS = ['customer', 'client', 'buyer'];

// ---------------------------------------------------------------------------
// Small text helpers (deterministic, explainable — research §3.4)
// ---------------------------------------------------------------------------

/** Header/alias normalization: NFC, lowercase, collapse whitespace, drop punctuation. */
function normHeader(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[._\-/\\()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Value cleaning: NFC, trim, collapse internal whitespace. */
function cleanString(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Identity key for dedup: cleaned + lowercased. */
function normKey(s: string): string {
  return cleanString(s).toLowerCase();
}

/** Light phone normalization — strip spaces/dashes/parens; keep a leading +. */
function cleanPhone(s: string): string {
  const t = cleanString(s);
  const plus = t.startsWith('+') ? '+' : '';
  return plus + t.replace(/[^0-9]/g, '');
}

/**
 * Tolerant number parse. Handles thousand separators ("1,200.50" -> 1200.5),
 * accounting negatives "(500)" -> -500, and stray currency letters ("ETB 1200").
 * Comma is treated as a thousands separator (ambiguity noted in research §1.2.7).
 * Returns null when nothing numeric remains.
 */
function parseNumber(raw: string): number | null {
  let s = cleanString(raw);
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  }
  if (s === '' || s === '.') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** Parse a loose boolean cell; undefined when blank/unrecognized. */
function parseBool(raw: string): boolean | undefined {
  const t = normKey(raw);
  if (t === '') return undefined;
  if (['yes', 'y', 'true', '1', 'sellable', 'purchasable'].includes(t)) return true;
  if (['no', 'n', 'false', '0'].includes(t)) return false;
  return undefined;
}

/** A header matches an alias if either contains the other (word-ish, forgiving). */
function headerMatchesAlias(header: string, alias: string): boolean {
  const h = normHeader(header);
  const a = normHeader(alias);
  if (!h || !a) return false;
  return h === a || h.includes(a) || a.includes(h);
}

// ---------------------------------------------------------------------------
// UPLOAD — normalize the parsed input into a table
// ---------------------------------------------------------------------------

/**
 * Accept `string[][]` (row 0 = header) OR `Record<string,string>[]` (already keyed)
 * and produce a uniform { headers, rows }. Fully-empty rows are dropped; the route
 * is responsible for CSV/XLSX parsing (we intentionally add no parser dependency).
 */
export function normalizeParsed(parsed: ParsedInput): NormalizedTable {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { headers: [], rows: [] };
  }
  const first = parsed[0];
  if (Array.isArray(first)) {
    const matrix = parsed as string[][];
    const headers = (matrix[0] ?? []).map((h) => cleanString(String(h ?? '')));
    const rows: Array<Record<string, string>> = [];
    for (let r = 1; r < matrix.length; r++) {
      const cells = matrix[r] ?? [];
      const rec: Record<string, string> = {};
      let nonEmpty = false;
      headers.forEach((h, c) => {
        const v = cells[c] == null ? '' : String(cells[c]);
        rec[h] = v;
        if (cleanString(v) !== '') nonEmpty = true;
      });
      if (nonEmpty) rows.push(rec);
    }
    return { headers, rows };
  }
  // Record<string,string>[] form
  const objRows = parsed as Array<Record<string, string>>;
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of objRows) {
    for (const k of Object.keys(row)) {
      const key = cleanString(k);
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const rows = objRows
    .map((row) => {
      const rec: Record<string, string> = {};
      for (const h of headers) rec[h] = row[h] == null ? '' : String(row[h]);
      return rec;
    })
    .filter((rec) => Object.values(rec).some((v) => cleanString(v) !== ''));
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// DETECT / CLASSIFY — guess the entity type from the column names
// ---------------------------------------------------------------------------

function anyHeaderMatches(headers: string[], aliases: string[]): boolean {
  return headers.some((h) => aliases.some((a) => headerMatchesAlias(h, a)));
}

export function detectEntityType(table: NormalizedTable): DetectionResult {
  const H = table.headers;
  const has = (aliases: string[]) => anyHeaderMatches(H, aliases);
  const hasKeyword = (kws: string[]) => H.some((h) => kws.some((k) => normHeader(h).includes(k)));

  const qtyAliases = ENTITY_FIELDS.opening_inventory.find((f) => f.field === 'qty')!.aliases;
  const whAliases = ENTITY_FIELDS.opening_inventory.find((f) => f.field === 'warehouse')!.aliases;
  const invItemAliases = ENTITY_FIELDS.opening_inventory.find((f) => f.field === 'item')!.aliases;
  const lotAliases = ENTITY_FIELDS.opening_inventory.find((f) => f.field === 'lot')!.aliases;
  const unitAliases = ENTITY_FIELDS.item.find((f) => f.field === 'unit')!.aliases;
  const codeAliases = ENTITY_FIELDS.item.find((f) => f.field === 'code')!.aliases;
  const itemNameAliases = ['item name', 'product name', 'item', 'product'];
  const nameAliases = ENTITY_FIELDS.customer.find((f) => f.field === 'name')!.aliases;
  const phoneAliases = ENTITY_FIELDS.customer.find((f) => f.field === 'phone')!.aliases;

  const scores: Record<EntityType, number> = {
    customer: 0,
    supplier: 0,
    item: 0,
    opening_inventory: 0,
  };

  // Opening inventory: quantity is the decisive signal; warehouse strongly supports it.
  if (has(qtyAliases)) scores.opening_inventory += 3;
  if (has(whAliases)) scores.opening_inventory += 2;
  if (has(invItemAliases)) scores.opening_inventory += 1;
  if (has(lotAliases)) scores.opening_inventory += 1;

  // Item master: a unit-of-measure column + code/name, and NO quantity column.
  if (has(unitAliases)) scores.item += 2;
  if (has(codeAliases)) scores.item += 1;
  if (anyHeaderMatches(H, itemNameAliases)) scores.item += 1;
  if (has(qtyAliases)) scores.item -= 2; // a qty column means this is stock, not a master list

  // Parties: name + phone; a keyword disambiguates customer vs supplier.
  const nameHit = has(nameAliases) ? 1 : 0;
  const phoneHit = has(phoneAliases) ? 1 : 0;
  scores.customer += nameHit + phoneHit;
  scores.supplier += nameHit + phoneHit;
  if (hasKeyword(SUPPLIER_KEYWORDS)) scores.supplier += 2;
  if (hasKeyword(CUSTOMER_KEYWORDS)) scores.customer += 2;

  // Winner (stable tie-break order); customer wins a bare name+phone tie.
  const order: EntityType[] = ['opening_inventory', 'item', 'supplier', 'customer'];
  let best: EntityType = 'customer';
  let bestScore = -Infinity;
  for (const e of order) {
    if (scores[e] > bestScore) {
      best = e;
      bestScore = scores[e];
    }
  }
  const positives = Object.values(scores).filter((v) => v > 0);
  const sum = positives.reduce((a, b) => a + b, 0);
  const confidence = sum > 0 && bestScore > 0 ? Math.max(0, bestScore) / sum : 0;
  return { entityType: best, confidence, scores };
}

// ---------------------------------------------------------------------------
// MAP — propose a column -> field mapping (REPLACEABLE: AI plugs in here)
// ---------------------------------------------------------------------------

/**
 * Suggest a column->field mapping for the chosen entity type. Kept a separate,
 * pure function returning a plain object so an AI-assisted mapper can replace it
 * (same signature, smarter body) without touching the rest of the pipeline.
 * The caller may override the result via ImportOptions.mapping.
 */
export function suggestMapping(table: NormalizedTable, entityType: EntityType): FieldMapping {
  const mapping: FieldMapping = {};
  const usedHeaders = new Set<string>();
  for (const def of ENTITY_FIELDS[entityType]) {
    // Try aliases most-specific first; first unused matching header wins.
    for (const alias of def.aliases) {
      const header = table.headers.find(
        (h) => !usedHeaders.has(h) && headerMatchesAlias(h, alias),
      );
      if (header) {
        mapping[def.field] = header;
        usedHeaders.add(header);
        break;
      }
    }
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Preloaded, tenant-scoped reference data (read-only) for VALIDATE + DEDUP
// ---------------------------------------------------------------------------

interface RefData {
  /** existing party identity keys ("name|phone") for the relevant kinds */
  partyKeys: Set<string>;
  /** item lookup by normalized code and normalized name */
  itemsByKey: Map<string, { id: string; baseUomId: string }>;
  /** existing item codes (normalized) */
  itemCodes: Set<string>;
  /** warehouse lookup by normalized code and normalized name */
  warehousesByKey: Map<string, { id: string }>;
  /** uom lookup by normalized code */
  uomsByCode: Map<string, { id: string }>;
  /** documentIds of opening-inventory movements already posted (idempotency) */
  openingDocIds: Set<string>;
}

function partyIdentityKey(name: string, phone: string): string {
  return `${normKey(name)}|${cleanPhone(phone)}`;
}

function openingDocId(itemId: string, warehouseId: string, lotNumber: string): string {
  return `opening:${itemId}:${warehouseId}:${normKey(lotNumber)}`;
}

function loadRefData(ctx: Ctx, entityType: EntityType): RefData {
  const ref: RefData = {
    partyKeys: new Set(),
    itemsByKey: new Map(),
    itemCodes: new Set(),
    warehousesByKey: new Map(),
    uomsByCode: new Map(),
    openingDocIds: new Set(),
  };

  if (entityType === 'customer' || entityType === 'supplier') {
    const kind: PartyKind = entityType;
    // parties.ts listParties already folds in 'both' when a kind is passed.
    for (const p of listParties(ctx, { kind })) {
      ref.partyKeys.add(partyIdentityKey(p.name, p.phone ?? ''));
    }
  }

  if (entityType === 'item') {
    for (const u of listUoms(ctx)) ref.uomsByCode.set(normKey(u.code), { id: u.id });
    for (const it of listItems(ctx)) ref.itemCodes.add(normKey(it.code));
  }

  if (entityType === 'opening_inventory') {
    for (const u of listUoms(ctx)) ref.uomsByCode.set(normKey(u.code), { id: u.id });
    for (const it of listItems(ctx)) {
      const rec = { id: it.id, baseUomId: it.baseUomId };
      ref.itemsByKey.set(normKey(it.code), rec);
      ref.itemsByKey.set(normKey(it.name), rec);
    }
    for (const w of listWarehouses(ctx, { includeInactive: true })) {
      const rec = { id: w.id };
      ref.warehousesByKey.set(normKey(w.code), rec);
      ref.warehousesByKey.set(normKey(w.name), rec);
    }
    for (const m of listMovements(ctx, { documentKind: 'opening_inventory', limit: 1000 })) {
      ref.openingDocIds.add(m.documentId);
    }
  }

  return ref;
}

// ---------------------------------------------------------------------------
// CLEAN + VALIDATE + DEDUP for a single row (produces a ProcessedRow)
// ---------------------------------------------------------------------------

/** Pull a mapped, cleaned value for a field; '' when unmapped/blank. */
function mappedValue(raw: Record<string, string>, mapping: FieldMapping, field: string): string {
  const header = mapping[field];
  if (!header) return '';
  return cleanString(raw[header] ?? '');
}

function processRow(
  ctx: Ctx,
  entityType: EntityType,
  mapping: FieldMapping,
  raw: Record<string, string>,
  rowNumber: number,
  ref: RefData,
  seenKeys: Set<string>,
  opts: ImportOptions,
  resolvedConstantWarehouseId: string | null,
): ProcessedRow {
  const errors: RowError[] = [];
  const cleaned: Record<string, string> = {};

  // CLEAN: gather every mapped field, normalized.
  for (const def of ENTITY_FIELDS[entityType]) {
    const v = mappedValue(raw, mapping, def.field);
    if (v !== '') cleaned[def.field] = def.field === 'phone' ? cleanPhone(v) : v;
  }

  // VALIDATE: required fields present? (missing -> row error, never invented)
  for (const def of ENTITY_FIELDS[entityType]) {
    if (def.required && !cleaned[def.field]) {
      // warehouse can be satisfied by a constant fill
      if (entityType === 'opening_inventory' && def.field === 'warehouse' && resolvedConstantWarehouseId) {
        continue;
      }
      errors.push({ field: def.field, message: `Required field '${def.field}' is missing` });
    }
  }

  const row: ProcessedRow = { rowNumber, raw, cleaned, status: 'ready', errors };

  // Entity-specific validation + reference resolution.
  if (entityType === 'customer' || entityType === 'supplier') {
    if (cleaned.creditLimit) {
      const n = parseNumber(cleaned.creditLimit);
      if (n === null) errors.push({ field: 'creditLimit', message: 'Credit limit is not a number' });
      else if (n < 0) errors.push({ field: 'creditLimit', message: 'Credit limit cannot be negative' });
    }
  }

  if (entityType === 'item') {
    if (cleaned.unit) {
      const uom = ref.uomsByCode.get(normKey(cleaned.unit));
      if (!uom) {
        errors.push({
          field: 'unit',
          message: `Unit '${cleaned.unit}' is not a known unit of measure — create it first`,
        });
      }
    }
    if (cleaned.kind && !(ITEM_KINDS as readonly string[]).includes(cleaned.kind)) {
      errors.push({
        field: 'kind',
        message: `Item kind '${cleaned.kind}' is not one of: ${ITEM_KINDS.join(', ')}`,
      });
    }
  }

  if (entityType === 'opening_inventory') {
    // qty -> milli base-units through the item's (or mapped unit's) UoM.
    const item = cleaned.item ? ref.itemsByKey.get(normKey(cleaned.item)) : undefined;
    if (cleaned.item && !item) {
      errors.push({ field: 'item', message: `Item '${cleaned.item}' does not exist — import items first` });
    }
    let warehouseId: string | null = resolvedConstantWarehouseId;
    if (cleaned.warehouse) {
      const wh = ref.warehousesByKey.get(normKey(cleaned.warehouse));
      if (!wh) {
        errors.push({ field: 'warehouse', message: `Warehouse '${cleaned.warehouse}' does not exist` });
      } else {
        warehouseId = wh.id;
      }
    }
    let uomId: string | null = item ? item.baseUomId : null;
    if (cleaned.unit) {
      const uom = ref.uomsByCode.get(normKey(cleaned.unit));
      if (!uom) errors.push({ field: 'unit', message: `Unit '${cleaned.unit}' is not a known unit of measure` });
      else uomId = uom.id;
    }
    const qtyNum = cleaned.qty ? parseNumber(cleaned.qty) : null;
    if (cleaned.qty && qtyNum === null) {
      errors.push({ field: 'qty', message: `Quantity '${cleaned.qty}' is not a number` });
    } else if (qtyNum !== null && qtyNum <= 0) {
      errors.push({ field: 'qty', message: 'Opening quantity must be greater than zero' });
    }
    // resolve milli qty when everything needed is present
    if (item && uomId && qtyNum !== null && qtyNum > 0) {
      row.qtyMilli = toBaseQty(ctx, uomId, qtyNum);
    }
    // stash resolved ids for the importer via cleaned map (ids never come from the file)
    if (item) cleaned.__itemId = item.id;
    if (warehouseId) cleaned.__warehouseId = warehouseId;
  }

  if (errors.length > 0) {
    row.status = 'error';
    return row;
  }

  // DEDUPLICATE: existing tenant data first, then within-file.
  let key: string | null = null;
  if (entityType === 'customer' || entityType === 'supplier') {
    key = partyIdentityKey(cleaned.name ?? '', cleaned.phone ?? '');
    if (ref.partyKeys.has(key)) {
      row.status = 'duplicate';
      row.duplicateOf = 'existing';
      return row;
    }
  } else if (entityType === 'item') {
    key = normKey(cleaned.code ?? '');
    if (ref.itemCodes.has(key)) {
      row.status = 'duplicate';
      row.duplicateOf = 'existing';
      return row;
    }
  } else if (entityType === 'opening_inventory') {
    const docId = openingDocId(cleaned.__itemId ?? '', cleaned.__warehouseId ?? '', cleaned.lot ?? '');
    key = docId;
    if (ref.openingDocIds.has(docId)) {
      row.status = 'duplicate';
      row.duplicateOf = 'existing';
      return row;
    }
  }

  if (key !== null) {
    if (seenKeys.has(key)) {
      row.status = 'duplicate';
      row.duplicateOf = 'in-file';
      return row;
    }
    seenKeys.add(key);
  }

  return row;
}

// ---------------------------------------------------------------------------
// PREVIEW — build the whole plan; performs ZERO writes
// ---------------------------------------------------------------------------

function resolveConstantWarehouse(ref: RefData, opts: ImportOptions): string | null {
  if (!opts.warehouse) return null;
  const wh = ref.warehousesByKey.get(normKey(opts.warehouse));
  return wh ? wh.id : null;
}

function tally(rows: ProcessedRow[]): ImportCounts {
  return {
    total: rows.length,
    ready: rows.filter((r) => r.status === 'ready').length,
    errors: rows.filter((r) => r.status === 'error').length,
    duplicates: rows.filter((r) => r.status === 'duplicate').length,
  };
}

/**
 * Build the full import plan (DETECT -> MAP -> CLEAN -> VALIDATE -> DEDUP).
 * READ-ONLY: this never writes. It is exactly what PREVIEW shows and what
 * IMPORT executes, so the two can never disagree.
 */
export function previewImport(ctx: Ctx, parsed: ParsedInput, opts: ImportOptions = {}): ImportPlan {
  const table = normalizeParsed(parsed);
  const detection = detectEntityType(table);
  const entityType = opts.entityType ?? detection.entityType;
  const mapping = opts.mapping ?? suggestMapping(table, entityType);

  const ref = loadRefData(ctx, entityType);
  const constantWh = resolveConstantWarehouse(ref, opts);
  const seenKeys = new Set<string>();

  const rows = table.rows.map((raw, i) =>
    processRow(ctx, entityType, mapping, raw, i + 1, ref, seenKeys, opts, constantWh),
  );

  const plan: ImportPlan = {
    entityType,
    detection,
    mapping,
    rows,
    counts: tally(rows),
  };

  if (entityType === 'opening_inventory') {
    const byItemWarehouse: Record<string, number> = {};
    let totalQtyMilli = 0;
    for (const r of rows) {
      if (r.status === 'ready' && r.qtyMilli) {
        totalQtyMilli += r.qtyMilli;
        const k = `${r.cleaned.__itemId}|${r.cleaned.__warehouseId}`;
        byItemWarehouse[k] = (byItemWarehouse[k] ?? 0) + r.qtyMilli;
      }
    }
    plan.controlTotals = { totalQtyMilli, byItemWarehouse };
  }

  return plan;
}

// ---------------------------------------------------------------------------
// IMPORT — transactional; delegates to the audited create services
// ---------------------------------------------------------------------------

const OPENING_SEQ_KEY = 'opening_stock';

/**
 * Execute the import. Builds the plan (no writes), then commits every `ready`
 * row inside a single transaction using ONLY existing audited services.
 * Duplicate/error rows are skipped/held. Re-running the same file is safe:
 * the second pass finds the now-existing rows and marks them duplicate.
 */
export function executeImport(ctx: Ctx, parsed: ParsedInput, opts: ImportOptions = {}): ImportResult {
  const plan = previewImport(ctx, parsed, opts);
  const ready = plan.rows.filter((r) => r.status === 'ready');
  const createdIds: string[] = [];
  const createdOpeningDocIds: string[] = [];

  inTx(ctx, (tx) => {
    if (plan.entityType === 'opening_inventory' && ready.length > 0) {
      // Idempotent: defineSequence updates in place if it already exists.
      defineSequence(tx, OPENING_SEQ_KEY, 'OPN-', 4);
    }

    for (const r of ready) {
      if (plan.entityType === 'customer' || plan.entityType === 'supplier') {
        const creditLimit = r.cleaned.creditLimit ? parseNumber(r.cleaned.creditLimit) ?? undefined : undefined;
        const id = createParty(tx, {
          kind: plan.entityType,
          name: r.cleaned.name,
          phone: r.cleaned.phone || undefined,
          location: r.cleaned.location || undefined,
          creditLimit,
          notes: r.cleaned.notes || undefined,
        });
        createdIds.push(id);
      } else if (plan.entityType === 'item') {
        const uom = listUoms(tx).find((u) => normKey(u.code) === normKey(r.cleaned.unit));
        const kind: ItemKind = (ITEM_KINDS as readonly string[]).includes(r.cleaned.kind ?? '')
          ? (r.cleaned.kind as ItemKind)
          : 'other';
        const id = createItem(tx, {
          code: r.cleaned.code,
          name: r.cleaned.name,
          kind,
          baseUomId: uom!.id,
          sellable: parseBool(r.cleaned.sellable ?? ''),
          purchasable: parseBool(r.cleaned.purchasable ?? ''),
        });
        createdIds.push(id);
      } else if (plan.entityType === 'opening_inventory') {
        const itemId = r.cleaned.__itemId!;
        const warehouseId = r.cleaned.__warehouseId!;
        const qty = r.qtyMilli!;
        let lotId: string | null = null;
        if (r.cleaned.lot) {
          lotId = createLot(tx, { itemId, lotNumber: r.cleaned.lot, sourceKind: 'opening_inventory' });
        }
        const docId = openingDocId(itemId, warehouseId, r.cleaned.lot ?? '');
        const docNumber = nextDocNumber(tx, OPENING_SEQ_KEY);
        const movementId = postMovement(tx, {
          itemId,
          lotId,
          warehouseId,
          qty, // positive milli base-units
          movementType: 'adjustment',
          documentKind: 'opening_inventory',
          documentId: docId,
          documentNumber: docNumber,
          note: 'Opening inventory (import) — declared balance at cutover',
        });
        writeAudit(tx, {
          module: 'inventory',
          action: 'opening_inventory_import',
          entity: 'stock_movement',
          entityId: movementId,
          reference: docNumber,
          summary: `Opening inventory posted (${qty / 1000} base units) via import`,
        });
        createdIds.push(movementId);
        createdOpeningDocIds.push(docId);
      }
    }
  });

  const reconcile = reconcileRun(ctx, plan, createdIds, createdOpeningDocIds);

  return {
    entityType: plan.entityType,
    created: createdIds.length,
    skipped: plan.counts.duplicates,
    failed: plan.counts.errors,
    createdIds,
    plan,
    reconcile,
  };
}

// ---------------------------------------------------------------------------
// RECONCILE — did the system state match what the plan promised?
// ---------------------------------------------------------------------------

function reconcileRun(
  ctx: Ctx,
  plan: ImportPlan,
  createdIds: string[],
  createdOpeningDocIds: string[],
): ReconcileResult {
  const discrepancies: string[] = [];
  const expectedCreated = plan.counts.ready;
  const actualCreated = createdIds.length;
  if (expectedCreated !== actualCreated) {
    discrepancies.push(`Expected to create ${expectedCreated} rows but created ${actualCreated}`);
  }

  const result: ReconcileResult = {
    ok: true,
    expectedCreated,
    actualCreated,
    discrepancies,
  };

  if (plan.entityType === 'opening_inventory') {
    const expectedQtyMilli = plan.controlTotals?.totalQtyMilli ?? 0;
    // Re-read the ledger and sum the movements this run posted.
    const posted = listMovements(ctx, { documentKind: 'opening_inventory', limit: 1000 }).filter((m) =>
      createdOpeningDocIds.includes(m.documentId),
    );
    const actualQtyMilli = posted.reduce((a, m) => a + m.qty, 0);
    result.expectedQtyMilli = expectedQtyMilli;
    result.actualQtyMilli = actualQtyMilli;
    if (expectedQtyMilli !== actualQtyMilli) {
      discrepancies.push(`Opening qty mismatch: expected ${expectedQtyMilli}, ledger has ${actualQtyMilli}`);
    }
    // Per item+warehouse: balances must reflect at least the imported quantity.
    for (const [k, qty] of Object.entries(plan.controlTotals?.byItemWarehouse ?? {})) {
      const [itemId, warehouseId] = k.split('|');
      const onHand = getOnHand(ctx, itemId, warehouseId);
      if (onHand < qty) {
        discrepancies.push(`On-hand for item ${itemId} @ ${warehouseId} is ${onHand}, below imported ${qty}`);
      }
    }
  }

  result.ok = discrepancies.length === 0;
  return result;
}
