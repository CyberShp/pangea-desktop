import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageRoot = resolve(process.env.DSH_B11_PACKAGE_ROOT ?? join(repoRoot, 'node_modules/dsh-better-sidebar'))
const sourceRoot = join(packageRoot, 'src/client')
const workRoot = resolve(repoRoot, '../../artifacts/uiux-implementation/B11/work')
const runName = packageRoot.includes('replay-final-') ? 'replay' : 'patch-root'
const runId = process.env.DSH_B11_BEHAVIOR_RUN ?? String(Date.now())
const testDir = join(workRoot, `behavior-${runId}-${runName}`)
const editorBundlePath = resolve(process.env.DSH_B11_EDITOR_BUNDLE ?? join(packageRoot, 'lib/client-editor.js'))
const baselineNodeModules = resolve(repoRoot, '../../runtime-validation/test116-fix-20260923/app/resources/app/node_modules')
const esbuild = createRequire(join(repoRoot, 'package.json'))(resolve(workRoot, 'tooling/node_modules/esbuild'))
const { chromium } = createRequire(join(repoRoot, 'package.json'))('C:/Users/sr1shepard/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')

assert.ok(!existsSync(testDir), `Refusing to overwrite existing behavior test directory: ${testDir}`)
await mkdir(testDir, { recursive: true })

const dynamicEntry = `
import assert from 'node:assert/strict'
import { createBetterSidebarService } from './service.ts'
import { allLeaves, createSidebarStore } from './state.ts'
globalThis.window = { setTimeout, clearTimeout }
globalThis.localStorage = { getItem: () => null, setItem: () => {} }
const store = createSidebarStore()
store.setSession('b11-return-file-list')
const service = createBetterSidebarService(store)
const initial = allLeaves(store.getSnapshot().state.splits).flatMap(leaf => leaf.tabs).find(tab => tab.type === 'editor')
assert.ok(initial, 'default editor tab exists')
service.updateTab(initial.id, { title: 'cpuload.c', path: 'src/cpuload.c' })
let selected = allLeaves(store.getSnapshot().state.splits).flatMap(leaf => leaf.tabs).find(tab => tab.id === initial.id)
assert.equal(selected.path, 'src/cpuload.c')
service.updateTab(initial.id, { title: '文件', path: undefined })
selected = allLeaves(store.getSnapshot().state.splits).flatMap(leaf => leaf.tabs).find(tab => tab.id === initial.id)
assert.equal(selected.path, 'src/cpuload.c', 'service ignores undefined, confirming it cannot clear the path')
service.updateTab(initial.id, { title: '文件', path: '' })
selected = allLeaves(store.getSnapshot().state.splits).flatMap(leaf => leaf.tabs).find(tab => tab.id === initial.id)
assert.equal(selected.path, '')
assert.equal(selected.title, '文件')
const path = selected.path ?? ''
const view = { showEmpty: path === '', selectedPath: path === '' ? null : path, errorBodyVisible: path !== '' }
assert.deepEqual(view, { showEmpty: true, selectedPath: null, errorBodyVisible: false })
console.log(JSON.stringify({ service: 'passed', pathCleared: true, selectedFileCleared: view.selectedPath === null, errorBodyCleared: !view.errorBodyVisible }))
`

const reactStub = `
export function useEffect() {}
export function useState(value) { return [typeof value === 'function' ? value() : value, () => {}] }
`
const reactStubPath = join(testDir, 'react-stub.mjs')
await writeFile(reactStubPath, reactStub)
const serviceBundle = await esbuild.build({
  stdin: { contents: dynamicEntry, resolveDir: sourceRoot, sourcefile: 'service-reducer-test.mts', loader: 'ts' },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  nodePaths: [baselineNodeModules],
  alias: { react: reactStubPath },
})
const serviceBundlePath = join(testDir, 'service-reducer-test.mjs')
await writeFile(serviceBundlePath, serviceBundle.outputFiles[0].contents)
await import(`${pathToFileURL(serviceBundlePath).href}?run=${Date.now()}`)

