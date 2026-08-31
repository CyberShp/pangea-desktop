import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const productClient = path.join('packages', 'dsh-pangea-product', 'client.js')
const productPackage = path.join('packages', 'dsh-pangea-product', 'package.json')
const productPatch = path.join('packages', 'dsh-pangea-product', 'cordis.patch.yml')
const installedModelsClient = path.join(
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-settings-models',
  'lib',
  'client.js'
)

describe('PANGEA model settings entry', () => {
  it('keeps the desktop product plugin active without injecting duplicate product navigation', async () => {
    const pkg = JSON.parse(await readFile(productPackage, 'utf8')) as {
      exports?: Record<string, string>
      dsh?: { client?: { platform?: string; inject?: string[] } }
    }
    const [client, patch] = await Promise.all([
      readFile(productClient, 'utf8'),
      readFile(productPatch, 'utf8')
    ])

    expect(pkg.exports?.['./client']).toBe('./client.js')
    expect(pkg.dsh?.client?.platform).toBe('web')
    expect(pkg.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-runtime')
    expect(patch).toContain('id: pangea-product-shell')
    expect(patch).toContain('name: dsh-pangea-product')
    expect(client).toContain('Product navigation and first-launch affordances are rendered by dsh-pangea')
    expect(client).not.toContain('MutationObserver')
    expect(client).not.toContain('createSettingsButton')
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

  it('publishes model readiness for the PANGEA-owned first-launch UI', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('pangea:model-onboarding-state')
    expect(client).toContain('pangea:query-model-onboarding')
    expect(client).toContain('const customAvailable = state.namespaces.get("llm-pi-ai") !== void 0')
    expect(client).toContain('!state.rows.some(providerUsable)')
  })

  it('opens the native custom-provider card directly from first-run onboarding', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('onboardingCustomProvider: "自定义 / 内部模型提供方"')
    expect(client).toContain('onboardingCustomProviderHint: "OpenAI 兼容接口、私有部署或内网模型"')
    expect(client).toContain('children: t("onboardingCustomProvider")')
    expect(client).toContain('event?.detail?.mode === "custom" ? "custom" : "models"')
    expect(client).toContain('(0, react_jsx_runtime.jsx)(CustomProviderCard, {')
    expect(client).toContain('new CustomEvent("pangea:open-model-settings", { detail: { mode: "custom" } })')
  })
})
