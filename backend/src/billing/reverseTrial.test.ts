// The reverse trial's setting and its claim key (billing/reverseTrial.ts; docs/billing.md § Pro: the reverse trial).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { reverseTrialHash, reverseTrialOn, startReverseTrial } from './reverseTrial.js';
import type { Db } from '../db/tx.js';

describe('reverseTrialOn', () => {
	it('is on only with REVERSE_TRIAL=true and BILLING_ENFORCED=true', () => {
		expect(reverseTrialOn({})).toBe(false);
		expect(reverseTrialOn({ REVERSE_TRIAL: 'true' })).toBe(false);
		expect(reverseTrialOn({ BILLING_ENFORCED: 'true' })).toBe(false);
		expect(reverseTrialOn({ REVERSE_TRIAL: '1', BILLING_ENFORCED: 'true' })).toBe(false);
		expect(reverseTrialOn({ REVERSE_TRIAL: 'true', BILLING_ENFORCED: 'true' })).toBe(true);
	});

	it('off, starting one touches no database', async () => {
		const db = { query: () => Promise.reject(new Error('no query when off')) } as unknown as Db;
		expect(await startReverseTrial(db, 'u', {})).toBe('off');
	});

	it('a disposable address gets no trial and claims nothing: only the address is read', async () => {
		const queries: string[] = [];
		const db = {
			query: (sql: string) => {
				queries.push(sql);
				return Promise.resolve({ rows: [{ email: 'someone@mailinator.com' }] });
			}
		} as unknown as Db;
		expect(await startReverseTrial(db, 'u', { REVERSE_TRIAL: 'true', BILLING_ENFORCED: 'true' })).toBe('disposable');
		expect(queries).toHaveLength(1);
		expect(queries[0]).not.toContain('app_reverse_trial_start');
	});
});

describe('reverseTrialHash', () => {
	it('is the SHA-256 of the canonical address, so canonical duplicates share it', () => {
		const h = reverseTrialHash('First.Last+tag@GoogleMail.com');
		expect(h).toBe(createHash('sha256').update('firstlast@gmail.com').digest('hex'));
		expect(reverseTrialHash('firstlast@gmail.com')).toBe(h);
		expect(reverseTrialHash('first.last@example.com')).not.toBe(reverseTrialHash('firstlast@example.com'));
		expect(h).not.toContain('firstlast');
	});
});
