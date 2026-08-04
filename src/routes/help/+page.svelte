<script lang="ts">
	import { onMount } from 'svelte';

	// Accordion tutorial modeled on the photos app's HelpScreen: one section
	// open at a time, tutorial voice, big features get structured walkthroughs.
	// Kept as a deep-linkable route (not a modal): /help#section-id opens that
	// section, and print shows everything expanded.
	type Section = { id: string; icon: string; title: string };
	const sections: Section[] = [
		{ id: 'getting-started', icon: '🧭', title: 'Getting started' },
		{ id: 'trips', icon: '📅', title: 'Trips & dates' },
		{ id: 'places', icon: '📍', title: 'Places — the itinerary' },
		{ id: 'place-workspace', icon: '🗺️', title: 'The place workspace & Ask AI' },
		{ id: 'day-plans', icon: '🚗', title: 'Day Plans' },
		{ id: 'packing', icon: '🎒', title: 'Packing & templates' },
		{ id: 'sharing', icon: '📤', title: 'Sharing & export' },
		{ id: 'records', icon: '🧾', title: 'Reservations, Documents & Expenses' },
		{ id: 'printing', icon: '🖨️', title: 'Printing' },
		{ id: 'accounts', icon: '👥', title: 'Accounts & roles' }
	];

	let openSection = $state<string | null>('getting-started');

	function toggle(id: string) {
		openSection = openSection === id ? null : id;
		if (openSection) history.replaceState(null, '', `#${openSection}`);
		else history.replaceState(null, '', location.pathname);
	}

	onMount(() => {
		const hash = location.hash.slice(1);
		if (hash && sections.some((s) => s.id === hash)) {
			openSection = hash;
			document.getElementById(hash)?.scrollIntoView();
		}
	});
</script>

<svelte:head><title>Help — trips</title></svelte:head>

<div class="page-head">
	<a class="back" href="/">← All trips</a>
	<h1>How to use trips</h1>
</div>

