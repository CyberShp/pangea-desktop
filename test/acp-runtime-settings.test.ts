import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withAcpRuntimeEnvironment } from '../src/main/runtime/acp-runtime-settings'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('external Agent runtime environment', () => {
  it('resolves configured Windows commands through the injected PowerShell boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pangea-acp-runtime-'))
    roots.push(root)
    const directory = join(root, 'dsh-pangea-companion')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'acp-runtime-v1.json'),
      JSON.stringify({
        version: 1,
        providers: {
          'pangea-opencode': {
            command: 'opencode-custom',
            args: ['acp'],
            models: [{ id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', efforts: ['high'] }]
          }
        }
      })
    )
    const resolver = vi.fn((command: string) => ({
      command: `C:\\Tools\\${command}.exe`,
      version: `${command} 2.0`
    }))

    const environment = withAcpRuntimeEnvironment(root, { Path: 'C:\\Windows' }, 'win32', resolver)
    const config = JSON.parse(environment.PANGEA_ACP_RUNTIME_CONFIG ?? '{}')

    expect(resolver).toHaveBeenCalledTimes(3)
    expect(config.providers['pangea-opencode']).toMatchObject({
      command: 'opencode-custom',
      resolved_command: 'C:\\Tools\\opencode-custom.exe',
      version: 'opencode-custom 2.0',
      available: true,
      resolution_status: 'resolved',
      models: [{ id: 'gpt-5.2-codex', efforts: ['high'] }]
    })
    expect(config.providers['pangea-claude-code']).toMatchObject({
      available: true,
      resolution_status: 'built-in'
    })
  })

  it('marks a missing command unavailable instead of registering a broken fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pangea-acp-runtime-missing-'))
    roots.push(root)
    const environment = withAcpRuntimeEnvironment(root, {}, 'win32', (command) => {
      if (command === 'nga') throw new Error('Get-Command: nga was not found')
      return { command: `C:\\Tools\\${command}.exe` }
    })
    const config = JSON.parse(environment.PANGEA_ACP_RUNTIME_CONFIG ?? '{}')
    expect(config.providers['pangea-nga']).toMatchObject({
      available: false,
      resolution_status: 'error',
      resolution_error: 'Get-Command: nga was not found'
    })
  })
})
