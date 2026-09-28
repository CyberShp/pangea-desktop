import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyAcpProvider } from '@deepseek-ai/dsh-subagent-acp'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(projectRoot, 'scripts', 'fixtures', 'acp-batch-agent.mjs')

// OpenCode v1.18.28 permission/index.ts fromConfig/evaluate + core/util/wildcard.ts.
// Evaluate the final merged configuration, not only the emitted edit property.
function openCodeEditAction(configured, override, file) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const normalize = value => typeof value === 'string' ? { '*': value } : value ?? {}
  const merged = { ...normalize(configured) }
  for (const [key, value] of Object.entries(normalize(override))) {
    merged[key] = object(merged[key]) && object(value) ? { ...merged[key], ...value } : value
  }
  const matches = (input, pattern) => {
    let escaped = pattern.replaceAll('\\', '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
    if (escaped.endsWith(' .*')) escaped = escaped.slice(0, -3) + '( .*)?'
    return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'si' : 's').test(input.replaceAll('\\', '/'))
  }
  const rules = [{ permission: '*', pattern: '*', action: 'allow' }]
  for (const [permission, value] of Object.entries(merged)) {
    for (const [pattern, action] of Object.entries(typeof value === 'string' ? { '*': value } : value)) rules.push({ permission, pattern, action })
  }
  return rules.findLast(rule => matches('edit', rule.permission) && matches(file, rule.pattern)).action
}

