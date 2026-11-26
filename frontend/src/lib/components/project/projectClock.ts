// The open project's time zone, shared through context with every workspace
// screen that names a run or dates a run or a publication (issue #899), so
// those read on the project's clock, as its run report does (reportTimeZone),
// rather than the viewer's. The project page provides it; anywhere else (or
// before the project loads) it is DEFAULT_TIME_ZONE.
import { getContext, hasContext, setContext } from 'svelte';
import { DEFAULT_TIME_ZONE } from '#lib/components/project/project.js';

const KEY = Symbol('project-time-zone');

/** The project page: the zone of the project it shows (read when a screen renders, so a project switch follows). */
export function provideProjectTimeZone(get: () => string | null | undefined): void {
	setContext(KEY, get);
}

/** Call while a component initialises; the getter it returns reads the open project's zone. */
export function projectTimeZoneReader(): () => string {
	const get = hasContext(KEY) ? (getContext(KEY) as () => string | null | undefined) : undefined;
	return () => get?.() || DEFAULT_TIME_ZONE;
}
