// The migrate Lambda's owner actions against Postgres (ops/ownerActions.ts,
// lambda-migrate.ts ownerAction; docs/deployment.md § Owner actions). Each
// does what the local script does (scripts/billing-grant.ts,
// billing-report.ts, authority-confirm.ts): the same rows written, the same
// report. Its answer and its failure never carry the address it was given
// (the billing-admin workflow's log is public). Runs under the workspace's
// skewed TZ (CLAUDE.md rule 7): `until` is a South African date.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { OWNER_URL } from '../__tests__/test-db.js';
import { ownerAction } from '../lambda-migrate.js';
import { redact } from '../billing/metrics.js';
import { type GrantArgs, parseArgs, runGrant } from '../../scripts/billing-grant.js';
import { gatherReport } from '../../scripts/billing-report.js';

type User = Awaited<ReturnType<typeof signUp>>;
const context = { logGroupName: '/aws/lambda/wm-migrate', logStreamName: 'stream', awsRequestId: 'req-1' };
/** Through the Lambda's entry, on the local owner connection. */
const lambda = (event: unknown) => ownerAction(event, context, async () => OWNER_URL);
/** The failure's public summary, and whether the address leaked into it. */
const failure = async (event: unknown, address?: string) => {
	vi.spyOn(console, 'error').mockImplementation(() => {});
	const err = (await lambda(event).catch((e: Error) => e)) as Error;
	expect(err).toBeInstanceOf(Error);
	if (address) {
		expect(err.message).not.toContain(address);
		expect(err.stack).not.toContain(address);
	}
	return JSON.parse(err.message) as { code: string; reason: string };
};
const script = (argv: string[]) => {
	const args = parseArgs(argv, 'octocat');
	if (typeof args === 'string') throw new Error(args);
	return runGrant(OWNER_URL, args as GrantArgs);
};
const accountOf = async (u: User) => (await u.call('GET', '/account/plan')).body.account.id as string;
const planOf = async (u: User) => (await u.call('GET', '/account/plan')).body.plan.code as string;
const rows = async (account: string) =>
	(await asOwner(
		`SELECT l.action, l.plan_code, l.until, l.reason, l.granted_by, s.status, s.period_end, s.cancel_at_period_end, s.provider
		 FROM billing_grant_log l JOIN subscription s ON s.id = l.subscription_id WHERE l.billing_account_id = $1 ORDER BY l.created_at, l.id`,
		[account]
	)) as Record<string, unknown>[];

let viaLambda: User;
let viaScript: User;
beforeAll(async () => {
	[viaLambda, viaScript] = (await Promise.all(['OwnerActLambda', 'OwnerActScript'].map((n) => signUp(n)))) as [User, User];
});

describe('billing-grant, billing-grants, billing-revoke through the migrate Lambda', () => {
	const reason = 'Invoice INV-0042: Team, one year';

	it('grants as the script does: the same subscription and log rows, the reason as given; no address in the answer', async () => {
		const out = await lambda({ action: 'billing-grant', email: viaLambda.email.toUpperCase(), plan: 'team', until: '2099-03-31', reason, by: 'octocat' });
		await script([viaScript.email, 'team', '--until', '2099-03-31', '--reason', reason]);
		const account = await accountOf(viaLambda);
		expect(out).toEqual({ action: 'billing-grant', accountId: account, kind: 'user', plan: 'team', seats: 3, endsAt: '2099-04-01 00:00', replaced: false });
		expect(JSON.stringify(out)).not.toContain('@');
		expect(await planOf(viaLambda)).toBe('team');
		const lambdaRows = await rows(account);
		expect(lambdaRows).toEqual(await rows(await accountOf(viaScript)));
		expect(lambdaRows).toMatchObject([{ action: 'grant', reason, granted_by: 'octocat', provider: 'manual', cancel_at_period_end: true }]);
	});

	it('refuses a second grant without replace (no address in the failure), and replaces with it', async () => {
		expect(await failure({ action: 'billing-grant', email: viaLambda.email, plan: 'pro', reason: 'Founding user', by: 'octocat' }, viaLambda.email)).toMatchObject({
			code: 'live_subscription'
		});
		const out = await lambda({ action: 'billing-grant', email: viaLambda.email, plan: 'pro', reason: 'Founding user', by: 'octocat', replace: true });
		expect(out).toMatchObject({ plan: 'pro', endsAt: null, replaced: true });
		expect((await rows(await accountOf(viaLambda))).map((r) => r.action)).toEqual(['grant', 'revoke', 'grant']);
	});

	it('lists one account’s log (reasons as written, no address) and every live grant (ids only)', async () => {
		const account = await accountOf(viaLambda);
		const one = await lambda({ action: 'billing-grants', email: viaLambda.email });
		expect(one).toMatchObject({ action: 'billing-grants', kind: 'user', accountId: account, planNow: 'pro' });
		expect((one as { log: { action: string; reason: string }[] }).log.map((r) => [r.action, r.reason])).toEqual([
			['grant', reason],
			['revoke', 'replaced: Founding user'],
			['grant', 'Founding user']
		]);
		expect(JSON.stringify(one)).not.toContain('@');
		const all = (await lambda({ action: 'billing-grants' })) as unknown as { kind: string; grants: { accountId: string; ownerId: string; kind: string; plan: string }[] };
		expect(all.kind).toBe('all');
		expect(all.grants).toContainEqual(expect.objectContaining({ accountId: account, ownerId: viaLambda.id, kind: 'user', plan: 'pro', until: null }));
		expect(JSON.stringify(all)).not.toContain('@');
	});

	it('revokes as the script does, then refuses a second revoke', async () => {
		const out = await lambda({ action: 'billing-revoke', email: viaLambda.email, reason: 'Pilot ended', by: 'octocat' });
		expect(out).toEqual({ action: 'billing-revoke', accountId: await accountOf(viaLambda), kind: 'user', plan: 'pro' });
		expect(await planOf(viaLambda)).toBe('free');
		await script([viaScript.email, '--revoke', '--reason', 'Pilot ended']);
		const [l, s] = [await rows(await accountOf(viaLambda)), await rows(await accountOf(viaScript))];
		expect(l.at(-1)).toMatchObject({ action: 'revoke', reason: 'Pilot ended', granted_by: 'octocat', status: 'canceled' });
		// The same row as the script's revoke (its grant was Team, never replaced; the times differ).
		const same = ({ action, reason, granted_by, status, provider, cancel_at_period_end }: Record<string, unknown> = {}) => ({ action, reason, granted_by, status, provider, cancel_at_period_end });
		expect(same(l.at(-1))).toEqual(same(s.at(-1)));
		expect(await failure({ action: 'billing-revoke', email: viaLambda.email, reason: 'again', by: 'octocat' }, viaLambda.email)).toMatchObject({ code: 'no_live_grant' });
	});

	it('names nobody: an unknown address or team is a code, never the address', async () => {
		const address = `nobody-${crypto.randomUUID()}@example.org`;
		expect(await failure({ action: 'billing-grant', email: address, plan: 'pro', reason: 'x', by: 'octocat' }, address)).toMatchObject({ code: 'no_person' });
		expect(await failure({ action: 'billing-grants', teamId: crypto.randomUUID() })).toMatchObject({ code: 'no_team' });
		// Nothing was made for the unknown address.
		expect(await asOwner('SELECT 1 FROM app_user WHERE email = $1', [address])).toEqual([]);
	});
});

