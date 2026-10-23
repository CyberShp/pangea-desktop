import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const stage = path.join(root, '.pangea-build')
const components = JSON.parse(await readFile(path.join(root, 'pangea.components.json'), 'utf8'))
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const pythonLock = components.pythonMacosArm64
const run = (command, args, cwd = root, env = {}) => execFileSync(command, args, {
  cwd, env: { ...process.env, ...env }, stdio: 'inherit', timeout: 30 * 60 * 1000
})
const output = (command, args, cwd = root) => execFileSync(command, args, {
  cwd, encoding: 'utf8', timeout: 60_000
}).trim()
const reset = async relative => {
  const destination = path.resolve(stage, relative)
  if (!destination.startsWith(stage + path.sep)) throw new Error(`Unsafe staging path: ${relative}`)
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  return destination
}
const digest = async filename => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}
const materialize = async (name, lock) => {
  const destination = await reset(`sources/${name}`)
  run('git', ['init', destination])
  run('git', ['-C', destination, 'remote', 'add', 'origin', lock.repository])
  run('git', ['-C', destination, 'fetch', '--depth=1', 'origin', lock.commit])
  run('git', ['-C', destination, 'checkout', '--detach', 'FETCH_HEAD'])
  if (output('git', ['rev-parse', 'HEAD'], destination) !== lock.commit) throw new Error(`${name}: commit mismatch`)
  return destination
}

run(process.execPath, ['scripts/verify-target.mjs', 'darwin', 'arm64'])
if (!pythonLock?.sha256 || pythonLock.version !== components.python.version) throw new Error('Missing matching locked macOS Python')
await mkdir(stage, { recursive: true })
await writeFile(path.join(stage, 'components.resolved.json'), JSON.stringify(components, null, 2) + '\n')
const dsh = await materialize('dsh-pangea', components.dshPangea)
const agent = await materialize('pangea-agent', components.pangeaAgent)
run(process.execPath, ['scripts/verify-product-composition.mjs', path.join(dsh, 'plugins/dsh-pangea/cordis.patch.yml'), path.join(root, 'packages/dsh-pangea-product/cordis.patch.yml')])

