import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { expect, it } from 'vitest'
import { createWindowsRecoveryFence } from '../node_modules/@deepseek-ai/dsh-subprocess-local/lib/windows-recovery-fence.js'

function fixture() {
  const state = { live: new Map([[10, true], [11, true]]), identity: new Map([[10, '100'], [11, '110']]),
    assigned: new Set(), closed: [], terminated: 0, queryError: false, retainAfterKill: false, snapshotError: false }
  const job = { job: true }
  const native = {
    createJob: () => job,
    open: pid => ({ handle: { pid, token: Symbol() }, started: state.identity.get(pid) }),
    isActive: handle => state.live.get(handle.pid) === true,
    snapshot: () => {
      if (state.snapshotError) throw new Error('snapshot access denied')
      return [{ pid: 10, parentPid: 1 }, { pid: 11, parentPid: 10 }]
    },
    assign: (_, handle) => state.assigned.add(handle.pid),
    activeProcesses: () => {
      if (state.queryError) throw new Error('job query access denied')
      return [...state.assigned].filter(pid => state.live.get(pid)).length
    },
    terminate: () => { state.terminated++; if (!state.retainAfterKill) for (const pid of state.assigned) state.live.set(pid, false) },
    close: handle => state.closed.push(handle),
  }
  return { state, native, job }
}

it('attaches root and existing startup descendants before returning a recovery capability', async () => {
  const { state, native } = fixture()
  const fence = createWindowsRecoveryFence(10, native)
  expect(fence.supported).toBe(true)
  expect([...state.assigned]).toEqual([10, 11])
  expect(await fence.quiesceForRecovery()).toMatchObject({ confirmed: true, processTreeStopped: true, method: 'windows-job' })
  expect(state.terminated).toBe(1)
  expect(await fence.quiesceForRecovery()).toMatchObject({ confirmed: true })
  expect(state.terminated).toBe(1)
})

it('keeps the job after the root exits and terminates a surviving descendant by job membership', async () => {
  const { state, native, job } = fixture()
  const fence = createWindowsRecoveryFence(10, native)
  state.live.set(10, false)
  fence.releaseWhenEmpty()
  expect(state.closed).not.toContain(job)
  expect(await fence.quiesceForRecovery()).toMatchObject({ confirmed: true, processTreeStopped: true })
  expect(state.live.get(11)).toBe(false)
  expect(state.closed).toContain(job)
})

for (const failure of ['snapshot', 'unreadable', 'reused-pid', 'old-parent', 'assignment', 'root-exited', 'unstable']) {
  it(`fails closed at startup without terminating the normal agent (${failure})`, async () => {
    const { state, native, job } = fixture()
    if (failure === 'snapshot') state.snapshotError = true
    if (failure === 'unreadable') native.open = () => { throw new Error('cannot read process identity') }
    if (failure === 'assignment') native.assign = () => { throw new Error('job assignment denied') }
    if (failure === 'root-exited') state.live.set(10, false)
    if (failure === 'old-parent') state.identity.set(11, '1')
    if (failure === 'reused-pid') {
      let rootReads = 0; const open = native.open
      native.open = pid => { const value = open(pid); if (pid === 10 && ++rootReads > 1) value.started = '999'; return value }
    }
    if (failure === 'unstable') {
      let count = 11
      native.snapshot = () => {
        state.identity.set(++count, String(count * 10)); state.live.set(count, true)
        return [{ pid: 10, parentPid: 1 }, ...[...state.identity.keys()].filter(pid => pid !== 10).map(pid => ({ pid, parentPid: 10 }))]
      }
    }
    const fence = createWindowsRecoveryFence(10, native)
    expect(fence.supported).toBe(false)
    expect(await fence.quiesceForRecovery()).toMatchObject({ confirmed: false, processTreeStopped: false })
    expect(state.terminated).toBe(0)
    expect(state.closed).toContain(job)
  })
}

for (const failure of ['query', 'wait', 'terminate', 'timeout']) {
  it(`does not convert an unknown or incomplete stop into a recovery proof (${failure})`, async () => {
    const { state, native } = fixture()
    const fence = createWindowsRecoveryFence(10, native, { timeoutMs: 5, intervalMs: 1 })
    if (failure === 'query') state.queryError = true
    if (failure === 'wait') native.isActive = () => { throw new Error('process wait failed') }
    if (failure === 'terminate') native.terminate = () => { throw new Error('job termination failed') }
    if (failure === 'timeout') state.retainAfterKill = true
    expect(await fence.quiesceForRecovery()).toMatchObject({ confirmed: false, processTreeStopped: false })
  })
}

it('rechecks the same owned Job after a failed observation without duplicating an in-flight attempt', async () => {
  const { state, native } = fixture()
  const fence = createWindowsRecoveryFence(10, native)
  state.queryError = true
  const first = fence.quiesceForRecovery()
  expect(fence.quiesceForRecovery()).toBe(first)
  expect(await first).toMatchObject({ confirmed: false })
  state.queryError = false
  expect(await fence.quiesceForRecovery()).toMatchObject({ confirmed: true, processTreeStopped: true })
  expect(state.terminated).toBe(2)
})

it.runIf(process.platform === 'win32')('native Windows job stops a child after its protocol parent has exited on EOF', async () => {
  const context = new Context(), runtime = new LocalSubprocessRuntime(context)
  let handle, descendantPid
  try {
    const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});child.unref();process.stdout.write(String(child.pid)+'\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`
    handle = runtime.spawn({ argv: [process.execPath, '-e', script], cwd: path.resolve('.'), env: {}, recoveryFence: true,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 100 })
    descendantPid = await new Promise((resolve, reject) => {
      handle.stdout.once('data', chunk => resolve(Number(chunk.toString().trim())))
      handle.done.then(() => reject(new Error('fixture exited before reporting its child')), reject)
    })
    expect(Number.isInteger(descendantPid)).toBe(true)
    handle.stdin.end()
    await handle.done
    expect(() => process.kill(descendantPid, 0)).not.toThrow()
    expect(await handle.quiesceForRecovery()).toMatchObject({ confirmed: true, processTreeStopped: true })
    expect(() => process.kill(descendantPid, 0)).toThrow()
  } finally {
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL') } catch {} }
    handle?.terminate()
    await context.fiber.dispose()
  }
}, 20000)

 it('releases exited process references before requiring zero Job accounting', async () => {
  const { state, native } = fixture()
  const openHandles = new Set()
  const open = native.open, close = native.close
  native.open = pid => { const value = open(pid); openHandles.add(value.handle); return value }
  native.close = handle => { openHandles.delete(handle); close(handle) }
  native.activeProcesses = () => [...state.assigned].filter(pid => state.live.get(pid)
    || [...openHandles].some(handle => handle.pid === pid)).length
  const fence = createWindowsRecoveryFence(10, native, { timeoutMs: 20, intervalMs: 1 })
  expect(await fence.quiesceForRecovery()).toMatchObject({ confirmed: true, processTreeStopped: true })
  expect(openHandles.size).toBe(0)
})
