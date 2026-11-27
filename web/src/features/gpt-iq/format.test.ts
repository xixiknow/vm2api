import { describe, expect, it } from 'vitest'
import {
  formatIq24hLine,
  iqBucketState,
  iqPillVisual,
  shouldShowIqBadge,
  wrapPreviewHtmlWithCsp,
} from './format'
import type { GptIqVmSummary } from './types'

function sampleIq(over: Partial<GptIqVmSummary> = {}): GptIqVmSummary {
  return {
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
    summary_24h: { total: 6, normal: 6, degraded: 0, unknown: 0, error: 0 },
    ...over,
  }
}

describe('gpt-iq format helpers', () => {
  it('hides pill when disabled and no records exist', () => {
    expect(
      shouldShowIqBadge(
        sampleIq({
          enabled: false,
          status: null,
          summary_24h: {
            total: 0,
            normal: 0,
            degraded: 0,
            unknown: 0,
            error: 0,
          },
        })
      )
    ).toBe(false)
    expect(shouldShowIqBadge(sampleIq())).toBe(true)
  })

  it('maps visual pills for running, isolated, degraded, reference, normal, and pending', () => {
    expect(iqPillVisual(sampleIq({ running: true }))).toEqual({
      text: '测智中',
      tone: 'running',
    })
    expect(
      iqPillVisual(sampleIq({ isolated: true, status: 'degraded' }))
    ).toEqual({
      text: '降智隔离',
      tone: 'bad',
    })
    expect(iqPillVisual(sampleIq({ status: 'degraded' })).tone).toBe('bad')
    expect(
      iqPillVisual(sampleIq({ status: 'degraded', reference_only: true })).text
    ).toBe('参考降智')
    expect(iqPillVisual(sampleIq({ status: 'normal' })).text).toBe('满血')
    expect(iqPillVisual(sampleIq({ status: null })).text).toBe('待测智')
  })

  it('classifies 30-min IQ buckets and formats 24h rollup line', () => {
    expect(iqBucketState([0, 0, 0, 0])).toBe('none')
    expect(iqBucketState([5, 0, 0, 0])).toBe('ok')
    expect(iqBucketState([4, 1, 0, 0])).toBe('bad')
    expect(iqBucketState([0, 0, 0, 2])).toBe('warn')
    expect(iqBucketState([3, 0, 1, 0])).toBe('caution')
    expect(
      formatIq24hLine(
        sampleIq({
          summary_24h: {
            total: 5,
            normal: 4,
            degraded: 1,
            unknown: 0,
            error: 0,
          },
        })
      )
    ).toBe('近 24h（5 次）：满血 4 · 降智 1')
  })

  it('injects strict CSP meta into preview HTML', () => {
    const wrapped = wrapPreviewHtmlWithCsp(
      '<!doctype html><html><head><title>x</title></head><body><svg/></body></html>'
    )
    expect(wrapped).toContain('Content-Security-Policy')
    expect(wrapped).toContain("default-src 'none'")
    expect(wrapped).toContain('<svg/>')
  })
})
