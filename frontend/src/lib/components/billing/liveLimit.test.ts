import { describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api/client.js';
import { planFigures } from '@water-management/engine/plans';
import { AUTO_RUNS_OFF_TEXT, autoRunsOffText, isLiveLimit, LIVE_LIMIT_TEXT, liveLimitText } from './liveLimit';

describe('isLiveLimit (338_live_catchments)', () => {
	it('is the 402 plan_limit refusal keyed live_catchments, not the seat one or another error', () => {
		expect(isLiveLimit(new ApiError(402, 'x', undefined, 'plan_limit', { limit: 1, used: 2, plan: 'free', key: 'live_catchments' }))).toBe(true);
		expect(isLiveLimit(new ApiError(402, 'x', undefined, 'plan_limit', { limit: 3, used: 4, plan: 'team' }))).toBe(false);
		expect(isLiveLimit(new ApiError(409, 'x', undefined, 'plan_limit', { key: 'live_catchments' }))).toBe(false);
		expect(isLiveLimit(new Error('plan_limit'))).toBe(false);
	});

	it('never says quota, abuse or 402', () => {
		expect(LIVE_LIMIT_TEXT).not.toMatch(/quota|abuse|402/i);
	});

	it('counts Free’s live catchments from the plan figures, never a typed number (#941)', () => {
		const n = planFigures('free').liveCatchments!;
		expect(LIVE_LIMIT_TEXT).toBe(liveLimitText(n));
		expect(AUTO_RUNS_OFF_TEXT).toBe(autoRunsOffText(n));
		expect(liveLimitText(1)).toContain('Free runs one catchment live: data feeds, automatic runs, alerts and farm views. Another of your catchments is live now.');
		expect(liveLimitText(2)).toContain('Free runs 2 catchments live');
		expect(liveLimitText(2)).toContain('2 others of your catchments are live now');
		expect(autoRunsOffText(3)).toContain('Free runs 3 catchments live, and 3 other catchments on this plan are live now');
	});
});
