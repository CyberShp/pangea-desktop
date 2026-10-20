import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assertPackageStagingSpace, copyAndHashPackage } from '../src/main/update/portable-package-io'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pangea-package-io-'))
  roots.push(root)
  return { source: join(root, 'source.zip'), destination: join(root, 'staged.zip') }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('checks staging volume before copying and leaves no output when space is insufficient', async () => {
  const { source, destination } = await fixture()
  await writeFile(source, 'payload')
  await expect(copyAndHashPackage(source, destination, Number.MAX_SAFE_INTEGER, () => {})).rejects.toThrow('空间不足')
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(assertPackageStagingSpace(destination, 7)).resolves.toBeUndefined()
})

it('hashes copied bytes and rejects files that changed size since selection', async () => {
  const { source, destination } = await fixture()
  const payload = Buffer.from('signed package fixture')
  await writeFile(source, payload)
  await expect(copyAndHashPackage(source, destination, payload.length, () => {}))
    .resolves.toBe(createHash('sha256').update(payload).digest('hex'))
  expect(await readFile(destination)).toEqual(payload)
  await expect(copyAndHashPackage(source, `${destination}.short`, payload.length + 1, () => {})).rejects.toThrow('发生变化')
  await expect(copyAndHashPackage(source, `${destination}.long`, payload.length - 1, () => {})).rejects.toThrow('发生变化')
})

it('terminates a timed out copy instead of leaving a background writer', async () => {
  const { source, destination } = await fixture()
  const bytes = Buffer.alloc(8 * 1024 * 1024, 42)
  await writeFile(source, bytes)
  await expect(copyAndHashPackage(source, destination, bytes.length, () => {}, { totalMs: 0 })).rejects.toThrow('已停止导入')
  const first = await readFile(destination).catch(() => Buffer.alloc(0))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(await readFile(destination).catch(() => Buffer.alloc(0))).toEqual(first)
})

it('propagates progress consumer failures through pipeline and leaves no writer running', async () => {
  const { source, destination } = await fixture()
  await writeFile(source, Buffer.alloc(512 * 1024, 42))
  await expect(copyAndHashPackage(source, destination, 512 * 1024, () => { throw new Error('progress consumer failed') }))
    .rejects.toThrow('progress consumer failed')
  const first = await readFile(destination).catch(() => Buffer.alloc(0))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(await readFile(destination).catch(() => Buffer.alloc(0))).toEqual(first)
})
