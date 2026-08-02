/**
 * Persisted expand/collapse state that can express a DEFAULT.
 *
 * The trip page used to store a Set of collapsed ids, where "absent" meant both
 * "the user expanded this" and "the user has never touched this". That is fine
 * while everything defaults to expanded, and impossible to extend once anything
 * should start collapsed: there is nowhere to record "collapsed by default, but
 * this person opened it". Storing the expanded ids instead only inverts the
 * problem onto everything else.
 *
 * So state is a tri-state map: present-and-true = collapsed, present-and-false =
 * expanded, ABSENT = whatever the default for that key is. Callers pass the
 * default at each call site, so changing a default is a one-line change and
 * needs no data migration.
 *
 * Serialised as {v: 2, state: {...}}. The v1 format was a bare array of
 * collapsed ids, which parse() still accepts and upgrades, so existing users
 * keep their folds and no key has to be renamed.
 */

export type CollapseMap = Record<string, boolean>;

interface CollapseEnvelopeV2 {
	v: 2;
	state: CollapseMap;
}

/**
 * Parse stored state, tolerating anything. Junk yields an empty map, which
 * means "no explicit choices" — every key falls back to its default rather than
 * throwing or wedging the page.
 */
export function parseCollapseState(raw: string | null | undefined): CollapseMap {
	if (!raw) return {};
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return {};
	}

	// v1: a bare array of collapsed ids. Each present id was an explicit collapse.
	if (Array.isArray(data)) {
		const out: CollapseMap = {};
		for (const id of data) {
			if (typeof id === 'string' || typeof id === 'number') out[String(id)] = true;
		}
		return out;
	}

	if (data && typeof data === 'object') {
		const envelope = data as Partial<CollapseEnvelopeV2>;
		const state = envelope.state;
		if (state && typeof state === 'object' && !Array.isArray(state)) {
			const out: CollapseMap = {};
			for (const [key, value] of Object.entries(state)) {
				if (typeof value === 'boolean') out[key] = value;
			}
			return out;
		}
	}

	return {};
}

export function serializeCollapseState(map: CollapseMap): string {
	return JSON.stringify({ v: 2, state: map } satisfies CollapseEnvelopeV2);
}

/** Is `key` collapsed, given no explicit choice means `defaultCollapsed`? */
export function isCollapsed(map: CollapseMap, key: string | number, defaultCollapsed = false): boolean {
	const explicit = map[String(key)];
	return explicit === undefined ? defaultCollapsed : explicit;
}

/**
 * Flip `key`, recording the result explicitly.
 *
 * The new value is always written, even when it matches the default: once
 * someone has acted on a row, their choice should survive a later change to
 * that default. Returns a new object so Svelte's reactivity sees the change.
 */
export function toggleCollapse(
	map: CollapseMap,
	key: string | number,
	defaultCollapsed = false
): CollapseMap {
	return { ...map, [String(key)]: !isCollapsed(map, key, defaultCollapsed) };
}

/** Set many keys at once, e.g. an expand-all / collapse-all control. */
export function setCollapsed(
	map: CollapseMap,
	keys: Iterable<string | number>,
	collapsed: boolean
): CollapseMap {
	const out = { ...map };
	for (const key of keys) out[String(key)] = collapsed;
	return out;
}

/** Keys the user explicitly collapsed — the shape the packing print route wants. */
export function collapsedKeys(map: CollapseMap): string[] {
	return Object.entries(map)
		.filter(([, collapsed]) => collapsed)
		.map(([key]) => key);
}
