import React from 'react';
import { useAuth } from '../auth.js';

/**
 * Offline / sync UX primitives (Mobile+Offline mission §4).
 *
 * Honesty contract: the UI must always tell the user whether data is local,
 * pending, synced, conflicted, or failed — and must NEVER pretend data is
 * synchronized when it is not. Today (Phase O1) there is no queued-write
 * engine yet, so the only live signal is connectivity: offline means reads
 * show the last loaded data and writes will fail until connection returns.
 * The SyncStatusBadge states are the platform vocabulary future offline
 * writes must use.
 */

export function useNetworkStatus(): boolean {
  const [online, setOnline] = React.useState<boolean>(() => navigator.onLine);
  React.useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

export type SyncState = 'local' | 'pending' | 'synced' | 'conflict' | 'failed';

const SYNC_LABELS: Record<SyncState, { key: string; fallback: string; cls: string }> = {
  local: { key: 'sync.local', fallback: 'Saved locally', cls: 'badge-gray' },
  pending: { key: 'sync.pending', fallback: 'Waiting to sync', cls: 'badge-amber' },
  synced: { key: 'sync.synced', fallback: 'Synced', cls: 'badge-green' },
  conflict: { key: 'sync.conflict', fallback: 'Conflict — review required', cls: 'badge-red' },
  failed: { key: 'sync.failed', fallback: 'Failed — retry', cls: 'badge-red' },
};

export function SyncStatusBadge({ state }: { state: SyncState }) {
  const { t } = useAuth();
  const s = SYNC_LABELS[state];
  return <span className={`badge ${s.cls} sync-badge`}>{t(s.key, s.fallback)}</span>;
}

/** Fixed banner shown whenever the device loses connectivity. */
export function OfflineBanner() {
  const { t } = useAuth();
  const online = useNetworkStatus();
  if (online) return null;
  return (
    <div className="offline-banner" role="status">
      <span className="offline-dot" aria-hidden />
      <b>{t('offline.title', 'You are offline.')}</b>{' '}
      {t(
        'offline.body',
        'Showing last loaded data — changes cannot be saved until the connection returns.',
      )}
    </div>
  );
}
