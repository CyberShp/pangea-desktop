import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installCustomProviderView, installCustomProviderRetryState, installProductModelCopy, installModelCatalogView, installProviderAdvancedView, installProviderConflictReload, installProviderReadonlyView } from './pangea-model-form-view.mjs'

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

function restoreNativeModelsSection(source) {
  if (source.includes('const [productTarget, setProductTarget]')) return source
  if (source.includes('children: (0, react_jsx_runtime.jsx)(ModelsSection, { ...props })')) return source
  const internalSection = /\t\tfunction PangeaInternalModelSettings\(props\) \{[\s\S]*?\n\t\t\}\n\t\tfunction PangeaModelSettingsOverlay/g
  return replaceRegexExactlyOnce(
    source,
    internalSection,
    '\t\tfunction PangeaInternalModelSettings(props) {\n\t\t\treturn (0, react_jsx_runtime.jsx)(ModelsSection, { ...props });\n\t\t}\n\t\tfunction PangeaModelSettingsOverlay',
    'native models section',
  )
}

function publishAllModelReadiness(source) {
  if (source.includes('const modelGroupsResponse = await props.api.llm.models(')
    && source.includes('if (row.entry.active !== true) return false;')) return source
  const readinessPublisher = `let disposed = false;
          let generation = 0;
          const publish = async () => {
            const current = ++generation;
            const customAvailable = state.namespaces.get("llm-pi-ai") !== void 0;
            let modelAvailable = false;
            let status = state.status;
            let error = state.error;
            if (state.status === "ready") {
              try {
                const modelGroupsResponse = await props.api.llm.models({ rpcId: "pangea-model-readiness-" + Date.now() + "-" + Math.random(), payload: {} });
                if (modelGroupsResponse?.result?.ok !== true) throw new Error("model catalog request failed");
                const groups = modelGroupsResponse.result.value?.groups;
                if (!Array.isArray(groups)) throw new Error("model catalog response is invalid");
                const groupsById = new Map(groups.map(group => [group.id, group]));
                modelAvailable = state.rows.some(row => {
                  if (row.entry.active !== true) return false;
                  const credentialConfigured = row.apiKeyEnv === undefined || row.apiKeyEnv === null
                    || row.credential?.configured === true
                    || typeof process !== "undefined" && typeof process.env?.[row.apiKeyEnv] === "string" && process.env[row.apiKeyEnv].trim() !== "";
                  if (!credentialConfigured) return false;
                  const group = groupsById.get(row.entry.provider);
                  return Array.isArray(group?.models) && group.models.some(model => typeof model?.id === "string" && model.id.trim() !== "");
                });
              } catch {
                status = "error";
                error = "模型目录读取失败";
              }
            }
            const required = state.status === "ready" && state.writable && customAvailable && !modelAvailable;
            const connections = state.rows.filter(row => row.configured || row.entry.active).map(row => {
              const namespace = state.namespaces.get(row.entry.settingsNs);
              const profile = namespace ? props.schema.getPath(namespace.value, row.entry.settingsPath) : undefined;
              const models = Array.isArray(profile?.models) ? profile.models.map(model => ({ id: model.id, name: model.name || model.id, input: model.input })) : null;
              return { id: row.entry.provider, name: row.entry.displayName || row.entry.provider, modelCount: models?.length ?? null, models, baseURL: profile?.baseURL, protocol: profile?.api, custom: row.entry.declared === true, credentialConfigured: row.credential?.configured === true, credentialRequired: row.apiKeyEnv !== undefined, usable: providerUsable(row) };
            });
            if (disposed || current !== generation) return;
            window.dispatchEvent(new CustomEvent("pangea:model-onboarding-state", { detail: { required, modelAvailable, customAvailable, status, error, connections } }));
          };
          const onQuery = () => { void publish(); };
          void publish();
          window.addEventListener("pangea:query-model-onboarding", onQuery);
          return () => { disposed = true; generation += 1; window.removeEventListener("pangea:query-model-onboarding", onQuery); };`
  const previousAsyncPublisher = /let disposed = false;\s*let generation = 0;\s*const publish = async \(\) => \{[\s\S]*?return \(\) => \{ disposed = true; generation \+= 1; window\.removeEventListener\("pangea:query-model-onboarding", onQuery\); \};/g
  if ([...source.matchAll(previousAsyncPublisher)].length === 1) {
    return replaceRegexExactlyOnce(source, previousAsyncPublisher, readinessPublisher, 'model readiness publication')
  }
  return replaceRegexExactlyOnce(
    source,
    /const publish = \(\) => \{[\s\S]*?return \(\) => window\.removeEventListener\("pangea:query-model-onboarding", publish\);/g,
    readinessPublisher,
    'model readiness publication',
  )
}

function installAdvancedProviderTitle(source) {
  if (!source.includes('const [advancedOpen, setAdvancedOpen]')) {
    source = replaceExactlyOnce(source,
      'const [validationError, setValidationError] = (0, react.useState)(false);',
      'const [validationError, setValidationError] = (0, react.useState)(false);\n\t\t\tconst [advancedOpen, setAdvancedOpen] = (0, react.useState)(false);',
      'advanced model title state')
  }
  const regularTitle = 'productTarget?.providerId ? "模型接入"'
  const advancedTitle = 'productTarget?.providerId && advancedOpen ? "模型自定义设置" : productTarget?.providerId ? "模型接入"'
  source = source.replace(/productTarget\?\.providerId && advancedOpen \? "模型自定义设置" : (?:productTarget\?\.providerId && advancedOpen \? "模型自定义设置" : )+productTarget\?\.providerId \? "模型接入"/g, advancedTitle)
  if (!source.includes(advancedTitle) && source.includes(regularTitle)) source = source.replaceAll(regularTitle, advancedTitle)
  const regularEditorCall = 'onConflictReload: () => props.controller.load(), onClose: finish'
  const advancedEditorCall = 'onConflictReload: () => props.controller.load(), onAdvancedStateChange: props.onAdvancedStateChange, onClose: finish'
  if (source.includes(regularEditorCall) && !source.includes(advancedEditorCall)) {
    source = replaceExactlyOnce(source, regularEditorCall, advancedEditorCall, 'advanced editor title callback')
  }
  const regularOverlayCall = 'productTarget, onValidationState: setValidationError, onClose: close'
  if (source.includes(regularOverlayCall)) {
    source = replaceExactlyOnce(source, regularOverlayCall,
      'productTarget, onValidationState: setValidationError, onAdvancedStateChange: setAdvancedOpen, onClose: close',
      'advanced editor state callback')
  }
  if (!source.includes('className: advancedOpen ? "pangea-model-advanced-overlay"')) {
    source = replaceExactlyOnce(source,
      '"data-pangea-model-settings-overlay": "true",\n\t\t\t\tstyle:',
      '"data-pangea-model-settings-overlay": "true",\n\t\t\t\tclassName: advancedOpen ? "pangea-model-advanced-overlay" : void 0,\n\t\t\t\tstyle:',
      'advanced editor overlay class')
  }
  if (!source.includes('className: advancedOpen ? "pangea-model-advanced-dialog"')) {
    source = replaceExactlyOnce(source,
      'role: "dialog",\n\t\t\t\t\t"aria-modal": capacityOpen ? false : true,',
      'role: "dialog",\n\t\t\t\t\tclassName: advancedOpen ? "pangea-model-advanced-dialog" : void 0,\n\t\t\t\t\t"aria-modal": capacityOpen ? false : true,',
      'advanced editor dialog class')
  }
  if (!source.includes('pangea-model-advanced-content')) {
    source = replaceExactlyOnce(source,
      '(0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\tstyle: { minHeight: 0, overflow: "auto", padding: "24px 30px 36px" },',
      '(0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\tclassName: advancedOpen ? "pangea-model-overlay-body pangea-model-advanced-content" : "pangea-model-overlay-body",\n\t\t\t\t\t\tstyle: { minHeight: 0, overflow: "auto", padding: "24px 30px 36px" },',
      'advanced editor content class')
  }
  const oldShow = 'setValidationError(false); setProductTarget(event.detail); setOpen(true);'
  if (source.includes(oldShow)) source = replaceExactlyOnce(source, oldShow,
    'setValidationError(false); setAdvancedOpen(false); setProductTarget(event.detail); setOpen(true);',
    'advanced editor state reset on open')
  const oldClose = 'const close = () => { setValidationError(false); setOpen(false); };'
  if (source.includes(oldClose)) source = replaceExactlyOnce(source, oldClose,
    'const close = () => { setValidationError(false); setAdvancedOpen(false); setOpen(false); };',
    'advanced editor state reset on close')
  return source
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

function publishProductModelSummary(source) {
  if (source.includes('detail: { required, modelAvailable, customAvailable, status, error, connections }')) return source
  return replaceRegexExactlyOnce(source,
    /(?:const connections = state\.rows\.filter[\s\S]*?\n\s*\}\);\s*)?window\.dispatchEvent\(new CustomEvent\("pangea:model-onboarding-state", \{ detail: \{ required, modelAvailable, customAvailable, status: state.status(?:, error: state.error, connections)? \} \}\)\);/g,
    `const connections = state.rows.filter(row => row.configured || row.entry.active).map(row => {
            const namespace = state.namespaces.get(row.entry.settingsNs);
            const profile = namespace ? props.schema.getPath(namespace.value, row.entry.settingsPath) : undefined;
            const models = Array.isArray(profile?.models) ? profile.models.map(model => ({ id: model.id, name: model.name || model.id, input: model.input })) : null;
            return { id: row.entry.provider, name: row.entry.displayName || row.entry.provider, modelCount: models?.length ?? null, models, baseURL: profile?.baseURL, protocol: profile?.api, custom: row.entry.declared === true, credentialConfigured: row.credential?.configured === true, credentialRequired: row.apiKeyEnv !== undefined, usable: providerUsable(row) };
          });
          window.dispatchEvent(new CustomEvent("pangea:model-onboarding-state", { detail: { required, modelAvailable, customAvailable, status: state.status, error: state.error, connections } }));`,
    'product model summary publication')
}

function installProductEditorTargets(source) {
  if (!source.includes('const [productTarget, setProductTarget]')) {
    source = replaceExactlyOnce(source,
      '\t\tfunction PangeaInternalModelSettings(props) {\n\t\t\treturn (0, react_jsx_runtime.jsx)(ModelsSection, { ...props });\n\t\t}',
      `\t\tfunction PangeaInternalModelSettings(props) {
      const state = props.useSnapshot(snapshot => snapshot);
      const finish = changed => { if (changed) void props.controller.load(); props.onClose(); };
      if (state.status === "idle" || state.status === "loading") return (0, react_jsx_runtime.jsxs)("div", {
        className: "pangea-model-overlay-state pangea-model-overlay-loading",
        role: "status", "aria-busy": "true",
        children: [(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-loading-label", children: [(0, react_jsx_runtime.jsx)("span", { className: "pangea-model-overlay-spinner", "aria-hidden": "true" }), "正在读取内部模型设置…"] }),
          (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-overlay-skeleton", style: { width: "45%" } }),
          (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-overlay-skeleton pangea-model-overlay-skeleton-large" }),
          (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-overlay-skeleton", style: { width: "68%" } }),
          (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-overlay-skeleton pangea-model-overlay-skeleton-large" }),
          (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-overlay-actions", children: (0, react_jsx_runtime.jsx)("button", { type: "button", onClick: props.onClose, children: "关闭" }) })]
      });
      if (state.status === "error") {
        const reopen = () => {
          const target = props.productTarget;
          props.onClose();
          requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("pangea:open-model-settings", { detail: target })));
        };
        return (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-state pangea-model-overlay-error", role: "alert", children: [
          (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-notice", title: state.error, children: [(0, react_jsx_runtime.jsx)("strong", { children: "模型设置暂时不可用" }), (0, react_jsx_runtime.jsx)("p", { children: "读取内部模型配置失败，请关闭后重新打开。" })] }),
          (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-actions", children: [(0, react_jsx_runtime.jsx)("button", { type: "button", onClick: props.onClose, children: "关闭" }), (0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-model-overlay-primary", onClick: reopen, children: "重新打开" })] })
        ] });
      }
      const namespace = state.namespaces.get("llm-pi-ai");
      if (props.productTarget?.create && namespace === void 0) return (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-state pangea-model-overlay-unavailable", children: [
        (0, react_jsx_runtime.jsx)("span", { className: "pangea-model-overlay-unavailable-icon", "aria-hidden": "true", children: "⌑" }),
        (0, react_jsx_runtime.jsx)("h2", { children: "当前适配器不支持内部自定义模型" }),
        (0, react_jsx_runtime.jsx)("p", { children: "内部模型设置需要当前部署提供对应的模型适配器。" }),
        (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-overlay-actions", children: (0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-model-overlay-primary", onClick: props.onClose, children: "返回设置" }) })
      ] });
      if (state.status === "ready" && props.productTarget?.create && namespace) return (0, react_jsx_runtime.jsx)(CustomProviderCard, {
        taken: state.rows.map(row => row.entry.provider), protocols: protocolChoices(namespace, props.schema), revision: namespace.revision,
        api: props.api, t: props.t, readOnly: !state.writable, onValidationState: props.onValidationState, onClose: finish
      });
      const row = state.rows.find(row => row.entry.provider === props.productTarget?.providerId);
      const owner = row && state.namespaces.get(row.entry.settingsNs);
      if (state.status === "ready" && row && owner) return renderProviderEditor({ target: targetOf(row), namespace: owner, schema: props.schema, api: props.api, t: props.t, readOnly: !state.writable, onClose: finish });
      return (0, react_jsx_runtime.jsx)(ModelsSection, { ...props });
    }`, 'product editor target')
    source = replaceExactlyOnce(source,
      '\t\t\tconst [open, setOpen] = (0, react.useState)(false);',
      '\t\t\tconst [open, setOpen] = (0, react.useState)(false);\n\t\t\tconst [productTarget, setProductTarget] = (0, react.useState)(null);', 'product target state')
    source = replaceExactlyOnce(source,
      'const show = () => setOpen(true);',
      'const show = event => { modelSettingsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setProductTarget(event.detail); setOpen(true); };', 'product target event')
    source = replaceExactlyOnce(source,
      'PangeaInternalModelSettings, { ...props, onClose: close }',
      'PangeaInternalModelSettings, { ...props, productTarget, onClose: close }', 'product target render')
  }
  if (!source.includes('const modelSettingsReturnFocus = (0, react.useRef)(null);')) {
    source = replaceExactlyOnce(source,
      'const [productTarget, setProductTarget] = (0, react.useState)(null);',
      'const [productTarget, setProductTarget] = (0, react.useState)(null);\n\t\t\tconst modelSettingsReturnFocus = (0, react.useRef)(null);',
      'model settings return focus state')
  }
  const oldShow = 'const show = event => { setProductTarget(event.detail); setOpen(true); };'
  const focusedShow = 'const show = event => { modelSettingsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setProductTarget(event.detail); setOpen(true); };'
  if (source.includes(oldShow)) source = replaceExactlyOnce(source, oldShow, focusedShow, 'model settings trigger focus capture')
  if (!source.includes('modelSettingsReturnFocus.current = null;')) {
    const showEffect = '\t\t\t\treturn () => window.removeEventListener("pangea:open-model-settings", show);\n\t\t\t}, []);'
    source = replaceExactlyOnce(source, showEffect, `${showEffect}\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tif (open || !modelSettingsReturnFocus.current) return;\n\t\t\t\tconst trigger = modelSettingsReturnFocus.current;\n\t\t\t\tmodelSettingsReturnFocus.current = null;\n\t\t\t\trequestAnimationFrame(() => { if (trigger.isConnected && !trigger.closest("[inert]") && !trigger.closest('[aria-hidden="true"]')) trigger.focus(); });\n\t\t\t}, [open]);`, 'model settings focus restoration')
  }
  if (!source.includes('pangea-model-overlay-loading')) {
    const stateViews = `      if (state.status === "idle" || state.status === "loading") return (0, react_jsx_runtime.jsxs)("div", {
        className: "pangea-model-overlay-state pangea-model-overlay-loading",
        role: "status", "aria-busy": "true",
        children: [(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-loading-label", children: [(0, react_jsx_runtime.jsx)("span", { className: "pangea-model-overlay-spinner", "aria-hidden": "true" }), "正在读取内部模型设置…"] }),
          (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-overlay-skeleton", style: { width: "45%" } }),
          (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-overlay-skeleton pangea-model-overlay-skeleton-large" }),
          (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-overlay-skeleton", style: { width: "68%" } }),
          (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-overlay-skeleton pangea-model-overlay-skeleton-large" }),
          (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-overlay-actions", children: (0, react_jsx_runtime.jsx)("button", { type: "button", onClick: props.onClose, children: "关闭" }) })]
      });
      if (state.status === "error") {
        const reopen = () => {
          const target = props.productTarget;
          props.onClose();
          requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("pangea:open-model-settings", { detail: target })));
        };
        return (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-state pangea-model-overlay-error", role: "alert", children: [
          (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-notice", title: state.error, children: [(0, react_jsx_runtime.jsx)("strong", { children: "模型设置暂时不可用" }), (0, react_jsx_runtime.jsx)("p", { children: "读取内部模型配置失败，请关闭后重新打开。" })] }),
          (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-actions", children: [(0, react_jsx_runtime.jsx)("button", { type: "button", onClick: props.onClose, children: "关闭" }), (0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-model-overlay-primary", onClick: reopen, children: "重新打开" })] })
        ] });
      }
`;
    source = replaceExactlyOnce(source,
      'const finish = changed => { if (changed) void props.controller.load(); props.onClose(); };\n      const namespace = state.namespaces.get("llm-pi-ai");',
      `const finish = changed => { if (changed) void props.controller.load(); props.onClose(); };\n${stateViews}      const namespace = state.namespaces.get("llm-pi-ai");`, 'model loading and error views')
    source = replaceExactlyOnce(source,
      'const namespace = state.namespaces.get("llm-pi-ai");\n      if (state.status === "ready" && props.productTarget?.create && namespace)',
      'const namespace = state.namespaces.get("llm-pi-ai");\n      if (props.productTarget?.create && namespace === void 0) return (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-state pangea-model-overlay-unavailable", children: [\n        (0, react_jsx_runtime.jsx)("span", { className: "pangea-model-overlay-unavailable-icon", "aria-hidden": "true", children: "⌑" }),\n        (0, react_jsx_runtime.jsx)("h2", { children: "当前适配器不支持内部自定义模型" }),\n        (0, react_jsx_runtime.jsx)("p", { children: "内部模型设置需要当前部署提供对应的模型适配器。" }),\n        (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-overlay-actions", children: (0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-model-overlay-primary", onClick: props.onClose, children: "返回设置" }) })\n      ] });\n      if (state.status === "ready" && props.productTarget?.create && namespace)', 'missing model adapter view')
  }
  if (!source.includes('const wasOpen = (0, react.useRef)(false);')) {
    source = replaceExactlyOnce(source,
      '\t\t\tconst [productTarget, setProductTarget] = (0, react.useState)(null);',
      '\t\t\tconst [productTarget, setProductTarget] = (0, react.useState)(null);\n\t\t\tconst wasOpen = (0, react.useRef)(false);\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tconst reopenedAfterFailure = open && !wasOpen.current && state.status === "error";\n\t\t\t\twasOpen.current = open;\n\t\t\t\tif (reopenedAfterFailure) void props.controller.load();\n\t\t\t}, [open, props.controller, state.status]);', 'reopen failed model settings')
  }
  source = source.replace('const reopenedAfterFailure = open && !wasOpen.current && state.status === "error";', 'const reopenedAfterFailure = shouldReloadModelSettingsAfterOpen(wasOpen.current, open, state.status);')
  if (source.includes('const [productTarget, setProductTarget]') && !source.includes('onConflictReload: () => props.controller.load()')) {
    source = replaceExactlyOnce(source,
      'if (state.status === "ready" && row && owner) return renderProviderEditor({ target: targetOf(row), namespace: owner, schema: props.schema, api: props.api, t: props.t, readOnly: !state.writable, onClose: finish });',
      'if (state.status === "ready" && row && owner) return renderProviderEditor({ target: targetOf(row), namespace: owner, schema: props.schema, api: props.api, t: props.t, readOnly: !state.writable, productReadOnly: !state.writable, key: `${props.productTarget?.providerId}:${String(owner.revision)}`, onConflictReload: () => props.controller.load(), onClose: finish });',
      'model conflict reload and read-only state')
  }
  const providerEditorCall = 'if (state.status === "ready" && row && owner) return renderProviderEditor({ target: targetOf(row), namespace: owner, schema: props.schema, api: props.api, t: props.t, readOnly: !state.writable, productReadOnly: !state.writable, key: `${props.productTarget?.providerId}:${String(owner.revision)}`, onConflictReload: () => props.controller.load(), onClose: finish });'
  if (!source.includes('className: "pangea-model-provider-edit pangea-model-overlay-state"')) {
    source = replaceExactlyOnce(source, providerEditorCall,
      'if (state.status === "ready" && row && owner) return (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-provider-edit pangea-model-overlay-state", children: [\n        (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-provider-summary", children: [\n          (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-provider-identity", children: [\n            (0, react_jsx_runtime.jsx)("span", { className: "pangea-model-provider-mark", "aria-hidden": "true", children: String(row.entry.provider || row.entry.displayName).trim().charAt(0).toUpperCase() }),\n            (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("strong", { children: row.entry.displayName || row.entry.provider }), (0, react_jsx_runtime.jsxs)("p", { children: [row.entry.provider, " · ", row.entry.declared === true ? "自定义接口" : "模型接口"] })] })\n          ] }),\n          (0, react_jsx_runtime.jsx)("span", { className: row.credential?.configured === true ? "pangea-model-provider-status is-configured" : "pangea-model-provider-status", role: "status", children: row.credential?.configured === true ? "API 密钥已配置" : row.credential?.configured === false ? "API 密钥未配置" : "密钥状态不可用" })\n        ] }),\n        renderProviderEditor({ target: targetOf(row), namespace: owner, schema: props.schema, api: props.api, t: props.t, readOnly: !state.writable, productReadOnly: !state.writable, productPresentation: true, key: `${props.productTarget?.providerId}:${String(owner.revision)}`, onConflictReload: () => props.controller.load(), onClose: finish })\n      ] });',
      'scoped product provider editor presentation')
  }
  const previousProviderMark = 'String(row.entry.displayName || row.entry.provider).trim().charAt(0).toUpperCase()'
  if (source.includes(previousProviderMark)) source = replaceExactlyOnce(source, previousProviderMark,
    'String(row.entry.provider || row.entry.displayName).trim().charAt(0).toUpperCase()', 'provider route mark')
  const customProviderProps = 'api: props.api, t: props.t, readOnly: !state.writable, onClose: finish'
  if (source.includes(customProviderProps)) source = replaceExactlyOnce(source, customProviderProps,
    'api: props.api, t: props.t, readOnly: !state.writable, onValidationState: props.onValidationState, onClose: finish',
    'custom provider validation callback')
  return source
}

function keepCustomCreateMountedDuringRefresh(source) {
  const start = source.indexOf('function PangeaInternalModelSettings(props) {')
  const end = source.indexOf('\n\t\tfunction pangeaModelText', start)
  if (start < 0 || end < start) throw new Error('Missing PANGEA model settings content for create retry retention')
  let body = source.slice(start, end)
  const stateLine = ['const state = props.useSnapshot((snapshot) => snapshot);', 'const state = props.useSnapshot(snapshot => snapshot);'].find(line => body.includes(line))
  const retainedState = `
			const lastReadySnapshot = (0, react.useRef)(void 0);
			if (state.status === "ready") lastReadySnapshot.current = state;
			const viewState = state.status === "loading" && props.productTarget?.create && lastReadySnapshot.current ? lastReadySnapshot.current : state;`
  if (!body.includes('const viewState = state.status === "loading"')) {
    if (!stateLine) throw new Error('PANGEA model settings patch: missing snapshot hook anchor')
    body = replaceExactlyOnce(body, stateLine, stateLine + retainedState, 'retain last ready provider snapshot during credential retry')
  }
  const viewStart = body.indexOf('const viewState = state.status === "loading"')
  const restStart = body.indexOf('\n', viewStart) + 1
  body = body.slice(0, restStart) + body.slice(restStart).replaceAll('state.', 'viewState.')
  body = body.replace('if ((viewState.status === "idle" || viewState.status === "loading") && !(props.productTarget?.create && viewState.namespaces.get("llm-pi-ai") !== void 0)) return',
    'if (viewState.status === "idle" || viewState.status === "loading") return')
  body = body.replace('if ((viewState.status === "ready" || viewState.status === "loading") && props.productTarget?.create && namespace)',
    'if (viewState.status === "ready" && props.productTarget?.create && namespace)')
  if (!body.includes('const viewState = state.status === "loading"') || !body.includes('if (viewState.status === "idle" || viewState.status === "loading") return') || !body.includes('if (viewState.status === "ready" && props.productTarget?.create && namespace)')) {
    throw new Error('PANGEA model settings patch: failed to retain the last ready create snapshot')
  }
  return source.slice(0, start) + body + source.slice(end)
}

function installProductReadonlyTitle(source) {
  const start = source.indexOf('function PangeaModelSettingsOverlay(props) {')
  const end = source.indexOf('\n\t\tfunction PangeaAwareDeepSeekOnboardingDialog', start)
  if (start < 0 || end < start) throw new Error('Missing model overlay title state')
  let body = source.slice(start, end)
  if (body.includes('"环境凭据只读"')) return source
  const validationState = '\t\t\tconst [validationError, setValidationError] = (0, react.useState)(false);'
  if (!body.includes(validationState)) body = replaceExactlyOnce(body, 'const [productTarget, setProductTarget] = (0, react.useState)(null);', `const [productTarget, setProductTarget] = (0, react.useState)(null);\n${validationState}`, 'model validation title state')
  const credentialRetryState = '\t\t\tconst [credentialRetry, setCredentialRetry] = (0, react.useState)(false);'
  if (!body.includes(credentialRetryState)) body = replaceExactlyOnce(body, validationState, `${validationState}\n${credentialRetryState}`, 'model credential retry title state')
  const oldShow = 'const show = event => { modelSettingsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setProductTarget(event.detail); setOpen(true); };'
  const validationShow = 'const show = event => { modelSettingsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setValidationError(false); setProductTarget(event.detail); setOpen(true); };'
  const retryShow = 'const show = event => { modelSettingsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setValidationError(false); setCredentialRetry(false); setProductTarget(event.detail); setOpen(true); };'
  if (body.includes(oldShow)) body = replaceExactlyOnce(body, oldShow, retryShow, 'model validation reset on open')
  else if (body.includes(validationShow)) body = replaceExactlyOnce(body, validationShow, retryShow, 'model credential retry reset on open')
  const oldClose = 'const close = () => setOpen(false);'
  const validationClose = 'const close = () => { setValidationError(false); setOpen(false); };'
  const retryClose = 'const close = () => { setValidationError(false); setCredentialRetry(false); setOpen(false); };'
  if (body.includes(oldClose)) body = replaceExactlyOnce(body, oldClose, retryClose, 'model validation reset on close')
  else if (body.includes(validationClose)) body = replaceExactlyOnce(body, validationClose, retryClose, 'model credential retry reset on close')
  const oldCreateView = 'PangeaInternalModelSettings, { ...props, t: pangeaModelText, productTarget, onClose: close }'
  const validationCreateView = 'PangeaInternalModelSettings, { ...props, t: pangeaModelText, productTarget, onValidationState: setValidationError, onClose: close }'
  const advancedValidationCreateView = 'PangeaInternalModelSettings, { ...props, t: pangeaModelText, productTarget, onValidationState: setValidationError, onAdvancedStateChange: setAdvancedOpen, onClose: close }'
  const retryCreateView = 'PangeaInternalModelSettings, { ...props, t: pangeaModelText, productTarget, onValidationState: setValidationError, onAdvancedStateChange: setAdvancedOpen, onCredentialRetry: setCredentialRetry, onClose: close }'
  const retryCreateViewSimple = 'PangeaInternalModelSettings, { ...props, t: pangeaModelText, productTarget, onValidationState: setValidationError, onCredentialRetry: setCredentialRetry, onClose: close }'
  if (body.includes(advancedValidationCreateView)) body = replaceExactlyOnce(body, advancedValidationCreateView, retryCreateView, 'model credential retry state callback')
  else if (body.includes(validationCreateView)) body = replaceExactlyOnce(body, validationCreateView, retryCreateViewSimple, 'model credential retry state callback')
  if (body.includes(oldCreateView)) body = replaceExactlyOnce(body, oldCreateView, validationCreateView, 'model validation state callback')
  const title = 'state.status === "error" ? "模型设置加载失败" : state.status === "idle" || state.status === "loading" ? "模型设置加载中" : productTarget?.create && !state.namespaces?.has("llm-pi-ai") ? "模型适配器不可用" : productTarget?.create && credentialRetry ? "连接已创建，凭据待保存" : productTarget?.create && validationError ? "模型连接字段校验" : productTarget?.create ? "连接模型接口" : productTarget?.providerId ? "模型接入" : "模型与 API 设置"'
  const advancedTitle = title.replace('productTarget?.providerId ? "模型接入"', 'productTarget?.providerId && advancedOpen ? "模型自定义设置" : productTarget?.providerId ? "模型接入"')
  const legacyTitle = title.replace('productTarget?.create && validationError ? "模型连接字段校验" : ', '')
  const previousTitle = title.replace('productTarget?.create && credentialRetry ? "连接已创建，凭据待保存" : ', '')
  const bareTitle = legacyTitle.replace('productTarget?.create && credentialRetry ? "连接已创建，凭据待保存" : ', '')
  const previousAdvancedTitle = previousTitle.replace('productTarget?.providerId ? "模型接入"', 'productTarget?.providerId && advancedOpen ? "模型自定义设置" : productTarget?.providerId ? "模型接入"')
  const readOnlyTitle = `state.status === "ready" && state.writable === false ? "模型设置只读" : ${title}`
  const readOnlyAdvancedTitle = `state.status === "ready" && state.writable === false ? "模型设置只读" : ${advancedTitle}`
  const previousReadOnlyAdvancedTitle = `state.status === "ready" && state.writable === false ? "模型设置只读" : ${previousAdvancedTitle}`
  const legacyReadOnlyTitle = `state.status === "ready" && state.writable === false ? "模型设置只读" : ${legacyTitle}`
  const bareReadOnlyTitle = `state.status === "ready" && state.writable === false ? "模型设置只读" : ${bareTitle}`
  body = body.split(previousReadOnlyAdvancedTitle).join(readOnlyAdvancedTitle)
  body = body.split(previousAdvancedTitle).join(readOnlyAdvancedTitle)
  const heading = `children: ${readOnlyTitle}`
  if (!body.includes(heading) && !body.includes(`children: ${readOnlyAdvancedTitle}`)) {
    if (body.includes(`children: ${legacyTitle}`)) body = replaceExactlyOnce(body, `children: ${legacyTitle}`, heading, 'model dialog title')
    else if (body.includes(`children: ${title}`)) body = replaceExactlyOnce(body, `children: ${title}`, heading, 'model dialog title')
    else if (body.includes(`children: ${advancedTitle}`)) body = replaceExactlyOnce(body, `children: ${advancedTitle}`, `children: ${readOnlyAdvancedTitle}`, 'model dialog title')
    else if (body.includes(`children: ${bareTitle}`)) body = replaceExactlyOnce(body, `children: ${bareTitle}`, heading, 'model dialog title')
    else if (body.includes('children: "内部模型设置" }),')) body = replaceExactlyOnce(body,
      'children: "内部模型设置" }),', `children: ${readOnlyTitle} }),`, 'model dialog title')
    else throw new Error('PANGEA model settings patch: missing model dialog title anchor')
  }
  const label = `"aria-label": ${readOnlyTitle},`
  const advancedLabel = `"aria-label": ${readOnlyAdvancedTitle},`
  if (!body.includes(label) && !body.includes(advancedLabel)) {
    if (body.includes(legacyReadOnlyTitle)) body = replaceExactlyOnce(body, legacyReadOnlyTitle, readOnlyTitle, 'model dialog label')
    else if (body.includes(bareReadOnlyTitle)) body = replaceExactlyOnce(body, bareReadOnlyTitle, readOnlyTitle, 'model dialog label')
    else if (body.includes(`"aria-label": ${legacyTitle},`)) body = body.replace(`"aria-label": ${legacyTitle},`, label)
    else if (body.includes(`"aria-label": ${title},`)) body = body.replace(`"aria-label": ${title},`, label)
    else if (body.includes(`"aria-label": ${advancedTitle},`)) body = body.replace(`"aria-label": ${advancedTitle},`, advancedLabel)
    else if (body.includes(`"aria-label": ${bareTitle},`)) body = body.replace(`"aria-label": ${bareTitle},`, label)
    else if (body.includes('"aria-label": "内部模型设置",')) body = body.replace('"aria-label": "内部模型设置",', label)
    else throw new Error('PANGEA model settings patch: missing model dialog label anchor')
  }
  return source.slice(0, start) + body + source.slice(end)
}

function installCredentialRetryState(source) {
  const start = source.indexOf('function PangeaInternalModelSettings(props) {')
  const end = source.indexOf('\n\t\tfunction pangeaModelText', start)
  if (start < 0 || end < start) throw new Error('Missing model editor target for credential retry state')
  let body = source.slice(start, end)
  const oldProp = 'onValidationState: props.onValidationState, onClose: finish'
  const newProp = 'onValidationState: props.onValidationState, onCredentialRetry: props.onCredentialRetry, onClose: finish'
  if (body.includes(oldProp)) body = replaceExactlyOnce(body, oldProp, newProp, 'custom provider credential retry callback')
  if (!body.includes(newProp)) throw new Error('Missing custom provider credential retry callback')
  return source.slice(0, start) + body + source.slice(end)
}

function removeOfficialModelSetup(source) {
  if (source.includes('function pangeaModelProvider(entry)')) return source
  source = replaceExactlyOnce(source,
    '\t\tfunction providerUsable(row) {',
    '\t\tfunction pangeaModelProvider(entry) {\n\t\t\treturn entry.settingsNs !== "llm-deepseek" && entry.provider !== "deepseek-official" && entry.provider !== "deepseek";\n\t\t}\n\t\tfunction providerUsable(row) {',
    'provider setup policy')
  return replaceExactlyOnce(source,
    'providers = providersResponse.result.value.providers;',
    'providers = providersResponse.result.value.providers.filter(pangeaModelProvider);',
    'provider directory')
}

let source = await readFile(clientPath, 'utf8')
if (source.includes('function pangeaModelProvider(entry)') && source.includes('pangea-model-conflict-state') && source.includes('pangea-model-advanced-provider-id')) process.exit(0)
const before = source
source = installOverlay(source)
source = source.replace('inset: 0, zIndex: 900, display: "grid"', 'inset: 0, zIndex: 20000, display: "grid"')
source = source.replace('const onKeyDown = (event) => { if (event.key === "Escape") setOpen(false); };', `const onKeyDown = (event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          const overlay = document.querySelector("[data-pangea-model-settings-overlay]");
          const nested = [...document.querySelectorAll('[role="dialog"]')].some(dialog => !overlay?.contains(dialog) && dialog.getClientRects().length > 0);
          if (!nested) setOpen(false);
        };`)
source = restoreNativeModelsSection(source)
source = publishAllModelReadiness(source)
source = publishProductModelSummary(source)
source = installProductEditorTargets(source)
if (!source.includes('pangea:model-settings-visibility')) {
  source = replaceExactlyOnce(source, '\t\t\tif (!open) return null;', `\t\t\t(0, react.useEffect)(() => {
        window.dispatchEvent(new CustomEvent("pangea:model-settings-visibility", { detail: { open, create: productTarget?.create === true } }));
      }, [open, productTarget]);
\t\t\tif (!open) return null;`, 'model settings visibility')
}
source = installCustomProviderView(source)
source = installCustomProviderRetryState(source)
source = installProductModelCopy(source)
source = installProductReadonlyTitle(source)
source = keepCustomCreateMountedDuringRefresh(source)
source = installProviderReadonlyView(source)
source = installModelCatalogView(source)
source = installProviderAdvancedView(source)
source = installAdvancedProviderTitle(source)
source = installCredentialRetryState(source)
source = installProviderConflictReload(source)
source = wrapNativeOnboardingRegistration(source)
source = removeOfficialModelSetup(source)
if (source !== before) await writeFile(clientPath, source, 'utf8')
