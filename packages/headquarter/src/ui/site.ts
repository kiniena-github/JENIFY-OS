/**
 * Static-site assembly: turns one canonical data bundle into the full set
 * of Headquarter pages. Kept pure (filename → HTML) so tests can assert on
 * the whole site without touching the filesystem.
 *
 * All inputs use the canonical contracts (§6b): ActivityEvent,
 * ApprovalRequest, ChatMessage, WorkerDescriptor.
 */

import type { ActivityEvent } from '../contracts/events.js';
import type { ApprovalRequest, ChatMessage } from '../contracts/modules.js';
import type { WorkerDescriptor } from '../contracts/workers.js';
import type { ArchiveRecord } from '../archive/schema.js';
import { monthlyView, projectEvolutionView, listProjects } from '../archive/views.js';
import { latestTaskStates } from './model.js';
import { founderDashboard, workerStatuses, projectCards, projectTimeline } from './views.js';
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

export interface HeadquarterData {
  /** Optional provenance note for the bundle (e.g. "reconstructed sample"). */
  note?: string;
  /** UTC date (YYYY-MM-DD) the dashboard treats as "today". */
  todayUtcDate: string;
  events: ActivityEvent[];
  approvals: ApprovalRequest[];
  archive: ArchiveRecord[];
  chatMessages: ChatMessage[];
  specialists: WorkerDescriptor[];
}

export function buildSite(data: HeadquarterData): Map<string, string> {
  const states = latestTaskStates(data.events);
  const dashboard = founderDashboard(states, data.todayUtcDate);
  const workers = workerStatuses(states);
  const cards = projectCards(states);
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
  site.set('index.html', renderCommandCenter(dashboard, workers, data.note));
  site.set('projects.html', renderProjects(cards, timelines, data.note));
  site.set('executive-room.html', renderExecutiveRoom(executiveRoom, data.note));
  site.set('direct-chats.html', renderDirectChats(directChats, data.note));
  site.set('specialists.html', renderSpecialistDirectory(data.specialists, data.note));
  site.set('approvals.html', renderFounderApprovals(dashboard.waitingForFounder, data.approvals, data.note));
  site.set('archive.html', renderArchive(data.archive, monthly, evolutions, data.note));
  return site;
}
