// The data-subject export, GET /auth/me/export (054_subject_export.sql,
// auth/export.ts; docs/security.md § Personal information (POPIA)). A farmer
// gets their own account, link, farm figures, registered volumes, notes,
// invites and audit events, and nothing of the other farmer's: every "not in
// it" check has the other farmer's own export as its positive control.
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { FARMER_NOTICE_VERSION, LEGAL_VERSION } from '@water-management/engine/legal';
import { reverseTrialHash } from '../billing/reverseTrial.js';
import { withUser } from '../db/tx.js';
import { canonicalEmail } from '../billing/metrics.js';
import { APP_USER_EXCLUDED, APP_USER_EXPORTED, EXPORT_COOLDOWN_SECONDS, MEMBER_FK_COVERAGE, USER_FK_COVERAGE } from './export.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ORIGIN = 'http://localhost:7777';
let owner: User;
let farmer: User;
let other: User;
let projectId: string;
let secondProjectId: string;
const outlet = node('Outlet', null);
const farmA = node('Farm Alpha', outlet.id);
const farmB = node('Farm Bravo', outlet.id);
const TOKEN_HEX = 'cd'.repeat(32);
const NONCE_HEX = 'ab'.repeat(32);
const UNSUB_HEX = 'ef'.repeat(32);

/** The export as a browser downloads it; the cooldown is cleared first so each test can call it. */
async function download(u: { cookie: string; id: string }) {
	await asOwner('UPDATE app_user SET data_exported_at = NULL WHERE id = $1', [u.id]);
	const res = await app.request('/auth/me/export', { headers: { cookie: u.cookie, origin: ORIGIN } });
	const text = await res.text();
	return { res, text, doc: (res.status === 200 ? JSON.parse(text) : null) as Doc };
}

