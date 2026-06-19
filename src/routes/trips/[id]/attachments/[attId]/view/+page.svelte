<script lang="ts">
	import AttachmentDownloadButton from '$components/AttachmentDownloadButton.svelte';

	let { data } = $props();

	const isPreviewable = $derived(
		data.attachment.mime_type === 'application/pdf' || data.attachment.mime_type.startsWith('image/')
	);
</script>

<svelte:head><title>{data.attachment.name} — trips</title></svelte:head>

<div class="page-head document-head">
	<a class="back" href="/trips/{data.trip.id}">← {data.trip.name}</a>
	<h1>{data.attachment.name}</h1>
	<p class="sub">{data.attachment.mime_type}</p>
	<div class="document-actions">
		<AttachmentDownloadButton
			url={data.attachment.url}
			filename={data.attachment.name}
			mimeType={data.attachment.mime_type}
		/>
	</div>
</div>

<div class="card document-viewer">
	{#if isPreviewable}
		<iframe title={data.attachment.name} src={data.attachment.url}></iframe>
	{:else}
		<p>This file type cannot be previewed in the app.</p>
		<p>
			<AttachmentDownloadButton
				class="btn primary"
				url={data.attachment.url}
				filename={data.attachment.name}
				mimeType={data.attachment.mime_type}
			/>
		</p>
	{/if}
</div>

<style>
	.document-head h1 {
		overflow-wrap: anywhere;
	}
	.back {
		text-decoration: none;
		font-size: 0.85rem;
	}
	.document-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 10px;
	}
	.document-viewer {
		padding: 0;
		overflow: hidden;
	}
	.document-viewer iframe {
		display: block;
		width: 100%;
		height: calc(100vh - var(--nav-h) - var(--bottomnav-h) - env(safe-area-inset-bottom) - 180px);
		min-height: 420px;
		border: 0;
		background: #fff;
	}

	@media (min-width: 640px) {
		.document-viewer iframe {
			height: calc(100vh - var(--nav-h) - 180px);
			min-height: 560px;
		}
	}
</style>
