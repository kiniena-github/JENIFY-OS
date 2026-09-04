/**
 * Headquarter presentation layer (issue #43, order 1; adapted to the
 * canonical contracts per issue #53 correction D / architecture doc §6b;
 * upgraded to the approved executive UI direction in issue #138).
 *
 * Framework-free HTML renderers for the HQ information architecture
 * (war room #41, order C): Command Center, Projects, Executive Room,
 * Direct Chats, Specialist Directory, Founder Approvals, Archive.
 *
 * Pure string renderers: testable without a DOM, servable as static files,
 * embeddable later behind the operator control layer. No external requests,
 * no secrets, read-only over canonical data.
 *
 * Three honesty rules survive the #138 visual upgrade unchanged:
 *
 *   1. Founder Approvals renders the D15 approval fields read-only and offers
 *      NO approve/reject actions — no <button>, no <form>, no mutation. The
 *      decision controls are drawn so the Founder can see where they will
 *      live, and are explicitly labelled as not wired.
 *   2. A field the canonical data cannot answer is omitted, never filled in.
 *      There is no fabricated cost, token usage, sentiment or ETA anywhere.
 *   3. When the bundle carries a provenance note, every page states it at the
 *      top AND in the footer, so sample/reconstructed data can never be read
 *      as live production truth.
 */

import type { ActivityEvent } from '../contracts/events.js';
import type { ApprovalRequest, ChatMessage } from '../contracts/modules.js';
import type { WorkerDescriptor, WorkerRole } from '../contracts/workers.js';
import type { ArchiveRecord } from '../archive/schema.js';
import type { MonthlyGroup, EvolutionChain } from '../archive/views.js';
import type { TaskState } from './model.js';
import type {
  FounderDashboard,
  WorkerStatus,
  ProjectBoardCard,
  ProjectHealth,
  AttentionItem,
  SpecialistProfile,
} from './views.js';
import { founderAttentionQueue } from './views.js';
import { THEME_CSS } from './theme.js';
import {
  escapeHtml,
  chip,
  statusChip,
  avatar,
  identity,
  kpiRow,
  meter,
  emptyState,
  tableWrap,
  section,
  relativeAge,
  type Tone,
} from './components.js';
import { archiveSearchScript, type ArchiveSearchRow } from './archive-search.js';
import { liveRefreshScript } from './live-refresh.js';
import {
  directOrderConsoleScript,
  approvalsConsoleScript,
  connectionsLiveScript,
} from './control-console.js';
import {
  AUTH_MECHANISM_LABELS,
  CONNECTION_STATE_LABELS,
  CONNECTION_STATE_TONE,
  connectionSummary,
  type ConnectionState,
  type ConnectionStatus,
} from '../live/connections.js';
import { DIRECT_ORDER_ROUTES, type RouteResolution } from '../live/orders.js';
import { SOURCE_MODE_LABELS, type SourceMode } from '../live/provenance.js';
import type { FloorState } from './spatial/state.js';
import { spatialFloorBody } from './spatial/page.js';
import { immersiveBody } from '../client/page.js';

export const HQ_PAGES = [
  { file: 'index.html', title: 'Command Center', glyph: '◈' },
  { file: 'immersive.html', title: 'Immersive HQ', glyph: '◉' },
  { file: 'headquarters.html', title: 'Headquarters Floor', glyph: '⬡' },
  { file: 'projects.html', title: 'Projects', glyph: '▤' },
  { file: 'executive-room.html', title: 'Executive Room', glyph: '◎' },
  { file: 'direct-chats.html', title: 'Direct Chats', glyph: '✉' },
  { file: 'specialists.html', title: 'Specialist Directory', glyph: '⚇' },
  { file: 'approvals.html', title: 'Founder Approvals', glyph: '⚖' },
  { file: 'connections.html', title: 'Connections', glyph: '⇄' },
  { file: 'archive.html', title: 'Archive', glyph: '▦' },
] as const;

const ROLE_LABELS: Record<WorkerRole, string> = {
  build_lead: 'Build lead',
  parallel_implementer: 'Parallel implementer',
  reviewer_gatekeeper: 'Reviewer / gatekeeper',
  specialist_tool: 'Specialist tool',
  mission_director: 'Mission director',
};

const HEALTH_PRESENTATION: Record<ProjectHealth, { label: string; tone: Tone }> = {
  blocked: { label: 'Blocked', tone: 'danger' },
  needs_founder: { label: 'Needs Founder', tone: 'warn' },
  active: { label: 'Active', tone: 'accent' },
  idle: { label: 'Idle', tone: 'neutral' },
};

const ATTENTION_PRESENTATION: Record<AttentionItem['reason'], { label: string; tone: Tone; why: string }> = {
  needs_approval: {
    label: 'Awaiting your decision',
    tone: 'warn',
    why: 'Recorded as needs_approval — no worker can proceed until the Founder decides.',
  },
  blocked: {
    label: 'Blocked',
    tone: 'danger',
    why: 'Recorded as blocked — work has stopped and the block is not self-clearing.',
  },
  outcome_unknown: {
    label: 'Outcome unknown',
    tone: 'danger',
    why: 'Recorded as outcome_unknown — the result was never confirmed, so it must be checked.',
  },
};

interface ShellOptions {
  title: string;
  activeFile: string;
  /** Small label above the page title. */
  eyebrow: string;
  /** One sentence explaining what the page answers. */
  lede: string;
  /** Instant the rendered view is current as of. */
  asOf: string;
  body: string;
  provenanceNote?: string;
  /**
   * Where the bundle's data actually came from. Rendered as a chip on every
   * page so LIVE, RECONSTRUCTED and SAMPLE are distinguishable at a glance
   * rather than buried in a footer. Omitted → no claim is made at all, which
   * is itself honest for a bundle that never stated one.
   */
  sourceMode?: SourceMode;
}

/** Chip tone per provenance mode — SAMPLE must never look like LIVE. */
const SOURCE_MODE_TONE: Record<SourceMode, Tone> = {
  live: 'accent',
  reconstructed: 'violet',
  sample: 'warn',
};

/**
 * The freshness chip the polling script updates.
 *
 * It starts as CHECKING rather than LIVE: before the first poll returns, the
 * page genuinely does not know whether it is current, and saying LIVE would
 * be a claim the render cannot back. With scripting unavailable it simply
 * stays CHECKING, next to the build-time "As of" stamp that is always true.
 */
function freshnessChip(): string {
  return `<span class="chip tone-neutral" data-live-state="checking"><span class="dot" aria-hidden="true"></span><span data-live-label>CHECKING…</span></span>`;
}

/* ------------------------------------------------------------------ */
/* Direct Order composer (issue #200, scope B — UI half)               */
/* ------------------------------------------------------------------ */

/** One route the composer offers, with the verdict evidence actually gives it. */
export interface DirectOrderRouteAvailability {
  route: (typeof DIRECT_ORDER_ROUTES)[number];
  resolution: RouteResolution;
}

/**
 * What the STATIC render of the composer truthfully is, stated in the UI.
 *
 * The Founder-auth boundary now exists (`live/auth.ts`, Founder decision of
 * 2026-08-28): a server-resolved JENIFY OS session, mapped by explicit
 * configuration to a registered, active HQ principal, is the only thing that
 * can act — and only where a host deliberately mounts the control plane. This
 * page's static markup still submits nothing: working controls are DOM nodes
 * that `control-console.ts` creates ONLY after `GET /api/hq/control/session`
 * granted them, so a copy of this page opened from disk, served by a plain
 * static host, or viewed by anyone but the mapped Founder stays inert and
 * says so.
 *
 * The CLI remains the maintenance path, named honestly: it is a
 * TRUSTED-LOCAL-ADMIN interface, and it does not authenticate the Founder —
 * it asserts a principal id (see `live/local-trust.ts`) that deny-by-default
 * authorization and the no-self-approval rule then contain.
 */
