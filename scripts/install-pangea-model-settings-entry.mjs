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
const STATE_EVENT = 'pangea:model-onboarding-state'
const QUERY_EVENT = 'pangea:query-model-onboarding'
const OVERLAY_MARKER = 'data-pangea-model-settings-overlay'
const PRODUCT_ONBOARDING_MARKER = 'PangeaAwareDeepSeekOnboardingDialog'

function replaceExactlyOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle)
  if (first < 0) throw new Error(`PANGEA model settings patch: missing ${label} anchor`)
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`PANGEA model settings patch: ${label} anchor is ambiguous`)
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length)
}

function replaceRegexExactlyOnce(source, pattern, replacement, label) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1) {
    throw new Error(`PANGEA model settings patch: expected 1 ${label} match, found ${matches.length}`)
  }
  return source.replace(pattern, replacement)
}

function installOverlay(source) {
  if (source.includes(OVERLAY_MARKER)) return source

  const regionAnchor = '\t\t//#region lib/types/client/DeepSeekOnboardingDialog.js\n'
  const component = `\t\t//#region PANGEA Desktop internal model settings overlay\n\t\tconst pangea_react_dom = require(\"react-dom\");\n\t\tfunction PangeaInternalModelSettings(props) {\n\t\t\tconst state = props.useSnapshot((snapshot) => snapshot);\n\t\t\tif (state.status === \"idle\") void props.controller.load();\n\t\t\tif (state.status === \"idle\" || state.status === \"loading\") return (0, react_jsx_runtime.jsx)(\"p\", { children: \"正在加载内部模型设置…\" });\n\t\t\tif (state.status === \"error\") return (0, react_jsx_runtime.jsx)(\"p\", { style: { color: \"var(--dsw-alias-state-error-primary)\" }, children: state.error ?? \"内部模型设置加载失败\" });\n\t\t\tconst namespace = state.namespaces.get(\"llm-pi-ai\");\n\t\t\tif (namespace === void 0) return (0, react_jsx_runtime.jsx)(\"p\", { children: \"当前 DSH 模型适配器不支持内部自定义 LLM。\" });\n\t\t\tconst internalRows = state.rows.filter((row) => row.entry.settingsNs === \"llm-pi-ai\" && row.entry.declared === true && row.configured);\n\t\t\tif (internalRows.length === 0) {\n\t\t\t\tconst protocols = protocolChoices(namespace, props.schema);\n\t\t\t\treturn (0, react_jsx_runtime.jsx)(CustomProviderCard, {\n\t\t\t\t\ttaken: state.rows.map((row) => row.entry.provider),\n\t\t\t\t\tprotocols,\n\t\t\t\t\trevision: namespace.revision,\n\t\t\t\t\tapi: props.api,\n\t\t\t\t\tt: props.t,\n\t\t\t\t\treadOnly: !state.writable,\n\t\t\t\t\tonClose: (changed) => {\n\t\t\t\t\t\tif (changed) void props.controller.load();\n\t\t\t\t\t\tprops.onClose();\n\t\t\t\t\t}\n\t\t\t\t});\n\t\t\t}\n\t\t\treturn (0, react_jsx_runtime.jsx)(\"div\", {\n\t\t\t\tstyle: { display: \"grid\", gap: 18 },\n\t\t\t\tchildren: internalRows.map((row) => (0, react_jsx_runtime.jsx)(ProviderEditor, {\n\t\t\t\t\tprovider: row.entry.provider,\n\t\t\t\t\tdisplayName: row.entry.displayName,\n\t\t\t\t\tdeclared: true,\n\t\t\t\t\tnamespace,\n\t\t\t\t\tschema: props.schema,\n\t\t\t\t\tsettingsPath: row.entry.settingsPath,\n\t\t\t\t\tapi: props.api,\n\t\t\t\t\tt: props.t,\n\t\t\t\t\treadOnly: !state.writable,\n\t\t\t\t\tonClose: (changed) => {\n\t\t\t\t\t\tif (changed) void props.controller.load();\n\t\t\t\t\t\tprops.onClose();\n\t\t\t\t\t}\n\t\t\t\t}, row.entry.provider))\n\t\t\t});\n\t\t}\n\t\tfunction PangeaModelSettingsOverlay(props) {\n\t\t\tconst state = props.useSnapshot((snapshot) => snapshot);\n\t\t\tconst [open, setOpen] = (0, react.useState)(false);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tif (state.status === \"idle\") void props.controller.load();\n\t\t\t}, [props.controller, state.status]);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tconst publish = () => {\n\t\t\t\t\tconst customAvailable = state.namespaces.get(\"llm-pi-ai\") !== void 0;\n\t\t\t\t\tconst internalRows = state.rows.filter((row) => row.entry.settingsNs === \"llm-pi-ai\" && row.entry.declared === true);\n\t\t\t\t\tconst required = state.status === \"ready\" && state.writable && customAvailable && !internalRows.some(providerUsable);\n\t\t\t\t\twindow.dispatchEvent(new CustomEvent(${JSON.stringify(STATE_EVENT)}, { detail: { required, customAvailable, status: state.status } }));\n\t\t\t\t};\n\t\t\t\tpublish();\n\t\t\t\twindow.addEventListener(${JSON.stringify(QUERY_EVENT)}, publish);\n\t\t\t\treturn () => window.removeEventListener(${JSON.stringify(QUERY_EVENT)}, publish);\n\t\t\t}, [state.status, state.writable, state.rows, state.namespaces]);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tconst show = () => setOpen(true);\n\t\t\t\twindow.addEventListener(${JSON.stringify(OPEN_EVENT)}, show);\n\t\t\t\treturn () => window.removeEventListener(${JSON.stringify(OPEN_EVENT)}, show);\n\t\t\t}, []);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tif (!open) return;\n\t\t\t\tconst onKeyDown = (event) => { if (event.key === \"Escape\") setOpen(false); };\n\t\t\t\tdocument.addEventListener(\"keydown\", onKeyDown);\n\t\t\t\treturn () => document.removeEventListener(\"keydown\", onKeyDown);\n\t\t\t}, [open]);\n\t\t\tif (!open) return null;\n\t\t\tconst close = () => setOpen(false);\n\t\t\treturn pangea_react_dom.createPortal((0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\t\"${OVERLAY_MARKER}\": \"true\",\n\t\t\t\tstyle: { position: \"fixed\", inset: 0, zIndex: 20000, display: \"grid\", placeItems: \"center\", padding: 24, fontFamily: '\"Huawei Sans\", \"HarmonyOS Sans SC\", \"PingFang SC\", \"Microsoft YaHei UI\", sans-serif' },\n\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(\"div\", {\n\t\t\t\t\trole: \"presentation\",\n\t\t\t\t\tonClick: close,\n\t\t\t\t\tstyle: { position: \"absolute\", inset: 0, background: \"rgba(20,24,32,.42)\", backdropFilter: \"blur(2px)\" }\n\t\t\t\t}), (0, react_jsx_runtime.jsxs)(\"section\", {\n\t\t\t\t\trole: \"dialog\",\n\t\t\t\t\t\"aria-modal\": \"true\",\n\t\t\t\t\t\"aria-label\": \"内部模型设置\",\n\t\t\t\t\tstyle: { position: \"relative\", boxSizing: \"border-box\", width: \"min(1040px, calc(100vw - 48px))\", height: \"min(860px, calc(100vh - 48px))\", display: \"grid\", gridTemplateRows: \"60px minmax(0,1fr)\", overflow: \"hidden\", border: \"1px solid var(--dsw-alias-border-l2)\", borderRadius: 14, background: \"var(--dsw-alias-bg-base, #fff)\", boxShadow: \"0 24px 70px rgba(0,0,0,.24)\" },\n\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)(\"header\", {\n\t\t\t\t\t\tstyle: { display: \"flex\", alignItems: \"center\", padding: \"0 18px 0 26px\", borderBottom: \"1px solid var(--dsw-alias-border-l2)\", background: \"var(--dsw-alias-bg-layer-1, #fff)\" },\n\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(\"strong\", { style: { fontSize: 17 }, children: \"内部模型设置\" }), (0, react_jsx_runtime.jsx)(\"span\", { style: { flex: 1 } }), (0, react_jsx_runtime.jsx)(\"button\", {\n\t\t\t\t\t\t\ttype: \"button\",\n\t\t\t\t\t\t\t\"aria-label\": \"关闭内部模型设置\",\n\t\t\t\t\t\t\tonClick: close,\n\t\t\t\t\t\t\tstyle: { width: 34, height: 34, border: 0, borderRadius: 8, background: \"transparent\", color: \"var(--dsw-alias-label-secondary, #555)\", cursor: \"pointer\", fontSize: 24, lineHeight: \"34px\" },\n\t\t\t\t\t\t\tchildren: \"×\"\n\t\t\t\t\t\t})]\n\t\t\t\t\t}), (0, react_jsx_runtime.jsx)(\"div\", {\n\t\t\t\t\t\tstyle: { minHeight: 0, overflow: \"auto\", padding: \"24px 30px 36px\" },\n\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(PangeaInternalModelSettings, { ...props, onClose: close })\n\t\t\t\t\t})]\n\t\t\t\t})]\n\t\t\t}), document.body);\n\t\t}\n\t\tfunction ${PRODUCT_ONBOARDING_MARKER}(props) {\n\t\t\tif (typeof document !== \"undefined\" && document.body.hasAttribute(\"data-pangea-product-shell\")) return null;\n\t\t\treturn (0, react_jsx_runtime.jsx)(DeepSeekOnboardingDialog, { ...props });\n\t\t}\n\t\t//#endregion\n`
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

function wrapNativeOnboardingRegistration(source) {
  if (source.includes(`}, ${PRODUCT_ONBOARDING_MARKER}));`)) return source
  const registration = /(ctx\.slots\.inject\("settings\.onboarding", \(\) => ctx\.slots\.register\(\{[\s\S]*?id: "deepseek-official",[\s\S]*?\}, )DeepSeekOnboardingDialog(\)\);)/g
  return replaceRegexExactlyOnce(
    source,
    registration,
    `$1${PRODUCT_ONBOARDING_MARKER}$2`,
    'deepseek-official onboarding registration',
  )
}

let source = await readFile(clientPath, 'utf8')
const before = source
source = installOverlay(source)
source = wrapNativeOnboardingRegistration(source)
if (source !== before) await writeFile(clientPath, source, 'utf8')
