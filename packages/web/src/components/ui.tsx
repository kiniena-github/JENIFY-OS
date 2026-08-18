import React from 'react';
import { useAuth } from '../auth.js';

const STATUS_COLORS: Record<string, string> = {
  draft: 'gray',
  posted: 'green',
  reversed: 'red',
  cancelled: 'gray',
  available: 'green',
  reserved: 'amber',
  in_process: 'blue',
  in_progress: 'blue',
  empty: 'gray',
  completed: 'green',
  passed: 'green',
  failed: 'red',
  retest_required: 'amber',
  pending: 'gray',
  pending_qc: 'gray',
  passed_pending_release: 'amber',
  released: 'green',
  confirmed: 'blue',
  dispatched: 'navy',
  delivered: 'green',
  loading: 'amber',
  paid: 'green',
  partial: 'amber',
  overdue: 'red',
  active: 'blue',
  inactive: 'gray',
  placeholder: 'amber',
};

export function StatusBadge({ status }: { status: string }) {
  const { t } = useAuth();
  const color = STATUS_COLORS[status] ?? 'gray';
  return <span className={`badge badge-${color}`}>{t(`status.${status}`, prettify(status))}</span>;
}

function prettify(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'danger' | 'success';
}) {
  return (
    <div className={`card ${tone === 'danger' ? 'danger-card' : tone === 'success' ? 'success-card' : ''}`}>
      <div className="card-label">{label}</div>
      <div className="card-value">{value}</div>
      {sub != null ? <div className="card-sub">{sub}</div> : null}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <div className="page-error">{message}</div>;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        style={wide ? { maxWidth: 980 } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({
  label,
  required,
  children,
  hint,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="field">
      <label>
        {label} {required ? <span className="req">*</span> : null}
      </label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

/** Ask for a reason before performing a destructive/corrective action. */
export function ReasonDialog({
  title,
  actionLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  actionLabel: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = React.useState('');
  return (
    <Modal title={title} onClose={onClose}>
      <div className="field">
        <label>
          Reason <span className="req">*</span>
        </label>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </div>
      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-danger"
          disabled={!reason.trim()}
          onClick={() => onConfirm(reason.trim())}
        >
          {actionLabel}
        </button>
      </div>
    </Modal>
  );
}