export const DIRECT_ORDER_BLOCKER =
  'This static render submits nothing. A working composer is drawn below ONLY when this page is ' +
  'served by a JENIFY OS host with the HQ control plane switched on, and only after the control ' +
  'API confirms that YOUR signed-in session is mapped to a registered Founder principal that ' +
  'holds the direct-order grant — a server-resolved session plus an explicit account-to-principal ' +
  'binding, never anything this page can assert about itself. Without that answer, no control is ' +
  'drawn. The maintenance alternative is ' +
  '`npm run hq:order --workspace @factoryos/headquarter -- --local-admin`, a ' +
  'TRUSTED-LOCAL-ADMIN interface: it does not authenticate the Founder, it asserts a principal ' +
  'id that deny-by-default authorization and the no-self-approval rule then contain.';

export const ROUTE_STATE_PRESENTATION: Record<'ready' | 'blocked' | 'unknown', { label: string; tone: Tone }> = {
  ready: { label: 'Available', tone: 'accent' },
  blocked: { label: 'Blocked — not connected', tone: 'danger' },
  unknown: { label: 'Not evaluated', tone: 'neutral' },
};

/**
 * The composer. Rendered entirely from inert elements — no `<form>`, no
 * `<button>`, no `<input>` — so the site-wide "nothing on any page executes
 * anything" invariant holds literally rather than by convention.
 */
function directOrderComposer(routes: DirectOrderRouteAvailability[] | undefined): string {
  const fields = [
    ['Instruction', 'What you want done, in your own words. A brief for a worker — never a command to run.'],
    ['Project (optional)', 'A label only. Labels are presentation, never authority.'],
  ]
    .map(
      ([label, hint]) => `<div class="order-field">
<p class="order-label">${escapeHtml(label)}</p>
<span class="control-readonly" aria-disabled="true">${escapeHtml(hint)}</span>
</div>`,
    )
    .join('\n');

  const routeChips = DIRECT_ORDER_ROUTES.map((route) => {
    const found = routes?.find((entry) => entry.route === route);
    const state = found == null ? 'unknown' : found.resolution.connected ? 'ready' : 'blocked';
    const presentation = ROUTE_STATE_PRESENTATION[state];
    const detail = found?.resolution.reason ?? 'Route availability was not evaluated for this build.';
    return `<div class="order-route" data-route="${escapeHtml(route)}" data-route-static-state="${escapeHtml(state)}">
<p class="row">${chip(route, 'neutral', true)}<span data-route-state-chip>${chip(presentation.label, presentation.tone)}</span></p>
<p class="faint" data-route-reason>${escapeHtml(detail)}</p>
</div>`;
  }).join('\n');

  return `<div class="panel order-composer">
<p class="readonly-note">${escapeHtml(DIRECT_ORDER_BLOCKER)}</p>
${fields}
<div class="order-field">
<p class="order-label">Route</p>
<div class="grid grid-cards">${routeChips}</div>
</div>
<div class="decision-controls" role="group" aria-label="Direct order controls — inert in this static render">
<span class="control-readonly" aria-disabled="true">Start Task</span>
<span class="faint">inert in this static render — a working control appears below only when the control API grants it to your session</span>
</div>
<div data-order-console></div>
<p class="muted">Every direct order is created as the Founder-gated capability <code>hq.direct_order</code>: it lands in <code>needs_approval</code> with an action digest and executes nothing until a Founder approves that exact action. An order for a provider that cannot dispatch today is still <b>RECORDED and BLOCKED</b>, never started and never lost — bound to the provider it names, so only a worker declared as that provider could ever claim it. No other provider is ever substituted.</p>
<p class="muted">The resolved provider is binding at execution, not a label: the order records it as <code>executionProvider</code>, and the Operator refuses to let any worker but one declared as that provider claim or start it. Because it sits in the payload, it is inside the digest the Founder approves — the provider cannot be swapped between approval and execution. <code>hq.direct_order</code> must also already be registered and enabled here: placing an order never registers it, and never re-enables one that was disabled.</p>
</div>`;
}

/**
 * The referrer policy every HQ page pins for itself (#219 correction round —
 * the Founder-workstation browser blocker on PR #225).
 *
 * ## Why a page needs an opinion about this at all
 *
 * `controlAvailability` grants a control only when the REQUEST'S OWN ORIGIN is
 * on the trusted list, because that is what `checkMutationOrigin` will decide
 * the eventual POST on. The console asks with `fetch(SESSION_PATH)` — a GET,
 * and a browser sends NO `Origin` header on a GET. So `Referer` is the only
 * evidence of the page's origin the request carries, and until now the pages
 * simply inherited whatever referrer policy the user agent happened to apply.
 *
 * That made the composer's existence a property of the BROWSER rather than of
 * the deployment: under a `no-referrer` document policy the identical, fully
 * configured stack answers `requestOriginSource: 'none'` and
 * `directOrder: false`, so the page correctly draws nothing — while a probe
 * with a hand-set `Referer` (curl, an HTTP client, devtools) reports
 * `directOrder: true` on the very same session. Reproduced in a real Chromium
 * against the real server: `no-referrer` → no composer; `same-origin` →
 * composer. That is exactly the shape of the reported blocker, and it is not
 * something a Founder could diagnose from the page.
 *
 * ## Why `same-origin` specifically
 *
 * It is STRICTER than the browser default (`strict-origin-when-cross-origin`),
 * never weaker: same-origin requests — the only kind any HQ page makes — carry
 * the full referrer, and cross-origin requests carry none at all rather than
 * the bare origin. So this widens nothing. It removes a dependency on a
 * user-agent default, and it cannot make the gate accept an origin it would
 * otherwise refuse: the server still checks the referrer's origin against the
 * configured allow-list, exactly as before.
 */
export const REFERRER_POLICY_META = '<meta name="referrer" content="same-origin">';

function provenanceBanner(note: string): string {
  return `<div class="provenance-banner" role="note" data-provenance-banner>
<b>SOURCE NOTE</b><span>${escapeHtml(note)}</span>
</div>`;
}

