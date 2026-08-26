/**
 * Static-site assembly: turns one canonical data bundle into the full set
 * of Headquarter pages. Kept pure (filename → HTML) so tests can assert on
 * the whole site without touching the filesystem.
 */

import type { ActivityEvent } from '../events.js';
import { latestTaskStates } from '../events.js';
import type { ArchiveRecord } from '../archive/schema.js';
import { monthlyView, projectEvolutionView, listProjects } from '../archive/views.js';
import { founderDashboard, workerStatuses, projectCards, projectTimeline } from './views.js';
import type { ChatThread, Specialist } from './chat.js';
import {
  renderCommandCenter,
  renderProjects,
  renderExecutiveRoom,
  renderDirectChats,
  renderSpecialistDirectory,
  renderFounderApprovals,
  renderArchive,
} from './render.js';

export interface HeadquarterData {
  /** Optional provenance note for the bundle (e.g. "reconstructed sample"). */
  note?: string;
  /** UTC date (YYYY-MM-DD) the dashboard treats as "today". */
  todayUtcDate: string;
  events: ActivityEvent[];
  archive: ArchiveRecord[];
  executiveRoom: ChatThread[];
  directChats: ChatThread[];
  specialists: Specialist[];
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

  const site = new Map<string, string>();
  site.set('index.html', renderCommandCenter(dashboard, workers));
  site.set('projects.html', renderProjects(cards, timelines));
  site.set('executive-room.html', renderExecutiveRoom(data.executiveRoom));
  site.set('direct-chats.html', renderDirectChats(data.directChats));
  site.set('specialists.html', renderSpecialistDirectory(data.specialists));
  site.set('approvals.html', renderFounderApprovals(dashboard.waitingForFounder));
  site.set('archive.html', renderArchive(data.archive, monthly, evolutions));
  return site;
}
