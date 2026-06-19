<script lang="ts">
	import { browser } from '$app/environment';

	type Props = {
		url: string;
		filename: string;
		mimeType: string;
		class?: string;
		disabled?: boolean;
	};

	let {
		url,
		filename,
		mimeType,
		class: className = 'btn small',
		disabled = false
	}: Props = $props();

	let saving = $state(false);
	let message = $state('');

	function isIosStandalone(): boolean {
		if (!browser) return false;
		const nav = navigator as Navigator & { standalone?: boolean };
		const isiOS =
			/iPad|iPhone|iPod/.test(navigator.userAgent) ||
			(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
		return isiOS && (nav.standalone === true || window.matchMedia('(display-mode: standalone)').matches);
	}

	function saveBlob(blob: Blob) {
		const objectUrl = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = objectUrl;
		a.download = filename || 'document';
		document.body.append(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
	}

	async function download() {
		if (!browser || saving || disabled) return;
		saving = true;
		message = '';

		try {
			const res = await fetch(url, { credentials: 'same-origin' });
			if (!res.ok) throw new Error(`Download failed: ${res.status}`);

			const blob = await res.blob();
			const file = new File([blob], filename || 'document', { type: mimeType || blob.type });
			const shareData = { files: [file], title: filename };
			const nav = navigator as Navigator & {
				canShare?: (data: ShareData) => boolean;
				share?: (data: ShareData) => Promise<void>;
			};

			if (nav.canShare?.(shareData) && nav.share) {
				await nav.share(shareData);
				return;
			}

			if (isIosStandalone()) {
				message = 'iOS cannot save this file here without leaving the app. Use View, or open in Safari.';
				return;
			}

			saveBlob(blob);
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			message = 'Could not download this file from here. Try View or open the app in Safari.';
		} finally {
			saving = false;
		}
	}
</script>

<span class="download-wrap">
	<button class={`download-button ${className}`} type="button" disabled={disabled || saving} onclick={download}>
		{saving ? 'Saving...' : 'Download'}
	</button>
	{#if message}
		<span class="download-msg" role="status">{message}</span>
	{/if}
</span>

<style>
	.download-wrap {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}
	.download-msg {
		color: var(--muted);
		font-size: 0.78rem;
		line-height: 1.25;
		max-width: 26rem;
	}
	.download-button {
		font: inherit;
		cursor: pointer;
	}
	.download-button:disabled {
		cursor: wait;
		opacity: 0.7;
	}
	.download-button.chip-link {
		font-size: 0.78rem;
		padding: 3px 9px;
		border: 0;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent);
		text-decoration: none;
		min-height: 28px;
		display: inline-flex;
		align-items: center;
	}
</style>
