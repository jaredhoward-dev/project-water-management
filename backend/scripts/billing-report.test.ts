// The operator's billing report (pnpm dev:billing:report, 325_billing_metrics): what it takes and refuses.
// The maths is src/billing/metrics.test.ts; the owner-only functions and the month's edges, src/billing/metrics.db.test.ts.
import { describe, expect, it } from 'vitest';
import { parseArgs } from './billing-report.js';

describe('parseArgs', () => {
	it('defaults to this month, text, no addresses', () => {
		expect(parseArgs([])).toEqual({ month: null, json: false, showEmails: false });
		expect(parseArgs(['--month', '2026-11', '--json', '--show-emails'])).toEqual({ month: '2026-11', json: true, showEmails: true });
	});

	it('refuses a bad month or an unknown argument', () => {
		expect(parseArgs(['--month', '2026-13'])).toMatch(/YYYY-MM/);
		expect(parseArgs(['--month'])).toMatch(/YYYY-MM/);
		expect(parseArgs(['--month', '2026-1'])).toMatch(/YYYY-MM/);
		expect(parseArgs(['--emails'])).toMatch(/unexpected/);
	});
});
