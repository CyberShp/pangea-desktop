// Real HTTP routes, Git and filesystem; only the model and analysis projection are fixtures.
// Run against either locked source or the companion shipped in win-unpacked.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  companion: { type: 'string' }, report: { type: 'string' },
  'require-windows': { type: 'boolean', default: false },
} })
const report = { schemaVersion: 1, status: 'failed', platform: process.platform,
  node: process.version, model: 'deterministic fixture', checks: [], startedAt: new Date().toISOString() }
let root, service, server
const savedEnv = { ...process.env }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const deadline = setTimeout(() => { console.error('Compatibility verification timed out'); process.exit(1) }, 180000)
try {
  if (values['require-windows']) assert.equal(process.platform, 'win32', 'Native Windows is required; a non-Windows pass is not acceptance')
  assert.ok(values.companion, '--companion <installed companion directory> is required')
  const companion = await realpath(values.companion)
  report.companion = companion
  report.sourceHashes = {}
  for (const file of ['src/index.js', 'src/fault-injection.js', 'src/repositories/git-source.js']) {
    report.sourceHashes[file] = hash(await readFile(path.join(companion, file)))
  }
  const load = file => import(pathToFileURL(path.join(companion, 'src', file)).href)
  const { sourceGit, compareSnapshot } = await load('repositories/git-source.js')
  const { FaultInjectionService, injectionGit } = await load('fault-injection.js')
  const { repositoryRouteHandler, faultInjectionRouteHandler } = await load('index.js')
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pfi-')))
  // Never inherit credentials, signing, autocrlf or longpaths from the developer/runner.
  const gitconfig = path.join(root, 'gitconfig')
  await writeFile(gitconfig, '[core]\n longpaths = false\n autocrlf = true\n[commit]\n gpgsign = false\n[user]\n name = Compatibility fixture\n email = fixture@example.test\n')
  for (const key of Object.keys(process.env)) if (key.startsWith('GIT_CONFIG_') || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'].includes(key)) delete process.env[key]
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })
  const rawGit = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trimEnd()
  report.git = rawGit(root, ['--version'])
  const configBefore = await readFile(gitconfig)
  const dataRoot = path.join(root, 'profile with spaces', 'pangea-data')
  const source = path.join(root, 'source'), remote = path.join(root, 'remote.git')
  await mkdir(source)
  await mkdir(dataRoot, { recursive: true })
  await mkdir(path.join(root, '.agents', 'pangea'), { recursive: true })
  await writeFile(path.join(root, '.agents', 'pangea', 'dsh.md'), 'compatibility fixture')
  await sourceGit(source, ['init', '-b', 'personal-A'])
  await sourceGit(source, ['config', '--local', 'core.longpaths', 'false'])
  // Keep the repository root below MAX_PATH; put depth in tracked file names.
  const relative = [...Array.from({ length: 9 }, (_, i) => `layer-${i}-${'x'.repeat(25)}`), 'target.c'].join('/')
  assert.ok(relative.length > 280, `tracked relative path must exceed MAX_PATH: ${relative.length}`)
  report.trackedRelativePathLength = relative.length
  const original = 'int operation(void) { return 0; }\n'
  const files = new Map([[relative, Buffer.from(original)], ['bom.c', Buffer.from('\ufefffirst\n')],
    ['binary.dat', Buffer.from([0, 10, 65])], ['invalid.dat', Buffer.from([255, 10, 65])]])
  // Match the incident's 212 text files, including a BOM and a deeply nested file.
  for (let i = 0; i < 210; i++) files.set(`text-${i}.c`, Buffer.from(`int value_${i};\n`))
  await writeFile(path.join(source, '.gitattributes'), '*.c text eol=lf\n*.dat -text\n')
  for (const [file, bytes] of files) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true })
    await writeFile(path.join(source, file), bytes)
  }
  await sourceGit(source, ['add', '.'])
  // Seed the deep tracked entry explicitly, like Git for Windows t2031. Directory
  // discovery during `add .` is not the checkout behavior this fixture measures.
  const deepBlob = execFileSync('git', ['-C', source, 'hash-object', '-w', '--stdin'],
    { input: original, encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim()
  await sourceGit(source, ['update-index', '--add', '--cacheinfo', '100644', deepBlob, relative])
  await sourceGit(source, ['commit', '-m', 'compatibility baseline'])
  assert.ok((await sourceGit(source, ['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n').includes(relative), 'deep fixture must exist in the committed tree')
  const base = await sourceGit(source, ['rev-parse', 'HEAD'])
  await sourceGit(root, ['clone', '--bare', '--', source, remote])
  await sourceGit(source, ['remote', 'add', 'origin', remote])
  // A negative control proves this fixture triggers the Windows failure without the fix.
  if (process.platform === 'win32') {
    const control = path.join(root, 'negative-control')
    rawGit(root, ['clone', '--no-checkout', '--', source, control])
    rawGit(control, ['config', '--local', 'core.longpaths', 'false'])
    report.negativeControl = {
      config: rawGit(control, ['config', '--show-origin', '--get', 'core.longpaths']),
      tracked: rawGit(control, ['ls-tree', '-r', '--name-only', base]).split('\n').filter(file => file === relative).join(''),
    }
    assert.equal(report.negativeControl.tracked, relative)
    assert.throws(() => execFileSync('git', ['-c', 'core.longpaths=false', '-C', control, 'checkout', '--detach', base],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 }), /Filename too long|filename.*long/i)
    report.checks.push('unfixed Windows checkout fails on the same deep file')
  }
  for (const [name, git] of [['sourceGit', sourceGit], ['injectionGit', injectionGit]]) {
    assert.equal(await git(source, ['config', '--get', 'core.longpaths']), 'true')
    assert.equal(rawGit(source, ['config', '--local', '--get', 'core.longpaths']), 'false')
    const target = path.join(root, name)
    await git(root, ['clone', '--no-checkout', '--', source, target])
    await git(target, ['checkout', '--detach', base])
    assert.equal(await git(target, ['status', '--porcelain']), '')
    assert.equal(await git(target, ['branch', '--show-current']), '')
    assert.equal(await readFile(path.join(target, relative), 'utf8'), original)
    assert.equal(rawGit(target, ['config', '--get', 'core.longpaths']), 'false')
    report.checks.push(`${name}: deep-file clone and detached checkout, config unchanged`)
  }
  const run = { run_id: 'compat-run', repositories: ['target'], details: { test_cases: [{ projection_id: 'case/A', title: 'compatibility' }] } }
  const snapshot = path.join(dataRoot, 'runs', run.run_id, 'inputs', 'source', 'target')
  const frozen = new Map()
  for (const [file, bytes] of files) {
    const value = file.endsWith('.c') ? Buffer.from(bytes.toString('utf8').replace(/\n/g, '\r\n')) : bytes
    await mkdir(path.dirname(path.join(snapshot, file)), { recursive: true })
    await writeFile(path.join(snapshot, file), value)
    frozen.set(file, value)
  }
  const compare = () => compareSnapshot(source, base, snapshot)
  let comparison = await compare()
  assert.equal(comparison.changed_count, 0)
  assert.equal(comparison.eol_only_count, 212)
  await writeFile(path.join(snapshot, 'text-0.c'), 'int changed;\r\n')
  comparison = await compare()
  assert.equal(comparison.changed_count, 1)
  assert.equal(comparison.eol_only_count, 211)
  await writeFile(path.join(snapshot, 'text-0.c'), frozen.get('text-0.c'))
  // Binary, invalid UTF-8, BOM removal and a file absent from Git must not be normalized away.
  await writeFile(path.join(snapshot, 'binary.dat'), Buffer.from([0, 13, 10, 65]))
  await writeFile(path.join(snapshot, 'invalid.dat'), Buffer.from([255, 13, 10, 65]))
  await writeFile(path.join(snapshot, 'bom.c'), 'first\r\n')
  await writeFile(path.join(snapshot, 'not-in-git.c'), 'new\r\n')
  comparison = await compare()
  assert.equal(comparison.changed_count, 4)
  assert.equal(comparison.eol_only_count, 211)
  for (const file of ['binary.dat', 'invalid.dat', 'bom.c']) await writeFile(path.join(snapshot, file), frozen.get(file))
  await rm(path.join(snapshot, 'not-in-git.c'))
  report.checks.push('212 CRLF-only files; real edit 1/211; BOM, binary, invalid UTF-8 and untracked content stay visible')
  let generated = 0
  service = new FaultInjectionService({ generate: async ({ record }) => {
    generated++
    if (record.instructions === 'fail') throw new Error('compatibility generator failure')
    const checkout = record.repositories[0].path
    assert.ok(checkout.length < 240, `repository root is too long: ${checkout.length}`)
    assert.ok(path.join(checkout, relative).length > 280)
    assert.equal(await injectionGit(checkout, ['branch', '--show-current']), '')
    report.paths = { checkoutLength: checkout.length, fileLength: path.join(checkout, relative).length }
    return { points: [{ id: 'p', repo_id: 'target', path: relative }],
      profiles: [{ case_key: 'case/A', point_ids: ['p'], steps: ['deterministic compatibility fixture'] }],
      edits: [{ repo_id: 'target', path: relative, before: 'return 0;', after: 'return -1;' }] }
  } })
  server = createServer((req, res) => {
    const handler = req.url.startsWith('/api/pangea-companion/repositories')
      ? repositoryRouteHandler(req, res)
      : faultInjectionRouteHandler(req, res, service, {}, { resolveRoot: async () => dataRoot, readRun: async () => run })
    Promise.resolve(handler).catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: error.message })) })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${server.address().port}`
  async function request(endpoint, input = {}, method = 'POST') {
    const payload = { data_root: dataRoot, cwd: root, run_id: run.run_id, ...input }
    const url = `${address}/api/pangea-companion/${endpoint}`
    const response = await fetch(`${url}?${new URLSearchParams(method === 'GET' ? payload : { data_root: dataRoot, cwd: root })}`, {
      method, headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30000),
    })
    const body = await response.json()
    assert.ok(response.ok, JSON.stringify({ status: response.status, body }))
    return body
  }
  async function terminal(id) {
    const until = Date.now() + 60000
    while (Date.now() < until) {
      const { task } = await request('fault-injection', { task_id: id }, 'GET')
      if (!['preparing', 'generating', 'pushing'].includes(task.status)) return task
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('HTTP task did not reach terminal state')
  }
  await request('repositories', { source_path: source, repository_name: 'target' })
  await request('repositories', { action: 'configure-repository', repository_name: 'target', git_path: source, base_ref: 'personal-A', personal_branch: 'personal-A' })
  const { defaults } = await request('fault-injection', {}, 'GET')
  assert.equal(defaults.repositories[0].comparison.changed_count, 0)
  assert.equal(defaults.repositories[0].comparison.eol_only_count, 212)
  const generate = instructions => request('fault-injection', { action: 'generate', case_keys: ['case/A'], provider_id: 'fixture', agent_model: 'fixture', instructions })
  const started = await generate('')
  const ready = await terminal(started.task.id)
  assert.equal(ready.status, 'ready', ready.error)
  assert.match(ready.repositories[0].diff, /return -1;/)
  assert.equal(await sourceGit(source, ['rev-parse', 'HEAD']), base)
  assert.equal(await readFile(path.join(source, relative), 'utf8'), original)
  report.checks.push('HTTP import/configure/defaults/generate: preparing reaches ready with a deep-file diff and detached HEAD')
  const failed = await terminal((await generate('fail')).task.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /compatibility generator failure/)
  const recovered = await terminal((await generate('')).task.id)
  assert.equal(recovered.status, 'ready', recovered.error)
  assert.notEqual(recovered.repositories[0].path, ready.repositories[0].path)
  assert.equal(generated, 3)
  report.checks.push('HTTP generation failure remains visible; next generation recovers in a separate checkout')
  for (const [file, bytes] of frozen) assert.deepEqual(await readFile(path.join(snapshot, file)), bytes)
  assert.equal(await sourceGit(source, ['rev-parse', 'HEAD']), base)
  assert.equal(await sourceGit(remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/']), 'refs/heads/personal-A')
  assert.equal(rawGit(source, ['config', '--local', '--get', 'core.longpaths']), 'false')
  assert.deepEqual(await readFile(gitconfig), configBefore)
  report.checks.push('snapshots, source HEAD, remote branches and Git config unchanged')
  report.status = 'passed'
} catch (error) {
  report.error = error.stack || String(error)
  process.exitCode = 1
} finally {
  try {
    if (service) await service.dispose()
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) { report.status = 'failed'; report.cleanupError = String(error); process.exitCode = 1 }
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  clearTimeout(deadline)
  report.finishedAt = new Date().toISOString()
  if (values.report) {
    await mkdir(path.dirname(path.resolve(values.report)), { recursive: true })
    await writeFile(values.report, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(JSON.stringify(report, null, 2))
}
