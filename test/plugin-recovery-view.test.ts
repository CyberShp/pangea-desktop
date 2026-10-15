import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { RuntimeSnapshot } from '../src/shared/contracts'
import {
  buildPluginRecoveryViewModel,
  describePluginFailure
} from '../src/main/plugin-recovery-view'

function failedSnapshot(logs: string[] = []): RuntimeSnapshot {
  return {
    phase: 'failed',
    message: 'Harness stopped unexpectedly. duplicate prefix route "/sidebar/api"',
    launchDirectory: '/Users/ray/Library/Application Support/dsh-desktop/launch-root',
    logs
  }
}

describe('plugin recovery view model', () => {
  it('explains a duplicate route without exposing only a raw stack trace', () => {
    const description = describePluginFailure(
      ['[stderr] webserver: duplicate prefix route "/sidebar/api"'],
      'zh'
    )
    expect(description.title).toBe('插件使用了重复的服务入口')
    expect(description.detail).toContain('/sidebar/api')
    expect(description.detail).toContain('启动日志显示')
  })

  it('uses an honest generic explanation when the exact cause is unknown', () => {
    const description = describePluginFailure(
      ['[stderr] plugin initialization returned an unexpected error'],
      'zh'
    )
    expect(description.title).toBe('Harness 发生错误')
    expect(description.detail).toContain('无法自动判断具体原因')
    expect(description.detail).toContain('plugin initialization returned an unexpected error')
    expect(description.detail).not.toContain('/sidebar/api')
  })

  it.each([
    ['Harness stopped unexpectedly (exit code 1 (0x00000001)).\nError: EADDRINUSE', 'Harness 运行进程已退出'],
    ['Harness did not become ready within 120 seconds.', 'Harness 启动超时'],
    ['Bundled Node.js runtime was not found: C:\\app\\node.exe', 'Harness 运行文件缺失'],
    ['Harness could not start: spawn EPERM', 'Harness 发生错误']
  ])('does not blame plugins for a runtime failure: %s', (message, title) => {
    const model = buildPluginRecoveryViewModel({
      snapshot: { ...failedSnapshot(), message },
      plugins: [],
      removedPlugins: [],
      locale: 'zh'
    })
    expect(model.reasonTitle).toBe(title)
    expect(model.reasonDetail).toContain(message)
    expect(model.summary).not.toContain('并继续使用 Agent')
    expect(model.canUninstall).toBe(false)
  })

  it('keeps the current error without repeating its cause or using previous launch failures', () => {
    const message = 'Harness stopped unexpectedly (exit code 1).\nError: listen EACCES'
    const description = describePluginFailure([
      '[desktop] starting previous',
      '[stderr] failed to apply loader entry old (old-plugin): old failure',
      '[desktop] starting current',
      '[stderr] [harness-node] uncaught exception: Error: listen EACCES'
    ], 'en', message)
    expect(description.title).toBe('The Harness process exited unexpectedly')
    expect(description.detail).toBe(message)
    expect(description.detail).not.toContain('old-plugin')
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'])('identifies monitor rename failure without diagnosing a third-party plugin: %s', (code) => {
    const message = `Harness stopped unexpectedly (exit code 1 (0x00000001)).\nError: ${code}: operation not permitted, rename 'C:\\profile\\monitor-v1.json.tmp' -> 'C:\\profile\\monitor-v1.json'`
    const model = buildPluginRecoveryViewModel({
      snapshot: { ...failedSnapshot(), message }, plugins: [], removedPlugins: [], locale: 'zh'
    })
    expect(model.heading).toBe('Harness 运行已中断')
    expect(model.reasonTitle).toBe('运行监控记录保存失败')
    expect(model.reasonDetail).toContain(message)
    expect(model.summary).toContain('运行监控文件保存失败')
    expect(model.summary).not.toContain('第三方插件')
    expect(model.canUninstall).toBe(false)
    const english = describePluginFailure([], 'en', message)
    expect(english.title).toBe('Runtime monitoring history could not be saved')
  })

  it('shows the exact loader entry and plugin when no friendlier cause is known', () => {
    const description = describePluginFailure(
      [],
      'zh',
      'Harness could not start. failed to apply loader entry acp-nga (dsh-pangea-nga-acp): ACP command exited before initialization'
    )
    expect(description.title).toBe('插件 dsh-pangea-nga-acp 启动失败')
    expect(description.detail).toContain('acp-nga')
    expect(description.detail).toContain('ACP command exited before initialization')
  })

  it.each([
    ['cannot resolve profile bundle example', '插件没有完整安装'],
    ['package declares no dsh.bundle', '安装的包不是兼容的 DSH 插件'],
    ['failed to import loader entry example', '插件代码加载失败'],
    ['duplicate loader entry id: storage', '插件注册了重复的服务组件'],
    ['single slot "conversation.hero.workspace.directoryFlow" already has a registration at priority 0', '插件存在界面插槽冲突']
  ])('describes known startup failures: %s', (log, expectedTitle) => {
    expect(describePluginFailure([`[stderr] ${log}`], 'zh').title).toBe(expectedTitle)
  })

  it('presents multiple plugins as one recovery step', () => {
    const model = buildPluginRecoveryViewModel({
      snapshot: failedSnapshot(),
      plugins: ['plugin-a', 'plugin-b', 'plugin-a'],
      removedPlugins: [],
      locale: 'zh'
    })
    expect(model.heading).toBe('发现 2 个导致启动失败的插件')
    expect(model.summary).toBe('')
    expect(model.plugins).toEqual(['plugin-a', 'plugin-b'])
    expect(model.primaryLabel).toBe('卸载这 2 个插件并继续检测')
    expect(model.canUninstall).toBe(true)
    expect(model).not.toHaveProperty('restartLabel')
    expect(model).not.toHaveProperty('status')
    expect(model.advancedLabel).toBe('查看技术详情')
  })

  it('shows progress when recovery discovers another conflict after a restart', () => {
    const model = buildPluginRecoveryViewModel({
      snapshot: failedSnapshot(),
      plugins: ['plugin-b'],
      removedPlugins: ['plugin-a'],
      locale: 'zh'
    })
    expect(model.progress).toContain('已处理 1 个插件')
    expect(model.plugins).toEqual(['plugin-b'])
  })

  it('shows a readable name for a scoped package while recovery keeps its package id', () => {
    const model = buildPluginRecoveryViewModel({
      snapshot: failedSnapshot(),
      plugins: ['@deepseek-harness-tui/dsh-tui'],
      removedPlugins: [],
      locale: 'zh'
    })
    expect(model.plugins).toEqual(['dsh-tui'])
    expect(model.canUninstall).toBe(true)
  })

  it('offers Safe Mode when no plugin can be identified', () => {
    const model = buildPluginRecoveryViewModel({
      snapshot: failedSnapshot(),
      plugins: [],
      removedPlugins: [],
      locale: 'en'
    })
    expect(model.canUninstall).toBe(false)
    expect(model.summary).toContain('Enter Safe Mode')
    expect(model.primaryLabel).toBe('Enter Safe Mode')
    expect(model.primaryBusyLabel).toBe('Entering Safe Mode…')
  })

  it('wires the unresolved recovery action to Safe Mode', async () => {
    const html = await readFile('build/plugin-recovery.html', 'utf8')
    expect(html).toContain("model.canUninstall ? 'uninstall' : 'safe-mode'")
    expect(html).toContain("navigate('show-log')")
    expect(html).not.toContain('id="restart"')
  })
})
