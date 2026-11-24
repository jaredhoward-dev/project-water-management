// The staff tool's B2B invoice without a database (billing/invoice.ts): the
// request's checks (the PO number above all, which is printed on the
// customer's invoice), the period in South African days, the lines and the
// key that makes a retry the same invoice. Runs under the workspace's skewed
// TZ (CLAUDE.md rule 7): the period never reads the machine's zone.
import { describe, expect, it } from 'vitest';
import { checkInvoiceRequest, invoiceKey, invoiceLines, invoicePeriod, InvoiceError, PO_NUMBER, sastToday } from './invoice.js';
import type { CheckoutPlan } from './provider.js';

const TEAM: CheckoutPlan = {
	code: 'team',
	name: 'Team',
	priceMonthlyMinor: 249900,
	priceAnnualMinor: 2499000,
	currency: 'ZAR',
	seatsIncluded: 3,
	extraSeatMonthlyMinor: 49900,
	extraSeatAnnualMinor: 499000
};
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const base = { target: { kind: 'account' as const, accountId: ACCOUNT }, plan: 'team', interval: 'year' as const, poNumber: 'PO-2026/0042' };

describe('checkInvoiceRequest', () => {
	it('takes a usual PO number, seats in range and a real date (positive control)', () => {
		for (const po of ['PO-2026/0042', '4500012345', 'WUA PO #17 (rev 2)', 'A.B_C:1']) expect(() => checkInvoiceRequest({ ...base, poNumber: po }), po).not.toThrow();
		expect(() => checkInvoiceRequest({ ...base, seats: 50, from: '2027-02-28' })).not.toThrow();
	});

	it('refuses a PO number that is empty, too long, starts with punctuation, or carries anything else (markup, a newline, an address)', () => {
		for (const po of ['', ' PO1', '-PO1', 'x'.repeat(65), 'PO<1>', 'PO\n1', 'PO1;drop', 'billing@example.com', 'PO “1”', 'PO=1']) {
			expect(() => checkInvoiceRequest({ ...base, poNumber: po }), JSON.stringify(po)).toThrow(InvoiceError);
		}
		expect(PO_NUMBER.test('x'.repeat(64))).toBe(true);
	});

	it('refuses seats out of range or fractional, and a date that doesn’t exist', () => {
		for (const seats of [0, 51, 2.5]) expect(() => checkInvoiceRequest({ ...base, seats }), String(seats)).toThrow(/seats/);
		expect(() => checkInvoiceRequest({ ...base, from: '2027-02-30' })).toThrow(/from/);
		expect(() => checkInvoiceRequest({ ...base, from: '27-01-01' })).toThrow(/from/);
	});
});

describe('invoicePeriod', () => {
	it('runs one month or one year from a SAST day, ending the day before, as SAST midnights', () => {
		expect(invoicePeriod('2027-01-15', 'month')).toEqual({ until: '2027-02-14', start: Date.UTC(2027, 0, 14, 22) / 1000, end: Date.UTC(2027, 1, 14, 22) / 1000 });
		expect(invoicePeriod('2027-01-01', 'year').until).toBe('2027-12-31');
		expect(invoicePeriod('2026-12-01', 'month').until).toBe('2026-12-31');
	});

	it('clamps a day the next month lacks (31 January + 1 month ends 27 February), and 29 February a year on', () => {
		expect(invoicePeriod('2027-01-31', 'month').until).toBe('2027-02-27');
		expect(invoicePeriod('2028-02-29', 'year').until).toBe('2029-02-27');
	});

	it('takes today in South Africa, whatever the machine’s zone: 23:30 UTC is already tomorrow there', () => {
		expect(sastToday(Date.UTC(2026, 11, 31, 23, 30))).toBe('2027-01-01');
		expect(sastToday(Date.UTC(2026, 11, 31, 21, 30))).toBe('2026-12-31');
	});
});

describe('invoiceLines', () => {
	it('is the plan alone at its included seats, at the interval’s price', () => {
		expect(invoiceLines(TEAM, 'year', 3, '2027-01-01', '2027-12-31')).toEqual([{ amountMinor: 2499000, description: 'IC-WBT Team (3 editor seats), 1 year, 2027-01-01 to 2027-12-31' }]);
	});

	it('adds the extra seats past the included ones as a second line, quantity × the seat price', () => {
		const lines = invoiceLines(TEAM, 'month', 5, '2027-01-01', '2027-01-31');
		expect(lines).toEqual([
			{ amountMinor: 249900, description: 'IC-WBT Team (3 editor seats), 1 month, 2027-01-01 to 2027-01-31' },
			{ amountMinor: 2 * 49900, description: 'IC-WBT Team: 2 extra editor seats, 1 month, 2027-01-01 to 2027-01-31' }
		]);
	});
});

describe('invoiceKey', () => {
	it('is the same for the same request and differs when anything billed differs', () => {
		const k = invoiceKey(ACCOUNT, 'team', 'year', 3, '2027-01-01', 'PO-1');
		expect(invoiceKey(ACCOUNT, 'team', 'year', 3, '2027-01-01', 'PO-1')).toBe(k);
		expect(k.startsWith(`${ACCOUNT}-`)).toBe(true);
		expect(k).not.toContain('PO-1');
		for (const other of [
			invoiceKey(ACCOUNT, 'team', 'month', 3, '2027-01-01', 'PO-1'),
			invoiceKey(ACCOUNT, 'team', 'year', 4, '2027-01-01', 'PO-1'),
			invoiceKey(ACCOUNT, 'team', 'year', 3, '2027-01-02', 'PO-1'),
			invoiceKey(ACCOUNT, 'team', 'year', 3, '2027-01-01', 'PO-2')
		])
			expect(other).not.toBe(k);
	});
});
