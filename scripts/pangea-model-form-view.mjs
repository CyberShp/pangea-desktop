const customProviderView = `
      // PANGEA custom-provider presentation; state and writes remain native.
      const field = (label, control, note) => (0, react_jsx_runtime.jsxs)("label", { className: "pangea-model-field", children: [
        (0, react_jsx_runtime.jsx)("span", { children: label }), control,
        note && (0, react_jsx_runtime.jsx)("small", { children: note })
      ] });
      const input = (label, value, change, extra = {}) => (0, react_jsx_runtime.jsx)("input", {
        "aria-label": label, value, disabled: profileDisabled, onChange: event => change(event.target.value), ...extra
      });
      (0, react.useEffect)(() => { props.onValidationState?.(routeInvalid || routeTaken); }, [routeInvalid, routeTaken, props.onValidationState]);
      (0, react.useEffect)(() => { props.onCredentialRetry?.(committed && failure !== void 0); }, [committed, failure, props.onCredentialRetry]);
      if (committed && failure !== void 0) return (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-create pangea-model-key-retry", children: [
        (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-key-warning", role: "status", children: [
          (0, react_jsx_runtime.jsx)("span", { className: "pangea-model-validation-icon", "aria-hidden": "true", children: "!" }),
          (0, react_jsx_runtime.jsxs)("div", { children: [
            (0, react_jsx_runtime.jsx)("strong", { children: "API 密钥尚未保存" }),
            (0, react_jsx_runtime.jsx)("p", { children: "提供方配置已保存，凭据写入未完成。这里只需重试保存密钥。" })
          ] })
        ] }),
        (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-grid", children: [
          field(t("customRoute"), input(t("customRoute"), route, setRoute, { readOnly: true, disabled: true })),
          field(t("baseUrl"), input(t("baseUrl"), baseURL, setBaseURL, { readOnly: true, disabled: true }))
        ] }),
        (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-key", children: field(t("keyInput"), input(t("keyInput"), keyDraft, setKeyDraft, { type: "password", autoComplete: "off", disabled, placeholder: "重新输入 API 密钥" }), "连接字段已锁定，避免重复创建。") }),
        (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-footer", children: [
          (0, react_jsx_runtime.jsx)("button", { type: "button", onClick: () => props.onClose(true), children: "关闭" }),
          (0, react_jsx_runtime.jsx)("button", { type: "button", disabled: disabled || keyValue.length === 0, onClick: create, children: "重试保存密钥" })
        ] })
      ] });
      return (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-create", children: [
        (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-grid", children: [
          field(t("customRoute"), input(t("customRoute"), route, setRoute, { placeholder: "team-gateway", "aria-invalid": routeInvalid || routeTaken, "aria-describedby": routeInvalid || routeTaken ? "pangea-model-route-error" : void 0 }), t("customRouteHint")),
          field(t("customDisplayName"), input(t("customDisplayName"), displayName, setDisplayName)),
          field(t("baseUrl"), input(t("baseUrl"), baseURL, setBaseURL, { placeholder: "https://models.example.com/v1" })),
          field(t("customApi"), (0, react_jsx_runtime.jsx)("select", { "aria-label": t("customApi"), value: protocol, disabled: profileDisabled, onChange: event => setProtocol(event.target.value), children: protocols.map(choice => (0, react_jsx_runtime.jsx)("option", { value: choice, children: choice }, choice)) }))
        ] }),
        (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-key", children: field(t("keyInput"), input(t("keyInput"), keyDraft, setKeyDraft, { type: "password", autoComplete: "off", disabled, placeholder: t("keyPlaceholderNative") }), "密钥单独保存，不写入设置文件。") }),
        routeInvalid || routeTaken ? (0, react_jsx_runtime.jsxs)("div", { role: "alert", id: "pangea-model-route-error", className: "pangea-model-validation-alert", children: [
          (0, react_jsx_runtime.jsx)("span", { className: "pangea-model-validation-icon", "aria-hidden": "true", children: "!" }),
          (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-validation-copy", children: [
            (0, react_jsx_runtime.jsx)("strong", { children: "请修正提供方 ID" }),
            (0, react_jsx_runtime.jsx)("p", { children: routeInvalid ? "ID 必须以小写字母开头，后续使用小写字母、数字或连接符。" : "已有提供方使用这个 ID。请输入未占用的 ID。" })
          ] })
        ] }) : null,
        keyFailure !== void 0 && (0, react_jsx_runtime.jsx)("p", { role: "alert", className: "pangea-model-error", children: t(keyFailure === "keyBlank" ? "keyBlankNew" : keyFailure) }),
        (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-catalog", children: [
          (0, react_jsx_runtime.jsx)(ModelListEditor, { models, onChange: setModels, modelQuery, onModelQueryChange: setModelQuery,
            probe: { settingsNs: NS$1, baseURL, api: protocol, ...keyValue.length === 0 ? {} : { apiKey: keyValue } },
            probeBlocked: keyFailure === "keyBlank" ? "keyBlankNew" : keyFailure, api, t, disabled: profileDisabled }),
          (0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-model-add", disabled: profileDisabled, onClick: addModel, children: t("addModel") }),
          (0, react_jsx_runtime.jsx)("p", { className: "pangea-model-note", children: "模型 ID 必须唯一。自定义接口至少需要一个模型。" })
        ] }),
        failure !== void 0 && (0, react_jsx_runtime.jsx)("p", { role: "alert", className: "pangea-model-error", children: failure }),
        hint !== void 0 && (0, react_jsx_runtime.jsx)("p", { className: "pangea-model-note", children: hint }),
        (0, react_jsx_runtime.jsx)("div", { className: "pangea-model-footer", children: (0, react_jsx_runtime.jsx)(EditorFooter, {
          t, busy, submitDisabled: disabled || !ready, submitLabel: committed ? "retryKey" : "create", submitBusyLabel: "creating",
          onCancel: () => props.onClose(committed), onSubmit: () => create()
        }) })
      ] });`;

export function installCustomProviderView(source) {
  const start = source.indexOf('function CustomProviderCard(props) {');
  const end = source.indexOf('\n\t\t}\n\t\t//#endregion', start);
  const render = source.indexOf('// PANGEA custom-provider presentation;', start);
  const nativeRender = source.indexOf('\n\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {', start);
  const offset = render >= start && render < end ? source.lastIndexOf('\n', render) : nativeRender;
  if (start < 0 || end < start || offset < start || offset >= end) throw new Error('Missing custom provider presentation anchor');
  return source.slice(0, offset) + customProviderView + source.slice(end);
}

export function installCustomProviderRetryState(source) {
  const start = source.indexOf('function CustomProviderCard(props) {');
  const end = source.indexOf('\n\t\t}\n\t\t//#endregion', start);
  if (start < 0 || end < start) throw new Error('Missing custom-provider retry state');
  let body = source.slice(start, end);
  body = body.replace('const routeTaken = taken.includes(route);', 'const routeTaken = !committed && taken.includes(route);');
  body = body.replace('if (!stored.result.ok) return stored.result.error.message;', 'if (!stored.result.ok) { setKeyDraft(""); return stored.result.error.message; }');
  if (!body.includes('const routeTaken = !committed && taken.includes(route);')) throw new Error('Missing committed-provider duplicate guard');
  if (!body.includes('if (!stored.result.ok) { setKeyDraft(""); return stored.result.error.message; }')) throw new Error('Missing credential failure key clear');
  return source.slice(0, start) + body + source.slice(end);
}

