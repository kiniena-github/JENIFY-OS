import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import type {
  Item,
  Uom,
  Warehouse,
  Party,
  Receipt,
  Transfer,
  StockRow,
  Movement,
  Stage,
  Batch,
  QualityTest,
  GenealogyNode,
  Invoice,
  Delivery,
  Payment,
  CreditOverview,
  PricingInfo,
} from './types.js';

export function useItems(params = '') {
  return useQuery({ queryKey: ['items', params], queryFn: () => api.get<Item[]>(`/api/items${params}`) });
}
export function useUoms() {
  return useQuery({ queryKey: ['uoms'], queryFn: () => api.get<Uom[]>('/api/uoms') });
}
export function useWarehouses() {
  return useQuery({ queryKey: ['warehouses'], queryFn: () => api.get<Warehouse[]>('/api/warehouses') });
}
export function useParties(params = '') {
  return useQuery({ queryKey: ['parties', params], queryFn: () => api.get<Party[]>(`/api/parties${params}`) });
}
export function useReceipts() {
  return useQuery({ queryKey: ['receipts'], queryFn: () => api.get<Receipt[]>('/api/receipts') });
}
export function useTransfers() {
  return useQuery({ queryKey: ['transfers'], queryFn: () => api.get<Transfer[]>('/api/transfers') });
}
export function useStock(params = '') {
  return useQuery({ queryKey: ['stock', params], queryFn: () => api.get<StockRow[]>(`/api/stock${params}`) });
}
export function useMovements(params = '') {
  return useQuery({
    queryKey: ['movements', params],
    queryFn: () => api.get<Movement[]>(`/api/movements${params}`),
  });
}
export function useStages() {
  return useQuery({ queryKey: ['stages'], queryFn: () => api.get<Stage[]>('/api/stages') });
}
export function useBatches(params = '') {
  return useQuery({ queryKey: ['batches', params], queryFn: () => api.get<Batch[]>(`/api/batches${params}`) });
}
export function useBatchDetail(id: string | null) {
  return useQuery({
    queryKey: ['batch', id],
    queryFn: () => api.get<{ batch: Batch; tests: QualityTest[] }>(`/api/batches/${id}`),
    enabled: !!id,
  });
}
export function useBatchGenealogy(id: string | null) {
  return useQuery({
    queryKey: ['genealogy', id],
    queryFn: () =>
      api.get<{ backward: GenealogyNode[]; forward: GenealogyNode[] }>(`/api/batches/${id}/genealogy`),
    enabled: !!id,
  });
}
export function useSourceBatches(forStage: string, enabled = true) {
  return useQuery({
    queryKey: ['sources', forStage],
    queryFn: () => api.get<Batch[]>(`/api/production/sources?forStage=${forStage}`),
    enabled,
  });
}
export function useInvoices(params = '') {
  return useQuery({ queryKey: ['invoices', params], queryFn: () => api.get<Invoice[]>(`/api/invoices${params}`) });
}
export function useDeliveries() {
  return useQuery({ queryKey: ['deliveries'], queryFn: () => api.get<Delivery[]>('/api/deliveries') });
}
export function usePayments() {
  return useQuery({ queryKey: ['payments'], queryFn: () => api.get<Payment[]>('/api/payments') });
}
export function useCredit(params = '') {
  return useQuery({ queryKey: ['credit', params], queryFn: () => api.get<CreditOverview>(`/api/credit${params}`) });
}
export function usePricing() {
  return useQuery({ queryKey: ['pricing'], queryFn: () => api.get<PricingInfo>('/api/pricing') });
}
