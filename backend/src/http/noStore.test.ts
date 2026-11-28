// The default Cache-Control on API answers (http/noStore.ts, docs/security.md § Infrastructure → Caching).
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { noStoreByDefault } from './noStore.js';

describe('noStoreByDefault', () => {
	const app = new Hono()
		.use('*', noStoreByDefault)
		.get('/plain', (c) => c.json({ ok: true }))
		.get('/own', (c) => {
			c.header('Cache-Control', 'private, max-age=60');
			return c.json({ ok: true });
		})
		.get('/throws', () => {
			throw new Error('boom');
		})
		.onError((_err, c) => c.json({ error: 'Internal server error' }, 500));

	it('marks an answer without a Cache-Control no-store', async () => {
		expect((await app.request('/plain')).headers.get('cache-control')).toBe('no-store');
	});

	it('leaves a route’s own Cache-Control alone', async () => {
		expect((await app.request('/own')).headers.get('cache-control')).toBe('private, max-age=60');
	});

	it('marks the error handler’s answer and a 404 too', async () => {
		expect((await app.request('/throws')).headers.get('cache-control')).toBe('no-store');
		expect((await app.request('/nowhere')).headers.get('cache-control')).toBe('no-store');
	});
});

describe('the API app', () => {
	const app = createApp();

	it('answers personal and public routes with no-store, refusals included', async () => {
		// Signed out: a refused personal read, a dead share link, a malformed invite, a bad ingest key, an unknown path.
		const answers = await Promise.all([
			app.request('/auth/me'),
			app.request('/health'),
			app.request('/verify/not-a-code'),
			app.request('/ingest/v1/whoami'),
			app.request('/nowhere'),
			app.request('/share/view', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:7777' }, body: JSON.stringify({ token: 'x' }) }),
			app.request('/auth/invite-info', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:7777' }, body: JSON.stringify({ token: 'x' }) })
		]);
		expect(answers.map((r) => r.status)).toEqual([401, 200, 404, 401, 404, 404, 404]);
		for (const r of answers) expect(r.headers.get('cache-control')).toBe('no-store');
	});
});
