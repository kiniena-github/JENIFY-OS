/**
 * Static-site assembly: turns one canonical data bundle into the full set
 * of Headquarter pages. Kept pure (filename → HTML) so tests can assert on
 * the whole site without touching the filesystem.
 *
 * All inputs use the canonical contracts (§6b): ActivityEvent,
 * ApprovalRequest, ChatMessage, WorkerDescriptor. The UI derives everything
 * it shows from these — it holds no state of its own and duplicates no
 * authority state from the operator control plane.
 */

import type { ActivityEvent } from '../contracts/events.js';
import type { ApprovalRequest, ChatMessage } from '../contracts/modules.js';
import type { WorkerDescriptor } from '../contracts/workers.js';
import type { ArchiveRecord } from '../archive/schema.js';
import { monthlyView, projectEvolutionView, listProjects } from '../archive/views.js';
import { latestTaskStates } from './model.js';
import {
  founderDashboard,
  workerStatuses,
  projectBoard,
  projectTimeline,
  activityFeed,
  specialistProfiles,
} from './views.js';
import {
  renderCommandCenter,
  renderProjects,
  renderExecutiveRoom,
  renderDirectChats,
  renderSpecialistDirectory,
  renderFounderApprovals,
  renderArchive,
} from './render.js';

export const EXECUTIVE_ROOM_THREAD_ID = 'executive-room';
export const DIRECT_CHAT_THREAD_PREFIX = 'dm:';

/** How many recent events the Command Center activity feed shows. */
export const ACTIVITY_FEED_LIMIT = 12;

export interface HeadquarterData {
  /** Optional provenance note for the bundle (e.g. "reconstructed sample"). */
  note?: string;
  /** UTC date (YYYY-MM-DD) the dashboard treats as "today". */
  todayUtcDate: string;
  /**
   * Instant the bundle is current as of, shown on every page and used for
   * relative ages. Omitted → derived from the newest timestamp actually in
   * the bundle, so the site never claims to be fresher than its data and
   * never depends on wall-clock time (renders stay reproducible).
   */
  generatedAt?: string;
  events: ActivityEvent[];
  approvals: ApprovalRequest[];
  archive: ArchiveRecord[];
  chatMessages: ChatMessage[];
  specialists: WorkerDescriptor[];
}

/** Newest timestamp anywhere in the bundle, or midnight on `todayUtcDate`. */
export function bundleAsOf(data: HeadquarterData): string {
  if (data.generatedAt) return data.generatedAt;
  const stamps = [
    ...data.events.map((event) => event.at),
    ...data.chatMessages.map((message) => message.at),
    ...data.approvals.map((approval) => approval.decidedAt ?? approval.requestedAt),
  ].filter((stamp): stamp is string => typeof stamp === 'string' && stamp.length > 0);
  if (stamps.length === 0) return `${data.todayUtcDate}T00:00:00Z`;
  return stamps.reduce((a, b) => (a > b ? a : b));
}

export function buildSite(data: HeadquarterData): Map<string, string> {
  const states = latestTaskStates(data.events);
  const dashboard = founderDashboard(states, data.todayUtcDate);
  const workers = workerStatuses(states);
  const cards = projectBoard(states);
  const nowIso = bundleAsOf(data);
  const timelines = new Map(
    cards.map((card) => [card.project, projectTimeline(data.events, card.project)]),
  );
  const monthly = monthlyView(data.archive);
  const evolutions = new Map(
    listProjects(data.archive).map((project) => [project, projectEvolutionView(data.archive, project)]),
  );
  const executiveRoom = data.chatMessages.filter(
    (message) => message.threadId === EXECUTIVE_ROOM_THREAD_ID,
  );
  const directChats = data.chatMessages.filter((message) =>
    message.threadId.startsWith(DIRECT_CHAT_THREAD_PREFIX),
  );

  const site = new Map<string, string>();
  site.set(
    'index.html',
    renderCommandCenter({
      dashboard,
      workers,
      specialists: data.specialists,
      feed: activityFeed(data.events, ACTIVITY_FEED_LIMIT),
      approvals: data.approvals,
      nowIso,
      provenanceNote: data.note,
    }),
  );
  site.set('projects.html', renderProjects(cards, timelines, nowIso, data.note));
  site.set(
    'executive-room.html',
    renderExecutiveRoom(executiveRoom, data.specialists, data.approvals, nowIso, data.note),
  );
  site.set(
    'direct-chats.html',
    renderDirectChats(directChats, data.specialists, states, nowIso, data.note),
  );
  site.set(
    'specialists.html',
    renderSpecialistDirectory(specialistProfiles(data.specialists, workers), nowIso, data.note),
  );
  site.set(
    'approvals.html',
    renderFounderApprovals(dashboard.waitingForFounder, data.approvals, nowIso, data.note),
  );
  site.set('archive.html', renderArchive(data.archive, monthly, evolutions, nowIso, data.note));
  return site;
}
