import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('external Agent provider patches', () => {
  it('applies ACP model and effort through session config before prompting', async () => {
    const patch = await readFile(
      join(process.cwd(), 'patches', '@deepseek-ai+dsh-subagent-acp+0.1.1-rc.2.patch'),
      'utf8'
    )
    expect(patch).toContain('setSessionConfigOption')
    expect(patch).toContain('["model", agentOptions?.model')
    expect(patch).toContain('["thought_level", agentOptions?.reasoningEffort')
    expect(patch).toContain('processId: child.pid')
    expect(patch).toContain('readOutput()')
    const installed = await readFile(
      join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-subagent-acp', 'lib', 'index.js'),
      'utf8'
    )
    expect(installed.indexOf('await applyRequestedSessionConfig')).toBeLessThan(installed.indexOf('await conn.prompt'))
  })

  it('passes Claude model and effort to the official SDK and exposes its process id', async () => {
    const patch = await readFile(
      join(process.cwd(), 'patches', '@deepseek-ai+dsh-subagent-claude-code+0.1.1-rc.2.patch'),
      'utf8'
    )
    expect(patch).toContain('{ model: spec.model }')
    expect(patch).toContain('{ effort: spec.reasoningEffort }')
    expect(patch).toContain('request.agentOptions?.model')
    expect(patch).toContain('run.processId = publishedChild.pid')
  })
})
