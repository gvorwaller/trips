function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
	return parts.find((p) => p.type === type)?.value ?? '';
}

export function duplicateTripTimestamp(at = new Date(), timeZone?: string | null): string {
	const options: Intl.DateTimeFormatOptions = {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	};
	const trimmed = timeZone?.trim();
	if (trimmed) options.timeZone = trimmed;

	let parts: Intl.DateTimeFormatPart[];
	try {
		parts = new Intl.DateTimeFormat('en-US', options).formatToParts(at);
	} catch {
		const { timeZone: _badTimeZone, ...fallbackOptions } = options;
		parts = new Intl.DateTimeFormat('en-US', fallbackOptions).formatToParts(at);
	}

	return `${partValue(parts, 'year')}-${partValue(parts, 'month')}-${partValue(
		parts,
		'day'
	)} ${partValue(parts, 'hour')}:${partValue(parts, 'minute')}`;
}

export function duplicateTripName(
	name: string,
	at = new Date(),
	timeZone?: string | null
): string {
	const stamp = duplicateTripTimestamp(at, timeZone);
	return `${name} (copy) ${stamp}`;
}
