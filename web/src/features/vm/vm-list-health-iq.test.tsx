import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { VmActionsContext, type VmActions } from './vm-actions-context'
import { VmTable } from './vm-list-table'

const NOOP_ACTIONS: VmActions = {
  openDetail: () => {},
  openTest: () => {},
  openStats: () => {},
  openReauth: () => {},
  openRecovery: () => {},
  refreshToken: () => {},
  recover: () => {},
  refreshingId: null,
  recoveringId: null,
}

function renderTable(vms: Vm[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <VmActionsContext.Provider value={NOOP_ACTIONS}>
          <VmTable vms={vms} />
        </VmActionsContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}

function baseVm(over: Partial<Vm> = {}): Vm {
  return {
    id: 'vm-1',
    name: 'Slot 1',
    has_token: true,
    has_refresh: true,
    schedulable: true,
    schedule_state: 'on',
    health_24h: [[10, 0]],
    availability: { key: 'ok', usable: true, text: '可用' },
    ...over,
  }
}

describe('VmTable Health 24h column with GPT IQ badges', () => {
  it('shows 满血 and 降智隔离 pills for GPT slots and leaves Claude slots untouched', () => {
    const html = renderTable([
      baseVm({
        id: 'gpt-ok',
        name: 'GPT Healthy',
        platform: 'openai',
        family: 'codex',
        iq_check: {
          enabled: true,
          mode: 'inherit',
          running: false,
          isolated: false,
          isolated_at: null,
          status: 'normal',
          raw_status: 'normal',
          reference_only: false,
          label: '正常',
          reason: '分类结果为正常',
          benchmark: 'pelican',
          model: 'gpt-6-astra',
          reasoning_effort: 'low',
          interval_min: 5,
          last_checked_at: '2026-11-27T02:00:00Z',
          next_run_at: '2026-11-27T02:05:00Z',
          last_duration_ms: 42_000,
          last_error: null,
          has_artifact: true,
          stale_24h: false,
          consecutive_degraded: 0,
          summary_24h: {
            total: 12,
            normal: 12,
            degraded: 0,
            unknown: 0,
            error: 0,
          },
        },
      }),
      baseVm({
        id: 'gpt-bad',
        name: 'GPT Degraded',
        platform: 'openai',
        family: 'codex',
        schedulable: false,
        schedule_state: 'unschedulable',
        unschedulable_reason: 'gpt_iq_degraded',
        unschedulable_text: '测智降智隔离',
        iq_check: {
          enabled: true,
          mode: 'enabled',
          running: false,
          isolated: true,
          isolated_at: '2026-11-27T01:55:00Z',
          status: 'degraded',
          raw_status: 'degraded',
          reference_only: false,
          label: '疑似降智',
          reason: '画面异常',
          benchmark: 'pelican',
          model: 'gpt-6-astra',
          reasoning_effort: 'low',
          interval_min: 5,
          last_checked_at: '2026-11-27T01:55:00Z',
          next_run_at: null,
          last_duration_ms: 38_000,
          last_error: null,
          has_artifact: true,
          stale_24h: false,
          consecutive_degraded: 1,
          summary_24h: {
            total: 5,
            normal: 4,
            degraded: 1,
            unknown: 0,
            error: 0,
          },
        },
      }),
      baseVm({
        id: 'claude-1',
        name: 'Claude Normal',
        platform: 'anthropic',
        family: 'claude',
      }),
    ])

    expect(html).toContain('满血')
    expect(html).toContain('降智隔离')
    expect(html).toContain('测智降智隔离')
    expect(html).toContain('测智 1 满血')
    expect(html).toContain('· 1 降智')
  })
})