beforeAll(async () => {
	[owner, farmer, other] = (await Promise.all(['XOwner', 'XFarmer', 'XOther'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Export catchment' })).body.project.id;
	const model = { nodes: [outlet, farmA, farmB], crops: [], cropAreas: [], transfers: [], landCover: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(300) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 12 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2022-10-01', values: rain })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: other.email, nodeIds: [farmB.id] })).status).toBe(201);
	const runId = (await owner.call('POST', `/projects/${projectId}/runs`, { label: 'r' })).body.run.id;
	expect((await owner.call('POST', `/projects/${projectId}/publication`, { runId })).status).toBe(201);
	for (const [nodeId, holder, reg] of [[farmA.id, 'Holder Alpha', 'REG-ALPHA'], [farmB.id, 'Holder Bravo', 'REG-BRAVO']] as const) {
		const res = await owner.call('POST', `/projects/${projectId}/allocations`, {
			nodeId, holder, registrationNo: reg, authorisation: 'registration', waterSource: 'surface', volumeM3PerYear: 12_000
		});
		expect(res.status).toBe(201);
	}
	expect((await farmer.call('POST', `/projects/${projectId}/notes`, { body: 'alpha note by the farmer', nodeId: farmA.id, visibility: 'farm' })).status).toBe(201);
	// The farmer pressed "I understand" on the farm view's notice (093); the other farmer never did.
	expect((await farmer.call('POST', '/auth/me/farm-notice', { version: FARMER_NOTICE_VERSION })).status).toBe(200);
	expect((await other.call('POST', `/projects/${projectId}/notes`, { body: 'bravo note by the other', nodeId: farmB.id, visibility: 'farm' })).status).toBe(201);
	// A lapsed invite to the farmer's address, to a project they never joined (only an owner reads it under RLS).
	secondProjectId = (await owner.call('POST', '/projects', { name: 'Invited catchment' })).body.project.id;
	await asOwner(
		`INSERT INTO invite (email, project_id, project_role, invited_by, token_hash, expires_at, created_at)
		 VALUES ($1, $2, 'viewer', $3, decode($4, 'hex'), now() - interval '1 day', now() - interval '8 days')`,
		[farmer.email, secondProjectId, owner.id, TOKEN_HEX]
	);
	// An alert choice, with the unsubscribe secrets the export must leave out.
	await asOwner(
		`INSERT INTO alert_subscription (user_id, project_id, kind, mode, unsubscribe_nonce, unsubscribe_hash)
		 VALUES ($1, $2, 'all', 'immediate', decode($3, 'hex'), decode($4, 'hex'))`,
		[farmer.id, projectId, NONCE_HEX, UNSUB_HEX]
	);
}, 60_000);

describe('GET /auth/me/export', () => {
	it('refuses without a session', async () => {
		const res = await anon('GET', '/auth/me/export');
		expect(res.status).toBe(401);
		expect(JSON.stringify(res.body)).not.toMatch(/relation|column|syntax/i);
	});

	it('downloads a JSON file, not cached', async () => {
		const { res, doc } = await download(farmer);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/^application\/json/);
		expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="my-data_\d{4}-\d{2}-\d{2}\.json"$/);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(doc).toMatchObject({ format: 'water-management.subject-export', version: 1 });
	});

	it('gives the farmer their account, membership and farm link, with the farm’s figures and registered volume', async () => {
		const { doc } = await download(farmer);
		expect(doc.account).toMatchObject({ id: farmer.id, email: farmer.email, displayName: 'XFarmer' });
		expect(doc.account.dataExportedAt).toEqual(expect.any(String));
		// Whether SES suppressed the address (057): nothing here, so all null.
		expect(doc.account).toMatchObject({ mailSuppressedAt: null, mailSuppressedReason: null, mailResumedAt: null });
		// The terms the account accepted at sign-up, and when (087).
		expect(doc.account).toMatchObject({ termsVersion: LEGAL_VERSION, termsAcceptedAt: expect.any(String) });
		// The farm view notice they acknowledged, and when (093); the other farmer's export has none (positive control's twin).
		expect(doc.account).toMatchObject({ farmNoticeVersion: FARMER_NOTICE_VERSION, farmNoticeAcceptedAt: expect.any(String) });
		expect((await download(other)).doc.account).toMatchObject({ farmNoticeVersion: null, farmNoticeAcceptedAt: null });
		expect(doc.projectMemberships).toEqual([expect.objectContaining({ projectId, projectName: 'Export catchment', role: 'farmer' })]);
		expect(doc.farms).toHaveLength(1);
		const farm = doc.farms[0];
		expect(farm).toMatchObject({ projectId, nodeId: farmA.id, farmName: 'Farm Alpha', linkedBy: 'XOwner' });
		expect(farm.allocations).toEqual([expect.objectContaining({ holderName: 'Holder Alpha', registrationNo: 'REG-ALPHA', volumeM3Year: 12_000, waterUse: '21a' })]);
		expect(farm.publication?.figures?.name).toBe('Farm Alpha');
		expect(farm.publication.restriction.level).toEqual(expect.any(String));
	});

	it('gives the notes they wrote, the lapsed invite to their address and their alert choices', async () => {
		const { doc } = await download(farmer);
		expect(doc.notes.map((n: Doc) => n.body)).toEqual(['alpha note by the farmer']);
		expect(doc.invites).toEqual([expect.objectContaining({ projectId: secondProjectId, projectName: 'Invited catchment', projectRole: 'viewer', invitedBy: 'XOwner' })]);
		expect(doc.alertSubscriptions).toEqual([expect.objectContaining({ projectId, kind: 'all', mode: 'immediate' })]);
	});

	it('gives the audit events about or by them, and only those', async () => {
		const { doc } = await download(farmer);
		const kinds = (doc.auditEvents as Doc[]).map((e) => e.kind);
		expect(kinds).toEqual(expect.arrayContaining(['member.added', 'farmer.linked']));
		// Made by accepting the invite, so theirs (issue #136).
		expect((doc.auditEvents as Doc[]).filter((e) => e.kind === 'farmer.linked').every((e) => e.byYou)).toBe(true);
		for (const e of doc.auditEvents as Doc[]) {
			expect(e.byYou || e.subject?.userId === farmer.id || e.subject?.authorId === farmer.id).toBe(true);
		}
		expect(doc.auditEventsTruncated).toBe(false);
	});

	it('holds nothing of the other farmer’s, who gets their own (positive control)', async () => {
		const { text: mine } = await download(farmer);
		for (const theirs of [other.id, other.email, 'XOther', 'Farm Bravo', farmB.id, 'Holder Bravo', 'REG-BRAVO', 'bravo note by the other']) {
			expect(mine).not.toContain(theirs);
		}
		const { doc } = await download(other);
		expect(doc.farms.map((f: Doc) => f.farmName)).toEqual(['Farm Bravo']);
		expect(doc.farms[0].allocations.map((a: Doc) => a.holderName)).toEqual(['Holder Bravo']);
		expect(doc.notes.map((n: Doc) => n.body)).toEqual(['bravo note by the other']);
		expect(doc.invites).toEqual([]);
		expect(JSON.stringify(doc)).not.toContain('Holder Alpha');
	});

	it('never holds a secret: no password hash, token hash or unsubscribe material', async () => {
		const { text } = await download(farmer);
		expect(text).not.toMatch(/\$2[aby]\$/);
		expect(text).not.toMatch(/password|tokenHash|token_hash|unsubscribe|nonce/i);
		for (const hex of [TOKEN_HEX, NONCE_HEX, UNSUB_HEX]) expect(text).not.toContain(hex);
	});

	it('leaves out invites to an address the account hasn’t verified', async () => {
		const unverified = await signUp('XUnverified', { verified: false });
		await asOwner(
			`INSERT INTO invite (email, project_id, project_role, invited_by, token_hash, expires_at)
			 VALUES ($1, $2, 'viewer', $3, decode($4, 'hex'), now() - interval '1 day')`,
			[unverified.email, secondProjectId, owner.id, 'aa'.repeat(32)]
		);
		const { doc } = await download(unverified);
		expect(doc.invites).toEqual([]);
		expect(await asOwner('SELECT count(*)::int AS n FROM invite WHERE email = $1', [unverified.email])).toEqual([{ n: 1 }]);
	});

	it('gives the owner their memberships and the events they made', async () => {
		const { doc } = await download(owner);
		expect(doc.projectMemberships.map((m: Doc) => m.projectName).sort()).toEqual(['Export catchment', 'Invited catchment']);
		// The owner invited the farmers; the farm links are the farmers' own, made by accepting (issue #136).
		expect((doc.auditEvents as Doc[]).some((e) => e.byYou && e.kind === 'invite.sent')).toBe(true);
		expect((doc.auditEvents as Doc[]).some((e) => e.byYou && e.kind === 'farmer.linked')).toBe(false);
		// Their publication, with its notice and window but not the per-farm figures (the decision log, issue #119), which the log itself keeps.
		const published = (doc.auditEvents as Doc[]).find((e) => e.byYou && e.kind === 'publication.published');
		expect(published?.subject).toMatchObject({ farms: expect.any(Number), restriction: { level: 'none' }, window: { dataUntil: expect.any(String) } });
		expect(published?.subject).not.toHaveProperty('perFarm');
		const [kept] = await asOwner(`SELECT subject FROM audit_event WHERE id = $1`, [published!.id]);
		expect(kept.subject.perFarm).toHaveLength(published!.subject.farms);
		expect(doc.farms).toEqual([]);
		expect(doc.invites).toEqual([]);
	});

	it('gives the person their own billing account, its subscriptions and counters (323); none to someone who never needed one, nor a team’s', async () => {
		const [acct] = await asOwner('SELECT id FROM billing_account WHERE user_id = $1', [owner.id]);
		expect(acct).toBeDefined();
		// A team the owner runs, with its own account: the team's, never in the person's export.
		const teamId = (await owner.call('POST', '/teams', { name: 'Export WUA' })).body.team.id as string;
		await asOwner(`INSERT INTO billing_account (kind, team_id) VALUES ('team', $1) ON CONFLICT (team_id) DO NOTHING`, [teamId]);
		const [teamAcct] = await asOwner('SELECT id FROM billing_account WHERE team_id = $1', [teamId]);
		const [sub] = await asOwner(
			`INSERT INTO subscription (billing_account_id, plan_code, status, provider, external_ref, seats, billing_interval) VALUES ($1, 'pro', 'canceled', 'manual', 'export-test-ref', 1, 'year') RETURNING id`,
			[acct.id]
		);
		// A renewal notice sent to them (329): as the schema owner, the pipeline isn't under test.
		await asOwner(
			`INSERT INTO renewal_notice (subscription_id, period_end, user_id, status, sent_at, settled_at) VALUES ($1, '2027-03-01T10:00:00Z', $2, 'sent', now(), now())`,
			[sub.id, owner.id]
		);
		// A plan email sent to them (346) about a team they administer, and one about their own account.
		await asOwner(
			`INSERT INTO billing_notice (billing_account_id, kind, about, user_id, status, sent_at, settled_at) VALUES ($1, 'grace', '2026-11-01T10:00:00Z', $2, 'sent', now(), now())`,
			[teamAcct.id, owner.id]
		);
		await asOwner(
			`INSERT INTO billing_notice (billing_account_id, kind, about, user_id, status) VALUES ($1, 'trial_ending', '2026-12-01T10:00:00Z', $2, 'skipped')`,
			[acct.id, owner.id]
		);
		await asOwner(`INSERT INTO usage_counter (billing_account_id, kind, month, qty) VALUES ($1, 'reports', '2026-10-01', 4)`, [acct.id]);
		// A staff grant's log row (330), as the schema owner; and one on the team's account, which isn't theirs.
		await asOwner(`INSERT INTO billing_grant_log (billing_account_id, action, plan_code, reason, granted_by) VALUES ($1, 'grant', 'pro', 'Export test grant', 'export-op')`, [acct.id]);
		await asOwner(`INSERT INTO billing_grant_log (billing_account_id, action, plan_code, reason, granted_by) VALUES ($1, 'grant', 'team', 'Team grant', 'export-op')`, [teamAcct.id]);
		await asOwner(`INSERT INTO usage_counter (billing_account_id, kind, month, qty) VALUES ($1, 'reports', '2026-10-01', 9)`, [teamAcct.id]);
		try {
			const { doc, text } = await download(owner);
			expect(doc.billing).toEqual({
				account: { id: acct.id, kind: 'user', projectsCreated: expect.any(Number), externalCustomerRef: null, createdAt: expect.any(String) },
				subscriptions: [expect.objectContaining({ planCode: 'pro', status: 'canceled', provider: 'manual', externalRef: 'export-test-ref', seats: 1, interval: 'year' })],
				usageCounters: expect.arrayContaining([{ kind: 'reports', month: '2026-10', qty: 4 }]),
				renewalNotices: [{ periodEnd: '2027-03-01T10:00:00.000Z', status: 'sent', sentAt: expect.any(String), createdAt: expect.any(String) }],
				planNotices: expect.arrayContaining([
					{ kind: 'grace', about: '2026-11-01T10:00:00.000Z', status: 'sent', sentAt: expect.any(String), createdAt: expect.any(String) },
					{ kind: 'trial_ending', about: '2026-12-01T10:00:00.000Z', status: 'skipped', sentAt: null, createdAt: expect.any(String) }
				]),
				grants: [{ action: 'grant', planCode: 'pro', until: null, reason: 'Export test grant', grantedBy: 'export-op', createdAt: expect.any(String) }]
			});
			expect(doc.billing.usageCounters).not.toContainEqual(expect.objectContaining({ qty: 9 }));
			expect(text).not.toContain(teamAcct.id);
			// The farmer never made a project or opened their plan: no account (and nothing of the owner's).
			const theirs = await download(farmer);
			expect(theirs.doc.billing).toBeNull();
			expect(theirs.text).not.toContain(acct.id);
		} finally {
			await asOwner('DELETE FROM subscription WHERE billing_account_id = $1', [acct.id]);
			await asOwner('DELETE FROM billing_notice WHERE user_id = $1', [owner.id]);
			await asOwner('DELETE FROM billing_grant_log WHERE billing_account_id = ANY($1)', [[acct.id, teamAcct.id]]);
			await asOwner(`DELETE FROM usage_counter WHERE billing_account_id = ANY($1) AND month = '2026-10-01'`, [[acct.id, teamAcct.id]]);
			await asOwner('DELETE FROM team WHERE id = $1', [teamId]);
		}
	});

	it('gives the scenarios the person was added to (scenario_member), and not another member’s (positive control)', async () => {
		const [helper, applicant] = (await Promise.all(['XHelper', 'XApplicant'].map((n) => signUp(n)))) as [User, User];
		for (const u of [helper, applicant]) expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role: 'contributor' })).status).toBe(201);
		// Contributors share an application only within their party (049 app_share_allowed).
		await asOwner(`UPDATE project_member SET party = 'Alpha Farms' WHERE project_id = $1 AND user_id = ANY($2)`, [projectId, [helper.id, applicant.id]]);
		const [run] = await asOwner('SELECT id FROM model_run WHERE project_id = $1 ORDER BY created_at LIMIT 1', [projectId]);
		// As the schema owner, acting as the applicant (the scenario trigger wants a signed-in user).
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		let app1: { id: string };
		try {
			await client.query('BEGIN');
			await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [applicant.id]);
			[app1] = (
				await client.query<{ id: string }>(
					`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256, owner_user_id, origin, status)
					 VALUES ($1, 'Raise the Alpha weir', $2, repeat('0', 64), $3, 'applicant', 'draft') RETURNING id`,
					[projectId, run.id, applicant.id]
				)
			).rows as [{ id: string }];
			await client.query('INSERT INTO scenario_member (scenario_id, project_id, user_id, added_by) VALUES ($1, $2, $3, $4)', [app1.id, projectId, helper.id, applicant.id]);
			await client.query('COMMIT');
		} finally {
			await client.end();
		}
		const membership = { scenarioId: app1.id, projectId, projectName: 'Export catchment', scenarioName: 'Raise the Alpha weir', addedAt: expect.any(String), addedBy: 'XApplicant' };
		const application = {
			scenarioId: app1.id, projectId, projectName: 'Export catchment', name: 'Raise the Alpha weir', origin: 'applicant', status: 'draft',
			outcome: null, createdAt: expect.any(String), submittedAt: null, decidedAt: null
		};
		const mine = await download(helper);
		expect(mine.doc.scenarioMemberships).toEqual([membership]);
		// The helper owns no scenario.
		expect(mine.doc.scenarios).toEqual([]);
		// The applicant made it, so it is in their scenarios (396); they are no member of it, so no row of the helper's.
		const theirs = await download(applicant);
		expect(theirs.doc.scenarioMemberships).toEqual([]);
		expect(theirs.doc.scenarios).toEqual([application]);
		// Nor anyone else's.
		const farmers = await download(farmer);
		expect(farmers.doc.scenarioMemberships).toEqual([]);
		expect(farmers.doc.scenarios).toEqual([]);
		expect(farmers.text).not.toContain('Raise the Alpha weir');
		// #906: the applicant's role drops below contributor (to farmer; the enum runs farmer < contributor < viewer). RLS
		// no longer shows them their draft (positive control: it did before), yet it stands, so the export still carries it
		// (app_subject_scenarios, 396). The helper's share goes with the drop (049 project_member_prune_shares deletes
		// shares the rule no longer allows), so there is nothing of theirs left to export.
		const ownSeen = () =>
			withUser(applicant.id, async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM scenario WHERE id = $1', [app1.id])).rows[0]!.n);
		expect(await ownSeen()).toBe(1);
		await asOwner(`UPDATE project_member SET role = 'farmer' WHERE project_id = $1 AND user_id = $2`, [projectId, applicant.id]);
		try {
			expect(await ownSeen()).toBe(0);
			expect((await download(applicant)).doc.scenarios).toEqual([application]);
			expect(await asOwner('SELECT 1 FROM scenario_member WHERE scenario_id = $1', [app1.id])).toEqual([]);
			expect((await download(helper)).doc.scenarioMemberships).toEqual([]);
			// Still only their own: the farmer's export is unchanged.
			expect((await download(farmer)).doc.scenarios).toEqual([]);
		} finally {
			await asOwner(`UPDATE project_member SET role = 'contributor' WHERE project_id = $1 AND user_id = $2`, [projectId, applicant.id]);
		}
	});

	it('gives the reverse-trial claim of the person’s current address (#906), and never another person’s', async () => {
		// The farmer's claim, stored as app_reverse_trial_start writes it (the hash of the canonical address).
		const mineHex = reverseTrialHash(farmer.email);
		const theirsHex = reverseTrialHash(other.email);
		await asOwner(`INSERT INTO reverse_trial_claim (email_hash, claimed_at) VALUES (decode($1, 'hex'), '2026-11-01T10:00:00Z')`, [mineHex]);
		try {
			const mine = await download(farmer);
			expect(mine.doc.reverseTrialClaim).toEqual({ emailHash: mineHex, claimedAt: expect.stringMatching(/^2026-11-01T10:00:00/) });
			// The other farmer had no trial: null, and no trace of the farmer's hash.
			const theirs = await download(other);
			expect(theirs.doc.reverseTrialClaim).toBeNull();
			expect(theirs.text).not.toContain(mineHex);
			// Positive control: once the other has a claim too, each sees only their own.
			await asOwner(`INSERT INTO reverse_trial_claim (email_hash) VALUES (decode($1, 'hex'))`, [theirsHex]);
			expect((await download(other)).doc.reverseTrialClaim).toEqual({ emailHash: theirsHex, claimedAt: expect.any(String) });
			const again = await download(farmer);
			expect(again.doc.reverseTrialClaim.emailHash).toBe(mineHex);
			expect(again.text).not.toContain(theirsHex);
		} finally {
			await asOwner(`DELETE FROM reverse_trial_claim WHERE encode(email_hash, 'hex') = ANY($1)`, [[mineHex, theirsHex]]);
		}
	});

	it('hashes the canonical address in SQL exactly as reverseTrialHash does (canonical_email, 396, 397), non-ASCII too', async () => {
		const cases = [
			'Plain@Example.com',
			'  spaced@example.com\t',
			'a.b.c+promo@gmail.com',
			'A.B+x@GoogleMail.com',
			'+leading@example.com',
			'dots.kept+tag@example.org',
			'two@at@example.com',
			'@nolocal.com',
			'no-at-sign',
			'first.last+@gmail.com',
			// Non-ASCII (#914): only A-Z is lower-cased, on both sides, and only ASCII whitespace trimmed.
			'İnci@Example.com', // JS toLowerCase gives i + U+0307, Postgres lower() i: kept as written
			'ÉLODIE.Ü@BÜCHER.de',
			'ΣΟΦΙΑ@example.gr', // final sigma
			'Straße@Example.de',
			'ǅemal@example.ba', // titlecase digraph
			'K@example.com', // U+212A Kelvin sign
			'\u00a0nbsp@example.com\u00a0', // a no-break space is not trimmed
			'\ufeffbom@example.com',
			'\u000bvt@example.com\u000b', // vertical tab is
			'Ünï.Cödé+Tag@GoogleMail.com',
			'用户@例子.广告'
		];
		for (const email of cases) {
			const [row] = await asOwner(`SELECT canonical_email($1) AS c, encode(sha256(convert_to(canonical_email($1), 'UTF8')), 'hex') AS h`, [email]);
			expect(row.c, email).toBe(canonicalEmail(email));
			expect(row.h, email).toBe(reverseTrialHash(email));
		}
	});

	it('gives a pending change of address (the new address and when it lapses), never the link’s hash, and not to anyone else', async () => {
		const LINK_HEX = '9a'.repeat(32);
		await asOwner(`INSERT INTO email_change (user_id, new_email, token_hash, expires_at) VALUES ($1, 'farmer-new@example.com', decode($2, 'hex'), now() + interval '2 days')`, [
			farmer.id,
			LINK_HEX
		]);
		try {
			const mine = await download(farmer);
			expect(mine.doc.pendingEmailChange).toEqual({ newEmail: 'farmer-new@example.com', createdAt: expect.any(String), expiresAt: expect.any(String) });
			expect(mine.text).not.toContain(LINK_HEX);
			const theirs = await download(other);
			expect(theirs.doc.pendingEmailChange).toBeNull();
			expect(theirs.text).not.toContain('farmer-new@example.com');
		} finally {
			await asOwner('DELETE FROM email_change WHERE user_id = $1', [farmer.id]);
		}
	});

	it('allows one export a minute per account (429 with Retry-After)', async () => {
		expect((await download(farmer)).res.status).toBe(200);
		const again = await app.request('/auth/me/export', { headers: { cookie: farmer.cookie, origin: ORIGIN } });
		expect(again.status).toBe(429);
		const wait = Number(again.headers.get('retry-after'));
		expect(wait).toBeGreaterThan(0);
		expect(wait).toBeLessThanOrEqual(EXPORT_COOLDOWN_SECONDS);
		// The account page words it from the code, with the wait (docs/api.md § Errors).
		const body = (await again.json()) as { code?: string; params?: { seconds?: number } };
		expect(body.code).toBe('export_throttled');
		expect(body.params?.seconds).toBe(wait);
		// Another account isn't held up (positive control).
		await asOwner('UPDATE app_user SET data_exported_at = NULL WHERE id = $1', [other.id]);
		const theirs = await app.request('/auth/me/export', { headers: { cookie: other.cookie, origin: ORIGIN } });
		expect(theirs.status).toBe(200);
	});
});

