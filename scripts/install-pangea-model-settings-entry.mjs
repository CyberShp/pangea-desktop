import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = path.join(
  projectRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-settings-models',
  'lib',
  'client.js',
)

const OPEN_EVENT = 'pangea:open-model-settings'
const OVERLAY_MARKER = 'data-pangea-model-settings-overlay'
const ONBOARDING_MARKER = 'onboardingCustomProvider'

function replaceExactlyOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle)
  if (first < 0) throw new Error(`PANGEA model settings patch: missing ${label} anchor`)
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`PANGEA model settings patch: ${label} anchor is ambiguous`)
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length)
}

function installOverlay(source) {
  if (source.includes(OVERLAY_MARKER)) return source

  const regionAnchor = '\t\t//#region lib/types/client/DeepSeekOnboardingDialog.js\n'
  const component = `\t\t//#region PANGEA Desktop model settings overlay\n\t\tfunction PangeaModelSettingsOverlay(props) {\n\t\t\tconst [open, setOpen] = (0, react.useState)(false);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tconst show = () => setOpen(true);\n\t\t\t\twindow.addEventListener(${JSON.stringify(OPEN_EVENT)}, show);\n\t\t\t\treturn () => window.removeEventListener(${JSON.stringify(OPEN_EVENT)}, show);\n\t\t\t}, []);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tif (!open) return;\n\t\t\t\tconst onKeyDown = (event) => { if (event.key === \"Escape\") setOpen(false); };\n\t\t\t\tdocument.addEventListener(\"keydown\", onKeyDown);\n\t\t\t\treturn () => document.removeEventListener(\"keydown\", onKeyDown);\n\t\t\t}, [open]);\n\t\t\tif (!open) return null;\n\t\t\tconst close = () => setOpen(false);\n\t\t\treturn (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\"${OVERLAY_MARKER}\": \"true\",\n\t\t\t\tstyle: { position: \"fixed\", inset: 0, zIndex: 12000, display: \"grid\", placeItems: \"center\", padding: 24, pointerEvents: \"auto\" },\n\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(\"div\", {\n\t\t\t\t\trole: \"presentation\",\n\t\t\t\t\tonClick: close,\n\t\t\t\t\tstyle: { position: \"absolute\", inset: 0, background: \"rgba(20,24,32,.42)\" }\n\t\t\t\t}), (0, react_jsx_runtime.jsxs)(\"section\", {\n\t\t\t\t\trole: \"dialog\",\n\t\t\t\t\t\"aria-modal\": \"true\",\n\t\t\t\t\t\"aria-label\": \"设置\",\n\t\t\t\t\tstyle: { position: \"relative\", width: \"min(980px, calc(100vw - 48px))\", height: \"min(820px, calc(100vh - 48px))\", display: \"grid\", gridTemplateRows: \"56px minmax(0,1fr)\", overflow: \"hidden\", border: \"1px solid var(--dsw-alias-border-l2)\", borderRadius: 12, background: \"var(--dsw-alias-bg-base)\", boxShadow: \"0 24px 70px rgba(0,0,0,.24)\" },\n\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)(\"header\", {\n\t\t\t\t\t\tstyle: { display: \"flex\", alignItems: \"center\", padding: \"0 18px 0 24px\", borderBottom: \"1px solid var(--dsw-alias-border-l2)\", background: \"var(--dsw-alias-bg-layer-1)\" },\n\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(\"strong\", { style: { fontSize: 16 }, children: \"设置\" }), (0, react_jsx_runtime.jsx)(\"span\", { style: { flex: 1 } }), (0, react_jsx_runtime.jsx)(\"button\", {\n\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\"aria-label\": \"关闭设置\",\n\t\t\t\t\t\t\tonClick: close,\n\t\t\t\t\t\t\tstyle: { width: 32, height: 32, border: 0, borderRadius: 8, background: \"transparent\", color: \"var(--dsw-alias-label-secondary)\", cursor: \"pointer\", fontSize: 22, lineHeight: \"32px\" },\n\t\t\t\t\t\t\tchildren: \"×\"\n\t\t\t\t\t\t})]\n\t\t\t\t\t}), (0, react_jsx_runtime.jsx)(\"div\", {\n\t\t\t\t\t\tstyle: { minHeight: 0, overflow: \"auto\", padding: \"22px 28px 32px\" },\n\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(ModelsSection, { ...props })\n\t\t\t\t\t})]\n\t\t\t\t})]\n\t\t\t});\n\t\t}\n\t\t//#endregion\n`
  source = replaceExactlyOnce(source, regionAnchor, component + regionAnchor, 'onboarding region')

  const sectionRegistration = '\t\tctx.slots.inject("settings.section", () => ctx.slots.register({\n'
  const overlayRegistration = `\t\tctx.slots.inject(\"shell.overlay\", () => ctx.slots.register({\n\t\t\tname: \"shell.overlay\",\n\t\t\tid: \"pangea-model-settings\",\n\t\t\torder: 1000,\n\t\t\tinject: injected\n\t\t}, PangeaModelSettingsOverlay));\n`
  return replaceExactlyOnce(
    source,
    sectionRegistration,
    overlayRegistration + sectionRegistration,
    'models section registration',
  )
}

