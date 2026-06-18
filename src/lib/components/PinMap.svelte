<script lang="ts">
	import { onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { loadGoogleMaps } from '$lib/google-maps';

	export interface Pin {
		id: number;
		title: string;
		lat: number;
		lon: number;
	}

	let { pins, onselect = () => {} }: { pins: Pin[]; onselect?: (id: number) => void } = $props();

	const API_KEY = env.PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
	const MAP_ID = env.PUBLIC_GOOGLE_MAPS_MAP_ID ?? '';

	let mapEl = $state<HTMLDivElement>();
	let loadError = $state('');

	onMount(async () => {
		if (pins.length === 0 || !mapEl) return;
		if (!API_KEY) {
			loadError = 'Map needs PUBLIC_GOOGLE_MAPS_API_KEY (links below still work).';
			return;
		}
		try {
			const libs = await loadGoogleMaps(API_KEY, ['maps', 'marker']);
			/* eslint-disable @typescript-eslint/no-explicit-any */
			const gmaps = (window as unknown as { google: { maps: any } }).google.maps;
			const markerLib = libs.marker as any;
			const { Map } = libs.maps as { Map: new (el: HTMLElement, opts: unknown) => any };
			/* eslint-enable @typescript-eslint/no-explicit-any */

			const map = new Map(mapEl, {
				mapId: MAP_ID || undefined,
				gestureHandling: 'greedy',
				streetViewControl: false,
				mapTypeControl: false,
				fullscreenControl: false
			});

			const boundsAround = (lat: number, lng: number, km: number) => {
				const dLat = km / 111.32;
				const dLng = km / (111.32 * Math.cos((lat * Math.PI) / 180));
				return new gmaps.LatLngBounds(
					{ lat: lat - dLat, lng: lng - dLng },
					{ lat: lat + dLat, lng: lng + dLng }
				);
			};

			const bounds = new gmaps.LatLngBounds();
			for (const pin of pins) {
				const pos = { lat: pin.lat, lng: pin.lon };
				const marker = new markerLib.AdvancedMarkerElement({
					map,
					position: pos,
					title: pin.title
				});
				marker.addListener('click', () => onselect(pin.id));
				bounds.extend(pos);
			}
			// A single pin has zero-area bounds, so fitBounds would zoom in as far
			// as it can. Frame it with a 20km buffer instead (matches MapPicker), so
			// a one-place trip shows useful surrounding context rather than rooftops.
			if (pins.length === 1) {
				const only = pins[0];
				map.fitBounds(boundsAround(only.lat, only.lon, 20));
			} else {
				map.fitBounds(bounds);
			}
		} catch (err) {
			loadError = err instanceof Error ? err.message : 'Could not load the map.';
		}
	});
</script>

{#if pins.length === 0}
	<p class="muted note">No mapped places yet — add coordinates to a place to see pins here.</p>
{:else}
	{#if loadError}<p class="err" role="alert">{loadError}</p>{/if}
	<div class="map" bind:this={mapEl}></div>
{/if}

<style>
	.map {
		height: 40vh;
		min-height: 240px;
		max-height: 380px;
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
		background: #dde3e8;
		margin-bottom: 10px;
	}
	.note,
	.muted {
		color: var(--muted);
		font-size: 0.85rem;
	}
	.err {
		color: var(--danger);
		font-size: 0.85rem;
		font-weight: 600;
	}
</style>
