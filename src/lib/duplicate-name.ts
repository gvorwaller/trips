function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

export function duplicateTripName(name: string, at = new Date()): string {
	const stamp = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(
		at.getHours()
	)}:${pad2(at.getMinutes())}`;
	return `${name} (copy) ${stamp}`;
}