let writeMode = 'success'
const writes = []
const testEntryPage = `
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'
const root = createRoot(document.getElementById('root'))
const IconCheckOutline16 = () => React.createElement('span', { 'aria-hidden': 'true' }, '✓')
const MarkdownText = ({ text }) => React.createElement('pre', { 'data-testid': 'markdown-source' }, text)
const iconStub = () => React.createElement('span', { 'aria-hidden': 'true' })
const primitives = new Proxy({ IconCheckOutline16, MarkdownText }, { get: (target, key) => key in target ? target[key] : typeof key === 'string' && key.startsWith('Icon') ? iconStub : undefined })
const externals = { react: React, 'react-dom': ReactDOM, '@deepseek-ai/dsh-client-ui-primitives': primitives, 'react/jsx-runtime': jsxRuntime }
window.__B11Require = (id) => {
  if (!(id in externals)) throw new Error('Unexpected editor chunk dependency: ' + id)
  return externals[id]
}
window.__B11Mount = (TextEditor) => root.render(React.createElement(TextEditor, {
  ctx: { get: () => undefined },
  scope: { sessionId: 'b11-behavior-test', cwd: 'D:/isolated/b11-fixture' },
  path: 'README.md',
  viewerId: 'markdown',
  content: '# Original file content',
}))
`
const browserBundle = await esbuild.build({
  stdin: { contents: testEntryPage, resolveDir: sourceRoot, sourcefile: 'text-editor-bundle-test.ts', loader: 'ts' },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  nodePaths: [baselineNodeModules],
})
const bundlePath = join(testDir, 'bundle.js')
await writeFile(bundlePath, browserBundle.outputFiles[0].contents)

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/bundle.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    response.end(await readFile(bundlePath))
    return
  }
  if (url.pathname === '/client-editor.js') {
    response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    response.end(await readFile(editorBundlePath))
    return
  }
  if (url.pathname === '/test-mode' && request.method === 'POST') {
    let body = ''
    for await (const chunk of request) body += chunk
    writeMode = JSON.parse(body).mode
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    return
  }
  if (url.pathname === '/sidebar/api/fs.write' && request.method === 'POST') {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    writes.push(payload)
    if (writeMode === 'fail') {
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: { code: 'EIO', message: 'Controlled write rejection' } }))
    } else {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"value":{"ok":true}}')
    }
    return
  }
  const html = '<!doctype html><meta charset="utf-8"><title>B11 behavior test</title><div id="root"></div><script src="/bundle.js"></script><script src="/client-editor.js"></script><script>window.__B11Mount(window.__dshChunks__.editor(window.__B11Require).TextEditor)</script>'
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
})

let browser
try {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const { port } = server.address()
  const profilePath = join(testDir, 'chromium-profile')
  browser = await chromium.launchPersistentContext(profilePath, { headless: true, locale: 'zh-CN', viewport: { width: 1100, height: 760 } })
  const page = await browser.newPage()
  const pageErrors = []
  const consoleErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.goto(`http://127.0.0.1:${port}/`)
  try {
    await page.getByTestId('markdown-source').waitFor({ timeout: 8000 })
  } catch (error) {
    console.error(JSON.stringify({ pageErrors, consoleErrors, body: await page.locator('body').innerText() }))
    throw error
  }
  assert.equal(await page.getByTestId('markdown-source').textContent(), '# Original file content')

  await page.getByRole('button', { name: '编辑', exact: true }).click()
  const editor = page.locator('.cm-content')
  await editor.waitFor()
  await page.waitForFunction(() => document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'true')
  const successfulText = '# Saved from the real editor interaction'
  await editor.fill(successfulText)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  try {
    await page.waitForFunction(() => document.body.innerText.includes('已保存'), { timeout: 8000 })
  } catch (error) {
    console.error(JSON.stringify({ pageErrors, consoleErrors, writes, body: await page.locator('body').innerText() }))
    throw error
  }
  assert.equal(writes.at(-1)?.path, 'README.md')
  assert.equal(writes.at(-1)?.content, successfulText)
  await page.getByRole('button', { name: '预览', exact: true }).click()
  await page.waitForFunction((text) => document.querySelector('[data-testid="markdown-source"]')?.textContent === text, successfulText)
  const previewAfterSuccess = await page.getByTestId('markdown-source').textContent()

  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.cm-content')?.getAttribute('contenteditable') === 'true')
  const rejectedText = '# Draft retained after a rejected save'
  await editor.fill(rejectedText)
  await page.request.post(`http://127.0.0.1:${port}/test-mode`, { data: { mode: 'fail' } })
  await page.getByRole('button', { name: '保存', exact: true }).click()
  try {
    await page.getByRole('alert').filter({ hasText: /当前文件无法写入|This file could not be written/ }).waitFor({ timeout: 5000 })
  } catch (error) {
    console.error(JSON.stringify({ pageErrors, consoleErrors, writes, body: await page.locator('body').innerText() }))
    throw error
  }
  assert.equal(writes.at(-1)?.content, rejectedText)
  await page.getByRole('button', { name: '预览', exact: true }).click()
  await page.waitForFunction((text) => document.querySelector('[data-testid="markdown-source"]')?.textContent === text, rejectedText)
  const previewAfterFailure = await page.getByTestId('markdown-source').textContent()
  assert.deepEqual(pageErrors, [])

  const result = {
    serviceReducer: 'passed',
    markdown: {
      successfulWriteText: writes[0].content,
      previewAfterSuccess,
      rejectedWriteText: writes[1].content,
      previewAfterFailure,
      pageErrors,
    },
  }
  await writeFile(join(testDir, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally {
  if (browser) await browser.close()
  await new Promise(resolveClose => server.close(resolveClose))
}
