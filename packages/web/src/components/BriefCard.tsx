import React from 'react';
import { useAuth } from '../auth.js';

/**
 * Owner daily-brief card — the client face of GET /api/brief.
 *
 * The server composes "what happened today" and "what needs my attention"
 * (attention already sorted most-severe first, money omitted when the role may
 * not see it). This card renders that shape with severity colour and count
 * badges, reusing the platform badge/card classes so it is theme-aware for free
 * and ships no new CSS. It re-sorts attention defensively so the "most-severe
 * first" guarantee holds even if a caller hands it an unsorted list.
 */

export interface BriefItem {
  kind: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** optional count/value the card shows as a small badge */
  count?: number;
}

export interface OwnerBrief {
  date: string;
  happened: BriefItem[];
  attention: BriefItem[];
  financialIncluded: boolean;
}

const SEV_RANK: Record<BriefItem['severity'], number> = { error: 0, warning: 1, info: 2 };
const SEV_BADGE: Record<BriefItem['severity'], string> = {
  error: 'badge-red',
  warning: 'badge-amber',
  info: 'badge-blue',
};
const SEV_LABEL: Record<BriefItem['severity'], { key: string; fallback: string }> = {
  error: { key: 'brief.sev.error', fallback: 'Critical' },
  warning: { key: 'brief.sev.warning', fallback: 'Warning' },
  info: { key: 'brief.sev.info', fallback: 'Info' },
};

function BriefRow({ item, testid }: { item: BriefItem; testid: string }) {
  const { t } = useAuth();
  const sev = SEV_LABEL[item.severity];
  return (
    <li
      className="brief-row"
      data-testid={testid}
      data-severity={item.severity}
      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}
    >
      <span className={`badge ${SEV_BADGE[item.severity]}`}>{t(sev.key, sev.fallback)}</span>
      <span className="brief-msg" style={{ flex: 1, overflowWrap: 'anywhere' }}>
        {item.message}
      </span>
      {item.count != null ? (
        <span className="badge badge-gray brief-count">{item.count}</span>
      ) : null}
    </li>
  );
}

function BriefSection({
  heading,
  items,
  emptyText,
  testid,
}: {
  heading: string;
  items: BriefItem[];
  emptyText: string;
  testid: string;
}) {
  return (
    <div className="brief-section">
      <div className="card-label">{heading}</div>
      {items.length > 0 ? (
        <ul className="brief-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {items.map((it, i) => (
            <BriefRow key={`${testid}-${i}`} item={it} testid={testid} />
          ))}
        </ul>
      ) : (
        <p className="muted">{emptyText}</p>
      )}
    </div>
  );
}

export function BriefCard({ brief }: { brief: OwnerBrief }) {
  const { t } = useAuth();
  // defensive: guarantee most-severe-first even if the caller passed it unsorted
  const attention = [...brief.attention].sort(
    (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity],
  );
  return (
    <section className="card brief-card" aria-label={t('brief.title', 'Daily brief')}>
      <div className="card-value" style={{ fontSize: 16 }}>
        {t('brief.title', 'Daily brief')}
      </div>
      <div className="muted" style={{ marginBottom: 8 }}>
        {brief.date}
      </div>
      <BriefSection
        heading={t('brief.happened', 'What happened today')}
        items={brief.happened}
        emptyText={t('brief.happened_none', 'Nothing recorded yet today.')}
        testid="brief-happened-item"
      />
      <BriefSection
        heading={t('brief.attention', 'Needs your attention')}
        items={attention}
        emptyText={t('brief.attention_none', 'All clear.')}
        testid="brief-attention-item"
      />
      {!brief.financialIncluded ? (
        <div className="muted brief-foot" style={{ marginTop: 8 }}>
          {t('brief.no_financial', 'Financial figures are hidden for your role.')}
        </div>
      ) : null}
    </section>
  );
}

export default BriefCard;
