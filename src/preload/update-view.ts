import type { UpdateStatus } from '../shared/contracts'

export type UpdateLocale = 'en' | 'zh'

export function shouldShowUpdate(status: UpdateStatus): boolean {
  if (['downloading', 'downloaded'].includes(status.phase)) return true
  return status.manual && ['checking', 'up-to-date', 'install-error', 'error', 'unsupported'].includes(status.phase)
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
    case 'up-to-date':
      return { title: zh ? '已是最新版本' : 'Up to date', description: `PANGEA Desktop v${status.currentVersion}` }
    case 'checking':
      return {
        title: status.source === 'github' ? (zh ? '正在检查在线更新' : 'Checking for updates') : (zh ? '正在读取升级包' : 'Reading update package'),
        description: zh ? `当前版本 v${status.currentVersion}` : `Current version v${status.currentVersion}`
      }
    case 'downloading':
      return {
        title: status.activity === 'download' ? (zh ? '正在下载升级包' : 'Downloading update') : (zh ? '正在校验升级包' : 'Verifying update package'),
        description: zh ? `${version} · ${Math.round(status.percent ?? 0)}%` : `${version} · ${Math.round(status.percent ?? 0)}%`
      }
    case 'downloaded':
      return {
        title: zh ? '更新已就绪' : 'Update ready',
        description: zh
          ? status.packageType === 'patch'
            ? `补丁 ${status.baseVersion ?? status.currentVersion} → ${version} 已验证；完成当前分析后可重启升级。`
            : `${version} 已验证；完成当前分析后可重启升级。`
          : status.packageType === 'patch'
            ? `Patch ${status.baseVersion ?? status.currentVersion} → ${version} is verified. Restart after current analysis finishes.`
            : `${version} is verified. Restart after current analysis finishes.`
      }
    case 'install-error':
      return {
        title: zh ? '升级未完成' : 'Update was not completed',
        description: zh
          ? `${version} 升级未完成，请查看失败原因和恢复结果。`
          : `The update to ${version} was not completed. Check the error and recovery result.`
      }
    case 'unsupported':
      return {
        title: zh ? '无法导入升级包' : 'Package import unavailable',
        description: status.message ?? ''
      }
    case 'error':
      return {
        title: status.source === 'github' ? (zh ? '在线更新失败' : 'Online update failed') : (zh ? '升级包校验失败' : 'Update package verification failed'),
        description: status.source === 'github' ? (zh ? '可通过菜单重新检查更新，或导入离线升级包。' : 'Retry from the menu or import an offline package.') : zh ? '请选择由 PANGEA Desktop 构建生成的完整包或补丁包。' : 'Choose a full or patch package produced by the PANGEA Desktop build.'
      }
    case 'idle':
      return { title: '', description: '' }
  }
}

export function updateMessage(status: UpdateStatus, locale: UpdateLocale): string {
  const zh = locale === 'zh'
  const version = status.availableVersion ? ` ${status.availableVersion}` : ''

  switch (status.phase) {
    case 'up-to-date':
      return zh ? '已是最新版本' : 'Up to date'
    case 'checking':
      if (status.source === 'github') return zh ? '正在检查在线更新…' : 'Checking for updates…'
      return zh ? '正在读取升级包…' : 'Reading update package…'
    case 'downloading': {
      const percent = Math.round(status.percent ?? 0)
      if (status.activity === 'download') return zh ? `正在下载升级包 ${percent}%` : `Downloading update ${percent}%`
      return zh ? `正在校验升级包 ${percent}%` : `Verifying update package ${percent}%`
    }
    case 'downloaded':
      return status.packageType === 'patch'
        ? (zh
          ? `PANGEA Desktop 补丁 ${status.baseVersion ?? status.currentVersion} →${version} 已验证完成`
          : `PANGEA Desktop patch ${status.baseVersion ?? status.currentVersion} →${version} is verified and ready`)
        : (zh ? `PANGEA Desktop${version} 已验证完成` : `PANGEA Desktop${version} is verified and ready`)
    case 'install-error':
      return zh ? `PANGEA Desktop${version} 升级未完成` : `PANGEA Desktop${version} update was not completed`
    case 'unsupported':
      return zh ? '当前版本无法导入升级包' : 'Package import is unavailable in this build'
    case 'error':
      if (status.source === 'github') return zh ? '在线更新失败' : 'Online update failed'
      return zh ? '升级包校验失败' : 'Update package verification failed'
    case 'idle':
      return ''
  }
}
