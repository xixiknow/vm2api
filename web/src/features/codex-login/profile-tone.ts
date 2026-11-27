import type { StatusTone } from '@/types/status'
import { codexAuthStageText } from './batch-text'
import type { CodexLoginProfile } from './types'

/** 一个登记槽位当前最需要知道的一件事。 */
export function profileTone(profile: CodexLoginProfile): StatusTone {
  const tone = (key: string, text: string, cls: string) => ({ key, text, cls })
  if (profile.relogin.state === 'queued') {
    return tone('relogin_queued', '排队重登', 'warn')
  }
  if (profile.relogin.state !== 'idle') {
    const stage = codexAuthStageText(profile.relogin.stage)
    return tone('relogin', stage ? `重登中 · ${stage}` : '重登中', 'warn')
  }
  if (profile.secret_unreadable)
    return tone('unreadable', '密码无法解密', 'bad')
  if (profile.state.auto_paused === 'workspace_not_found') {
    return tone('workspace_paused', '原工作区失效', 'bad')
  }
  if (profile.state.auto_paused) return tone('paused', '自动重登已暂停', 'bad')
  if (profile.state.last_relogin_result === 'failed') {
    return tone('relogin_failed', '上次重登失败', 'bad')
  }
  if (!profile.auto_relogin) return tone('off', '自动重登关', 'off')
  if (profile.state.auth_fail_streak > 0) {
    return tone(
      'auth',
      `鉴权失败 ${profile.state.auth_fail_streak} 次`,
      'caution'
    )
  }
  if (profile.state.last_probe_result === 'ok') return tone('ok', '正常', 'ok')
  if (profile.state.last_probe_result)
    return tone('probe', '巡检未通过', 'caution')
  return tone('pending', '待巡检', 'none')
}
