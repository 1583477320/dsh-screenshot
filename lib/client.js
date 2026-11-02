window.__ModuleLoader__.load({
	id: "dsh-screenshot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		//#region styles
		const css = [
			".dshshot_section{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}",
			".dshshot_heading{margin:0;font-size:18px;font-weight:600}",
			".dshshot_intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}",
			".dshshot_rows{flex-direction:column;gap:2px;display:flex}",
			".dshshot_row{justify-content:space-between;align-items:center;gap:18px;padding:12px 0;display:flex;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
			".dshshot_row:last-child{border-bottom:0}",
			".dshshot_text{flex-direction:column;gap:3px;min-width:0;display:flex}",
			".dshshot_label{font-size:13px;line-height:20px}",
			".dshshot_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dshshot_control{flex-shrink:0;align-items:center;gap:8px;display:flex}",
			".dshshot_input{background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;min-width:220px;padding:5px 9px;font:inherit;font-size:13px;line-height:20px}",
			".dshshot_input:focus{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
			".dshshot_input::placeholder{color:var(--dsw-alias-label-tertiary)}",
			".dshshot_key{background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;cursor:pointer;min-width:150px;padding:5px 10px;font:inherit;font-size:13px;line-height:20px;text-align:center}",
			".dshshot_key[data-recording=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}",
			".dshshot_key:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
			".dshshot_select{background:var(--dsw-alias-bg-l2);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 9px;font:inherit;font-size:13px;line-height:20px}",
			".dshshot_switch{appearance:none;-webkit-appearance:none;background:var(--dsw-alias-border-l2);border-radius:999px;cursor:pointer;width:36px;height:20px;position:relative;transition:background .15s}",
			".dshshot_switch:checked{background:var(--dsw-alias-state-business-primary)}",
			".dshshot_switch:before{background:var(--dsw-alias-bg-l1);content:\"\";border-radius:50%;width:16px;height:16px;position:absolute;top:2px;left:2px;transition:transform .15s}",
			".dshshot_switch:checked:before{transform:translateX(16px)}",
			".dshshot_switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}",
			".dshshot_error{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:18px}",
			".dshshot_muted{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px}",
		].join("");
		const tagId = "dsh-screenshot/ScreenshotSection.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-screenshot";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region locales
		const en = {
			nav: "Screenshot",
			title: "Screenshot",
			intro: "A global hotkey grabs a region of the screen and copies it straight to the clipboard, without opening the main window.",
			enabled: "Enable the global hotkey",
			enabledHint: "When off, no hotkey is registered at all.",
			hotkey: "Hotkey",
			hotkeyHint: "Click and press the combination. If another program already owns it, a spare combination is used instead.",
			hotkeyRecording: "Press a combination…",
			hotkeyEmpty: "Not set",
			hotkeyNeedsModifier: "Include Ctrl, Alt, Shift or Win.",
			directory: "Save folder",
			directoryHint: "Used by the SAVE button. Leave blank for Pictures/DSH Screenshots.",
			directoryPlaceholder: "Default folder",
			action: "Confirm action",
			actionHint: "What Enter and the confirm button do; hold Ctrl to flip it.",
			actionCopy: "Copy to clipboard",
			actionSave: "Save to folder",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "The screenshot service is not running, so there is nothing to configure.",
			loading: "Loading…",
			saveFailed: "The deployment did not accept that value.",
			escapeHint: "Esc cancels a selection.",
			model: "Vision model",
			modelHint: "Used by the TEXT button. A bare model name works, or provider/model to pin a route. Empty picks the first route that accepts images; local OCR is the fallback. When it fails, the result panel lists the models this machine actually offers.",
			modelPlaceholder: "auto",
			modelAuto: "Automatic",
			modelCustom: "{route} (not in the list)",
			modelUnavailable: "Could not read the model list (remote.settings unavailable), so this field has to be typed: a model name, or provider/model.",
		};
		const zh = {
			nav: "截图",
			title: "截图",
			intro: "用全局快捷键框选屏幕区域并直接复制到剪贴板，不会打开主窗口。",
			enabled: "启用全局快捷键",
			enabledHint: "关闭后不注册任何快捷键。",
			hotkey: "快捷键",
			hotkeyHint: "点击后按下组合键。若已被其它程序占用，会自动改用备用组合。",
			hotkeyRecording: "请按下组合键…",
			hotkeyEmpty: "未设置",
			hotkeyNeedsModifier: "请包含 Ctrl、Alt、Shift 或 Win。",
			directory: "保存目录",
			directoryHint: "保存按钮使用的目录，留空则为「图片/DSH Screenshots」。",
			directoryPlaceholder: "默认目录",
			action: "确认动作",
			actionHint: "回车与确认按钮的行为；按住 Ctrl 可临时反转。",
			actionCopy: "复制到剪贴板",
			actionSave: "保存到目录",
			readOnly: "本部署的设置为只读。",
			unavailable: "截图服务未运行，暂时没有可配置的内容。",
			loading: "加载中…",
			saveFailed: "本部署没有接受这个值。",
			escapeHint: "按 Esc 取消框选。",
			model: "识别模型",
			modelHint: "TEXT 按钮使用的大模型：填模型名即可，也可写「提供方/模型」指定路由。留空则自动选择支持图像输入的模型，不可用时回退到本地 OCR。识别失败时结果面板会列出这台机器上可用的模型。",
			modelPlaceholder: "自动",
			modelAuto: "自动（推荐）",
			modelCustom: "{route}（当前值，不在列表里）",
			modelUnavailable: "读取不到模型列表（remote.settings 不可用），这个字段暂时只能手填：填模型名，或「提供方/模型」。",
		};
		//#endregion

		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.screenshot";
		/** The Host plugin entry whose settings this page edits. */
		const SETTINGS_NS = "dsh-screenshot";
		/**
		 * Required services (cordis fiber inject).
		 *
		 * `remote.*` is what makes the model list reachable: cordis only hands a
		 * service to a fiber that declares it. `remote.session.modelCatalog` is the
		 * same source the chat's own model picker reads, which is the only place
		 * that knows about providers whose models are built into an adapter (the
		 * official DeepSeek ones) rather than listed in the settings document.
		 */
		const inject = ["slots", "locale", "configForms", "remote", "remote.settings", "remote.session"];

		const h = React.createElement;

		/**
		 * Collect `provider/model` routes out of the settings document.
		 *
		 * The model catalogue is not exposed by any remote namespace — `llm` only
		 * publishes provider keys — so the configured providers are read out of the
		 * settings document itself. The shape is `providers: { key: { displayName,
		 * models: [{ id, name }] } }`, nested under whichever namespace declares it
		 * (`llm-pi-ai` today), so the tree is walked instead of hard-coding a path:
		 * a differently named or restructured adapter still yields options.
		 * @param view - the `settings.describe()` payload.
		 * @returns `[{ value: 'provider/model', label }]`, de-duplicated in order.
		 */
		function routesFromSettings(view) {
			const options = [];
			const seen = new Set();
			const visit = (node, depth) => {
				if (node === null || typeof node !== "object" || depth > 6) return;
				const providers = node.providers;
				if (providers !== null && typeof providers === "object") {
					const entries = Array.isArray(providers)
						? providers.map((entry) => [entry?.provider ?? entry?.id, entry])
						: Object.entries(providers);
					for (const [key, entry] of entries) {
						const models = Array.isArray(entry?.models) ? entry.models : [];
						for (const model of models) {
							const id = typeof model === "string" ? model : model?.id;
							const owner = entry?.provider ?? entry?.id ?? key;
							if (typeof id !== "string" || id.length === 0) continue;
							if (typeof owner !== "string" || owner.length === 0) continue;
							const route = `${owner}/${id}`;
							if (seen.has(route)) continue;
							seen.add(route);
							const modelName = typeof model === "string" ? id : (model?.name ?? id);
							const ownerName = typeof entry?.displayName === "string" && entry.displayName.length > 0
								? entry.displayName
								: owner;
							options.push({ value: route, label: `${ownerName} · ${modelName}` });
						}
					}
				}
				for (const value of Object.values(node)) visit(value, depth + 1);
			};
			visit(view, 0);
			return options;
		}

		/**
		 * Turn a `session.modelCatalog()` payload into options.
		 *
		 * This is the chat picker's own source: every registered provider with the
		 * models its adapter advertises, including the ones whose catalogue lives in
		 * code rather than in the settings document (the official DeepSeek routes).
		 * Shape: `{ groups: [{ id, name, models: [{ id, name }] }] }`.
		 * @param view - the catalog payload.
		 * @returns `[{ value: 'provider/model', label }]`.
		 */
		function routesFromCatalog(view) {
			const options = [];
			const groups = Array.isArray(view?.groups) ? view.groups : [];
			for (const group of groups) {
				const provider = typeof group?.id === "string" ? group.id : undefined;
				if (provider === undefined || provider.length === 0) continue;
				const providerName = typeof group.name === "string" && group.name.length > 0 ? group.name : provider;
				const models = Array.isArray(group.models) ? group.models : [];
				for (const model of models) {
					const id = typeof model === "string" ? model : model?.id;
					if (typeof id !== "string" || id.length === 0) continue;
					const name = typeof model === "string" ? id : (model?.name ?? id);
					options.push({ value: `${provider}/${id}`, label: `${providerName} · ${name}` });
				}
			}
			return options;
		}

		/**
		 * Resolve the selectable models.
		 *
		 * The session catalogue is asked first because it is the complete picture —
		 * it is what the chat's model picker shows, official routes included. The
		 * settings document is the fallback for a deployment where that namespace is
		 * missing; it only knows providers that spell their models out in config.
		 * Both are retried briefly while the page mounts, then abandoned so the text
		 * field can take over instead of blocking behind a spinner.
		 * @param ctx - the plugin context, read for `remote.session`/`remote.settings`.
		 * @returns the options, or `undefined` when neither source answers.
		 */
		function useModelRoutes(ctx) {
			const [routes, setRoutes] = React.useState(undefined);
			React.useEffect(() => {
				let alive = true;
				let attempts = 0;
				let timer;
				const settle = (found) => {
					if (!alive) return;
					if (found.length > 0) setRoutes(found);
				};
				const read = (method, mapper) => Promise.resolve()
					.then(() => method())
					.then((response) => {
						if (!alive) return false;
						const view = response?.ok === false ? undefined : (response?.value ?? response);
						if (view === undefined) return false;
						const found = mapper(view);
						if (found.length === 0) return false;
						settle(found);
						return true;
					})
					.catch(() => false);
				const attempt = () => {
					if (!alive) return;
					let remote;
					try {
						// `ctx.get` is the escape hatch when the service is not a plain
						// property of this context branch.
						remote = ctx?.remote ?? ctx?.get?.("remote");
					} catch {
						remote = undefined;
					}
					const session = remote?.session;
					const settings = remote?.settings;
					const canCatalog = typeof session?.modelCatalog === "function";
					const canSettings = typeof settings?.describe === "function";
					if (!canCatalog && !canSettings) {
						if (attempts++ < 15) timer = setTimeout(attempt, 400);
						return;
					}
					const fromSettings = () => {
						if (!canSettings) return;
						void read(() => settings.describe(), routesFromSettings);
					};
					if (!canCatalog) {
						fromSettings();
						return;
					}
					void read(() => session.modelCatalog(), routesFromCatalog)
						.then((found) => { if (!found) fromSettings(); });
				};
				attempt();
				return () => {
					alive = false;
					if (timer !== undefined) clearTimeout(timer);
				};
			}, [ctx]);
			return routes;
		}

		/**
		 * Read the shared form for this plugin's namespace.
		 * @param controller - the ConfigFormController from `configForms.get`.
		 * @returns the current snapshot, re-rendering on every change.
		 */
		function useSnapshot(controller) {
			const subscribe = React.useCallback((listener) => controller.subscribe(listener), [controller]);
			const read = React.useCallback(() => controller.getSnapshot(), [controller]);
			return React.useSyncExternalStore(subscribe, read, read);
		}

		/** Modifier keys, in the order the accelerator parser expects. */
		const MODIFIER_ORDER = [
			["ctrlKey", "Ctrl"],
			["altKey", "Alt"],
			["shiftKey", "Shift"],
			["metaKey", "Win"],
		];

		/**
		 * Turn a key event into an accelerator string.
		 * @param event - the keydown event.
		 * @returns the accelerator, or undefined while only modifiers are held.
		 */
		function acceleratorOf(event) {
			const key = event.key;
			if (key === undefined) return undefined;
			if (key === "Control" || key === "Alt" || key === "Shift" || key === "Meta") return undefined;
			const parts = [];
			for (const [flag, name] of MODIFIER_ORDER) {
				if (event[flag] === true) parts.push(name);
			}
			let named = key;
			if (key.length === 1) named = key.toUpperCase();
			else if (/^F\d{1,2}$/.test(key)) named = key;
			else {
				const alias = {
					Escape: "Esc",
					Enter: "Enter",
					" ": "Space",
					ArrowUp: "Up",
					ArrowDown: "Down",
					ArrowLeft: "Left",
					ArrowRight: "Right",
					Backspace: "Backspace",
					Delete: "Delete",
					Home: "Home",
					End: "End",
					PageUp: "PageUp",
					PageDown: "PageDown",
					Tab: "Tab",
				}[key];
				// Anything else (Dead keys, IME output) is not a stable accelerator.
				if (alias === undefined) return undefined;
				named = alias;
			}
			if (parts.length === 0) return undefined;
			return [...parts, named].join("+");
		}

		/**
		 * The Screenshot settings page.
		 * @param props - `t` is bound to this plugin's dictionary.
		 */
		function ScreenshotSection(props) {
			const t = props.t;
			const controller = ScreenshotSection.controller;
			const snapshot = useSnapshot(controller);
			const [recording, setRecording] = React.useState(false);
			const [pendingHotkey, setPendingHotkey] = React.useState(undefined);
			const [directory, setDirectory] = React.useState(undefined);
			const [model, setModel] = React.useState(undefined);
			const [failure, setFailure] = React.useState(undefined);

			const value = snapshot.value ?? {};
			const writable = snapshot.writable === true;
			const ready = snapshot.status === "ready";

			const commit = (field, next) => {
				setFailure(undefined);
				const accepted = controller.set(field, next);
				// `set` resolves once the Host answered; a rejection is worth showing.
				Promise.resolve(accepted).then((ok) => {
					if (ok === false) setFailure(t("saveFailed"));
				});
			};

			const row = (label, hint, control) => h(
				"div",
				{ className: "dshshot_row" },
				h("div", { className: "dshshot_text" },
					h("span", { className: "dshshot_label" }, label),
					hint === undefined ? null : h("span", { className: "dshshot_hint" }, hint)),
				h("div", { className: "dshshot_control" }, control),
			);

			const routes = useModelRoutes(ScreenshotSection.ctx);

			// The stored value may be a full route or a bare model name (both are
			// accepted by the host). Show the route it resolves to, so a value that
			// is configured correctly never looks like an unknown one — without
			// rewriting what the user saved.
			const stored = value.ocrModel ?? "";
			const resolved = stored === ""
				? ""
				: (routes ?? []).find((route) => route.value === stored)?.value
					?? (routes ?? []).find((route) => route.value.slice(route.value.indexOf("/") + 1) === stored)?.value
					?? stored;
			const selectedRoute = resolved;

			const body = [];
			if (snapshot.status === "loading") {
				body.push(h("p", { className: "dshshot_muted", key: "loading" }, t("loading")));
			} else if (snapshot.status === "unavailable") {
				body.push(h("p", { className: "dshshot_muted", key: "unavailable" }, t("unavailable")));
			} else {
				body.push(h(
					"div",
					{ className: "dshshot_rows", key: "rows" },
					row(
						t("enabled"),
						t("enabledHint"),
						h("input", {
							type: "checkbox",
							className: "dshshot_switch",
							role: "switch",
							checked: value.enabled !== false,
							disabled: !writable,
							"aria-label": t("enabled"),
							onChange: (event) => commit("enabled", event.target.checked),
						}),
					),
					row(
						t("hotkey"),
						t("hotkeyHint"),
						h("button", {
							type: "button",
							className: "dshshot_key",
							"data-recording": recording ? "true" : undefined,
							disabled: !writable,
							onClick: () => setRecording(true),
							onBlur: () => setRecording(false),
							onKeyDown: (event) => {
								if (!recording) return;
								if (event.key === "Escape") {
									event.preventDefault();
									setRecording(false);
									setPendingHotkey(undefined);
									return;
								}
								const accelerator = acceleratorOf(event);
								if (accelerator === undefined) {
									event.preventDefault();
									setPendingHotkey(undefined);
									setFailure(t("hotkeyNeedsModifier"));
									return;
								}
								event.preventDefault();
								setRecording(false);
								setPendingHotkey(undefined);
								commit("hotkey", accelerator);
							},
							children: recording
								? t("hotkeyRecording")
								: pendingHotkey ?? (value.hotkey ? value.hotkey : t("hotkeyEmpty")),
						}),
					),
					row(
						t("directory"),
						t("directoryHint"),
						h("input", {
							type: "text",
							className: "dshshot_input",
							value: directory ?? value.saveDirectory ?? "",
							placeholder: t("directoryPlaceholder"),
							disabled: !writable,
							"aria-label": t("directory"),
							onChange: (event) => setDirectory(event.target.value),
							onBlur: () => {
								if (directory === undefined) return;
								if (directory === (value.saveDirectory ?? "")) return;
								commit("saveDirectory", directory);
								setDirectory(undefined);
							},
							onKeyDown: (event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							},
						}),
					),
					row(
						t("action"),
						t("actionHint"),
						h("select", {
							className: "dshshot_select",
							value: value.action === "save" ? "save" : "copy",
							disabled: !writable,
							"aria-label": t("action"),
							onChange: (event) => commit("action", event.target.value),
						},
							h("option", { value: "copy" }, t("actionCopy")),
							h("option", { value: "save" }, t("actionSave")),
						),
					),
					row(
						t("model"),
						t("modelHint"),
						routes !== undefined && routes.length > 0
							? h("select", {
								className: "dshshot_select",
								value: selectedRoute,
								disabled: !writable,
								"aria-label": t("model"),
								onChange: (event) => commit("ocrModel", event.target.value),
							},
								h("option", { value: "" }, t("modelAuto")),
								// A value saved before the catalogue loaded, from another
								// deployment, or typed as a bare model name must stay
								// selectable, otherwise the browser would silently point
								// the field at "auto" and change behaviour on open.
								selectedRoute !== "" && !routes.some((route) => route.value === selectedRoute)
									? h("option", { value: selectedRoute }, t("modelCustom").replace("{route}", selectedRoute))
									: null,
								routes.map((route) => h("option", { key: route.value, value: route.value }, route.label)),
							)
							: h("input", {
								type: "text",
								className: "dshshot_input",
								value: model ?? value.ocrModel ?? "",
								placeholder: t("modelPlaceholder"),
								disabled: !writable,
								"aria-label": t("model"),
							onChange: (event) => setModel(event.target.value),
							onBlur: () => {
								if (model === undefined) return;
								if (model === (value.ocrModel ?? "")) return;
								commit("ocrModel", model);
								setModel(undefined);
							},
							onKeyDown: (event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							},
							}),
					),
				));
				if (!writable) body.push(h("p", { className: "dshshot_muted", key: "ro" }, t("readOnly")));
				// A silent text box is a dead end: say which half failed so the
				// next report is specific instead of "there is no dropdown".
				if (routes === undefined) {
					body.push(h("p", { className: "dshshot_muted", key: "noroutes" }, t("modelUnavailable")));
				}
				if (ready && value.enabled === false) {
					body.push(h("p", { className: "dshshot_muted", key: "off" }, t("enabledHint")));
				}
			}
			if (failure !== undefined) body.push(h("p", { className: "dshshot_error", key: "err" }, failure));

			return h(
				"div",
				{ className: "dshshot_section" },
				h("h2", { className: "dshshot_heading" }, t("title")),
				h("p", { className: "dshshot_intro" }, t("intro")),
				body,
				h("p", { className: "dshshot_hint" }, t("escapeHint")),
			);
		}

		/**
		 * Mount the screenshot settings page.
		 *
		 * The page exists only while the Host serves this plugin's settings
		 * namespace, so a deployment without the service shows no trace of it.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-screenshot: dictionaries");
			const controller = ctx.configForms.get(SETTINGS_NS);
			ScreenshotSection.controller = controller;
			// Kept for the model dropdown: the settings document is read lazily
			// from here, so this plugin never has to declare `remote` in `inject`
			// and a deployment without that namespace still renders a text field.
			ScreenshotSection.ctx = ctx;
			ctx.effect(() => ctx.configForms.whileServed([SETTINGS_NS], () => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "screenshot",
				order: 55,
				label: () => t("nav"),
				locale: NS,
			}, ScreenshotSection))), "dsh-screenshot: settings page");
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		// Test hook: the option derivation is pure, so it can be exercised
		// against a real settings document without mounting the component.
		exports.__routesFromSettings = routesFromSettings;
		return module.exports;
	}
});