function installCustomOnboardingEntry(source) {
  if (source.includes(ONBOARDING_MARKER)) return source

  const editorAnchor = '\t\t\t\t}), (0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\tclassName: DeepSeekOnboardingDialog_module_css_default.editor,\n'
  const customButton = `\t\t\t\t}), (0, react_jsx_runtime.jsxs)(\"button\", {\n\t\t\t\t\ttype: \"button\",\n\t\t\t\t\tclassName: DeepSeekOnboardingDialog_module_css_default.providerButton,\n\t\t\t\t\tstyle: { width: \"100%\", marginBottom: 12 },\n\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\tcomplete();\n\t\t\t\t\t\twindow.dispatchEvent(new CustomEvent(${JSON.stringify(OPEN_EVENT)}));\n\t\t\t\t\t},\n\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\tclassName: DeepSeekOnboardingDialog_module_css_default.providerName,\n\t\t\t\t\t\tchildren: t(\"onboardingCustomProvider\")\n\t\t\t\t\t}), (0, react_jsx_runtime.jsx)(\"span\", {\n\t\t\t\t\t\tclassName: DeepSeekOnboardingDialog_module_css_default.providerKind,\n\t\t\t\t\t\tchildren: t(\"onboardingCustomProviderHint\")\n\t\t\t\t\t})]\n\t\t\t\t}), (0, react_jsx_runtime.jsx)(\"div\", {\n\t\t\t\t\tclassName: DeepSeekOnboardingDialog_module_css_default.editor,\n`
  source = replaceExactlyOnce(source, editorAnchor, customButton, 'onboarding editor')

  source = replaceExactlyOnce(
    source,
    '\t\t\tonboardingInference: "Inference platform",\n',
    '\t\t\tonboardingInference: "Inference platform",\n\t\t\tonboardingCustomProvider: "Custom / private model provider",\n\t\t\tonboardingCustomProviderHint: "OpenAI-compatible endpoint or internal deployment",\n',
    'English onboarding copy',
  )
  source = replaceExactlyOnce(
    source,
    '\t\t\tonboardingInference: "推理服务平台",\n',
    '\t\t\tonboardingInference: "推理服务平台",\n\t\t\tonboardingCustomProvider: "自定义 / 内部模型提供方",\n\t\t\tonboardingCustomProviderHint: "OpenAI 兼容接口、私有部署或内网模型",\n',
    'Chinese onboarding copy',
  )
  return source
}

let source = await readFile(clientPath, 'utf8')
const before = source
source = installOverlay(source)
source = installCustomOnboardingEntry(source)
if (source !== before) await writeFile(clientPath, source, 'utf8')
