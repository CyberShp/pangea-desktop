// Packaged macOS smoke only. No model calls, worker-split acceptance, or measured coverage claims.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeNativeDiagramFixture, verifyNativeDiagrams } from './native-diagram-smoke.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export function parseOptions(args) {
  const options = { arch: process.arch, timeoutSeconds: 180 }
  const names = { '--app': 'app', '--expected-version': 'version', '--arch': 'arch', '--evidence': 'evidence', '--timeout-seconds': 'timeoutSeconds' }
  for (let index = 0; index < args.length; index++) {
    const name = names[args[index]]
    if (!name || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Invalid argument: ${args[index]}`)
    options[name] = args[++index]
  }
  assert.ok(options.app && options.version, 'Usage: node scripts/verify-packaged-macos.mjs --app <file.app> --expected-version <version> [--arch arm64|x64] [--evidence <new-directory>] [--timeout-seconds 180]')
  assert.ok(['arm64', 'x64'].includes(options.arch), 'Expected architecture must be arm64 or x64')
  options.timeoutSeconds = Number(options.timeoutSeconds)
  assert.ok(Number.isInteger(options.timeoutSeconds) && options.timeoutSeconds >= 10 && options.timeoutSeconds <= 900, 'Timeout must be 10..900 seconds')
  return options
}

export function isolatedEnvironment(root, nodeDirectory) {
  // Deliberately do not spread process.env: no inherited tokens, model config,
  // Python/Node injection, proxy settings, shell startup files, or user profiles.
  const isolatedHome = path.join(root, 'home')
  const profile = path.join(root, 'profile')
  return {
    HOME: isolatedHome, CFFIXED_USER_HOME: isolatedHome,
    PATH: [nodeDirectory, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    SHELL: '/bin/sh', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    TMPDIR: path.join(root, 'tmp') + path.sep,
    XDG_CONFIG_HOME: path.join(isolatedHome, '.config'), XDG_CACHE_HOME: path.join(isolatedHome, '.cache'),
    PANGEA_USER_DATA_DIR: profile, DSH_HOME: path.join(profile, 'harness'),
    PANGEA_LOCAL_SKILLS_ROOT: path.join(root, 'local-skills'),
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8',
    NO_COLOR: '1', CI: 'true',
  }
}

export function parseProcessGroups(text) {
  return text.trim().split('\n').filter(Boolean).map(line => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number)
    assert.ok([pid, ppid, pgid].every(Number.isSafeInteger), 'Invalid process table')
    return { pid, ppid, pgid }
  })
}

export function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function processGroupMembers(groupId) {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0, result.error?.message || result.stderr || 'Cannot inspect child process group')
  return parseProcessGroups(result.stdout).filter(item => item.pgid === groupId)
}

async function stopOwnedGroup(child) {
  if (!child?.pid) return []
  // detached spawn creates this group. Never match processes by app name/path,
  // which could terminate a separately running user instance of the same app.
  const signal = value => {
    try { process.kill(-child.pid, value) } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  signal('SIGTERM')
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!processGroupMembers(child.pid).length) return []
    await delay(100)
  }
  signal('SIGKILL')
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!processGroupMembers(child.pid).length) return []
    await delay(100)
  }
  return processGroupMembers(child.pid)
}

async function reservePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

const pythonProbe = String.raw`
import importlib, json, platform, sys
from pathlib import Path
resources, evidence, expected_arch = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve(), sys.argv[3]
actual_arch = {'aarch64':'arm64', 'x86_64':'x64', 'AMD64':'x64'}.get(platform.machine(), platform.machine())
assert sys.platform == 'darwin' and actual_arch == expected_arch, (sys.platform, actual_arch)
assert Path(sys.executable).resolve().is_relative_to(resources), sys.executable
modules = {}
for name in ['pangea_agent.cli.main', 'langgraph.graph', 'pydantic_core', 'openpyxl', 'PIL._imaging', 'pypdf', 'docx', 'tree_sitter', 'tree_sitter_c', 'tree_sitter_cpp']:
    module = importlib.import_module(name)
    location = Path(module.__file__).resolve()
    assert location.is_relative_to(resources), (name, str(location))
    modules[name] = str(location)
from pangea_agent.assets import import_asset, prepare_asset_extraction, asset_detail
from pangea_agent.agent_io import write_json, read_json
from pangea_agent.cli.run_module_analysis import run_module_analysis, resume_module_analysis
from pangea_agent.documents.coverage import parse_coverage_combined, relevant_zero_coverage
data = evidence / 'synthetic-data'
repo = data / 'repositories' / 'sample' / 'module'
repo.mkdir(parents=True)
(repo / 'tls.c').write_text('int connect_session(int ready) {\n    if (!ready) return -1;\n    return 0;\n}\n', encoding='utf-8')
coverage = evidence / 'synthetic-coverage.json'
write_json(coverage, {'status':'success', 'scope':{'requested':'module','recursive':True},
    'query_input':{'product':'synthetic-fixture','c_version':'synthetic-only','source':'summary'},
    'snapshot':{'stable':False,'sources':[{'source':'summary','coverage_timestamp':'synthetic'}]},
    'source_semantics':{'preferred':'summary'},
    'summary':{'per_source':[{'source':'summary'}]},
    'uncovered':{
        'functions':[{'source':'summary','relative_path':'module/tls.c','uncovered_functions':['connect_session']}],
        'lines':[{'source':'summary','relative_path':'module/tls.c','uncovered_lines':[2]}],
        'branches':[{'source':'summary','relative_path':'module/tls.c','uncovered_branches':[{'line':2,'block':'0','branch':'0','count':0}]}]},
    'indeterminate':{'branches':[{'source':'summary','relative_path':'module/tls.c','indeterminate_branches':[{'line':2,'block':'0','branch':'1','count':'-'}]}]}})
parsed = parse_coverage_combined(coverage)
assert len(parsed['records']) == 4
assert len(relevant_zero_coverage({'matched':parsed['records']})) == 3
asset = import_asset(str(data), str(coverage), 'coverage', 'Synthetic packaged smoke only')
prepare_asset_extraction(str(data), asset.asset_id)
revision = asset_detail(str(data), asset.asset_id)['asset']['input_revision']
scenes = []
for scenario in ['branch-analysis', 'coverage-analysis']:
    run_id = 'packaged-' + scenario
    contract = {'data_root':str(data),'run_id':run_id,'repository':'sample','target':'Synthetic connection smoke',
        'workflow_version':'source-first-v1','analysis_profile':'behavior-test-v2','source_scope':['module'],
        'analysis_settings':{'scenario':scenario,'mode':'depth','objective':'interface-contract'},
        'asset_ids':[asset.asset_id], 'asset_revisions':{asset.asset_id:revision}}
    request = evidence / (run_id + '.json')
    write_json(request, contract)
    result = run_module_analysis(str(request))
    assert result['agent_actions'] and all(a['role'] == 'planning' for a in result['agent_actions']), result
    inputs = data / 'runs' / run_id / 'inputs'
    scene_bytes = (inputs / 'analysis-scene.json').read_bytes()
    scene = json.loads(scene_bytes)
    assert scene['id'] == scenario and scene['risk_responsibility'] == 'none', scene
    matches = read_json(inputs / 'coverage-match-summary.json')
    assert len(read_json(inputs / 'coverage-gaps.json')) == 3
    assert len([r for r in matches['matched'] if r['coverage_state'] == 'indeterminate']) == 1
    resume_module_analysis(run_id, str(data))
    assert (inputs / 'analysis-scene.json').read_bytes() == scene_bytes
    scenes.append({'scenario':scenario,'input_freeze':'passed','resume_freeze':'passed','model_dispatched':False})
print(json.dumps({'status':'ok','platform':sys.platform,'arch':actual_arch,'python':sys.version,'modules':modules,
    'scenes':scenes,'coverage_states':'3 uncovered, 1 indeterminate; synthetic only'}, ensure_ascii=False))
`

export async function verifyPackagedMac(options) {
  assert.equal(process.platform, 'darwin', 'The packaged macOS check must run on a macOS runner')
  assert.equal(process.arch, options.arch, 'Use a runner and verification Node matching the package architecture; Rosetta is not native acceptance')
  const app = await realpath(path.resolve(options.app))
  assert.ok(app.endsWith('.app'), 'Expected a packaged .app directory')
  const resources = path.join(app, 'Contents/Resources')
  const appRoot = path.join(resources, 'app')
  const python = path.join(resources, 'pangea-python/bin/python3')
  const node = path.join(appRoot, 'node_modules/node/bin/node')
  const runtime = path.join(resources, 'pangea-runtime')
  const evidence = options.evidence ? path.resolve(options.evidence) : await mkdtemp(path.join(os.tmpdir(), 'pangea-macos-smoke-'))
  assert.ok(!isWithin(app, path.join(await realpath(path.dirname(evidence)), path.basename(evidence))), 'Evidence must be outside the app bundle')
  if (options.evidence) await mkdir(evidence) // Reject existing evidence; never overwrite another run/profile.
  const env = isolatedEnvironment(evidence, path.dirname(node))
  for (const directory of [env.HOME, env.PANGEA_USER_DATA_DIR, env.TMPDIR, env.PANGEA_LOCAL_SKILLS_ROOT]) await mkdir(directory, { recursive: true })
  const results = { schema_version: 1, status: 'running', app, architecture: options.arch, version: options.version, evidence,
    scope: 'Packaged runtime, synthetic branch/coverage input freeze, deterministic diagrams, and Desktop workspace readiness only',
    business_acceptance: 'not_run', worker_split_acceptance: 'not_run', measured_coverage_improvement: 'not_measured', checks: [] }
  let desktop, interrupted
  const onSignal = signal => { interrupted = new Error(`Interrupted by ${signal}`) }
  const onInterrupt = () => onSignal('SIGINT'), onTerminate = () => onSignal('SIGTERM')
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onTerminate)
  async function run(label, executable, args, commandEnv = env) {
    if (interrupted) throw interrupted
    const child = spawn(executable, args, { env: commandEnv, cwd: evidence, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 8 * 1024 * 1024) child.kill('SIGTERM') })
    child.stderr.on('data', data => { stderr += data; if (stderr.length > 8 * 1024 * 1024) child.kill('SIGTERM') })
    let timeout
    try {
      const status = await new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 120_000)
        child.once('error', reject)
        child.once('close', (code, signal) => resolve({ code, signal }))
      })
      await Promise.all([writeFile(path.join(evidence, `${label}.stdout.log`), stdout), writeFile(path.join(evidence, `${label}.stderr.log`), stderr)])
      assert.equal(status.code, 0, `${label} failed (${status.code ?? status.signal}): ${stderr.slice(-4000) || stdout.slice(-4000)}`)
      results.checks.push({ name: label, status: 'passed' })
      return stdout
    } finally {
      clearTimeout(timeout)
      const remaining = await stopOwnedGroup(child)
      assert.equal(remaining.length, 0, `${label} left child processes: ${JSON.stringify(remaining)}`)
    }
  }
  let error
  try {
    for (const file of [python, node, path.join(resources, 'pangea-manifest.json'), path.join(appRoot, 'package.json')]) await access(file)
    const executableName = (await run('bundle-executable', '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(app, 'Contents/Info.plist')])).trim()
    assert.equal(path.basename(executableName), executableName, 'Invalid CFBundleExecutable')
    const desktopExecutable = path.join(app, 'Contents/MacOS', executableName)
    const metadata = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'))
    assert.equal(metadata.version, options.version, 'Bundled package version mismatch')
    for (const [label, executable] of [['electron', desktopExecutable], ['python', python], ['node', node]]) {
      const description = await run(`${label}-mach-o`, '/usr/bin/file', ['-L', executable])
      assert.match(description, /Mach-O/, `${label} is not a Mach-O executable`)
      assert.ok(description.includes(options.arch === 'x64' ? 'x86_64' : 'arm64'), `${label} does not contain ${options.arch}`)
    }
    const nodeResult = JSON.parse(await run('node-runtime', node, ['-e', 'console.log(JSON.stringify({platform:process.platform,arch:process.arch,execPath:process.execPath,version:process.version}))']))
    assert.equal(nodeResult.platform, 'darwin'); assert.equal(nodeResult.arch, options.arch)
    assert.equal(await realpath(nodeResult.execPath), await realpath(node))
    results.node = nodeResult
    // Do not inject a checkout or even the bundled source via PYTHONPATH: this
    // validates the relocatable .pth installed in the actual Python bundle.
    const pythonEnv = { ...env, PANGEA_RUNTIME_ROOT: runtime }
    results.python = JSON.parse(await run('python-branch-coverage', python, ['-X', 'utf8', '-c', pythonProbe, resources, evidence, options.arch], pythonEnv))
    const capabilities = JSON.parse(await run('capabilities', python, ['-m', 'pangea_agent.cli.main', 'system', 'capabilities', '--data-root', path.join(evidence, 'synthetic-data')], pythonEnv))
    assert.equal(capabilities.ok, true, 'Capabilities CLI returned a business error')
    const scenes = capabilities.result.source_first.analysis_options_by_profile['behavior-test-v2'].scenarios
    for (const scenario of ['branch-analysis', 'coverage-analysis']) assert.ok(scenes.includes(scenario), `Missing ${scenario} capability`)
    results.diagrams = JSON.parse(await run('native-diagrams', node, [scriptPath, '--probe-diagrams', path.join(appRoot, 'node_modules/dsh-pangea-companion'), path.join(evidence, 'diagram-fixture')]))

    const health = path.join(env.PANGEA_USER_DATA_DIR, 'updates/packaged-macos-healthy.json')
    await mkdir(path.dirname(health), { recursive: true })
    const stdout = createWriteStream(path.join(evidence, 'desktop.stdout.log'), { flags: 'wx' })
    const stderr = createWriteStream(path.join(evidence, 'desktop.stderr.log'), { flags: 'wx' })
    const launchedAt = Date.now()
    // Exercise the product's own bytecode setting, as a Finder launch would.
    const desktopEnv = { ...env, PANGEA_MOBILE_PORT: String(await reservePort()) }
    delete desktopEnv.PYTHONDONTWRITEBYTECODE
    desktop = spawn(desktopExecutable, [`--pangea-update-health=${health}`], {
      cwd: evidence, env: desktopEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let desktopError
    desktop.once('error', value => { desktopError = value })
    desktop.stdout.pipe(stdout); desktop.stderr.pipe(stderr)
    const deadline = Date.now() + options.timeoutSeconds * 1000
    let ready
    while (Date.now() < deadline) {
      if (interrupted) throw interrupted
      if (desktopError) throw desktopError
      if (desktop.exitCode !== null || desktop.signalCode !== null) throw new Error(`Desktop exited before readiness (${desktop.exitCode ?? desktop.signalCode})`)
      try { ready = JSON.parse(await readFile(health, 'utf8')); break } catch (value) { if (value.code !== 'ENOENT' && !(value instanceof SyntaxError)) throw value }
      await delay(250)
    }
    assert.ok(ready, `Desktop did not reach product-workspace readiness within ${options.timeoutSeconds}s; inspect ${evidence}`)
    assert.equal(ready.version, options.version)
    assert.equal(ready.pid, desktop.pid, 'Health marker came from another process')
    assert.ok(Date.parse(ready.healthy_at) >= launchedAt - 1000, 'Stale health marker')
    const workspace = path.join(env.PANGEA_USER_DATA_DIR, 'launch-root')
    await access(path.join(workspace, 'pangea-data'))
    const profile = JSON.parse(await readFile(path.join(env.DSH_HOME, 'profiles/web/package.json'), 'utf8'))
    assert.ok(profile.dsh?.profile?.bundles?.includes('dsh-pangea-product'), 'Desktop did not activate its packaged product bundle')
    results.checks.push({ name: 'desktop-product-workspace-ready', status: 'passed', pid: desktop.pid, workspace, healthy_at: ready.healthy_at })
    results.status = 'passed'
  } catch (value) { error = value; results.status = 'failed'; results.error = value.stack || String(value) }
  finally {
    try {
      const remaining = await stopOwnedGroup(desktop)
      results.cleanup = { remaining_processes: remaining }
      assert.equal(remaining.length, 0, 'Packaged Desktop left owned child processes')
    } catch (value) { results.status = 'failed'; results.cleanup_error = String(value); error ??= value }
    process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate)
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify(results, null, 2) + '\n')
  }
  console.log(JSON.stringify({ status: results.status, evidence, result: path.join(evidence, 'result.json'), scope: results.scope }))
  if (error) throw error
  return results
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  if (process.argv[2] === '--probe-diagrams') {
    const [, , , companion, evidence] = process.argv
    await mkdir(evidence)
    const fixture = await writeNativeDiagramFixture(evidence)
    console.log(JSON.stringify(await verifyNativeDiagrams(companion, fixture, path.join(evidence, 'exports'))))
  } else await verifyPackagedMac(parseOptions(process.argv.slice(2)))
}