export function installProductModelCopy(source) {
  if (source.includes('"环境凭据只读"') && source.includes('PangeaInternalModelSettings, { ...props, t: pangeaModelText')) return source;
  const original = 'PangeaInternalModelSettings, { ...props, productTarget, onClose: close }';
  const localized = 'PangeaInternalModelSettings, { ...props, t: pangeaModelText, productTarget, onClose: close }';
  const validationLocalized = 'PangeaInternalModelSettings, { ...props, t: pangeaModelText, productTarget, onValidationState: setValidationError, onClose: close }';
  const advancedLocalized = 'PangeaInternalModelSettings, { ...props, t: pangeaModelText, productTarget, onValidationState: setValidationError, onAdvancedStateChange: setAdvancedOpen, onClose: close }';
  const credentialRetryLocalized = 'PangeaInternalModelSettings, { ...props, t: pangeaModelText, productTarget, onValidationState: setValidationError, onAdvancedStateChange: setAdvancedOpen, onCredentialRetry: setCredentialRetry, onClose: close }';
  if (!source.includes(original) && !source.includes(localized) && !source.includes(validationLocalized) && !source.includes(advancedLocalized) && !source.includes(credentialRetryLocalized)) throw new Error('Missing model overlay content');
  source = source.replace(original, localized);
  source = source.replace(/productTarget\?\.providerId && advancedOpen \? "模型自定义设置" : (?:productTarget\?\.providerId && advancedOpen \? "模型自定义设置" : )+productTarget\?\.providerId \? "模型接入"/g,
    'productTarget?.providerId && advancedOpen ? "模型自定义设置" : productTarget?.providerId ? "模型接入"');
  const priorTitle = 'children: productTarget?.create ? "连接模型接口" : "模型与 API 设置" }), (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } })';
  const initialTitle = 'children: "模型与 API 设置" }), (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } })';
  const fixedTitle = 'children: "内部模型设置" }), (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } })';
  const legacyStateTitle = 'children: state.status === "error" ? "模型设置加载失败" : state.status === "idle" || state.status === "loading" ? "模型设置加载中" : productTarget?.create && !state.namespaces?.has("llm-pi-ai") ? "模型适配器不可用" : productTarget?.create ? "连接模型接口" : "模型与 API 设置" }), (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } })';
  const stateTitle = 'children: state.status === "error" ? "模型设置加载失败" : state.status === "idle" || state.status === "loading" ? "模型设置加载中" : productTarget?.create && !state.namespaces?.has("llm-pi-ai") ? "模型适配器不可用" : productTarget?.create ? "连接模型接口" : productTarget?.providerId ? "模型接入" : "模型与 API 设置" }), (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } })';
  const validationStateTitle = stateTitle.replace('productTarget?.create ? "连接模型接口"', 'productTarget?.create && validationError ? "模型连接字段校验" : productTarget?.create ? "连接模型接口"');
  const credentialRetryStateTitle = validationStateTitle.replace('productTarget?.create && validationError ? "模型连接字段校验"', 'productTarget?.create && credentialRetry ? "连接已创建，凭据待保存" : productTarget?.create && validationError ? "模型连接字段校验"');
  const advancedStateTitle = stateTitle.replace('productTarget?.providerId ? "模型接入"', 'productTarget?.providerId && advancedOpen ? "模型自定义设置" : productTarget?.providerId ? "模型接入"');
  const advancedValidationStateTitle = validationStateTitle.replace('productTarget?.providerId ? "模型接入"', 'productTarget?.providerId && advancedOpen ? "模型自定义设置" : productTarget?.providerId ? "模型接入"');
  const advancedCredentialRetryStateTitle = credentialRetryStateTitle.replace('productTarget?.providerId ? "模型接入"', 'productTarget?.providerId && advancedOpen ? "模型自定义设置" : productTarget?.providerId ? "模型接入"');
  const oldReadOnlyTitle = 'children: state.status === "ready" && state.writable === false ? "模型设置只读" : "模型与 API 设置" }), (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } })';
  const readOnlyStateTitle = 'children: state.status === "ready" && state.writable === false ? "模型设置只读" : ' + stateTitle.slice('children: '.length);
  const readOnlyValidationStateTitle = 'children: state.status === "ready" && state.writable === false ? "模型设置只读" : ' + validationStateTitle.slice('children: '.length);
  const readOnlyCredentialRetryStateTitle = 'children: state.status === "ready" && state.writable === false ? "模型设置只读" : ' + credentialRetryStateTitle.slice('children: '.length);
  const readOnlyAdvancedValidationStateTitle = 'children: state.status === "ready" && state.writable === false ? "模型设置只读" : ' + advancedValidationStateTitle.slice('children: '.length);
  const legacyReadOnlyStateTitle = 'children: state.status === "ready" && state.writable === false ? "模型设置只读" : ' + legacyStateTitle.slice('children: '.length);
  source = source.replace(priorTitle, stateTitle).replace(initialTitle, stateTitle).replace(fixedTitle, stateTitle).replace(legacyStateTitle, stateTitle).replace(oldReadOnlyTitle, readOnlyStateTitle).replace(legacyReadOnlyStateTitle, readOnlyStateTitle);
  const readOnlyAdvancedStateTitle = 'children: state.status === "ready" && state.writable === false ? "模型设置只读" : ' + advancedStateTitle.slice('children: '.length);
  const readOnlyAdvancedCredentialRetryStateTitle = 'children: state.status === "ready" && state.writable === false ? "模型设置只读" : ' + advancedCredentialRetryStateTitle.slice('children: '.length);
  if (!source.includes(stateTitle) && !source.includes(readOnlyStateTitle) && !source.includes(validationStateTitle) && !source.includes(readOnlyValidationStateTitle) && !source.includes(credentialRetryStateTitle) && !source.includes(readOnlyCredentialRetryStateTitle) && !source.includes(advancedStateTitle) && !source.includes(readOnlyAdvancedStateTitle) && !source.includes(advancedValidationStateTitle) && !source.includes(readOnlyAdvancedValidationStateTitle) && !source.includes(advancedCredentialRetryStateTitle) && !source.includes(readOnlyAdvancedCredentialRetryStateTitle)) throw new Error('Missing model settings title anchor');
  const marker = '\t\tfunction PangeaModelSettingsOverlay(props) {';
  const copy = `\t\tfunction pangeaModelText(key) {
      return ({ customRoute: "提供方 ID", customRouteHint: "使用小写字母开头的唯一标识。", baseUrl: "接口地址", models: "模型列表", addModel: "添加一行", fetchModels: "查询可用模型", create: "创建连接", apply: "应用", keyPlaceholderNative: "输入密钥，或使用提供方原生认证", keyStored: "已配置 · 输入新密钥以替换", retryKey: "重试保存密钥", modelAdvanced: "模型设置", modelContextWindow: "上下文窗口", modelMaxTokens: "最大输出 tokens", modelImageInput: "支持图像输入", modelImageInputShort: "支持图像输入", modelImageInputHint: "只在接口实际支持图像输入时启用。" })[key] ?? zh[key] ?? key;
    }
\t\tfunction shouldReloadModelSettingsAfterOpen(wasOpen, isOpen, status) {
\t\t\treturn isOpen && !wasOpen && status === "error";
\t\t}
\t\tfunction filterPangeaModelCandidates(candidates, query) {
\t\t\tconst normalized = String(query ?? "").trim().toLocaleLowerCase();
\t\t\tif (normalized.length === 0) return candidates;
\t\t\treturn candidates.filter(candidate => [candidate.id, candidate.name].some(value => typeof value === "string" && value.toLocaleLowerCase().includes(normalized)));
\t\t}
\t\tfunction mergePangeaModelCandidates(models, candidates, picked) {
\t\t\tconst byId = new Map(models.map(model => [String(model.id ?? ""), model]));
\t\t\tfor (const candidate of candidates) {
\t\t\t\tif (!picked.has(candidate.id)) continue;
\t\t\t\tbyId.set(candidate.id, byId.get(candidate.id) ?? adopt(candidate));
\t\t\t}
\t\t\treturn [...byId.values()];
\t\t}
`;
  const existing = source.indexOf('\t\tfunction pangeaModelText(key) {');
  if (existing >= 0) source = source.slice(0, existing) + source.slice(source.indexOf(marker, existing));
  source = source.replace(marker, copy + marker);
  const stateAnchor = 'const [productTarget, setProductTarget] = (0, react.useState)(null);';
  if (!source.includes(stateAnchor)) throw new Error('Missing model overlay state anchor');
  const focusTrap = `
			(0, react.useEffect)(() => {
				if (!open) return;
				const trapCapacityTab = event => {
					if (event.key !== "Tab") return;
					const modal = document.querySelector(".pangea-model-capacity-modal");
					if (!modal || modal.getClientRects().length === 0) return;
					const focusable = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter(element => element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"]'));
					if (focusable.length === 0) { event.preventDefault(); modal.focus(); return; }
					const first = focusable[0];
					const last = focusable[focusable.length - 1];
					const active = document.activeElement;
					if (event.shiftKey && (active === first || !modal.contains(active))) { event.preventDefault(); last.focus(); }
					else if (!event.shiftKey && (active === last || !modal.contains(active))) { event.preventDefault(); first.focus(); }
				};
				document.addEventListener("keydown", trapCapacityTab, true);
				return () => document.removeEventListener("keydown", trapCapacityTab, true);
			}, [open]);`;
  if (!source.includes('const [capacityOpen, setCapacityOpen] = (0, react.useState)(false);')) {
    const layerState = `${stateAnchor}
			const [capacityOpen, setCapacityOpen] = (0, react.useState)(false);
			const capacityReturnFocus = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (!open) { setCapacityOpen(false); return; }
				const sync = () => {
					const modal = document.querySelector(".pangea-model-capacity-modal");
					const next = Boolean(modal && modal.getClientRects().length > 0);
					setCapacityOpen(current => current === next ? current : next);
				};
				const observer = new MutationObserver(sync);
				observer.observe(document.body, { childList: true, subtree: true });
				sync();
				return () => observer.disconnect();
			}, [open]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const rememberCapacityTrigger = event => {
					const trigger = event.target.closest?.('[data-pangea-model-settings-overlay] button[aria-label^="模型设置"]');
					if (trigger) capacityReturnFocus.current = trigger;
				};
				document.addEventListener("click", rememberCapacityTrigger, true);
				return () => document.removeEventListener("click", rememberCapacityTrigger, true);
			}, [open]);
			(0, react.useEffect)(() => {
				if (capacityOpen || !capacityReturnFocus.current) return;
				const target = capacityReturnFocus.current;
				capacityReturnFocus.current = null;
				requestAnimationFrame(() => { if (target.isConnected && !target.closest("[inert]")) target.focus(); });
			}, [capacityOpen]);`;
    source = source.replace(stateAnchor, layerState);
  }
  const capacityFocusAnchor = 'requestAnimationFrame(() => { if (target.isConnected && !target.closest("[inert]")) target.focus(); });\n\t\t\t}, [capacityOpen]);';
  if (!source.includes('const trapCapacityTab = event =>')) {
    if (!source.includes(capacityFocusAnchor)) throw new Error('Missing capacity focus trap insertion anchor');
    source = source.replace(capacityFocusAnchor, capacityFocusAnchor + focusTrap);
  }
  const dialogAnchor = '"aria-modal": "true",\n\t\t\t\t\t"aria-label": "模型与 API 设置",';
  const dialogState = '"aria-modal": capacityOpen ? false : true,\n\t\t\t\t\t"aria-hidden": capacityOpen ? "true" : void 0,\n\t\t\t\t\t"inert": capacityOpen ? "" : void 0,\n\t\t\t\t\t"aria-label": "模型与 API 设置",';
  const dialogTitle = 'state.status === "error" ? "模型设置加载失败" : state.status === "idle" || state.status === "loading" ? "模型设置加载中" : productTarget?.create && !state.namespaces?.has("llm-pi-ai") ? "模型适配器不可用" : productTarget?.create ? "连接模型接口" : productTarget?.providerId ? "模型接入" : "模型与 API 设置"';
  const validationDialogTitle = dialogTitle.replace('productTarget?.create ? "连接模型接口"', 'productTarget?.create && validationError ? "模型连接字段校验" : productTarget?.create ? "连接模型接口"');
  const credentialRetryDialogTitle = validationDialogTitle.replace('productTarget?.create && validationError ? "模型连接字段校验"', 'productTarget?.create && credentialRetry ? "连接已创建，凭据待保存" : productTarget?.create && validationError ? "模型连接字段校验"');
  const advancedValidationDialogTitle = validationDialogTitle.replace('productTarget?.providerId ? "模型接入"', 'productTarget?.providerId && advancedOpen ? "模型自定义设置" : productTarget?.providerId ? "模型接入"');
  const advancedCredentialRetryDialogTitle = credentialRetryDialogTitle.replace('productTarget?.providerId ? "模型接入"', 'productTarget?.providerId && advancedOpen ? "模型自定义设置" : productTarget?.providerId ? "模型接入"');
  const readOnlyDialogTitle = `state.status === "ready" && state.writable === false ? "模型设置只读" : ${dialogTitle}`;
  const readOnlyValidationDialogTitle = `state.status === "ready" && state.writable === false ? "模型设置只读" : ${validationDialogTitle}`;
  const readOnlyCredentialRetryDialogTitle = `state.status === "ready" && state.writable === false ? "模型设置只读" : ${credentialRetryDialogTitle}`;
  const readOnlyAdvancedValidationDialogTitle = `state.status === "ready" && state.writable === false ? "模型设置只读" : ${advancedValidationDialogTitle}`;
  const readOnlyAdvancedCredentialRetryDialogTitle = `state.status === "ready" && state.writable === false ? "模型设置只读" : ${advancedCredentialRetryDialogTitle}`;
  const readOnlyDialogLabel = `"aria-label": ${readOnlyDialogTitle}`;
  const readOnlyValidationDialogLabel = `"aria-label": ${readOnlyValidationDialogTitle}`;
  const readOnlyCredentialRetryDialogLabel = `"aria-label": ${readOnlyCredentialRetryDialogTitle}`;
  const readOnlyAdvancedValidationDialogLabel = `"aria-label": ${readOnlyAdvancedValidationDialogTitle}`;
  const readOnlyAdvancedCredentialRetryDialogLabel = `"aria-label": ${readOnlyAdvancedCredentialRetryDialogTitle}`;
  const legacyReadOnlyDialogLabel = '"aria-label": state.status === "ready" && state.writable === false ? "模型设置只读" : "模型与 API 设置",';
  const readOnlyDialogState = dialogState.replace('"aria-label": "模型与 API 设置"', readOnlyDialogLabel);
  const readOnlyValidationDialogState = dialogState.replace('"aria-label": "模型与 API 设置"', readOnlyValidationDialogLabel);
  const readOnlyCredentialRetryDialogState = dialogState.replace('"aria-label": "模型与 API 设置"', readOnlyCredentialRetryDialogLabel);
  const readOnlyAdvancedValidationDialogState = dialogState.replace('"aria-label": "模型与 API 设置"', readOnlyAdvancedValidationDialogLabel);
  const readOnlyAdvancedCredentialRetryDialogState = dialogState.replace('"aria-label": "模型与 API 设置"', readOnlyAdvancedCredentialRetryDialogLabel);
  const fixedDialogAnchor = '"aria-modal": "true",\n\t\t\t\t\t"aria-label": "内部模型设置",';
  const fixedDialogState = dialogState.replace('"aria-label": "模型与 API 设置"', readOnlyDialogLabel);
  if (source.includes(dialogAnchor)) source = source.replace(dialogAnchor, dialogState);
  else if (source.includes(fixedDialogAnchor)) source = source.replace(fixedDialogAnchor, fixedDialogState);
  else if (source.includes(legacyReadOnlyDialogLabel)) source = source.replace(legacyReadOnlyDialogLabel, `${readOnlyDialogLabel},`);
  else if (!source.includes(dialogState) && !source.includes(readOnlyDialogState) && !source.includes(readOnlyValidationDialogState) && !source.includes(readOnlyValidationDialogLabel) && !source.includes(readOnlyCredentialRetryDialogState) && !source.includes(readOnlyCredentialRetryDialogLabel) && !source.includes(readOnlyAdvancedValidationDialogState) && !source.includes(readOnlyAdvancedValidationDialogLabel) && !source.includes(readOnlyAdvancedCredentialRetryDialogState) && !source.includes(readOnlyAdvancedCredentialRetryDialogLabel)) throw new Error('Missing model overlay accessibility anchor');

  const providerStart = source.indexOf('function ProviderEditor(props) {');
  const providerEnd = source.indexOf('\n\t\tfunction renderProviderEditor', providerStart);
  if (providerStart < 0 || providerEnd < providerStart) throw new Error('Missing ProviderEditor product presentation anchor');
  let provider = source.slice(providerStart, providerEnd);
  const patchProvider = (needle, replacement, label) => {
    const at = provider.indexOf(needle);
    if (at < 0) throw new Error(`Missing ${label} anchor`);
    if (provider.indexOf(needle, at + needle.length) >= 0) throw new Error(`Ambiguous ${label} anchor`);
    provider = provider.slice(0, at) + replacement + provider.slice(at + needle.length);
  };
  if (!provider.includes('className: "pangea-model-key-status"')) {
    patchProvider('shownKeyFailure === void 0 ? null : (0, react_jsx_runtime.jsx)("p", {',
      'props.productPresentation === true && keyState?.configured === true ? (0, react_jsx_runtime.jsx)("small", { className: "pangea-model-key-hint", children: "留空保留当前密钥。保存的密钥不会回显。" }) : null,\n\t\t\t\t\t\tprops.productPresentation === true && keyState?.configured === true ? (0, react_jsx_runtime.jsx)("span", { className: "pangea-model-key-status", role: "status", children: "密钥已配置" }) : null,\n\t\t\t\t\t\tshownKeyFailure === void 0 ? null : (0, react_jsx_runtime.jsx)("p", {',
      'ProviderEditor credential status');
  }
  if (!provider.includes('pangea-model-customized-copy')) {
    patchProvider('children: t("customized")',
      'children: props.productPresentation === true ? (0, react_jsx_runtime.jsxs)("span", { className: "pangea-model-customized-copy", children: [(0, react_jsx_runtime.jsx)("strong", { children: t("customized") }), (0, react_jsx_runtime.jsx)("small", { children: "接口地址、显示名称、API 协议与模型目录" })] }) : t("customized")',
      'ProviderEditor customized settings summary');
  }
  source = source.slice(0, providerStart) + provider + source.slice(providerEnd);
  return source;
}

