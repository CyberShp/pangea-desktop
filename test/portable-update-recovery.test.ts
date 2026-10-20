import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { portableTransactionLocation, readPendingPortableTransaction, isAuthorizedPortableHealthLaunch } from '../src/main/update/portable-update-recovery'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pangea-recovery-'))
  roots.push(root)
  const install = join(root, 'desktop')
  const userData = join(root, 'profile')
  await mkdir(join(userData, 'updates', 'run-1'), { recursive: true })
  const planPath = join(userData, 'updates', 'run-1', 'update-plan.json')
  const location = await portableTransactionLocation(install)
  const record = { schema_version: 1, install_root: location.installRoot, target_version: '2.0.14', state: 'original_move_pending', plan_path: planPath, new_version_started: true, worker_pid: 7331, worker_started_at: '2026-10-20T00:00:00.1234567Z' }
  await writeFile(planPath, JSON.stringify({ schema_version: 2, install_root: location.installRoot, expected_version: '2.0.14', health_marker: join(userData, 'updates', 'run-1', 'healthy.json') }))
  const save = async () => writeFile(location.journalPath, JSON.stringify(record))
  await save()
  return { install, userData, record, save, planPath }
}

it('finds an interrupted transaction even while the install directory is missing', async () => {
  const f = await fixture()
  expect(await readPendingPortableTransaction(f.install, f.userData)).toMatchObject({ state: 'original_move_pending', planPath: f.planPath })
  f.record.state = 'restored'; await f.save()
  expect(await readPendingPortableTransaction(f.install, f.userData)).toBeUndefined()
})

it('rejects mismatched install and outside-profile recovery plans without running them', async () => {
  const f = await fixture()
  f.record.install_root = join(f.install, 'different'); await f.save()
  await expect(readPendingPortableTransaction(f.install, f.userData)).rejects.toThrow('不匹配')
  f.record.install_root = (await portableTransactionLocation(f.install)).installRoot
  const outside = join(f.userData, 'outside.json')
  await writeFile(outside, '{}')
  f.record.plan_path = outside; await f.save()
  await expect(readPendingPortableTransaction(f.install, f.userData)).rejects.toThrow('不在当前用户')
})

it('fails closed on unrecognized state or plan version mismatch', async () => {
  const f = await fixture()
  f.record.state = 'unknown'; await f.save()
  await expect(readPendingPortableTransaction(f.install, f.userData)).rejects.toThrow('无法识别')
  f.record.state = 'activated'; await f.save()
  await writeFile(f.planPath, JSON.stringify({ schema_version: 2, install_root: f.record.install_root, expected_version: '2.0.15' }))
  await expect(readPendingPortableTransaction(f.install, f.userData)).rejects.toThrow('不匹配')
})


it('allows only the live transaction worker child to bypass pending recovery for health reporting', async () => {
  const f = await fixture()
  f.record.state = 'activated'; await f.save()
  const pending = (await readPendingPortableTransaction(f.install, f.userData))!
  const identity = {
    workerPid: f.record.worker_pid, workerStartedAt: f.record.worker_started_at,
    parentPid: f.record.worker_pid, executable: process.execPath
  }
  const authorize = (marker = pending.healthMarker, version = '2.0.14', current = identity) =>
    isAuthorizedPortableHealthLaunch(pending, marker, version, async () => current)
  await expect(authorize()).resolves.toBe(true)
  await expect(authorize(join(f.userData, 'updates', 'arbitrary.json'))).resolves.toBe(false)
  await expect(authorize(pending.healthMarker, '2.0.7')).resolves.toBe(false)
  await expect(authorize(pending.healthMarker, '2.0.14', { ...identity, parentPid: 7332 })).resolves.toBe(false)
  await expect(authorize(pending.healthMarker, '2.0.14', { ...identity, executable: join(f.install, 'other.exe') })).resolves.toBe(false)
  // A reused PID within the same millisecond must still fail identity checking.
  await expect(authorize(pending.healthMarker, '2.0.14', { ...identity, workerStartedAt: '2026-10-20T00:00:00.1234568Z' })).resolves.toBe(false)
  await expect(isAuthorizedPortableHealthLaunch(pending, pending.healthMarker, '2.0.14', async () => { throw new Error('worker exited') })).resolves.toBe(false)
  await expect(isAuthorizedPortableHealthLaunch({ ...pending, state: 'candidate_ready' }, pending.healthMarker, '2.0.14', async () => identity)).resolves.toBe(false)
  await expect(isAuthorizedPortableHealthLaunch({ ...pending, newVersionStarted: false }, pending.healthMarker, '2.0.14', async () => identity)).resolves.toBe(false)
})

it('rejects a plan health marker that escapes the active user profile', async () => {
  const f = await fixture()
  await writeFile(f.planPath, JSON.stringify({
    schema_version: 2, install_root: f.record.install_root, expected_version: '2.0.14',
    health_marker: join(f.userData, 'outside.json')
  }))
  await expect(readPendingPortableTransaction(f.install, f.userData)).rejects.toThrow('健康标记不在当前用户')
})