function shell({
  title,
  activeFile,
  eyebrow,
  lede,
  asOf,
  body,
  provenanceNote,
  sourceMode,
}: ShellOptions): string {
  const nav = HQ_PAGES.map(
    (page) =>
      `<li><a href="${page.file}"${page.file === activeFile ? ' aria-current="page"' : ''}><span class="glyph" aria-hidden="true">${page.glyph}</span>${escapeHtml(page.title)}</a></li>`,
  ).join('');
  const footer = provenanceNote
    ? `<footer class="muted" data-provenance>Data provenance: ${escapeHtml(provenanceNote)}</footer>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
${REFERRER_POLICY_META}
<title>JENIFY HQ — ${escapeHtml(title)}</title>
<style>${THEME_CSS}</style>
</head>
<body>
<a class="skip-link" href="#hq-main">Skip to ${escapeHtml(title)}</a>
<div class="shell">
<header class="rail">
<div class="brand"><span class="mark" aria-hidden="true">JQ</span><span class="wordmark"><b>JENIFY</b><span>Headquarter</span></span></div>
<nav aria-label="Headquarter sections"><ul>${nav}</ul></nav>
<p class="rail-foot">Founder view over the canonical activity log. Nothing mutates outside the Founder-gated control API, and no control is drawn that the control API did not grant to this session.</p>
</header>
<main id="hq-main">
<div class="page-head">
<p class="eyebrow">${escapeHtml(eyebrow)}</p>
<h1>${escapeHtml(title)}</h1>
<p class="lede">${escapeHtml(lede)}</p>
<p class="row" data-as-of>${chip(`As of ${asOf}`, 'neutral', true)}${
    sourceMode ? chip(SOURCE_MODE_LABELS[sourceMode], SOURCE_MODE_TONE[sourceMode], true) : ''
  }${freshnessChip()}</p>
<p class="faint" data-live-detail>Checking whether a newer snapshot exists…</p>
</div>
${provenanceNote ? provenanceBanner(provenanceNote) : ''}
${body}
${footer}
${liveRefreshScript(asOf)}
</main>
</div>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* Shared task/identity fragments                                      */
/* ------------------------------------------------------------------ */

function taskRefs(state: TaskState): string {
  const refs = (state.refs ?? []).filter((ref) => ref.startsWith('https:'));
  if (refs.length === 0) return '';
  return `<p class="faint">${refs
    .map((ref, index) => `<a href="${escapeHtml(ref)}">evidence ${index + 1}</a>`)
    .join(' · ')}</p>`;
}

/** Compact task card used across the Command Center lanes and project board. */
function taskCard(state: TaskState, nowIso: string, extraClass = ''): string {
  return `<article class="card${extraClass ? ` ${extraClass}` : ''}">
<h3>${escapeHtml(state.title)}</h3>
<p class="row">${statusChip(state.status)}${chip(state.project, 'neutral')}</p>
<p class="faint">${escapeHtml(state.taskId)} · ${escapeHtml(state.worker)} · ${escapeHtml(relativeAge(state.updatedAt, nowIso))}</p>
${taskRefs(state)}
</article>`;
}

function taskRows(states: TaskState[], label: string): string {
  if (states.length === 0) return emptyState('Nothing here.');
  const rows = states
    .map(
      (state) => `<tr>
<td>${escapeHtml(state.taskId)}</td>
<td>${escapeHtml(state.title)}</td>
<td>${escapeHtml(state.project)}</td>
<td>${escapeHtml(state.worker)}</td>
<td>${statusChip(state.status)}</td>
<td>${escapeHtml(state.updatedAt)}</td>
</tr>`,
    )
    .join('\n');
  return tableWrap(
    `<table><thead><tr><th>Task</th><th>Title</th><th>Project</th><th>Worker</th><th>Status</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>`,
    label,
  );
}

function participantIdentity(author: string, specialists: WorkerDescriptor[], small = false): string {
  if (author === 'founder') return identity('founder', 'Founder', 'Human · final authority', small);
  const descriptor = specialists.find((specialist) => specialist.id === author);
  if (!descriptor) return identity(author, author, 'Participant recorded in the transcript', small);
  return identity(
    descriptor.id,
    descriptor.displayName,
    `${descriptor.vendor} · ${ROLE_LABELS[descriptor.role]}`,
    small,
  );
}

function timelineClass(status: ActivityEvent['status']): string {
  if (status === 'blocked' || status === 'outcome_unknown') return 'is-blocked';
  if (status === 'needs_approval') return 'is-approval';
  if (status === 'completed') return 'is-done';
  if (status === null) return '';
  return 'is-active';
}

/* ------------------------------------------------------------------ */
/* Page 1 — Command Center                                             */
/* ------------------------------------------------------------------ */

export interface CommandCenterInput {
  dashboard: FounderDashboard;
  workers: WorkerStatus[];
  specialists: WorkerDescriptor[];
  /** Recent canonical activity, newest first. */
  feed: ActivityEvent[];
  approvals: ApprovalRequest[];
  /** UTC instant the page treats as "now" for relative ages. */
  nowIso: string;
  provenanceNote?: string;
  sourceMode?: SourceMode;
  /**
   * Truthful route availability for the Direct Order composer, as observed
   * by `resolveOrderRoute`. Omitted → the composer states that availability
   * was not evaluated for this build, which is different from (and must not
   * be rendered as) "unavailable".
   */
  orderRoutes?: DirectOrderRouteAvailability[];
}

export function renderCommandCenter({
  dashboard,
  workers,
  specialists,
  feed,
  approvals,
  nowIso,
  provenanceNote,
  sourceMode,
  orderRoutes,
}: CommandCenterInput): string {
  const attention = founderAttentionQueue(dashboard);
  const pendingApprovals = approvals.filter((approval) => approval.decision === 'pending');
  const activeWorkers = workers.filter((worker) => worker.activeCount > 0);

  const kpis = kpiRow([
    {
      label: 'In flight',
      value: dashboard.now.length,
      hint: 'tasks recorded as active right now',
      tone: dashboard.now.length > 0 ? 'info' : 'neutral',
    },
    {
      label: 'Needs you',
      value: attention.length,
      hint: 'approvals and blockers waiting on the Founder',
      tone: attention.length > 0 ? 'warn' : 'accent',
    },
    {
      label: 'Blocked',
      value: dashboard.blocked.length,
      hint: 'stopped work, not self-clearing',
      tone: dashboard.blocked.length > 0 ? 'danger' : 'accent',
    },
    {
      label: 'Done today',
      value: dashboard.doneToday.length,
      hint: 'completions recorded on today’s UTC date',
      tone: 'accent',
    },
    {
      label: 'Workers active',
      value: `${activeWorkers.length}/${workers.length}`,
      hint: 'holding at least one active task',
      tone: 'neutral',
    },
    {
      label: 'Queued next',
      value: dashboard.next.length,
      hint: 'accepted work not yet started',
      tone: 'neutral',
    },
  ]);

  const attentionPanel =
    attention.length === 0
      ? emptyState('Nothing is waiting on the Founder. No approvals pending, nothing blocked.')
      : `<div class="grid grid-wide">${attention
          .map((item) => {
            const presentation = ATTENTION_PRESENTATION[item.reason];
            return `<article class="card attention-card${presentation.tone === 'danger' ? ' tone-danger' : ''}">
<p class="row">${chip(presentation.label, presentation.tone, true)}${chip(item.state.project, 'neutral')}</p>
<h3>${escapeHtml(item.state.title)}</h3>
<p class="muted">${escapeHtml(presentation.why)}</p>
<p class="faint">${escapeHtml(item.state.taskId)} · raised by ${escapeHtml(item.state.worker)} · ${escapeHtml(relativeAge(item.state.updatedAt, nowIso))}</p>
${taskRefs(item.state)}
</article>`;
          })
          .join('\n')}
<p class="muted">${pendingApprovals.length} formal approval request${pendingApprovals.length === 1 ? '' : 's'} recorded — see <a href="approvals.html">Founder Approvals</a>.</p></div>`;

  const lanes = ([
    ['NOW', dashboard.now],
    ['NEXT', dashboard.next],
    ['DONE TODAY', dashboard.doneToday],
    ['BLOCKED', dashboard.blocked],
    ['WAITING FOR FOUNDER', dashboard.waitingForFounder],
  ] as const)
    .map(
      ([title, states]) =>
        `${section(
          title,
          states.length === 0
            ? emptyState('Nothing here.')
            : `<div class="stack">${states.map((state) => taskCard(state, nowIso)).join('\n')}</div>`,
        )}`,
    )
    .join('\n');

  const workforce =
    workers.length === 0
      ? emptyState('No worker activity recorded yet.')
      : `<div class="grid grid-cards">${workers
          .map((worker) => {
            const descriptor = specialists.find((specialist) => specialist.id === worker.worker);
            const busy = worker.activeCount > 0;
            return `<article class="card">
<p class="row-between">${participantIdentity(worker.worker, specialists)}${chip(
              busy ? 'Working' : worker.blockedCount > 0 ? 'Blocked' : 'Idle',
              busy ? 'info' : worker.blockedCount > 0 ? 'danger' : 'neutral',
              true,
            )}</p>
${
  worker.activeTask
    ? `<p class="muted">On <strong>${escapeHtml(worker.activeTask.title)}</strong></p>`
    : '<p class="muted">No active assignment recorded.</p>'
}
<p class="faint">active ${worker.activeCount} · blocked ${worker.blockedCount} · completed ${worker.completedCount}</p>
<p class="faint">last seen ${escapeHtml(relativeAge(worker.lastSeen, nowIso))}${
              descriptor ? '' : ' · not in the specialist directory'
            }</p>
</article>`;
          })
          .join('\n')}</div>`;

  const activity =
    feed.length === 0
      ? emptyState('No activity recorded.')
      : `<ul class="feed">${feed
          .map(
            (event) => `<li>
<span class="faint when">${escapeHtml(relativeAge(event.at, nowIso))}</span>
<span class="what"><strong>${escapeHtml(event.actor)}</strong> — ${escapeHtml(event.summary)}
${event.status ? ` ${statusChip(event.status)}` : ` ${chip('note', 'neutral')}`}</span>
</li>`,
          )
          .join('\n')}</ul>`;

  const body = `${kpis}
<div class="split-main">
<div>
${section('WHAT NEEDS THE FOUNDER', attentionPanel, 'founder-attention')}
${section('DIRECT ORDER', directOrderComposer(orderRoutes), 'direct-order')}
${directOrderConsoleScript({
  ready: ROUTE_STATE_PRESENTATION.ready,
  blocked: ROUTE_STATE_PRESENTATION.blocked,
})}
<div class="grid grid-lanes">${lanes}</div>
</div>
<div>
${section('LIVE ACTIVITY', `<div class="panel">${activity}</div>`)}
${section('ACTIVE AI WORKFORCE', workforce)}
</div>
</div>`;

  return shell({
    title: 'Command Center',
    activeFile: 'index.html',
    eyebrow: 'Founder operating view',
    lede: 'What is happening, what finished, what is blocked, who is working, and what needs you — from the canonical activity log only.',
    asOf: nowIso,
    body,
    provenanceNote,
    sourceMode,
  });
}

/* ------------------------------------------------------------------ */
/* Page 2 — Projects                                                   */
/* ------------------------------------------------------------------ */

export function renderProjects(
  cards: ProjectBoardCard[],
  timelines: Map<string, ActivityEvent[]>,
  nowIso: string,
  provenanceNote?: string,
  sourceMode?: SourceMode,
): string {
  const board =
    cards.length === 0
      ? emptyState('No projects have recorded activity yet.')
      : `<div class="grid grid-wide">${cards
          .map((card) => {
            const health = HEALTH_PRESENTATION[card.health];
            const percent = Math.round(card.completedShare * 100);
            return `<article class="card" data-project-card="${escapeHtml(card.project)}">
<p class="row-between"><span class="identity">${avatar(card.project, card.project)}<span class="who"><b>${escapeHtml(card.project)}</b><span>${card.totalCount} recorded task${card.totalCount === 1 ? '' : 's'}</span></span></span>${chip(health.label, health.tone, true)}</p>
${meter(card.completedShare, `${card.project} completed share of recorded tasks`)}
<p class="faint">${percent}% of recorded tasks completed · ${card.openCount} open · ${card.blockedCount} blocked · ${card.waitingForFounderCount} awaiting Founder</p>
<p class="row">${
              card.activeWorkers.length > 0
                ? card.activeWorkers.map((worker) => chip(worker, 'info')).join('')
                : chip('no active worker', 'neutral')
            }</p>
${
  card.blockers.length > 0
    ? `<p class="muted"><strong>Blocker:</strong> ${escapeHtml(card.blockers[0].title)} <span class="faint">(${escapeHtml(card.blockers[0].worker)})</span></p>`
    : ''
}
${
  card.latestCompleted
    ? `<p class="muted"><strong>Latest achievement:</strong> ${escapeHtml(card.latestCompleted.title)}</p>`
    : ''
}
${
  card.nextQueued
    ? `<p class="muted"><strong>Next queued:</strong> ${escapeHtml(card.nextQueued.title)}</p>`
    : ''
}
${
  card.latestUpdate
    ? `<p class="faint"><strong>Recent update:</strong> ${escapeHtml(card.latestUpdate.title)} — ${escapeHtml(relativeAge(card.lastActivity, nowIso))}</p>`
    : ''
}
<p class="faint"><a href="#timeline-${escapeHtml(slug(card.project))}">Open project timeline</a></p>
</article>`;
          })
          .join('\n')}</div>`;

  const timelineHtml = [...timelines.entries()]
    .map(([project, events]) =>
      section(
        `Timeline — ${project}`,
        events.length === 0
          ? emptyState('No events recorded for this project.')
          : `<div class="panel"><ul class="timeline">${events
              .map(
                (event) => `<li class="${timelineClass(event.status)}">
<p class="row">${event.status ? statusChip(event.status) : chip('note', 'neutral')}<span class="faint">${escapeHtml(event.at)}</span></p>
<p>${escapeHtml(event.summary)}</p>
<p class="faint">${escapeHtml(event.actor)}</p>
</li>`,
              )
              .join('\n')}</ul></div>`,
        `timeline-${slug(project)}`,
      ),
    )
    .join('\n');

  return shell({
    title: 'Projects',
    activeFile: 'projects.html',
    eyebrow: 'Company portfolio board',
    lede: 'Every project with recorded activity, its health, who is on it, what is blocking it, and what happened last.',
    asOf: nowIso,
    body: `${section('PORTFOLIO', board)}${timelineHtml}`,
    provenanceNote,
    sourceMode,
  });
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
}

/* ------------------------------------------------------------------ */
/* Pages 3 & 4 — Executive Room and Direct Chats                       */
/* ------------------------------------------------------------------ */

interface Thread {
  id: string;
  messages: ChatMessage[];
  participants: string[];
}

function groupThreads(messages: ChatMessage[]): Thread[] {
  const byThread = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const list = byThread.get(message.threadId) ?? [];
    list.push(message);
    byThread.set(message.threadId, list);
  }
  return [...byThread.entries()]
    .map(([id, threadMessages]) => {
      const ordered = [...threadMessages].sort((a, b) => a.at.localeCompare(b.at));
      return { id, messages: ordered, participants: [...new Set(ordered.map((message) => message.author))] };
    })
    .sort((a, b) => {
      const aLast = a.messages[a.messages.length - 1].at;
      const bLast = b.messages[b.messages.length - 1].at;
      return bLast.localeCompare(aLast);
    });
}

function messageBubble(message: ChatMessage, specialists: WorkerDescriptor[], nowIso: string): string {
  const refs = (message.refs ?? []).filter((ref) => ref.startsWith('https:'));
  return `<article class="msg${message.author === 'founder' ? ' from-founder' : ''}">
<div class="msg-head">${participantIdentity(message.author, specialists, true)}<span class="faint">${escapeHtml(relativeAge(message.at, nowIso))}</span></div>
<p class="body">${escapeHtml(message.body)}</p>
${refs.length > 0 ? `<p class="faint">${refs.map((ref, index) => `<a href="${escapeHtml(ref)}">reference ${index + 1}</a>`).join(' · ')}</p>` : ''}
</article>`;
}

const TRANSCRIPT_NOTE =
  'Read-only transcript view. There is no send box on this page because live messaging is not wired yet — it arrives with the operator control layer.';

export function renderExecutiveRoom(
  messages: ChatMessage[],
  specialists: WorkerDescriptor[],
  approvals: ApprovalRequest[],
  nowIso: string,
  provenanceNote?: string,
  sourceMode?: SourceMode,
): string {
  const threads = groupThreads(messages);
  const all = threads.flatMap((thread) => thread.messages);
  const participants = [...new Set(all.map((message) => message.author))];
  const latest = all.length > 0 ? all.reduce((a, b) => (a.at > b.at ? a : b)) : null;
  const pending = approvals.filter((approval) => approval.decision === 'pending');

  const participantPanel =
    participants.length === 0
      ? emptyState('No participants recorded.')
      : `<div class="stack">${participants
          .map((participant) => `<div class="card">${participantIdentity(participant, specialists)}</div>`)
          .join('\n')}</div>`;

  const decisionPanel =
    pending.length === 0
      ? emptyState('No decision is recorded as waiting on the Founder.')
      : `<div class="stack">${pending
          .map(
            (approval) => `<article class="card attention-card">
<p class="row">${chip(approval.riskClass, 'warn', true)}</p>
<p>${escapeHtml(approval.ask)}</p>
<p class="faint">raised by ${escapeHtml(approval.requestedBy)} · ${escapeHtml(relativeAge(approval.requestedAt, nowIso))}</p>
</article>`,
          )
          .join('\n')}<p class="muted">Decide these in <a href="approvals.html">Founder Approvals</a>.</p></div>`;

  const body = `<p class="readonly-note">${escapeHtml(TRANSCRIPT_NOTE)}</p>
${kpiRow([
  { label: 'Participants', value: participants.length, hint: 'distinct voices in the room' },
  { label: 'Contributions', value: all.length, hint: 'recorded messages' },
  {
    label: 'Last activity',
    value: latest ? relativeAge(latest.at, nowIso) : '—',
    hint: latest ? `by ${latest.author}` : 'nothing recorded',
  },
  {
    label: 'Founder decisions open',
    value: pending.length,
    hint: 'pending approval requests',
    tone: pending.length > 0 ? 'warn' : 'accent',
  },
])}
<div class="convo-layout">
<div>${section('IN THE ROOM', participantPanel)}</div>
<div>${section(
    'DISCUSSION',
    threads.length === 0
      ? emptyState('No transcripts available yet.')
      : threads
          .map(
            (thread) => `<div class="panel"><p class="row-between"><strong>${escapeHtml(thread.id)}</strong><span class="faint">${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'}</span></p>
<div class="thread">${thread.messages.map((message) => messageBubble(message, specialists, nowIso)).join('\n')}</div></div>`,
          )
          .join('\n'),
  )}</div>
<div>${section('FOUNDER DECISION', decisionPanel)}</div>
</div>`;

  return shell({
    title: 'Executive Room',
    activeFile: 'executive-room.html',
    eyebrow: 'AI boardroom',
    lede: 'Who is in the room, what they contributed, and which decisions are sitting with the Founder.',
    asOf: nowIso,
    body,
    provenanceNote,
    sourceMode,
  });
}

export function renderDirectChats(
  messages: ChatMessage[],
  specialists: WorkerDescriptor[],
  states: TaskState[],
  nowIso: string,
  provenanceNote?: string,
  sourceMode?: SourceMode,
): string {
  const threads = groupThreads(messages);

  const list =
    threads.length === 0
      ? emptyState('No direct conversations recorded.')
      : `<ul class="convo-list">${threads
          .map((thread) => {
            const workerId = thread.id.replace(/^dm:/, '');
            const last = thread.messages[thread.messages.length - 1];
            return `<li><a href="#thread-${escapeHtml(slug(thread.id))}">
${participantIdentity(workerId, specialists, true)}
<span class="faint">${escapeHtml(relativeAge(last.at, nowIso))} · ${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'}</span>
</a></li>`;
          })
          .join('\n')}</ul>`;

  const conversations =
    threads.length === 0
      ? emptyState('No transcripts available yet.')
      : threads
          .map((thread) => {
            const workerId = thread.id.replace(/^dm:/, '');
            const workerStates = states.filter((state) => state.worker === workerId);
            const active = workerStates.filter((state) =>
              ['assigned', 'running', 'review_failed', 'review_passed'].includes(state.status),
            );
            const blocked = workerStates.filter(
              (state) => state.status === 'blocked' || state.status === 'outcome_unknown',
            );
            const waiting = workerStates.filter((state) => state.status === 'needs_approval');
            const done = workerStates.filter((state) => state.status === 'completed');
            const workState = blocked.length > 0 ? 'Blocked' : active.length > 0 ? 'Working' : waiting.length > 0 ? 'Waiting on Founder' : 'Idle';
            const workTone: Tone =
              blocked.length > 0 ? 'danger' : active.length > 0 ? 'info' : waiting.length > 0 ? 'warn' : 'neutral';
            return `<div class="panel" id="thread-${escapeHtml(slug(thread.id))}">
<p class="row-between">${participantIdentity(workerId, specialists)}${chip(workState, workTone, true)}</p>
<p class="faint">${escapeHtml(thread.id)}</p>
<div class="thread">${thread.messages.map((message) => messageBubble(message, specialists, nowIso)).join('\n')}</div>
<div class="record-meta">
<p class="faint">CONTEXT — derived from the canonical task log, not from the conversation</p>
${
  active.length > 0
    ? `<p class="muted">Working on: ${active.map((state) => escapeHtml(state.title)).join(', ')}</p>`
    : ''
}
${blocked.length > 0 ? `<p class="muted">Blocked on: ${blocked.map((state) => escapeHtml(state.title)).join(', ')}</p>` : ''}
${waiting.length > 0 ? `<p class="muted">Waiting on Founder: ${waiting.map((state) => escapeHtml(state.title)).join(', ')}</p>` : ''}
<p class="faint">active ${active.length} · blocked ${blocked.length} · awaiting Founder ${waiting.length} · completed ${done.length}</p>
</div>
</div>`;
          })
          .join('\n');

  const body = `<p class="readonly-note">${escapeHtml(TRANSCRIPT_NOTE)} Attachments and file sharing are not part of this contract, so no attachment control is shown.</p>
<div class="convo-layout two-pane">
<div>${section('CONVERSATIONS', list)}</div>
<div>${section('TRANSCRIPT', conversations)}</div>
</div>`;

  return shell({
    title: 'Direct Chats',
    activeFile: 'direct-chats.html',
    eyebrow: 'Founder ↔ worker channel',
    lede: 'Direct transcripts with each AI worker, alongside what that worker is actually recorded as doing.',
    asOf: nowIso,
    body,
    provenanceNote,
    sourceMode,
  });
}

/* ------------------------------------------------------------------ */
/* Page 5 — Specialist Directory                                       */
/* ------------------------------------------------------------------ */

export function renderSpecialistDirectory(
  profiles: SpecialistProfile[],
  nowIso: string,
  provenanceNote?: string,
  sourceMode?: SourceMode,
): string {
  const cards =
    profiles.length === 0
      ? emptyState('No specialists registered.')
      : `<div class="grid grid-cards">${profiles
          .map(({ descriptor, status }) => {
            const busy = (status?.activeCount ?? 0) > 0;
            const availability = !descriptor.active
              ? { label: 'Inactive', tone: 'neutral' as Tone }
              : busy
                ? { label: 'On assignment', tone: 'info' as Tone }
                : { label: 'Available', tone: 'accent' as Tone };
            return `<article class="card" data-specialist="${escapeHtml(descriptor.id)}">
<p class="row-between">${identity(descriptor.id, descriptor.displayName, `${descriptor.vendor} · ${ROLE_LABELS[descriptor.role]}`)}${chip(availability.label, availability.tone, true)}</p>
<p class="faint">${escapeHtml(descriptor.id)}</p>
${
  status
    ? `<p class="muted">${
        status.activeTask
          ? `Current assignment: <strong>${escapeHtml(status.activeTask.title)}</strong>`
          : 'No current assignment recorded.'
      }</p>
<p class="faint">active ${status.activeCount} · blocked ${status.blockedCount} · completed ${status.completedCount} · last seen ${escapeHtml(relativeAge(status.lastSeen, nowIso))}</p>`
    : '<p class="faint">No recorded activity for this specialist yet.</p>'
}
<div class="record-meta">
<p class="faint">CAPABILITIES GRANTED</p>
<p class="row">${
              descriptor.allowedCapabilities.length > 0
                ? descriptor.allowedCapabilities.map((capability) => chip(capability, 'violet')).join('')
                : chip('none granted', 'neutral')
            }</p>
</div>
</article>`;
          })
          .join('\n')}</div>`;

  const note =
    'Capabilities shown are the ones granted in the worker descriptor and the capability registry — a worker’s own self-description is never a permission. Cost and token usage are not part of these contracts, so this page does not show them rather than estimating them.';

  return shell({
    title: 'Specialist Directory',
    activeFile: 'specialists.html',
    eyebrow: 'AI workforce',
    lede: 'Every registered specialist: identity, platform, role, granted capabilities, and current recorded workload.',
    asOf: nowIso,
    body: `<p class="readonly-note">${escapeHtml(note)}</p>${section('WORKFORCE', cards)}`,
    provenanceNote,
    sourceMode,
  });
}

/* ------------------------------------------------------------------ */
/* Page 6 — Founder Approvals                                          */
/* ------------------------------------------------------------------ */

const HIGH_RISK_CLASSES = ['founder_gate', 'destructive', 'production', 'payment', 'irreversible'];

/**
 * Read-only Founder Approvals page (§6b): renders the D15 approval fields
 * (actionDigest, expiresAt, consumedAt, decidedBy) and offers NO
 * approve/reject actions — decisions stay in the operator control plane.
 *
 * The Approve / Reject / Ask for Changes affordances are drawn so the layout
 * is honest about where decisions will live, but they are inert spans, not
 * buttons or form controls, and each carries a visible "not wired" label.
 */
export function renderFounderApprovals(
  waiting: TaskState[],
  approvals: ApprovalRequest[],
  nowIso: string,
  provenanceNote?: string,
  sourceMode?: SourceMode,
): string {
  const note =
    'The cards below are the build-time approval record and stay read-only: their Approve / Reject / Ask for changes markers are inert placeholders. Working decision controls exist only in the LIVE DECISIONS panel, and only after the Founder-gated control API confirms this session holds the approve or deny grant — every decision it takes still goes through the action digest, expiry and single-use nonce. If the control API grants nothing, nothing on this page can submit.';

  const pending = approvals.filter((approval) => approval.decision === 'pending');
  const decided = approvals.filter((approval) => approval.decision !== 'pending');

  const decisionControls = `<div class="decision-controls" role="group" aria-label="Decision controls — inert on this build-time card">
<span class="control-readonly" aria-disabled="true">Approve</span>
<span class="control-readonly" aria-disabled="true">Reject</span>
<span class="control-readonly" aria-disabled="true">Ask for changes</span>
<span class="faint">inert build-time card — live decisions happen in the LIVE DECISIONS panel above, and only when the control API grants them</span>
</div>`;

  function approvalCard(approval: ApprovalRequest): string {
    const highRisk = HIGH_RISK_CLASSES.includes(approval.riskClass);
    const decisionTone: Tone =
      approval.decision === 'approved' ? 'accent' : approval.decision === 'denied' ? 'danger' : 'warn';
    return `<article class="card${highRisk ? ' risk-high' : ''}" data-approval="${escapeHtml(approval.id)}">
<p class="row">${chip(`Risk: ${approval.riskClass}`, highRisk ? 'danger' : 'warn', true)}${chip(approval.decision, decisionTone)}${
      approval.taskId ? chip(approval.taskId, 'neutral') : ''
    }</p>
<h3>${escapeHtml(approval.ask)}</h3>
<p class="muted">Requested by ${escapeHtml(approval.requestedBy)} · ${escapeHtml(relativeAge(approval.requestedAt, nowIso))}</p>
${approval.decisionNote ? `<p class="muted">Note: ${escapeHtml(approval.decisionNote)}</p>` : ''}
<div class="record-meta">
<p class="faint">Decided by: ${approval.decidedBy ? escapeHtml(approval.decidedBy) : '—'}</p>
<p class="faint">Action digest: ${
      approval.actionDigest ? `<code>${escapeHtml(approval.actionDigest.slice(0, 16))}…</code>` : '—'
    }</p>
<p class="faint">Expires: ${approval.expiresAt ? escapeHtml(approval.expiresAt) : '—'} · Consumed: ${
      approval.consumedAt ? escapeHtml(approval.consumedAt) : '—'
    }</p>
</div>
${approval.decision === 'pending' ? decisionControls : ''}
</article>`;
  }

  const pendingHtml =
    pending.length === 0
      ? emptyState('No approval request is pending.')
      : `<div class="grid grid-wide">${pending.map(approvalCard).join('\n')}</div>`;
  const decidedHtml =
    decided.length === 0
      ? emptyState('No decisions recorded yet.')
      : `<div class="grid grid-wide">${decided.map(approvalCard).join('\n')}</div>`;

  const body = `<p class="readonly-note">${escapeHtml(note)}</p>
${section('LIVE DECISIONS', '<div data-approvals-console></div>', 'live-decisions')}
${approvalsConsoleScript()}
${kpiRow([
  { label: 'Pending', value: pending.length, hint: 'awaiting a Founder decision', tone: pending.length > 0 ? 'warn' : 'accent' },
  {
    label: 'High risk pending',
    value: pending.filter((approval) => HIGH_RISK_CLASSES.includes(approval.riskClass)).length,
    hint: 'Founder-gated or irreversible',
    tone: 'danger',
  },
  { label: 'Decided', value: decided.length, hint: 'recorded decisions' },
  { label: 'Tasks waiting', value: waiting.length, hint: 'tasks in needs_approval' },
])}
${section('PENDING DECISIONS', pendingHtml)}
${section('DECISION HISTORY', decidedHtml)}
${section('TASKS WAITING FOR FOUNDER', taskRows(waiting, 'Tasks waiting for the Founder'))}`;

  return shell({
    title: 'Founder Approvals',
    activeFile: 'approvals.html',
    eyebrow: 'Decision center',
    lede: 'Every request that cannot move without you, what it would do, and how risky it is.',
    asOf: nowIso,
    body,
    provenanceNote,
    sourceMode,
  });
}

/* ------------------------------------------------------------------ */
/* Page 7 — Connections (issue #200, scope C)                          */
/* ------------------------------------------------------------------ */

const CONNECTIONS_NOTE =
  'Every state on this page is derived from facts actually observed in this environment — not from ' +
  'the provider catalogue, not from a registered AI member, and not from a vendor descriptor. A name ' +
  'appearing here means HQ knows what the integration would be, never that it is reachable. ' +
  'CONFIGURED means the credentials are present and nothing has checked them. DISPATCHABLE means ' +
  'more — an executor exists and every fact it needs to run is present, so HQ would route work to ' +
  'it — but still nothing has asked the provider itself, so an expired or revoked credential would ' +
  'look identical. Neither is Connected, and neither grants a capability: CONNECTED means a live ' +
  'check ran against the service and succeeded, and HQ registers no such check yet. Only secret ' +
  'PRESENCE is recorded anywhere in HQ; no credential value is read, stored, logged or rendered.';

export function renderConnections(
  statuses: ConnectionStatus[],
  nowIso: string,
  provenanceNote?: string,
  sourceMode?: SourceMode,
): string {
  const counts = connectionSummary(statuses);

  const card = (status: ConnectionStatus): string => {
    const usable = status.state === 'connected' || status.state === 'local_only';
    const capabilities =
      status.effectiveCapabilities.length > 0
        ? `<p class="row">${status.effectiveCapabilities.map((capability) => chip(capability, 'accent')).join('')}</p>`
        : `<p class="faint">No capability is available to HQ through this connection${
            usable
              ? '.'
              : status.state === 'dispatchable'
                ? ': HQ would route work to it, but nothing has asked the provider whether the credential still works, and dispatchability alone grants nothing.'
                : status.state === 'configured'
                  ? ': its credentials are present, but nothing has verified them, and configuration alone grants nothing.'
                  : ' while it is not connected.'
          }</p>`;

    // Fact NAMES only. This is the presence-not-value convention that makes a
    // connection status renderable in a browser at all.
    const facts = [
      status.observedFacts.length > 0
        ? `<p class="faint">Observed present: ${status.observedFacts.map((fact) => `<code>${escapeHtml(fact)}</code>`).join(', ')}</p>`
        : '',
      status.missingFacts.length > 0
        ? `<p class="faint">Observed absent: ${status.missingFacts.map((fact) => `<code>${escapeHtml(fact)}</code>`).join(', ')}</p>`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    // A control is drawn ONLY where a real implementation exists. An
    // unavailable action is described in words instead of mocked as a button.
    const controls = `<div class="decision-controls" role="group" aria-label="Connection controls">
${
  status.canRecheck
    ? '<span class="control-readonly" aria-disabled="true">Recheck</span>'
    : ''
}
<span class="faint">${escapeHtml(
      status.canRecheck
        ? 'Recheck re-reads the same non-secret facts; it is not wired to the browser, and runs from the Founder workstation.'
        : 'No safe recheck exists for this integration yet, so no control is drawn.',
    )}</span>
<span class="faint">${escapeHtml(
      status.canDisconnect
        ? 'Disconnect revokes the stored credential.'
        : 'No Disconnect/Revoke control is drawn: HQ holds no credential of its own to revoke, so the control would do nothing.',
    )}</span>
</div>`;

    return `<article class="card" data-connection="${escapeHtml(status.id)}" data-connection-static-state="${escapeHtml(status.state)}">
<p class="row"><span data-connection-state-chip>${chip(CONNECTION_STATE_LABELS[status.state], CONNECTION_STATE_TONE[status.state], true)}</span>${chip(
      AUTH_MECHANISM_LABELS[status.authMechanism],
      'neutral',
    )}${chip(status.locality === 'local' ? 'Local' : 'Cloud', 'neutral')}</p>
<h3>${escapeHtml(status.displayName)}</h3>
<p class="muted" data-connection-reason>${escapeHtml(status.reason)}</p>
${capabilities}
<div class="record-meta">
${facts}
<p class="faint">Evidence: ${escapeHtml(status.evidenceSource)}</p>
<p class="faint">Verification: ${escapeHtml(status.verification.replace(/_/g, ' '))} — ${escapeHtml(status.outcome.replace(/_/g, ' '))}</p>
<p class="faint">Last verified: ${status.lastVerifiedAt ? escapeHtml(status.lastVerifiedAt) : 'never'}</p>
</div>
${controls}
</article>`;
  };

  const body = `<p class="readonly-note">${escapeHtml(CONNECTIONS_NOTE)}</p>
${kpiRow([
  { id: 'connected', label: 'Connected', value: counts.connected, hint: 'a live check succeeded', tone: counts.connected > 0 ? 'accent' : 'neutral' },
  { id: 'dispatchable', label: 'Dispatchable', value: counts.dispatchable, hint: 'routable, never verified', tone: counts.dispatchable > 0 ? 'info' : 'neutral' },
  { id: 'configured', label: 'Configured', value: counts.configured, hint: 'credentials present, never verified', tone: counts.configured > 0 ? 'warn' : 'neutral' },
  { id: 'setup_required', label: 'Setup required', value: counts.setup_required, hint: 'partially configured', tone: counts.setup_required > 0 ? 'warn' : 'neutral' },
  { id: 'not_connected', label: 'Not connected', value: counts.not_connected, hint: 'no required fact observed' },
  { id: 'error', label: 'Error', value: counts.error, hint: 'a check failed or the probe threw', tone: counts.error > 0 ? 'danger' : 'neutral' },
])}
${section(
  'CONNECTIONS',
  statuses.length === 0
    ? emptyState('No integration is catalogued.')
    : `<div class="grid grid-wide">${statuses.map(card).join('\n')}</div>`,
)}
${connectionsLiveScript(
  { label: CONNECTION_STATE_LABELS.dispatchable, tone: CONNECTION_STATE_TONE.dispatchable },
  { label: CONNECTION_STATE_LABELS.not_connected, tone: CONNECTION_STATE_TONE.not_connected },
)}
${section(
  'ADDING A CONNECTION',
  `<div class="panel">
<p class="muted">A new integration is a descriptor plus a probe (<code>live/connections.ts</code>). A descriptor added without a probe stays <em>not connected</em> rather than optimistic — deny by default, as everywhere else in the control plane.</p>
<p class="muted">Adapter preference, in order: OAuth, then API key, then MCP or a local CLI, with browser automation only as a last resort.</p>
<div class="decision-controls" role="group" aria-label="Add connection — not available in the browser">
<span class="control-readonly" aria-disabled="true">+ Add Connection</span>
<span class="faint">not wired — adding a connection needs credentials HQ deliberately cannot hold on a Founder's behalf from a browser</span>
</div>
</div>`,
)}`;

  return shell({
    title: 'Connections',
    activeFile: 'connections.html',
    eyebrow: 'Connection center',
    lede: 'What HQ can genuinely reach right now, how it authenticates, what that grants — and what is merely catalogued.',
    asOf: nowIso,
    body,
    provenanceNote,
    sourceMode,
  });
}

/* ------------------------------------------------------------------ */
/* Page 8 — Archive / Knowledge (+ page 9 search experience)           */
/* ------------------------------------------------------------------ */

/**
 * Schemes allowed to become clickable links in rendered pages. Evidence
 * locators come from external exports (static/Drive adapters), so anything
 * not explicitly allowed — repo paths, Drive ids, javascript:, data:,
 * unknown schemes — renders as escaped, non-clickable text instead.
 */
const LINKABLE_SCHEMES = ['https:'];

export function renderSourceRef(sourceRef: string): string {
  let scheme: string | null = null;
  try {
    scheme = new URL(sourceRef).protocol;
  } catch {
    scheme = null;
  }
  if (scheme !== null && LINKABLE_SCHEMES.includes(scheme)) {
    return `<a href="${escapeHtml(sourceRef)}">original</a>`;
  }
  return `<code>${escapeHtml(sourceRef)}</code>`;
}

const ARCHIVE_BANNER =
  '<p class="readonly-note" data-archive-banner>These rows are reconstructed canonical records, not original evidence: each links to its preserved original via the source column. Dates flagged &quot;inferred&quot; or &quot;estimated&quot; are not authoritative and must be verified against the original before being relied on.</p>';

const ARCHIVE_STATUS_TONE: Record<string, Tone> = {
  CURRENT: 'accent',
  SUPERSEDED: 'neutral',
  REJECTED: 'danger',
  EXPERIMENTAL: 'violet',
  ARCHIVED: 'neutral',
};

function archiveStatusChip(status: string): string {
  return chip(status, ARCHIVE_STATUS_TONE[status] ?? 'neutral', true);
}

function relatedSummary(record: ArchiveRecord): string {
  const parts: string[] = [];
  if (record.related.issues?.length) parts.push(`issues ${record.related.issues.join(', ')}`);
  if (record.related.pullRequests?.length) parts.push(`PRs ${record.related.pullRequests.join(', ')}`);
  if (record.related.commits?.length) parts.push(`commits ${record.related.commits.join(', ')}`);
  if (record.related.artifacts?.length) parts.push(`artifacts ${record.related.artifacts.join(', ')}`);
  return parts.join(' · ');
}

function archiveCard(record: ArchiveRecord, neighbours: ArchiveRecord[]): string {
  const related = relatedSummary(record);
  const links = neighbours.filter((other) => other.id !== record.id);
  return `<details class="record" data-archive-id="${escapeHtml(record.id)}">
<summary>
<p class="row">${archiveStatusChip(record.status)}${chip(record.project, 'info')}${chip(record.category, 'neutral')}${chip(
    `v${record.version}`,
    'neutral',
  )}</p>
<h3>${escapeHtml(record.title)}</h3>
<p class="faint">${escapeHtml(record.created.date)}${
    record.created.confidence === 'exact' ? '' : ` · ${escapeHtml(record.created.confidence)} date`
  } · ${renderSourceRef(record.sourceRef)}</p>
</summary>
<div class="record-meta">
<p>${escapeHtml(record.summary)}</p>
${related ? `<p class="faint">Related: ${escapeHtml(related)}</p>` : ''}
${record.tags.length > 0 ? `<p class="row">${record.tags.map((tag) => chip(tag, 'neutral')).join('')}</p>` : ''}
${
  links.length > 0
    ? `<p class="faint">Other records in ${escapeHtml(record.project)}: ${links
        .slice(0, 4)
        .map((other) => escapeHtml(other.title))
        .join(' · ')}</p>`
    : ''
}
<p class="faint">Evidence observed ${escapeHtml(record.evidence.date)} (${escapeHtml(record.evidence.confidence)})</p>
</div>
</details>`;
}

function optionList(id: string, label: string, values: string[]): string {
  return `<div class="field">
<label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
<select id="${escapeHtml(id)}"><option value="">All</option>${values
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join('')}</select>
</div>`;
}

export function renderArchive(
  records: ArchiveRecord[],
  monthly: MonthlyGroup[],
  evolutions: Map<string, EvolutionChain[]>,
  nowIso: string,
  provenanceNote?: string,
  sourceMode?: SourceMode,
): string {
  const byProject = new Map<string, ArchiveRecord[]>();
  for (const record of records) {
    const list = byProject.get(record.project) ?? [];
    list.push(record);
    byProject.set(record.project, list);
  }

  const distinct = (values: string[]): string[] => [...new Set(values)].sort();
  const filters = `<div class="filter-bar">
<div class="field">
<label for="archive-search">Search</label>
<input id="archive-search" type="search" placeholder="e.g. qos chatbot upgrade" autocomplete="off">
</div>
${optionList('archive-filter-project', 'Project', distinct(records.map((record) => record.project)))}
${optionList('archive-filter-category', 'Category', distinct(records.map((record) => record.category)))}
${optionList('archive-filter-status', 'Status', distinct(records.map((record) => record.status)))}
${optionList('archive-filter-year', 'Year', distinct(records.map((record) => record.created.date.slice(0, 4))).reverse())}
</div>
<p class="muted" id="archive-count" role="status" aria-live="polite">${records.length} records in the archive.</p>`;

  const results = `<div id="archive-results" hidden>${records
    .map((record) => archiveCard(record, byProject.get(record.project) ?? []))
    .join('\n')}</div>`;

  const browse = `<div id="archive-browse">${monthly
    .map(
      (group) => `<section><h2>${group.year}-${group.month}</h2>
${tableWrap(
  `<table><thead><tr><th>Date</th><th>Title</th><th>Project</th><th>Category</th><th>Version</th><th>Status</th><th>Source</th></tr></thead><tbody>${group.records
    .map(
      (record) => `<tr><td>${escapeHtml(record.created.date)}${
        record.created.confidence === 'exact' ? '' : ` ${chip(record.created.confidence, 'warn')}`
      }</td><td>${escapeHtml(record.title)}</td><td>${escapeHtml(record.project)}</td><td>${escapeHtml(
        record.category,
      )}</td><td>${escapeHtml(record.version)}</td><td>${archiveStatusChip(record.status)}</td><td>${renderSourceRef(
        record.sourceRef,
      )}</td></tr>`,
    )
    .join('\n')}</tbody></table>`,
  `Archive records for ${group.year}-${group.month}`,
)}</section>`,
    )
    .join('\n')}</div>`;

  const evolutionHtml = `<div id="archive-evolution">${[...evolutions.entries()]
    .map(
      ([project, chains]) => `<section><h2>Evolution — ${escapeHtml(project)}</h2>${chains
        .map(
          (chain) =>
            `<div class="panel" data-evolution-chain="${escapeHtml(chain.rootId)}"><p class="row">${chain.entries
              .map(
                (entry) =>
                  `<span data-evolution-entry="${escapeHtml(entry.id)}" class="row">${escapeHtml(entry.title)} ${archiveStatusChip(entry.status)}</span>`,
              )
              .join('<span class="faint" aria-hidden="true">&rarr;</span>')}</p></div>`,
        )
        .join('\n')}</section>`,
    )
    .join('\n')}</div>`;

  const searchRows: ArchiveSearchRow[] = records.map((record) => ({
    id: record.id,
    title: record.title.toLowerCase(),
    text: `${record.title} ${record.summary} ${record.project} ${record.category} ${record.tags.join(' ')}`.toLowerCase(),
    project: record.project,
    category: record.category,
    status: record.status,
    year: record.created.date.slice(0, 4),
  }));

  const searchNote =
    'Search is literal token matching over title, summary, project, category and tags — there is no semantic model behind it. Filters and search apply to the results list and to the Evolution chains at the same time, so the page never shows a record as filtered out in one place and present in another.';

  const body = `${ARCHIVE_BANNER}
${section('SEARCH', `<div class="panel">${filters}<p class="faint">${escapeHtml(searchNote)}</p></div>`)}
${section('RECORDS', `${results}${browse}`)}
${section('EVOLUTION', evolutionHtml)}
${archiveSearchScript(searchRows)}`;

  return shell({
    title: 'Archive',
    activeFile: 'archive.html',
    eyebrow: 'Company memory',
    lede: 'Every reconstructed record, searchable and filterable, with its lifecycle state and a link to the preserved original.',
    asOf: nowIso,
    body,
    provenanceNote,
    sourceMode,
  });
}

/* ------------------------------------------------------------------ */
/* Page 9 — Headquarters Floor (issue #200, spatial HQ mission)        */
/*                                                                     */
/* The living headquarters: the same canonical read models the other    */
/* eight pages render, projected into a room-and-desk plan the Founder  */
/* can walk. It adds no data source and no authority — every room links */
/* back to the read-only page that holds its full detail.               */
/* ------------------------------------------------------------------ */

export interface HeadquartersFloorInput {
  floor: FloorState;
  specialists: WorkerDescriptor[];
  nowIso: string;
  provenanceNote?: string;
  sourceMode?: SourceMode;
}

export function renderHeadquartersFloor({
  floor,
  specialists,
  nowIso,
  provenanceNote,
  sourceMode,
}: HeadquartersFloorInput): string {
  return shell({
    title: 'Headquarters Floor',
    activeFile: 'headquarters.html',
    eyebrow: 'The living headquarters',
    lede: 'The whole company as one floor: who is at work, what is blocked, what waits on you, and which uplinks are lit — drawn only from canonical state.',
    asOf: nowIso,
    body: spatialFloorBody({ floor, nowIso, specialists }),
    provenanceNote,
    sourceMode,
  });
}

/**
 * What this page says about where its own content came from.
 *
 * NOT the bundle's provenance. The signature below takes no bundle data, and
 * this is the reason: everything the shell would otherwise stamp — the source
 * chip, the provenance banner — describes the build's snapshot, and this page
 * contains none of it. A build from a `sample` bundle therefore printed a
 * SAMPLE chip and the bundle's caveat at the top of a page whose runtime, one
 * paragraph below, stamps the live document it just read as `provenance live`.
 * Two provenance claims about one page, one of them about data the page does
 * not hold (Codex round 18).
 *
 * So the page states its own truth instead, and no source chip is drawn: the
 * mode of the document is not knowable at build time, and the runtime prints
 * the real one as soon as HQ answers.
 */
const IMMERSIVE_PROVENANCE_NOTE =
  'This page carries no build-time data. Every number and every lit room is read from the ' +
  'authenticated HQ control API in your browser, and the line under the title states the canonical ' +
  'state document’s own time and provenance once HQ has answered. Until it does, the rooms say so ' +
  'rather than showing a zero.';

/**
 * The immersive HQ (issue #250, Phase 2 Stage 4).
 *
 * Deliberately takes NO data. Every other page on this site is a projection of
 * the build's bundle; this one is a projection of the authenticated control
 * API, read in the browser at run time. Handing it bundle data would have
 * reintroduced exactly the thing Stage 4 removes — a page whose numbers came
 * from a build rather than from HQ — so the signature makes that impossible
 * rather than merely discouraged.
 *
 * That was true of the room data and false of the provenance chrome, which was
 * being forwarded from the bundle until round 18. The parameters are gone now,
 * so it is true of both.
 *
 * `asOf` is still stamped, because the freshness chip in the shell is about
 * THIS RENDER, and the render is genuinely from that instant. The canonical
 * state stamp is a separate line the runtime fills in.
 */
export function renderImmersiveHq(nowIso: string): string {
  return shell({
    title: 'Immersive HQ',
    activeFile: 'immersive.html',
    eyebrow: 'The building',
    lede:
      'All seventeen HQ destinations as one place you move through. Every room is lit by canonical ' +
      'state read from the authenticated control API — nothing here is baked in at build time, and ' +
      'a dark room is a room HQ is holding nothing in.',
    asOf: nowIso,
    body: immersiveBody(),
    provenanceNote: IMMERSIVE_PROVENANCE_NOTE,
  });
}
