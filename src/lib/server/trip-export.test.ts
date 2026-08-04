import { describe, expect, it } from 'vitest';
import { buildTripText, tripFilename, type TripExportData } from './trip-export';
import { buildDayPlanText } from '$lib/dayplan-export';

function fixture(): TripExportData {
	return {
		trip: {
			id: 10,
			name: 'Maine 2026',
			start_date: '2026-07-27',
			end_date: '2026-08-07',
			notes: 'Anniversary trip to Blue Hill ME'
		},
		places: [
			{
				id: 1,
				parent_id: null,
				sort_order: 0,
				item_type: 'section',
				title: 'Blue Hill',
				notes: null,
				date: null,
				lat: null,
				lon: null,
				place_id: null,
				apple_maps_place_id: null,
				visited: false
			},
			{
				id: 2,
				parent_id: 1,
				sort_order: 0,
				item_type: 'place',
				title: 'Blue Hill Farmers Market',
				notes: 'Saturday only',
				date: '2026-08-01',
				lat: 44.41,
				lon: -68.59,
				place_id: 'pl-market',
				apple_maps_place_id: null,
				visited: true
			},
			{
				id: 3,
				parent_id: 1,
				sort_order: 1,
				item_type: 'place',
				title: 'Seal Cove',
				notes: null,
				date: null,
				lat: 44.3,
				lon: -68.3,
				place_id: null,
				apple_maps_place_id: null,
				visited: false
			}
		],
		plans: [
			{
				plan: {
					id: 36,
					title: 'Seal Cove day',
					notes: null,
					optional_date: '2026-07-29',
					anchor_title: 'Stay: Summit Sanctuary',
					anchor_lat: 44.41,
					anchor_lon: -68.58,
					return_drive_km: 62.7,
					return_drive_min: 61,
					updated_at: '2026-07-29T12:00:00Z'
				},
				stops: [
					{
						snapshot_title: 'Seal Cove',
						snapshot_lat: 44.3,
						snapshot_lon: -68.3,
						snapshot_place_id: null,
						notes: 'Low tide best',
						ai_notes: 'A very long AI paragraph.',
						visited: false,
						drive_km: 57.8,
						drive_min: 52
					}
				]
			}
		],
		reservations: [
			{
				reservation_type: 'accommodation',
				title: 'Summit Sanctuary',
				confirmation_code: 'ABC123',
				status: 'confirmed',
				start_at: '2026-07-27T15:00',
				end_at: '2026-08-07T11:00',
				notes: null
			}
		],
		packing: [
			{
				name: 'Essentials',
				items: [
					{
						id: 1,
						parent_id: null,
						sort_order: 0,
						name: 'Optics',
						quantity: 1,
						notes: null,
						checked: false
					},
					{
						id: 2,
						parent_id: 1,
						sort_order: 0,
						name: 'Binoculars',
						quantity: 2,
						notes: 'in the car case',
						checked: true
					}
				]
			}
		],
		attachmentCount: 3
	};
}

