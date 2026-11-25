// Where *Compare plans* goes (issue #641; docs/billing.md § Who the plan
// belongs to): the Plan page of the account that bills the catchment. A team
// project bills to its team (project_billing_account_set, 323), so its link is
// the team's plan; any other project bills to its creator's own account, and
// the link is the person's own plan. Only a team admin reads a team's plan
// (app_billing_account_readable, 323; GET /teams/:id/plan is 404 to anyone
// else), so for a team member who isn't an admin, or someone shared the
// catchment directly, the link is the public price list instead, with a line
// saying whose plan the catchment is on and to ask a team admin: their own
// plan wouldn't change what this catchment may do. Every Compare plans link
// (the live-limit note, the auto-runs-off line of the copy and import dialogs,
// the assistant's cap, the workspace's paused and trial notices) builds it
// with planLink here.
import { getContext, hasContext, setContext } from 'svelte';
import type { ProjectTeam } from '#lib/api/types.js';

/** The public price list (the pricing page's English address): where a non-admin's Compare plans goes. */
export const PRICING_HREF = '/welcome/pricing';

/**
 * The plan a catchment is billed to: `<base>/teams/<encoded team id>/plan` for a
 * team catchment, else `<base>/account/plan`. The head is always a literal
 * app path and the id is encoded, so an id from the API can't leave the app's
 * origin (urlAttributes.security.test.ts calls it with hostile ids). `base` is
 * the app's base path (basePath(), '' at the site root).
 */
export function planHref(teamId: string | null | undefined, base = ''): string {
	return teamId ? `${base}/teams/${encodeURIComponent(teamId)}/plan` : `${base}/account/plan`;
}

/** The team as planLink reads it. */
export type BillingTeam = Pick<ProjectTeam, 'id' | 'name' | 'role'>;

/** Where Compare plans goes, and the line to show beside it when the plan isn't the person's to open. */
export interface PlanLink {
	href: string;
	/** Why the link is the price list: the catchment is on a team's plan the person can't open. null otherwise. */
	note: string | null;
}

/**
 * Compare plans for a catchment billed to `team` (the project's `team`, null for a
 * personal one): your own plan; the team's plan for a team admin (`team.role`,
 * from the full project payload); else the public price list with a line naming
 * the team's plan (its name when you're in the team) and to ask a team admin. A
 * missing `role` (the list's summary, an older API) counts as not an admin: the
 * price list is always there, a team plan page the person can't open is a 404.
 */
export function planLink(team: BillingTeam | null | undefined, base = ''): PlanLink {
	if (!team?.id) return { href: planHref(null, base), note: null };
	if (team.role === 'admin') return { href: planHref(team.id, base), note: null };
	const whose = team.name ? `${team.name}’s plan` : 'its team’s plan';
	return { href: `${base}${PRICING_HREF}`, note: `This catchment is on ${whose}: ask a team admin to change it.` };
}

/** The context key (exported for the components' unit tests, which render with a context map). */
export const BILLING_TEAM_CONTEXT = Symbol('billingTeam');

/**
 * The workspace says which team bills the open catchment (its `project.team`,
 * with your role in it, or none), so a Compare plans link anywhere below it
 * goes where planLink says. Call during component init with a getter, so a
 * late-loading project counts.
 */
export function provideBillingTeam(team: () => BillingTeam | null | undefined): void {
	setContext(BILLING_TEAM_CONTEXT, team);
}

/** The team that bills the catchment the nearest workspace shows (call during component init); null outside one. */
export function useBillingTeam(): () => BillingTeam | null {
	if (!hasContext(BILLING_TEAM_CONTEXT)) return () => null;
	const get = getContext<() => BillingTeam | null | undefined>(BILLING_TEAM_CONTEXT);
	return () => get() ?? null;
}
