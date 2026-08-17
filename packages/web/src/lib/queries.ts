import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import type { Item, Uom, Warehouse, Party, Receipt, Transfer, StockRow, Movement } from './types.js';

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
