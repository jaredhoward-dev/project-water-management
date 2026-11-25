// The workspace's paused notice (341, docs/billing.md § Pausing after a
// downgrade; docs/ui.md § The header's notices): a catchment whose billing
// account dropped to Free past its live catchments, and whose 14-day grace
// ran out, has its feeds, alerts and automatic runs paused. The notice says
// so in #641's tone (an information note, never an error), that nothing is
// lost, and links to the plan the catchment is billed to (planLink.ts: for
// someone in a team catchment who isn't a team admin, the price list, with
// whose plan it is and to ask a team admin). English: the workspace is; a
// farmer page never shows it.
import type { Project } from '#lib/api/types.js';
import { fmtDate } from '#lib/format/number.js';
import { planLink } from './planLink';
import { trialEndingText } from './trialEnding';

export interface PausedNotice {
	text: string;
	/** The team the catchment is billed to, or null for your own account. */
	teamId: string | null;
	/** The link to the plan: planLink(team, base).href. */
	href: string;
	linkText: string;
}

/** The notice for a paused catchment, or null when it isn't paused (or an older API doesn't say). */
export function pausedNotice(p: Pick<Project, 'planPausedAt' | 'team'> | null | undefined, base = ''): PausedNotice | null {
	if (!p?.planPausedAt) return null;
	const teamId = p.team?.id ?? null;
	const link = planLink(p.team, base);
	const text = `Feeds, alerts and automatic runs are paused here since ${fmtDate(p.planPausedAt)}, because the plan this catchment is billed to has ended. Nothing is lost: you can still open, run, edit and export it, and everything carries on as it was on a plan again.`;
	return {
		text: link.note ? `${text} ${link.note}` : text,
		teamId,
		href: link.href,
		linkText: link.note ? 'Compare plans' : p.team ? 'The team’s plan' : 'Plan and usage'
	};
}

/** The header's trial-ending notice (349; trialEnding.ts): its words and the plan page to upgrade on. */
export interface TrialNotice {
	text: string;
	href: string;
	linkText: string;
}

/**
 * The notice in the 3 days before the reverse trial of the account this
 * catchment is billed to ends, or null. Only the account's person gets
 * `planTrialEnd` (349), so a member never sees someone else's trial. Links to
 * the Plan page, where Upgrade is offered during the trial.
 */
export function trialNotice(p: Pick<Project, 'planTrialEnd' | 'team'> | null | undefined, base = '', now: number = Date.now()): TrialNotice | null {
	const text = trialEndingText(p?.planTrialEnd, now);
	if (!text) return null;
	// Only the account's person or a team admin gets planTrialEnd, so planLink is their plan; it still says
	// where to go should anyone else ever be handed one.
	const link = planLink(p?.team, base);
	return { text: link.note ? `${text} ${link.note}` : text, href: link.href, linkText: link.note ? 'Compare plans' : 'Upgrade' };
}
