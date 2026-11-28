// An alert mail's retries and a worker that dies mid-send (051_alerts.sql app_alert_finish, 386 app_alert_claim;
// send.ts header): a transport error is retried on the next tick, 3 attempts in all, then the delivery is failed and
// never claimed again; a delivery left `sending` past its lease (the worker stopped) is failed, never sent a second
// time; one still inside its lease is another worker's and is left alone. Each "never sent" has a positive control.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { outbox } from '../mail/transport.js';
import { sendAlerts } from './send.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let projectId: string;

/** Alert mails to the owner (they carry List-Unsubscribe), not the sign-up confirmation. */
const alertMails = () => outbox.filter((m) => m.to === owner.email && m.headers?.['List-Unsubscribe']).length;

/** A firing job_dead event with one immediate delivery to the owner, in the given state (as the schema owner). */
async function delivery(fields: { status?: 'pending' | 'sending'; attempts?: number; lockedFor?: string } = {}) {
	const [rule] = await asOwner(
		`INSERT INTO alert_rule (project_id, kind, threshold) VALUES ($1, 'job_dead', 1)
		 ON CONFLICT (project_id, kind, node_id, feed_id, series_id) DO UPDATE SET threshold = 1 RETURNING id`,
		[projectId]
	);
	await asOwner(`UPDATE alert_event SET state = 'cleared' WHERE rule_id = $1 AND state = 'firing'`, [rule.id]);
	const [e] = await asOwner(`INSERT INTO alert_event (rule_id, project_id, state, value, detail) VALUES ($1, $2, 'firing', 1, '{"count":1}') RETURNING id`, [
		rule.id,
		projectId
	]);
	const sending = fields.status === 'sending';
	await asOwner(
		`INSERT INTO alert_delivery (event_id, user_id, project_id, mode, status, attempts, via, claimed_at, locked_until)
		 VALUES ($1, $2, $3, 'immediate', $4, $5, $6, $7, now() + $8::interval)`,
		[e.id, owner.id, projectId, fields.status ?? 'pending', fields.attempts ?? 0, sending ? 'immediate' : null, sending ? new Date() : null, sending ? fields.lockedFor : null]
	);
	return e.id as string;
}
const row = async (eventId: string) =>
	(await asOwner('SELECT status, attempts, reason FROM alert_delivery WHERE event_id = $1 AND user_id = $2', [eventId, owner.id]))[0];

beforeAll(async () => {
	owner = await signUp('Rowner');
	projectId = (await owner.call('POST', '/projects', { name: 'Alert retries' })).body.project.id;
});

afterEach(async () => {
	vi.restoreAllMocks();
	await asOwner('DELETE FROM alert_delivery WHERE project_id = $1', [projectId]);
});

afterAll(async () => {
	await asOwner('DELETE FROM alert_rule WHERE project_id = $1', [projectId]);
});

describe('a mail the transport keeps refusing', () => {
	it('is retried on the next two ticks, then failed after the third attempt and never claimed again', async () => {
		const id = await delivery();
		let tries = 0;
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(outbox, 'push').mockImplementation(() => {
			tries++;
			throw Object.assign(new Error('Throttling: Maximum sending rate exceeded.'), { name: 'Throttling' });
		});
		for (const n of [1, 2]) {
			expect(await sendAlerts()).toMatchObject({ failed: 1, sent: 0 });
			expect(await row(id), `attempt ${n}`).toEqual({ status: 'pending', attempts: n, reason: 'send failed (Throttling)' });
		}
		expect(await sendAlerts()).toMatchObject({ failed: 1 });
		expect(await row(id)).toEqual({ status: 'failed', attempts: 3, reason: 'send failed (Throttling)' });
		// A fourth tick, transport still down: nothing to claim, the transport not even tried.
		expect(await sendAlerts()).toMatchObject({ failed: 0, sent: 0 });
		expect(tries).toBe(3);
		vi.mocked(outbox.push).mockRestore();
		// And with the transport back, a failed delivery stays failed: it is never sent late.
		const before = alertMails();
		expect((await sendAlerts()).sent).toBe(0);
		expect(alertMails()).toBe(before);
		expect((await row(id))!.status).toBe('failed');
	});

	it('positive control: a retry that succeeds on the second attempt is sent once', async () => {
		const id = await delivery();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const push = vi.spyOn(outbox, 'push').mockImplementationOnce(() => {
			throw Object.assign(new Error('socket hang up'), { name: 'Error', code: 'ECONNRESET' });
		});
		expect((await sendAlerts()).failed).toBe(1);
		push.mockRestore();
		const before = alertMails();
		expect((await sendAlerts()).sent).toBe(1);
		expect(alertMails()).toBe(before + 1);
		expect(await row(id)).toMatchObject({ status: 'sent', attempts: 2 });
	});
});

describe('a worker that stopped while sending', () => {
	it('a delivery left sending past its lease is failed, never mailed a second time', async () => {
		const id = await delivery({ status: 'sending', attempts: 1, lockedFor: '-1 minute' });
		const before = alertMails();
		await sendAlerts();
		expect(await row(id)).toEqual({ status: 'failed', attempts: 1, reason: 'the worker stopped while sending' });
		expect(alertMails()).toBe(before);
	});

	it('one still inside its lease is another worker’s: left sending, not claimed or failed (positive control: a pending one beside it goes)', async () => {
		const held = await delivery({ status: 'sending', attempts: 1, lockedFor: '5 minutes' });
		const [rule] = await asOwner(`SELECT id FROM alert_rule WHERE project_id = $1 AND kind = 'job_dead'`, [projectId]);
		const [other] = await asOwner(
			`INSERT INTO alert_event (rule_id, project_id, state, value, detail) VALUES ($1, $2, 'cleared', 1, '{"count":1}') RETURNING id`,
			[rule.id, projectId]
		);
		await asOwner(`INSERT INTO alert_delivery (event_id, user_id, project_id, mode) VALUES ($1, $2, $3, 'immediate')`, [other.id, owner.id, projectId]);
		const before = alertMails();
		expect((await sendAlerts()).sent).toBe(1);
		expect(alertMails()).toBe(before + 1);
		expect(await row(held)).toEqual({ status: 'sending', attempts: 1, reason: null });
		expect((await row(other.id))!.status).toBe('sent');
	});
});
