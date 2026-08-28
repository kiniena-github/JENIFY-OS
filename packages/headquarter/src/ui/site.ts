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
  renderConnections,
  renderArchive,
  renderHeadquartersFloor,
  type DirectOrderRouteAvailability,
} from './render.js';
import { floorState } from './spatial/state.js';
import { assessConnections, type ConnectionStatus } from '../live/connections.js';
import { assertBrowserSafe } from '../live/redaction.js';
import { DIRECT_ORDER_ROUTES, resolveOrderRoute } from '../live/orders.js';
import type { SourceMode } from '../live/provenance.js';
import type { SecretsEnv } from '../routing/providers.js';

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
  /**
   * What the bundle actually is (issue #200, scope A). Rendered as a chip on
   * every page. Omitted → no claim is made, which is what an older bundle
   * that predates provenance modes honestly is.
   */
  sourceMode?: SourceMode;
  /**
   * Non-secret environment facts used to derive Connection Center state and
   * Direct Order route availability. Only PRESENCE is ever read; values never
   * reach a rendered page. Omitted → nothing is observed, so every connection
   * renders as not connected, which is the correct deny-by-default answer for
   * a build that observed nothing.
   */
  env?: SecretsEnv;
  /**
   * Pre-computed connection statuses. Supply to render a snapshot taken
   * elsewhere; omit and they are derived from `env` at build time.
   */
  connections?: ConnectionStatus[];
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

  // Connection state and route availability are derived from observed facts
  // at build time, never from the bundle's own provenance mode: a SAMPLE
  // bundle rendered on a machine with a real Claude credential still reports
  // that credential truthfully, and a LIVE bundle on a bare machine still
  // reports nothing connected.
  const env = data.env ?? {};
  const connections = data.connections ?? assessConnections(env, { now: nowIso });
  // Guard the connections that are about to be RENDERED, not a recomputation
  // of them. `build-site.ts` derives the snapshot's connections from `env`
  // independently of this bundle, so when a caller supplies `data.connections`
  // the snapshot guard inspects a different object entirely — and the HTML is
  // written first. A credential that reached a verifier's `reason`,
  // `evidenceSource` or fact list would therefore land in `connections.html`
  // with nothing in the path having looked at it. Checked on both branches, so
  // the invariant does not depend on which one a caller took: a computed
  // bundle carries only fact NAMES and passes, and this throws rather than
  // renders if that ever stops being true.
  assertBrowserSafe(connections, 'site.connections');
  const orderRoutes: DirectOrderRouteAvailability[] = DIRECT_ORDER_ROUTES.map((route) => ({
    route,
    resolution: resolveOrderRoute(route, env),
  }));

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
      sourceMode: data.sourceMode,
      orderRoutes,
    }),
  );
  // The living headquarters. It is a projection of the read models already
  // computed above — no extra data source, no second vocabulary — so a room
  // can never show a state the rest of the site would contradict.
  site.set(
    'headquarters.html',
    renderHeadquartersFloor({
      floor: floorState({
        states,
        dashboard,
        workers,
        specialists: data.specialists,
        projects: cards,
        approvals: data.approvals,
        connections,
        archive: data.archive,
        chatMessages: data.chatMessages,
      }),
      specialists: data.specialists,
      nowIso,
      provenanceNote: data.note,
      sourceMode: data.sourceMode,
    }),
  );
  site.set('projects.html', renderProjects(cards, timelines, nowIso, data.note, data.sourceMode));
  site.set(
    'executive-room.html',
    renderExecutiveRoom(executiveRoom, data.specialists, data.approvals, nowIso, data.note, data.sourceMode),
  );
  site.set(
    'direct-chats.html',
    renderDirectChats(directChats, data.specialists, states, nowIso, data.note, data.sourceMode),
  );
  site.set(
    'specialists.html',
    renderSpecialistDirectory(specialistProfiles(data.specialists, workers), nowIso, data.note, data.sourceMode),
  );
  site.set(
    'approvals.html',
    renderFounderApprovals(dashboard.waitingForFounder, data.approvals, nowIso, data.note, data.sourceMode),
  );
  site.set('connections.html', renderConnections(connections, nowIso, data.note, data.sourceMode));
  site.set(
    'archive.html',
    renderArchive(data.archive, monthly, evolutions, nowIso, data.note, data.sourceMode),
  );
  return site;
}