<div class="card help">
	<p class="intro">
		Welcome! This app is a lightweight reference for planning and running a trip — places to go,
		day-by-day driving plans, packing lists, reservations, documents, and costs. If you're new,
		start with <strong>Getting started</strong> below; every other section is a deeper dive into one part
		of the app. Tap a heading to open it.
	</p>

	{#each sections as s (s.id)}
		<section id={s.id} class="help-section">
			<button
				class="section-toggle"
				class:open={openSection === s.id}
				aria-expanded={openSection === s.id}
				aria-controls="body-{s.id}"
				onclick={() => toggle(s.id)}
			>
				<span class="section-icon" aria-hidden="true">{s.icon}</span>
				<span class="section-title">{s.title}</span>
				<span class="chevron" aria-hidden="true">{openSection === s.id ? '▾' : '▸'}</span>
			</button>

			<div id="body-{s.id}" class="section-body" class:open={openSection === s.id}>
				{#if s.id === 'getting-started'}
					<p>Here's the whole flow, from nothing to a printable trip:</p>
					<ol>
						<li>
							<strong>Create a trip.</strong> Tap <strong>＋ New trip</strong>, give it a name, and
							(optionally) start/end dates.
						</li>
						<li>
							<strong>Add a day.</strong> In <strong>Places</strong>, the Add box has a type chooser
							— pick <em>day</em> and give it a date. Days are the headers you hang everything else on.
						</li>
						<li>
							<strong>Add places.</strong> Switch the type to <em>place</em> and add your stops. Everything
							lands at the top level at first.
						</li>
						<li>
							<strong>Nest places under the day.</strong> Tap <strong>⇥ indent</strong> on a place
							to tuck it under the row above; <strong>↑ / ↓</strong> reorder rows.
						</li>
						<li>
							<strong>Set locations.</strong> Tap <strong>＋ location</strong> on a place to search
							Google Maps and drop a pin. Once set, the link becomes
							<strong>📍 location</strong> and the place shows up on the trip map with
							<em>Google / Apple / Directions</em> links.
						</li>
						<li>
							<strong>Build a packing list.</strong> In <strong>Packing</strong>, add a list, apply
							the built-in <em>Essentials</em> template, and check things off as you pack.
						</li>
					</ol>
					<p>
						From there, explore <strong>Day Plans</strong> (ordered driving routes through your
						places) and the <strong>place workspace</strong> (hours, ratings, and AI answers about a place)
						— both have their own sections below.
					</p>
				{:else if s.id === 'trips'}
					<p>
						Create a trip from <strong>＋ New trip</strong>, with a name and optional start/end
						dates. Dates use a <strong>calendar picker</strong> — tap the field, then tap a day.
						There's no free-typing, so a date can't be half-entered. Use <strong>Clear</strong> in the
						calendar to remove a date.
					</p>
					<p>
						<strong>Edit</strong> and <strong>Duplicate</strong> live at the bottom of the trip page.
						Duplicating copies the whole trip — places, packing, reservations, documents — with checked/visited
						state reset, so a repeat trip starts fresh.
					</p>
					<p>
						When a trip is over, <strong>Archive</strong> it (next to Edit and Duplicate). Archived
						trips move out of the main list into a collapsed <strong>Archived</strong> section, but stay
						fully readable, editable, and searchable — they're for future reference, not deleted.
						<strong>Unarchive</strong> brings one back any time.
					</p>
					<p>
						The trips list shows each trip's dates and when it was last touched. Use
						<strong>Search</strong> in the top bar to find anything — trips, places, packing items, reservations
						— by name (results from archived trips carry an <em>archived</em> badge).
					</p>
				{:else if s.id === 'places'}
					<p>The <strong>Add</strong> box has a type chooser. Each type behaves differently:</p>
					<ul>
						<li>
							<strong>place</strong> — somewhere you go. Only places appear as map pins and get
							<em>Google / Apple / Directions</em> links and the location control.
						</li>
						<li>
							<strong>day</strong> — a dated header you hang places under. With child places it
							offers a <em>Route this group</em> multi-stop route through them in order.
						</li>
						<li><strong>section</strong> — like a day but undated (e.g. “Restaurants”).</li>
						<li><strong>note</strong> — free text; no map or links (can carry a Reference URL).</li>
					</ul>
					<p>
						Organise with the row buttons: <strong>⇥ indent</strong> tucks a row under the one
						above, <strong>⇤ outdent</strong> promotes it, <strong>↑ / ↓</strong> reorder,
						<strong>✕</strong> deletes (always with a confirmation — deleting a parent removes everything
						nested inside, and the dialog says so).
					</p>
					<h4>Faster ways to add many places</h4>
					<ul>
						<li>
							<strong>Paste many</strong> — a batch of places, one per line.
						</li>
						<li>
							<strong>Import itinerary from text</strong> — paste rough notes, AI output, or web
							text. It extracts candidate places/notes, flags likely duplicates, and lets you review
							before anything is saved. Choose a day/section in
							<strong>Import under</strong> to land them organised.
						</li>
						<li>
							<strong>Import from Maps link</strong> — paste a Google Maps or Apple Maps link to pull
							in the place with its coordinates.
						</li>
						<li>
							<strong>Import from photo</strong> — drop or paste a screenshot (e.g. of a list or map)
							and the app extracts the places it can read.
						</li>
						<li>
							<strong>Import from Birds</strong> — pull the stops from a birding trip in the Birds
							app. After fetching, a <strong>trip dropdown</strong> lets you import one trip's places
							at a time instead of unchecking a long combined list.
						</li>
					</ul>
					<h4>Checking places off</h4>
					<p>
						Every place row has a <strong>visited checkbox</strong> — tick it when you've been. The
						Places heading shows a running <em>“X / Y visited”</em> count, and checking a place
						anywhere (the tree, its workspace page, or a day-plan stop) updates every copy — they can
						never disagree.
					</p>
					<h4>Dates on places</h4>
					<p>
						A place can carry an optional <strong>date</strong> — set it when adding (there's a date
						field in the Add box and in Paste many), or later from the row's edit form. Dated places
						appear on the trip's <strong>📅 Schedule</strong> page (button next to the Places heading),
						a day-by-day view of everything you've pinned to a date.
					</p>
					<h4>Folding</h4>
					<p>
						Any row with children shows a <strong>▾ / ▸</strong> caret — tap to fold that branch;
						<strong>Collapse all / Expand all</strong> folds the whole list. The main trip sections (Day
						Plans, Places, Packing, …) also collapse by tapping their headings. Folded state is remembered
						per trip on this device.
					</p>
				{:else if s.id === 'place-workspace'}
					<p>
						Tap <strong>📍 location</strong> (or <strong>＋ location</strong>) on any place to open
						its workspace — a full page for everything about that one place.
					</p>
					<h4>Setting or fixing the pin</h4>
					<p>
						Search by name or tap the map to set coordinates. If a place has a pin but no Google
						listing yet (say, it came from an Apple Maps import), the page suggests the closest
						Google match by name — check it and tap <strong>Link this match</strong> to confirm. Nothing
						links without your say-so.
					</p>
					<h4>Known Details</h4>
					<p>
						Once a place is linked to a Google listing, the workspace shows its
						<strong>Known Details</strong>: address, phone, website, rating, opening-hours schedule,
						and (when Google provides one) a short AI-generated summary with attribution. Details
						are cached for the day; <strong>Refresh details</strong> re-fetches them on demand and tells
						you plainly if the refresh failed.
					</p>
					<h4>Ask AI About This Place</h4>
					<p>
						Ask a free-form question — “is this worth two hours?”, “any parking tips?” — and get an
						answer grounded in the known details above. The AI is deliberately cautious: it won't
						invent hours, prices, tickets, or schedules, and it says so when something needs
						checking against an official source. Treat it as a well-read friend, not a booking
						system.
					</p>
				{:else if s.id === 'day-plans'}
					<p>
						A <strong>Day Plan</strong> is an ordered driving route through places already in your
						itinerary — without moving or duplicating them. Build one from scratch in the Day Plans
						section, or tap <strong>Day plan</strong> on a day/section to start from its places.
					</p>
					<p>
						Saved plans start <strong>collapsed</strong>, so the section reads as an index of your days
						— each folded card still shows its date, weather, and driving total. Tap
						<strong>▸ Stops</strong> to open one; the app remembers which plans you keep open, per trip.
						The <strong>mi / km</strong> toggle in the section header switches units everywhere,
						including exports.
					</p>
					<p>Each saved plan keeps ordered stops, per-stop notes, and visited checkboxes, plus:</p>
					<ul>
						<li>
							<strong>Anchor</strong> — pick your lodging (or any place) as the start/end point for
							routing. An anchored day is a <em>closed loop</em>: the total includes the drive home,
							shown as its own row after the last stop.
						</li>
						<li>
							<strong>Calculate distances</strong> — driving time and miles for each leg, computed
							server-side through Google's routing.
						</li>
						<li><strong>Optimize order</strong> — sorts stops into the shortest driving loop.</li>
						<li>
							<strong>Duplicate</strong> — copy a plan (visited flags reset) to try a different order
							or reuse a day.
						</li>
						<li>
							<strong>Open directions</strong> — the full multi-stop route in Google Maps, with
							individual <em>Leg</em> links per segment.
						</li>
						<li>
							<strong>Get visit notes</strong> and <strong>Suggest stops</strong> — AI tips per stop,
							and nearby-place suggestions you can add with one tap.
						</li>
						<li>Weather per stop (US only) when the plan has a date.</li>
					</ul>
					<p>
						The Day Plans section on the trip page has step-by-step walkthroughs behind
						<em>How to…</em> toggles right where you build them.
					</p>
				{:else if s.id === 'packing'}
					<p>
						Add one or more packing lists, then add items. Nest items under a category with
						<strong>⇥ indent</strong> (socks under “Clothing”). Tick the checkbox to mark something packed
						— checking a category checks everything inside it — and the progress bar tracks the list.
					</p>
					<ul>
						<li>
							<strong>Templates</strong> — reusable starter lists. <em>Apply a template</em>
							copies its items into the trip; <em>Save as template</em> turns a list you've built
							into a reusable one. There's a built-in <em>Essentials</em> starter.
						</li>
						<li><strong>Paste many</strong> — one item per line, added to that list.</li>
						<li>
							<strong>Print packing</strong> — prints just that list (see Printing below).
						</li>
					</ul>
				{:else if s.id === 'records'}
					<h4>Reservations</h4>
					<p>
						Track accommodation, flights, restaurants, transport, and other bookings — each with a
						confirmation code, status, dates, and notes (long notes tuck behind
						<strong>Show details</strong>). Reorder with <strong>↑ / ↓</strong>; your order is used
						everywhere, including print.
						<strong>Auto-fill from a confirmation</strong> — paste a confirmation email and review the
						extracted fields before saving.
					</p>
					<h4>Documents</h4>
					<p>
						Attach PDFs or images (up to 30 MB). Files are private — opening one streams it through
						the app; there's no public link. Give files a display name when uploading, or rename
						later. <strong>View</strong> opens in-app; <strong>Download</strong> saves to your device.
					</p>
					<h4>Expenses</h4>
					<p>
						Rough trip costs with date, description, amount, and category. The running total sits in
						the section header even when collapsed.
						<strong>Extract from text or document</strong> pulls transactions out of a pasted bank
						statement or an uploaded screenshot for review — deselect the non-trip lines before
						saving. An expense can link to an uploaded receipt via
						<strong>Link document</strong>.
					</p>
				{:else if s.id === 'sharing'}
					<p>
						Everything here is built for the way trips actually get shared: pasted into Messages from
						a phone.
					</p>
					<h4>Share a whole trip</h4>
					<p>
						<strong>Share text</strong> at the top of the trip page opens a plain-text version of the
						trip — places (with their map links), day plans, reservations, and packing lists — ready to
						select-all and paste. Add <code>?format=md</code> for a Markdown download instead. Expenses
						and attached files are deliberately left out (the export says so at the bottom), so a
						shared sheet never leaks costs or documents.
					</p>
					<h4>Share one day</h4>
					<p>Each day-plan card has three share controls:</p>
					<ul>
						<li>
							<strong>Share text</strong> — the day as plain text with tappable Apple/Google links per
							stop, the drive legs, and (when the route fits in one link) a whole-route Google Maps URL.
						</li>
						<li>
							<strong>🖨 Print / PDF</strong> — a clean print page for the day; use the browser's
							“Save as PDF” for a file with clickable links.
						</li>
						<li>
							<strong>Calendar</strong> — download an <code>.ics</code> that adds the day as an
							all-day event with the stops in its description (shown only when the plan has a date).
						</li>
					</ul>
					<p>
						Viewers can use every share control too — sharing is reading. AI visit notes stay out of
						exports unless you add <code>&amp;ai=1</code> to the link; they're long.
					</p>
				{:else if s.id === 'printing'}
					<p>
						Print the whole trip with the browser's print function — collapsed sections and folded
						branches expand automatically, so the paper copy is always complete. Each packing list
						also has its own <strong>Print packing</strong> button. (This help page prints fully expanded
						too.)
					</p>
				{:else if s.id === 'accounts'}
					<p>There are three kinds of account:</p>
					<ul>
						<li>
							<strong>admin</strong> — a full account with its own trips, plus user management in Settings.
						</li>
						<li><strong>user</strong> — a full account with its own trips. No user management.</li>
						<li>
							<strong>viewer</strong> — a read-only window into <em>one chosen account's</em>
							trips. Viewers can still check off packing items and mark day-plan stops visited — so a
							couple can pack and travel together — but can't edit anything else.
						</li>
					</ul>
					<p>
						Every admin and user account is fully separate: your trips, packing templates, and
						documents are yours alone and never appear in anyone else's account.
					</p>
					<p>
						Admins manage accounts under <strong>Settings → Users</strong>: create accounts, choose
						which account a new viewer views, and reset passwords (a reset signs that person out
						everywhere). Everyone else manages their own display name and password in Settings.
					</p>
				{/if}
			</div>
		</section>
	{/each}
</div>

<style>
	.help .intro {
		margin: 0 0 1rem;
		line-height: 1.55;
	}
	.help-section {
		border-top: 1px solid var(--border);
	}
	.section-toggle {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		min-height: 48px;
		padding: 0.65rem 0.25rem;
		background: none;
		border: none;
		cursor: pointer;
		font: inherit;
		font-size: 1.02rem;
		font-weight: 600;
		color: inherit;
		text-align: left;
	}
	.section-toggle:hover .section-title,
	.section-toggle.open .section-title {
		color: var(--accent);
	}
	.section-icon {
		flex: none;
	}
	.section-title {
		flex: 1;
	}
	.chevron {
		flex: none;
		color: var(--muted);
	}
	.section-body {
		display: none;
		padding: 0 0.25rem 1rem;
	}
	.section-body.open {
		display: block;
	}
	.section-body p {
		margin: 0 0 0.6rem;
		line-height: 1.55;
	}
	.section-body ul,
	.section-body ol {
		margin: 0 0 0.6rem;
		padding-left: 1.2rem;
		line-height: 1.55;
	}
	.section-body li {
		margin-bottom: 0.4rem;
	}
	.section-body h4 {
		margin: 0.9rem 0 0.35rem;
		font-size: 0.98rem;
	}

	@media print {
		/* The paper copy is always complete: every section expanded, no chrome. */
		.section-body {
			display: block;
		}
		.section-toggle {
			min-height: 0;
			padding: 0.4rem 0;
		}
		.chevron {
			display: none;
		}
	}
</style>
