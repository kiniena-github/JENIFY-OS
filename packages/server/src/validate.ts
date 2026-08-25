import { badRequest } from './util.js';

/**
 * Shared input-validation discipline (GitHub AI TASK #3).
 *
 * The R4 red team found that per-endpoint ad-hoc checks let whole BUG FAMILIES
 * through, not just single exploits:
 *   - `qty: true` coerced past a bare `> 0` test and posted a real ledger movement
 *   - `'2026-09-01T12:00:00+03:00'` did not collide with the same instant in `Z`
 *   - `?limit=-1` widened a page past its cap
 *   - a 1000-year booking blocked a resource forever
 *
 * Fixing those one endpoint at a time guarantees the next endpoint repeats them.
 * These helpers are the single place the rules live; services call them instead
 * of hand-rolling `if (!(x > 0))`.
 *
 * Design rules:
 *  - Reject by TYPE first. `true`, `'5'`, `[]`, `{}`, `null` are never numbers,
 *    however conveniently JavaScript coerces them.
 *  - Reject non-finite (NaN / Infinity) explicitly.
 *  - Bound every magnitude: an unbounded value corrupts an append-only ledger
 *    permanently, and no real business needs 1e15 of anything.
 *  - Canonicalise instants to UTC so string comparison equals chronological
 *    comparison wherever times are stored or compared as text.
 */

/** Absolute ceiling for a single quantity in natural units. */
export const MAX_QTY = 1e9;
/** Absolute ceiling for a single money amount, in minor units (cents). */
export const MAX_MONEY_MINOR = 1e13;

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * A real, finite JS number — never a boolean, numeric string, array, object,
 * null/undefined, NaN or Infinity.
 */
export function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    badRequest('invalid_number', `${field} must be a number (received ${typeName(value)})`);
  }
  if (!Number.isFinite(value)) {
    badRequest('invalid_number', `${field} must be a finite number`);
  }
  return value as number;
}

export interface NumberBounds {
  /** default: value must be > 0 */
  allowZero?: boolean;
  allowNegative?: boolean;
  /** default: MAX_QTY */
  max?: number;
  /** reject fractions where the domain is integer-only */
  integerOnly?: boolean;
}

/** A quantity: finite, bounded, positive by default, optionally integer-only. */
export function requireQty(value: unknown, field: string, bounds: NumberBounds = {}): number {
  const n = requireNumber(value, field);
  const max = bounds.max ?? MAX_QTY;
  if (!bounds.allowNegative && !bounds.allowZero && n <= 0) {
    badRequest('invalid_number', `${field} must be greater than zero`);
  }
  if (!bounds.allowNegative && bounds.allowZero && n < 0) {
    badRequest('invalid_number', `${field} cannot be negative`);
  }
  if (Math.abs(n) > max) {
    badRequest('number_out_of_range', `${field} is out of the allowed range (max ${max})`);
  }
  if (bounds.integerOnly && !Number.isInteger(n)) {
    badRequest('invalid_number', `${field} must be a whole number`);
  }
  return n;
}

/** Money in minor units (cents): finite, integer, bounded. */
export function requireMoneyMinor(value: unknown, field: string, bounds: NumberBounds = {}): number {
  return requireQty(value, field, { ...bounds, max: bounds.max ?? MAX_MONEY_MINOR, integerOnly: true });
}

/**
 * A caller-supplied page size may narrow a page but must NEVER widen it past
 * the server's cap, and garbage must fall back to the default rather than
 * disabling the limit (`?limit=-1` returned every row).
 */
export function clampLimit(value: unknown, fallback: number, max: number): number {
  // Query params arrive as strings, so a numeric string is legitimate here —
  // but nothing else is. Number(true) === 1 and Number([]) === 0, so a bare
  // Number() coercion reintroduces exactly the boolean/array bug family this
  // module exists to kill. Accept only a real number or a numeric string.
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value);
  } else {
    return fallback;
  }
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

/** Longest span any single booking/reservation-style range may cover. */
export const MAX_SPAN_DAYS = 366;
/** Instants outside this window are almost certainly input errors. */
const MIN_YEAR = 1970;
const MAX_YEAR = 2200;

/**
 * Canonicalise an instant to UTC ISO-8601.
 *
 * Instants are stored in TEXT columns and compared with SQL string operators,
 * so the stored form MUST be canonical or the comparison is lexicographic
 * instead of chronological — which is exactly how the same moment written
 * `T12:00:00.000+03:00` failed to collide with `T09:00:00.000Z`.
 */
export function requireInstant(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    badRequest('invalid_instant', `${field} is required`);
  }
  const ms = Date.parse(value as string);
  if (!Number.isFinite(ms)) {
    badRequest('invalid_instant', `${field} must be a valid date and time`);
  }
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (year < MIN_YEAR || year > MAX_YEAR) {
    badRequest('instant_out_of_range', `${field} is outside the supported date range`);
  }
  return d.toISOString();
}

/** A calendar date (no time component), canonicalised to YYYY-MM-DD. */
export function requireDate(value: unknown, field: string): string {
  const iso = requireInstant(value, field);
  return iso.slice(0, 10);
}

/** An ordered instant range that must end after it starts and stay bounded. */
export function requireSpan(
  startValue: unknown,
  endValue: unknown,
  fields: { start: string; end: string },
  maxDays = MAX_SPAN_DAYS,
): { start: string; end: string } {
  const start = requireInstant(startValue, fields.start);
  const end = requireInstant(endValue, fields.end);
  if (!(start < end)) {
    badRequest('invalid_span', `${fields.end} must be after ${fields.start}`);
  }
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  if (days > maxDays) {
    badRequest('span_too_long', `The period may not exceed ${maxDays} days`);
  }
  return { start, end };
}

/** A non-empty trimmed string, length-bounded so no field is unbounded. */
export function requireText(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== 'string' || value.trim() === '') {
    badRequest('invalid_text', `${field} is required`);
  }
  const s = (value as string).trim();
  if (s.length > maxLength) {
    badRequest('text_too_long', `${field} may not exceed ${maxLength} characters`);
  }
  return s;
}

/** A value from a fixed set — rejects anything not explicitly allowed. */
export function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    badRequest('invalid_choice', `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}