describe('patched ACP provider launch', () => {
  it('isolates concurrent worker temp directories and restores the original session without changing cwd or config', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pangea-acp-scratch-'))
    const directories = [path.join(root, 'worker one'), path.join(root, "worker's 二")]
    const context = new Context()
    const runs = []
    let provider
    const env = { PANGEA_TEST_APP_ROOT: projectRoot, PANGEA_TEST_SCRATCH: '1', PANGEA_TEST_KEEP: 'preserved',
      OPENCODE_CONFIG_CONTENT: '{"model":"configured/model","permission":{"pangea_*":"deny"}}',
      TEMP: 'configured-temp', temp: 'configured-lowercase-temp', TMP: 'configured-tmp', TMPDIR: 'configured-tmpdir' }
    const originalEnv = { ...env }
    const ambient = () => Object.fromEntries(['TEMP', 'TMP', 'TMPDIR', 'PANGEA_WORKER_SCRATCH'].map(name => [name, process.env[name]]))
    const before = ambient()
    applyAcpProvider({ logger: { warn() {} }, subprocess: new LocalSubprocessRuntime(context), subagents: { registerProvider(value) { provider = value } } }, {
      providerName: 'pangea-opencode', command: process.execPath, args: [fixture], cwd: projectRoot, permission: 'allow', env,
      disposeEofGraceMs: 1000, disposeGraceMs: 1000,
    })
    const request = scratchDirectory => ({ scratchDirectory, prompt: [{ type: 'text', text: 'REPORT_SCRATCH' }],
      parent: { session: { header: { cwd: root } } }, signal: new AbortController().signal })
    const report = result => JSON.parse(result.output.map(item => item.type === 'text' ? item.text : '').join(''))
    const check = (value, directory, sessionId) => {
      expect(value).toEqual({ cwd: projectRoot, sessionId, env: {
        TEMP: directory, TMP: directory, TMPDIR: directory, PANGEA_WORKER_SCRATCH: directory,
        PANGEA_TEST_KEEP: env.PANGEA_TEST_KEEP, OPENCODE_CONFIG_CONTENT: env.OPENCODE_CONFIG_CONTENT,
        OPENCODE_PERMISSION: '{"edit":"ask"}',
      } })
    }
    try {
      const attempts = await Promise.allSettled(directories.map(async directory => {
        const run = await provider.start(request(directory))
        runs.push(run)
        return { run, directory, value: report(await run.result) }
      }))
      for (const attempt of attempts) {
        expect(attempt.status, attempt.reason?.message).toBe('fulfilled')
        check(attempt.value.value, attempt.value.directory, attempt.value.run.remoteSessionId)
      }
      const first = attempts[0].value
      await first.run.dispose()
      const resumed = await provider.start({ ...request(first.directory), prompt: [],
        resume: { taskId: first.run.id, remoteSessionId: first.run.remoteSessionId } })
      runs.push(resumed)
      expect(resumed.id).toBe(first.run.id)
      expect((await resumed.result).output).toEqual([])
      check(report(await resumed.continuePrompt([{ type: 'text', text: 'REPORT_SCRATCH' }])), first.directory, first.run.remoteSessionId)
      await resumed.dispose()
      expect(JSON.parse(await readFile(path.join(first.directory, 'fixture-session.json'), 'utf8')).sessionId).toBe(first.run.remoteSessionId)
      expect(ambient()).toEqual(before)
      expect(env).toEqual(originalEnv)
      await expect(provider.start(request('relative-scratch'))).rejects.toThrow(/scratchDirectory must be an absolute path/)
    } finally {
      await Promise.allSettled(runs.map(run => run.dispose()))
      await context.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 15000)

  it('limits native edits to each worker scratch while preserving reads and shell permissions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pangea-acp-native-'))
    const directories = [path.join(root, 'one'), path.join(root, 'two')]
    const context = new Context()
    const runs = []
    const events = []
    let provider
    applyAcpProvider({ logger: { warn() {} }, subprocess: new LocalSubprocessRuntime(context), subagents: { registerProvider(value) { provider = value } } }, {
      providerName: 'native-fixture', command: process.execPath, args: [fixture], cwd: projectRoot, permission: 'allow',
      env: { PANGEA_TEST_APP_ROOT: projectRoot, PANGEA_TEST_SCRATCH: '1' }, disposeEofGraceMs: 1000, disposeGraceMs: 1000,
    })
    const probe = async (run, request) => JSON.parse((await run.continuePrompt([{ type: 'text', text: `PERMISSION ${JSON.stringify(request)}` }])).output.map(item => item.text ?? '').join(''))
    const native = (file, extra = {}) => ({ kind: 'edit', locations: [{ path: file }], write: true, ...extra })
    const allowed = { outcome: { outcome: 'selected', optionId: 'once' } }
    const rejected = { outcome: { outcome: 'cancelled' } }
    try {
      for (const scratchDirectory of directories) {
        const run = await provider.start({ scratchDirectory, prompt: [], signal: new AbortController().signal,
          onDiagnostic: event => events.push(event), parent: { session: { header: { cwd: root } } } })
        runs.push(run)
        await run.result
      }
      const targets = directories.map(directory => path.join(directory, 'new parent', '单位.json'))
      expect(await Promise.all(runs.map((run, index) => probe(run, native(targets[index]))))).toEqual([allowed, allowed])
      expect(await Promise.all(targets.map(file => readFile(file, 'utf8')))).toEqual(['fixture native write', 'fixture native write'])
      expect(await Promise.all(runs.map((run, index) => probe(run, native(targets[1 - index]))))).toEqual([rejected, rejected])
      const outside = path.join(root, 'outside.json')
      for (const kind of ['edit', 'delete', 'move']) expect(await probe(runs[0], native(outside, { kind }))).toEqual(rejected)
      for (const locations of [undefined, [], [{ path: 'relative.json' }], [{ path: '' }], [{ path: directories[0] }], [{ path: targets[0] }, { path: outside }]]) {
        expect(await probe(runs[0], { kind: 'edit', locations })).toEqual(rejected)
      }
      expect(await access(outside).then(() => true, () => false)).toBe(false)
      const outsideDirectory = path.join(root, 'external')
      await mkdir(outsideDirectory)
      await symlink(outsideDirectory, path.join(directories[0], 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(await probe(runs[0], native(path.join(directories[0], 'escape', 'new', 'file.json')))).toEqual(rejected)
      await symlink(path.join(root, 'missing'), path.join(directories[0], 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(await probe(runs[0], native(path.join(directories[0], 'dangling', 'file.json')))).toEqual(rejected)
      await symlink(path.dirname(targets[0]), path.join(directories[0], 'inside'), process.platform === 'win32' ? 'junction' : 'dir')
      expect(await probe(runs[0], native(path.join(directories[0], 'inside', 'linked.json')))).toEqual(allowed)
      expect(await probe(runs[0], native(targets[0], { options: [{ optionId: 'always', kind: 'allow_always', name: 'Always' }] }))).toEqual(rejected)
      for (const kind of ['read', 'execute']) expect(await probe(runs[0], { kind, locations: [{ path: outside }] })).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } })
      const identity = { taskId: runs[0].id, remoteSessionId: runs[0].remoteSessionId }
      await runs[0].dispose()
      const resumed = await provider.start({ scratchDirectory: directories[0], resume: identity, prompt: [], signal: new AbortController().signal,
        parent: { session: { header: { cwd: root } } } })
      runs.push(resumed)
      await resumed.result
      expect(await probe(resumed, native(targets[0]))).toEqual(allowed)
      expect(await probe(resumed, native(outside))).toEqual(rejected)
      expect(events.some(event => event.stage === 'file_permission' && event.lastPermissionDecision === 'reject')).toBe(true)
      expect(await access(outside).then(() => true, () => false)).toBe(false)
    } finally {
      await Promise.allSettled(runs.map(run => run.dispose()))
      await context.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 20000)

  it.each([
    { permission: { edit: 'deny', bash: 'deny' }, expected: { edit: 'deny', bash: 'deny' } },
    { permission: { edit: { '*': 'allow', 'protected/**': 'deny', 'scratch/**': 'ask' }, read: 'allow' }, expected: { edit: { '*': 'ask', 'protected/**': 'deny', 'scratch/**': 'ask' }, read: 'allow' } },
    { permission: { '*': 'deny' }, expected: { '*': 'deny', edit: 'deny' } },
    { permission: {}, configured: { edit: { '*': 'ask', 'protected/**': 'deny' } }, expected: { edit: { '*': 'ask', 'protected/**': 'deny' } } },
    { permission: 'deny', expected: { '*': 'deny', edit: 'deny' } },
    { permission: 'allow', expected: { '*': 'allow', edit: 'ask' } },
    { permission: {}, configured: 'deny', expected: { edit: 'deny' } },
    { permission: {}, configured: { '*': 'deny', edit: { '*': 'deny', 'approved/**': 'allow' } }, expected: { edit: { '*': 'deny', 'approved/**': 'ask' } } },
    { permission: { '*': 'deny', edit: { 'approved/**': 'allow' } }, expected: { '*': 'deny', edit: { '*': 'deny', 'approved/**': 'ask' } } },
    { permission: { '*': { '*': 'deny', 'shared/**': 'allow' }, edit: { 'protected/**': 'deny' } },
      expected: { '*': { '*': 'deny', 'shared/**': 'allow' }, edit: { '*': 'deny', 'shared/**': 'ask', 'protected/**': 'deny' } } },
    { permission: { edit: { 'approved/**': 'allow' }, '*': 'deny' },
      expected: { edit: { 'approved/**': 'ask', '*': 'deny' }, '*': 'deny' }, expectedOrder: ['approved/**', '*'] },
    { configured: { '*': 'deny', edit: { '*': 'deny', 'approved/**': 'allow', 'secret/**': 'deny' } },
      permission: { edit: { 'approved/**': 'deny', 'new/**': 'allow' }, bash: 'deny' },
      expected: { edit: { '*': 'deny', 'approved/**': 'deny', 'secret/**': 'deny', 'new/**': 'ask' }, bash: 'deny' } },
    { configured: { edit: { 'approved/**': 'allow' }, '*': 'deny' }, permission: { edit: { 'new/**': 'allow' } },
      expected: { edit: { 'approved/**': 'ask', 'new/**': 'ask', '*': 'deny' } }, expectedOrder: ['approved/**', 'new/**', '*'] },
    { permission: { 'e*': 'deny' }, expectedError: /permission name "e\*" matches edit/ },
    { permission: { edit: 'ask', '*': 'allow' }, expectedError: /permission '\*' allows operations after edit rules/ },
    { permission: {}, configured: { '*': 'deny', edit: { 'approved/**': 'allow' } }, expectedError: /inline edit pattern order would change/ },
    { permission: {}, configured: { edit: { 'protected/**': 'deny' } }, expectedError: /inline edit pattern order would change/ },
    { providerName: 'pangea-nga', permission: null, expected: null },
    { permission: null, expectedError: /OpenCode permission must be/ },
  ])('scopes OpenCode permission rules without relaxing denial $permission', async ({ providerName = 'pangea-opencode', permission, configured, expected, expectedError, expectedOrder }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'pangea-acp-permissions-'))
    const context = new Context()
    let provider, run
    applyAcpProvider({ logger: { warn() {} }, subprocess: new LocalSubprocessRuntime(context), subagents: { registerProvider(value) { provider = value } } }, {
      providerName, command: process.execPath, args: [fixture], cwd: projectRoot, permission: 'allow',
      env: { PANGEA_TEST_APP_ROOT: projectRoot, PANGEA_TEST_SCRATCH: '1', OPENCODE_PERMISSION: JSON.stringify(permission),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: configured ?? {} }) }, disposeEofGraceMs: 1000, disposeGraceMs: 1000,
    })
    try {
      const request = { scratchDirectory: root, prompt: [{ type: 'text', text: 'REPORT_SCRATCH' }], signal: new AbortController().signal }
      if (expectedError) { await expect(provider.start(request)).rejects.toThrow(expectedError); return }
      run = await provider.start(request)
      const report = JSON.parse((await run.result).output.map(item => item.text ?? '').join(''))
      expect(JSON.parse(report.env.OPENCODE_PERMISSION)).toEqual(expected)
      if (expectedOrder) expect(Object.keys(JSON.parse(report.env.OPENCODE_PERMISSION).edit)).toEqual(expectedOrder)
      if (providerName === 'pangea-opencode') {
        for (const file of ['ordinary/file', 'approved/file', 'secret/file', 'new/file', 'shared/file', 'protected/file']) {
          const before = openCodeEditAction(configured, permission, file)
          const after = openCodeEditAction(configured, JSON.parse(report.env.OPENCODE_PERMISSION), file)
          expect(after, `effective edit permission for ${file}`).toBe(before === 'deny' ? 'deny' : 'ask')
        }
      }
    } finally {
      await run?.dispose()
      await context.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 10000)

  it('runs the packaged verification registration, continuation, and cancellation on the native path', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.join(projectRoot, 'scripts/verify-packaged-acp-batch-launch.mjs'), '--native',
    ], { cwd: projectRoot, env: { ...process.env, PANGEA_TEST_APP_ROOT: projectRoot }, timeout: 20_000 })
    const report = JSON.parse(stdout)
    expect(report.status).toBe('ok')
    expect(report.results.some(result => result.sameSessionContinuation === true && result.launcherKind === 'direct')).toBe(true)
    expect(report.results.some(result => result.cancellation === 'aborted')).toBe(true)
  }, 25_000)

  it.each([
    { command: process.execPath, cwd: projectRoot },
    ...(process.platform === 'win32' ? [] : [{ command: `./${path.basename(process.execPath)}`, cwd: path.dirname(process.execPath) }]),
  ])('keeps native command $command on the direct subprocess path', async ({ command, cwd }) => {
    const serviceContext = new Context()
    let provider
    const ctx = {
      logger: { warn() {} },
      subagents: { registerProvider(value) { provider = value } },
    }
    ctx.subprocess = new LocalSubprocessRuntime(serviceContext)
    applyAcpProvider(ctx, {
      providerName: 'fixture-acp',
      command,
      configuredCommand: 'fixture-agent',
      args: [fixture],
      cwd,
      permission: 'allow',
      env: { PANGEA_TEST_APP_ROOT: projectRoot },
      disposeEofGraceMs: 1_000,
      disposeGraceMs: 1_000,
    })

    let run
    try {
      run = await provider.start({
        prompt: [{ type: 'text', text: 'fixture prompt' }],
        parent: { session: { header: { cwd: projectRoot } } },
        signal: new AbortController().signal,
      })
      const result = await run.result
      expect(result.stopReason).toBe('completed')
      expect(result.output.map(item => item.type === 'text' ? item.text : '').join('')).toContain('ACP_BATCH_READY')
      expect(run.launch).toMatchObject({
        configuredCommand: 'fixture-agent',
        resolvedCommand: command,
        launcherKind: 'direct',
        launcherCommand: command,
        cwd,
      })
      expect(run.processId).toBeGreaterThan(0)
    } finally {
      await run?.dispose?.()
      await serviceContext.fiber.dispose()
    }
  })
})
