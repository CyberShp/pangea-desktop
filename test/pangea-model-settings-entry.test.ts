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
      dependencies?: Record<string, string>
      dsh?: { client?: { platform?: string; inject?: string[] } }
    }
    const [client, patch] = await Promise.all([
      readFile(productClient, 'utf8'),
      readFile(productPatch, 'utf8')
    ])

    expect(pkg.exports?.['./client']).toBe('./client.js')
    expect(pkg.dsh?.client?.platform).toBe('web')
    expect(pkg.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-runtime')
    expect(pkg.dependencies?.['@deepseek-ai/dsh-subagent-acp']).toBe('0.1.1-rc.2')
    expect(patch).toContain('id: pangea-product-shell')
    expect(patch).toContain('name: dsh-pangea-product')
    expect(patch).not.toContain('id: pangea-jobs-local')
    expect(patch).not.toContain('id: pangea-subagent')
    expect(patch).not.toContain('id: pangea-subprocess-local')
    expect(patch).not.toContain("name: '@deepseek-ai/dsh-subagent-acp'")
    expect(client).toContain('Product navigation and first-launch affordances are rendered by dsh-pangea')
    expect(client).not.toContain('MutationObserver')
    expect(client).not.toContain('createSettingsButton')
    execFileSync(process.execPath, ['--check', productClient])
  })

  it('portals internal model settings to document.body instead of the DSH layout pane', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('data-pangea-model-settings-overlay')
    expect(client).toContain('id: "pangea-model-settings"')
    expect(client).toContain('name: "shell.overlay"')
    expect(client).toContain('const pangea_react_dom = require("react-dom")')
    expect(client).toContain('pangea_react_dom.createPortal')
    expect(client).toContain('document.body)')
    expect(client).toContain('width: "min(1040px, calc(100vw - 48px))"')
  })

  it('exposes only DSH internal custom-provider create/edit surfaces', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('function PangeaInternalModelSettings(props)')
    expect(client).toContain('row.entry.settingsNs === "llm-pi-ai" && row.entry.declared === true')
    expect(client).toContain('(0, react_jsx_runtime.jsx)(CustomProviderCard, {')
    expect(client).toContain('(0, react_jsx_runtime.jsx)(ProviderEditor, {')
    expect(client).not.toContain('children: (0, react_jsx_runtime.jsx)(ModelsSection, { ...props })')
  })

  it('publishes readiness based only on internal custom LLM routes', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('pangea:model-onboarding-state')
    expect(client).toContain('pangea:query-model-onboarding')
    expect(client).toContain('const customAvailable = state.namespaces.get("llm-pi-ai") !== void 0')
    expect(client).toContain('const internalRows = state.rows.filter((row) => row.entry.settingsNs === "llm-pi-ai" && row.entry.declared === true)')
    expect(client).toContain('!internalRows.some(providerUsable)')
  })

  it('wraps native DSH onboarding at registration while the PANGEA shell owns first launch', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('function PangeaAwareDeepSeekOnboardingDialog(props)')
    expect(client).toContain('document.body.hasAttribute("data-pangea-product-shell")')
    expect(client).toContain('}, PangeaAwareDeepSeekOnboardingDialog));')
  })
})