const plugins = await reset('plugins')
for (const name of ['dsh-pangea', 'dsh-pangea-companion', 'dsh-pangea-asset-catalog']) {
  const destination = path.join(plugins, name)
  await cp(path.join(dsh, 'plugins', name), destination, { recursive: true })
  run(process.execPath, [path.join(destination, 'scripts/build-client.mjs')])
}
const pythonRoot = await reset('runtime/python')
const runtime = await reset('runtime/pangea-runtime')
const cache = path.join(stage, 'cache')
await mkdir(cache, { recursive: true })
const archive = path.join(cache, `python-${pythonLock.version}-macos-arm64.tar.gz`)
if (!existsSync(archive) || await digest(archive) !== pythonLock.sha256) {
  run('curl', ['--fail', '--location', '--retry', '3', '--output', archive, pythonLock.url])
}
if (await digest(archive) !== pythonLock.sha256) throw new Error('macOS Python archive SHA256 mismatch')
run('tar', ['-xzf', archive, '--strip-components=1', '-C', pythonRoot])
for (const name of ['.agents', 'schemas', 'src', 'docs', 'pyproject.toml']) {
  await cp(path.join(agent, name), path.join(runtime, name), { recursive: true })
}
await mkdir(path.join(runtime, '.opencode'), { recursive: true })
for (const name of ['agents', 'commands', 'plugins', 'skills', 'package.json', 'package-lock.json']) {
  await cp(path.join(agent, '.opencode', name), path.join(runtime, '.opencode', name), { recursive: true })
}
const python = path.join(pythonRoot, 'bin/python3')
const bundledNode = path.join(root, 'node_modules/node/bin/node')
if (output(bundledNode, ['-p', 'process.platform + "/" + process.arch']) !== 'darwin/arm64') throw new Error('Bundled Node target mismatch')
run(python, ['-c', 'import platform, sys; assert sys.platform == "darwin" and platform.machine() == "arm64"; assert platform.python_version() == "3.12.10"'])
run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-compile', '--only-binary=:all:', '-r', path.join(root, 'build/pangea-runtime-requirements.txt')])
// Keep imports relocatable after the .app is moved or extracted on another Mac.
const sitePackages = output(python, ['-c', 'import site; print(site.getsitepackages()[0])'])
await writeFile(path.join(sitePackages, 'pangea-runtime.pth'), '../../../../pangea-runtime/src\n')
const env = { PYTHONPATH: path.join(runtime, 'src'), PYTHONNOUSERSITE: '1' }
run(python, ['-m', 'pangea_agent.cli.main', 'system', 'capabilities', '--data-root', await reset('smoke-data')], runtime, env)
for (const script of ['verify-source-snapshot.py', 'verify-analysis-scenes.py', 'verify-coverage-path-quality.py', 'verify-input-materials.py']) {
  run(python, [path.join(root, 'scripts', script)], runtime, env)
}
for (const script of ['test_case_contract.py', 'branch_behavior_contract.py', 'report_delivery_smoke.py']) {
  run(python, [path.join(agent, 'verification', script)], runtime, env)
}
await writeFile(path.join(stage, 'manifest.json'), JSON.stringify({
  schema_version: 1, built_at: new Date().toISOString(),
  product: { name: 'PANGEA Desktop Acceptance', version: pkg.version },
  target: { platform: 'darwin', arch: 'arm64' },
  acceptance: { scenarios: ['branch-analysis', 'coverage-analysis'], worker_topology: 'existing-single-analysis-worker', notarized: false },
  components: {
    desktop: { commit: output('git', ['rev-parse', 'HEAD']), upstream_branch: components.desktopBase.branch, upstream_base: components.desktopBase.commit },
    dsh_pangea: { branch: components.dshPangea.branch, commit: components.dshPangea.commit },
    pangea_agent: { branch: components.pangeaAgent.branch, commit: components.pangeaAgent.commit },
    python: { version: pythonLock.version, sha256: pythonLock.sha256 }
  }
}, null, 2) + '\n')
run(process.execPath, ['scripts/prepare-portable-update.mjs', '--output-dir', await reset('update')])
run(process.execPath, ['scripts/verify-pangea-staging.mjs', '--platform', 'darwin', '--arch', 'arm64'])
run('npm', ['run', 'typecheck'])
run('npm', ['run', 'build'])
run('npx', ['--no-install', 'electron-builder', '--dir', '--mac', '--arm64', '--config', 'electron-builder.macos.cjs', '--publish', 'never'])
const app = path.join(root, 'dist-macos/mac-arm64/PANGEA Desktop Acceptance.app')
await reset('macos-acceptance-parent')
run(process.execPath, ['scripts/verify-packaged-macos.mjs', '--app', app, '--expected-version', pkg.version, '--arch', 'arm64', '--evidence', path.join(stage, 'macos-acceptance-parent/evidence')])
const delivery = path.join(root, 'dist-macos/delivery')
await mkdir(delivery, { recursive: true })
const filename = `pangea-desktop-${pkg.version}-macos-arm64-acceptance.zip`
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, path.join(delivery, filename)])
await writeFile(path.join(delivery, `${filename}.sha256`), `${await digest(path.join(delivery, filename))}  ${filename}\n`)
await cp(path.join(stage, 'manifest.json'), path.join(delivery, 'pangea-manifest.json'))
await cp(path.join(root, 'docs/macos-acceptance.md'), path.join(delivery, '验收说明.md'))
await cp(path.join(root, 'test/fixtures/macos-acceptance'), path.join(delivery, 'acceptance-fixtures'), { recursive: true })
console.log(`Verified macOS acceptance artifact: ${path.join(delivery, filename)}`)
