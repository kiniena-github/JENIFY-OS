/**
 * Connector registry and extension points (issue #140 / #123, HQ lane G).
 *
 * The registry is where "which sources does Headquarter know about" is
 * answered honestly. GitHub and Drive are implemented; Gmail, Calendar, the
 * JENIFY website/products and media are *declared* as planned, so a caller
 * asking for them gets `not_implemented` rather than an empty result set that
 * looks like "nothing there". Declaring them here is the extension point: a
 * later lane registers an adapter against an existing kind and inherits the
 * provenance, sync and safety rules unchanged — no parallel pipeline.
 *
 * The registry also enforces least privilege at registration time: this lane
 * performs no outbound mutations, so a connector declaring a write, delete,
 * send or admin scope is rejected outright rather than trusted not to use it.
 */

import { assertNoSecretMaterial } from './safety.js';
import type { AccessDescriptor, Connector, ConnectorKind } from './types.js';
import { IMPLEMENTED_CONNECTOR_KINDS, PLANNED_CONNECTOR_KINDS, isConnectorKind } from './types.js';

/** Scope fragments that imply the ability to change or send something. */
const MUTATING_SCOPE_FRAGMENTS = [
  'write',
  'append',
  'modify',
  'delete',
  'admin',
  'send',
  'manage',
  'full_control',
  'compose',
];

/**
 * Reject anything that is not strictly read-only. Read-first is a structural
 * guarantee in this lane, not a promise: a connector cannot be registered at
 * all if its declared access could mutate the source.
 */
export function assertReadOnlyAccess(access: AccessDescriptor, context: string): void {
  assertNoSecretMaterial(access, `${context} access descriptor`);
  if (access.mode !== 'read_only') {
    throw new Error(`${context}: access mode "${access.mode}" is not permitted; connectors are read-only`);
  }
  if (!Array.isArray(access.scopes) || access.scopes.length === 0) {
    throw new Error(`${context}: at least one declared scope is required`);
  }
  for (const scope of access.scopes) {
    if (typeof scope !== 'string' || scope.trim().length === 0) {
      throw new Error(`${context}: scopes must be non-empty strings`);
    }
    const lowered = scope.toLowerCase();
    const offending = MUTATING_SCOPE_FRAGMENTS.find((fragment) => lowered.includes(fragment));
    if (offending) {
      throw new Error(`${context}: scope "${scope}" implies mutation ("${offending}"); read-only scopes only`);
    }
  }
}

export type RegistrationStatus = 'implemented' | 'planned';

export interface ConnectorRegistration {
  kind: ConnectorKind;
  /** Instance name for implemented connectors; the kind label for planned ones. */
  name: string;
  status: RegistrationStatus;
  /** Present only for implemented connectors. */
  connector?: Connector;
  /** Why a planned kind is not available yet. */
  note?: string;
}

export class UnimplementedConnectorError extends Error {
  readonly code = 'not_implemented';
  constructor(public readonly kind: ConnectorKind) {
    super(`Connector kind "${kind}" is declared as a planned extension point but has no adapter yet.`);
    this.name = 'UnimplementedConnectorError';
  }
}

/**
 * In-memory registry of connector instances. Deliberately not persisted and
 * deliberately not a state machine: connector instances are cheap, pure
 * wrappers over already-fetched data, and Headquarter's durable state lives in
 * the existing store, not here.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  /** Register an implemented connector. Rejects non-read-only access. */
  register(connector: Connector): this {
    if (!isConnectorKind(connector.kind)) {
      throw new Error(`ConnectorRegistry.register: unknown connector kind "${String(connector.kind)}"`);
    }
    if (!(IMPLEMENTED_CONNECTOR_KINDS as readonly ConnectorKind[]).includes(connector.kind)) {
      throw new UnimplementedConnectorError(connector.kind);
    }
    assertReadOnlyAccess(connector.access, `ConnectorRegistry.register(${connector.name})`);
    if (this.connectors.has(connector.name)) {
      throw new Error(`ConnectorRegistry.register: "${connector.name}" is already registered`);
    }
    this.connectors.set(connector.name, connector);
    return this;
  }

  get(name: string): Connector | undefined {
    return this.connectors.get(name);
  }

  /** Registered connectors of a kind, in registration-independent order. */
  byKind(kind: ConnectorKind): Connector[] {
    return [...this.connectors.values()]
      .filter((connector) => connector.kind === kind)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /**
   * Everything Headquarter knows about: registered connectors plus the
   * declared-but-unbuilt kinds, so a caller can never mistake "not built yet"
   * for "nothing found".
   */
  list(): ConnectorRegistration[] {
    const implemented: ConnectorRegistration[] = [...this.connectors.values()]
      .map((connector) => ({ kind: connector.kind, name: connector.name, status: 'implemented' as const, connector }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const planned: ConnectorRegistration[] = PLANNED_CONNECTOR_KINDS.map((kind) => ({
      kind,
      name: kind,
      status: 'planned' as const,
      note: 'Declared extension point; no adapter in this lane.',
    }));
    return [...implemented, ...planned];
  }
}
