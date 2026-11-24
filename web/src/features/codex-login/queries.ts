import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type {
  CodexLoginBatch,
  CodexLoginProfile,
  CodexLoginServiceConfig,
} from './types'

export const CODEX_LOGIN_BASE = '/api/panel/codex-login'

export function codexLoginServiceQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'codex-login', 'service'] as const,
    queryFn: () => api<CodexLoginServiceConfig>(`${CODEX_LOGIN_BASE}/service`),
  })
}

/**
 * 当前批次。只在运行中每 2 秒轮询一次；请求失败就停，不靠重试刷屏
 * （全局 QueryCache 会对每次失败弹 toast）。
 */
export function codexLoginBatchQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'codex-login', 'batch'] as const,
    queryFn: () =>
      api<CodexLoginBatch | null>(`${CODEX_LOGIN_BASE}/batches/current`),
    retry: false,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.status === 'error'
        ? false
        : query.state.data?.status === 'running'
          ? 2000
          : false,
  })
}

/** 已登记密码登录的槽位。有重登在跑时 3 秒刷新一次。 */
export function codexLoginProfilesQueryOptions() {
  return queryOptions({
    queryKey: ['panel', 'codex-login', 'profiles'] as const,
    queryFn: () =>
      api<{ items: CodexLoginProfile[] }>(`${CODEX_LOGIN_BASE}/profiles`),
    retry: false,
    refetchInterval: (query) =>
      query.state.status === 'error'
        ? false
        : query.state.data?.items.some((p) => p.relogin.state !== 'idle')
          ? 3000
          : false,
  })
}
