import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageRoot = resolve(
  process.env.DSH_B11_PACKAGE_ROOT ?? fileURLToPath(new URL('../node_modules/dsh-better-sidebar', import.meta.url)),
)
const matches = (source, pattern) => assert.ok(pattern.test(source), `Expected bundle/source to match ${pattern}`)
const { canSaveText, canShowPendingTextActions, markdownPreviewKicker } = await import(pathToFileURL(resolve(packageRoot, 'src/client/editor-policy.mjs')).href)

let cases = 0
for (const contentLoaded of [false, true]) {
  for (const truncated of [false, true]) {
    for (const saving of [false, true]) {
      for (const dirty of [false, true]) {
        const expected = contentLoaded && !truncated && !saving && dirty
        assert.equal(canSaveText({ contentLoaded, truncated, saving, dirty }), expected)
        cases += 1
      }
    }
  }
}

const pendingTextCases = [
  ['src/app.ts', 'code', true],
  ['src/CPULOAD.C', 'code', true],
  ['README.md', 'markdown', true],
  ['report.htm', 'html', true],
  ['data.bin', 'code', false],
  ['report.pdf', 'pdf', false],
  ['photo.png', 'image', false],
  ['archive.doc', 'binary-download', false],
  ['unknown', 'code', false],
]
for (const [path, viewerId, expected] of pendingTextCases) {
  assert.equal(canShowPendingTextActions(path, viewerId), expected, `${path} / ${viewerId}`)
  cases += 1
}
assert.equal(markdownPreviewKicker('README.md', '# 采样周期示意\n\n正文'), 'README / SAMPLING')
assert.equal(markdownPreviewKicker('docs/architecture.md', '# Architecture'), 'ARCHITECTURE / MARKDOWN')
cases += 2

const textEditor = await readFile(resolve(packageRoot, 'src/client/TextEditor.tsx'), 'utf8')
const editorHost = await readFile(resolve(packageRoot, 'src/client/EditorHost.tsx'), 'utf8')
const fileTree = await readFile(resolve(packageRoot, 'src/client/FileTree.tsx'), 'utf8')
const treePanel = await readFile(resolve(packageRoot, 'src/client/TreePanel.tsx'), 'utf8')
const viewers = await readFile(resolve(packageRoot, 'src/client/builtins/viewers.tsx'), 'utf8')
const mermaid = await readFile(resolve(packageRoot, 'src/client/mermaid.tsx'), 'utf8')
const sidebarCss = await readFile(resolve(packageRoot, 'src/client/sidebar.module.css'), 'utf8')
const cmThemes = await readFile(resolve(packageRoot, 'src/client/cm-themes.ts'), 'utf8')
const locales = await readFile(resolve(packageRoot, 'src/client/locales.ts'), 'utf8')
const editorPolicy = await readFile(resolve(packageRoot, 'src/client/editor-policy.mjs'), 'utf8')
const clientBundle = await readFile(resolve(packageRoot, 'lib/client.js'), 'utf8')
const editorBundle = await readFile(resolve(packageRoot, 'lib/client-editor.js'), 'utf8')
const mermaidBundle = await readFile(resolve(packageRoot, 'lib/client-mermaid.js'), 'utf8')

