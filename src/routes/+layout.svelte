<script lang="ts">
	import { page } from '$app/state';
	import '../app.css';

	let { data, children } = $props();
	const isViewer = $derived(data.user?.role === 'viewer');
	const path = $derived(page.url.pathname);
	function active(prefix: string): boolean {
		return prefix === '/' ? path === '/' : path.startsWith(prefix);
	}
</script>

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
