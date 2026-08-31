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
const ONBOARDING_MARKER = 'onboardingCustomProvider'
const PRODUCT_ONBOARDING_MARKER = 'pangeaProductShell'

function replaceExactlyOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle)
  if (first < 0) throw new Error(`PANGEA model settings patch: missing ${label} anchor`)
  if (source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`PANGEA model settings patch: ${label} anchor is ambiguous`)
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length)
}

function installOnboardingLocaleCopy(source) {
  const pattern = /\t\t\tonboardingInference:\s*"[^"]*",\r?\n/g
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 2) {
    throw new Error(`PANGEA model settings patch: expected 2 onboarding locale anchors, found ${matches.length}`)
  }

  const additions = [
    '\t\t\tonboardingCustomProvider: "Custom / private model provider",\n\t\t\tonboardingCustomProviderHint: "OpenAI-compatible endpoint or internal deployment",\n',
    '\t\t\tonboardingCustomProvider: "自定义 / 内部模型提供方",\n\t\t\tonboardingCustomProviderHint: "OpenAI 兼容接口、私有部署或内网模型",\n',
  ]

  let offset = 0
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const at = (match.index ?? 0) + offset + match[0].length
    source = source.slice(0, at) + additions[index] + source.slice(at)
    offset += additions[index].length
  }
  return source
}

