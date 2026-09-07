import assert from 'node:assert/strict'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// --native exercises the same registration and protocol checks without a shell.
// It does not count as Windows batch verification.
const native = process.argv[2] === '--native'
if (!native && process.platform !== 'win32') throw new Error('This integration test must run on Windows')
const appRoot = process.env.PANGEA_TEST_APP_ROOT
const [ngaShim, codeagentShim, opencodeShim] = process.argv.slice(2)
if (!appRoot || (!native && (!ngaShim || !codeagentShim || !opencodeShim))) {
  throw new Error('Packaged app root and three shim paths are required')
}

const importPackaged = relativePath => import(pathToFileURL(path.join(appRoot, 'node_modules', relativePath)).href)
const [{ Context }, { LocalSubprocessRuntime }, product, commandProbe] = await Promise.all([
  importPackaged('@deepseek-ai/cordis/lib/index.js'),
  importPackaged('@deepseek-ai/dsh-subprocess-local/lib/index.js'),
  importPackaged('dsh-pangea-product/index.js'),
  importPackaged('dsh-pangea-product/agent-command-probe.js'),
])

// CALL may duplicate carets inside quoted arguments; batch mode rejects them.
// The direct path still verifies that a literal caret reaches the child intact.
const expectedArgs = ['acp', '', 'value with spaces', '中文参数', 'A&B', 'x|y', '<in>', ...(native ? ['caret^'] : []), 'bang!', '(group)', 'C:\\tail\\']
const fixture = fileURLToPath(new URL('./fixtures/acp-batch-agent.mjs', import.meta.url))
const shimDirectory = native ? path.dirname(fixture) : path.dirname(ngaShim)
const probeEnvironment = native ? process.env : {
  ...process.env,
  Path: `${shimDirectory};${process.env.Path ?? process.env.PATH ?? ''}`,
  PATH: `${shimDirectory};${process.env.Path ?? process.env.PATH ?? ''}`,
}
const resolvedCommands = Object.fromEntries([
  ['pangea-nga', 'nga'],
  ['pangea-codeagent', 'codeagent'],
  ['pangea-opencode', 'opencode'],
].map(([provider, command]) => [provider, native
  ? { command: process.execPath }
  : commandProbe.resolveAgentCommandWithPowerShell(command, probeEnvironment)]))
const launchArgs = native ? [fixture, ...expectedArgs] : expectedArgs
const runtimeConfig = {
  version: 1,
  providers: {
    'pangea-nga': { command: 'nga', resolved_command: resolvedCommands['pangea-nga'].command, args: launchArgs },
    'pangea-codeagent': { command: 'codeagent', resolved_command: resolvedCommands['pangea-codeagent'].command, args: launchArgs },
    'pangea-opencode': { command: 'opencode', resolved_command: resolvedCommands['pangea-opencode'].command, args: launchArgs },
    'pangea-claude-code': { available: false },
  },
}
const environment = {
  ...probeEnvironment,
  PANGEA_ACP_RUNTIME_CONFIG: JSON.stringify(runtimeConfig),
}
const serviceContext = new Context()
const providers = new Map()
const ctx = {
  logger: { warn(message) { process.stderr.write(`${message}\n`) } },
  subagents: { registerProvider(provider) { providers.set(provider.name, provider) } },
}
ctx.subprocess = new LocalSubprocessRuntime(serviceContext)

const entries = product.configuredProviderPlugins(environment)
assert.equal(entries.length, 3)

const results = []
try {
  for (const [plugin, config] of entries) plugin.apply(ctx, plugin.Config({ ...config, cwd: shimDirectory }))
  for (const providerName of ['pangea-nga', 'pangea-codeagent', 'pangea-opencode']) {
    const provider = providers.get(providerName)
    assert.ok(provider, `${providerName} was not registered`)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(`${providerName} integration timeout`), 30_000)
    let run
    try {
      run = await provider.start({
        prompt: [{ type: 'text', text: 'fixture prompt' }],
        parent: { session: { header: { cwd: shimDirectory } } },
        signal: controller.signal,
      })
      const result = await run.result
      assert.equal(result.stopReason, 'completed')
      const output = result.output.map(item => item.type === 'text' ? item.text : '').join('')
      assert.match(output, /ACP_BATCH_READY/)
      assert.match(output, /turn=1/)
      assert.ok(output.includes(JSON.stringify(expectedArgs)), `batch arguments changed: ${output}`)
      assert.equal(run.launch.launcherKind, native ? 'direct' : 'windows-batch')
      assert.equal(path.resolve(run.launch.resolvedCommand), path.resolve(runtimeConfig.providers[providerName].resolved_command))
      assert.ok(Number.isInteger(run.processId) && run.processId > 0)
      const second = await run.continuePrompt([{ type: 'text', text: 'fixture second turn' }])
      assert.equal(second.stopReason, 'completed')
      const secondOutput = second.output.map(item => item.type === 'text' ? item.text : '').join('')
      assert.match(secondOutput, /turn=2/)
      assert.ok(secondOutput.includes(JSON.stringify(expectedArgs)), `continued batch arguments changed: ${secondOutput}`)
      results.push({ provider: providerName, processId: run.processId, launcherKind: run.launch.launcherKind, sameSessionContinuation: true })
    } finally {
      clearTimeout(timer)
      await run?.dispose?.()
    }
  }

  const cancellationProvider = providers.get('pangea-opencode')
  const cancellation = await cancellationProvider.start({
    prompt: [{ type: 'text', text: 'WAIT_FOR_CANCEL' }],
    parent: { session: { header: { cwd: shimDirectory } } },
    signal: new AbortController().signal,
  })
  const waitDeadline = Date.now() + 5_000
  let waitingOutput = ''
  while (!waitingOutput.includes('ACP_BATCH_READY') && Date.now() < waitDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
    waitingOutput += cancellation.readOutput()
  }
  assert.match(waitingOutput, /ACP_BATCH_READY/)
  await cancellation.dispose()
  const cancelled = await cancellation.result
  assert.equal(cancelled.stopReason, 'aborted')
  results.push({ provider: 'pangea-opencode', cancellation: 'aborted', processId: cancellation.processId })

  if (!native) {
    for (const shim of [ngaShim, codeagentShim, opencodeShim]) {
      for (const invalid of ['caret^', 'unsafe"argument', '%PATH%', 'line\nbreak', 'line\rbreak', 'nul\0byte']) {
        assert.throws(() => ctx.subprocess.spawn({
          argv: [shim, invalid], windowsBatch: true, cwd: shimDirectory,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 1_000,
        }), /windowsBatch argv cannot contain.*argv\[1\]/)
      }
    }
    assert.throws(() => ctx.subprocess.spawn({
      argv: [path.join(shimDirectory, 'agent^unsafe.cmd'), 'acp'], windowsBatch: true, cwd: shimDirectory,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 1_000,
    }), /windowsBatch argv cannot contain.*argv\[0\]/)
  }
} finally {
  await serviceContext.fiber.dispose()
}

process.stdout.write(`${JSON.stringify({ status: 'ok', results }, null, 2)}\n`)
