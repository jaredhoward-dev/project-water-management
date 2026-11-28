// Free's one live catchment (issue #641; docs/billing.md § Live catchments
// (Free)): with billing enforced, switching a data feed, an alert, automatic
// runs or a farm view on in a second catchment on Free answers 402 plan_limit
// with params.key 'live_catchments'. The workspace words it as #641's copy
// does: plain, no error colour, never "quota" or "402". Workspace only (English).
import { freeLiveCatchments } from '@water-management/engine/plans';
import { ApiError } from '#lib/api/client.js';

/** "one catchment", "2 catchments": Free's live figure in the words (#941: read from the plan figures, never typed). */
export const liveCatchmentsWords = (n: number): string => (n === 1 ? 'one catchment' : `${n} catchments`);

/** Whether an error is Free's live-catchment refusal (338_live_catchments), not the Team seat one. */
export const isLiveLimit = (err: unknown): boolean =>
	err instanceof ApiError && err.status === 402 && err.code === 'plan_limit' && err.params.key === 'live_catchments';

/** What the refusal says, for Free's live figure `n`. */
export const liveLimitText = (n: number): string =>
	`Free runs ${liveCatchmentsWords(n)} live: data feeds, automatic runs, alerts and farm views. ` +
	`${n === 1 ? 'Another of your catchments is' : `${n} others of your catchments are`} live now. ` +
	'Switch those off there to make this one live instead, or compare plans. Everything else here keeps working: runs, ' +
	'calibration, scenarios and exports have no limit on Free.';

/** What the refusal says, at the plan figures' Free limit. */
export const LIVE_LIMIT_TEXT = liveLimitText(freeLiveCatchments());

/**
 * A copy or an import of a catchment with automatic runs on, at Free's live
 * limit, is made with them off and the API's 201 says so (`autoRunsOff:
 * "live_catchments"`, docs/api.md § Projects): whether this answer did.
 */
export const startedAutoRunsOff = (answer: { autoRunsOff?: string | null } | null | undefined): boolean => answer?.autoRunsOff === 'live_catchments';

/** The copy and import dialogs' done-state line for it (AutoRunsOffNotice), for Free's live figure `n`. */
export const autoRunsOffText = (n: number): string =>
	`The new project starts with automatic runs off: Free runs ${liveCatchmentsWords(n)} live, and ` +
	`${n === 1 ? 'another catchment on this plan is' : `${n} other catchments on this plan are`} live now. ` +
	'Everything else in it works: runs, calibration, scenarios and exports. Switch automatic runs on in its settings once ' +
	`${n === 1 ? 'the other one is' : 'one of the others is'} off, or compare plans.`;

/** The same at the plan figures' Free limit. */
export const AUTO_RUNS_OFF_TEXT = autoRunsOffText(freeLiveCatchments());
