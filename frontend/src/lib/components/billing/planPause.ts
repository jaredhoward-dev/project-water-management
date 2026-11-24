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
	/** The link to the plan: the team's Plan page for a team catchment (teamId), else your own account's. */
	teamId: string | null;
	linkText: string;
}

/** The notice for a paused catchment, or null when it isn't paused (or an older API doesn't say). */
export function pausedNotice(p: Pick<Project, 'planPausedAt' | 'team'> | null | undefined): PausedNotice | null {
	if (!p?.planPausedAt) return null;
	return {
		text: `Feeds, alerts and automatic runs are paused here since ${fmtDate(p.planPausedAt)}, because the plan this catchment is billed to has ended. Nothing is lost: you can still open, run, edit and export it, and everything carries on as it was on a plan again.`,
		teamId: p.team?.id ?? null,
		linkText: p.team ? 'The team’s plan' : 'Plan and usage'
	};
}
