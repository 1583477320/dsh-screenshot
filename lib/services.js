/**
 * Optional service lookup.
 *
 * A cordis context is a proxy that THROWS when an undeclared service is read:
 * `cannot get property "llm" without inject`. Declaring the service in `inject`
 * fixes the throw but makes it required, and a required service that is never
 * provided leaves the plugin permanently inactive — the hotkey would silently
 * disappear on a deployment without that plugin. Worse, a misspelt name in
 * `inject` fails exactly the same silent way.
 *
 * `ctx.reflect.get(name)` resolves the same registry without the inject gate and
 * yields `undefined` while the providing fiber is not active yet, so a missing or
 * mistyped service costs a feature instead of the whole plugin.
 *
 * @module dsh-screenshot/services
 */

/**
 * Resolve a service by name without declaring it in `inject`.
 * @param ctx - the plugin context.
 * @param name - the service name, e.g. `llm`.
 * @returns the service, or `undefined` when it is absent or not yet active.
 */
export function service(ctx, name) {
	if (ctx === null || ctx === undefined) return undefined;
	try {
		const reflect = ctx.reflect;
		if (reflect !== undefined && typeof reflect.get === "function") {
			const resolved = reflect.get(name);
			if (resolved !== undefined) return resolved;
		}
	} catch {
		// Contexts outside cordis (probes, tests) have no reflection layer.
	}
	try {
		// Plain fallback: works for a context that is not a proxy, and for a
		// proxy that has the service declared.
		return ctx[name];
	} catch {
		return undefined;
	}
}

/**
 * The LLM registry, when this deployment has one.
 * @param ctx - the plugin context.
 * @returns the `llm` service, or `undefined`.
 */
export function llmOf(ctx) {
	return service(ctx, "llm");
}

/**
 * The attachment store, when this deployment has one.
 * @param ctx - the plugin context.
 * @returns the `attachments` service, or `undefined`.
 */
export function attachmentsOf(ctx) {
	return service(ctx, "attachments");
}
