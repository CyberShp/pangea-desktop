import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'

describe('PANGEA model routes', () => {
  it('disables the built-in official adapter and starts without an implicit model', async () => {
    const rows = YAML.parse(await readFile('packages/dsh-pangea-product/cordis.patch.yml', 'utf8'))
    expect(rows.find((row: { id?: string }) => row.id === 'llm-deepseek')?.disabled).toBe(true)
    expect(rows.find((row: { id?: string }) => row.id === 'agent-default-model')?.config).toEqual({ provider: '', model: '' })
  })

  it('preserves a saved MiniMax default and does not revive a removed official selection', () => {
    const read = (value: object) => AgentDefaultModel.prototype.currentSelection.call({ source: () => value })
    expect(read({ provider: 'minimax-1', model: 'MiniMax-M2.7-highspeed' })).toEqual({ provider: 'minimax-1', model: 'MiniMax-M2.7-highspeed' })
    expect(read({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })).toEqual({ provider: '', model: '' })
    expect(read({ provider: '', model: '' })).toEqual({ provider: '', model: '' })
  })

  it('does not expose the auxiliary DeepSeek search API', async () => {
    const rows = YAML.parse(await readFile('packages/dsh-pangea-product/cordis.patch.yml', 'utf8'))
    expect(rows.find((row: { id?: string }) => row.id === 'web-search-deepseek')?.disabled).toBe(true)
    expect(rows.find((row: { id?: string }) => row.id === 'tool-web')?.config.search).toBe(false)
  })

  it('omits official API setup while retaining MiniMax and custom gateways', async () => {
    const client = await readFile('node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js', 'utf8')
    const source = client.match(/function pangeaModelProvider\(entry\) \{[\s\S]*?\n\t\t\}/)?.[0]
    expect(source).toBeDefined()
    const allowed = Function(`${source}; return pangeaModelProvider`)()
    expect(allowed({ provider: 'deepseek-official', settingsNs: 'llm-deepseek' })).toBe(false)
    expect(allowed({ provider: 'deepseek', settingsNs: 'llm-pi-ai' })).toBe(false)
    expect(allowed({ provider: 'minimax-cn', settingsNs: 'llm-pi-ai' })).toBe(true)
    expect(allowed({ provider: 'minimax-1', settingsNs: 'llm-pi-ai' })).toBe(true)
    expect(allowed({ provider: 'internal-gateway', settingsNs: 'llm-pi-ai' })).toBe(true)
    expect(client).toContain('providersResponse.result.value.providers.filter(pangeaModelProvider)')
  })
})
