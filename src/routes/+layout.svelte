<script lang="ts">
	import '../app.css';
	let { children } = $props();
</script>

<div class="app">
	<header class="topnav">
		<a class="brand" href="/">trips</a>
	</header>

	<main class="page">
		{@render children()}
	</main>
</div>
