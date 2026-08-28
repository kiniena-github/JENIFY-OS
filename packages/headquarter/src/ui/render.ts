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

export const HQ_PAGES = [
  { file: 'index.html', title: 'Command Center', glyph: '◈' },
  { file: 'projects.html', title: 'Projects', glyph: '▤' },
  { file: 'executive-room.html', title: 'Executive Room', glyph: '◎' },
  { file: 'direct-chats.html', title: 'Direct Chats', glyph: '✉' },
  { file: 'specialists.html', title: 'Specialist Directory', glyph: '⚇' },
  { file: 'approvals.html', title: 'Founder Approvals', glyph: '⚖' },
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
}

function provenanceBanner(note: string): string {
  return `<div class="provenance-banner" role="note" data-provenance-banner>
<b>SOURCE NOTE</b><span>${escapeHtml(note)}</span>
</div>`;
}

function shell({ title, activeFile, eyebrow, lede, asOf, body, provenanceNote }: ShellOptions): string {
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
<title>JENIFY HQ — ${escapeHtml(title)}</title>
<style>${THEME_CSS}</style>
</head>
<body>
<a class="skip-link" href="#hq-main">Skip to ${escapeHtml(title)}</a>
<div class="shell">
<header class="rail">
<div class="brand"><span class="mark" aria-hidden="true">JQ</span><span class="wordmark"><b>JENIFY</b><span>Headquarter</span></span></div>
<nav aria-label="Headquarter sections"><ul>${nav}</ul></nav>
<p class="rail-foot">Read-only Founder view over the canonical activity log. No action on any page executes anything.</p>
</header>
<main id="hq-main">
<div class="page-head">
<p class="eyebrow">${escapeHtml(eyebrow)}</p>
<h1>${escapeHtml(title)}</h1>
<p class="lede">${escapeHtml(lede)}</p>
<p class="row" data-as-of>${chip(`As of ${asOf}`, 'neutral', true)}</p>
</div>
${provenanceNote ? provenanceBanner(provenanceNote) : ''}
${body}
${footer}
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
}

export function renderCommandCenter({
  dashboard,
  workers,
  specialists,
  feed,
  approvals,
  nowIso,
  provenanceNote,
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
  });
}

export function renderDirectChats(
  messages: ChatMessage[],
  specialists: WorkerDescriptor[],
  states: TaskState[],
  nowIso: string,
  provenanceNote?: string,
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
  });
}

/* ------------------------------------------------------------------ */
/* Page 5 — Specialist Directory                                       */
/* ------------------------------------------------------------------ */

export function renderSpecialistDirectory(
  profiles: SpecialistProfile[],
  nowIso: string,
  provenanceNote?: string,
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
): string {
  const note =
    'Read-only approval queue. Approve / Reject / Ask for changes are shown as disabled placeholders: this page never executes an action. Decisions happen in the Founder-gated operator control plane, which enforces the action digest, expiry and single-use nonce.';

  const pending = approvals.filter((approval) => approval.decision === 'pending');
  const decided = approvals.filter((approval) => approval.decision !== 'pending');

  const decisionControls = `<div class="decision-controls" role="group" aria-label="Decision controls — not available on this page">
<span class="control-readonly" aria-disabled="true">Approve</span>
<span class="control-readonly" aria-disabled="true">Reject</span>
<span class="control-readonly" aria-disabled="true">Ask for changes</span>
<span class="faint">not wired — read-only page</span>
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
  });
}

/* ------------------------------------------------------------------ */
/* Page 7 — Archive / Knowledge (+ page 8 search experience)           */
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
  });
}
