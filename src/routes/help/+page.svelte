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

	<h2>Collapsing branches</h2>
	<p>
		Any row with children shows a <strong>▾ / ▸</strong> caret — tap it to fold or unfold that
		branch. Use <strong>Collapse all / Expand all</strong> to fold a whole list at once. This works
		on both the itinerary and packing lists, and your folded state is remembered on this device.
	</p>

	<h2>Documents</h2>
	<p>
		Attach a PDF or image (up to 30 MB) to a trip. Files are stored privately — opening one streams
		it through the app, so there's no public link.
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
