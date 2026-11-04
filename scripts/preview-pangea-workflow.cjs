// Local acceptance window for the shipped plugin UI. No model/provider execution.
const { app, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const { mkdir, readdir, readFile, writeFile } = require('node:fs/promises')
const { createHash } = require('node:crypto')
const path = require('node:path')

const option = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] }
const desktop = path.resolve(option('--desktop', path.join(__dirname, '..')))
const plugins = path.resolve(option('--plugins', path.join(desktop, '.pangea-build/plugins')))
const profile = path.resolve(option('--profile', path.join(desktop, '.pangea-build/workflow-review-profile')))
const companion = path.join(plugins, 'dsh-pangea-companion')
const agent = path.resolve(option('--agent', path.join(profile, 'source-fixture')))
let server, window, stopping = false
app.setName('PANGEA UI Review')
app.setPath('userData', profile)

async function main() {
  await mkdir(profile, { recursive: true })
  const markerPath = path.join(profile, '.pangea-ui-review-profile')
  const entries = await readdir(profile)
  if (entries.length && !entries.includes('.pangea-ui-review-profile')) throw new Error('Refusing a non-empty profile without the UI review marker')
  if (!entries.length) await writeFile(markerPath, 'Isolated UI acceptance profile. Synthetic data; no provider execution.\n', { flag: 'wx' })
  await app.whenReady()
  server = spawn(process.execPath, [path.join(companion, 'scripts/preview-ui.mjs'), '--desktop', desktop, '--agent', agent, '--fixture-module', path.join(companion, 'tests/fixtures/workflow-review.mjs'), '--scene', option('--scene', 'running'), '--port', option('--port', '0')], {
    cwd: companion, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let diagnostics = ''
  server.stderr.on('data', bytes => { diagnostics += bytes; process.stderr.write(bytes) })
  const endpoint = await new Promise((resolve, reject) => {
    let text = ''
    const timeout = setTimeout(() => reject(new Error(`Preview startup timed out: ${diagnostics}`)), 30000)
    server.once('error', error => { clearTimeout(timeout); reject(error) })
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Preview server exited ${code}: ${diagnostics}`)) })
    server.stdout.on('data', bytes => {
      text += bytes
      for (const line of text.split('\n')) {
        try { const value = JSON.parse(line); if (value.url) { clearTimeout(timeout); resolve(value) } } catch {}
      }
    })
  })
  const url = new URL(endpoint.url)
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Preview must bind to localhost')
  window = new BrowserWindow({ width: 1460, height: 960, useContentSize: true, title: 'PANGEA · 工作流 UI 验收（示例数据）', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== url.origin) event.preventDefault() })
  window.webContents.on('page-title-updated', event => event.preventDefault())
  const entryUrl = new URL(endpoint.url)
  entryUrl.searchParams.set('page', option('--page', 'home'))
  await window.loadURL(entryUrl.href)
  const bundles = await Promise.all(['dsh-pangea', 'dsh-pangea-companion', 'dsh-pangea-asset-catalog'].map(async name => {
    const file = path.join(plugins, name, 'lib/client.js')
    return { name, file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') }
  }))
  const manifest = { type: 'synthetic UI acceptance; no model execution', url: endpoint.url, entryUrl: entryUrl.href, scene: option('--scene', 'running'), profile, dataRoot: endpoint.dataRoot, desktop, plugins, electron: process.versions.electron, bundles, startedAt: new Date().toISOString() }
  await writeFile(path.join(profile, 'review-instance.json'), JSON.stringify(manifest, null, 2))
  console.log('UI_REVIEW_READY', JSON.stringify(manifest))
  window.on('closed', () => app.quit())
}
app.on('before-quit', event => {
  if (stopping || !server || server.exitCode !== null) return
  event.preventDefault(); stopping = true
  server.once('exit', () => app.quit())
  server.kill('SIGTERM')
  setTimeout(() => { if (server.exitCode === null) server.kill('SIGKILL'); app.quit() }, 5000).unref()
})
main().catch(error => {
  console.error(error)
  if (!server || server.exitCode !== null) return app.exit(1)
  server.once('exit', () => app.exit(1))
  server.kill('SIGTERM')
  setTimeout(() => { server.kill('SIGKILL'); app.exit(1) }, 5000).unref()
})
