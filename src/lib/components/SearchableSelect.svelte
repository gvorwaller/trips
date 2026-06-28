<script lang="ts">
	type Option = {
		value: string;
		label: string;
		searchText?: string;
	};

	let {
		name,
		options,
		selectedValue = '',
		ariaLabel = 'Select an option',
		placeholder = 'Search',
		emptyMessage = 'No matches',
		maxResults = 50,
		listboxId
	}: {
		name: string;
		options: Option[];
		selectedValue?: string;
		ariaLabel?: string;
		placeholder?: string;
		emptyMessage?: string;
		maxResults?: number;
		listboxId?: string;
	} = $props();

	let selected = $state('');
	let query = $state('');
	let open = $state(false);
	let activeIndex = $state(0);
	let closeTimer: ReturnType<typeof setTimeout> | null = null;

	const selectedLabel = $derived(options.find((option) => option.value === selected)?.label ?? '');
	const controlsId = $derived(listboxId ?? `${name}-options`);
	const normalized = (value: string) => value.trim().toLowerCase();
	const filtered = $derived.by(() => {
		const q = normalized(query);
		const matches = q
			? options.filter((option) =>
					normalized(`${option.label} ${option.searchText ?? ''}`).includes(q)
				)
			: options;
		return matches.slice(0, maxResults);
	});

	$effect(() => {
		selected = selectedValue;
	});

	$effect(() => {
		if (!open) query = selectedLabel;
	});

	function clearCloseTimer() {
		if (closeTimer) clearTimeout(closeTimer);
		closeTimer = null;
	}

	function choose(option: Option) {
		selected = option.value;
		query = option.label;
		open = false;
		activeIndex = 0;
	}

	function openList() {
		clearCloseTimer();
		open = true;
		activeIndex = 0;
	}

	function closeList() {
		closeTimer = setTimeout(() => {
			open = false;
			query = selectedLabel;
		}, 120);
	}

	function onInput(event: Event) {
		query = (event.currentTarget as HTMLInputElement).value;
		open = true;
		activeIndex = 0;
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			open = true;
			activeIndex = Math.min(activeIndex + 1, Math.max(filtered.length - 1, 0));
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			open = true;
			activeIndex = Math.max(activeIndex - 1, 0);
		} else if (event.key === 'Enter' && open && filtered[activeIndex]) {
			event.preventDefault();
			choose(filtered[activeIndex]);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			open = false;
			query = selectedLabel;
		}
	}
</script>

<div class="searchable-select">
	<input type="hidden" {name} value={selected} />
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
						aria-selected={option.value === selected}
						class:active={index === activeIndex}
						onclick={() => choose(option)}
					>
						{option.label}
					</button>
				{/each}
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
	.empty {
		color: var(--muted);
	}
</style>