export function installModelCatalogView(source) {
  const searchStart = source.indexOf('function ModelCatalogSearch(props) {');
  const searchEnd = source.indexOf('\n\t\t}\n\t\t//#endregion', searchStart);
  if (searchStart < 0 || searchEnd < searchStart) throw new Error('Missing model catalog search component');
  let searchBody = source.slice(searchStart, searchEnd);
  if (!searchBody.includes('placeholder: props.placeholder ?? props.t("modelSearch")')) {
    const searchPlaceholder = 'placeholder: props.t("modelSearch"),';
    if (!searchBody.includes(searchPlaceholder)) throw new Error('Missing model catalog search placeholder');
    searchBody = searchBody.replace(searchPlaceholder, 'placeholder: props.placeholder ?? props.t("modelSearch"),');
  }
  if (!searchBody.includes('"aria-label": props.placeholder ?? props.t("modelSearch")')) {
    searchBody = searchBody.replace('"aria-label": props.t("modelSearch"),', '"aria-label": props.placeholder ?? props.t("modelSearch"),');
  }
  if (!searchBody.includes('ref: props.inputRef')) {
    searchBody = searchBody.replace('type: "search",', 'type: "search",\n\t\t\t\t\tref: props.inputRef,');
  }
  source = source.slice(0, searchStart) + searchBody + source.slice(searchEnd);
  if (!source.includes('function pangeaModelCandidateSelection(models, candidates) {')) {
    const catalogStart = source.indexOf('function ModelListEditor(props) {');
    if (catalogStart < 0) throw new Error('Missing model candidate selection anchor');
    source = source.slice(0, catalogStart) + `function pangeaModelCandidateSelection(models, candidates) {
			const known = new Set(models.map((model) => textOf(model, "id")));
			return new Set(candidates.filter((model) => known.has(model.id)).map((model) => model.id));
		}
		` + source.slice(catalogStart);
  }
  const start = source.indexOf('function ModelListEditor(props) {');
  const end = source.indexOf('\n\t\t}\n\t\t//#endregion', start);
  if (start < 0 || end < start) throw new Error('Missing model catalog view');
  let body = source.slice(start, end);
  if (!body.includes('const [actionsOpen, setActionsOpen]')) {
    const expandedState = 'const [expanded, setExpanded] = (0, react.useState)(/* @__PURE__ */ new Set());';
    if (!body.includes(expandedState)) throw new Error('Missing model action-menu state anchor');
    body = body.replace(expandedState, `${expandedState}
			const [actionsOpen, setActionsOpen] = (0, react.useState)(false);
			const [savedFilterOpen, setSavedFilterOpen] = (0, react.useState)(false);
			const actionsRef = (0, react.useRef)(null);
			const actionsTriggerRef = (0, react.useRef)(null);
			const savedFilterRef = (0, react.useRef)(null);`);
  }
  const defaultNewModels = 'setPicked(new Set(found.filter((model) => !known.has(model.id)).map((model) => model.id)));';
  const defaultExistingModels = 'setPicked(pangeaModelCandidateSelection(models, found));';
  if (body.includes(defaultNewModels)) body = body.replace(defaultNewModels, defaultExistingModels);
  else if (!body.includes(defaultExistingModels)) throw new Error('Missing model discovery selection behavior');
  if (!body.includes('pangea-model-table-head')) {
  const toggleStart = body.indexOf('(0, react_jsx_runtime.jsx)(ModelImageInputToggle, {');
  const toggleEnd = body.indexOf('\n\t\t\t\t\t(0, react_jsx_runtime.jsx)("button", {', toggleStart);
  if (toggleStart < 0 || toggleEnd < toggleStart) throw new Error('Missing model input capability control');
  const toggle = body.slice(toggleStart, toggleEnd).trim().replace(/,$/, '').replace('compact: true', 'compact: false');
  body = body.slice(0, toggleStart) + `(0, react_jsx_runtime.jsx)("span", { className: "pangea-model-input-type", children: Array.isArray(model.input) && model.input.includes("image") ? model.input.includes("text") ? "文本与图像" : "图像" : "文本" }),` + body.slice(toggleEnd);
  const advanced = 'className: ModelsSection_module_css_default["modelAdvanced"],\n\t\t\t\t\t\t\tchildren: [';
  if (!body.includes(advanced)) throw new Error('Missing model details region');
  body = body.replace(advanced, advanced + toggle + ',');
  body = body.replace('className: ModelsSection_module_css_default["modelRow"]', 'className: "pangea-model-row"');
  body = body.replace('className: ModelsSection_module_css_default["modelEntry"]', 'className: "pangea-model-entry"');
  body = body.replace('children: (0, react_jsx_runtime.jsx)(IconChevron, { open: expanded.has(index) })', 'children: [(0, react_jsx_runtime.jsx)(IconChevron, { open: expanded.has(index) }), "设置"]');
  const rows = 'visibleModels.map(({ model, index }) =>';
  if (!body.includes(rows)) throw new Error('Missing model rows');
    body = body.replace(rows, `(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-table-head", children: [(0, react_jsx_runtime.jsx)("span", { children: "模型 ID" }), (0, react_jsx_runtime.jsx)("span", { children: "显示名称" }), (0, react_jsx_runtime.jsx)("span", { children: "输入类型" })] }),\n                    ` + rows);
  }
  if (!body.includes('className: "pangea-model-advanced-note"')) {
    const rowMapEnd = /\}, index\)\),\r?\n(\s*)failure !== void 0 \?/g;
    if ([...body.matchAll(rowMapEnd)].length !== 1) throw new Error('Missing model rows end for advanced list note');
    body = body.replace(rowMapEnd, '}, index)),\n$1props.productAdvanced === true ? (0, react_jsx_runtime.jsx)("p", { className: "pangea-model-advanced-note", children: "模型 ID 必须唯一。自定义接口至少需要一个模型。" }) : null,\n$1failure !== void 0 ?');
  }
  if (!body.includes('const [candidateQuery, setCandidateQuery]')) {
    const candidatesState = 'const [candidates, setCandidates] = (0, react.useState)(void 0);';
    if (!body.includes(candidatesState)) throw new Error('Missing model candidate state');
    body = body.replace(candidatesState, `${candidatesState}\n\t\t\tconst candidateReturnFocus = (0, react.useRef)(null);\n\t\t\tconst [candidateQuery, setCandidateQuery] = (0, react.useState)("");`);
  } else if (!body.includes('const candidateReturnFocus = (0, react.useRef)(null);')) {
    const candidatesState = 'const [candidates, setCandidates] = (0, react.useState)(void 0);';
    if (!body.includes(candidatesState)) throw new Error('Missing model candidate state');
    body = body.replace(candidatesState, `${candidatesState}\n\t\t\tconst candidateReturnFocus = (0, react.useRef)(null);`);
  }
  if (!body.includes('const visibleCandidates = filterPangeaModelCandidates')) {
    const previousCandidateFilter = /const normalizedCandidateQuery = candidateQuery\.trim\(\)\.toLocaleLowerCase\(\);\n\s*const visibleCandidates = activeCandidates\.filter\([^\n]*\);\n(\s*const addManualModel = \(\) => \{[\s\S]*?\n\s*\};)/;
    if (previousCandidateFilter.test(body)) {
      body = body.replace(previousCandidateFilter, 'const visibleCandidates = filterPangeaModelCandidates(activeCandidates, candidateQuery);\n$1');
    } else {
      const candidateList = 'const activeCandidates = candidates ?? [];';
      if (!body.includes(candidateList)) throw new Error('Missing active model candidates');
      body = body.replace(candidateList, `${candidateList}
			const visibleCandidates = filterPangeaModelCandidates(activeCandidates, candidateQuery);
			const addManualModel = () => {
				props.onModelQueryChange?.("");
				onChange([...models.map(model => ({ ...model })), { id: "" }]);
				setFailure(void 0);
			};`);
    }
  }
  if (!body.includes('setCandidateQuery("");')) {
    if (!body.includes('setCandidates(found);')) throw new Error('Missing model candidate result');
    body = body.replace('setCandidates(found);', 'setCandidates(found);\n\t\t\t\t\tsetCandidateQuery("");');
  }
  if (!body.includes('className: "pangea-model-query-state-dialog"')) {
    const failure = /failure !== void 0 \? \(0, react_jsx_runtime\.jsx\)\("p", \{\n\s*className: ModelsSection_module_css_default\["error"\],\n\s*children: failure\n\s*\}\) : null,/g;
    if ([...body.matchAll(failure)].length !== 1) throw new Error('Missing model query failure state');
    body = body.replace(failure, `failure !== void 0 ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: true,
						onClose: () => setFailure(void 0),
						title: failure === t("fetchEmpty") ? "接口未返回模型" : "模型查询失败",
						closeLabel: t("close"),
						description: "内部模型设置 · 本地自定义模型接口",
						className: "pangea-model-query-state-dialog",
						footer: (0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-model-query-secondary", onClick: () => setFailure(void 0), children: "返回设置" }),
						children: failure === t("fetchEmpty") ? (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-query-empty", children: [
							(0, react_jsx_runtime.jsx)("div", { className: "pangea-model-query-empty-icon", "aria-hidden": "true", children: (0, react_jsx_runtime.jsxs)("svg", { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", children: [(0, react_jsx_runtime.jsx)("path", { d: "M22 12h-6l-2 3h-4l-2-3H2" }), (0, react_jsx_runtime.jsx)("path", { d: "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" })] }) }),
							(0, react_jsx_runtime.jsx)("strong", { children: "接口没有列出模型" }),
							(0, react_jsx_runtime.jsx)("p", { children: "可以检查接口地址，或回到自定义设置手动添加模型 ID。" }),
							(0, react_jsx_runtime.jsx)("div", { className: "pangea-model-query-empty-actions", children: (0, react_jsx_runtime.jsxs)("button", { type: "button", className: "pangea-model-query-primary", onClick: addManualModel, children: [(0, react_jsx_runtime.jsx)("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: (0, react_jsx_runtime.jsx)("path", { d: "M8 2.5v11M2.5 8h11", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }) }), "手动添加"] }) })
						] }) : (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-query-error", role: "alert", children: [
							(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-query-error-notice", children: [
								(0, react_jsx_runtime.jsxs)("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [(0, react_jsx_runtime.jsx)("circle", { cx: 12, cy: 12, r: 10 }), (0, react_jsx_runtime.jsx)("path", { d: "M12 8v4" }), (0, react_jsx_runtime.jsx)("path", { d: "M12 16h.01" })] }),
								(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-query-error-copy", children: [
									(0, react_jsx_runtime.jsx)("strong", { children: "无法获取接口模型列表" }),
									(0, react_jsx_runtime.jsx)("p", { children: "接口未返回可识别的模型目录。请核对地址与协议，也可以手动维护模型列表。" })
								] })
							] }),
							(0, react_jsx_runtime.jsx)("div", { className: "pangea-model-query-error-url", children: probe.baseURL || "—" }),
							(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-query-actions", children: [
								(0, react_jsx_runtime.jsxs)("button", { type: "button", className: "pangea-model-query-primary", onClick: () => { void fetchModels(); }, children: [
									(0, react_jsx_runtime.jsxs)("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.65", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [(0, react_jsx_runtime.jsx)("path", { d: "M20 7v5h-5" }), (0, react_jsx_runtime.jsx)("path", { d: "M4 17v-5h5" }), (0, react_jsx_runtime.jsx)("path", { d: "M5.64 5.64A9 9 0 0 1 20 12" }), (0, react_jsx_runtime.jsx)("path", { d: "M4 12a9 9 0 0 0 14.36 6.36" })] }),
									"重新查询"
								] }),
								(0, react_jsx_runtime.jsxs)("button", { type: "button", className: "pangea-model-query-secondary", onClick: () => { setFailure(void 0); props.onModelQueryChange?.(""); }, children: [
									(0, react_jsx_runtime.jsxs)("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.65", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [(0, react_jsx_runtime.jsx)("path", { d: "M12 20h9" }), (0, react_jsx_runtime.jsx)("path", { d: "M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" })] }),
									"手动编辑模型"
								] })
							] })
						] })
					}) : null,`);
  }
  const queryDialogTitle = 'title: failure === t("fetchEmpty") ? "接口未返回模型" : "模型查询失败",';
  const queryDialogStart = body.indexOf(queryDialogTitle);
  const candidateDialogStart = body.indexOf('open: candidates !== void 0,', queryDialogStart);
  if (queryDialogStart >= 0 && candidateDialogStart > queryDialogStart) {
    const queryDialog = body.slice(queryDialogStart, candidateDialogStart);
    if (!queryDialog.includes('description: "内部模型设置 · 本地自定义模型接口"')) {
      const closeLabel = 'closeLabel: t("close"),';
      const closeLabelIndex = queryDialog.indexOf(closeLabel);
      if (closeLabelIndex < 0) throw new Error('Missing model query dialog description anchor');
      const insertion = closeLabelIndex + closeLabel.length;
      body = body.slice(0, queryDialogStart + insertion) + '\n\t\t\t\t\t\tdescription: "内部模型设置 · 本地自定义模型接口",' + body.slice(queryDialogStart + insertion);
    }
  }
  if (!body.includes('className: "pangea-model-query-error-notice"')) {
    const errorStart = body.indexOf('className: "pangea-model-query-error", role: "alert", children: [');
    const queryStateEnd = body.indexOf('}) : null,', errorStart);
    const errorEnd = body.lastIndexOf('] })', queryStateEnd);
    if (errorStart < 0 || queryStateEnd < errorStart || errorEnd < errorStart) throw new Error('Missing model query error content');
    const errorView = `className: "pangea-model-query-error", role: "alert", children: [
							(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-query-error-notice", children: [
								(0, react_jsx_runtime.jsxs)("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [(0, react_jsx_runtime.jsx)("circle", { cx: 12, cy: 12, r: 10 }), (0, react_jsx_runtime.jsx)("path", { d: "M12 8v4" }), (0, react_jsx_runtime.jsx)("path", { d: "M12 16h.01" })] }),
								(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-query-error-copy", children: [
									(0, react_jsx_runtime.jsx)("strong", { children: "无法获取接口模型列表" }),
									(0, react_jsx_runtime.jsx)("p", { children: "接口未返回可识别的模型目录。请核对地址与协议，也可以手动维护模型列表。" })
								] })
							] }),
							(0, react_jsx_runtime.jsx)("div", { className: "pangea-model-query-error-url", children: probe.baseURL || "—" }),
							(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-query-actions", children: [
								(0, react_jsx_runtime.jsxs)("button", { type: "button", className: "pangea-model-query-primary", onClick: () => { void fetchModels(); }, children: [
									(0, react_jsx_runtime.jsxs)("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.65", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [(0, react_jsx_runtime.jsx)("path", { d: "M20 7v5h-5" }), (0, react_jsx_runtime.jsx)("path", { d: "M4 17v-5h5" }), (0, react_jsx_runtime.jsx)("path", { d: "M5.64 5.64A9 9 0 0 1 20 12" }), (0, react_jsx_runtime.jsx)("path", { d: "M4 12a9 9 0 0 0 14.36 6.36" })] }),
									"重新查询"
								] }),
								(0, react_jsx_runtime.jsxs)("button", { type: "button", className: "pangea-model-query-secondary", onClick: () => { setFailure(void 0); props.onModelQueryChange?.(""); }, children: [
									(0, react_jsx_runtime.jsxs)("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.65", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", children: [(0, react_jsx_runtime.jsx)("path", { d: "M12 20h9" }), (0, react_jsx_runtime.jsx)("path", { d: "M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" })] }),
									"手动编辑模型"
								] })
							] })
						] })`;
    body = body.slice(0, errorStart) + errorView + body.slice(errorEnd + '] })'.length);
  }
  if (!body.includes('pangea-model-query-empty-icon')) {
    const emptyStart = body.indexOf('className: "pangea-model-query-empty"');
    const emptyEnd = body.indexOf('] }) : (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-query-error"', emptyStart);
    if (emptyStart < 0 || emptyEnd < emptyStart) throw new Error('Missing empty model result presentation');
    const emptyView = `className: "pangea-model-query-empty", children: [
							(0, react_jsx_runtime.jsx)("div", { className: "pangea-model-query-empty-icon", "aria-hidden": "true", children: (0, react_jsx_runtime.jsxs)("svg", { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", children: [(0, react_jsx_runtime.jsx)("path", { d: "M22 12h-6l-2 3h-4l-2-3H2" }), (0, react_jsx_runtime.jsx)("path", { d: "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" })] }) }),
							(0, react_jsx_runtime.jsx)("strong", { children: "接口没有列出模型" }),
							(0, react_jsx_runtime.jsx)("p", { children: "可以检查接口地址，或回到自定义设置手动添加模型 ID。" }),
							(0, react_jsx_runtime.jsx)("div", { className: "pangea-model-query-empty-actions", children: (0, react_jsx_runtime.jsxs)("button", { type: "button", className: "pangea-model-query-primary", onClick: addManualModel, children: [(0, react_jsx_runtime.jsx)("svg", { width: 15, height: 15, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: (0, react_jsx_runtime.jsx)("path", { d: "M8 2.5v11M2.5 8h11", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }) }), "手动添加"] }) })
						] })`;
    body = body.slice(0, emptyStart) + emptyView + body.slice(emptyEnd + '] })'.length);
  }
  if (!body.includes('mergePangeaModelCandidates(models, candidates, picked)')) {
    const merge = /const byId = new Map\(models\.map\(\(model\) => \[textOf\(model, "id"\), model\]\)\);\s*for \(const candidate of candidates\) \{\s*if \(!picked\.has\(candidate\.id\)\) continue;\s*byId\.set\(candidate\.id, byId\.get\(candidate\.id\) \?\? adopt\(candidate\)\);\s*\}\s*onChange\(\[\.\.\.byId\.values\(\)\]\);/g;
    if ([...body.matchAll(merge)].length !== 1) throw new Error('Missing model candidate merge logic');
    body = body.replace(merge, 'onChange(mergePangeaModelCandidates(models, candidates, picked));');
  }
  if (!body.includes('if (candidates === void 0 && failure === void 0) return;')) {
    const focusEffect = `
			(0, react.useEffect)(() => {
				if (candidates === void 0 && failure === void 0) return;
				const trapCandidateDialogFocus = event => {
					const candidateDialog = candidates !== void 0;
					const dialog = document.querySelector(candidateDialog ? ".pangea-model-candidate-dialog" : ".pangea-model-query-state-dialog");
					if (!dialog || dialog.getClientRects().length === 0) return;
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						if (candidateDialog) closePicker();
						else setFailure(void 0);
						return;
					}
					if (event.key !== "Tab") return;
					const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter(element => element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"]'));
					if (focusable.length === 0) { event.preventDefault(); dialog.focus(); return; }
					const first = focusable[0];
					const last = focusable[focusable.length - 1];
					const active = document.activeElement;
					if (event.shiftKey && (active === first || !dialog.contains(active))) { event.preventDefault(); last.focus(); }
					else if (!event.shiftKey && (active === last || !dialog.contains(active))) { event.preventDefault(); first.focus(); }
				};
				document.addEventListener("keydown", trapCandidateDialogFocus, true);
				requestAnimationFrame(() => {
					const firstAction = document.querySelector(".pangea-model-query-state-dialog button:not([disabled])");
					if (candidates === void 0) firstAction?.focus();
					else document.querySelector(".pangea-model-candidate-dialog .dshModelCatalogSearch input")?.focus();
				});
				return () => {
					document.removeEventListener("keydown", trapCandidateDialogFocus, true);
					const trigger = candidateReturnFocus.current;
					candidateReturnFocus.current = null;
					if (trigger) requestAnimationFrame(() => { if (trigger.isConnected && !trigger.closest("[inert]")) trigger.focus(); });
				};
			}, [candidates, failure]);`;
    const previousFocusEffect = /\(0, react\.useEffect\)\(\(\) => \{\s*if \(candidates === void 0\) return;[\s\S]*?\n\s*\}, \[candidates\]\);/;
    if (previousFocusEffect.test(body)) body = body.replace(previousFocusEffect, focusEffect.trimStart());
    else {
      const closePicker = 'const closePicker = () => {\n\t\t\t\tsetCandidates(void 0);\n\t\t\t\tsetPicked(/* @__PURE__ */ new Set());\n\t\t	};';
      if (!body.includes(closePicker)) throw new Error('Missing model candidate close behavior');
      body = body.replace(closePicker, closePicker + focusEffect);
    }
  }
  body = body.replace(
    /const search = document\.querySelector\("\.pangea-model-candidate-dialog \.dshModelCatalogSearch input"\);\s*const firstAction = document\.querySelector\("\.pangea-model-query-state-dialog button:not\(\[disabled\]\)"\);\s*\((?:candidates === void 0 \? firstAction : search|search \?\? firstAction)\)\?\.focus\(\);/,
    'const firstAction = document.querySelector(".pangea-model-query-state-dialog button:not([disabled])");\n\t\t\t\t\tif (candidates === void 0) firstAction?.focus();\n\t\t\t\t\telse document.querySelector(".pangea-model-candidate-dialog .dshModelCatalogSearch input")?.focus();'
  );
  if (!body.includes('className: "pangea-model-candidate-toolbar"')) {
    const candidateActions = 'children: [(0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["candidateActions"],';
    if (!body.includes(candidateActions)) throw new Error('Missing model candidate actions');
    body = body.replace(candidateActions, `children: [(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-candidate-toolbar", children: [
							(0, react_jsx_runtime.jsx)(ModelCatalogSearch, { value: candidateQuery, onChange: setCandidateQuery, t }),
							(0, react_jsx_runtime.jsxs)("span", { className: "pangea-model-candidate-count", children: ["接口返回 ", activeCandidates.length, " 个条目 · 已选 ", picked.size, " 个"] })
						] }), (0, react_jsx_runtime.jsx)("div", {
							className: ModelsSection_module_css_default["candidateActions"],`);
  }
  if (!body.includes('className: "pangea-model-candidate-dialog"')) {
    const candidateModal = 'title: t("fetchTitle"),';
    if (!body.includes(candidateModal)) throw new Error('Missing model candidate dialog title');
    body = body.replace(candidateModal, 'title: "选择接口模型",');
    body = body.replace('description: t("fetchDescription"),', 'description: "内部模型设置 · 本地自定义模型接口",');
    body = body.replace('className: ModelsSection_module_css_default["fetchDialog"],', 'className: "pangea-model-candidate-dialog",');
  }
  if (!body.includes('candidateReturnFocus.current = event.currentTarget;')) {
    const queryTrigger = /onClick: \(\) => \{\s*fetchModels\(\);\s*\},(?=\s*children: busy \? t\("fetching"\))/;
    if (!queryTrigger.test(body)) throw new Error('Missing model discovery focus-return trigger');
    body = body.replace(queryTrigger, 'onClick: event => { candidateReturnFocus.current = event.currentTarget; fetchModels(); },');
  }
  body = body.replace('value: candidateQuery, onChange: setCandidateQuery, t })', 'value: candidateQuery, onChange: setCandidateQuery, placeholder: "搜索模型 ID 或名称", t })');
  body = body.replace('activeCandidates.length, " 个条目 · 已选 ", picked.size, " 个"]', 'activeCandidates.length, " 个条目"]');
  if (!body.includes('className: "pangea-model-candidate-selected"')) {
    const cancelButton = '(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {\n\t\t\t\t\t\t\tvariant: "outline",\n\t\t\t\t\t\t\tonClick: closePicker,';
    if (!body.includes(cancelButton)) throw new Error('Missing model candidate cancel footer action');
    body = body.replace(cancelButton, `(0, react_jsx_runtime.jsx)("span", { className: "pangea-model-candidate-selected", children: ["已选 ", picked.size, " 个"] }), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {\n\t\t\t\t\t\t\tvariant: "outline", className: "pangea-model-candidate-cancel",\n\t\t\t\t\t\t\tonClick: closePicker,`);
    body = body.replace('variant: "outline",\n\t\t\t\t\t\t\tonClick: adoptPicked,', 'variant: "outline", className: "pangea-model-candidate-apply",\n\t\t\t\t\t\t\tonClick: adoptPicked,');
  }
  if (!body.includes('className: "pangea-model-candidate-table-head"')) {
    const candidateActions = 'className: ModelsSection_module_css_default["candidateActions"],\n\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {';
    if (!body.includes(candidateActions)) throw new Error('Missing model candidate select-all action');
    const tableHead = `className: "pangea-model-candidate-table-head", children: [
\t\t\t\t\t\t\t(0, react_jsx_runtime.jsxs)("span", { children: ["选择", (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, { variant: "ghost", size: "sm", className: "pangea-model-candidate-select-all", onClick: toggleAllCandidates, children: allCandidatesPicked ? "取消全选" : "全选" })] }),
\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", { children: "模型 ID" }),
\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", { children: "状态" })
\t\t\t\t\t\t]`;
    const actionsStart = body.indexOf(candidateActions);
    const listStart = body.indexOf('}), (0, react_jsx_runtime.jsx)("ul", {', actionsStart);
    if (listStart < actionsStart) throw new Error('Missing model candidate list after select-all action');
    body = body.slice(0, actionsStart) + tableHead + body.slice(listStart);
  } else {
    const headStart = body.indexOf('className: "pangea-model-candidate-table-head"');
    const staleButton = body.indexOf('\n\t\t\t\t\t\t\t\tvariant: "ghost",', headStart);
    const listStart = staleButton >= 0 ? body.indexOf('}), (0, react_jsx_runtime.jsx)("ul", {', staleButton) : -1;
    if (staleButton >= 0 && listStart > staleButton) body = body.slice(0, staleButton) + body.slice(listStart);
  }
  body = body.replace('className: ModelsSection_module_css_default["candidateList"]', 'className: "pangea-model-candidate-list"');
  body = body.replace('className: ModelsSection_module_css_default["candidate"],', 'className: "pangea-model-candidate-row",');
  body = body.replace('className: ModelsSection_module_css_default["candidateLabel"],', 'className: "pangea-model-candidate-item",');
  body = body.replace('children: (candidates ?? []).map((candidate) =>', 'children: visibleCandidates.map((candidate) =>');
  const candidateRowsStart = body.indexOf('children: visibleCandidates.map((candidate) =>');
  if (candidateRowsStart < 0) throw new Error('Missing model candidate rows');
  const candidateCheckbox = body.indexOf('type: "checkbox",', candidateRowsStart);
  if (candidateCheckbox < 0) throw new Error('Missing model candidate checkbox');
  let candidateCheckboxSource = body.slice(candidateCheckbox, candidateCheckbox + 180);
  if (!candidateCheckboxSource.includes('pangea-model-candidate-checkbox')) {
    body = body.slice(0, candidateCheckbox) + body.slice(candidateCheckbox).replace('type: "checkbox",', 'type: "checkbox", className: "pangea-model-candidate-checkbox",');
    candidateCheckboxSource = body.slice(candidateCheckbox, candidateCheckbox + 180);
  }
  if (!candidateCheckboxSource.includes('aria-label')) {
    const checkboxClass = 'className: "pangea-model-candidate-checkbox",';
    const classAt = body.indexOf(checkboxClass, candidateCheckbox);
    if (classAt < 0) throw new Error('Missing model candidate checkbox class');
    const insertAt = classAt + checkboxClass.length;
    body = body.slice(0, insertAt) + ' "aria-label": `选择 ${candidate.id}`, ' + body.slice(insertAt);
  }
  body = body.replace('className: ModelsSection_module_css_default["candidateId"],', 'className: "pangea-model-candidate-id",');
  const candidateNote = '(0, react_jsx_runtime.jsx)("p", { className: "pangea-model-candidate-note", children: "添加相同 ID 时，保留你已经填写的显示名称与容量。" })';
  let currentRowsStart = body.indexOf('children: visibleCandidates.map((candidate) =>');
  const notePosition = body.indexOf(candidateNote);
  if (notePosition >= 0 && notePosition < currentRowsStart) {
    body = body.slice(0, notePosition - 2) + body.slice(notePosition + candidateNote.length);
    currentRowsStart = body.indexOf('children: visibleCandidates.map((candidate) =>');
  }
  if (body.indexOf(candidateNote, currentRowsStart) < 0) {
    const candidateListClose = '\n\t\t\t\t\t\t})]';
    const closeAt = body.indexOf(candidateListClose, currentRowsStart);
    if (closeAt < currentRowsStart) throw new Error('Missing model candidate list close');
    body = body.slice(0, closeAt) + `\n\t\t\t\t\t\t}), ${candidateNote}]` + body.slice(closeAt + candidateListClose.length);
  }
  if (body.includes('children: (candidates ?? []).map((candidate) =>')) {
    body = body.replace('children: (candidates ?? []).map((candidate) =>', 'children: visibleCandidates.map((candidate) =>');
  } else if (!body.includes('children: visibleCandidates.map((candidate) =>')) {
    throw new Error('Missing model candidate rows');
  }
  const legacyCandidateStatus = 'className: "pangea-model-candidate-status", children: models.some(model => textOf(model, "id") === candidate.id) ? "已在列表" : "可添加"';
  const statusClass = 'className: models.some(model => textOf(model, "id") === candidate.id) ? "pangea-model-candidate-status is-existing" : "pangea-model-candidate-status is-new", children: models.some(model => textOf(model, "id") === candidate.id) ? "已在列表" : "可添加"';
  if (body.includes(legacyCandidateStatus)) {
    body = body.replace(legacyCandidateStatus, statusClass);
  } else if (!body.includes(statusClass)) {
    const candidateId = /(className: (?:ModelsSection_module_css_default\["candidateId"\]|"pangea-model-candidate-id"),\s*children: candidate\.id\s*\})\)\]/g;
    if ([...body.matchAll(candidateId)].length !== 1) throw new Error('Missing model candidate status anchor');
    body = body.replace(candidateId, '$1), (0, react_jsx_runtime.jsx)("span", { className: models.some(model => textOf(model, "id") === candidate.id) ? "pangea-model-candidate-status is-existing" : "pangea-model-candidate-status is-new", children: models.some(model => textOf(model, "id") === candidate.id) ? "已在列表" : "可添加" })]');
  }
  {
    const rowStart = body.indexOf('className: "pangea-model-row"') >= 0
      ? body.indexOf('className: "pangea-model-row"')
      : body.indexOf('className: ModelsSection_module_css_default["modelRow"]');
    const expandedModalStart = body.indexOf('expanded.has(index) ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal', rowStart);
    const expandedStart = expandedModalStart >= 0
      ? expandedModalStart
      : body.indexOf('expanded.has(index) ? (0, react_jsx_runtime.jsxs)("div", {', rowStart);
    const rowChildrenEnd = body.indexOf('\n\t\t\t\t\t\t\t]', rowStart);
    if (rowStart < 0 || expandedStart < rowStart || rowChildrenEnd < rowStart) throw new Error('Missing model row action slot');
    const rowRemove = body.indexOf('className: "pangea-model-remove"', rowStart);
    if (rowRemove < 0 || rowRemove > rowChildrenEnd) {
      const danger = body.indexOf('className: `${ModelsSection_module_css_default["iconButton"]} ${ModelsSection_module_css_default["iconButtonDanger"]}`');
      const oldRemove = body.indexOf('className: "pangea-model-remove"');
      const buttonStart = body.lastIndexOf('(0, react_jsx_runtime.jsx)("button", {', danger >= 0 ? danger : oldRemove);
      let buttonEnd;
      if (danger >= 0) buttonEnd = body.indexOf('})\n\t\t\t\t\t\t\t]', danger) + 2;
      else {
        const imageInputStart = body.indexOf('(0, react_jsx_runtime.jsx)(ModelImageInputToggle, {', oldRemove);
        const separator = body.lastIndexOf('}),', imageInputStart);
        buttonEnd = separator >= 0 ? separator + 3 : -1;
      }
      if ((danger < 0 && oldRemove < 0) || buttonStart < 0 || buttonEnd <= buttonStart) throw new Error('Missing model removal action');
      const remove = body.slice(buttonStart, buttonEnd)
        .replace('className: `${ModelsSection_module_css_default["iconButton"]} ${ModelsSection_module_css_default["iconButtonDanger"]}`', 'className: "pangea-model-remove"')
        .replace('"aria-label": `${t("removeModel")} ${index + 1}`', '"aria-label": `${t("removeModel")} ${String(textOf(model, "id"))}`')
        .replace('"aria-label": `${props.t("removeModel")} ${String(index + 1)}`', '"aria-label": `${props.t("removeModel")} ${String(textOf(model, "id"))}`')
        .replace('"aria-label": `${props.t("removeModel")} ${index + 1}`', '"aria-label": `${props.t("removeModel")} ${String(textOf(model, "id"))}`')
        .replace('title: t("removeModel")', 'title: `${t("removeModel")} ${String(textOf(model, "id"))}`')
        .replace('title: props.t("removeModel")', 'title: `${props.t("removeModel")} ${String(textOf(model, "id"))}`');
      body = body.slice(0, buttonStart) + body.slice(buttonEnd);
      const insertAt = body.indexOf('\n\t\t\t\t\t\t\t]', rowStart);
      const separator = body.slice(0, insertAt).trimEnd().endsWith(',') ? '' : ',';
      body = body.slice(0, insertAt) + `${separator}\n\t\t\t\t\t\t\t${remove},` + body.slice(insertAt);
    }
  }
  if (!body.includes('pangea-model-capacity-dialog')) {
    const expanded = body.indexOf('expanded.has(index) ? (0, react_jsx_runtime.jsxs)("div", {');
    const element = body.indexOf('(0, react_jsx_runtime.jsxs)("div", {', expanded);
    const close = body.indexOf('}) : null]', element);
    if (expanded < 0 || element < expanded || close < element) throw new Error('Missing model capacity dialog region');
    const details = body.slice(element, close + 2);
    const wrapper = `expanded.has(index) ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
          open: expanded.has(index), onClose: () => toggleExpanded(index), title: Array.isArray(model.input) && model.input.includes("image") ? "图像模型设置" : "模型设置", closeLabel: t("close"), className: "pangea-model-capacity-modal",
          footer: (0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-capacity-done", disabled: disabled || model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) || model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0), title: model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) || model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0) ? "容量需为正整数，支持 K / M 后缀。" : void 0, onClick: () => toggleExpanded(index), children: "完成" }),
          children: (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-capacity-dialog", children: [
            (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-capacity-heading", children: [
              (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("strong", { children: textOf(model, "name") || textOf(model, "id") }), (0, react_jsx_runtime.jsx)("span", { children: textOf(model, "id") })] }),
              (0, react_jsx_runtime.jsx)("span", { className: "pangea-model-capacity-badge", children: Array.isArray(model.input) && model.input.includes("image") ? model.input.includes("text") ? "文本与图像" : "图像模型" : "文本模型" })
            ] }), (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) || model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) ? (0, react_jsx_runtime.jsx)("p", { role: "alert", className: "pangea-capacity-error", children: "容量需为正整数，支持 K / M 后缀。" }) : null, ${details}
          ] })\n        }) : null`;
    body = body.slice(0, expanded) + wrapper + body.slice(close + '}) : null'.length);
  }
  const genericCapacityTitle = 'title: "模型设置", closeLabel: t("close"), className: "pangea-model-capacity-modal"';
  if (body.includes(genericCapacityTitle)) {
    body = body.replace(genericCapacityTitle, 'title: Array.isArray(model.input) && model.input.includes("image") ? "图像模型设置" : "模型设置", closeLabel: t("close"), className: "pangea-model-capacity-modal"');
  }
  body = body.replace('compact: true,', 'compact: false,');
  const oldDone = 'className: "pangea-capacity-done", onClick: () => toggleExpanded(index)';
  if (body.includes(oldDone)) body = body.replace(oldDone, 'className: "pangea-capacity-done", disabled: disabled || model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) || model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0), title: model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) || model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0) ? "容量需为正整数，支持 K / M 后缀。" : void 0, onClick: () => toggleExpanded(index)');
  if (!body.includes('pangea-capacity-error')) {
    const heading = body.indexOf('className: "pangea-model-capacity-heading"');
    const advanced = body.indexOf('className: ModelsSection_module_css_default["modelAdvanced"]', heading);
    const headingClose = body.lastIndexOf('] }),', advanced);
    if (heading < 0 || advanced < heading || headingClose < heading) throw new Error('Missing model capacity validation anchor');
    const error = ' (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0) || model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) ? (0, react_jsx_runtime.jsx)("p", { role: "alert", className: "pangea-capacity-error", children: "容量需为正整数，支持 K / M 后缀。" }) : null,';
    body = body.slice(0, headingClose + 5) + error + body.slice(headingClose + 5);
  }
  if (!body.includes('pangea-model-list-actions-menu')) {
    const askable = 'const askable = probe.provider !== void 0 || probe.baseURL !== void 0 && probe.baseURL.length > 0;';
    if (!body.includes(askable)) throw new Error('Missing model action-menu effect anchor');
    body = body.replace(askable, `${askable}
			(0, react.useEffect)(() => {
				if (!actionsOpen) return;
				const onPointerDown = event => {
					if (!actionsRef.current?.contains(event.target)) setActionsOpen(false);
				};
				const onKeyDown = event => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					event.stopPropagation();
					setActionsOpen(false);
					requestAnimationFrame(() => actionsTriggerRef.current?.focus());
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown, true);
				requestAnimationFrame(() => actionsRef.current?.querySelector('[role="menuitem"]')?.focus());
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown, true);
				};
			}, [actionsOpen]);`);
  }
  if (!body.includes('pangea-model-advanced-list-head')) {
  if (!body.includes('className: ModelsSection_module_css_default["modelListHead"]')) throw new Error('Missing model list header anchor');
  const headerClass = 'className: ModelsSection_module_css_default["modelListHead"]';
  const headerClassAt = body.indexOf(headerClass);
  const headerStart = body.lastIndexOf('(0, react_jsx_runtime.jsxs)("div", {', headerClassAt);
  const headerSearchStart = body.indexOf('(0, react_jsx_runtime.jsx)(ModelCatalogSearch, {', headerClassAt);
  if (headerStart < 0 || headerSearchStart < headerStart) throw new Error('Missing model header/search region');
  const searchLineStart = body.lastIndexOf('\n', headerSearchStart) + 1;
  const legacyHeader = body.slice(headerStart, searchLineStart).trim().replace(/,$/, '');
  const advancedHeader = `(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-advanced-list-head", children: [
						(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-advanced-list-title", children: [
							(0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["modelCatalogTitle"], children: t("models") }),
							props.overridden === void 0 ? null : (0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["modelCatalogMeta"], children: props.overridden ? t("modelsCustomized") : t("modelsInherited") })
						] }),
						(0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-model-query-trigger", disabled: disabled || busy || !askable || props.probeBlocked !== void 0, title: props.probeBlocked !== void 0 ? t(props.probeBlocked) : askable ? void 0 : t("fetchNeedsBaseUrl"), onClick: event => { candidateReturnFocus.current = event.currentTarget; fetchModels(); }, children: [
							(0, react_jsx_runtime.jsx)("svg", { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", "aria-hidden": "true", children: [(0, react_jsx_runtime.jsx)("circle", { cx: 11, cy: 11, r: 7.5 }), (0, react_jsx_runtime.jsx)("path", { d: "m17 17 4 4" })] }), t("fetchModels")
						] }),
						props.onAddModel ? (0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-model-add-row", disabled, onClick: props.onAddModel, children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, { size: 15 }), t("addModel")] }) : null,
						(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-list-actions", ref: actionsRef, children: [
							(0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-model-list-actions-trigger", ref: actionsTriggerRef, "aria-label": "模型列表操作", "aria-haspopup": "menu", "aria-expanded": actionsOpen, "aria-controls": "pangea-model-list-actions-menu", title: "模型列表操作", onClick: () => setActionsOpen(current => !current), children: (0, react_jsx_runtime.jsx)("svg", { width: 18, height: 18, viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true", children: [(0, react_jsx_runtime.jsx)("circle", { cx: 5, cy: 12, r: 1.6 }), (0, react_jsx_runtime.jsx)("circle", { cx: 12, cy: 12, r: 1.6 }), (0, react_jsx_runtime.jsx)("circle", { cx: 19, cy: 12, r: 1.6 })] }) }),
							actionsOpen ? (0, react_jsx_runtime.jsxs)("div", { id: "pangea-model-list-actions-menu", className: "pangea-model-list-actions-menu", role: "menu", "aria-label": "模型列表操作", children: [
								(0, react_jsx_runtime.jsx)("button", { type: "button", role: "menuitem", onClick: () => { setActionsOpen(false); setSavedFilterOpen(true); requestAnimationFrame(() => savedFilterRef.current?.focus()); }, children: savedFilterOpen ? "编辑模型筛选" : "筛选已保存模型" }),
								props.overridden === true && props.onReset !== void 0 ? (0, react_jsx_runtime.jsx)("button", { type: "button", role: "menuitem", disabled, onClick: () => { props.onReset(); setActionsOpen(false); requestAnimationFrame(() => actionsTriggerRef.current?.focus()); }, children: t("resetModels") }) : null
							] }) : null
						] })
					] })`;
  const headerReplacement = `props.productAdvanced === true ? ${advancedHeader} : ${legacyHeader}`;
  body = body.slice(0, headerStart) + headerReplacement + ',\n\t\t\t\t\t' + body.slice(searchLineStart);
  const newSearchStart = body.indexOf('(0, react_jsx_runtime.jsx)(ModelCatalogSearch, {', headerStart);
  const newSearchClose = body.indexOf('})', newSearchStart);
  if (newSearchStart < 0 || newSearchClose < newSearchStart) throw new Error('Missing saved-model search renderer');
  const searchElement = body.slice(newSearchStart, newSearchClose + 2);
  if (!searchElement.includes('inputRef: savedFilterRef')) {
    const valueAnchor = 'value: props.modelQuery,';
    if (!searchElement.includes(valueAnchor)) throw new Error('Missing saved-model search input anchor');
    const withRef = searchElement.replace(valueAnchor, `${valueAnchor}\n\t\t\t\t\t\tinputRef: savedFilterRef,`);
    const conditionalSearch = `props.productAdvanced === true ? savedFilterOpen ? ${withRef} : null : ${withRef}`;
    body = body.slice(0, newSearchStart) + conditionalSearch + body.slice(newSearchClose + 2);
  }
  }
  body = body.replace(
    'className: ModelsSection_module_css_default["modelCatalog"],\n\t\t\t\t"aria-label": t("models"),',
    'className: props.productAdvanced === true ? "pangea-model-advanced-catalog" : ModelsSection_module_css_default["modelCatalog"],\n\t\t\t\t"aria-label": t("models"),'
  );
  return source.slice(0, start) + body + source.slice(end);
}

