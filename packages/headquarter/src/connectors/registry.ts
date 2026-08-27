/**
 * Connector registry — the extension point for future sources.
 *
 * Lane G implements GitHub and Drive only. Gmail, Calendar, the JENIFY
 * website/products and media are DECLARED here so the shape of the seam is
 * fixed, but they are `planned`: asking for one raises a clear
 * `connector_not_implemented` refusal instead of returning a stub that
 * quietly produces nothing. A planned connector never reports data.
 *
 * Adding a connector later means: register a descriptor, write a normalizer
 * (`raw -> ObservedItem`) and a page fetcher. The sync engine, idempotency,
 * lifecycle, provenance, staleness and safety rules are already shared.
 */

import { ConnectorPolicyError, type ConnectorScope } from './types.js';
import { DRIVE_CONNECTOR_ID, DRIVE_SOURCE_SYSTEM } from './drive.js';
import { GITHUB_CONNECTOR_ID, GITHUB_SOURCE_SYSTEM } from './github.js';

export type ConnectorImplementationStatus = 'implemented' | 'planned';

export interface ConnectorDescriptor {
  id: string;
  title: string;
  sourceSystem: string;
  status: ConnectorImplementationStatus;
  /** Every connector in this lane is read-only. */
  scope: ConnectorScope;
  /** Source-native kinds the connector indexes (empty while planned). */
  nativeKinds: readonly string[];
  notes: string;
}

export const CONNECTOR_REGISTRY: readonly ConnectorDescriptor[] = [
  {
    id: GITHUB_CONNECTOR_ID,
    title: 'GitHub evidence',
    sourceSystem: GITHUB_SOURCE_SYSTEM,
    status: 'implemented',
    scope: 'read',
    nativeKinds: ['repository', 'issue', 'pull_request', 'commit'],
    notes: 'Indexes references with canonical constructed locators. No outbound mutations.',
  },
  {
    id: DRIVE_CONNECTOR_ID,
    title: 'Google Drive documents',
    sourceSystem: DRIVE_SOURCE_SYSTEM,
    status: 'implemented',
    scope: 'read',
    nativeKinds: ['drive_file', 'drive_folder'],
    notes: 'Reference-only. Authorization stays with the caller; no tokens in repo or logs.',
  },
  {
    id: 'gmail',
    title: 'Gmail threads',
    sourceSystem: 'mail.google.com',
    status: 'planned',
    scope: 'read',
    nativeKinds: [],
    notes: 'Extension point only. Not implemented in lane G; needs its own privacy review.',
  },
  {
    id: 'calendar',
    title: 'Google Calendar events',
    sourceSystem: 'calendar.google.com',
    status: 'planned',
    scope: 'read',
    nativeKinds: [],
    notes: 'Extension point only. Not implemented in lane G.',
  },
  {
    id: 'jenify-web',
    title: 'JENIFY websites',
    sourceSystem: 'jenify',
    status: 'planned',
    scope: 'read',
    nativeKinds: [],
    notes: 'Extension point only. Not implemented in lane G.',
  },
  {
    id: 'jenify-products',
    title: 'JENIFY product releases',
    sourceSystem: 'jenify',
    status: 'planned',
    scope: 'read',
    nativeKinds: [],
    notes: 'Extension point only. Not implemented in lane G.',
  },
  {
    id: 'media',
    title: 'Media library',
    sourceSystem: 'jenify',
    status: 'planned',
    scope: 'read',
    nativeKinds: [],
    notes: 'Extension point only. Not implemented in lane G.',
  },
];

export function getConnectorDescriptor(id: string): ConnectorDescriptor | undefined {
  return CONNECTOR_REGISTRY.find((descriptor) => descriptor.id === id);
}

export function implementedConnectors(): ConnectorDescriptor[] {
  return CONNECTOR_REGISTRY.filter((descriptor) => descriptor.status === 'implemented');
}

export function plannedConnectors(): ConnectorDescriptor[] {
  return CONNECTOR_REGISTRY.filter((descriptor) => descriptor.status === 'planned');
}

/**
 * Gate every connector use. An unknown or merely-planned connector is refused
 * loudly; it must never be able to return a silent empty result that reads
 * like "nothing to see here".
 */
export function assertConnectorImplemented(id: string): ConnectorDescriptor {
  const descriptor = getConnectorDescriptor(id);
  if (!descriptor) {
    throw new ConnectorPolicyError('connector_not_implemented', `Unknown connector "${id}"`);
  }
  if (descriptor.status !== 'implemented') {
    throw new ConnectorPolicyError(
      'connector_not_implemented',
      `Connector "${id}" is a planned extension point and is not implemented`,
    );
  }
  return descriptor;
}
