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
  for (const providerName of ['pangea-nga', 'pangea-codeagent', 'pangea-opencode']) {
    it(`marks only explicit Desktop CLI workers for ${providerName}, including original-session recovery`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'pangea-cli-transport-'))
      const context = new Context()
      const runs = []
      let provider
      const env = { PANGEA_TEST_APP_ROOT: projectRoot, PANGEA_TEST_SCRATCH: '1', PANGEA_TEST_KEEP: 'preserved',
        PANGEA_WORKER_TRANSPORT: 'standalone-custom',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'configured/model', permission: { bash: 'ask', edit: 'deny' } }),
        OPENCODE_PERMISSION: JSON.stringify({ bash: 'ask' }) }
      const originalEnv = { ...env }
      const before = process.env.PANGEA_WORKER_TRANSPORT
      applyAcpProvider({ logger: { warn() {} }, subprocess: new LocalSubprocessRuntime(context),
        subagents: { registerProvider(value) { provider = value } } }, {
        providerName, command: process.execPath, args: [fixture], cwd: projectRoot, permission: 'allow', env,
        disposeEofGraceMs: 1000, disposeGraceMs: 1000,
      })
      const request = (scratchDirectory, pangeaCliWorker) => ({ scratchDirectory, pangeaCliWorker,
        prompt: [{ type: 'text', text: 'REPORT_WORKER_TRANSPORT' }],
        parent: { session: { header: { cwd: root } } }, signal: new AbortController().signal })
      const report = result => JSON.parse(result.output.map(item => item.type === 'text' ? item.text : '').join(''))
      try {
        const attempts = await Promise.allSettled([true, false, undefined, 'true'].map(async (flag, index) => {
          const scratchDirectory = path.join(root, `worker-${index}`)
          const run = await provider.start(request(scratchDirectory, flag))
          runs.push(run)
          return { run, scratchDirectory, value: report(await run.result) }
        }))
        for (const attempt of attempts) expect(attempt.status, attempt.reason?.message).toBe('fulfilled')
        const [worker, ...others] = attempts.map(attempt => attempt.value)
        expect(worker.value.transport).toBe('desktop-cli')
        for (const item of others) {
          expect(item.value.transport).toBe('standalone-custom')
          expect(item.value.cwd).toBe(worker.value.cwd)
          expect(item.value.keep).toBe('preserved')
          expect(item.value.config).toBe(worker.value.config)
          expect(item.value.permission).toBe(worker.value.permission)
        }
        expect(worker.value.config).toBe(env.OPENCODE_CONFIG_CONTENT)
        expect(worker.value.permission).toBe(providerName === 'pangea-opencode'
          ? JSON.stringify({ bash: 'ask', edit: 'deny' }) : env.OPENCODE_PERMISSION)
        await worker.run.dispose()
        const resumed = await provider.start({ ...request(worker.scratchDirectory, true), prompt: [],
          resume: { taskId: worker.run.id, remoteSessionId: worker.run.remoteSessionId } })
        runs.push(resumed)
        expect(resumed.id).toBe(worker.run.id)
        const restored = report(await resumed.continuePrompt([{ type: 'text', text: 'REPORT_WORKER_TRANSPORT' }]))
        expect(restored).toEqual(worker.value)
        expect(process.env.PANGEA_WORKER_TRANSPORT).toBe(before)
        expect(env).toEqual(originalEnv)
      } finally {
        await Promise.allSettled(runs.map(run => run.dispose()))
        await context.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      }
    }, 15000)
  }

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

  for (const providerName of ['pangea-codeagent', 'native-fixture']) {
    it(`handles CodeAgent raw paths and explicit reject options for ${providerName}`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'pangea-permission-'))
      const scratchDirectory = path.join(root, 'scratch')
      const context = new Context()
      let provider, run
      applyAcpProvider({ logger: { warn() {} }, subprocess: new LocalSubprocessRuntime(context), subagents: { registerProvider(value) { provider = value } } }, {
        providerName, command: process.execPath, args: [fixture], cwd: projectRoot, permission: 'allow',
        env: { PANGEA_TEST_APP_ROOT: projectRoot }, disposeEofGraceMs: 1000, disposeGraceMs: 1000,
      })
      const allowed = { outcome: { outcome: 'selected', optionId: 'once' } }
      const rejected = { outcome: { outcome: 'selected', optionId: 'reject' } }
      try {
        run = await provider.start({ scratchDirectory, prompt: [], signal: new AbortController().signal,
          parent: { session: { header: { cwd: root } } } })
        await run.result
        const probe = async (request, stopReason = 'end_turn') => {
          const result = await run.continuePrompt([{ type: 'text', text: `PERMISSION ${JSON.stringify(request)}` }])
          expect(result.protocolStopReason).toBe(stopReason)
          return JSON.parse(result.output.map(item => item.text ?? '').join(''))
        }
        const inside = path.join(scratchDirectory, 'new', 'unit1.json')
        const outside = path.join(root, 'outside.json')
        const edit = (filepath, extra = {}) => ({ kind: 'edit', rawInput: { filepath, diff: 'fixture', is_danger: false }, ...extra })
        expect(await probe(edit(inside, { write: true }))).toEqual(providerName === 'pangea-codeagent' ? allowed : rejected)
        expect(await access(inside).then(() => true, () => false)).toBe(providerName === 'pangea-codeagent')
        for (const filepath of [outside, '', 'relative.json', null]) expect(await probe(edit(filepath, { write: true }))).toEqual(rejected)
        expect(await probe({ kind: 'edit' })).toEqual(rejected)
        for (const locations of [[], [{ path: outside }]]) expect(await probe(edit(inside, { locations }))).toEqual(rejected)
        if (providerName === 'pangea-codeagent') {
          expect(await probe(edit(outside, { locations: [{ path: inside }] }))).toEqual(rejected)
          const escape = path.join(scratchDirectory, 'escape')
          await symlink(root, escape, process.platform === 'win32' ? 'junction' : 'dir')
          expect(await probe(edit(path.join(escape, 'outside.json')))).toEqual(rejected)
        }
        for (const kind of ['delete', 'move']) expect(await probe(edit(inside, { kind }))).toEqual(rejected)
        // Use the offered opaque reject ID, never a hardcoded option name or persistent policy.
        expect(await probe(edit(outside, { options: [
          { optionId: 'persistent', kind: 'reject_always', name: 'Never' },
          { optionId: 'deny-opaque-42', kind: 'reject_once', name: 'No' },
        ] }))).toEqual({ outcome: { outcome: 'selected', optionId: 'deny-opaque-42' } })
        expect(await probe(edit(outside, { options: [{ optionId: 'always', kind: 'allow_always', name: 'Always' }] }), 'cancelled'))
          .toEqual({ outcome: { outcome: 'cancelled' } })
        expect(await access(outside).then(() => true, () => false)).toBe(false)
        // A denied permission must not strand the next turn in the ACP fixture.
        expect(await probe({ kind: 'read' })).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } })
      } finally {
        await run?.dispose()
        await context.fiber.dispose()
        await rm(root, { recursive: true, force: true })
      }
    }, 20000)
  }

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
    const rejected = { outcome: { outcome: 'selected', optionId: 'reject' } }
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
      expect(await probe(runs[0], native(targets[0], { options: [{ optionId: 'always', kind: 'allow_always', name: 'Always' }] }))).toEqual({ outcome: { outcome: 'cancelled' } })
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
