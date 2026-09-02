/**
 * Shared HTML building blocks for the Headquarter UI (issue #138).
 *
 * Pure functions, string in / string out, no DOM and no data access. Every
 * helper escapes what it renders: callers pass raw canonical values, never
 * pre-built markup, unless the parameter is explicitly named `html`.
 */

import type { ActivityStatus } from '../contracts/events.js';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Serialise a value for embedding inside an inline `<script>` element.
 *
 * `escapeHtml` is the wrong tool here and `JSON.stringify` alone is not
 * enough. Inside a script element the HTML parser looks for the literal
 * characters `</script` before the JavaScript parser sees anything at all, so
 * a string containing `</script>` closes the element from INSIDE a JavaScript
 * string literal — everything after it is fresh markup. `JSON.stringify`
 * leaves `<` untouched, so it hands that straight through (issue #200, Codex
 * exact-head finding on `1c5683f`: a bundle timestamp beginning
 * `z</script><script>…`, chosen to sort last so `bundleAsOf` selects it, became
 * stored script execution on every generated page).
 *
 * `<` and `>` become their `\u003c` / `\u003e` escapes, which the HTML parser
 * cannot read as a tag boundary and which JavaScript reads as exactly the
 * characters they encode — the embedded value is byte-identical at run time. U+2028 and U+2029
 * are escaped for the same class of reason: they are line terminators to a
 * JavaScript parser but legal inside a JSON string.
 *
 * Use this for anything interpolated into executable inline script. A
 * `<script type="application/json">` block is a different context with a
 * different rule, and `archive-search.ts` documents its own.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export type Tone = 'accent' | 'info' | 'warn' | 'danger' | 'violet' | 'neutral';

/** Status → (human label, tone). The vocabulary stays the canonical one. */
export const STATUS_PRESENTATION: Record<ActivityStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  assigned: { label: 'Assigned', tone: 'info' },
  running: { label: 'Running', tone: 'info' },
  review_failed: { label: 'Review failed', tone: 'warn' },
  review_passed: { label: 'Review passed', tone: 'accent' },
  blocked: { label: 'Blocked', tone: 'danger' },
  outcome_unknown: { label: 'Outcome unknown', tone: 'danger' },
  needs_approval: { label: 'Needs approval', tone: 'warn' },
  completed: { label: 'Completed', tone: 'accent' },
};

export function chip(label: string, tone: Tone = 'neutral', withDot = false): string {
  const dot = withDot ? '<span class="dot" aria-hidden="true"></span>' : '';
  return `<span class="chip tone-${tone}">${dot}${escapeHtml(label)}</span>`;
}

export function statusChip(status: ActivityStatus): string {
  const presentation = STATUS_PRESENTATION[status];
  return chip(presentation.label, presentation.tone, true);
}

/** Deterministic hue from an identity string, so a worker keeps one colour. */
export function identityHue(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 360;
  }
  return hash;
}

export function initials(name: string): string {
  const words = name
    .split(/[\s_\-–—]+/)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ''))
    .filter((word) => word.length > 0);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Identity avatar. Colour is derived from the id only — it carries no status
 * meaning, so nothing is communicated by colour alone.
 */
export function avatar(id: string, displayName: string, small = false): string {
  const hue = identityHue(id);
  const style = `background: linear-gradient(140deg, hsl(${hue} 62% 62%), hsl(${(hue + 38) % 360} 58% 44%));`;
  return `<span class="avatar${small ? ' sm' : ''}" style="${style}" aria-hidden="true">${escapeHtml(initials(displayName))}</span>`;
}

export function identity(id: string, displayName: string, subtitle: string, small = false): string {
  return `<span class="identity">${avatar(id, displayName, small)}<span class="who"><b>${escapeHtml(displayName)}</b><span>${escapeHtml(subtitle)}</span></span></span>`;
}

export interface KpiInput {
  label: string;
  value: string | number;
  hint?: string;
  tone?: Tone;
  /**
   * Stable hook (`data-kpi`) a page's own live script may target to patch
   * this tile's value after a runtime check, without touching every other
   * caller of `kpiRow`. Omitted by every existing caller; opt-in only.
   */
  id?: string;
}

export function kpi({ label, value, hint, tone = 'neutral', id }: KpiInput): string {
  return `<div class="card kpi tone-${tone}"${id ? ` data-kpi="${escapeHtml(id)}"` : ''}>
<span class="kpi-label">${escapeHtml(label)}</span>
<span class="kpi-value">${escapeHtml(String(value))}</span>
${hint ? `<span class="kpi-hint">${escapeHtml(hint)}</span>` : ''}
</div>`;
}

export function kpiRow(items: KpiInput[]): string {
  return `<div class="grid grid-kpi">${items.map(kpi).join('\n')}</div>`;
}

/**
 * Progress meter. `label` is rendered as the accessible name so the ratio is
 * never communicated by the bar alone.
 */
export function meter(ratio: number, label: string): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const percent = Math.round(clamped * 100);
  return `<div class="meter" role="img" aria-label="${escapeHtml(`${label}: ${percent}%`)}"><span style="width:${percent}%"></span></div>`;
}

export function emptyState(message: string): string {
  return `<p class="empty">${escapeHtml(message)}</p>`;
}

/** Wide content never widens the page: it scrolls inside its own container. */
export function tableWrap(tableHtml: string, label: string): string {
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(label)}">${tableHtml}</div>`;
}

export function section(heading: string, bodyHtml: string, id?: string): string {
  return `<section${id ? ` id="${escapeHtml(id)}"` : ''}><h2>${escapeHtml(heading)}</h2>${bodyHtml}</section>`;
}

/** Compact relative age, e.g. "3h ago". Falsy/unparseable input renders "—". */
export function relativeAge(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return '—';
  const minutes = Math.round((now - then) / 60000);
  if (minutes < 0) return 'scheduled';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
