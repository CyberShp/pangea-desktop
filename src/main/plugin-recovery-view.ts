import type { RuntimeSnapshot } from '../shared/contracts'
import { extractFailureCause } from './runtime/harness-runtime'

export type PluginRecoveryLocale = 'en' | 'zh'

export interface PluginRecoveryViewModel {
  locale: PluginRecoveryLocale
  brand: string
  badge: string
  heading: string
  summary: string
  reasonTitle: string
  reasonDetail: string
  plugins: string[]
  removedPlugins: string[]
  progress?: string
  notice?: string
  safetyNote: string
  primaryLabel: string
  primaryBusyLabel: string
  logLabel: string
  advancedLabel: string
  errorLabel: string
  launchDirectoryLabel: string
  launchDirectory?: string
  rawError: string
  quitLabel: string
  canUninstall: boolean
}

interface FailureDescription {
  title: string
  detail: string
  summary?: string
}

function displayPluginName(packageName: string): string {
  if (!packageName.startsWith('@')) return packageName
  return packageName.slice(packageName.indexOf('/') + 1)
}

function latestAttemptText(logs: readonly string[]): string {
  let startIndex = -1
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    if (logs[index]?.trimStart().startsWith('[desktop] starting ')) {
      startIndex = index
      break
    }
  }
  return logs.slice(startIndex + 1).join('\n')
}

function loaderEntryFailure(text: string): { entryId: string; plugin: string; cause: string } | undefined {
  const pattern = /failed to (?:apply|import) loader entry\s+([^\s(]+)\s+\(([^)]+)\):\s*/gi
  let latest: RegExpExecArray | null = null
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) latest = match
  if (!latest) return undefined
  const cause = text
    .slice(latest.index + latest[0].length)
    .split(/\r?\n/, 1)[0]
    ?.trim()
    .slice(0, 400)
  return {
    entryId: latest[1] ?? 'unknown',
    plugin: latest[2] ?? 'unknown',
    cause: cause || 'No additional error detail was reported.'
  }
}