export function installProviderAdvancedView(source) {
  const start = source.indexOf('function ProviderEditor(props) {');
  const end = source.indexOf('\n\t\t}\n\t\t//#endregion', start);
  if (start < 0 || end < start) throw new Error('Missing advanced provider editor view');
  let body = source.slice(start, end);
  if (!body.includes('props.onAdvancedStateChange?.(customizedOpen)')) {
    const customizedState = 'const [customizedOpen, setCustomizedOpen] = (0, react.useState)(false);';
    if (!body.includes(customizedState)) throw new Error('Missing advanced provider state');
    body = body.replace(customizedState, `${customizedState}\n\t\t\t(0, react.useEffect)(() => {\n\t\t\t\tif (props.productPresentation === true && props.declared === true) props.onAdvancedStateChange?.(customizedOpen);\n\t\t\t}, [customizedOpen, props.onAdvancedStateChange]);`);
  }
  const catalogProps = 'const catalogProps = {\n\t\t\t\t\tmodels,';
  if (body.includes(catalogProps)) {
    body = body.replace(catalogProps, 'const catalogProps = {\n\t\t\t\t\tproductAdvanced: customizedOpen && props.productPresentation === true && props.declared === true && family === "pi-ai",\n\t\t\t\t\tonAddModel: addModel,\n\t\t\t\t\tmodels,');
  } else if (!body.includes('productAdvanced: customizedOpen && props.productPresentation === true')) {
    throw new Error('Missing advanced model catalog props');
  }
  if (!body.includes('pangea-model-advanced-provider-id')) {
  const identityField = `(0, react_jsx_runtime.jsx)("div", { className: "pangea-model-advanced-field pangea-model-advanced-provider-id", children: [
\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["fieldLabel"], children: "提供方 ID" }),
\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("input", { className: ModelsSection_module_css_default["input"], type: "text", value: props.provider, "aria-label": "提供方 ID", readOnly: true }),
\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("small", { children: "ID 固定，用于模型路由与凭据引用。" })
\t\t\t\t\t]})`;
    const nameStart = body.indexOf('children: t("customDisplayName")');
    const nameFieldStart = body.lastIndexOf('ownsIdentity ? (0, react_jsx_runtime.jsxs)("div", {', nameStart);
    if (nameStart < 0 || nameFieldStart < 0) throw new Error('Missing provider ID insertion point');
    body = body.slice(0, nameFieldStart) + 'ownsIdentity ? ' + identityField + ' : null,\n\t\t\t\t\t\t' + body.slice(nameFieldStart);
  const advancedFields = [
    ['children: t("customDisplayName")', 'pangea-model-advanced-field pangea-model-advanced-name'],
    ['children: t("baseUrl")', 'pangea-model-advanced-field pangea-model-advanced-endpoint'],
    ['children: t("customApi")', 'pangea-model-advanced-field pangea-model-advanced-protocol']
  ];
  for (const [label, className] of advancedFields) {
    const labelAt = body.indexOf(label);
    const fieldAt = body.lastIndexOf('className: ModelsSection_module_css_default["field"],', labelAt);
    if (labelAt < 0 || fieldAt < 0) throw new Error(`Missing advanced field class for ${label}`);
    body = body.slice(0, fieldAt) + `className: "${className}",` + body.slice(fieldAt + 'className: ModelsSection_module_css_default["field"],'.length);
  }
  const keyLabel = 'children: t("keyInput")';
  const keyLabelAt = body.indexOf(keyLabel);
  const keyFieldAt = body.lastIndexOf('className: ModelsSection_module_css_default["field"],', keyLabelAt);
  if (keyLabelAt < 0 || keyFieldAt < 0) throw new Error('Missing advanced credential field');
  body = body.slice(0, keyFieldAt) + 'className: "pangea-model-advanced-field pangea-model-credential-field",' + body.slice(keyFieldAt + 'className: ModelsSection_module_css_default["field"],'.length);
  }
  const credentialFieldTail = '}), props.credentialOnly === true ? null : (0, react_jsx_runtime.jsxs)("details", {';
  if (!body.includes('const credentialField =')) {
    const credentialClassAt = body.indexOf('className: "pangea-model-advanced-field pangea-model-credential-field",');
    const fieldAt = body.lastIndexOf('(0, react_jsx_runtime.jsxs)("div", {', credentialClassAt);
    const tailAt = body.indexOf(credentialFieldTail, credentialClassAt);
    const fragmentReturnAt = body.lastIndexOf('return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [', credentialClassAt);
    if (fieldAt < 0 || tailAt < fieldAt || fragmentReturnAt < 0) throw new Error('Missing credential field relocation anchors');
    const credentialExpression = body.slice(fieldAt, tailAt + 2);
    body = body.slice(0, fragmentReturnAt) + `const credentialField = ${credentialExpression};\n\t\t\t\t` + body.slice(fragmentReturnAt);
    const relocatedFragmentAt = body.indexOf('return (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [');
    const relocatedClassAt = body.indexOf('className: "pangea-model-advanced-field pangea-model-credential-field",', relocatedFragmentAt);
    const relocatedFieldAt = body.lastIndexOf('(0, react_jsx_runtime.jsxs)("div", {', relocatedClassAt);
    const relocatedTailAt = body.indexOf(credentialFieldTail, relocatedClassAt);
    const outsideField = 'customizedOpen && props.productPresentation === true && props.declared === true && family === "pi-ai" ? null : credentialField';
    body = body.slice(0, relocatedFieldAt) + outsideField + body.slice(relocatedTailAt + 2);
    const catalogAt = body.indexOf('family === "deepseek" ? (0, react_jsx_runtime.jsx)(DeepSeekModelsEditor, {', relocatedFieldAt);
    if (catalogAt < 0) throw new Error('Missing advanced credential destination');
    body = body.slice(0, catalogAt) + 'customizedOpen && props.productPresentation === true && props.declared === true && family === "pi-ai" ? credentialField : null,\n\t\t\t\t\t\t\t' + body.slice(catalogAt);
  } else if (!body.includes('customizedOpen && props.productPresentation === true && props.declared === true && family === "pi-ai" ? credentialField : null')) {
    throw new Error('Credential field exists without advanced placement');
  }
  const footerStart = body.indexOf('className: "dshProviderEditorStickyFooter');
  if (footerStart < 0) throw new Error('Missing advanced editor footer');
  if (!body.includes('className: "dshProviderEditorStickyFooter pangea-model-advanced-footer"')) {
    const footerClassEnd = body.indexOf('"', footerStart + 'className: "'.length);
    if (footerClassEnd < 0) throw new Error('Missing advanced editor footer class end');
    body = body.slice(0, footerClassEnd) + ' pangea-model-advanced-footer' + body.slice(footerClassEnd);
  }
  const newFooterStart = body.indexOf('className: "dshProviderEditorStickyFooter pangea-model-advanced-footer"');
  const newFooterChildren = body.indexOf('children: [', newFooterStart);
  if (!body.slice(newFooterChildren, newFooterChildren + 200).includes('customizedOpen && props.productPresentation')) {
    const insertAt = newFooterChildren + 'children: ['.length;
    body = body.slice(0, insertAt) + 'customizedOpen && props.productPresentation === true && props.declared === true && layout === "pi-ai" ? null : ' + body.slice(insertAt);
  }
  return source.slice(0, start) + body + source.slice(end);
}