describe('the workflow’s id targets and the operator’s private lookup', () => {
	let person: User;
	let teamId: string;
	beforeAll(async () => {
		person = await signUp('OwnerActIds');
		const team = await person.call('POST', '/teams', { name: 'Owner action ids team' });
		expect(team.status).toBe(201);
		teamId = team.body.team.id;
	});

	it('looks up a person with no billing account by address: their id, no account, Free; writes nothing', async () => {
		const out = await lambda({ action: 'billing-account', email: person.email.toUpperCase() });
		expect(out).toEqual({ action: 'billing-account', kind: 'user', ownerId: person.id, accountId: null, planNow: 'free' });
		expect(JSON.stringify(out)).not.toContain('@');
		expect(await asOwner('SELECT 1 FROM billing_account WHERE user_id = $1', [person.id])).toEqual([]);
	});

	it('grants to the person by id (making the account), as the workflow sends it; then names the account by id', async () => {
		const out = await lambda({ action: 'billing-grant', via: 'workflow', userId: person.id, plan: 'pro', reason: 'Founding user', by: 'octocat', replace: false });
		const account = await accountOf(person);
		expect(out).toEqual({ action: 'billing-grant', accountId: account, kind: 'user', plan: 'pro', seats: 1, endsAt: null, replaced: false });
		// Seats as `--seats` (374, issue #891): Pro sells no extra seats, so the database refuses 2, before it looks at the live grant.
		expect(
			await failure({ action: 'billing-grant', via: 'workflow', accountId: account, plan: 'pro', seats: 2, reason: 'More seats', by: 'octocat', replace: true })
		).toMatchObject({ code: 'invalid' });
		expect(await lambda({ action: 'billing-account', email: person.email })).toEqual({ action: 'billing-account', kind: 'user', ownerId: person.id, accountId: account, planNow: 'pro' });
		expect(await lambda({ action: 'billing-grants', via: 'workflow', accountId: account })).toMatchObject({ action: 'billing-grants', kind: 'user', accountId: account, planNow: 'pro' });
		expect(await lambda({ action: 'billing-revoke', via: 'workflow', accountId: account, reason: 'Pilot ended', by: 'octocat' })).toEqual({
			action: 'billing-revoke',
			accountId: account,
			kind: 'user',
			plan: 'pro'
		});
		expect(await planOf(person)).toBe('free');
	});

	it('names a team’s account by its account id, with the team’s kind', async () => {
		const looked = (await lambda({ action: 'billing-account', teamId })) as unknown as { kind: string; ownerId: string; accountId: string | null };
		expect(looked).toMatchObject({ kind: 'team', ownerId: teamId });
		const granted = (await lambda({ action: 'billing-grant', via: 'workflow', teamId, plan: 'team', until: '2099-01-31', reason: 'Invoice INV-7', by: 'octocat', replace: false })) as unknown as {
			accountId: string;
		};
		expect(await lambda({ action: 'billing-grants', via: 'workflow', accountId: granted.accountId })).toMatchObject({ kind: 'team', accountId: granted.accountId, planNow: 'team' });
		expect(await lambda({ action: 'billing-revoke', via: 'workflow', accountId: granted.accountId, reason: 'ended', by: 'octocat' })).toMatchObject({ kind: 'team', plan: 'team' });
	});

	it('refuses an unknown account, person or team id as a code; and the workflow’s address, before anything connects', async () => {
		expect(await failure({ action: 'billing-grants', via: 'workflow', accountId: crypto.randomUUID() })).toMatchObject({ code: 'no_billing_account' });
		expect(await failure({ action: 'billing-grant', via: 'workflow', accountId: crypto.randomUUID(), plan: 'pro', reason: 'x', by: 'octocat' })).toMatchObject({
			code: 'no_billing_account'
		});
		expect(await failure({ action: 'billing-account', userId: crypto.randomUUID() })).toMatchObject({ code: 'no_person' });
		expect(await failure({ action: 'billing-account', teamId: crypto.randomUUID() })).toMatchObject({ code: 'no_team' });
		const address = `nobody-${crypto.randomUUID()}@example.org`;
		expect(await failure({ action: 'billing-account', email: address }, address)).toMatchObject({ code: 'no_person' });
		expect(await failure({ action: 'billing-grants', via: 'workflow', email: person.email }, person.email)).toMatchObject({ code: 'refused' });
		expect(await failure({ action: 'billing-account', via: 'workflow', email: person.email }, person.email)).toMatchObject({ code: 'refused' });
	});
});

