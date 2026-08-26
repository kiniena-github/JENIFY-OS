/**
 * Headquarter presentation layer (issue #43, order 1; adapted to the
 * canonical contracts per issue #53 correction D / architecture doc §6b).
 *
 * Framework-free HTML renderers for the HQ information architecture
 * (war room #41, order C): Command Center, Projects, Executive Room,
 * Direct Chats, Specialist Directory, Founder Approvals, Archive.
 *
 * Pure string renderers: testable without a DOM, servable as static files,
 * embeddable later behind the operator control layer. No external requests,
 * no secrets, read-only over canonical data. Founder Approvals renders the
 * D15 approval fields read-only and offers NO approve/reject actions —
 * decisions stay in the operator control plane.
 */

import type { ActivityEvent } from '../contracts/events.js';
import type { ApprovalRequest, ChatMessage } from '../contracts/modules.js';
import type { WorkerDescriptor } from '../contracts/workers.js';
import type { ArchiveRecord } from '../archive/schema.js';
import type { MonthlyGroup, EvolutionChain } from '../archive/views.js';
import type { TaskState } from './model.js';
import type { FounderDashboard, WorkerStatus, ProjectCard } from './views.js';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export const HQ_PAGES = [
  { file: 'index.html', title: 'Command Center' },
  { file: 'projects.html', title: 'Projects' },
  { file: 'executive-room.html', title: 'Executive Room' },
  { file: 'direct-chats.html', title: 'Direct Chats' },
  { file: 'specialists.html', title: 'Specialist Directory' },
  { file: 'approvals.html', title: 'Founder Approvals' },
  { file: 'archive.html', title: 'Archive' },
] as const;

const STYLE = `
:root { color-scheme: light dark; --accent: #1a7f64; --line: #8884; }
body { font-family: system-ui, sans-serif; margin: 0; }
header { padding: 0.8rem 1.2rem; border-bottom: 2px solid var(--accent); display: flex; gap: 1rem; align-items: baseline; flex-wrap: wrap; }
header h1 { font-size: 1.05rem; margin: 0; }
nav a { margin-right: 0.75rem; text-decoration: none; color: var(--accent); }
nav a[aria-current="page"] { font-weight: 700; text-decoration: underline; }
main { padding: 1rem 1.2rem; max-width: 70rem; }
section { margin-bottom: 1.5rem; }
h2 { font-size: 0.95rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--line); padding-bottom: 0.25rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
.badge { display: inline-block; padding: 0.05rem 0.45rem; border: 1px solid var(--line); border-radius: 0.6rem; font-size: 0.75rem; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 0.8rem; }
.card { border: 1px solid var(--line); border-radius: 0.5rem; padding: 0.7rem 0.9rem; }
.card h3 { margin: 0 0 0.4rem; font-size: 1rem; }
.muted { opacity: 0.7; font-size: 0.85rem; }
.empty { opacity: 0.6; font-style: italic; }
.msg { border-left: 3px solid var(--accent); padding: 0.2rem 0.6rem; margin: 0.4rem 0; }
code { font-size: 0.8rem; word-break: break-all; }
`;

function shell(title: string, activeFile: string, body: string, provenanceNote?: string): string {
  const nav = HQ_PAGES.map(
    (page) =>
      `<a href="${page.file}"${page.file === activeFile ? ' aria-current="page"' : ''}>${escapeHtml(page.title)}</a>`,
  ).join('');
  const footer = provenanceNote
    ? `<footer class="muted" data-provenance>Data provenance: ${escapeHtml(provenanceNote)}</footer>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JENIFY HQ — ${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>JENIFY Headquarter</h1><nav>${nav}</nav></header>
<main><h1>${escapeHtml(title)}</h1>
${body}
${footer}
</main>
</body>
</html>`;
}