export function installProviderConflictReload(source) {
  const start = source.indexOf('function ProviderEditor(props) {');
  const end = source.indexOf('\n\t\t}\n\t\t//#endregion', start);
  if (start < 0 || end < start) throw new Error('Missing provider editor conflict state');
  let body = source.slice(start, end);
  if (!body.includes('pangea-model-conflict-dialog')) {
    const failure = /failure !== void 0 \? \(0, react_jsx_runtime\.jsx\)\("p", \{\s*className: ModelsSection_module_css_default\["error"\],\s*children: failure\s*\}\) : null,/g;
    if ([...body.matchAll(failure)].length !== 1) throw new Error('Missing provider editor failure message');
    body = body.replace(failure, `failure !== void 0 ? failure === t("conflict") && typeof props.onConflictReload === "function" ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open: true,
				onClose: () => setFailure(void 0),
				title: "模型配置保存冲突",
				closeLabel: t("close"),
				className: "pangea-model-conflict-dialog",
				footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					(0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-model-query-secondary", onClick: () => setFailure(void 0), children: "关闭" }),
					(0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-model-query-primary", onClick: async () => { setFailure(void 0); await props.onConflictReload(); }, children: "重新读取配置" })
				] }),
				children: (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-conflict-message", role: "alert", children: [
					(0, react_jsx_runtime.jsx)("strong", { children: "配置已经发生变化" }),
					(0, react_jsx_runtime.jsx)("p", { children: "其他位置更新了这份配置。当前修改尚未覆盖最新版本。" }),
					(0, react_jsx_runtime.jsx)("p", { children: "重新读取会放弃尚未应用的修改，并显示服务器当前值。" })
				] })
			}) : (0, react_jsx_runtime.jsx)("p", { className: ModelsSection_module_css_default["error"], children: failure }) : null,`);
  }
  body = body.replace('setFailure(failure);\n\t\t\t\t\t\treturn;', 'setFailure(failure);\n\t\t\t\t\t\tif (failure === t("conflict")) props.onConflictState?.(true);\n\t\t\t\t\t\treturn;');
  source = source.slice(0, start) + body + source.slice(end);
  if (!source.includes('pangea-model-conflict-state')) {
    const viewAnchor = 'const viewState = state.status === "loading" && props.productTarget?.create && lastReadySnapshot.current ? lastReadySnapshot.current : state;';
    const view = `
      if (props.productConflictOpen === true) {
        const row = state.rows.find(item => item.entry.provider === props.productTarget?.providerId);
        return (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-state pangea-model-conflict-state", children: [
          (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-notice pangea-model-conflict-notice", role: "alert", children: [
            (0, react_jsx_runtime.jsx)("strong", { children: "ⓘ  配置已经发生变化" }),
            (0, react_jsx_runtime.jsx)("p", { children: "其他位置更新了这份配置。当前修改尚未覆盖最新版本，请重新打开设置并确认。" })
          ] }),
          (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-provider-summary", children: [
            (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-provider-identity", children: [
              (0, react_jsx_runtime.jsx)("span", { className: "pangea-model-provider-mark", "aria-hidden": "true", children: String(row?.entry.provider || "T").charAt(0).toUpperCase() }),
              (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("strong", { children: row?.entry.displayName || row?.entry.provider || "模型接口" }), (0, react_jsx_runtime.jsxs)("p", { children: [row?.entry.provider || "", " · 自定义接口"] })] })
            ] }),
            (0, react_jsx_runtime.jsx)("span", { className: row?.credential?.configured === true ? "pangea-model-provider-status is-configured" : "pangea-model-provider-status", children: row?.credential?.configured === true ? "API 密钥已配置" : "API 密钥未配置" })
          ] }),
          (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-actions", children: [
            (0, react_jsx_runtime.jsx)("button", { type: "button", onClick: props.onClose, children: "关闭" }),
            (0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-model-overlay-primary", onClick: async () => { await props.controller.load(); props.onConflictState(false); }, children: "重新读取配置" })
          ] })
        ] });
      }`;
    if (!source.includes(viewAnchor)) throw new Error('Missing product conflict view anchor');
    source = source.replace(viewAnchor, viewAnchor + view);
  }
  source = source.replace('onConflictReload: () => props.controller.load(), onAdvancedStateChange:', 'onConflictReload: () => props.controller.load(), onConflictState: props.onConflictState, onAdvancedStateChange:');
  if (!source.includes('const [conflictOpen, setConflictOpen]')) {
    source = source.replace('const [productTarget, setProductTarget] = (0, react.useState)(null);', 'const [productTarget, setProductTarget] = (0, react.useState)(null);\n\t\t\tconst [conflictOpen, setConflictOpen] = (0, react.useState)(false);');
  }
  source = source.replace('setValidationError(false); setAdvancedOpen(false); setProductTarget(event.detail);', 'setValidationError(false); setAdvancedOpen(false); setConflictOpen(false); setProductTarget(event.detail);');
  source = source.replace('PangeaInternalModelSettings, { ...props, t: pangeaModelText, productTarget, onValidationState:', 'PangeaInternalModelSettings, { ...props, t: pangeaModelText, productTarget, productConflictOpen: conflictOpen, onConflictState: setConflictOpen, onValidationState:');
  source = source.replace('productConflictOpen: conflictOpen, onConflictState: setConflictOpen, onValidationState:', 'productConflictOpen: conflictOpen, onConflictState: value => { setConflictOpen(value); if (value) setAdvancedOpen(false); }, onValidationState:');
  const conflictTitle = 'conflictOpen ? "模型配置保存冲突" : ';
  while (source.includes(conflictTitle + conflictTitle)) source = source.replaceAll(conflictTitle + conflictTitle, conflictTitle);
  if (!source.includes(conflictTitle)) source = source.replaceAll('state.status === "ready" && state.writable === false ? "模型设置只读" : state.status === "error"', conflictTitle + 'state.status === "ready" && state.writable === false ? "模型设置只读" : state.status === "error"');
  return source;
}

