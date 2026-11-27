import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type {
  AutoResetConfigPayload,
  AutoResetEvent,
  AutoResetSlotsPayload,
  SlotAutoResetView,
} from './types'

export const AUTO_RESET_BASE = '/api/panel/auto-reset'

export function autoResetConfigQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'auto-reset', 'config'] as const,
    queryFn: () => api<AutoResetConfigPayload>(`${AUTO_RESET_BASE}/config`),
  })
}

export function autoResetSlotsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'auto-reset', 'slots'] as const,
    queryFn: () => api<AutoResetSlotsPayload>(`${AUTO_RESET_BASE}/slots`),
  })
}

export function autoResetEventsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'auto-reset', 'events'] as const,
    queryFn: () =>
      api<{ items: AutoResetEvent[] }>(`${AUTO_RESET_BASE}/events`),
  })
}

export function vmAutoResetQueryOptions(vmId: string) {
  return queryOptions({
    queryKey: ['panel', 'vm-auto-reset', vmId] as const,
    queryFn: () =>
      api<SlotAutoResetView>(
        `/api/panel/vms/${encodeURIComponent(vmId)}/auto-reset`
      ),
  })
}
