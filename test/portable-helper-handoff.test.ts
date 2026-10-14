import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile }))
import { launchPortableHelper } from '../src/main/update/launch-portable-helper'

const roots: string[] = []
beforeEach(() => {
  execFile.mockReset()
  execFile.mockImplementation((_file, _args, _options, callback) => {
    queueMicrotask(() => callback(null, '', ''))
    return {}
  })
})
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'pangea-handoff-'))
  roots.push(root)
  const helper = path.join(root, 'helper.ps1')
  const plan = path.join(root, 'plan.json')
  await writeFile(helper, '# PANGEA_UPDATE_MONITOR_PROTOCOL=1\nparam([string]$PlanPath)\n')
  await writeFile(plan, JSON.stringify({ handoff_required: true }))
  return { root, helper, plan }
}
const ready = { schema_version: 1, ui_ready: true, worker_pid: 123, monitor_pid: 456 }
const options = { requireUiReady: true, timeoutMs: 250 }

describe('portable updater visible-window handoff', () => {
  it('releases the worker only after the visible monitor handshake', async () => {
    const f = await fixture()
    const launch = launchPortableHelper(f.helper, f.plan, { ...options, timeoutMs: 2000 })
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledOnce())
    expect(existsSync(`${f.plan}.continue`)).toBe(false)
    // Launching PowerShell by itself does not prove that the form opened.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(existsSync(`${f.plan}.continue`)).toBe(false)
    await writeFile(`${f.plan}.ready`, JSON.stringify(ready))
    await launch
    expect(existsSync(`${f.plan}.continue`)).toBe(true)
    expect(existsSync(`${f.plan}.cancel`)).toBe(false)
  })

  it('rejects a legacy worker-ready marker that does not prove a visible monitor exists', async () => {
    const f = await fixture()
    await writeFile(`${f.plan}.ready`, 'ready')
    await expect(launchPortableHelper(f.helper, f.plan, options)).rejects.toThrow()
    expect(existsSync(`${f.plan}.cancel`)).toBe(true)
    expect(existsSync(`${f.plan}.continue`)).toBe(false)
  })

  for (const marker of ['ui-error', 'startup-error']) {
    it(`preserves the old desktop when ${marker} is reported, even with a ready marker`, async () => {
      const f = await fixture()
      await writeFile(`${f.plan}.ready`, JSON.stringify(ready))
      await writeFile(`${f.plan}.${marker}`, 'fixture-monitor-startup-failed')
      await expect(launchPortableHelper(f.helper, f.plan, options)).rejects.toThrow()
      expect(existsSync(`${f.plan}.cancel`)).toBe(true)
      expect(existsSync(`${f.plan}.continue`)).toBe(false)
    })
  }

  for (const invalid of [
    { ...ready, ui_ready: false },
    { ...ready, worker_pid: 0 },
    { ...ready, monitor_pid: 0 },
    { ...ready, schema_version: 2 }
  ]) {
    it(`does not accept an incomplete handshake ${JSON.stringify(invalid)}`, async () => {
      const f = await fixture()
      await writeFile(`${f.plan}.ready`, JSON.stringify(invalid))
      await expect(launchPortableHelper(f.helper, f.plan, options)).rejects.toThrow()
      expect(existsSync(`${f.plan}.cancel`)).toBe(true)
      expect(existsSync(`${f.plan}.continue`)).toBe(false)
    })
  }

  it('writes cancellation on timeout and includes a recoverable diagnostic location', async () => {
    const f = await fixture()
    await expect(launchPortableHelper(f.helper, f.plan, options)).rejects.toThrow(f.root)
    expect(existsSync(`${f.plan}.cancel`)).toBe(true)
    expect(existsSync(`${f.plan}.continue`)).toBe(false)
  })

  it('cancels when PowerShell could not be launched', async () => {
    const f = await fixture()
    execFile.mockImplementation((_file, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error('fixture process creation failed'), '', ''))
      return {}
    })
    await expect(launchPortableHelper(f.helper, f.plan, options)).rejects.toThrow(/fixture process creation failed/)
    expect(existsSync(`${f.plan}.cancel`)).toBe(true)
    expect(existsSync(`${f.plan}.continue`)).toBe(false)
  })

  it('rejects a helper without the cancellation protocol before starting it', async () => {
    const f = await fixture()
    await writeFile(f.helper, 'param([string]$PlanPath)\n# old helper\n')
    await expect(launchPortableHelper(f.helper, f.plan, options)).rejects.toThrow()
    expect(execFile).not.toHaveBeenCalled()
    expect(existsSync(`${f.plan}.continue`)).toBe(false)
    expect(await readFile(f.plan, 'utf8')).toBe(JSON.stringify({ handoff_required: true }))
  })
})
