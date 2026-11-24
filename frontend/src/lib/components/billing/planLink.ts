// Where *Compare plans* goes (issue #641; docs/billing.md § Who the plan
// belongs to): the Plan page of the account that bills the catchment. A team
// project bills to its team (project_billing_account_set, 323), so its link is
// the team's plan; any other project bills to its creator's own account, and
// the link is the person's own plan. Every Compare plans link (the live-limit
// note, the auto-runs-off line of the copy and import dialogs, the assistant's
// cap, the workspace's paused notice) builds its href here.
import { getContext, hasContext, setContext } from 'svelte';

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

/** The context key (exported for the components' unit tests, which render with a context map). */
export const BILLING_TEAM_CONTEXT = Symbol('billingTeam');

/**
 * The workspace says which team bills the open catchment (its `project.team`,
 * or none), so a Compare plans link anywhere below it opens that team's plan.
 * Call during component init with a getter, so a late-loading project counts.
 */
export function provideBillingTeam(teamId: () => string | null | undefined): void {
	setContext(BILLING_TEAM_CONTEXT, teamId);
}

/** The team that bills the catchment the nearest workspace shows (call during component init); null outside one. */
export function useBillingTeam(): () => string | null {
	if (!hasContext(BILLING_TEAM_CONTEXT)) return () => null;
	const get = getContext<() => string | null | undefined>(BILLING_TEAM_CONTEXT);
	return () => get() ?? null;
}
