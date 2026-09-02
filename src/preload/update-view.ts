import type { UpdateStatus } from '../shared/contracts'

export type UpdateLocale = 'en' | 'zh'

export function shouldShowUpdate(status: UpdateStatus): boolean {
  if (['downloading', 'downloaded'].includes(status.phase)) return true
  return status.manual && ['checking', 'install-error', 'error', 'unsupported'].includes(status.phase)
}

export function isUpdateDismissed(
  status: UpdateStatus,
  dismissedVersion: string | null,
  dismissedTransientPhase: UpdateStatus['phase'] | null = null
): boolean {
  if (status.availableVersion) return status.availableVersion === dismissedVersion
  return status.phase === dismissedTransientPhase
}

export interface UpdateHeadline {
  title: string
  description: string
}

/**
 * The card's two lines: what happened, then what it means for the user.
 *
 * The version belongs in the second line rather than the first — a release
 * number answers "which one", not "what now", and reading the state should not
 * require parsing a version string out of a sentence.
 */
export function updateHeadline(status: UpdateStatus, locale: UpdateLocale): UpdateHeadline {
  const zh = locale === 'zh'
  const version = status.availableVersion ? `v${status.availableVersion}` : ''

  switch (status.phase) {
    case 'checking':
      return {
        title: zh ? '正在读取升级包' : 'Reading update package',
        description: zh ? `当前版本 v${status.currentVersion}` : `Current version v${status.currentVersion}`
      }
    case 'downloading':
      return {
        title: zh ? '正在校验升级包' : 'Verifying update package',
        description: zh ? `${version} · ${Math.round(status.percent ?? 0)}%` : `${version} · ${Math.round(status.percent ?? 0)}%`
      }
    case 'downloaded':
      return {
        title: zh ? '更新已就绪' : 'Update ready',
        description: zh
          ? `${version} 已验证；完成当前分析后可重启升级。`
          : `${version} is verified. Restart after current analysis finishes.`
      }
    case 'install-error':
      return {
        title: zh ? '升级未完成' : 'Update was not completed',
        description: zh
          ? `${version} 未安装，当前可用版本已重新启动。`
          : `${version} was not installed. The current working version was restarted.`
      }
    case 'unsupported':
      return {
        title: zh ? '无法导入升级包' : 'Package import unavailable',
        description: status.message ?? ''
      }
    case 'error':
      return {
        title: zh ? '升级包校验失败' : 'Update package verification failed',
        description: zh ? '请选择由 PANGEA Desktop 构建生成的完整 ZIP。' : 'Choose a complete ZIP produced by the PANGEA Desktop build.'
      }
    case 'idle':
      return { title: '', description: '' }
  }
}

export function updateMessage(status: UpdateStatus, locale: UpdateLocale): string {
  const zh = locale === 'zh'
  const version = status.availableVersion ? ` ${status.availableVersion}` : ''

  switch (status.phase) {
    case 'checking':
      return zh ? '正在读取升级包…' : 'Reading update package…'
    case 'downloading': {
      const percent = Math.round(status.percent ?? 0)
      return zh ? `正在校验升级包 ${percent}%` : `Verifying update package ${percent}%`
    }
    case 'downloaded':
      return zh ? `PANGEA Desktop${version} 已验证完成` : `PANGEA Desktop${version} is verified and ready`
    case 'install-error':
      return zh ? `PANGEA Desktop${version} 升级未完成` : `PANGEA Desktop${version} update was not completed`
    case 'unsupported':
      return zh ? '当前版本无法导入升级包' : 'Package import is unavailable in this build'
    case 'error':
      return zh ? '升级包校验失败' : 'Update package verification failed'
    case 'idle':
      return ''
  }
}
