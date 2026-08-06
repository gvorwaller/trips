<script lang="ts">
	import { onDestroy } from 'svelte';

	type Option = {
		value: string;
		label: string;
		searchText?: string;
		/** Shown but not selectable — e.g. a place already added to the plan. */
		disabled?: boolean;
	};

	let {
		name,
		options,
		selectedValue = $bindable(''),
		ariaLabel = 'Select an option',
		placeholder = 'Search',
		emptyMessage = 'No matches',
		maxResults = 50,
		listboxId,
		onSelect,
		clearOnEdit = true
	}: {
		name: string;
		options: Option[];
		selectedValue?: string;
		ariaLabel?: string;
		placeholder?: string;
		emptyMessage?: string;
		maxResults?: number;
		listboxId?: string;
		/**
		 * Notified on every pick. Use instead of `bind:selectedValue` when the
		 * parent's value can be undefined (e.g. a keyed record entry) — binding
		 * undefined to a prop that has a fallback throws in runes mode.
		 */
		onSelect?: (value: string) => void;
		/**
		 * When true (default), editing away from the committed label drops the
		 * selection — right for "stage an item" pickers where empty must mean
		 * nothing staged. Set false for pickers whose value is already
		 * persisted elsewhere (e.g. a saved route anchor): typing then only
		 * filters, the committed selection survives, and Escape/blur restore
		 * its label instead of a blank box.
		 */
		clearOnEdit?: boolean;
	} = $props();

	let query = $state('');
	let open = $state(false);
	// The input shows the current selection's label when closed. That label must
	// not act as a filter when the list opens, or focusing shows only the item
	// already selected. Filter on `query` only once the user actually types.
	let typed = $state(false);
	let activeIndex = $state(0);
	let closeTimer: ReturnType<typeof setTimeout> | null = null;

	const selectedLabel = $derived(
		options.find((option) => option.value === selectedValue)?.label ?? ''
	);
	const controlsId = $derived(listboxId ?? `${name}-options`);
	const normalized = (value: string) => value.trim().toLowerCase();
	const matched = $derived.by(() => {
		const q = typed ? normalized(query) : '';
		if (!q) return options;
		return options.filter((option) =>
			normalized(`${option.label} ${option.searchText ?? ''}`).includes(q)
		);
	});
	const filtered = $derived(matched.slice(0, maxResults));
	const hiddenCount = $derived(matched.length - filtered.length);

	/**
	 * First selectable row, so the highlight never starts on a disabled one.
	 * Returns -1 when every row is disabled — no row is highlighted, rather than
	 * marking one active that Enter could never select.
	 */
	function firstEnabled() {
		return filtered.findIndex((option) => !option.disabled);
	}

	/** Move the highlight by one, skipping disabled rows; stay put at the ends. */
	function stepActive(direction: 1 | -1) {
		let index = activeIndex;
		for (let n = 0; n < filtered.length; n++) {
			index += direction;
			if (index < 0 || index >= filtered.length) return activeIndex;
			if (!filtered[index].disabled) return index;
		}
		return activeIndex;
	}

	$effect(() => {
		if (!open) query = selectedLabel;
	});

	function clearCloseTimer() {
		if (closeTimer) clearTimeout(closeTimer);
		closeTimer = null;
	}

	// The blur timer reads `selectedLabel`. If the component is torn down first
	// — e.g. the enhanced add-stop submit re-renders the day plan card — that
	// callback would read a derived belonging to a destroyed effect.
	onDestroy(clearCloseTimer);

	function choose(option: Option) {
		if (option.disabled) return;
		selectedValue = option.value;
		query = option.label;
		open = false;
		typed = false;
		activeIndex = 0;
		onSelect?.(option.value);
	}

	/**
	 * Opens the list. Wired to focus AND pointerdown/click: clicking an input
	 * that already has focus fires no focus event, so onfocus alone can leave
	 * the list shut. Also reopens it after Escape.
	 */
	function openList() {
		clearCloseTimer();
		open = true;
		typed = false;
		// Pre-highlight the first selectable row so Enter picks the obvious
		// match straight away. firstEnabled() yields -1 when every row is
		// disabled, which leaves nothing highlighted.
		activeIndex = firstEnabled();
	}

	function closeList() {
		closeTimer = setTimeout(() => {
			open = false;
			typed = false;
			query = selectedLabel;
		}, 120);
	}

	function onInput(event: Event) {
		query = (event.currentTarget as HTMLInputElement).value;
		open = true;
		typed = true;
		activeIndex = firstEnabled();
		// Editing away from the committed label drops the selection. Without
		// this, clearing the box leaves the old value in the hidden input and a
		// place the user thought they had removed still gets submitted.
		// (Skipped in clearOnEdit=false mode, where typing is filter-only.)
		if (clearOnEdit && selectedValue && query !== selectedLabel) {
			selectedValue = '';
			onSelect?.('');
		}
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			open = true;
			activeIndex = stepActive(1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			open = true;
			activeIndex = stepActive(-1);
		} else if (event.key === 'Enter' && open && filtered[activeIndex]) {
			event.preventDefault();
			choose(filtered[activeIndex]);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			open = false;
			typed = false;
			query = selectedLabel;
		}
	}
</script>

<div class="searchable-select">
	<input type="hidden" {name} value={selectedValue} />
	<input
		type="text"
		role="combobox"
		aria-label={ariaLabel}
		aria-controls={controlsId}
		aria-expanded={open}
		aria-autocomplete="list"
		autocomplete="off"
		spellcheck="false"
		{placeholder}
		value={query}
		onfocus={(event) => {
			openList();
			(event.currentTarget as HTMLInputElement).select();
		}}
		onpointerdown={openList}
		onclick={openList}
		onblur={closeList}
		oninput={onInput}
		onkeydown={onKeydown}
	/>
	{#if open}
		<div
			id={controlsId}
			class="options"
			role="listbox"
			tabindex="-1"
			onmousedown={(event) => event.preventDefault()}
		>
			{#if filtered.length === 0}
				<div class="empty">{emptyMessage}</div>
			{:else}
				{#each filtered as option, index (option.value)}
					<button
						type="button"
						role="option"
						aria-selected={option.value === selectedValue}
						aria-disabled={option.disabled ? 'true' : undefined}
						disabled={option.disabled}
						class:active={index === activeIndex}
						onclick={() => choose(option)}
					>
						{option.label}
					</button>
				{/each}
				{#if hiddenCount > 0}
					<div class="empty">{hiddenCount} more — keep typing to narrow</div>
				{/if}
			{/if}
		</div>
	{/if}
</div>

<style>
	.searchable-select {
		position: relative;
		width: 100%;
	}
	input[type='text'] {
		width: 100%;
		box-sizing: border-box;
		font-size: 1rem;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
		color: var(--text);
		background: var(--card);
	}
	.options {
		position: absolute;
		z-index: 20;
		top: calc(100% + 4px);
		left: 0;
		right: 0;
		max-height: min(320px, 60vh);
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--card);
		box-shadow: 0 10px 28px rgb(0 0 0 / 0.14);
	}
	.options button,
	.empty {
		display: block;
		width: 100%;
		padding: 8px 10px;
		border: 0;
		border-radius: 0;
		text-align: left;
		font: inherit;
		color: var(--text);
		background: transparent;
	}
	.options button:hover,
	.options button.active,
	.options button[aria-selected='true'] {
		background: var(--accent-soft);
	}
	.options button:disabled {
		color: var(--muted);
		cursor: default;
		background: transparent;
	}
	.empty {
		color: var(--muted);
	}
</style>