describe('buildTripText', () => {
	it('renders every included section in order with nesting and states', () => {
		const text = buildTripText(fixture());
		// Header before places, places before plans, plans before reservations,
		// reservations before packing, omissions footer last.
		const order = [
			'Maine 2026',
			'Dates: 2026-07-27 to 2026-08-07',
			'Places',
			'Blue Hill',
			'[x] Blue Hill Farmers Market (2026-08-01)',
			'Seal Cove day',
			'Reservations',
			'Summit Sanctuary (accommodation)',
			'Packing — Essentials',
			'[ ] Optics',
			'[x] Binoculars ×2',
			'Not included: expenses, 3 attached files.'
		];
		let at = -1;
		for (const marker of order) {
			const next = text.indexOf(marker, at + 1);
			expect(next, `expected "${marker}" after position ${at}`).toBeGreaterThan(at);
			at = next;
		}
		// Nesting: the child place is indented under its section, and the
		// packing child under its parent.
		expect(text).toContain('\n  [x] Blue Hill Farmers Market');
		expect(text).toContain('\n  [x] Binoculars ×2');
		// Places carry both map links, bare, for Messages linkification.
		expect(text).toMatch(/Apple: https:\/\/maps\.apple\.com/);
		expect(text).toMatch(/Google: https:\/\/www\.google\.com\/maps/);
	});

	it('embeds each day plan byte-identically to the standalone day export at depth 2', () => {
		const data = fixture();
		const text = buildTripText(data, { markdown: true });
		const standalone = buildDayPlanText(data.trip, data.plans[0].plan, data.plans[0].stops, {
			markdown: true,
			headingDepth: 2
		}).trimEnd();
		expect(text).toContain(standalone);
	});

	it('states the omissions in the footer', () => {
		// The builder cannot leak expenses structurally — it never receives
		// them. A blanket "$"/"amount" regex here was semantically too broad
		// (legitimate notes contain dollar amounts; peer CODEX): the real
		// leak guard is the isolation dbtest asserting the MARK expense is
		// absent from the actual route output over real fixture rows.
		const text = buildTripText(fixture());
		expect(text).toContain('Not included: expenses, 3 attached files.');
	});

	it('omits the attachment mention when there are none, keeps the expenses one', () => {
		const data = fixture();
		data.attachmentCount = 0;
		expect(buildTripText(data)).toContain('Not included: expenses.');
	});

	it('keeps AI notes out unless opted in, in both formats', () => {
		const data = fixture();
		expect(buildTripText(data)).not.toContain('A very long AI paragraph.');
		expect(buildTripText(data, { markdown: true })).not.toContain('A very long AI paragraph.');
		expect(buildTripText(data, { aiNotes: true })).toContain('A very long AI paragraph.');
	});

	it('markdown mode adds heading markers; text mode has none', () => {
		const data = fixture();
		const md = buildTripText(data, { markdown: true });
		expect(md).toContain('# Maine 2026');
		expect(md).toContain('## Places');
		expect(md).toContain('## Seal Cove day');
		const txt = buildTripText(data);
		expect(txt).not.toContain('# ');
	});

	it('markdown emits REAL nested list items with continuation indentation', () => {
		const md = buildTripText(fixture(), { markdown: true });
		// Sections and places are list items; a depth-1 place nests under its
		// parent with 2-space list indentation (CommonMark nesting, not
		// paragraph soft-breaks).
		expect(md).toContain('\n- Blue Hill\n');
		expect(md).toContain('\n  - [x] Blue Hill Farmers Market (2026-08-01)');
		// Continuation lines (notes/links) are indented to the item's content
		// column — 4 spaces for the depth-1 place — and therefore belong to
		// the list item rather than opening a code block.
		expect(md).toContain('\n    Saturday only');
		expect(md).toMatch(/\n {4}Apple: https:/);
		// Packing is a real task list.
		expect(md).toContain('\n- [ ] Optics');
		expect(md).toContain('\n  - [x] Binoculars ×2');
	});

	it('multiline notes cannot forge structure in either format — including EMBEDDED plan/stop notes and trip notes', () => {
		const data = fixture();
		const evil = 'first line\n# fake heading\n- [x] fake done item\nNot included: nothing';
		data.places[1].notes = evil;
		data.trip.notes = evil;
		data.plans[0].plan.notes = evil;
		data.plans[0].stops[0].notes = evil;
		const md = buildTripText(data, { markdown: true });
		// Every note line carries the node's indentation; structural leaders
		// are backslash-escaped in Markdown.
		expect(md).not.toMatch(/\n# fake heading/);
		expect(md).not.toMatch(/\n- \[x\] fake done item/);
		expect(md).toContain('\n    \\# fake heading');
		expect(md).toContain('\n    \\- [x] fake done item');
		const txt = buildTripText(data);
		// In text, no note line lands at column 0 where it could impersonate
		// a section or the omissions footer.
		expect(txt).not.toMatch(/\nNot included: nothing/);
		expect(txt).toContain('\n    Not included: nothing');
		// The REAL footer is still the last line.
		expect(txt.trimEnd().endsWith('Not included: expenses, 3 attached files.')).toBe(true);
	});

	it('skips empty sections entirely', () => {
		const data = fixture();
		data.places = [];
		data.reservations = [];
		data.packing = [{ name: 'Empty list', items: [] }];
		const text = buildTripText(data);
		expect(text).not.toContain('Places');
		expect(text).not.toContain('Reservations');
		expect(text).not.toContain('Packing');
	});

	it('propagates units into the embedded day plans', () => {
		const km = buildTripText(fixture(), { unit: 'km' });
		expect(km).toMatch(/\d+ km/);
	});
});

describe('tripFilename', () => {
	it('slugifies and falls back', () => {
		expect(tripFilename({ name: 'Maine 2026' }, 'md')).toBe('maine-2026.md');
		expect(tripFilename({ name: '???' }, 'txt')).toBe('trip.txt');
	});
});
