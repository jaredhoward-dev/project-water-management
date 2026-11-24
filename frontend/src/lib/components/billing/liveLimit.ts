// Free's one live catchment (issue #641; docs/billing.md § Live catchments
// (Free)): with billing enforced, switching a data feed, an alert, automatic
// runs or a farm view on in a second catchment on Free answers 402 plan_limit
// with params.key 'live_catchments'. The workspace words it as #641's copy
// does: plain, no error colour, never "quota" or "402". Workspace only (English).
import { ApiError } from '#lib/api/client.js';

/** Whether an error is Free's live-catchment refusal (338_live_catchments), not the Team seat one. */
export const isLiveLimit = (err: unknown): boolean =>
	err instanceof ApiError && err.status === 402 && err.code === 'plan_limit' && err.params.key === 'live_catchments';

/** What the refusal says. */
export const LIVE_LIMIT_TEXT =
	'Free runs one catchment live: data feeds, automatic runs, alerts and farm views. Another of your catchments is live now. ' +
	'Switch those off there to make this one live instead, or compare plans. Everything else here keeps working: runs, ' +
	'calibration, scenarios and exports have no limit on Free.';
