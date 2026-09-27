import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

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
    expect(pkg.dependencies?.['@deepseek-ai/dsh-subagent-claude-code']).toBe('0.1.1-rc.2')
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

  it('keeps the advanced editor draft mounted while exposing its approved model-list actions', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('props.onAdvancedStateChange?.(customizedOpen)')
    expect(client).toContain('productAdvanced: customizedOpen && props.productPresentation === true && props.declared === true && family === "pi-ai"')
    expect(client).toContain('const credentialField = (0, react_jsx_runtime.jsxs)("div", {')
    expect(client).toContain('customizedOpen && props.productPresentation === true && props.declared === true && family === "pi-ai" ? null : credentialField')
    expect(client).toContain('customizedOpen && props.productPresentation === true && props.declared === true && family === "pi-ai" ? credentialField : null')
    expect(client).toContain('onAddModel: addModel')
    expect(client).toContain('props.productAdvanced === true ? (0, react_jsx_runtime.jsx)("p", { className: "pangea-model-advanced-note", children: "模型 ID 必须唯一。自定义接口至少需要一个模型。" }) : null')
    expect(client).toContain('className: advancedOpen ? "pangea-model-advanced-dialog" : void 0')
    expect(client).toContain('className: "dshProviderEditorStickyFooter pangea-model-advanced-footer"')
    expect(client).toContain('"aria-haspopup": "menu"')
    expect(client).toContain('role: "menuitem", onClick: () => { setActionsOpen(false); setSavedFilterOpen(true);')
    expect(client).toContain('props.onReset(); setActionsOpen(false);')
    expect(client).toContain('document.addEventListener("pointerdown", onPointerDown, true)')
    expect(client).toContain('event.key !== "Escape"')
    expect(client).toContain('requestAnimationFrame(() => actionsTriggerRef.current?.focus())')
    expect(client).toContain('expectedRevision')
  })

  it('uses DSH model settings with the product provider policy', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('function PangeaInternalModelSettings(props)')
    expect(client).toContain('return (0, react_jsx_runtime.jsx)(ModelsSection, { ...props });')
    expect(client).toContain('function ModelsSection(props)')
    expect(client).toContain('providersResponse.result.value.providers.filter(pangeaModelProvider)')
  })

  it('publishes readiness based on every usable DSH model route', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('pangea:model-onboarding-state')
    expect(client).toContain('pangea:query-model-onboarding')
    expect(client).toContain('const customAvailable = state.namespaces.get("llm-pi-ai") !== void 0')
    expect(client).toContain('const modelGroupsResponse = await props.api.llm.models(')
    expect(client).toContain('row.entry.active !== true')
    expect(client).toContain('detail: { required, modelAvailable, customAvailable, status, error, connections }')
  })

  it('matches readiness to active native and custom DSH provider routes used by PANGEA analysis', async () => {
    const client = await readFile(installedModelsClient, 'utf8')
    const body = client.match(/modelAvailable = state\.rows\.some\(row => \{([\s\S]*?)\n\s*\}\);/)
    if (!body?.[1]) throw new Error('Missing model readiness predicate')
    const hasUsableRoute = new Function('state', 'groupsById', 'process', `return state.rows.some(row => {${body[1]}});`) as (
      state: { rows: Array<{ apiKeyEnv?: string; credential?: { configured?: boolean }; entry: { settingsNs: string; declared?: boolean; active?: boolean; provider: string } }> },
      groupsById: Map<string, { models?: Array<{ id?: string }> }>,
      process: { env: Record<string, string | undefined> }
    ) => boolean
    const row = (overrides: Partial<{ apiKeyEnv: string; configured: boolean; namespace: string; declared: boolean; active: boolean; provider: string }> = {}) => ({
      apiKeyEnv: overrides.apiKeyEnv,
      credential: { configured: overrides.configured ?? true },
      entry: {
        settingsNs: overrides.namespace ?? 'llm-pi-ai',
        declared: overrides.declared ?? true,
        active: overrides.active ?? true,
        provider: overrides.provider ?? 'team-gateway'
      }
    })
    const route = new Map([['team-gateway', { models: [{ id: 'gpt-4.1-mini' }] }]])
    const env = { env: {} }

    expect(hasUsableRoute({ rows: [row({ namespace: 'llm-openai', declared: false, provider: 'openai' })] }, new Map([['openai', { models: [{ id: 'gpt-4.1-mini' }] }]]), env)).toBe(true)
    expect(hasUsableRoute({ rows: [row({ active: false })] }, route, env)).toBe(false)
    expect(hasUsableRoute({ rows: [row({ apiKeyEnv: 'TEAM_API_KEY', configured: false })] }, route, env)).toBe(false)
    expect(hasUsableRoute({ rows: [row({ apiKeyEnv: 'TEAM_API_KEY', configured: true })] }, route, env)).toBe(true)
    expect(hasUsableRoute({ rows: [row({ namespace: 'llm-custom' })] }, route, env)).toBe(true)
    expect(hasUsableRoute({ rows: [row({ provider: 'missing' })] }, route, env)).toBe(false)
    expect(hasUsableRoute({ rows: [row()] }, new Map([['team-gateway', { models: [{ id: '  ' }] }]]), env)).toBe(false)
    expect(hasUsableRoute({ rows: [row({ namespace: 'llm-openai', declared: false, provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY', configured: false })] }, new Map([['openai', { models: [{ id: 'gpt-4.1-mini' }] }]]), { env: {} })).toBe(false)
    expect(hasUsableRoute({ rows: [row({ apiKeyEnv: 'TEAM_API_KEY', configured: false })] }, route, { env: { TEAM_API_KEY: 'configured-in-runtime' } })).toBe(true)
  })

  it('changes the new-model dialog title to the confirmed field-validation state when the route is invalid', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('onValidationState: props.onValidationState')
    expect(client).toContain('onValidationState: setValidationError')
    expect(client).toContain('productTarget?.create && validationError ? "模型连接字段校验" : productTarget?.create ? "连接模型接口"')
    expect(client).toContain('"aria-label": conflictOpen ? "模型配置保存冲突" : state.status === "ready" && state.writable === false ? "模型设置只读" : state.status === "error" ? "模型设置加载失败"')
  })

  it('publishes model summary fields without forwarding profiles or credentials', async () => {
    const client = await readFile(installedModelsClient, 'utf8')
    const body = client.match(/const connections = state\.rows\.filter[\s\S]*?\n\s*\}\);/)
    if (!body?.[0]) throw new Error('Missing model summary projection')
    const projectConnections = new Function('state', 'props', 'providerUsable', `${body[0].replace(/^const connections = /, 'return ')};`) as (
      state: { rows: Array<Record<string, any>>; namespaces: Map<string, { value: unknown }> },
      props: { schema: { getPath(value: unknown, path: string[]): unknown } },
      providerUsable: (row: Record<string, any>) => boolean
    ) => Array<Record<string, unknown>>
    const profile = { models: [{ id: 'one' }, { id: 'two' }], apiKey: 'test-secret-never-publish' }
    const connections = projectConnections({ namespaces: new Map([['llm-pi-ai', { value: profile }]]), rows: [
      { configured: true, entry: { provider: 'custom', displayName: '团队接口', active: true, settingsNs: 'llm-pi-ai', settingsPath: [] } },
      { configured: false, entry: { provider: 'native', active: true, settingsNs: 'native', settingsPath: [] } },
      { configured: false, entry: { provider: 'unused', active: false, settingsNs: 'native', settingsPath: [] } }
    ] }, { schema: { getPath: (value: unknown) => value } }, (row: Record<string, any>) => row.entry.active)
    expect(connections).toMatchObject([
      { id: 'custom', name: '团队接口', modelCount: 2, usable: true },
      { id: 'native', name: 'native', modelCount: null, usable: true }
    ])
    expect(JSON.stringify(connections)).not.toContain('test-secret-never-publish')
  })

  it('opens product editor targets through native form components and preserves missing-adapter access', async () => {
    const client = await readFile(installedModelsClient, 'utf8')
    const body = client.match(/function PangeaInternalModelSettings\(props\) \{([\s\S]*?)\n\s*\}\n\s*function pangeaModelText/)
    if (!body?.[1]) throw new Error('Missing internal model settings body')
    const render = new Function('props', 'react', 'react_jsx_runtime', 'CustomProviderCard', 'ModelsSection', 'protocolChoices', 'renderProviderEditor', 'targetOf', body[1])
    const jsx = { jsx: (type: string, props: unknown) => ({ type, props }), jsxs: (type: string, props: unknown) => ({ type, props }) }
    const react = { useRef: () => ({ current: undefined }) }
    const state = { status: 'ready', writable: false, rows: [{ entry: { provider: 'native', settingsNs: 'native' } }], namespaces: new Map([['native', { ns: 'native', revision: 7 }]]) }
    const load = vi.fn().mockResolvedValue(undefined)
    const props = { useSnapshot: (select: (value: unknown) => unknown) => select(state), controller: { load }, onClose() {}, schema: {}, api: {}, t() {} }
    const dependencies = [react, jsx, 'create', 'directory', () => ['openai-completions'], (value: unknown) => ({ type: 'editor', props: value }), (row: { entry: unknown }) => row.entry]
    expect(render({ ...props, productTarget: { create: true } }, ...dependencies).props.className).toContain('pangea-model-overlay-unavailable')
    expect(render(props, ...dependencies).type).toBe('directory')
    const editor = render({ ...props, productTarget: { providerId: 'native' } }, ...dependencies)
    expect(editor.type).toBe('div')
    expect(editor.props.className).toContain('pangea-model-provider-edit')
    const summary = editor.props.children[0]
    const providerMark = summary.props.children[0].props.children[0]
    expect(providerMark.props.children).toBe('N')
    const providerEditor = editor.props.children[1]
    expect(providerEditor.type).toBe('editor')
    expect(providerEditor.props.readOnly).toBe(true)
    expect(providerEditor.props.productReadOnly).toBe(true)
    expect(providerEditor.props.productPresentation).toBe(true)
    expect(providerEditor.props.key).toBe('native:7')
    expect(providerEditor.props.namespace.revision).toBe(7)
    await providerEditor.props.onConflictReload()
    expect(load).toHaveBeenCalledOnce()
  })

  it('reloads a conflicting product editor into the current revision and exposes a read-only summary', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('onConflictReload: () => props.controller.load()')
    expect(client).toContain('key: `${props.productTarget?.providerId}:${String(owner.revision)}`')
    expect(client).toContain('className: "pangea-model-conflict-dialog"')
    expect(client).toContain('重新读取会放弃尚未应用的修改，并显示服务器当前值。')
    expect(client).toContain('if (props.productReadOnly === true)')
    expect(client).toContain('当前连接没有设置写入权限，你可以查看接口与模型配置。')
    expect(client).toContain('productTarget?.providerId ? "模型接入" : "模型与 API 设置"')
    expect(client).toContain('className: "pangea-model-provider-edit pangea-model-overlay-state"')
    expect(client).toContain('row.credential?.configured === true ? "API 密钥已配置"')
    expect(client).toContain('keyLocked ? t("keyEnvLocked")')
    expect(client).toContain('disabled: disabled || keyLocked')
  })

  it('renders read-only model data without editable controls or a save action', async () => {
    const client = await readFile(installedModelsClient, 'utf8')
    const start = client.indexOf('function ProviderEditor(props) {')
    const end = client.indexOf('\n\t\t}\n\t\t//#endregion', start)
    const body = client.slice(client.indexOf('{', start) + 1, end)
    const compile = new Function('props', 'react', 'react_jsx_runtime', 'draftAt', 'layoutOf', 'refFor', 'protocolChoices', 'validateDeepSeekModels', 'apiKeyFailure', 'textOf', body)
    const jsx = { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) }
    const profile = { baseURL: 'https://models.example.com/v1', api: 'openai-completions', models: [{ id: 'analysis-model' }, { id: 'review-model' }] }
    const schema = {
      getPath: (value: any, path: string[]) => path.length ? value?.[path[0]!] : value,
      rehydrate: () => ({}),
      nodeAtPath: () => ({})
    }
    const props = {
      namespace: { ns: 'llm-pi-ai', revision: 8, schema: {}, user: profile, value: profile },
      schema, settingsPath: [], provider: 'team-gateway', displayName: '团队模型网关',
      api: { credentials: { describe: vi.fn() } }, t: (key: string) => key,
      productReadOnly: true, onClose: vi.fn()
    }
    const react = { useState: (initial: unknown) => [typeof initial === 'function' ? (initial as () => unknown)() : initial, vi.fn()], useMemo: (factory: () => unknown) => factory(), useEffect() {} }
    const tree = compile(props, react, jsx, () => ({}), () => 'pi-ai', () => 'TEAM_GATEWAY_API_KEY', () => [], () => undefined, () => undefined, (model: any, key: string) => model?.[key])
    const nodes: any[] = []
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return
      nodes.push(node)
      const children = node.props?.children
      for (const child of Array.isArray(children) ? children : [children]) visit(child)
    }
    visit(tree)
    const text = nodes.map(node => node.props?.children).filter(value => typeof value === 'string').join(' ')
    expect(text).toContain('当前配置只读')
    expect(text).toContain('https://models.example.com/v1')
    expect(text).toContain('openai-completions')
    expect(text).toContain('analysis-model')
    expect(text).toContain('review-model')
    expect(nodes.some(node => ['input', 'select', 'textarea'].includes(node.type))).toBe(false)
    expect(nodes.some(node => node.type === 'footer')).toBe(false)
    expect(nodes.find(node => node.type === 'button')?.props.children).toBe('关闭')
  })

  it('gates the native directory while loading and renders retryable load failures', async () => {
    const client = await readFile(installedModelsClient, 'utf8')
    const body = client.match(/function PangeaInternalModelSettings\(props\) \{([\s\S]*?)\n\s*\}\n\s*function pangeaModelText/)?.[1]
    expect(body).toBeDefined()
    const render = new Function('props', 'react', 'react_jsx_runtime', 'CustomProviderCard', 'ModelsSection', 'protocolChoices', 'renderProviderEditor', 'targetOf', 'requestAnimationFrame', 'window', 'CustomEvent', body!)
    const jsx = { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) }
    const lastReadyRef = { current: undefined as any }
    const react = { useRef: () => lastReadyRef }
    const find = (node: any, predicate: (node: any) => boolean): any => {
      if (!node || typeof node !== 'object') return undefined
      if (predicate(node)) return node
      const children = node.props?.children
      for (const child of Array.isArray(children) ? children : [children]) {
        const found = find(child, predicate)
        if (found) return found
      }
    }
    const makeProps = (state: any, productTarget?: unknown, onClose = vi.fn()) => ({
      useSnapshot: (select: (value: unknown) => unknown) => select(state),
      controller: { load: vi.fn().mockResolvedValue(undefined) }, schema: {}, api: {}, t: (key: string) => key, productTarget, onClose
    })
    const dependencies = [react, jsx, 'create', 'directory', () => [], () => ({ type: 'editor' }), (row: any) => row.entry, () => undefined, { dispatchEvent() {} }, class {}]
    const loading = render(makeProps({ status: 'loading', namespaces: new Map(), rows: [] }), ...dependencies)
    expect(loading.props.role).toBe('status')
    expect(loading.props['aria-busy']).toBe('true')
    expect(find(loading, node => node.type === 'input')).toBeUndefined()
    expect(find(loading, node => node.props?.children === '关闭')).toBeDefined()

    const createTarget = { create: true }
    const beforeRefresh = render(makeProps({
      status: 'ready', writable: true,
      namespaces: new Map([['llm-pi-ai', { ns: 'llm-pi-ai', revision: 1 }]]), rows: []
    }, createTarget), ...dependencies)
    expect(beforeRefresh.type).toBe('create')
    expect(beforeRefresh.props.revision).toBe(1)
    const committedCreateDuringRefresh = render(makeProps({ status: 'loading', namespaces: new Map(), rows: [] }, createTarget), ...dependencies)
    expect(committedCreateDuringRefresh.type).toBe('create')
    expect(committedCreateDuringRefresh.props.revision).toBe(1)

    let scheduled: (() => void) | undefined
    let dispatched: { options: { detail: unknown } } | undefined
    const onClose = vi.fn()
    const target = { providerId: 'native-route' }
    const error = render(makeProps({ status: 'error', error: 'settings service unavailable', namespaces: new Map(), rows: [] }, target, onClose),
      react, jsx, 'create', 'directory', () => [], () => ({ type: 'editor' }), (row: any) => row.entry,
      (callback: () => void) => { scheduled = callback }, { dispatchEvent: (event: { options: { detail: unknown } }) => { dispatched = event } }, class { constructor(public type: string, public options: unknown) {} })
    expect(error.props.role).toBe('alert')
    expect(find(error, node => node.props?.children === 'settings service unavailable')).toBeDefined()
    find(error, node => node.type === 'button' && node.props.children === '重新打开').props.onClick()
    expect(onClose).toHaveBeenCalledOnce()
    scheduled?.()
    expect(dispatched?.options.detail).toBe(target)
  })

  it('reports a missing custom adapter only for its create target and preserves the full native directory', async () => {
    const client = await readFile(installedModelsClient, 'utf8')
    const body = client.match(/function PangeaInternalModelSettings\(props\) \{([\s\S]*?)\n\s*\}\n\s*function pangeaModelText/)?.[1]
    expect(body).toBeDefined()
    const render = new Function('props', 'react', 'react_jsx_runtime', 'CustomProviderCard', 'ModelsSection', 'protocolChoices', 'renderProviderEditor', 'targetOf', body!)
    const jsx = { jsx: (type: string, props: unknown) => ({ type, props }), jsxs: (type: string, props: unknown) => ({ type, props }) }
    const react = { useRef: () => ({ current: undefined }) }
    const state = { status: 'ready', writable: true, rows: [{ entry: { provider: 'native', settingsNs: 'native' } }], namespaces: new Map() }
    const props = { useSnapshot: (select: (value: unknown) => unknown) => select(state), controller: { load() {} }, onClose() {}, schema: {}, api: {}, t() {} }
    const deps = [react, jsx, 'create', 'directory', () => [], () => ({ type: 'editor' }), (row: any) => row.entry]
    const unavailable = render({ ...props, productTarget: { create: true } }, ...deps)
    expect(unavailable.props.className).toContain('pangea-model-overlay-unavailable')
    expect(unavailable.props.children.map((node: any) => node.props?.children).join(' ')).toContain('当前适配器不支持内部自定义模型')
    expect(render(props, ...deps).type).toBe('directory')
  })

  it('retries a failed model settings load only on a closed-to-open transition', async () => {
    const client = await readFile(installedModelsClient, 'utf8')
    const helper = client.match(/function shouldReloadModelSettingsAfterOpen\(wasOpen, isOpen, status\) \{[^}]+\}/)?.[0]
    expect(helper).toBeDefined()
    const shouldReload = new Function(`${helper}; return shouldReloadModelSettingsAfterOpen`)() as (wasOpen: boolean, isOpen: boolean, status: string) => boolean
    expect(shouldReload(false, true, 'error')).toBe(true)
    expect(shouldReload(false, true, 'loading')).toBe(false)
    expect(shouldReload(true, true, 'error')).toBe(false)
    expect(shouldReload(false, false, 'error')).toBe(false)
    expect(client).toContain('if (reopenedAfterFailure) void props.controller.load();')
  })

  it('restores the model directory trigger after closing the product editor', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('modelSettingsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null')
    expect(client).toContain('if (open || !modelSettingsReturnFocus.current) return;')
    expect(client).toContain('trigger.isConnected && !trigger.closest("[inert]")')
    expect(client).toContain('if (event.key !== "Escape" || event.defaultPrevented) return;')
  })

  it('wraps native DSH onboarding at registration while the PANGEA shell owns first launch', async () => {
    const client = await readFile(installedModelsClient, 'utf8')

    expect(client).toContain('function PangeaAwareDeepSeekOnboardingDialog(props)')
    expect(client).toContain('document.body.hasAttribute("data-pangea-product-shell")')
    expect(client).toContain('}, PangeaAwareDeepSeekOnboardingDialog));')
  })
})
