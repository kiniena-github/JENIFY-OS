/**
 * `GET /api/hq/control/state` — the Stage 4 hydration seam, end to end
 * (issue #250).
 *
 * This is the route that ends "the HQ pages carry build-time data". It reads
 * canonical state from a real `HeadquarterOperations`, projects it into the
 * seventeen rooms, and answers a Founder session — so the things that can go
 * wrong here are the things that matter most in this stage:
 *
 *   - it must be READ ONLY, and must not widen the write surface;
 *   - it must be gated exactly as strictly as the approvals read;
 *   - it must never publish a secret or an invented metric;
 *   - it must report zero as zero and populated as populated, and the two must
 *     be distinguishable by something other than trust;
 *   - and a real mutation through the EXISTING approval machinery must change
 *     what it answers on the very next read.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, CAPS, type Fixture } from './application.fixture.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability } from '../src/live/orders.js';
import type { AuthenticatedAccount, ControlRequest } from '../src/live/auth.js';
import { HQ_ROOMS } from '../src/client/rooms.js';
import type { RoomView } from '../src/client/contracts.js';

const ORIGIN = 'https://hq.example';
const FRESH = new Date().toISOString();

/**
 * The non-secret PRESENCE facts a CLAUDE-routed order needs to resolve.
 *
 * Values never leave the server — `assessConnections` and `resolveOrderRoute`
 * read presence only — and the publication tests below assert exactly that.
 */
const CLAUDE_ONLY = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };

const FOUNDER_ACCOUNT: AuthenticatedAccount = {
  realmId: 'tenant-1',
  accountId: 'user-founder',
  displayName: 'Founder',
  authenticatedAt: FRESH,
};
const STAFF_ACCOUNT: AuthenticatedAccount = {
  realmId: 'tenant-1',
  accountId: 'user-staff',
  displayName: 'Warehouse Lead',
  authenticatedAt: FRESH,
};

interface Harness {
  fixture: Fixture;
  deps: ControlApiDeps;
  call(request: Partial<ControlRequest>, account?: AuthenticatedAccount | null): ControlResponse;
}

function harness(options: { account?: AuthenticatedAccount | null } = {}): Harness {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  let account = options.account === undefined ? FOUNDER_ACCOUNT : options.account;
  const deps: ControlApiDeps = {
    ops: fixture.ops,
    sessions: { resolve: () => account },
    founderMap: [{ realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' }],
    allowedOrigins: [ORIGIN],
    secretsEnv: CLAUDE_ONLY,
    mutationsEnabled: true,
  };
  return {
    fixture,
    deps,
    call(request, override) {
      if (override !== undefined) account = override;
      return handleControlRequest(
        {
          method: 'GET',
          path: CONTROL_ROUTES.state,
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          ...request,
        },
        deps,
      );
    },
  };
}

function rooms(response: ControlResponse): RoomView[] {
  return (response.body as { rooms: RoomView[] }).rooms;
}

describe('the state route is gated exactly as strictly as the rest of the read surface', () => {
  it('answers a mapped Founder', () => {
    const response = harness().call({});
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(rooms(response)).toHaveLength(17);
  });

  it('answers 401 with no state when the browser holds no session', () => {
    const response = harness({ account: null }).call({});
    expect(response.status).toBe(401);
    expect(response.body).not.toHaveProperty('rooms');
    expect(JSON.stringify(response.body)).not.toContain('Mission Room');
  });

  it('answers 403 with no state to a signed-in account that is not the Founder', () => {
    const response = harness({ account: STAFF_ACCOUNT }).call({});
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('rooms');
  });

  it('refuses a broken Founder map rather than falling open', () => {
    const h = harness();
    h.deps.founderMap = 'not-a-map';
    const response = h.call({});
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('rooms');
  });

  it('is READ ONLY: no verb but GET reaches it', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = harness().call({ method });
      expect(response.status, method).toBe(404);
    }
  });

  it('serves reads even where browser writes are switched off', () => {
    // A read-only deployment must still be able to SHOW HQ. Refusing the read
    // alongside the writes would leave a correctly-configured safe deployment
    // with a blank building.
    const h = harness();
    h.deps.mutationsEnabled = false;
    const response = h.call({});
    expect(response.status).toBe(200);
    expect(rooms(response)).toHaveLength(17);
  });
});

