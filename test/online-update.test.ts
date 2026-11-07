import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OnlineUpdateDownloader } from '../src/main/update/online-update'
const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
function fixture(fetcher: any) {
  const bytes = Buffer.from('signed package bytes')
  const update = { version: '2.1.19', releaseId: 0, asset: { name: 'pangea-desktop.zip', size: bytes.length, state: 'uploaded', browser_download_url: 'https://updates.example/package' }, sha256: createHash('sha256').update(bytes).digest('hex') }
  return { bytes, update, client: new OnlineUpdateDownloader(fetcher, new AbortController().signal, 'https://updates.example') }
}
it.each(['corrupt', 'short', 'oversized', 'redirect'])('removes failed download after %s', async mode => {
  const fetcher = vi.fn(async () => mode === 'redirect' ? new Response(null, { status: 302, headers: { location: 'https://github.com/package' } }) : new Response(mode === 'short' ? 'a' : mode === 'oversized' ? Buffer.alloc(100) : Buffer.alloc(20)))
  const f = fixture(fetcher)
  const root = await mkdtemp(join(tmpdir(), 'online-')); roots.push(root)
  const destination = join(root, 'package.zip')
  await expect(f.client.download(f.update, destination, () => {})).rejects.toThrow()
  await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('follows same-origin redirects and verifies streamed download', async () => {
  const fetcher = vi.fn()
  const f = fixture(fetcher)
  fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } })).mockResolvedValueOnce(new Response(f.bytes))
  const root = await mkdtemp(join(tmpdir(), 'online-')); roots.push(root)
  const progress = vi.fn()
  await f.client.download(f.update, join(root, 'package.zip'), progress)
  expect(await readFile(join(root, 'package.zip'))).toEqual(f.bytes)
  expect(progress).toHaveBeenLastCalledWith(100)
  expect(fetcher.mock.calls[1]![0]).toBe('https://updates.example/next')
})
it('aborts a stalled response after 60 seconds', async () => {
  const f = fixture((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))))
  const root = await mkdtemp(join(tmpdir(), 'online-')); roots.push(root)
  vi.useFakeTimers()
  const pending = expect(f.client.download(f.update, join(root, 'package.zip'), () => {})).rejects.toThrow('aborted')
  // File creation completes before the network inactivity timer is installed.
  await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0))
  await vi.advanceTimersByTimeAsync(60_000)
  await pending
})