describe('app_subject_export (054_subject_export.sql)', () => {
	it('returns nothing without a user', async () => {
		const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
		await client.connect();
		try {
			expect((await client.query('SELECT app_subject_export() AS doc')).rows).toEqual([{ doc: null }]);
		} finally {
			await client.end();
		}
	});
});

describe('export completeness guard', () => {
	let db: pg.Client;
	beforeAll(async () => {
		db = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await db.connect();
		return () => db.end();
	});

	it('lists every foreign key to app_user as exported or deliberately left out (auth/export.ts USER_FK_COVERAGE)', async () => {
		const { rows } = await db.query<{ col: string }>(
			`SELECT c.conrelid::regclass::text || '.' || a.attname AS col
			 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
			 WHERE c.contype = 'f' AND c.confrelid = 'app_user'::regclass ORDER BY 1`
		);
		expect(rows.map((r) => r.col).sort()).toEqual(Object.keys(USER_FK_COVERAGE).sort());
	});

	it('lists every person column reached through project_member or team_member (auth/export.ts MEMBER_FK_COVERAGE)', async () => {
		// A composite key (project_id, user_id) → project_member points at a person as surely as one to app_user.
		const { rows } = await db.query<{ col: string }>(
			`SELECT c.conrelid::regclass::text || '.' || a.attname AS col
			 FROM pg_constraint c
			 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
			 JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = c.confkey[array_position(c.conkey, a.attnum)]
			 WHERE c.contype = 'f' AND c.confrelid IN ('project_member'::regclass, 'team_member'::regclass) AND fa.attname = 'user_id' ORDER BY 1`
		);
		expect(rows.map((r) => r.col).sort()).toEqual(Object.keys(MEMBER_FK_COVERAGE).sort());
	});

	it('lists every app_user column as exported or deliberately left out', async () => {
		const { rows } = await db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'app_user' ORDER BY 1`
		);
		expect(rows.map((r) => r.column_name).sort()).toEqual([...APP_USER_EXPORTED, ...Object.keys(APP_USER_EXCLUDED)].sort());
	});
});