describe('billing-report through the migrate Lambda', () => {
	it('answers with the script’s report, redacted (no address)', async () => {
		const out = (await lambda({ action: 'billing-report', month: '2001-03' })) as unknown as { action: string; report: Record<string, unknown> };
		const local = redact(await gatherReport(OWNER_URL, '2001-03'));
		expect(out.action).toBe('billing-report');
		expect({ ...out.report, generatedAt: null }).toEqual({ ...local, generatedAt: null });
		expect(JSON.stringify(out)).not.toMatch(/[^\s"@]+@[^\s"@]+/);
	});
});

describe('authority-confirm through the migrate Lambda', () => {
	let owner: User;
	let viewer: User;
	let projectId: string;
	beforeAll(async () => {
		[owner, viewer] = (await Promise.all(['OwnerActAuOwner', 'OwnerActAuViewer'].map((n) => signUp(n)))) as [User, User];
		projectId = (await owner.call('POST', '/projects', { name: 'Owner action authority' })).body.project.id;
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	});

	it('confirms an editor or owner as the script does (History: by Operator, with the reference); no name or address in the answer', async () => {
		const out = await lambda({ action: 'authority-confirm', projectId, email: owner.email, reference: 'CMA letter 2026/07' });
		expect(out).toEqual({ action: 'authority-confirm', projectId, userId: owner.id, confirmed: true });
		expect(JSON.stringify(out)).not.toContain('@');
		expect(await asOwner('SELECT confirmed_at IS NOT NULL AS confirmed FROM authority_delegate WHERE project_id = $1 AND user_id = $2', [projectId, owner.id])).toEqual([
			{ confirmed: true }
		]);
		const events = await asOwner(`SELECT actor_label, subject FROM audit_event WHERE project_id = $1 AND kind = 'authority.confirmed'`, [projectId]);
		expect(events).toMatchObject([{ actor_label: 'Operator', subject: { userId: owner.id, via: 'operator', reference: 'CMA letter 2026/07' } }]);
	});

	it('confirms by the person’s id, as the workflow sends it (no address anywhere in the payload)', async () => {
		const other = await signUp('OwnerActAuById');
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: other.email, role: 'editor' })).status).toBe(201);
		const out = await lambda({ action: 'authority-confirm', via: 'workflow', projectId, userId: other.id, reference: 'CMA letter 2026/08' });
		expect(out).toEqual({ action: 'authority-confirm', projectId, userId: other.id, confirmed: true });
		expect(await asOwner('SELECT confirmed_at IS NOT NULL AS confirmed FROM authority_delegate WHERE project_id = $1 AND user_id = $2', [projectId, other.id])).toEqual([
			{ confirmed: true }
		]);
		expect(await failure({ action: 'authority-confirm', via: 'workflow', projectId, userId: crypto.randomUUID(), reference: 'letter' })).toMatchObject({ code: 'no_person' });
		expect(await failure({ action: 'authority-confirm', via: 'workflow', projectId, email: other.email, reference: 'letter' }, other.email)).toMatchObject({ code: 'refused' });
	});

	it('refuses a viewer (not_editor), without the address', async () => {
		expect(await failure({ action: 'authority-confirm', projectId, email: viewer.email, reference: 'letter' }, viewer.email)).toMatchObject({ code: 'not_editor' });
	});
});
