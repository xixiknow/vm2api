import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type {
  GptIqArtifactPayload,
  GptIqConfigPayload,
  GptIqEvent,
  GptIqSlotsPayload,
  SlotIqView,
} from './types'

export const GPT_IQ_BASE = '/api/panel/gpt-iq'

export function gptIqConfigQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'gpt-iq', 'config'] as const,
    queryFn: () => api<GptIqConfigPayload>(`${GPT_IQ_BASE}/config`),
  })
}

export function gptIqSlotsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'gpt-iq', 'slots'] as const,
    queryFn: () => api<GptIqSlotsPayload>(`${GPT_IQ_BASE}/slots`),
    refetchInterval: 10_000,
  })
}

export function gptIqEventsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'gpt-iq', 'events'] as const,
    queryFn: () => api<{ items: GptIqEvent[] }>(`${GPT_IQ_BASE}/events`),
    refetchInterval: 15_000,
  })
}

export function vmIqCheckQueryOptions(vmId: string) {
  return queryOptions({
    queryKey: ['panel', 'vm-iq-check', vmId] as const,
    queryFn: () =>
      api<SlotIqView>(`/api/panel/vms/${encodeURIComponent(vmId)}/iq-check`),
    refetchInterval: (query) => (query.state.data?.running ? 3_000 : 15_000),
  })
}

export function vmIqArtifactQueryOptions(vmId: string) {
  return queryOptions({
    queryKey: ['panel', 'vm-iq-artifact', vmId] as const,
    queryFn: () =>
      api<GptIqArtifactPayload>(
        `/api/panel/vms/${encodeURIComponent(vmId)}/iq-check/artifact`
      ),
    retry: false,
  })
}

export function gptIqModelsQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'test-models', 'openai'] as const,
    queryFn: () =>
      api<{ items: Array<{ id: string; label?: string }> }>(
        '/api/panel/test-models?platform=openai'
      ),
    staleTime: 60_000,
  })
}
