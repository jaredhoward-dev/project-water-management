import { describe, expect, it } from 'vitest';
import type { AccountPlan } from '#lib/api/types.js';
import { seatChangeLine, seatChangeState, seatChangeValid } from './seatChange';

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
		limits: { seats_included: 3 },
		features: { extra_seat_monthly_minor: 49900, extra_seat_annual_minor: 499000 }
	},
	subscription: { status: 'active', seats: 3, periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z', trialEnd: null, cancelAtPeriodEnd: false }
} as unknown as AccountPlan;
const withSub = (patch: Record<string, unknown>, top: Record<string, unknown> = {}) =>
	({ ...TEAM, ...top, subscription: { ...TEAM.subscription!, ...patch } }) as unknown as AccountPlan;

describe('seatChangeState', () => {
	it('is the seats now and the extra-seat prices for a live Team subscription', () => {
		expect(seatChangeState(TEAM)).toEqual({ current: 3, offer: { included: 3, max: 50, extraMonthlyMinor: 49900, extraAnnualMinor: 499000 }, currency: 'ZAR', interval: null });
	});
	it('reads the interval when the plan carries one', () => {
		expect(seatChangeState(withSub({ interval: 'year' }))?.interval).toBe('year');
	});
	it('is null with no subscription, an ended one, a person’s account or no online billing', () => {
		expect(seatChangeState({ ...TEAM, subscription: null } as AccountPlan)).toBeNull();
		expect(seatChangeState(withSub({ status: 'canceled' }))).toBeNull();
		expect(seatChangeState(withSub({}, { account: { id: 'a', kind: 'user' } }))).toBeNull();
		expect(seatChangeState(withSub({}, { provider: 'manual' }))).toBeNull();
	});
});

describe('seatChangeLine', () => {
	const st = seatChangeState(TEAM)!;
	it('says only the new count when the interval is unknown', () => {
		expect(seatChangeLine(st, 5)).toBe('From 3 to 5 editor seats. The difference for the rest of this period is prorated on the next invoice.');
	});
	it('says the monthly or yearly difference when the interval is known', () => {
		expect(seatChangeLine({ ...st, interval: 'month' }, 5)).toBe('From 3 to 5 editor seats: R 998.00 more a month. The difference for the rest of this period is prorated on the next invoice.');
		expect(seatChangeLine({ ...st, current: 6, interval: 'year' }, 4)).toMatch(/^From 6 to 4 editor seats: R 9[\s  ]?980.00 less a year\./);
	});
});

describe('seatChangeValid', () => {
	const st = seatChangeState(TEAM)!;
	it('takes a whole count from the included seats to 50 that differs from now', () => {
		expect(seatChangeValid(st, 5)).toBe(true);
		expect(seatChangeValid(st, 50)).toBe(true);
		for (const n of [null, 3, 2, 51, 4.5]) expect(seatChangeValid(st, n)).toBe(false);
	});
});
