import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const productClient = path.join('packages', 'dsh-pangea-product', 'client.js')
const productPackage = path.join('packages', 'dsh-pangea-product', 'package.json')
const installedModelsClient = path.join(
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-settings-models',
  'lib',
  'client.js'
)

describe('PANGEA model settings entry', () => {
  it('ships a browser client for the desktop product plugin', async () => {
    const pkg = JSON.parse(await readFile(productPackage, 'utf8')) as {
      exports?: Record<string, string>
      dsh?: { client?: { platform?: string; inject?: string[] } }
    }
    const client = await readFile(productClient, 'utf8')

    expect(pkg.exports?.['./client']).toBe('./client.js')
    expect(pkg.dsh?.client?.platform).toBe('web')
    expect(pkg.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-runtime')
    expect(client).toContain("const OPEN_EVENT = 'pangea:open-model-settings'")
    expect(client).toContain("button.setAttribute('aria-label', '设置')")
    expect(client).toContain("toolList.appendChild(createSettingsButton())")
    execFileSync(process.execPath, ['--check', productClient])
  })

  it('patches the native Models component into a model-only PANGEA overlay', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('data-pangea-model-settings-overlay')
    expect(client).toContain('id: "pangea-model-settings"')
    expect(client).toContain('name: "shell.overlay"')
    expect(client).toContain('children: (0, react_jsx_runtime.jsx)(ModelsSection, { ...props })')
    expect(client).toContain('pangea:open-model-settings')
  })

  it('offers the same model-only settings surface from first-run onboarding', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('onboardingCustomProvider: "自定义 / 内部模型提供方"')
    expect(client).toContain('onboardingCustomProviderHint: "OpenAI 兼容接口、私有部署或内网模型"')
    expect(client).toContain('children: t("onboardingCustomProvider")')
    expect(client).toContain('window.dispatchEvent(new CustomEvent("pangea:open-model-settings"))')
  })
})
