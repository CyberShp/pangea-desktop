import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export function parseProcessGroups(text) {
  return text.trim().split('\n').filter(Boolean).map(line => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    assert.ok([pid, ppid, pgid].every(Number.isSafeInteger), 'Invalid process table')
    return { pid, ppid, pgid }
  })
}

function processGroupMembers(groupId) {
  try { process.kill(-groupId, 0) } catch (error) { if (error.code === 'ESRCH') return []; throw error }
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0, result.error?.message || result.stderr || 'Cannot inspect child process group')
  return parseProcessGroups(result.stdout).filter(item => item.pgid === groupId)
}

export async function stopOwnedGroup(child) {
  if (!child?.pid) return []
  // The detached spawn created this group. Never select by name or app path.
  const signal = value => {
    try { process.kill(-child.pid, value); return true } catch (error) { if (error.code !== 'ESRCH') throw error; return false }
  }
  if (!signal('SIGTERM')) return []
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(100)
    if (!processGroupMembers(child.pid).length) return []
  }
  signal('SIGKILL')
  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(100)
    if (!processGroupMembers(child.pid).length) return []
  }
  return processGroupMembers(child.pid)
}

/** Execute only the supplied process; always retain failure/timeout evidence. */
export async function runProcessProbe({ label, executable, args = [], cwd, env, evidence,
  timeoutMs = 120_000, maxOutputBytes = 8 * 1024 * 1024 }) {
  assert.notEqual(process.platform, 'win32', 'Process-group probes require macOS or Linux')
  assert.match(label, /^[a-z0-9-]+$/, 'Probe label must be a safe log basename')
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs > 0, 'Probe timeout must be positive')
  const startedAt = new Date()
  const start = performance.now()
  const record = {
    name: label, status: 'running', executable, started_at: startedAt.toISOString(),
    pid: null, elapsed_ms: 0, timeout_ms: timeoutMs, timed_out: false,
    exit_code: null, signal: null, spawn_error: null,
    stdout_log: path.join(evidence, `${label}.stdout.log`),
    stderr_log: path.join(evidence, `${label}.stderr.log`),
    output_truncated: false, cleanup: { remaining_processes: [], error: null },
  }
  const stdoutChunks = [], stderrChunks = []
  const sizes = { stdout: 0, stderr: 0 }
  let child, timer, settle, closed
  const finished = new Promise(resolve => { settle = resolve })
  const collect = (stream, chunks) => chunk => {
    const remaining = Math.max(0, maxOutputBytes - sizes[stream])
    if (remaining) chunks.push(chunk.subarray(0, remaining))
    sizes[stream] += chunk.length
    if (sizes[stream] > maxOutputBytes) {
      record.output_truncated = true
      settle('output_limit')
    }
  }
  try {
    child = spawn(executable, args, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    closed = new Promise(resolve => child.once('close', resolve))
    record.pid = child.pid ?? null
    child.stdout.on('data', collect('stdout', stdoutChunks))
    child.stderr.on('data', collect('stderr', stderrChunks))
    child.once('error', error => {
      record.spawn_error = { code: error.code ?? null, message: error.message }
      settle('spawn_error')
    })
    child.once('close', (code, signal) => {
      record.exit_code = code
      record.signal = signal
      settle('closed')
    })
    timer = setTimeout(() => { record.timed_out = true; settle('timed_out') }, timeoutMs)
    const outcome = await finished
    record.status = outcome === 'timed_out' ? 'timed_out'
      : outcome === 'closed' && record.exit_code === 0 ? 'passed' : 'failed'
    record.failure_kind = record.status === 'passed' ? null : outcome === 'closed' ? 'nonzero_exit' : outcome
  } catch (error) {
    record.status = 'failed'
    record.failure_kind = 'spawn_error'
    record.spawn_error = { code: error.code ?? null, message: error.message }
  } finally {
    clearTimeout(timer)
    record.elapsed_ms = Math.round(performance.now() - start)
    try {
      record.cleanup.remaining_processes = await stopOwnedGroup(child)
      if (record.cleanup.remaining_processes.length) record.cleanup.error = 'Owned child processes remain after cleanup'
    } catch (error) { record.cleanup.error = error.message }
    if (closed) {
      let drainTimer
      await Promise.race([closed, new Promise(resolve => { drainTimer = setTimeout(resolve, 1000) })])
      clearTimeout(drainTimer)
    }
    // Cleanup can cause the close event; retain that terminal code/signal too.
    record.exit_code = child?.exitCode ?? record.exit_code
    record.signal = child?.signalCode ?? record.signal
    if (record.cleanup.error && record.status === 'passed') {
      record.status = 'failed'
      record.failure_kind = 'cleanup'
    }
    record.total_elapsed_ms = Math.round(performance.now() - start)
  }
  const stdout = Buffer.concat(stdoutChunks).toString('utf8')
  const stderr = Buffer.concat(stderrChunks).toString('utf8')
  const writes = await Promise.allSettled([
    writeFile(record.stdout_log, stdout, { flag: 'wx' }),
    writeFile(record.stderr_log, stderr, { flag: 'wx' }),
  ])
  const errors = writes.filter(item => item.status === 'rejected').map(item => item.reason.message)
  if (errors.length) {
    record.evidence_error = errors.join('; ')
    if (record.status === 'passed') { record.status = 'failed'; record.failure_kind = 'evidence' }
  }
  try {
    await writeFile(path.join(evidence, `${label}.process.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
  } catch (error) {
    record.evidence_error = [record.evidence_error, error.message].filter(Boolean).join('; ')
    if (record.status === 'passed') { record.status = 'failed'; record.failure_kind = 'evidence' }
  }
  return { record, stdout, stderr }
}