describe('what the state route publishes', () => {
  it('projects every registered room, once, in the approved order', () => {
    const view = rooms(harness().call({}));
    expect(view.map((room) => room.roomId)).toEqual(HQ_ROOMS.map((room) => room.id));
    expect(view.map((room) => room.ordinal)).toEqual(HQ_ROOMS.map((room) => room.ordinal));
  });

  it('reports an empty HQ as zeroes rather than as absence', () => {
    const response = harness().call({});
    const body = response.body as { counts: Record<string, number> };
    expect(body.counts).toEqual({
      approvals: 0,
      pendingReviews: 0,
      outcomeUnknown: 0,
      blocked: 0,
      inFlight: 0,
      queued: 0,
    });
    const home = rooms(response).find((room) => room.roomId === 'home')!;
    expect(home.status).toBe('live');
    for (const metric of home.metrics) expect(metric.value).toBe(0);
  });

  it('carries no task payload, no instruction text and no secret', () => {
    const h = harness();
    // A real order, whose instruction text is Founder input that must stay
    // server-side. `assertBrowserSafe` runs over the response; this proves the
    // specific thing it is protecting.
    const created = handleControlRequest(
      {
        method: 'POST',
        path: CONTROL_ROUTES.orders,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: {
          instruction: 'SECRET-INSTRUCTION-TEXT-DO-NOT-PUBLISH',
          route: 'CLAUDE',
          idempotencyKey: 'k1',
          title: 'A visible title',
        },
      },
      h.deps,
    );
    // 201: the order route CREATES a canonical task.
    expect(created.status).toBe(201);
    const serialized = JSON.stringify(h.call({}).body);
    expect(serialized).not.toContain('SECRET-INSTRUCTION-TEXT-DO-NOT-PUBLISH');
    expect(serialized).not.toContain('payload');
    // The title IS presentation text and is meant to travel.
    expect(serialized).toContain('A visible title');
  });

  it('publishes no fabricated metric — no cost, token, ETA or progress field', () => {
    // The snapshot builder refuses these shapes on the way out. This asserts
    // the property on the route that a browser actually calls.
    const serialized = JSON.stringify(harness().call({}).body).toLowerCase();
    for (const forbidden of ['"cost', '"tokens', '"eta', '"progress', '"percentcomplete', '"sentiment']) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it('stamps provenance, so a reader can tell how old and how true it is', () => {
    const body = harness().call({}).body as { generatedAt: string; mode: string };
    expect(body.mode).toBe('live');
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
  });

  it('reports the canonical kill switch for the lock banner', () => {
    const body = harness().call({}).body as { killSwitch: { globalEngaged: boolean } };
    expect(body.killSwitch.globalEngaged).toBe(false);
  });
});

describe('a real mutation changes what the next read answers', () => {
  it('shows an order in the Approvals room after it is created, and not before', () => {
    const h = harness();

    const before = rooms(h.call({})).find((room) => room.roomId === 'approvals')!;
    expect(before.metrics.find((metric) => metric.label === 'Awaiting your decision')!.value).toBe(0);
    expect(before.rows).toHaveLength(0);
    expect(before.liveness).toBe('dark');

    const created = handleControlRequest(
      {
        method: 'POST',
        path: CONTROL_ROUTES.orders,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: { instruction: 'Check the CI status of the Stage 4 branch.', route: 'CLAUDE', idempotencyKey: 'k-1' },
      },
      h.deps,
    );
    expect(created.status).toBe(201);
    expect(created.body.ok).toBe(true);

    const after = rooms(h.call({})).find((room) => room.roomId === 'approvals')!;
    expect(after.metrics.find((metric) => metric.label === 'Awaiting your decision')!.value).toBe(1);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.id).toBe((created.body as { taskId: string }).taskId);
    // The room now needs a human, and says so through the one channel the 3D
    // shell reads.
    expect(after.liveness).toBe('attention');
  });

  it('never tells the Command Room it is empty while approvals are pending', () => {
    // Codex P2 on `7e87392`. With one approval pending and nothing else — the
    // ordinary state immediately after submitting an order — the Command Room
    // has no rows, because approvals are the Approvals room's subject. Its
    // empty message must not therefore claim HQ is holding nothing, directly
    // beneath its own metric reading 1 and a room lit amber.
    const h = harness();
    handleControlRequest(
      {
        method: 'POST',
        path: CONTROL_ROUTES.orders,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: { instruction: 'Awaiting a decision.', route: 'CLAUDE', idempotencyKey: 'k-cmd' },
      },
      h.deps,
    );
    const command = rooms(h.call({})).find((room) => room.roomId === 'command-room')!;
    expect(command.rows).toHaveLength(0);
    expect(command.metrics.find((metric) => metric.label === 'Awaiting decision')!.value).toBe(1);
    expect(command.liveness).toBe('attention');
    expect(command.emptyMessage).not.toContain('HQ is holding nothing');
    expect(command.emptyMessage).toContain('held at the Founder gate');
    expect(command.emptyMessage).toContain('1 task(s)');
  });

  it('still says HQ is holding nothing when it genuinely is', () => {
    const command = rooms(harness().call({})).find((room) => room.roomId === 'command-room')!;
    expect(command.emptyMessage).toContain('HQ is holding nothing');
    expect(command.liveness).toBe('dark');
  });

  it('refuses the mutation, and changes nothing, when the session holds no authority', () => {
    const h = harness({ account: STAFF_ACCOUNT });
    const refused = handleControlRequest(
      {
        method: 'POST',
        path: CONTROL_ROUTES.orders,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: { instruction: 'Do something.', route: 'CLAUDE', idempotencyKey: 'k-2' },
      },
      h.deps,
    );
    expect(refused.status).toBe(403);
    expect(h.fixture.ops.queue.listByStatus('needs_approval')).toHaveLength(0);

    // And the state route still answers that account nothing at all.
    expect(h.call({}).status).toBe(403);
  });

  it('reflects a denial on the very next read', () => {
    const h = harness();
    const created = handleControlRequest(
      {
        method: 'POST',
        path: CONTROL_ROUTES.orders,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: { instruction: 'Something to refuse.', route: 'CLAUDE', idempotencyKey: 'k-3' },
      },
      h.deps,
    );
    const taskId = (created.body as { taskId: string }).taskId;
    expect(rooms(h.call({})).find((room) => room.roomId === 'approvals')!.rows).toHaveLength(1);

    const denied = handleControlRequest(
      {
        method: 'POST',
        path: CONTROL_ROUTES.deny,
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: { taskId, reason: 'Not now.' },
      },
      h.deps,
    );
    expect(denied.status).toBe(200);

    const after = rooms(h.call({}));
    expect(after.find((room) => room.roomId === 'approvals')!.rows).toHaveLength(0);
    // Denial BLOCKS the task; it does not delete it. The Command Room must show
    // where it went, or the Founder would see work simply vanish.
    const command = after.find((room) => room.roomId === 'command-room')!;
    expect(command.rows.map((row) => row.id)).toContain(taskId);
    expect(command.liveness).toBe('attention');
  });
});

describe('a capability the registry holds shows up in the Resources room', () => {
  it('copies the registry rows and their canonical classification', () => {
    const view = rooms(harness().call({})).find((room) => room.roomId === 'resources')!;
    const ids = view.rows.map((row) => row.id);
    expect(ids).toContain(CAPS.readStatus);
    expect(ids).toContain(CAPS.dropIndex);
    const destructive = view.rows.find((row) => row.id === CAPS.dropIndex)!;
    expect(destructive.chips.map((chip) => chip.label)).toContain('destructive');
    expect(destructive.chips.map((chip) => chip.label)).toContain('Founder approval required');
  });
});
