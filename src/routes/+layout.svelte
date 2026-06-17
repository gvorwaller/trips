<script lang="ts">
	import { page } from '$app/state';
	import '../app.css';

	let { data, children } = $props();
	const isViewer = $derived(data.user?.role === 'viewer');
	const path = $derived(page.url.pathname);
	function active(prefix: string): boolean {
		return prefix === '/' ? path === '/' : path.startsWith(prefix);
	}

	// Top-nav hamburger: an everywhere-available menu that also holds the Help
	// link (which lives ONLY here). Closes on outside-click, Escape, or navigation.
	let menuOpen = $state(false);
	let menuRoot = $state<HTMLDivElement | null>(null);
	const closeMenu = () => (menuOpen = false);
	function onWindowClick(e: MouseEvent) {
		if (menuOpen && menuRoot && !menuRoot.contains(e.target as Node)) menuOpen = false;
	}
	function onWindowKey(e: KeyboardEvent) {
		if (menuOpen && e.key === 'Escape') menuOpen = false;
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKey} />

{#if data.user}
	<header class="top-nav">
		<a class="brand" href="/">trips</a>
		<nav class="links">
			<a href="/" class:active={active('/')}>Trips</a>
			<a href="/search" class:active={active('/search')}>Search</a>
			{#if !isViewer}
				<a href="/settings" class:active={active('/settings')}>Settings</a>
			{/if}
		</nav>
		<span class="spacer"></span>
		<span class="user">
			{data.user.display_name}{#if isViewer}<span class="role-tag">viewer</span>{/if}
		</span>
		<form class="logout" method="POST" action="/login?/logout">
			<button class="signout" type="submit">Sign out</button>
		</form>

		<div class="menu" bind:this={menuRoot}>
			<button
				class="menu-btn"
				type="button"
				aria-haspopup="true"
				aria-expanded={menuOpen}
				aria-label="Menu"
				onclick={() => (menuOpen = !menuOpen)}>☰</button
			>
			{#if menuOpen}
				<div class="menu-panel" role="menu">
					<a href="/" role="menuitem" class:active={active('/')} onclick={closeMenu}>Trips</a>
					<a href="/search" role="menuitem" class:active={active('/search')} onclick={closeMenu}
						>Search</a
					>
					{#if !isViewer}
						<a href="/settings" role="menuitem" class:active={active('/settings')} onclick={closeMenu}
							>Settings</a
						>
					{/if}
					<a href="/help" role="menuitem" class:active={active('/help')} onclick={closeMenu}>Help</a>
					<div class="menu-sep"></div>
					<form method="POST" action="/login?/logout">
						<button type="submit" role="menuitem" class="menu-signout">Sign out</button>
					</form>
				</div>
			{/if}
		</div>
	</header>

	{#if isViewer}
		<div class="readonly-banner">Read-only view — you can browse and check off packing.</div>
	{/if}
{/if}

<main class="page">
	{@render children()}
</main>

{#if data.user}
	<nav class="bottom-nav">
		<a href="/" class:active={active('/')}><span class="ico">🧳</span>Trips</a>
		<a href="/search" class:active={active('/search')}><span class="ico">🔍</span>Search</a>
		{#if !isViewer}
			<a href="/trips/new" class:active={active('/trips/new')}><span class="ico">＋</span>New</a>
			<a href="/settings" class:active={active('/settings')}><span class="ico">⚙</span>Settings</a>
		{/if}
	</nav>
{/if}
