import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StagedPortablePackage } from '../src/main/update/portable-package-validator'
import type { StagedPortablePatch } from '../src/main/update/portable-patch-validator'
import { stageUpdateHelper } from '../src/main/update/stage-update-helper'

const { open } = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('unzipper', () => ({ default: { Open: { file: open } } }))
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.resetAllMocks() })
const helper = 'resources/update/apply-portable-update.ps1'
const bytes = Buffer.from('# new verified updater')
const file = { path: helper, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
async function fixture(kind: 'full' | 'patch', changed = true) {
  const root = await mkdtemp(join(tmpdir(), 'pangea-helper-')); roots.push(root)
  const installed = join(root, 'old.ps1'), destination = join(root, 'new.ps1')
  await writeFile(installed, changed ? '# old updater' : bytes)
  open.mockResolvedValue({ files: [{ path: (kind === 'patch' ? 'payload/' : '') + helper,
    type: 'File', uncompressedSize: bytes.length, stream: () => Readable.from([bytes]) }] })
  const staged = { kind, packagePath: join(root, 'verified.zip'), manifest: { files: changed ? [file] : [] },
    targetManifest: { files: [file] } } as unknown as StagedPortablePackage | StagedPortablePatch
  return { staged, installed, destination }
}
describe('signed target updater selection', () => {
  for (const kind of ['full', 'patch'] as const) it(`uses the verified new updater from a ${kind} package`, async () => {
    const f = await fixture(kind)
    await stageUpdateHelper(f.staged, f.installed, f.destination)
    expect(await readFile(f.destination)).toEqual(bytes)
    expect(await readFile(f.installed, 'utf8')).toBe('# old updater')
  })
  it('uses an unchanged installed helper only when its target hash matches', async () => {
    const f = await fixture('patch', false)
    await stageUpdateHelper(f.staged, f.installed, f.destination)
    expect(open).not.toHaveBeenCalled()
    expect(await readFile(f.destination)).toEqual(bytes)
    await rm(f.destination)
    await writeFile(f.installed, '# tampered helper')
    await expect(stageUpdateHelper(f.staged, f.installed, f.destination)).rejects.toThrow(/校验失败/)
  })
  it('rejects altered bytes even if the archive reports the signed size', async () => {
    const f = await fixture('full')
    open.mockResolvedValue({ files: [{ path: helper, type: 'File', uncompressedSize: bytes.length,
      stream: () => Readable.from([Buffer.alloc(bytes.length)]) }] })
    await expect(stageUpdateHelper(f.staged, f.installed, f.destination)).rejects.toThrow(/校验失败/)
    await expect(readFile(f.destination)).rejects.toThrow()
  })
  it('rejects duplicate helper entries and never falls back to the old updater', async () => {
    const f = await fixture('full')
    const entry = { path: helper, type: 'File', uncompressedSize: bytes.length }
    open.mockResolvedValue({ files: [entry, entry] })
    await expect(stageUpdateHelper(f.staged, f.installed, f.destination)).rejects.toThrow(/条目无效/)
  })
})
