import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth.js';
import { api } from '../api.js';
import { usePageTitle } from '../components/Layout.js';
import { StatCard, StatusBadge, ErrorBox, Field, Modal, ReasonDialog } from '../components/ui.js';
import {
  useStages,
  useBatches,
  useBatchDetail,
  useBatchGenealogy,
  useSourceBatches,
  useStock,
  useItems,
  useUoms,
  useWarehouses,
} from '../lib/queries.js';
import * as fmt from '../lib/format.js';
import type { Batch, Stage } from '../lib/types.js';

export default function ProductionPage() {
  const { t } = useAuth();
  usePageTitle(t('nav.production', 'Production'), t('production.subtitle', 'Batches by stage'));
  const stages = useStages();
  const [stageId, setStageId] = useState('');
  const active = stages.data?.find((s) => s.id === stageId) ?? stages.data?.[0];

  if (!stages.data) return <div className="centered-page">Loading…</div>;
  if (stages.data.length === 0)
    return <div className="centered-page">{t('production.no_stages', 'No production stages configured.')}</div>;

  return (
    <div>
      <div className="flex" style={{ marginBottom: 14 }}>
        {stages.data.map((s) => (
          <button
            key={s.id}
            className={`btn btn-sm ${active?.id === s.id ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setStageId(s.id)}
          >
            {t(s.nameKey, s.code)}
          </button>
        ))}
      </div>
      {active ? <StagePanel key={active.id} stage={active} /> : null}
    </div>
  );
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['batches'] });
  void qc.invalidateQueries({ queryKey: ['stock'] });
  void qc.invalidateQueries({ queryKey: ['sources'] });
  void qc.invalidateQueries({ queryKey: ['batch'] });
}

/** Worker-facing QC state of a gated batch. */
function qcDisplay(b: Batch): string {
  if (b.qcStatus === 'passed' && b.qcApprovedAt) return 'released';
  if (b.qcStatus === 'pending') return 'pending_qc';
  return b.qcStatus; // failed | retest_required | passed_pending_release
}

function isReleased(b: Batch): boolean {
  return b.qcStatus === 'passed' && !!b.qcApprovedAt;
}

function StagePanel({ stage }: { stage: Stage }) {
  const { t, can } = useAuth();
  const qc = useQueryClient();
  const batches = useBatches();
  const items = useItems();
  const [error, setError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState<Batch | null>(null);
  const [completing, setCompleting] = useState<Batch | null>(null);
  const [inspecting, setInspecting] = useState<Batch | null>(null);
  const [correcting, setCorrecting] = useState<Batch | null>(null);

  const stageBatches = (batches.data ?? []).filter((b) => b.stageId === stage.id);
  const itemName = (id: string | null) => items.data?.find((i) => i.id === id)?.name ?? '—';

  const today = fmt.todayIso();
  const doneToday = stageBatches.filter((b) => b.status === 'completed' && b.date === today);
  const open = stageBatches.filter((b) => b.status === 'draft' || b.status === 'in_progress');
  const inputToday = doneToday.reduce((s, b) => s + b.inputQty, 0);
  const outputToday = doneToday.reduce((s, b) => s + (b.outputQty ?? 0), 0);
  const lossToday = doneToday.reduce((s, b) => s + (b.lossQty ?? 0), 0);

  async function act(url: string, body?: unknown) {
    setError(null);
    try {
      await api.post(url, body);
      invalidate(qc);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div>
      <div className="cards">
        <StatCard label={t('production.input_today', 'Input today')} value={fmt.qtySmart(inputToday)} sub={`${doneToday.length} ${t('production.batches', 'batches')}`} />
        <StatCard
          label={stage.outputForm === 'bulk' ? t('production.output_today', 'Output today') : t('production.packed_today', 'Packed today')}
          value={fmt.qtySmart(outputToday)}
          sub={
            inputToday > 0 && stage.outputPolicy === 'measured'
              ? `${((outputToday / inputToday) * 100).toFixed(1)}% ${t('production.efficiency', 'efficiency')}`
              : stage.outputPolicy === 'conserved'
                ? t('production.conserved', 'Conserved')
                : undefined
          }
        />
        {stage.outputPolicy === 'measured' && stage.outputForm === 'bulk' ? (
          <StatCard label={t('production.loss_today', 'Waste / loss')} value={fmt.qtySmart(lossToday)} tone={lossToday > 0 ? 'danger' : undefined} />
        ) : null}
        <StatCard label={t('production.open', 'Open batches')} value={open.length} sub={t('status.in_process', 'In Process')} />
      </div>

      <ErrorBox error={error} />

      {can('production', 'create') ? <NewBatchForm stage={stage} onError={setError} /> : null}

      <div className="panel">
        <div className="panel-head">
          <h2>
            {t('production.recent', 'Recent batches')} — {t(stage.nameKey, stage.code)}
          </h2>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>{t('inventory.batch', 'Batch')}</th>
                <th>{t('shell.date', 'Date')}</th>
                <th className="num">{t('production.input', 'Input')}</th>
                <th className="num">
                  {stage.outputForm === 'bulk' ? t('production.output', 'Output') : t('production.good_units', 'Good units')}
                </th>
                {stage.outputForm === 'bulk' ? <th className="num">{t('production.loss', 'Loss')}</th> : <th>{t('inventory.product', 'Product')}</th>}
                {stage.requiresQc ? <th>{t('production.qc', 'Quality')}</th> : null}
                <th>{t('shell.status', 'Status')}</th>
                <th>{t('shell.actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {stageBatches.map((b) => (
                <tr key={b.id}>
                  <td className="mono">
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        setInspecting(b);
                      }}
                    >
                      {b.docNumber}
                    </a>
                  </td>
                  <td>{fmt.date(b.date)}</td>
                  <td className="num">{fmt.qty(b.inputQty)}</td>
                  <td className="num">
                    {stage.outputForm === 'bulk'
                      ? b.outputQty != null
                        ? fmt.qty(b.outputQty)
                        : '—'
                      : b.unitsProduced != null
                        ? fmt.qty((b.unitsProduced ?? 0) - (b.unitsRejected ?? 0))
                        : '—'}
                  </td>
                  {stage.outputForm === 'bulk' ? (
                    <td className="num">
                      {stage.outputPolicy === 'conserved' && (b.lossQty ?? 0) === 0
                        ? '—'
                        : b.lossQty != null
                          ? fmt.qty(b.lossQty)
                          : '—'}
                    </td>
                  ) : (
                    <td>{itemName(b.outputItemId)}</td>
                  )}
                  {stage.requiresQc ? (
                    <td>
                      <StatusBadge status={qcDisplay(b)} />
                    </td>
                  ) : null}
                  <td>
                    <StatusBadge status={b.status} />
                  </td>
                  <td>
                    {b.status === 'draft' && can('production', 'edit') ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => void act(`/api/batches/${b.id}/start`)}>
                        {t('production.start', 'Start')}
                      </button>
                    ) : null}{' '}
                    {(b.status === 'draft' || b.status === 'in_progress') && can('production', 'edit') ? (
                      <>
                        <button className="btn btn-primary btn-sm" onClick={() => setCompleting(b)}>
                          {t('production.complete', 'Complete')}
                        </button>{' '}
                        <button className="btn btn-secondary btn-sm" onClick={() => setCancelling(b)}>
                          {t('shell.cancel', 'Cancel')}
                        </button>
                      </>
                    ) : null}
                    {stage.requiresQc && b.status === 'completed' && !isReleased(b) ? (
                      <button className="btn btn-primary btn-sm" onClick={() => setInspecting(b)}>
                        {t('production.qc_action', 'Quality test')}
                      </button>
                    ) : null}{' '}
                    {stage.outputForm === 'bulk' && b.status === 'completed' && can('production', 'approve') ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => setCorrecting(b)}>
                        {t('production.correct_output', 'Record measured variance')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {stageBatches.length === 0 ? (
                <tr>
                  <td colSpan={9} className="table-empty">
                    {t('production.none', 'No batches yet for this stage.')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      {cancelling ? (
        <ReasonDialog
          title={`${t('shell.cancel', 'Cancel')} ${cancelling.docNumber}`}
          actionLabel={t('shell.cancel', 'Cancel')}
          onConfirm={(reason) => {
            void act(`/api/batches/${cancelling.id}/cancel`, { reason });
            setCancelling(null);
          }}
          onClose={() => setCancelling(null)}
        />
      ) : null}
      {completing ? (
        <CompleteModal stage={stage} batch={completing} onClose={() => setCompleting(null)} />
      ) : null}
      {inspecting ? (
        <BatchDetailModal stage={stage} batch={inspecting} onClose={() => setInspecting(null)} />
      ) : null}
      {correcting ? (
        <CorrectOutputModal batch={correcting} onClose={() => setCorrecting(null)} />
      ) : null}
    </div>
  );
}

/** Explicit measured variance for a completed bulk batch — audited with reason. */
function CorrectOutputModal({ batch, onClose }: { batch: Batch; onClose: () => void }) {
  const { t } = useAuth();
  const qc = useQueryClient();
  const [measured, setMeasured] = useState(String((batch.outputQty ?? batch.inputQty) / 1000));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const variance = Number(measured || 0) - (batch.outputQty ?? 0) / 1000;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/batches/${batch.id}/correct-output`, {
        measuredOutputKg: Number(measured),
        reason,
      });
      invalidate(qc);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${t('production.correct_output', 'Record measured variance')} — ${batch.docNumber}`} onClose={onClose}>
      <ErrorBox error={error} />
      <div className="page-info">
        {t('production.input', 'Input')}: {fmt.qty(batch.inputQty)} kg · {t('production.output', 'Output')}:{' '}
        {fmt.qty(batch.outputQty ?? 0)} kg
      </div>
      <div className="form-grid">
        <Field label={t('production.measured_output', 'Measured output (kg)')} required>
          <input type="number" min="0" step="any" value={measured} onChange={(e) => setMeasured(e.target.value)} />
        </Field>
        <Field label={t('audit.reason', 'Reason')} required hint={`${variance >= 0 ? '+' : ''}${variance.toFixed(2)} kg`}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          {t('shell.cancel', 'Cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy || !reason.trim() || !(Number(measured) > 0)} onClick={() => void save()}>
          {t('production.correct_output', 'Record measured variance')}
        </button>
      </div>
    </Modal>
  );
}

/** Attribute label with its unit — skipped when the translation already names it. */
function attrLabel(label: string, unit?: string | null): string {
  if (!unit || label.includes(`(${unit})`)) return label;
  return `${label} (${unit})`;
}

/** Output + attribute fields shared by the new-batch form and complete modal. */
function OutputFields({
  stage,
  state,
  setState,
}: {
  stage: Stage;
  state: Record<string, string>;
  setState: (k: string, v: string) => void;
}) {
  const { t } = useAuth();
  const items = useItems();
  const warehouses = useWarehouses();
  const outputItems = (stage.outputItemIds ?? [])
    .map((id) => items.data?.find((i) => i.id === id))
    .filter(Boolean);
  return (
    <>
      {(stage.attributes ?? []).map((a) => (
        <Field key={a.key} label={attrLabel(t(a.labelKey, a.key), a.unit)} required={a.required}>
          <input
            type={a.type === 'number' ? 'number' : 'text'}
            step="any"
            value={state[`attr_${a.key}`] ?? ''}
            onChange={(e) => setState(`attr_${a.key}`, e.target.value)}
          />
        </Field>
      ))}
      {stage.outputForm === 'bulk' && stage.outputPolicy === 'conserved' ? (
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <div className="page-info" style={{ margin: 0 }}>
            {t(
              'production.conserved_note',
              'This stage conserves quantity — output equals input. A measured variance can be recorded later as an audited correction.',
            )}
          </div>
        </div>
      ) : stage.outputForm === 'bulk' ? (
        <Field label={t('production.output_qty', 'Output quantity (kg)')} required>
          <input type="number" min="0" step="any" value={state.outputQty ?? ''} onChange={(e) => setState('outputQty', e.target.value)} />
        </Field>
      ) : (
        <>
          <Field label={t('production.product_size', 'Product')} required>
            <select value={state.outputItemId ?? ''} onChange={(e) => setState('outputItemId', e.target.value)}>
              <option value="">—</option>
              {outputItems.map((i) => (
                <option key={i!.id} value={i!.id}>
                  {i!.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('production.units_produced', 'Units produced')} required>
            <input type="number" min="0" step="1" value={state.unitsProduced ?? ''} onChange={(e) => setState('unitsProduced', e.target.value)} />
          </Field>
          <Field label={t('production.units_rejected', 'Damaged / rejected')}>
            <input type="number" min="0" step="1" value={state.unitsRejected ?? ''} onChange={(e) => setState('unitsRejected', e.target.value)} />
          </Field>
          <Field label={t('production.output_warehouse', 'Destination warehouse')} required>
            <select value={state.outputWarehouseId ?? ''} onChange={(e) => setState('outputWarehouseId', e.target.value)}>
              <option value="">—</option>
              {warehouses.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
    </>
  );
}

function collectOutput(stage: Stage, state: Record<string, string>) {
  const attributes: Record<string, unknown> = {};
  for (const a of stage.attributes ?? []) {
    const v = state[`attr_${a.key}`];
    if (v !== undefined && v !== '') attributes[a.key] = a.type === 'number' ? Number(v) : v;
  }
  if (stage.outputForm === 'bulk') {
    if (stage.outputPolicy === 'conserved') return { attributes }; // output = input
    return { outputQty: state.outputQty ? Number(state.outputQty) : undefined, attributes };
  }
  return {
    outputItemId: state.outputItemId || undefined,
    unitsProduced: state.unitsProduced ? Number(state.unitsProduced) : undefined,
    unitsRejected: state.unitsRejected ? Number(state.unitsRejected) : 0,
    outputWarehouseId: state.outputWarehouseId || undefined,
    attributes,
  };
}

function outputReady(stage: Stage, state: Record<string, string>): boolean {
  for (const a of stage.attributes ?? []) {
    if (a.required && !(state[`attr_${a.key}`] ?? '').length) return false;
  }
  if (stage.outputForm === 'bulk') {
    return stage.outputPolicy === 'conserved' ? true : !!state.outputQty;
  }
  return !!state.outputItemId && !!state.unitsProduced && !!state.outputWarehouseId;
}

function NewBatchForm({ stage, onError }: { stage: Stage; onError: (e: unknown) => void }) {
  const { t, can } = useAuth();
  const qc = useQueryClient();
  const stock = useStock('?kind=raw_material');
  const uoms = useUoms();
  const sources = useSourceBatches(stage.code, stage.inputSource === 'prior_batch');
  const stagesQ = useStages();
  const allBatches = useBatches();

  // batches of the QC-gated prior stage that still hold output but are not
  // released yet — shown with the reason so workers know WHY they are missing
  const priorStage = stagesQ.data?.find((s) => s.id === stage.priorStageId);
  const blockedSources =
    stage.inputSource === 'prior_batch' && priorStage?.requiresQc
      ? (allBatches.data ?? []).filter(
          (b) =>
            b.stageId === priorStage.id &&
            b.status === 'completed' &&
            (b.outputQty ?? 0) - b.consumedOutputQty > 0 &&
            !isReleased(b),
        )
      : [];
  const blockedReason = (b: Batch): string => {
    switch (qcDisplay(b)) {
      case 'failed':
        return t('production.blocked_failed', 'quality test failed — retest required before release');
      case 'retest_required':
        return t('production.blocked_retest', 'retest required');
      case 'passed_pending_release':
        return t('production.blocked_release', 'passed — awaiting quality release');
      default:
        return t('production.blocked_pending', 'awaiting quality test');
    }
  };
  const [state, setStateObj] = useState<Record<string, string>>({ date: fmt.todayIso() });
  const [busy, setBusy] = useState(false);
  const setState = (k: string, v: string) => setStateObj((s) => ({ ...s, [k]: v }));

  const eligibleLots = useMemo(
    () =>
      (stock.data ?? []).filter(
        (r) => r.available > 0 && r.lotId && (!stage.inputItemId || r.itemId === stage.inputItemId),
      ),
    [stock.data, stage.inputItemId],
  );
  const massUoms = uoms.data?.filter((u) => u.family === 'mass') ?? [];
  const effUomId = state.inputUomId || massUoms.find((u) => u.code === 'kg')?.id || '';

  const selectedLot = eligibleLots.find((r) => `${r.lotId}|${r.warehouseId}` === state.lotKey);

  const inputReady =
    stage.inputSource === 'lot'
      ? !!selectedLot && !!state.inputQty
      : !!state.inputBatchId && !!state.inputBatchQty;

  async function submit(complete: boolean) {
    setBusy(true);
    onError(null);
    try {
      const base = {
        stageCode: stage.code,
        date: state.date,
        operatorName: state.operatorName || undefined,
        notes: state.notes || undefined,
        attributes: collectOutput(stage, state).attributes,
      };
      const payload =
        stage.inputSource === 'lot'
          ? {
              ...base,
              inputLotId: selectedLot!.lotId,
              inputWarehouseId: selectedLot!.warehouseId,
              inputQty: Number(state.inputQty),
              inputUomId: effUomId,
            }
          : {
              ...base,
              inputBatchId: state.inputBatchId,
              inputBatchQty: Number(state.inputBatchQty),
            };
      const { id } = await api.post<{ id: string }>('/api/batches', payload);
      if (complete) {
        await api.post(`/api/batches/${id}/complete`, collectOutput(stage, state));
      }
      setStateObj({ date: fmt.todayIso() });
      invalidate(qc);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>
          {t('production.new_batch', 'New batch')} — {t(stage.nameKey, stage.code)}
        </h2>
      </div>
      <div className="panel-body">
        {blockedSources.length > 0 ? (
          <div className="page-info">
            <strong>{t('production.blocked_title', 'Batches not yet available for this stage')}:</strong>
            {blockedSources.map((b) => (
              <div key={b.id} className="flex" style={{ marginTop: 6 }}>
                <span className="mono">{b.docNumber}</span>
                <StatusBadge status={qcDisplay(b)} />
                <span>— {blockedReason(b)}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="form-grid">
          <Field label={t('shell.date', 'Date')} required>
            <input type="date" value={state.date ?? ''} onChange={(e) => setState('date', e.target.value)} />
          </Field>
          {stage.inputSource === 'lot' ? (
            <>
              <Field label={t('production.source_lot', 'Source batch / warehouse')} required>
                <select value={state.lotKey ?? ''} onChange={(e) => setState('lotKey', e.target.value)}>
                  <option value="">—</option>
                  {eligibleLots.map((r) => (
                    <option key={`${r.lotId}|${r.warehouseId}`} value={`${r.lotId}|${r.warehouseId}`}>
                      {r.lotNumber} — {r.warehouseName} ({fmt.qty(r.available)} kg)
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('production.input_qty', 'Input quantity')} required>
                <input type="number" min="0" step="any" value={state.inputQty ?? ''} onChange={(e) => setState('inputQty', e.target.value)} />
              </Field>
              <Field label={t('receiving.unit', 'Unit')} required>
                <select value={effUomId} onChange={(e) => setState('inputUomId', e.target.value)}>
                  {massUoms.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          ) : (
            <>
              <Field label={t('production.source_batch', 'Source batch')} required>
                <select value={state.inputBatchId ?? ''} onChange={(e) => setState('inputBatchId', e.target.value)}>
                  <option value="">—</option>
                  {(sources.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.docNumber} ({fmt.qty((b.outputQty ?? 0) - b.consumedOutputQty)} kg {t('inventory.available', 'available')})
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('production.input_qty_kg', 'Quantity received (kg)')} required>
                <input type="number" min="0" step="any" value={state.inputBatchQty ?? ''} onChange={(e) => setState('inputBatchQty', e.target.value)} />
              </Field>
            </>
          )}
          <OutputFields stage={stage} state={state} setState={setState} />
          <Field label={t('production.operator', 'Operator / supervisor')}>
            <input value={state.operatorName ?? ''} onChange={(e) => setState('operatorName', e.target.value)} />
          </Field>
          <Field label={t('shell.notes', 'Notes')}>
            <input value={state.notes ?? ''} onChange={(e) => setState('notes', e.target.value)} />
          </Field>
        </div>
        <div className="form-actions">
          <button className="btn btn-secondary" disabled={busy || !inputReady} onClick={() => void submit(false)}>
            {t('shell.save_draft', 'Save draft')}
          </button>
          {can('production', 'edit') ? (
            <button
              className="btn btn-primary"
              disabled={busy || !inputReady || !outputReady(stage, state)}
              onClick={() => void submit(true)}
            >
              {t('production.complete_batch', 'Complete batch')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CompleteModal({ stage, batch, onClose }: { stage: Stage; batch: Batch; onClose: () => void }) {
  const { t } = useAuth();
  const qc = useQueryClient();
  const [state, setStateObj] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const a of stage.attributes ?? []) {
      const v = (batch.attributes as Record<string, unknown> | null)?.[a.key];
      if (v != null) init[`attr_${a.key}`] = String(v);
    }
    return init;
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const setState = (k: string, v: string) => setStateObj((s) => ({ ...s, [k]: v }));

  async function complete() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/batches/${batch.id}/complete`, collectOutput(stage, state));
      invalidate(qc);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${t('production.complete', 'Complete')} ${batch.docNumber}`} onClose={onClose}>
      <ErrorBox error={error} />
      <div className="page-info">
        {t('production.input', 'Input')}: {fmt.qty(batch.inputQty)}
      </div>
      <div className="form-grid">
        <OutputFields stage={stage} state={state} setState={setState} />
      </div>
      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          {t('shell.cancel', 'Cancel')}
        </button>
        <button className="btn btn-primary" disabled={busy || !outputReady(stage, state)} onClick={() => void complete()}>
          {t('production.complete_batch', 'Complete batch')}
        </button>
      </div>
    </Modal>
  );
}

function BatchDetailModal({ stage, batch, onClose }: { stage: Stage; batch: Batch; onClose: () => void }) {
  const { t, can } = useAuth();
  const qc = useQueryClient();
  const detail = useBatchDetail(batch.id);
  const genealogy = useBatchGenealogy(batch.id);
  const uiConfig = useQuery({
    queryKey: ['ui-config'],
    queryFn: () => api.get<{ qualityTargetPpm: string | null }>('/api/ui-config'),
  });
  const [error, setError] = useState<unknown>(null);
  const [target, setTarget] = useState<string | null>(null); // null = use configured default
  const [actual, setActual] = useState('');
  const [status, setStatus] = useState<'passed' | 'failed' | 'retest_required'>('passed');
  const [testedBy, setTestedBy] = useState('');
  const [testDate, setTestDate] = useState(fmt.todayIso());
  const [notes, setNotes] = useState('');

  const b = detail.data?.batch ?? batch;
  const tests = detail.data?.tests ?? [];
  const approved = isReleased(b);
  const latestPassedUnapproved = tests[0]?.status === 'passed' && !tests[0]?.approvedAt;
  // configured target is the default; the recorded test keeps its own value
  const effectiveTarget = target ?? uiConfig.data?.qualityTargetPpm ?? '';

  async function recordTest() {
    setError(null);
    try {
      await api.post(`/api/batches/${batch.id}/qc-test`, {
        targetLevel: effectiveTarget || undefined,
        actualResult: actual,
        status,
        operatorName: testedBy || undefined,
        date: testDate,
        notes: notes || undefined,
      });
      setActual('');
      setNotes('');
      invalidate(qc);
    } catch (err) {
      setError(err);
    }
  }

  async function approve() {
    setError(null);
    try {
      await api.post(`/api/batches/${batch.id}/qc-approve`);
      invalidate(qc);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Modal title={`${b.docNumber} — ${t(stage.nameKey, stage.code)}`} onClose={onClose} wide>
      <ErrorBox error={error} />
      <div className="cards">
        <StatCard label={t('production.input', 'Input')} value={fmt.qty(b.inputQty)} />
        {stage.outputForm === 'bulk' ? (
          <>
            <StatCard label={t('production.output', 'Output')} value={b.outputQty != null ? fmt.qty(b.outputQty) : '—'} />
            <StatCard label={t('production.loss', 'Loss')} value={b.lossQty != null ? fmt.qty(b.lossQty) : '—'} />
          </>
        ) : (
          <StatCard
            label={t('production.good_units', 'Good units')}
            value={b.unitsProduced != null ? fmt.qty((b.unitsProduced ?? 0) - (b.unitsRejected ?? 0)) : '—'}
          />
        )}
        {stage.requiresQc ? (
          <StatCard
            label={t('production.qc', 'Quality')}
            value={<StatusBadge status={qcDisplay(b)} />}
            sub={
              approved
                ? t('production.approved', 'Approved')
                : b.qcStatus === 'passed_pending_release'
                  ? t('production.awaiting', 'Awaiting approval')
                  : undefined
            }
          />
        ) : null}
      </div>

      {stage.requiresQc && approved ? (
        <div className="page-info">{t('production.released_note', 'Released — available for Packaging.')}</div>
      ) : null}

      {stage.requiresQc && b.status === 'completed' && !approved && can('quality', 'create') && !latestPassedUnapproved ? (
        <div className="panel">
          <div className="panel-head">
            <h2>{tests.length > 0 ? t('production.record_retest', 'Record retest') : t('production.record_test', 'Record test result')}</h2>
          </div>
          <div className="panel-body">
            <div className="form-grid">
              <Field label={t('production.target', 'Target level')}>
                <input value={effectiveTarget} onChange={(e) => setTarget(e.target.value)} />
              </Field>
              <Field label={t('production.actual', 'Actual test result')} required>
                <input value={actual} onChange={(e) => setActual(e.target.value)} />
              </Field>
              <Field label={t('production.test_status', 'Test status')} required>
                <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                  <option value="passed">{t('status.passed', 'Passed')}</option>
                  <option value="failed">{t('status.failed', 'Failed')}</option>
                  <option value="retest_required">{t('status.retest_required', 'Retest Required')}</option>
                </select>
              </Field>
              <Field label={t('production.tested_by', 'Tested by')} required>
                <input value={testedBy} onChange={(e) => setTestedBy(e.target.value)} />
              </Field>
              <Field label={t('production.test_date', 'Test date')} required>
                <input type="date" value={testDate} onChange={(e) => setTestDate(e.target.value)} />
              </Field>
              <Field label={t('shell.notes', 'Notes')}>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </div>
            <div className="form-actions">
              <button
                className="btn btn-primary"
                disabled={!actual.trim() || !testedBy.trim() || !testDate}
                onClick={() => void recordTest()}
              >
                {tests.length > 0 ? t('production.record_retest', 'Record retest') : t('production.submit_test', 'Submit test')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {stage.requiresQc && b.status === 'completed' && !approved && latestPassedUnapproved ? (
        <div className="panel">
          <div className="panel-body">
            <div className="page-info" style={{ marginBottom: can('quality', 'approve') ? 12 : 0 }}>
              {t(
                'production.awaiting_release_note',
                'Test passed. An authorized quality approver must Approve & Release before Packaging can use this batch.',
              )}
            </div>
            {can('quality', 'approve') ? (
              <div className="form-actions">
                <button className="btn btn-primary" onClick={() => void approve()}>
                  {t('production.approve_release', 'Approve & Release')}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {stage.requiresQc && tests.length > 0 ? (
        <div className="panel">
          <div className="panel-head">
            <h2>{t('production.test_history', 'Test and retest history')}</h2>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('shell.date', 'Date')}</th>
                  <th>{t('production.target', 'Target')}</th>
                  <th>{t('production.actual', 'Actual result')}</th>
                  <th>{t('production.tested_by', 'Tested by')}</th>
                  <th>{t('shell.status', 'Status')}</th>
                  <th>{t('production.approved', 'Approved')}</th>
                </tr>
              </thead>
              <tbody>
                {tests.map((qt2) => (
                  <tr key={qt2.id}>
                    <td>{qt2.attemptNumber}</td>
                    <td>{fmt.date(qt2.date)}</td>
                    <td>{qt2.targetLevel ?? '—'}</td>
                    <td>{qt2.actualResult}</td>
                    <td>{qt2.operatorName ?? '—'}</td>
                    <td>
                      <StatusBadge status={qt2.status} />
                    </td>
                    <td>{qt2.approvedAt ? fmt.dateTime(qt2.approvedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <h2>{t('production.traceability', 'Traceability')}</h2>
        </div>
        <div className="panel-body">
          <div className="flex" style={{ flexWrap: 'wrap' }}>
            {[...(genealogy.data?.backward ?? [])].reverse().map((n) => (
              <React.Fragment key={n.id}>
                <span className={`badge ${n.kind === 'lot' ? 'badge-navy' : 'badge-blue'}`}>
                  {n.label}
                </span>
                <span className="muted">→</span>
              </React.Fragment>
            ))}
            <span className="badge badge-green">{b.docNumber}</span>
            {(genealogy.data?.forward ?? []).map((n) => (
              <React.Fragment key={n.id}>
                <span className="muted">→</span>
                <span className={`badge ${n.kind === 'lot' ? 'badge-navy' : 'badge-blue'}`}>
                  {n.label}
                </span>
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