function installOverlay(source) {
  if (source.includes(OVERLAY_MARKER)) return source

  const regionAnchor = '\t\t//#region lib/types/client/DeepSeekOnboardingDialog.js\n'
  const component = `\t\t//#region PANGEA Desktop model settings overlay\n\t\tfunction PangeaCustomProviderSetup(props) {\n\t\t\tconst state = props.useSnapshot((snapshot) => snapshot);\n\t\t\tif (state.status === "idle") void props.controller.load();\n\t\t\tif (state.status === "idle" || state.status === "loading") return (0, react_jsx_runtime.jsx)("p", { children: "正在加载模型设置…" });\n\t\t\tif (state.status === "error") return (0, react_jsx_runtime.jsx)("p", { style: { color: "var(--dsw-alias-state-error-primary)" }, children: state.error ?? "模型设置加载失败" });\n\t\t\tconst namespace = state.namespaces.get("llm-pi-ai");\n\t\t\tif (namespace === void 0) return (0, react_jsx_runtime.jsx)("p", { children: "当前模型适配器不支持自定义提供方。" });\n\t\t\tconst protocols = protocolChoices(namespace, props.schema);\n\t\t\treturn (0, react_jsx_runtime.jsx)(CustomProviderCard, {\n\t\t\t\ttaken: state.rows.map((row) => row.entry.provider),\n\t\t\t\tprotocols,\n\t\t\t\trevision: namespace.revision,\n\t\t\t\tapi: props.api,\n\t\t\t\tt: props.t,\n\t\t\t\treadOnly: !state.writable,\n\t\t\t\tonClose: (changed) => {\n\t\t\t\t\tif (changed) void props.controller.load();\n\t\t\t\t\tprops.onClose();\n\t\t\t\t}\n\t\t\t});\n\t\t}\n\t\tfunction PangeaModelSettingsOverlay(props) {\n\t\t\tconst state = props.useSnapshot((snapshot) => snapshot);\n\t\t\tconst [mode, setMode] = (0, react.useState)(null);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tif (state.status === "idle") void props.controller.load();\n\t\t\t}, [props.controller, state.status]);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tconst publish = () => {\n\t\t\t\t\tconst customAvailable = state.namespaces.get("llm-pi-ai") !== void 0;\n\t\t\t\t\tconst required = state.status === "ready" && state.writable && customAvailable && !state.rows.some(providerUsable);\n\t\t\t\t\twindow.dispatchEvent(new CustomEvent(${JSON.stringify(STATE_EVENT)}, { detail: { required, customAvailable, status: state.status } }));\n\t\t\t\t};\n\t\t\t\tpublish();\n\t\t\t\twindow.addEventListener(${JSON.stringify(QUERY_EVENT)}, publish);\n\t\t\t\treturn () => window.removeEventListener(${JSON.stringify(QUERY_EVENT)}, publish);\n\t\t\t}, [state.status, state.writable, state.rows, state.namespaces]);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tconst show = (event) => setMode(event?.detail?.mode === "custom" ? "custom" : "models");\n\t\t\t\twindow.addEventListener(${JSON.stringify(OPEN_EVENT)}, show);\n\t\t\t\treturn () => window.removeEventListener(${JSON.stringify(OPEN_EVENT)}, show);\n\t\t\t}, []);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tif (mode === null) return;\n\t\t\t\tconst onKeyDown = (event) => { if (event.key === "Escape") setMode(null); };\n\t\t\t\tdocument.addEventListener("keydown", onKeyDown);\n\t\t\t\treturn () => document.removeEventListener("keydown", onKeyDown);\n\t\t\t}, [mode]);\n\t\t\tif (mode === null) return null;\n\t\t\tconst close = () => setMode(null);\n\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\t"${OVERLAY_MARKER}": "true",\n\t\t\t\tstyle: { position: "fixed", inset: 0, zIndex: 12000, display: "grid", placeItems: "center", padding: 24, pointerEvents: "auto" },\n\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\trole: "presentation",\n\t\t\t\t\tonClick: close,\n\t\t\t\t\tstyle: { position: "absolute", inset: 0, background: "rgba(20,24,32,.42)" }\n\t\t\t\t}), (0, react_jsx_runtime.jsxs)("section", {\n\t\t\t\t\trole: "dialog",\n\t\t\t\t\t"aria-modal": "true",\n\t\t\t\t\t"aria-label": mode === "custom" ? "自定义模型提供方" : "模型设置",\n\t\t\t\t\tstyle: { position: "relative", width: "min(980px, calc(100vw - 48px))", height: "min(820px, calc(100vh - 48px))", display: "grid", gridTemplateRows: "56px minmax(0,1fr)", overflow: "hidden", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, background: "var(--dsw-alias-bg-base)", boxShadow: "0 24px 70px rgba(0,0,0,.24)" },\n\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)("header", {\n\t\t\t\t\t\tstyle: { display: "flex", alignItems: "center", padding: "0 18px 0 24px", borderBottom: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-1)" },\n\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("strong", { style: { fontSize: 16 }, children: "设置" }), (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }), (0, react_jsx_runtime.jsx)("button", {\n\t\t\t\t\t\t\ttype: "button",\n\t\t\t\t\t\t\t"aria-label": "关闭设置",\n\t\t\t\t\t\t\tonClick: close,\n\t\t\t\t\t\t\tstyle: { width: 32, height: 32, border: 0, borderRadius: 8, background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", fontSize: 22, lineHeight: "32px" },\n\t\t\t\t\t\t\tchildren: "×"\n\t\t\t\t\t\t})]\n\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\tstyle: { minHeight: 0, overflow: "auto", padding: "22px 28px 32px" },\n\t\t\t\t\t\tchildren: mode === "custom"\n\t\t\t\t\t\t\t? (0, react_jsx_runtime.jsx)(PangeaCustomProviderSetup, { ...props, onClose: close })\n\t\t\t\t\t\t\t: (0, react_jsx_runtime.jsx)(ModelsSection, { ...props })\n\t\t\t\t\t})]\n\t\t\t\t})]\n\t\t\t});\n\t\t}\n\t\t//#endregion\n`
  source = replaceExactlyOnce(source, regionAnchor, component + regionAnchor, 'onboarding region')

  const sectionRegistration = '\t\tctx.slots.inject("settings.section", () => ctx.slots.register({\n'
  const overlayRegistration = `\t\tctx.slots.inject("shell.overlay", () => ctx.slots.register({\n\t\t\tname: "shell.overlay",\n\t\t\tid: "pangea-model-settings",\n\t\t\torder: 1000,\n\t\t\tinject: injected\n\t\t}, PangeaModelSettingsOverlay));\n`
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
  const customButton = `\t\t\t\t}), (0, react_jsx_runtime.jsxs)("button", {\n\t\t\t\t\ttype: "button",\n\t\t\t\t\tclassName: DeepSeekOnboardingDialog_module_css_default.providerButton,\n\t\t\t\t\tstyle: { width: "100%", marginBottom: 12 },\n\t\t\t\t\tonClick: () => {\n\t\t\t\t\t\tcomplete();\n\t\t\t\t\t\twindow.dispatchEvent(new CustomEvent(${JSON.stringify(OPEN_EVENT)}, { detail: { mode: "custom" } }));\n\t\t\t\t\t},\n\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\tclassName: DeepSeekOnboardingDialog_module_css_default.providerName,\n\t\t\t\t\t\tchildren: t("onboardingCustomProvider")\n\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {\n\t\t\t\t\t\tclassName: DeepSeekOnboardingDialog_module_css_default.providerKind,\n\t\t\t\t\t\tchildren: t("onboardingCustomProviderHint")\n\t\t\t\t\t})]\n\t\t\t\t}), (0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\tclassName: DeepSeekOnboardingDialog_module_css_default.editor,\n`
  source = replaceExactlyOnce(source, editorAnchor, customButton, 'onboarding editor')
  return installOnboardingLocaleCopy(source)
}

function suppressNativeOnboardingInProductShell(source) {
  if (source.includes(PRODUCT_ONBOARDING_MARKER)) return source

  const stateAnchor = '\t\t\tconst state = useModels((snapshot) => snapshot);\n'
  source = replaceExactlyOnce(
    source,
    stateAnchor,
    `${stateAnchor}\t\t\tconst ${PRODUCT_ONBOARDING_MARKER} = typeof document !== "undefined" && document.body.hasAttribute("data-pangea-product-shell");\n`,
    'native onboarding product-shell state',
  )

  const decisionAnchor = '\t\t\tif (state.status === "idle" || state.status === "loading" || anyUsable || selected === void 0 || !state.writable) return null;\n'
  return replaceExactlyOnce(
    source,
    decisionAnchor,
    `\t\t\tif (${PRODUCT_ONBOARDING_MARKER}) return null;\n${decisionAnchor}`,
    'native onboarding product-shell guard',
  )
}

let source = await readFile(clientPath, 'utf8')
const before = source
source = installOverlay(source)
source = installCustomOnboardingEntry(source)
source = suppressNativeOnboardingInProductShell(source)
if (source !== before) await writeFile(clientPath, source, 'utf8')
