/** Display helpers. Quantities arrive as integer milli base-units; money as cents. */

export function qty(milli: number | null | undefined, decimals = 0): string {
  if (milli == null) return '—';
  const v = milli / 1000;
  return v.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: Math.max(decimals, 2),
  });
}

/** kg quantity shown in tons when large. */
export function qtySmart(milliKg: number | null | undefined): string {
  if (milliKg == null) return '—';
  const kg = milliKg / 1000;
  if (Math.abs(kg) >= 1000) {
    return `${(kg / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} t`;
  }
  return `${kg.toLocaleString('en-US', { maximumFractionDigits: 1 })} kg`;
}

export function money(cents: number | null | undefined, currency = 'ETB'): string {
  if (cents == null) return '—';
  return `${currency} ${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
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