export function describePluginFailure(
  logs: readonly string[],
  locale: PluginRecoveryLocale,
  rawError = ''
): FailureDescription {
  const text = `${latestAttemptText(logs)}\n${rawError}`
  const loaderFailure = loaderEntryFailure(text)
  const duplicateRoute = text.match(/duplicate prefix route ["']([^"']+)["']/i)?.[1]

  if (duplicateRoute) {
    return locale === 'zh'
      ? {
          title: loaderFailure
            ? `插件 ${loaderFailure.plugin} 使用了重复的服务入口`
            : '插件使用了重复的服务入口',
          detail: `启动日志显示 ${duplicateRoute} 被重复注册${loaderFailure ? `（loader entry “${loaderFailure.entryId}”）` : ''}，因此 Harness 无法继续启动。`
        }
      : {
          title: loaderFailure
            ? `Plugin ${loaderFailure.plugin} registered a duplicate service route`
            : 'A plugin registered a duplicate service route',
          detail: `The startup log shows that ${duplicateRoute} was registered more than once${loaderFailure ? ` by loader entry “${loaderFailure.entryId}”` : ''}, so Harness could not continue.`
        }
  }
 
  if (/duplicate loader entry id/i.test(text)) {
    const entryId = text.match(/duplicate loader entry id:\s*([^\s]+)/i)?.[1]
    return locale === 'zh'
      ? {
          title: loaderFailure
            ? `插件 ${loaderFailure.plugin} 注册了重复的服务组件`
            : '插件注册了重复的服务组件',
          detail: `启动日志显示组件 ${entryId ? `"${entryId}"` : ''} 被重复定义${loaderFailure ? `（loader entry “${loaderFailure.entryId}”）` : ''}，插件之间存在加载冲突，因此 Harness 无法继续启动。`
        }
      : {
          title: loaderFailure
            ? `Plugin ${loaderFailure.plugin} registered a duplicate service component`
            : 'A plugin registered a duplicate service component',
          detail: `The startup log shows that component ${entryId ? `"${entryId}"` : ''} was registered more than once${loaderFailure ? ` by loader entry “${loaderFailure.entryId}”` : ''} due to a plugin conflict.`
        }
  }

  if (/cannot resolve profile bundle/i.test(text)) {
    return locale === 'zh'
      ? {
          title: '插件没有完整安装',
          detail: '配置中仍然引用了这个插件，但本地找不到对应的插件包。'
        }
      : {
          title: 'The plugin is not fully installed',
          detail: 'The profile still references this plugin, but its package cannot be found locally.'
        }
  }

  if (/declares no dsh\.bundle/i.test(text)) {
    return locale === 'zh'
      ? {
          title: '安装的包不是兼容的 DSH 插件',
          detail: '这个包缺少 DSH 插件所需的入口声明，因此 Harness 无法加载。'
        }
      : {
          title: 'The package is not a compatible DSH plugin',
          detail: 'It does not declare the entry point required by Harness.'
        }
  }

  if (/single slot\s+["'][^"']+["']\s+already has a registration/i.test(text)) {
    const slotName = text.match(/single slot\s+["']([^"']+)["']/i)?.[1]
    return locale === 'zh'
      ? {
          title: '插件存在界面插槽冲突',
          detail: `检测到界面插槽 ${slotName ? `"${slotName}"` : ''} 存在重复注册，多个第三方插件试图占用相同的界面组件，导致前端无法正常渲染。`
        }
      : {
          title: 'A plugin has a UI slot conflict',
          detail: `UI slot ${slotName ? `"${slotName}"` : ''} has duplicate registrations from conflicting plugins.`
        }
  }

  if (/failed to import loader entry/i.test(text)) {
    if (loaderFailure) {
      return locale === 'zh'
        ? {
            title: `插件 ${loaderFailure.plugin} 加载失败`,
            detail: `Loader entry “${loaderFailure.entryId}” 启动失败：${loaderFailure.cause}`
          }
        : {
            title: `Plugin ${loaderFailure.plugin} could not load`,
            detail: `Loader entry “${loaderFailure.entryId}” failed during startup: ${loaderFailure.cause}`
          }
    }
    return locale === 'zh'
      ? {
          title: '插件代码加载失败',
          detail: '插件文件可能损坏、缺少依赖，或与当前 Harness 版本不兼容。'
        }
      : {
          title: 'The plugin code could not be loaded',
          detail: 'Its files may be damaged, missing a dependency, or incompatible with this Harness version.'
      }
  }

  if (loaderFailure) {
    return locale === 'zh'
      ? {
          title: `插件 ${loaderFailure.plugin} 启动失败`,
          detail: `Loader entry “${loaderFailure.entryId}” 启动失败：${loaderFailure.cause}`
        }
      : {
          title: `Plugin ${loaderFailure.plugin} failed during startup`,
          detail: `Loader entry “${loaderFailure.entryId}” failed during startup: ${loaderFailure.cause}`
        }
  }

  const reportedCause = extractFailureCause(logs)
  const errorSummary = [rawError.trim(), reportedCause]
    .filter((value, index, values): value is string => Boolean(value) &&
      !values.slice(0, index).some((previous) => previous?.includes(value!)))
    .join('\n')
  const detail = errorSummary.length > 1_200 ? `${errorSummary.slice(0, 1_199)}…` : errorSummary

  if (/\b(?:EPERM|EACCES|EBUSY)\b[^\r\n]*rename[^\r\n]*monitor-v1\.json/i.test(text)) {
    return locale === 'zh'
      ? {
          title: '运行监控记录保存失败',
          summary: '已定位到运行监控文件保存失败，请查看下方错误和 Harness 日志。',
          detail: `系统拒绝替换 monitor-v1.json 运行观察记录。文件占用或访问限制可能导致此错误，具体原因需要结合日志核实。\n${detail}`
        }
      : {
          title: 'Runtime monitoring history could not be saved',
          summary: 'The failure occurred while saving runtime monitoring history. See the error and Harness log below.',
          detail: `The operating system rejected replacement of monitor-v1.json. File sharing or access restrictions may cause this error; the exact cause requires further investigation.\n${detail}`
        }
  }

  if (/Harness did not become ready within/i.test(text)) {
    return locale === 'zh'
      ? { title: 'Harness 启动超时', detail: `本地服务未在规定时间内就绪。${detail ? `\n${detail}` : ''}` }
      : { title: 'Harness startup timed out', detail: `The local service did not become ready in time.${detail ? `\n${detail}` : ''}` }
  }

  if (/(?:Harness entry|Bundled Node\.js runtime|Harness diagnostic entry|DSH Desktop patch) was not found/i.test(text)) {
    return locale === 'zh'
      ? { title: 'Harness 运行文件缺失', detail }
      : { title: 'A required Harness runtime file is missing', detail }
  }

  if (/Harness stopped unexpectedly/i.test(text)) {
    return locale === 'zh'
      ? { title: 'Harness 运行进程已退出', detail }
      : { title: 'The Harness process exited unexpectedly', detail }
  }

  return locale === 'zh'
    ? {
        title: 'Harness 发生错误',
        detail: `暂时无法自动判断具体原因。${detail ? `\n${detail}` : '请打开 Harness 日志查看错误记录。'}`
      }
    : {
        title: 'Harness reported an error',
        detail: `The exact cause could not be determined automatically.${detail ? `\n${detail}` : ' Open the Harness log to inspect the error.'}`
      }
}

