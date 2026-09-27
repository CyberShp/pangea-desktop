import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { patchPath, projectRoot } from './patch-path'

const settingsModelsClient = path.join(
  projectRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-settings-models',
  'lib',
  'client.js'
)

interface ModelRow {
  id?: string
  name?: string
}

async function loadSearch(): Promise<
  (models: ModelRow[], query: string) => Array<{ model: ModelRow; index: number }>
> {
  const client = await readFile(settingsModelsClient, 'utf8')
  const source = client.match(
    /function searchableModelEntries\(models, query\) \{[\s\S]*?\n\t\t\}/
  )?.[0]

  expect(source).toBeDefined()
  return Function(`${source}; return searchableModelEntries`)() as (
    models: ModelRow[],
    query: string
  ) => Array<{ model: ModelRow; index: number }>
}

function customProviderCardSource(client: string): string {
  const start = client.indexOf('function CustomProviderCard(props) {')
  const end = client.indexOf('\n\t\t//#endregion', start)

  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return client.slice(start, end)
}

describe('settings model catalog search', () => {
  const models: ModelRow[] = [
    { id: 'qwen3.8-max', name: 'Qwen Max' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'openai/gpt-5.6-luna', name: 'Luna' }
  ]

  it('matches model ids and display names while preserving source indexes', async () => {
    const search = await loadSearch()

    expect(search(models, 'MAX')).toEqual([{ model: models[0]!, index: 0 }])
    expect(search(models, 'deepseek-v4')).toEqual([
      { model: models[1]!, index: 1 }
    ])
    expect(search(models, 'luna')).toEqual([{ model: models[2]!, index: 2 }])
    expect(search(models, 'missing')).toEqual([])
  })

  it('keeps every row and index when the query is blank', async () => {
    const search = await loadSearch()

    expect(search(models, '  ')).toEqual(
      models.map((model, index) => ({ model, index }))
    )
  })

  it('uses the shared search in both adapter catalog editors', async () => {
    const client = await readFile(settingsModelsClient, 'utf8')

    expect(client.match(/jsx\)\(ModelCatalogSearch, \{\s*value: props\.modelQuery/g)).toHaveLength(2)
    expect(client.match(/visibleModels\.map\(\(\{ model, index \}\)/g)).toHaveLength(2)
    expect(client).toContain('modelSearch: "Search models"')
    expect(client).toContain('modelSearch: "搜索模型"')
    expect(client).toContain('modelSearchEmpty: "没有找到匹配的模型。"')
  })

  it('provides search state when the custom-provider form renders its model editor', async () => {
    const client = await readFile(settingsModelsClient, 'utf8')
    const customProviderCard = customProviderCardSource(client)

    expect(customProviderCard).toContain(
      'const [modelQuery, setModelQuery] = (0, react.useState)("")'
    )
    expect(customProviderCard).toMatch(
      /jsx\)\(ModelListEditor, \{[\s\S]*?modelQuery,[\s\S]*?onModelQueryChange: setModelQuery/
    )
  })

  it('keeps an add-model action in the custom-provider creation form', async () => {
    const client = await readFile(settingsModelsClient, 'utf8')
    const customProviderCard = customProviderCardSource(client)

    expect(customProviderCard).toContain(
      'setModels((current) => [...current.map((model) => ({ ...model })), { id: "" }])'
    )
    expect(customProviderCard).toContain('setModelQuery("")')
    expect(customProviderCard).toContain(
      'className: "pangea-model-add"'
    )
    expect(customProviderCard).toContain(
      'className: "pangea-model-footer"'
    )
    expect(customProviderCard).toContain('disabled: profileDisabled')
    expect(customProviderCard).toContain('onClick: addModel')
    expect(customProviderCard).toContain('jsx)(EditorFooter, {')
    expect(customProviderCard.match(/onClick: addModel/g)).toHaveLength(1)
  })
})

describe('settings model discovery states', () => {
  it('preselects only discovered models already present in the active draft', async () => {
    const client = await readFile(settingsModelsClient, 'utf8')
    const selectionSource = client.match(
      /function pangeaModelCandidateSelection\(models, candidates\) \{[\s\S]*?\n\t\t\}/
    )?.[0]
    expect(selectionSource).toBeDefined()
    const select = new Function(
      'textOf',
      `${selectionSource}; return pangeaModelCandidateSelection`
    )((model: ModelRow, key: string) => model[key as keyof ModelRow]) as (
      models: ModelRow[], candidates: ModelRow[]
    ) => Set<string>
    const draft = [
      { id: 'analysis-model', name: '分析模型' },
      { id: 'review-model', name: '复核模型' }
    ]
    const discovered = [
      { id: 'analysis-model' },
      { id: 'review-model' },
      { id: 'fast-model' }
    ]

    expect([...select(draft, discovered)]).toEqual([
      'analysis-model',
      'review-model'
    ])
  })

  it('filters candidate rows without changing picks and merges existing model drafts by ID', async () => {
    const client = await readFile(settingsModelsClient, 'utf8')
    const filterSource = client.match(/function filterPangeaModelCandidates\(candidates, query\) \{[\s\S]*?\n\t\t\}/)?.[0]
    const adoptSource = client.match(/function adopt\(candidate\) \{[\s\S]*?\n\t\t\}/)?.[0]
    const mergeSource = client.match(/function mergePangeaModelCandidates\(models, candidates, picked\) \{[\s\S]*?\n\t\t\}/)?.[0]
    expect(filterSource).toBeDefined()
    expect(adoptSource).toBeDefined()
    expect(mergeSource).toBeDefined()
    const filter = new Function(`${filterSource}; return filterPangeaModelCandidates`)() as (
      candidates: Array<{ id: string; name?: string }>, query: string
    ) => Array<{ id: string; name?: string }>
    const merge = new Function(`${adoptSource}; ${mergeSource}; return mergePangeaModelCandidates`)() as (
      models: Array<Record<string, unknown>>,
      candidates: Array<Record<string, unknown>>,
      picked: Set<string>
    ) => Array<Record<string, unknown>>
    const candidates = [
      { id: 'analysis-model', name: 'Analysis' },
      { id: 'fast-model', name: 'Fast review' }
    ]
    const picked = new Set(['analysis-model'])
    expect(filter(candidates, 'FAST')).toEqual([candidates[1]])
    expect(filter(candidates, 'analysis-model')).toEqual([candidates[0]])
    expect(filter(candidates, '  ')).toEqual(candidates)
    expect([...picked]).toEqual(['analysis-model'])

    const existing = { id: 'analysis-model', name: 'Local name', contextWindow: 8192, input: ['text', 'image'] }
    const merged = merge([existing], [...candidates, { id: 'unused-model', contextWindow: 2048 }], picked)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toBe(existing)
    expect(merged[0]).toMatchObject({ name: 'Local name', contextWindow: 8192, input: ['text', 'image'] })
    expect(merge([existing], candidates, new Set(['fast-model']))).toMatchObject([
      existing,
      { id: 'fast-model', name: 'Fast review' }
    ])
  })

  it('renders distinct empty and error dialogs with draft-local recovery actions', async () => {
    const client = await readFile(settingsModelsClient, 'utf8')
    const modelListEditor = client.slice(client.indexOf('function ModelListEditor(props) {'), client.indexOf('\n\t\t}\n\t\t//#endregion', client.indexOf('function ModelListEditor(props) {')))
    const queryStateDialog = modelListEditor.slice(
      modelListEditor.indexOf('title: failure === t("fetchEmpty")'),
      modelListEditor.indexOf('open: candidates !== void 0,')
    )
    expect(modelListEditor).toContain('className: "pangea-model-query-state-dialog"')
    expect(modelListEditor).toContain('failure === t("fetchEmpty") ? "接口未返回模型" : "模型查询失败"')
    expect(queryStateDialog).toContain('description: "内部模型设置 · 本地自定义模型接口"')
    expect(modelListEditor).toContain('onClick: addManualModel')
    expect(modelListEditor).toContain('className: "pangea-model-query-empty-icon"')
    expect(modelListEditor).toContain('const firstAction = document.querySelector(".pangea-model-query-state-dialog button:not([disabled])")')
    expect(modelListEditor).toContain('else setFailure(void 0)')
    expect(modelListEditor).toContain('onClick: () => { void fetchModels(); }')
    expect(modelListEditor).toContain('className: "pangea-model-query-error-notice"')
    expect(modelListEditor).toContain('children: "无法获取接口模型列表"')
    expect(modelListEditor).toContain('children: "接口未返回可识别的模型目录。请核对地址与协议，也可以手动维护模型列表。"')
    expect(modelListEditor).toContain('className: "pangea-model-query-error-url", children: probe.baseURL || "—"')
    expect(modelListEditor).not.toContain('children: probe.api || "—"')
    expect(modelListEditor).toContain('value: candidateQuery, onChange: setCandidateQuery, placeholder: "搜索模型 ID 或名称"')
    expect(modelListEditor).toContain('title: "选择接口模型"')
    expect(modelListEditor).toContain('description: "内部模型设置 · 本地自定义模型接口"')
    expect(modelListEditor).toContain('className: "pangea-model-candidate-dialog"')
    expect(modelListEditor).toContain('activeCandidates.length, " 个条目"')
    expect(modelListEditor).toContain('["已选 ", picked.size, " 个"]')
    expect(modelListEditor).toContain('className: "pangea-model-candidate-table-head"')
    expect(modelListEditor).toContain('className: "pangea-model-candidate-note"')
    expect(modelListEditor).toContain('onClick: adoptPicked')
    expect(modelListEditor).toContain('children: visibleCandidates.map((candidate) =>')
    expect(modelListEditor).toContain('candidateReturnFocus.current = event.currentTarget')
    expect(modelListEditor).toContain('const trapCandidateDialogFocus = event =>')
    expect(modelListEditor).toContain('document.querySelector(".pangea-model-candidate-dialog .dshModelCatalogSearch input")?.focus()')
    expect(modelListEditor).toContain('if (event.key === "Escape")')
    expect(modelListEditor).toContain('event.shiftKey && (active === first || !dialog.contains(active))')
    expect(modelListEditor).toContain('active === last || !dialog.contains(active)')
    expect(modelListEditor).toContain('trigger.focus()')
  })
})

describe('settings provider editor sticky actions', () => {
  it('only freezes add, cancel, and submit while custom settings are expanded', async () => {
    const client = await readFile(settingsModelsClient, 'utf8')

    expect(client).toContain('.dshProviderEditorStickyFooter{')
    expect(client).toContain('position:sticky;bottom:-24px')
    expect(client).toContain(
      '.dshProviderEditorExpanded .zGbnIq_customizedBody{padding-bottom:72px}'
    )
    expect(client).toContain('" dshProviderEditorExpanded"')
    expect(client).toContain(
      'props.credentialOnly === true || !customizedOpen || layout === "unknown"'
    )
    expect(client).toContain('className: "dshProviderEditorStickyFooter"')
    expect(client).toContain('onClick: addModel')
    expect(client).toContain('jsx)(EditorFooter, { ...footerProps })')
  })

  it('captures search and sticky actions in the reproducible package patch', async () => {
    const patch = await readFile(
      patchPath('@deepseek-ai/dsh-client-ui-settings-models'),
      'utf8'
    )

    expect(patch).toContain('function searchableModelEntries(models, query)')
    expect(patch).toContain('ModelCatalogSearch')
    expect(patch).toContain(
      'const [modelQuery, setModelQuery] = (0, react.useState)("")'
    )
    expect(patch).toContain('onModelQueryChange: setModelQuery')
    expect(patch).toContain('dshProviderEditorStickyFooter')
    expect(patch).toContain('onClick: addModel')
    expect(patch).toContain(
      'setModels((current) => [...current.map((model) => ({ ...model })), { id: "" }])'
    )
    expect(patch).toContain(
      'className: ModelsSection_module_css_default["addModelButton"]'
    )
  })
})
