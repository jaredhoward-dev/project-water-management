// The alert kill switch (ALERTS_ENABLED, evaluate.ts alertsEnabled): unset is on, and every spelling an operator may
// reach for in an incident switches alert emails off. Before this, only the exact lower-case `false` did, so
// `FALSE`, `0` or `off` left every alert email going out (alerts.db.test.ts covers what "off" does to the queue).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertsEnabled } from './evaluate.js';

afterEach(() => vi.unstubAllEnvs());

describe('ALERTS_ENABLED', () => {
	it('is on when unset, true, or anything it does not recognise (positive control)', () => {
		vi.stubEnv('ALERTS_ENABLED', undefined);
		expect(alertsEnabled()).toBe(true);
		for (const v of ['', 'true', 'TRUE', '1', 'on', 'yes', 'flase']) {
			vi.stubEnv('ALERTS_ENABLED', v);
			expect(alertsEnabled(), JSON.stringify(v)).toBe(true);
		}
	});

	it('is off for false, 0, off or no, in any case and with stray spaces', () => {
		for (const v of ['false', 'FALSE', 'False', ' false ', '0', 'off', 'OFF', 'no', 'No\n']) {
			vi.stubEnv('ALERTS_ENABLED', v);
			expect(alertsEnabled(), JSON.stringify(v)).toBe(false);
		}
	});
});
