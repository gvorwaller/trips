<svelte:head><title>Help — trips</title></svelte:head>

<div class="page-head">
	<a class="back" href="/">← All trips</a>
	<h1>How to use trips</h1>
</div>

<div class="card help">
	<h2>Trips &amp; dates</h2>
	<p>
		Create a trip from <strong>New</strong>, give it a name and optional start/end dates. Dates use
		a <strong>calendar picker</strong> — tap the field, then tap a day. There's no free-typing, so a
		date can't be half-entered. Use <strong>Clear</strong> in the calendar to remove a date. Edit or
		duplicate a trip from the buttons at the bottom of its page.
	</p>

	<h2>Places (the itinerary)</h2>
	<p>The <strong>Add</strong> box has a type chooser. Each type behaves differently:</p>
	<ul>
		<li>
			<strong>place</strong> — somewhere you go. Only places appear as map pins and get
			<em>Google / Apple / Directions</em> links and a <em>＋ location</em> control to set coordinates.
		</li>
		<li>
			<strong>day</strong> — a dated header you hang places under. When it has child places it shows
			a <em>“Directions for the day”</em> multi-stop route through them in order.
		</li>
		<li><strong>section</strong> — same as a day but not tied to a date (e.g. “Restaurants”).</li>
		<li><strong>note</strong> — free text; no map or links (but can carry a Reference URL via edit).</li>
	</ul>
	<p>
		Everything you add lands at the top level. Use the row buttons to organise:
		<strong>⇥ indent</strong> tucks a row under the one above it, <strong>⇤ outdent</strong> promotes
		it, <strong>↑ / ↓</strong> reorder, and <strong>✕</strong> deletes. Typical flow: add a
		<em>day</em>, add your <em>place</em> stops, then indent the places under the day.
		<strong>Paste many</strong> adds a batch of places, one per line.
	</p>
	<p>
		<strong>Import itinerary from text</strong> accepts rough notes, AI output, web text, or bullets.
		It extracts candidate places/notes, flags likely duplicates, and lets you review/edit before
		anything is saved. For best organization, choose an existing day or section in
		<strong>Import under</strong>; top-level import is still available.
	</p>

	<h2>Packing</h2>
	<p>
		Add one or more packing lists, then add items. Nest items under a category with
		<strong>⇥ indent</strong> (e.g. socks under “Clothing”). Tick the checkbox to mark something
		packed; the progress bar tracks the list.
	</p>
	<ul>
		<li>
			<strong>Templates</strong> — reusable starter lists. Tap <em>Apply a template</em> to copy its
			items into the current trip, or <em>Save as template</em> (under “Paste many”) to turn a list you've
			built into a reusable one. There's a built-in <em>Essentials</em> starter.
		</li>
		<li>
			<strong>Paste many</strong> — paste multiple item names, one per line; each line becomes an
			item in that list.
		</li>
	</ul>

	<h2>Reservations</h2>
	<p>
		Add reservations (accommodation, flight, restaurant, transport, other) from the
		<strong>Reservations</strong> section. Each reservation can carry a confirmation code, status,
		start/end dates, and free-form notes. Long notes are tucked behind a
		<strong>Show details</strong> toggle so they don't dominate the page.
	</p>
	<p>
		Use the <strong>↑ / ↓</strong> buttons to reorder reservations however you like. The order you
		set is saved and used everywhere (printing, viewer mode).
	</p>

	<h2>Expenses</h2>
	<p>
		Track rough trip costs in the <strong>Expenses</strong> section. Each expense has a date,
		description, amount, and optional category (lodging, food, transport, activities, other).
		The running total is always visible in the section header, even when collapsed.
	</p>
	<p>
		<strong>Extract from text or document</strong> — paste a bank statement or choose an uploaded
		screenshot, and the app will pull out individual transactions for you to review before adding.
		You can deselect items that aren't trip-related and edit categories before saving.
	</p>
	<p>
		You can optionally link an expense to an uploaded document (receipt, confirmation) via the
		"Link document" dropdown.
	</p>

	<h2>Collapsing</h2>
	<p>
		Any row with children shows a <strong>▾ / ▸</strong> caret — tap it to fold or unfold that
		branch. Use <strong>Collapse all / Expand all</strong> to fold a whole list at once. This works
		on both the itinerary and packing lists, and your folded state is remembered on this device.
	</p>
	<p>
		The four main sections (Places, Packing, Reservations, Documents) also collapse — tap the
		section heading to toggle. Section collapse state is remembered per trip on this device.
	</p>

	<h2>Documents</h2>
	<p>
		Attach a PDF or image (up to 30 MB) to a trip. Files are stored privately — opening one streams
		it through the app, so there's no public link. You can give each file a
		<strong>display name</strong> (label) when uploading or via <strong>edit → rename</strong> later.
	</p>
	<p>
		Tap <strong>View</strong> to open a file in an in-app viewer (with a back link to the trip), or
		<strong>Download</strong> to save it to your device.
	</p>

	<h2>Printing</h2>
	<p>
		Use the browser's print function to print the full trip. Each packing list also has a
		<strong>Print packing</strong> button that prints just that list. All collapsed sections and
		branches are automatically expanded for printing.
	</p>

	<h2>Deleting</h2>
	<p>
		Every <strong>✕</strong> and <strong>Delete</strong> asks you to confirm first. Deleting a
		parent (a day, a category, or a whole list) also removes everything nested inside it — the
		confirmation tells you when that's the case.
	</p>

	<h2>Owner vs. viewer</h2>
	<p>
		The <strong>owner</strong> can edit everything. A <strong>viewer</strong> sees a read-only copy
		and can do exactly one thing: check packing items on or off. Manage the viewer account and
		passwords under <strong>Settings</strong>.
	</p>
</div>

<style>
	.help h2 {
		margin: 1.5rem 0 0.4rem;
		font-size: 1.05rem;
	}
	.help h2:first-of-type {
		margin-top: 0;
	}
	.help p {
		margin: 0 0 0.6rem;
		line-height: 1.55;
	}
	.help ul {
		margin: 0 0 0.6rem;
		padding-left: 1.2rem;
		line-height: 1.55;
	}
	.help li {
		margin-bottom: 0.4rem;
	}
</style>