export function buildPluginRecoveryViewModel(options: {
  snapshot: RuntimeSnapshot
  plugins: readonly string[]
  removedPlugins: readonly string[]
  locale: PluginRecoveryLocale
  notice?: string
}): PluginRecoveryViewModel {
  const { snapshot, locale, notice } = options
  const pluginPackages = [...new Set(options.plugins)]
  const plugins = pluginPackages.map(displayPluginName)
  const removedPlugins = [...new Set(options.removedPlugins)].map(displayPluginName)
  const canUninstall = plugins.length > 0
  const description = describePluginFailure(snapshot.logs, locale, snapshot.message)
  const multiple = plugins.length > 1

  if (locale === 'zh') {
    return {
      locale,
      brand: 'PANGEA Desktop',
      badge: '启动修复',
      heading: canUninstall
        ? multiple ? `发现 ${plugins.length} 个导致启动失败的插件` : '发现导致启动失败的插件'
        : /Harness stopped unexpectedly/i.test(snapshot.message) ? 'Harness 运行已中断' : 'Harness 暂时无法启动',
      summary: canUninstall
        ? ''
        : description.summary ?? '尚未定位到具体故障组件。你可以打开 Harness 日志查看错误，或尝试安全模式排查第三方插件影响。',
      reasonTitle: description.title,
      reasonDetail: description.detail,
      plugins,
      removedPlugins,
      progress: removedPlugins.length > 0
        ? `已处理 ${removedPlugins.length} 个插件，正在继续检查剩余问题。`
        : undefined,
      notice,
      safetyNote: '工作区、会话、模型配置和其他插件不会被删除。',
      primaryLabel: canUninstall
        ? multiple ? `卸载这 ${plugins.length} 个插件并继续检测` : '卸载此插件并继续检测'
        : '进入安全模式',
      primaryBusyLabel: canUninstall ? '正在处理并重新检测…' : '正在进入安全模式…',
      logLabel: '打开 Harness 日志',
      advancedLabel: '查看技术详情',
      errorLabel: '错误信息',
      launchDirectoryLabel: '启动目录',
      launchDirectory: snapshot.launchDirectory,
      rawError: snapshot.message,
      quitLabel: '退出 PANGEA Desktop',
      canUninstall
    }
  }

  return {
    locale,
    brand: 'PANGEA Desktop',
    badge: 'Startup recovery',
    heading: canUninstall
      ? multiple ? `${plugins.length} plugins are preventing startup` : 'A plugin is preventing startup'
      : /Harness stopped unexpectedly/i.test(snapshot.message) ? 'Harness stopped unexpectedly' : 'Harness could not start',
    summary: canUninstall
      ? ''
      : description.summary ?? 'The failing component has not been identified. Open the Harness log for details. Enter Safe Mode to investigate third-party plugins.',
    reasonTitle: description.title,
    reasonDetail: description.detail,
    plugins,
    removedPlugins,
    progress: removedPlugins.length > 0
      ? `${removedPlugins.length} plugin${removedPlugins.length === 1 ? '' : 's'} handled. Checking for remaining issues.`
      : undefined,
    notice,
    safetyNote: 'Your workspaces, sessions, model settings, and other plugins will not be removed.',
    primaryLabel: canUninstall
      ? multiple ? `Remove these ${plugins.length} plugins and continue` : 'Remove this plugin and continue'
      : 'Enter Safe Mode',
    primaryBusyLabel: canUninstall ? 'Removing and checking again…' : 'Entering Safe Mode…',
    logLabel: 'Open Harness log',
    advancedLabel: 'View technical details',
    errorLabel: 'Error details',
    launchDirectoryLabel: 'Launch directory',
    launchDirectory: snapshot.launchDirectory,
    rawError: snapshot.message,
    quitLabel: 'Quit PANGEA Desktop',
    canUninstall
  }
}