function taskRows(states: TaskState[]): string {
  if (states.length === 0) return '<p class="empty">Nothing here.</p>';
  const rows = states
    .map(
      (state) => `<tr>
<td>${escapeHtml(state.taskId)}</td>
<td>${escapeHtml(state.title)}</td>
<td>${escapeHtml(state.project)}</td>
<td>${escapeHtml(state.worker)}</td>
<td><span class="badge">${escapeHtml(state.status)}</span></td>
<td>${escapeHtml(state.updatedAt)}</td>
</tr>`,
    )
    .join('\n');
  return `<table><thead><tr><th>Task</th><th>Title</th><th>Project</th><th>Worker</th><th>Status</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ------------------------------------------------------------------ */
/* Pages                                                               */
/* ------------------------------------------------------------------ */

export function renderCommandCenter(dashboard: FounderDashboard, workers: WorkerStatus[], provenanceNote?: string): string {
  const sections = [
    ['NOW', dashboard.now],
    ['DONE TODAY', dashboard.doneToday],
    ['BLOCKED', dashboard.blocked],
    ['WAITING FOR FOUNDER', dashboard.waitingForFounder],
    ['NEXT', dashboard.next],
  ] as const;
  const body =
    sections.map(([title, states]) => `<section><h2>${title}</h2>${taskRows(states)}</section>`).join('\n') +
    `<section><h2>Worker Status</h2><div class="cards">${workers
      .map(
        (worker) => `<div class="card"><h3>${escapeHtml(worker.worker)}</h3>
<p>${
          worker.activeTask
            ? `Working on <strong>${escapeHtml(worker.activeTask.title)}</strong>`
            : '<span class="muted">Idle</span>'
        }</p>
<p class="muted">active ${worker.activeCount} · blocked ${worker.blockedCount} · completed ${worker.completedCount}</p>
<p class="muted">last seen ${escapeHtml(worker.lastSeen)}</p></div>`,
      )
      .join('\n')}</div></section>`;
  return shell('Command Center', 'index.html', body, provenanceNote);
}

export function renderProjects(
  cards: ProjectCard[],
  timelines: Map<string, ActivityEvent[]>,
  provenanceNote?: string,
): string {
  const cardHtml = `<div class="cards">${cards
    .map(
      (card) => `<div class="card"><h3>${escapeHtml(card.project)}</h3>
<p>open ${card.openCount} · blocked ${card.blockedCount} · waiting on Founder ${card.waitingForFounderCount} · done ${card.completedCount}</p>
<p class="muted">last activity ${escapeHtml(card.lastActivity)}</p></div>`,
    )
    .join('\n')}</div>`;
  const timelineHtml = [...timelines.entries()]
    .map(
      ([project, events]) => `<section><h2>Timeline — ${escapeHtml(project)}</h2>
<table><thead><tr><th>When</th><th>Status</th><th>Event</th><th>Actor</th></tr></thead><tbody>${events
        .map(
          (event) =>
            `<tr><td>${escapeHtml(event.at)}</td><td><span class="badge">${escapeHtml(event.status ?? 'note')}</span></td><td>${escapeHtml(event.summary)}</td><td>${escapeHtml(event.actor)}</td></tr>`,
        )
        .join('\n')}</tbody></table></section>`,
    )
    .join('\n');
  return shell('Projects', 'projects.html', `<section><h2>Project Cards</h2>${cardHtml}</section>${timelineHtml}`, provenanceNote);
}

/** Group canonical chat messages into displayable threads by threadId. */
function renderThreads(messages: ChatMessage[]): string {
  if (messages.length === 0) return '<p class="empty">No transcripts available yet.</p>';
  const byThread = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const list = byThread.get(message.threadId) ?? [];
    list.push(message);
    byThread.set(message.threadId, list);
  }
  return [...byThread.entries()]
    .map(([threadId, threadMessages]) => {
      const ordered = [...threadMessages].sort((a, b) => a.at.localeCompare(b.at));
      const participants = [...new Set(ordered.map((message) => message.author))];
      return `<section><h2>${escapeHtml(threadId)} <span class="muted">(${participants
        .map(escapeHtml)
        .join(', ')})</span></h2>
${ordered
  .map(
    (message) =>
      `<div class="msg"><strong>${escapeHtml(message.author)}</strong> <span class="muted">${escapeHtml(message.at)}</span><br>${escapeHtml(message.body)}</div>`,
  )
  .join('\n')}</section>`;
    })
    .join('\n');
}

export function renderExecutiveRoom(messages: ChatMessage[], provenanceNote?: string): string {
  const note =
    '<p class="muted">Presentation layer over recorded transcripts. Live messaging arrives with the operator control layer.</p>';
  return shell('Executive Room', 'executive-room.html', note + renderThreads(messages), provenanceNote);
}

export function renderDirectChats(messages: ChatMessage[], provenanceNote?: string): string {
  const note =
    '<p class="muted">Direct Founder ↔ worker transcripts. Live messaging arrives with the operator control layer.</p>';
  return shell('Direct Chats', 'direct-chats.html', note + renderThreads(messages), provenanceNote);
}

export function renderSpecialistDirectory(workers: WorkerDescriptor[], provenanceNote?: string): string {
  const body = `<div class="cards">${workers
    .map(
      (worker) => `<div class="card"><h3>${escapeHtml(worker.displayName)}</h3>
<p class="muted">${escapeHtml(worker.vendor)} · ${escapeHtml(worker.role)}</p>
<p><span class="badge">${worker.active ? 'active' : 'inactive'}</span></p></div>`,
    )
    .join('\n')}</div>`;
  return shell('Specialist Directory', 'specialists.html', body, provenanceNote);
}

/**
 * Read-only Founder Approvals page (§6b): renders the D15 approval fields
 * (actionDigest, expiresAt, consumedAt, decidedBy) and offers NO
 * approve/reject actions — decisions stay in the operator control plane.
 */
export function renderFounderApprovals(
  waiting: TaskState[],
  approvals: ApprovalRequest[],
  provenanceNote?: string,
): string {
  const note =
    '<p class="muted">Read-only approval queue. Approve/Reject decisions happen in the Founder-gated operator control plane — this page never executes actions itself.</p>';
  const approvalRows =
    approvals.length === 0
      ? '<p class="empty">No approval requests recorded.</p>'
      : `<table><thead><tr><th>Ask</th><th>Risk</th><th>Requested by</th><th>Decision</th><th>Decided by</th><th>Action digest</th><th>Expires</th><th>Consumed</th></tr></thead><tbody>${approvals
          .map(
            (approval) => `<tr>
<td>${escapeHtml(approval.ask)}${approval.taskId ? `<br><span class="muted">task ${escapeHtml(approval.taskId)}</span>` : ''}</td>
<td><span class="badge">${escapeHtml(approval.riskClass)}</span></td>
<td>${escapeHtml(approval.requestedBy)}<br><span class="muted">${escapeHtml(approval.requestedAt)}</span></td>
<td><span class="badge">${escapeHtml(approval.decision)}</span>${approval.decisionNote ? `<br><span class="muted">${escapeHtml(approval.decisionNote)}</span>` : ''}</td>
<td>${approval.decidedBy ? escapeHtml(approval.decidedBy) : '<span class="muted">—</span>'}</td>
<td>${approval.actionDigest ? `<code>${escapeHtml(approval.actionDigest.slice(0, 16))}…</code>` : '<span class="muted">—</span>'}</td>
<td>${approval.expiresAt ? escapeHtml(approval.expiresAt) : '<span class="muted">—</span>'}</td>
<td>${approval.consumedAt ? escapeHtml(approval.consumedAt) : '<span class="muted">—</span>'}</td>
</tr>`,
          )
          .join('\n')}</tbody></table>`;
  const body = `${note}
<section><h2>Approval Requests</h2>${approvalRows}</section>
<section><h2>Tasks Waiting For Founder</h2>${taskRows(waiting)}</section>`;
  return shell('Founder Approvals', 'approvals.html', body, provenanceNote);
}

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
  '<p class="muted" data-archive-banner>These rows are reconstructed canonical records, not original evidence: each links to its preserved original via the source column. Dates flagged &quot;inferred&quot; or &quot;estimated&quot; are not authoritative and must be verified against the original before being relied on.</p>';

export function renderArchive(
  records: ArchiveRecord[],
  monthly: MonthlyGroup[],
  evolutions: Map<string, EvolutionChain[]>,
  provenanceNote?: string,
): string {
  const monthlyHtml = monthly
    .map(
      (group) => `<section><h2>${group.year}-${group.month}</h2>
<table><thead><tr><th>Date</th><th>Title</th><th>Project</th><th>Category</th><th>Version</th><th>Status</th><th>Source</th></tr></thead><tbody>${group.records
        .map(
          (record) => `<tr data-archive-id="${escapeHtml(record.id)}"><td>${escapeHtml(record.created.date)}${
            record.created.confidence === 'exact' ? '' : ` <span class="badge">${record.created.confidence}</span>`
          }</td><td>${escapeHtml(record.title)}</td><td>${escapeHtml(record.project)}</td><td>${escapeHtml(record.category)}</td><td>${escapeHtml(record.version)}</td><td><span class="badge">${escapeHtml(record.status)}</span></td><td>${renderSourceRef(record.sourceRef)}</td></tr>`,
        )
        .join('\n')}</tbody></table></section>`,
    )
    .join('\n');
  const evolutionHtml = [...evolutions.entries()]
    .map(
      ([project, chains]) => `<section><h2>Evolution — ${escapeHtml(project)}</h2>${chains
        .map(
          (chain) =>
            `<p>${chain.entries
              .map((entry) => `${escapeHtml(entry.title)} <span class="badge">${escapeHtml(entry.status)}</span>`)
              .join(' &rarr; ')}</p>`,
        )
        .join('\n')}</section>`,
    )
    .join('\n');
  const searchData = JSON.stringify(
    records.map((record) => ({
      id: record.id,
      text: `${record.title} ${record.summary} ${record.project} ${record.category} ${record.tags.join(' ')}`.toLowerCase(),
    })),
  ).replaceAll('</', '<\\/');
  const searchUi = `<section><h2>Search</h2>
<input id="archive-search" type="search" placeholder="e.g. qos chatbot upgrade" style="width:100%;padding:0.4rem;font-size:1rem;">
<script id="archive-search-data" type="application/json">${searchData}</script>
<script>
(function () {
  var input = document.getElementById('archive-search');
  var data = JSON.parse(document.getElementById('archive-search-data').textContent);
  input.addEventListener('input', function () {
    var tokens = input.value.toLowerCase().split(/[^a-z0-9]+/).filter(function (t) { return t.length > 1; });
    var visible = {};
    data.forEach(function (row) {
      var match = tokens.every(function (t) { return row.text.indexOf(t) !== -1; });
      visible[row.id] = tokens.length === 0 || match;
    });
    document.querySelectorAll('[data-archive-id]').forEach(function (el) {
      el.style.display = visible[el.getAttribute('data-archive-id')] ? '' : 'none';
    });
  });
})();
</script></section>`;
  return shell('Archive', 'archive.html', ARCHIVE_BANNER + searchUi + monthlyHtml + evolutionHtml, provenanceNote);
}
