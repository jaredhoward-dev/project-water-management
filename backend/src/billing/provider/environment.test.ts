// The deployment's billing tag (environment.ts): the orphan check compares it with the tag checkout stamped.
import { describe, expect, it } from 'vitest';
import { BILLING_ENVIRONMENT_LOCAL, BILLING_ENVIRONMENT_TAG } from '../../config/production.js';
import { BILLING_ENVIRONMENT_SHAPE, billingEnvironment, LOCAL_BILLING_ENVIRONMENT } from './environment.js';

describe('billingEnvironment', () => {
	it('reads BILLING_ENVIRONMENT, trimmed (positive control)', () => {
		expect(billingEnvironment({ BILLING_ENVIRONMENT: ' icwbt.example.com ' })).toBe('icwbt.example.com');
		expect(billingEnvironment({ BILLING_ENVIRONMENT: 'staging-2' })).toBe('staging-2');
	});

	it('is the local default when unset, empty or not tag-shaped, so local dev needs nothing', () => {
		for (const v of [undefined, '', '  ', 'has space', '-x', 'x'.repeat(101)]) expect(billingEnvironment({ BILLING_ENVIRONMENT: v }), String(v)).toBe('local');
	});

	it('agrees with the production check’s copy (config/production.ts imports nothing)', () => {
		expect(BILLING_ENVIRONMENT_TAG.source).toBe(BILLING_ENVIRONMENT_SHAPE.source);
		expect(BILLING_ENVIRONMENT_LOCAL).toBe(LOCAL_BILLING_ENVIRONMENT);
	});
});
