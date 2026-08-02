import { describe, expect, it } from 'vitest';
import {
	collapsedKeys,
	isCollapsed,
	parseCollapseState,
	serializeCollapseState,
	setCollapsed,
	toggleCollapse
} from './collapse-state';

describe('the default is expressible — the whole point of the format', () => {
	it('falls back to the default when there is no explicit choice', () => {
		expect(isCollapsed({}, 'dayplans', true)).toBe(true);
		expect(isCollapsed({}, 'places', false)).toBe(false);
	});

	it('lets an explicit choice override a default in BOTH directions', () => {
		// The old Set-of-collapsed-ids format could represent the first of these
		// and not the second; that limitation is why this module exists.
		expect(isCollapsed({ a: false }, 'a', true)).toBe(false);
		expect(isCollapsed({ a: true }, 'a', false)).toBe(true);
	});

	it('accepts numeric keys, since plan and item ids are numbers', () => {
		expect(isCollapsed({ '42': false }, 42, true)).toBe(false);
	});
});

describe('toggleCollapse', () => {
	it('records an expansion against a collapsed default', () => {
		expect(toggleCollapse({}, 'p1', true)).toEqual({ p1: false });
	});

	it('records a collapse against an expanded default', () => {
		expect(toggleCollapse({}, 'p1', false)).toEqual({ p1: true });
	});

	it('writes the value even when it equals the default, so the choice outlives a default change', () => {
		const map = toggleCollapse({ p1: false }, 'p1', true);
		expect(map).toEqual({ p1: true });
		expect(Object.hasOwn(map, 'p1')).toBe(true);
	});

	it('returns a new object rather than mutating', () => {
		const before = { p1: true };
		const after = toggleCollapse(before, 'p1', false);
		expect(before).toEqual({ p1: true });
		expect(after).not.toBe(before);
	});

	it('round-trips back to the start', () => {
		const once = toggleCollapse({}, 'p1', true);
		expect(isCollapsed(toggleCollapse(once, 'p1', true), 'p1', true)).toBe(true);
	});
});

describe('parseCollapseState', () => {
	it('reads the v2 envelope', () => {
		expect(parseCollapseState('{"v":2,"state":{"a":true,"b":false}}')).toEqual({
			a: true,
			b: false
		});
	});

	it('upgrades the legacy bare array, treating each id as an explicit collapse', () => {
		// Existing users have this in localStorage right now; losing their folds
		// on upgrade would be a silent regression.
		expect(parseCollapseState('[1,2,"dayplans"]')).toEqual({
			'1': true,
			'2': true,
			dayplans: true
		});
	});

	it('treats an empty legacy array as no explicit choices, not as all-expanded', () => {
		// The distinction matters: with an empty map, a collapsed-by-default key
		// starts collapsed. If [] meant "everything expanded", the new default
		// would never apply to anyone who had ever loaded the page.
		expect(parseCollapseState('[]')).toEqual({});
		expect(isCollapsed(parseCollapseState('[]'), 'dayplans', true)).toBe(true);
	});

	it('returns an empty map for null, empty, junk or malformed JSON', () => {
		for (const raw of [null, undefined, '', 'not json', '{', '3', 'true', '"x"']) {
			expect(parseCollapseState(raw)).toEqual({});
		}
	});

	it('ignores non-boolean values inside a v2 envelope', () => {
		expect(parseCollapseState('{"v":2,"state":{"a":true,"b":"yes","c":null}}')).toEqual({
			a: true
		});
	});

	it('ignores a v2 envelope whose state is the wrong shape', () => {
		expect(parseCollapseState('{"v":2,"state":[1,2]}')).toEqual({});
		expect(parseCollapseState('{"v":2}')).toEqual({});
	});
});

describe('serialize round-trip', () => {
	it('survives a write and read', () => {
		const map = { dayplans: false, '12': true };
		expect(parseCollapseState(serializeCollapseState(map))).toEqual(map);
	});

	it('preserves an explicit false, which the legacy format could not', () => {
		expect(parseCollapseState(serializeCollapseState({ a: false }))).toEqual({ a: false });
	});

	it('tags the version so a future format can be told apart', () => {
		expect(JSON.parse(serializeCollapseState({}))).toEqual({ v: 2, state: {} });
	});
});

describe('bulk helpers', () => {
	it('collapses many keys at once', () => {
		expect(setCollapsed({}, [1, 2, 3], true)).toEqual({ '1': true, '2': true, '3': true });
	});

	it('expands many keys at once, overriding a collapsed default', () => {
		const map = setCollapsed({ '1': true }, [1, 2], false);
		expect(isCollapsed(map, 1, true)).toBe(false);
		expect(isCollapsed(map, 2, true)).toBe(false);
	});

	it('leaves untouched keys alone', () => {
		expect(setCollapsed({ keep: true }, ['a'], false)).toEqual({ keep: true, a: false });
	});

	it('lists only the explicitly collapsed keys', () => {
		expect(collapsedKeys({ a: true, b: false, c: true }).sort()).toEqual(['a', 'c']);
	});

	it('lists nothing when everything is merely defaulted', () => {
		expect(collapsedKeys({})).toEqual([]);
	});
});
