/** Display helpers. Quantities arrive as integer milli base-units; money as cents. */
import { toEthiopianDate } from '@factoryos/shared';

// Calendar is tenant DISPLAY configuration — stored dates never change.
let displayCalendar: 'gregorian' | 'ethiopian' = 'gregorian';
export function setDisplayCalendar(cal: string | null | undefined): void {
  displayCalendar = cal === 'ethiopian' ? 'ethiopian' : 'gregorian';
}

export function qty(milli: number | null | undefined, decimals = 0): string {
  if (milli == null) return '—';
  const v = milli / 1000;
  return v.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: Math.max(decimals, 2),
  });
}

/**
 * FactoryOS-wide quantity display policy: under 1,000 kg show kg; from
 * 1,000 kg show tons with enough precision that hundreds of kilograms are
 * NEVER rounded away (3,980 kg -> "3.98 t", never "4 t").
 */
export function qtySmart(milliKg: number | null | undefined): string {
  if (milliKg == null) return '—';
  const kg = milliKg / 1000;
  if (Math.abs(kg) >= 1000) {
    return `${(kg / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} t`;
  }
  return `${kg.toLocaleString('en-US', { maximumFractionDigits: 1 })} kg`;
}

/** Exact operational form: "3.98 t (3,980 kg)" — for KPIs where precision matters. */
export function qtyExact(milliKg: number | null | undefined): string {
  if (milliKg == null) return '—';
  const kg = milliKg / 1000;
  if (Math.abs(kg) < 1000) return `${kg.toLocaleString('en-US', { maximumFractionDigits: 1 })} kg`;
  return `${qtySmart(milliKg)} (${kg.toLocaleString('en-US', { maximumFractionDigits: 0 })} kg)`;
}

export function money(cents: number | null | undefined, currency = 'ETB'): string {
  if (cents == null) return '—';
  return `${currency} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (displayCalendar === 'ethiopian') {
    const ec = toEthiopianDate(d);
    return `${ec.day} ${ec.monthName} ${ec.year} EC`;
  }
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (displayCalendar === 'ethiopian') {
    const ec = toEthiopianDate(d);
    const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `${ec.day} ${ec.monthName} ${ec.year} EC, ${hm}`;
  }
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
