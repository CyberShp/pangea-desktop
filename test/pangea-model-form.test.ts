import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'

const clientPath = process.env.PANGEA_MODEL_SETTINGS_TEST_CLIENT ?? 'node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js'

async function form(options: { readOnly?: boolean; key?: string; route?: string; taken?: string[] } = {}) {
  const source = await readFile(clientPath, 'utf8')
  const start = source.indexOf('function CustomProviderCard(props) {')
  const end = source.indexOf('\n\t\t}\n\t\t//#endregion', start)
  const body = source.slice(source.indexOf('{', start) + 1, end)
  const states: unknown[] = [7, options.route ?? 'test-route', 'Test route', 'https://example.invalid/v1', 'openai-completions', options.key ?? '', [{ id: 'test-model' }], '', false, undefined, false]
  let cursor = 0
  let taken = options.taken ?? []
  const react = { useState: () => {
    const index = cursor++
    return [states[index], (value: unknown) => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
  }, useEffect: (effect: () => void) => effect() }
  const jsx = { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) }
  const api = { settings: { mutate: vi.fn().mockResolvedValue({ result: { ok: true } }) }, credentials: { set: vi.fn().mockResolvedValue({ result: { ok: true } }) } }
  const onClose = vi.fn()
  const onValidationState = vi.fn()
  const compile = new Function('props', 'react', 'react_jsx_runtime', 'ROUTE_PATTERN', 'validateDeepSeekModels', 'apiKeyFailure', 'deriveKeyRef', 'NS$1', 'messageOf', 'ModelListEditor', 'EditorFooter', body)
  const render = () => {
    cursor = 0
    return compile({ revision: 7, taken, protocols: ['openai-completions'], api, t: (key: string) => key, readOnly: options.readOnly ?? false, onClose, onValidationState }, react, jsx, /^[a-z][a-z0-9-]*$/, () => undefined, () => undefined, (id: string) => id.toUpperCase() + '_API_KEY', 'llm-pi-ai', String, 'catalog', 'footer')
  }
  const find = (node: any, predicate: (node: any) => boolean): any => {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    const children = node.props?.children
    for (const child of Array.isArray(children) ? children : [children]) {
      const found = find(child, predicate)
      if (found) return found
    }
  }
  return { api, onClose, onValidationState, render, find, setTaken: (value: string[]) => { taken = value } }
}

describe('product model form contracts', () => {
  it('writes the profile against its opening revision and keeps the key in credentials', async () => {
    const { api, render, find, onClose } = await form({ key: 'test-only-key' })
    await find(render(), node => node.type === 'footer').props.onSubmit()
    expect(api.settings.mutate).toHaveBeenCalledWith(expect.objectContaining({ ns: 'llm-pi-ai', expectedRevision: 7 }))
    expect(JSON.stringify(api.settings.mutate.mock.calls)).not.toContain('test-only-key')
    expect(api.credentials.set).toHaveBeenCalledWith({ ref: 'TEST-ROUTE_API_KEY', value: 'test-only-key' })
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('locks profile fields and retries only credentials after their write fails', async () => {
    const { api, render, find, onClose, setTaken } = await form({ key: 'test-only-key' })
    api.credentials.set.mockResolvedValueOnce({ result: { ok: false, error: { message: 'credential unavailable' } } })
    await find(render(), node => node.type === 'footer').props.onSubmit()
    expect(onClose).not.toHaveBeenCalled()
    setTaken(['test-route'])
    const retry = render()
    expect(find(retry, node => node.type === 'div' && node.props.id === 'pangea-model-route-error')).toBeUndefined()
    expect(find(retry, node => node.type === 'input' && node.props.type === 'password').props.value).toBe('')
    expect(find(retry, node => node.type === 'input' && node.props['aria-label'] === 'customRoute').props.disabled).toBe(true)
    expect(find(retry, node => node.type === 'input' && node.props.type === 'password').props.disabled).toBe(false)
    expect(find(retry, node => node.type === 'button' && node.props.children === '重试保存密钥').props.disabled).toBe(true)
    find(retry, node => node.type === 'input' && node.props.type === 'password').props.onChange({ target: { value: 'test-only-retry-key' } })
    await find(render(), node => node.type === 'button' && node.props.children === '重试保存密钥').props.onClick()
    expect(api.settings.mutate).toHaveBeenCalledTimes(1)
    expect(api.credentials.set).toHaveBeenCalledTimes(2)
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('connects an invalid provider ID to its visible error summary and disables creation', async () => {
    const { render, find, onValidationState } = await form({ route: '9 gateway' })
    const tree = render()
    const route = find(tree, node => node.type === 'input' && node.props['aria-label'] === 'customRoute')
    expect(route.props['aria-invalid']).toBe(true)
    expect(route.props['aria-describedby']).toBe('pangea-model-route-error')
    const alert = find(tree, node => node.type === 'div' && node.props.id === 'pangea-model-route-error')
    expect(alert.props.role).toBe('alert')
    expect(find(alert, node => node.type === 'strong').props.children).toBe('请修正提供方 ID')
    expect(find(alert, node => node.type === 'p').props.children).toContain('小写字母开头')
    expect(find(tree, node => node.type === 'footer').props.submitDisabled).toBe(true)
    expect(onValidationState).toHaveBeenLastCalledWith(true)
  })

  it('disables profile, credentials, catalog and submission when the settings are read-only', async () => {
    const { render, find } = await form({ readOnly: true })
    const tree = render()
    for (const label of ['customRoute', 'customDisplayName', 'baseUrl', 'keyInput']) {
      expect(find(tree, node => node.type === 'input' && node.props['aria-label'] === label).props.disabled).toBe(true)
    }
    expect(find(tree, node => node.type === 'catalog').props.disabled).toBe(true)
    expect(find(tree, node => node.type === 'footer').props.submitDisabled).toBe(true)
  })

  it('keeps repeated dependency installation byte-identical', async () => {
    execFileSync(process.execPath, ['scripts/install-pangea-model-settings-entry.mjs'])
    const once = await readFile(clientPath, 'utf8')
    execFileSync(process.execPath, ['scripts/install-pangea-model-settings-entry.mjs'])
    expect(await readFile(clientPath, 'utf8')).toBe(once)
  })
})
