import { describe, expect, it } from 'vitest';
import type { AccountPlan } from '#lib/api/types.js';
import { assistantShareConfirmLine, assistantShareLine, assistantShareState, assistantShareValid, shareUsdMicros } from './assistantShare';

const TEAM = {
	provider: 'mock',
	enforced: false,
	account: { id: 'a', kind: 'team' },
	plan: {
		code: 'team',
		name: 'Team',
		priceMonthlyMinor: 249900,
		priceAnnualMinor: 2499000,
		currency: 'ZAR',
		limits: { seats_included: 3, assistant_usd_micros_per_seat_month: 15_000_000, assistant_usd_micros_per_month: null },
		features: {}
	},
	subscription: { status: 'active', seats: 3, periodStart: null, periodEnd: null, trialEnd: null, cancelAtPeriodEnd: false, interval: 'month' },
	team: { editorCount: 3, assistantMemberMaxPct: 50 },
	usage: { assistantCost: { usedUsdMicros: 0, limitUsdMicros: 45_000_000, unpricedTurns: 0 } }
} as unknown as AccountPlan;
const FREE_TEAM = {
	...TEAM,
	plan: { ...TEAM.plan, code: 'free', name: 'Free', limits: { assistant_usd_micros_per_month: 1_000_000, assistant_usd_micros_per_seat_month: null } },
	subscription: null,
	usage: { assistantCost: { usedUsdMicros: 0, limitUsdMicros: 1_000_000, unpricedTurns: 0 } }
} as unknown as AccountPlan;

describe('assistantShareState', () => {
	it('is the share now and the pooled month on a Team plan', () => {
		expect(assistantShareState(TEAM)).toEqual({ current: 50, pooled: true, monthUsdMicros: 45_000_000 });
	});
	it('is unpooled, with no dollars, on a team’s Free plan', () => {
		expect(assistantShareState(FREE_TEAM)).toEqual({ current: 50, pooled: false, monthUsdMicros: null });
	});
	it('is null on a person’s account, and without a share in range', () => {
		expect(assistantShareState({ ...TEAM, account: { id: 'u', kind: 'user' }, team: null } as AccountPlan)).toBeNull();
		expect(assistantShareState({ ...TEAM, team: { editorCount: 3 } } as unknown as AccountPlan)).toBeNull();
		expect(assistantShareState({ ...TEAM, team: { editorCount: 3, assistantMemberMaxPct: 0 } } as AccountPlan)).toBeNull();
	});
});

describe('the words', () => {
	const st = assistantShareState(TEAM)!;
	it('says the share and what it comes to, as the database rounds (down)', () => {
		expect(assistantShareLine(st)).toBe('One member may use up to 50% of the team’s assistant dollars a month ($22.50 of $45.00).');
		expect(shareUsdMicros(45_000_000, 33)).toBe(14_850_000);
		expect(shareUsdMicros(1_000_001, 50)).toBe(500_000);
	});
	it('says 100% is no per-member limit', () => {
		expect(assistantShareLine({ ...st, current: 100 })).toBe('Any one member may use all of the team’s assistant dollars a month ($45.00 of $45.00).');
		expect(assistantShareConfirmLine(st, 100)).toBe('From 50% to 100%: any one member may use all of the team’s assistant dollars a month. It applies from each member’s next question.');
	});
	it('says off the Team plan that the share applies once on it', () => {
		expect(assistantShareLine(assistantShareState(FREE_TEAM)!)).toBe('One member may use up to 50% of the team’s assistant dollars a month. This applies once the team is on the Team plan.');
	});
	it('the confirm question names the new dollars', () => {
		expect(assistantShareConfirmLine(st, 80)).toBe('From 50% to 80%: one member may use up to $36.00 of the team’s $45.00 a month. It applies from each member’s next question.');
		expect(assistantShareConfirmLine(assistantShareState(FREE_TEAM)!, 80)).toBe(
			'From 50% to 80%: one member may use up to 80% of the team’s assistant dollars a month. It applies from each member’s next question.'
		);
	});
});

describe('assistantShareValid', () => {
	const st = assistantShareState(TEAM)!;
	it('takes a whole 1–100 other than the share now', () => {
		for (const n of [1, 51, 100]) expect(assistantShareValid(st, n)).toBe(true);
		for (const n of [null, 0, 101, 50, 60.5, -1]) expect(assistantShareValid(st, n)).toBe(false);
	});
});
