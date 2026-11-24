// The workspace's paused notice (341, docs/billing.md § Pausing after a
// downgrade; docs/ui.md § The header's notices): a catchment whose billing
// account dropped to Free past its live catchments, and whose 14-day grace
// ran out, has its feeds, alerts and automatic runs paused. The notice says
// so in #641's tone (an information note, never an error), that nothing is
// lost, and links to the plan the catchment is billed to. English: the
// workspace is; a farmer page never shows it.
import type { Project } from '#lib/api/types.js';
import { fmtDate } from '#lib/format/number.js';

export interface PausedNotice {
	text: string;
	/** The team the catchment is billed to, or null for your own account. */
	teamId: string | null;
	/** The link to the plan: planHref(teamId, base). */
	href: string;
	linkText: string;
}

/**
 * The plan a catchment is billed to: `<base>/teams/<encoded team id>/plan` for a
 * team catchment, else `<base>/account/plan`. The head is always a literal
 * app path and the id is encoded, so an id from the API can't leave the app's
 * origin (urlAttributes.security.test.ts calls it with hostile ids). `base` is
 * the app's base path (basePath(), '' at the site root).
 */
export function planHref(teamId: string | null, base = ''): string {
	return teamId ? `${base}/teams/${encodeURIComponent(teamId)}/plan` : `${base}/account/plan`;
}

/** The notice for a paused catchment, or null when it isn't paused (or an older API doesn't say). */
export function pausedNotice(p: Pick<Project, 'planPausedAt' | 'team'> | null | undefined, base = ''): PausedNotice | null {
	if (!p?.planPausedAt) return null;
	const teamId = p.team?.id ?? null;
	return {
		text: `Feeds, alerts and automatic runs are paused here since ${fmtDate(p.planPausedAt)}, because the plan this catchment is billed to has ended. Nothing is lost: you can still open, run, edit and export it, and everything carries on as it was on a plan again.`,
		teamId,
		href: planHref(teamId, base),
		linkText: p.team ? 'The team’s plan' : 'Plan and usage'
	};
}
