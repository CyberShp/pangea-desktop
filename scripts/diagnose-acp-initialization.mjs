import { mkdtemp, access } from 'node:fs/promises'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { configuredProviderPlugins } from 'dsh-pangea-product'

const LIMIT = 8192
export function diagnosticText(value) {
  return String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[authorization]')
    .replace(/\b[\w-]*(?:key|password|secret|token)[\w-]*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[credential]').slice(0, LIMIT)
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const blocks = text => [{ type: 'text', text }]

export async function diagnose({ providerName, cwd, env = process.env, python, runtimeRoot, timeoutMs = 60000, drainMs = 400, stages = ['ping', 'tool', 'init'], emit = () => {} }) {
  if (!['pangea-nga', 'pangea-opencode', 'pangea-codeagent'].includes(providerName)) throw new Error('Unsupported ACP provider')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000 || !Number.isFinite(drainMs) || drainMs < 0 || drainMs > 2000) throw new Error('Invalid diagnostic time bounds')
  if (stages.includes('init') && (!python || !runtimeRoot)) throw new Error('Full probe requires --python and --runtime')
  cwd = path.resolve(cwd)
  await access(cwd)
  const entry = configuredProviderPlugins(env).find(([, config]) => config.providerName === providerName)
  if (!entry) throw new Error('Provider is unavailable in Desktop runtime configuration')
  const context = new Context()
  const subprocess = new LocalSubprocessRuntime(context)
  const controller = new AbortController()
  const children = []
  const started = Date.now()
  const report = { schemaVersion: 2, startedAt: new Date(started).toISOString(), provider: providerName, probePid: process.pid, nodeVersion: process.version, cwd, phases: [], status: 'failed' }
  let run, timer, phase = 'version', phaseStarted = started
  const publish = item => {
    const memory = process.memoryUsage()
    emit({ at: new Date().toISOString(), elapsedMs: Date.now() - started, probePid: process.pid,
      probeMemory: { rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal }, ...item })
  }
  const begin = value => { phase = value; phaseStarted = Date.now(); publish({ phase, status: 'start' }) }
  const spawn = subprocess.spawn.bind(subprocess)
  report.processes = []
  subprocess.spawn = spec => {
    const child = spawn(spec)
    children.push(child)
    const record = { pid: child.pid, role: phase, startedAt: new Date().toISOString() }
    report.processes.push(record)
    publish({ phase, status: 'process_started', process: { ...record } })
    child.done.then(outcome => {
      Object.assign(record, outcome, { finishedAt: new Date().toISOString() })
      publish({ phase: record.role, status: 'process_exited', process: { ...record } })
    }, error => {
      Object.assign(record, { error: diagnosticText(error.message), finishedAt: new Date().toISOString() })
      publish({ phase: record.role, status: 'process_failed', process: { ...record } })
    }).catch(() => {})
    return child
  }
  let timedOut = false
  const timed = async work => {
    clearTimeout(timer)
    timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    try { return await work() } finally { clearTimeout(timer) }
  }
  const command = async (argv, maxBytes = LIMIT) => {
    const resolved = await subprocess.resolveExecutable(argv[0], {}, controller.signal)
    const child = subprocess.spawn({ argv: [resolved, ...argv.slice(1)], windowsBatch: process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved), cwd, env: {}, stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes: LIMIT } }, graceMs: 200 })
    const abort = () => child.terminate()
    controller.signal.addEventListener('abort', abort, { once: true })
    if (controller.signal.aborted) abort()
    try {
      const outcome = await child.done
      if (outcome.exitCode !== 0) throw new Error(`command exit=${outcome.exitCode}: ${child.collected.stderr.readFrom(0).text}`)
      return child.collected.stdout.readFrom(0).text
    } finally { controller.signal.removeEventListener('abort', abort) }
  }
  const onSigint = () => controller.abort()
  process.once('SIGINT', onSigint)
  try {
    begin('version')
    report.version = diagnosticText(await timed(() => command([entry[1].command, ...entry[1].args.filter(arg => arg !== 'acp'), '--version'])))
    publish({ phase, status: 'passed', version: report.version, durationMs: Date.now() - phaseStarted })
    begin('session')
    let provider
    entry[0].apply({ logger: { warn() {} }, subprocess, subagents: { registerProvider(value) { provider = value } } }, entry[0].Config({ ...entry[1], diagnosticOutputLimit: LIMIT, disposeEofGraceMs: 200, disposeGraceMs: 200 }))
    run = await timed(() => provider.start({ prompt: blocks('Reply exactly PANGEA_PING_OK. Do not use tools.'), parent: { session: { header: { cwd } } }, signal: controller.signal }))
    report.launcherPid = run.processId
    report.localSessionId = run.id
    report.remoteSessionId = run.remoteSessionId
    report.model = diagnosticText(run.readDiagnostics().model || 'unavailable')
    report.phases.push({ phase, status: 'passed', durationMs: Date.now() - phaseStarted })
    publish({ ...report.phases.at(-1), launcherPid: report.launcherPid, remoteSessionId: report.remoteSessionId, model: report.model })
    let current = run.result
    for (phase of stages) {
      begin(phase)
      if (controller.signal.aborted) throw new Error('diagnostic timed out')
      let prepared
      if (phase === 'tool') current = run.continuePrompt(blocks('Execute a harmless shell command that prints PANGEA_TOOL_OK, then report its output. Do not modify files. If execution fails, report the error and stop.'))
      if (phase === 'init') {
        report.scratch = await mkdtemp(path.join(tmpdir(), 'pangea-acp-probe-'))
        prepared = JSON.parse(await timed(() => command([python, '-X', 'utf8', path.join(import.meta.dirname, 'prepare-acp-probe.py'), 'prepare', runtimeRoot, report.scratch], 65536)))
        const initArgs = [python, '-X', 'utf8', path.join(prepared.skill.root_path, 'scripts', 'run_guard.py'), 'init', '--skill-root', prepared.skill.root_path, '--workspace', prepared.run_root, '--source-raw', path.join(report.scratch, 'data', 'repositories', 'acp-probe'), '--source-verified', path.join(prepared.run_root, 'inputs', 'source', 'repository'), '--scenario', 'module-analysis', '--mode', 'speed']
        current = run.continuePrompt(blocks(`This is an isolated initialization check. Read request_path=${prepared.request_path} and its frozen SKILL.md. Use Python executable ${python} to execute only run_guard.py init for run_root=${prepared.run_root}. In PowerShell use & with quoted paths. Stop after init; do not execute Step 01–09. On host blockage report the command, exit code and brief error, then stop. Do not search host configuration, credentials or historical logs.\nInitialization arguments (JSON): ${JSON.stringify(initArgs)}`))
      }
      const before = phase === 'ping' ? { toolCalls: 0, toolFailures: 0 } : run.readDiagnostics()
      const result = await timed(() => current)
      // ACP notifications may arrive after the prompt response. Only this diagnostic waits.
      let output = result.output.filter(item => item.type === 'text').map(item => item.text).join('').slice(-LIMIT)
      const until = Date.now() + drainMs
      do {
        output = (output + run.readOutput()).slice(-LIMIT)
        if (Date.now() < until) await delay(Math.min(25, until - Date.now()))
      } while (Date.now() < until)
      output = (output + run.readOutput()).slice(-LIMIT)
      const details = run.readDiagnostics()
      let observed = phase === 'ping' ? output.includes('PANGEA_PING_OK') : phase === 'tool' ? details.toolCalls > before.toolCalls && details.toolOutput.includes('PANGEA_TOOL_OK') : false
      let state
      if (phase === 'init') {
        const statePath = path.join(prepared.run_root, '内部索引', '运行状态.json')
        const exists = await access(statePath).then(() => true, () => false)
        state = JSON.parse(await timed(() => command([python, '-X', 'utf8', path.join(import.meta.dirname, 'prepare-acp-probe.py'), 'read', runtimeRoot, report.scratch], 65536)))
        observed = exists && state.phase === 'STEP_BOOTSTRAP'
        report.state = { path: statePath, exists, phase: state.phase, completed: state.completed_steps.length }
      }
      const passed = observed && result.stopReason === 'completed' && details.toolFailures === before.toolFailures
      const item = { phase, status: passed ? 'passed' : 'failed', durationMs: Date.now() - phaseStarted, marker: observed ? 'observed' : 'not_observed', timedOut, stopReason: result.stopReason, protocolStopReason: result.protocolStopReason, messageChunks: details.messageChunks, toolCalls: details.toolCalls, toolFailures: details.toolFailures, errorCode: details.errorCode, errorSummary: diagnosticText(details.errorSummary), stderrSummary: diagnosticText(details.stderrSummary),
        model: diagnosticText(details.model || 'unavailable'), agentVersion: diagnosticText(details.agentVersion),
        firstEventMs: details.firstEventMs, turnDurationMs: details.turnDurationMs,
        lastToolId: diagnosticText(details.lastToolId), lastToolStatus: details.lastToolStatus,
        stderrBytes: details.stderrBytes, stderrTruncated: details.stderrTruncated, outputTruncated: details.outputTruncated,
        ...(!passed ? { responseSummary: diagnosticText(output).slice(-512), toolSummary: diagnosticText(details.toolOutput).slice(-512) } : {}),
      }
      report.phases.push(item)
      publish(item)
      if (!passed) return report
    }
    report.status = 'passed'
    return report
  } catch (error) {
    const details = run?.readDiagnostics?.() ?? {}
    const failure = { phase, status: 'failed', durationMs: Date.now() - phaseStarted, timedOut, errorCode: error.code ?? null, errorSummary: diagnosticText(error.message), stderrSummary: diagnosticText(error.stderrSummary ?? details.stderrSummary), lastToolStatus: details.lastToolStatus }
    report.phases.push(failure)
    publish(failure)
    return report
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGINT', onSigint)
    publish({ phase: 'cleanup', status: 'start' })
    controller.abort()
    try {
      await run?.dispose()
      for (const child of children) { await child.waitForExit(); }
      report.cleanup = 'completed'
    } catch (error) {
      report.cleanup = 'failed'
      report.cleanupError = diagnosticText(error.message)
      report.status = 'failed'
    } finally {
      try { await context.fiber.dispose() } catch (error) {
        report.cleanup = 'failed'; report.status = 'failed'; report.cleanupError = diagnosticText(error.message)
      }
      report.finishedAt = new Date().toISOString()
      report.durationMs = Date.now() - started
      const final = run?.readDiagnostics?.()
      if (final) report.finalProcess = { processExited: final.processExited, exitCode: final.exitCode, exitSignal: final.exitSignal,
        stderrBytes: final.stderrBytes, stderrTruncated: final.stderrTruncated, stderrSummary: diagnosticText(final.stderrSummary) }
      publish({ phase: 'cleanup', status: report.cleanup === 'completed' ? 'passed' : 'failed', errorSummary: report.cleanupError, ...report.finalProcess })
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1] }
  let outputDir
  try {
    const requestedDir = value('--output-dir')
    if (requestedDir) {
      const resolvedDir = path.resolve(requestedDir)
      // Each invocation owns a fresh directory, preserving previous diagnostic evidence.
      mkdirSync(resolvedDir, { recursive: false })
      outputDir = resolvedDir
    }
    const emit = item => {
      const line = `${JSON.stringify(item)}\n`
      if (outputDir) appendFileSync(path.join(outputDir, 'events.jsonl'), line, 'utf8')
      process.stderr.write(line)
    }
    emit({ at: new Date().toISOString(), phase: 'probe', status: 'start', probePid: process.pid })
    const report = await diagnose({ providerName: value('--provider', 'pangea-opencode'), cwd: value('--cwd', process.cwd()), python: value('--python'), runtimeRoot: value('--runtime'), timeoutMs: Number(value('--timeout-ms', 60000)), stages: args.includes('--ping-only') ? ['ping'] : undefined, emit })
    if (outputDir) writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    process.exitCode = report.status === 'passed' ? 0 : 1
  } catch (error) {
    const failure = { at: new Date().toISOString(), phase: 'probe', status: 'failed', probePid: process.pid, errorSummary: diagnosticText(error.message) }
    if (outputDir) { try {
      appendFileSync(path.join(outputDir, 'events.jsonl'), `${JSON.stringify(failure)}\n`, 'utf8')
      writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(failure, null, 2)}\n`, 'utf8')
    } catch {} }
    process.stderr.write(`${JSON.stringify(failure)}\n`); process.exitCode = 1
  }
}