export function installProviderReadonlyView(source) {
  const start = source.indexOf('function ProviderEditor(props) {');
  const end = source.indexOf('\n\t\t}\n\t\t//#endregion', start);
  if (start < 0 || end < start) throw new Error('Missing provider editor read-only state');
  let body = source.slice(start, end);
  if (!body.includes('const [keyLockedLanding, setKeyLockedLanding]')) {
    body = body.replace('const [keyState, setKeyState] = (0, react.useState)(void 0);', 'const [keyState, setKeyState] = (0, react.useState)(void 0);\n\t\t\tconst [keyLockedLanding, setKeyLockedLanding] = (0, react.useState)(true);');
  }
  if (!body.includes('pangea-model-readonly-view')) {
    const anchor = 'if (node === void 0) return (0, react_jsx_runtime.jsx)("p", {';
    const readonlyView = `if (props.productReadOnly === true) {
				const profile = schema.getPath(namespace.value, settingsPath);
				const readOnlyModels = schema.getPath(profile, ["models"]);
				return (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-state pangea-model-readonly-view", children: [
					(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-notice pangea-model-readonly-notice", role: "status", children: [
						(0, react_jsx_runtime.jsx)("strong", { children: "ⓘ  当前配置只读" }),
						(0, react_jsx_runtime.jsx)("p", { children: "当前连接没有设置写入权限，你可以查看接口与模型配置。" })
					] }),
					(0, react_jsx_runtime.jsxs)("dl", { className: "pangea-model-readonly-fields", children: [
						(0, react_jsx_runtime.jsx)("dt", { children: "接口地址" }), (0, react_jsx_runtime.jsx)("dd", { children: stringAt(profile, "baseURL") ?? "—" }),
						(0, react_jsx_runtime.jsx)("dt", { children: "API 协议" }), (0, react_jsx_runtime.jsx)("dd", { children: stringAt(profile, "api") ?? "—" }),
						(0, react_jsx_runtime.jsx)("dt", { children: "模型列表" }), (0, react_jsx_runtime.jsx)("dd", { children: Array.isArray(readOnlyModels) ? readOnlyModels.map(model => textOf(model, "id")).filter(Boolean).join("\\n") || "暂无模型" : "暂无模型" })
					] }),
					(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-actions", children: [
						(0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-model-overlay-primary", onClick: () => props.onClose(false), children: "关闭" })
					] })
				] });
			}
			`;
    if (!body.includes(anchor)) throw new Error('Missing provider editor read-only insertion anchor');
    body = body.replace(anchor, readonlyView + anchor);
  }
  const legacyIdentity = `(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-readonly-identity", children: [
						(0, react_jsx_runtime.jsx)("strong", { children: props.displayName || props.provider }),
						(0, react_jsx_runtime.jsx)("span", { children: props.provider })
					] }),
					`;
  body = body.replace(legacyIdentity, '');
  body = body.replace('children: "当前配置只读"', 'children: "ⓘ  当前配置只读"');
  if (!body.includes('pangea-model-key-locked-view')) {
    const anchor = 'if (node === void 0) return (0, react_jsx_runtime.jsx)("p", {';
    const keyLockedView = `if (props.productPresentation === true && keyState?.writable === false && keyLockedLanding) return (0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-overlay-state pangea-model-key-locked-view", children: [
				(0, react_jsx_runtime.jsxs)("div", { className: "pangea-model-key-locked-field", children: [
					(0, react_jsx_runtime.jsx)("label", { children: t("keyInput") }),
					(0, react_jsx_runtime.jsx)("input", { type: "text", "aria-label": t("keyInput"), value: "由启动环境提供 · 只读", disabled: true, readOnly: true }),
					(0, react_jsx_runtime.jsx)("small", { children: "凭据由启动环境提供，此处不能覆盖。" })
				] }),
				(0, react_jsx_runtime.jsx)("p", { className: "pangea-model-key-locked-copy", children: "接口与模型目录仍可按当前设置权限编辑。" }),
				(0, react_jsx_runtime.jsx)("div", { className: "pangea-model-key-locked-action", children: (0, react_jsx_runtime.jsx)("button", { type: "button", onClick: () => { setKeyLockedLanding(false); setCustomizedOpen(true); }, children: "编辑自定义设置" }) }),
				(0, react_jsx_runtime.jsx)("div", { className: "pangea-model-overlay-actions", children: (0, react_jsx_runtime.jsx)("button", { type: "button", className: "pangea-model-overlay-primary", onClick: () => props.onClose(false), children: "关闭" }) })
			] });
			`;
    if (!body.includes(anchor)) throw new Error('Missing provider editor key-locked insertion anchor');
    body = body.replace(anchor, keyLockedView + anchor);
  }
  source = source.slice(0, start) + body + source.slice(end);
  if (!source.includes('"环境凭据只读"')) {
    source = source.replaceAll('productTarget?.providerId && advancedOpen ? "模型自定义设置" : productTarget?.providerId ? "模型接入"',
      'productTarget?.providerId && state.status === "ready" && state.rows.some(row => row.entry.provider === productTarget.providerId && row.credential?.writable === false) && !advancedOpen ? "环境凭据只读" : productTarget?.providerId && advancedOpen ? "模型自定义设置" : productTarget?.providerId ? "模型接入"');
  }
  return source;
}