matches(textEditor, /canSaveText\(\{ contentLoaded: content !== undefined, truncated, saving: savingRef\.current, dirty: dirtyRef\.current \}\)/)
matches(textEditor, /canSaveText\(\{ contentLoaded: editable, truncated, saving: saveState === 'saving', dirty \}\)/)
matches(textEditor, /EditorState\.readOnly\.of\(mode !== 'edit' \|\| truncated\)/)
matches(textEditor, /CodeMirrorView\.editable\.of\(mode === 'edit' && !truncated\)/)
matches(editorHost, /disabled=\{toolbar\.editable !== true \|\| toolbar\.readOnly === true\}/)
matches(textEditor, /api\.fsWrite\(scope, path, savedText\)/)
matches(textEditor, /setSaveError\(\/\\b\(\?:EPERM\|EACCES\)\\b\/\.test\(message\)/)
matches(textEditor, /const \[savedContent, setSavedContent\] = useState<string \| undefined>\(content\)/)
matches(textEditor, /setSavedContent\(content\)/)
matches(textEditor, /const savedText = view\.state\.doc\.toString\(\)/)
matches(textEditor, /setSavedContent\(savedText\)[\s\S]*?setDraft\(null\)/)
matches(textEditor, /const mdText = draft \?\? savedContent \?\? ''/)
matches(textEditor, /markdownPreviewKicker\(path, mdText\)/)
matches(textEditor, /<div className=\{css\.editorMdKicker\} aria-hidden="true">\{previewKicker\}<\/div>/)
matches(textEditor, /aria-label=\{t\('save'\)\}[\s\S]*?disabled=\{!canSave \|\| !dirty\}/)
matches(editorHost, /ctx\.get\('pangea'\)[\s\S]*?openPage\?\.\(scope, 'analysis'\)/)
matches(editorHost, /IconSaveOutline16/)
matches(editorHost, /FiEye/)
matches(editorHost, /FiEdit3/)
assert.doesNotMatch(editorHost, /toolbar\?\.dirty === true && <span className=\{css\.dirtyDot\}/)
matches(editorHost, /selectedPath=\{path === '' \? null : path\}/)
matches(editorHost, /toolbar\?\.modes === true[\s\S]*?controlsRef\.current\?\.setMode\('preview'\)[\s\S]*?controlsRef\.current\?\.setMode\('edit'\)/)
matches(editorHost, /toolbarEntry\?\.key === loadKey/)
matches(editorHost, /\{ key: loadKey, state: next \}/)
matches(editorHost, /pendingTextActions/)
matches(editorHost, /canShowPendingTextActions\(path, preflightViewer\?\.id\)/)
matches(editorHost, /currentLoad\.status === 'loading' \|\| currentLoad\.status === 'error'/)
matches(editorHost, /toolbar\?\.modes !== true && pendingTextActions[\s\S]*?disabled/)
matches(editorHost, /toolbar\?\.editable === true \|\| pendingTextActions[\s\S]*?toolbar\?\.canSave !== true \|\| toolbar\?\.dirty !== true/)
matches(editorHost, /editorStateSpinner/)
matches(editorHost, /editorReadErrorSummary/)
matches(editorHost, /onClick=\{returnToFileList\}/)
matches(editorHost, /updateTab\(tab\.id, \{ path: '', title: t\('files'\) \}\)/)
matches(editorHost, /className=\{css\.editor\}/)
matches(editorHost, /const currentLoad: EditorLoad = load\.key === loadKey \? load : \{ key: loadKey, status: 'loading' \}/)
matches(editorHost, /if \(cancelled\) return[\s\S]*?setLoad\(\{ key: loadKey, status: 'error'/)
matches(editorHost, /\[scope\.sessionId, scope\.cwd, path, loadKey, ctx, showEmpty\]/)
matches(fileTree, /selectedPath: string \| null/)
matches(fileTree, /entry\.path === selectedPath && css\.explorerRowSelected/)
matches(treePanel, /selectedPath=\{selectedPath\}/)
matches(viewers, /id: 'pdf'/)
matches(viewers, /id: 'image'/)
matches(viewers, /BinaryDownload/)
matches(clientBundle, /pangea\?\.openPage\?\.\(scope, "analysis"\)/)
matches(clientBundle, /IconSaveOutline16, \{ size: 14 \}/)
matches(clientBundle, /FiEye/)
matches(clientBundle, /FiEdit3/)
assert.doesNotMatch(clientBundle, /sidebar_module_default\.dirtyDot/)
matches(clientBundle, /currentLoad\.status === "loading"/)
matches(clientBundle, /selectedPath/)
matches(clientBundle, /editorFooter/)
matches(clientBundle, /toolbar\.mode === "edit" &&/)
matches(clientBundle, /toolbarEntry\?\.key === loadKey/)
matches(clientBundle, /pendingTextActions/)
matches(clientBundle, /canShowPendingTextActions\(path, preflightViewer\?\.id\)/)
matches(clientBundle, /updateTab\(tab\.id, \{\s*path: "",\s*title: t\("files"\)\s*\}\)/)
matches(clientBundle, /editorStateSpinner/)
matches(clientBundle, /editorReadErrorSummary/)
matches(clientBundle, /editorReturnToFiles/)
matches(clientBundle, /toolbar\?\.editable === true \|\| pendingTextActions/)
matches(clientBundle, /onClick: returnToFileList/)
matches(clientBundle, /const currentLoad = load\.key === loadKey \? load : \{\s*key: loadKey,\s*status: "loading"\s*\}/)
matches(clientBundle, /disabled: true,[\s\S]*?children: t\("edit"\)/)
matches(clientBundle, /"editorStateSpinner": "nArs4W_editorStateSpinner"/)
matches(editorBundle, /function canSaveText/)
matches(editorBundle, /truncated === true &&/)
matches(editorBundle, /editorSaveFailure/)
matches(editorBundle, /setSavedContent\(savedText\)/)
matches(editorBundle, /const mdText = draft \?\? savedContent \?\? ""/)
matches(editorBundle, /EditorState\.readOnly\.of\(mode !== "edit" \|\| truncated\)/)
matches(editorBundle, /disabled: !canSave \|\| !dirty/)
matches(clientBundle, /editorTreeHeader/)
matches(mermaid, /onBodyClick = \(event: ReactMouseEvent<HTMLDivElement>\)/)
matches(mermaid, /bodyRef\.current\?\.focus\(\)[\s\S]*?restoreZoomFocus\.current = true/)
matches(mermaid, /aria-modal="true"\s*aria-label=\{label\('mermaidOpenZoom'\)\}\s*tabIndex=\{-1\}/)
matches(mermaid, /main\[data-pangea-page="workbench"\]/)
matches(mermaid, /data-pangea-utility-head/)
matches(mermaid, /top: `\$\{utilityHeader\?\.getBoundingClientRect\(\)\.height \?\? 0\}px`/)
matches(mermaid, /workbench \?\? document\.body/)
matches(mermaid, /className=\{css\.mermaidBody\}[\s\S]*?role="button"[\s\S]*?tabIndex=\{0\}[\s\S]*?aria-label=\{t\('mermaidOpenZoom'\)\}[\s\S]*?onKeyDown=\{onBodyKeyDown\}/)
matches(mermaid, /theme: dark \? 'dark' : 'base'/)
matches(mermaid, /mermaid\.render\(id, code, renderContainer\)[\s\S]*?finally\(\(\) => \{ renderContainer\.remove\(\) \}\)/)
matches(mermaid, /primaryColor: '#f3f7ee'/)
matches(mermaid, /className=\{css\.mermaidError\} role="alert"[\s\S]*?t\('mermaidErrorHint'\)/)
matches(mermaid, /error !== null \? `\$\{css\.mermaidHeader\} \$\{css\.mermaidHeaderError\}` : css\.mermaidHeader/)
matches(mermaid, /code\.split\('\\n'\)\.map\(\(line, index\)/)
matches(mermaid, /className=\{css\.mermaidCodeNumber\} aria-hidden="true">/)
matches(editorPolicy, /export function markdownPreviewKicker\(path, text\)/)
matches(editorPolicy, /采样\(\?:周期\|时间\|频率\)/)
matches(locales, /mermaidErrorHint: '以下保留图表源码，可切换编辑模式修正。'/)
matches(sidebarCss, /\.mermaidError\s*\{[^}]*color:\s*var\(--dsw-alias-state-error-primary\);/s)
matches(textEditor, /markdown && css\.editorMarkdownCm/)
matches(sidebarCss, /\.editorMarkdownCm :global\(\.cm-scroller\)\s*\{[^}]*padding:/s)
matches(sidebarCss, /\.editorMarkdownCm :global\(\.cm-gutters\)\s*\{[^}]*padding-right:/s)
matches(sidebarCss, /\.editorMarkdownCm :global\(\.cm-line\)\s*\{[^}]*line-height:/s)
matches(sidebarCss, /\.editorMdWithMermaid\s*\{[^}]*width:\s*550px;[^}]*max-width:\s*calc\(100% - 28px\);[^}]*margin-inline:\s*auto/s)
matches(sidebarCss, /\.editorMdKicker\s*\{[^}]*text-transform:\s*uppercase;/s)
matches(sidebarCss, /\.editorMdWithMermaid:has\(\.mermaidError\) \.editorMdKicker\s*\{[^}]*display:\s*none;/s)
matches(sidebarCss, /\.editorMdWithMermaid \.mermaidHeaderError\s*\{[^}]*clip-path:\s*inset\(50%\);/s)
matches(sidebarCss, /\.editorMdWithMermaid \.mermaidHeaderError:focus-within\s*\{[^}]*height:\s*51px;[^}]*clip-path:\s*none;/s)
matches(sidebarCss, /\.mermaidCodeLine\s*\{[^}]*grid-template-columns:\s*32px minmax\(0, 1fr\);/s)
matches(sidebarCss, /\.mermaidHeader\s*\{[^}]*display:\s*flex;/s)
matches(mermaid, /className=\{css\.mermaidModalHeader\}[\s\S]*?<strong>\{title\}<\/strong>[\s\S]*?className=\{css\.mermaidModalToolbar\}[\s\S]*?label\('mermaidZoomOut'\)/)
matches(sidebarCss, /\.mermaidModalStage\s*\{[^}]*flex:\s*1;[^}]*width:\s*100%;[^}]*padding:\s*150px 24px 20px;/s)
matches(sidebarCss, /\.mermaidModalStage :global\(svg\)\s*\{[^}]*width:\s*min\(540px, 100%\);[^}]*max-height:\s*240px;/s)
matches(sidebarCss, /\.editorMdWithMermaid \.mermaidHeader\s*\{[^}]*height:\s*\d+px/s)
matches(sidebarCss, /\.editorMdWithMermaid \.mermaidBody\s*\{[^}]*min-height:\s*\d+px;[^}]*background:\s*#[0-9a-f]{6};/is)
matches(clientBundle, /sidebar_module_default\.editor,/)
matches(mermaidBundle, /data-mermaid-modal/)
matches(mermaidBundle, /data-pangea-utility-head/)
matches(mermaidBundle, /"aria-label": t\("mermaidOpenZoom"\)/)
matches(mermaidBundle, /mermaidOpenZoom: "放大查看流程图"/)
matches(mermaidBundle, /nArs4W_editorMd/)
matches(mermaidBundle, /#f3f7ee/)
matches(mermaidBundle, /以下保留图表源码，可切换编辑模式修正。/)
matches(editorBundle, /markdownPreviewKicker/)
matches(editorBundle, /SAMPLING/)
matches(mermaidBundle, /mermaidCodeNumber/)

await import(`${new URL('./test-b11-behavior.mjs', import.meta.url).href}?run=${Date.now()}`)
console.log(JSON.stringify({ packageRoot, policyCases: cases, sourceAssertions: 75, bundleAssertions: 39, result: 'passed' }, null, 2))
