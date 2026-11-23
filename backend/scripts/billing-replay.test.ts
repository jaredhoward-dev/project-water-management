// pnpm dev:billing:replay (billing-replay.ts): what it signs and where it refuses to post.
import { describe, expect, it, vi } from 'vitest';
import { fixturePath, main, prepareEvent } from './billing-replay.js';

const A = '11111111-1111-4111-8111-111111111111';

describe('billing-replay', () => {
	it('finds a fixture by name, or a path from where pnpm ran', () => {
		expect(fixturePath('subscription-updated')).toMatch(/fixtures\/billing\/subscription-updated\.json$/);
		expect(fixturePath('./x.json', '/tmp/here')).toBe('/tmp/here/x.json');
	});

	it('puts the account in every billing_account_id and can give a fresh id', () => {
		const e = { id: 'evt_1', data: { object: { metadata: { billing_account_id: 'old' }, parent: { subscription_details: { metadata: { billing_account_id: 'old' } } } } } };
		const out = JSON.parse(prepareEvent(e, { account: A, newId: true }));
		expect(out.data.object.metadata.billing_account_id).toBe(A);
		expect(out.data.object.parent.subscription_details.metadata.billing_account_id).toBe(A);
		expect(out.id).not.toBe('evt_1');
		expect(JSON.parse(prepareEvent(e, {})).id).toBe('evt_1');
	});

	it('refuses to sign with anything but the dev-only key, for anything but the mock, or to post anywhere but localhost', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch');
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const dev = { BILLING_PROVIDER: 'mock', BILLING_WEBHOOK_SECRET: 'dev-only-x' };
		expect(await main(['subscription-updated'], { ...dev, BILLING_WEBHOOK_SECRET: 'whsec_real' })).toBe(2);
		expect(await main(['subscription-updated'], { ...dev, BILLING_PROVIDER: 'stripe' })).toBe(2);
		expect(await main(['subscription-updated'], { ...dev, WM_API_URL: 'https://example.org' })).toBe(2);
		expect(await main(['no-such-fixture'], dev)).toBe(2);
		expect(await main(['subscription-updated', '--account', 'nope'], dev)).toBe(2);
		expect(fetch).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});
});
