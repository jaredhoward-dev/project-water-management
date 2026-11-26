// What an account deletion used to leave behind (383_erase_handover_and_invites;
// docs/security.md § Personal information (POPIA)): the leaver's name in a team
// project's hand-over event, and invites addressed to the person. The operator
// deletes the app_user row as the schema owner, as account-deletion.db.test.ts
// does; every case has a positive control that keeps another person's data.
import { describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
const tag = crypto.randomUUID().slice(0, 8);

const subjects = async (pid: string, kind: string) =>
	(await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = $2 ORDER BY id`, [pid, kind])).map((r) => r.subject as Record<string, unknown>);
const allEvents = async (pid: string) => JSON.stringify(await asOwner(`SELECT actor_label, subject FROM audit_event WHERE project_id = $1`, [pid]));

/** A team made by `admin`, with `creator` a member who made a team project, so leaving hands it to the admin. */
async function teamWithCreator(name: string) {
	const [admin, creator] = (await Promise.all([`${name}Admin`, `${name}Creator`].map((n) => signUp(n)))) as [User, User];
	const teamId = (await admin.call('POST', '/teams', { name: `${name} ${tag}` })).body.team.id as string;
	expect((await admin.call('POST', `/teams/${teamId}/members`, { email: creator.email, role: 'member' })).status).toBe(201);
	const teamProject = (await creator.call('POST', '/projects', { name: `${name} team project`, teamId })).body.project.id as string;
	return { admin, creator, teamId, teamProject };
}

describe('deleting the account of a member whose team project was handed over', () => {
	it('removed by an admin: the hand-over no longer names them; the admin keeps their name (positive control)', async () => {
		const { admin, creator, teamId, teamProject } = await teamWithCreator('EraseRemoved');
		expect((await admin.call('DELETE', `/teams/${teamId}/members/${creator.id}`)).status).toBe(204);
		expect(await subjects(teamProject, 'member.added')).toContainEqual(
			expect.objectContaining({ userId: admin.id, displayName: 'EraseRemovedAdmin', handedFrom: 'EraseRemovedCreator', handedFromId: creator.id })
		);

		await asOwner('DELETE FROM app_user WHERE id = $1', [creator.id]);

		expect(await subjects(teamProject, 'member.added')).toContainEqual(
			expect.objectContaining({ userId: admin.id, displayName: 'EraseRemovedAdmin', handedFrom: 'Deleted user' })
		);
		expect(await allEvents(teamProject)).not.toContain('EraseRemovedCreator');
		expect(await allEvents(teamProject)).toContain('EraseRemovedAdmin');
	});

	it('left by themselves: the same', async () => {
		const { admin, creator, teamId, teamProject } = await teamWithCreator('EraseLeft');
		expect((await creator.call('DELETE', `/teams/${teamId}/members/${creator.id}`)).status).toBe(204);
		expect(await allEvents(teamProject)).toContain('EraseLeftCreator');

		await asOwner('DELETE FROM app_user WHERE id = $1', [creator.id]);

		expect(await subjects(teamProject, 'member.added')).toContainEqual(expect.objectContaining({ userId: admin.id, handedFrom: 'Deleted user' }));
		expect(await allEvents(teamProject)).not.toContain('EraseLeftCreator');
	});

	it('an event written before handedFromId is matched through its member.removed event', async () => {
		const { admin, creator, teamId, teamProject } = await teamWithCreator('EraseLegacy');
		const { teamProject: otherProject, creator: stays, teamId: otherTeam, admin: otherAdmin } = await teamWithCreator('EraseLegacyKept');
		expect((await admin.call('DELETE', `/teams/${teamId}/members/${creator.id}`)).status).toBe(204);
		expect((await otherAdmin.call('DELETE', `/teams/${otherTeam}/members/${stays.id}`)).status).toBe(204);
		// As events written before 383 look: no handedFromId.
		await asOwner(`UPDATE audit_event SET subject = subject - 'handedFromId' WHERE project_id = ANY ($1::uuid[]) AND subject ? 'handedFrom'`, [[teamProject, otherProject]]);

		await asOwner('DELETE FROM app_user WHERE id = $1', [creator.id]);

		expect(await subjects(teamProject, 'member.added')).toContainEqual(expect.objectContaining({ userId: admin.id, handedFrom: 'Deleted user' }));
		// Positive control: another team's hand-over from a member whose account stays keeps their name.
		expect(await subjects(otherProject, 'member.added')).toContainEqual(expect.objectContaining({ handedFrom: 'EraseLegacyKeptCreator' }));
	});
});

describe('deleting the account of a person with invites addressed to them', () => {
	it('removes the invites to their address, live and expired; another person’s invite stays (positive control)', async () => {
		const owner = await signUp('EraseInviter');
		const [invitee, bystander] = (await Promise.all(['EraseInvitee', 'EraseBystander'].map((n) => signUp(n, { acceptInvites: false })))) as [User, User];
		const live = (await owner.call('POST', '/projects', { name: 'Erase invites live' })).body.project.id as string;
		const lapsed = (await owner.call('POST', '/projects', { name: 'Erase invites lapsed' })).body.project.id as string;
		for (const pid of [live, lapsed]) {
			for (const u of [invitee, bystander]) expect((await owner.call('POST', `/projects/${pid}/members`, { email: u.email, role: 'viewer' })).status).toBe(201);
		}
		// One of them expired, as app_purge_invites keeps it for 90 days.
		await asOwner(`UPDATE invite SET expires_at = now() - interval '1 day' WHERE project_id = $1`, [lapsed]);
		expect(await asOwner('SELECT count(*)::int AS n FROM invite WHERE email = $1', [invitee.email])).toEqual([{ n: 2 }]);

		await asOwner('DELETE FROM app_user WHERE id = $1', [invitee.id]);

		expect(await asOwner('SELECT 1 FROM invite WHERE email = $1', [invitee.email])).toEqual([]);
		expect(await asOwner('SELECT count(*)::int AS n FROM invite WHERE email = $1', [bystander.email])).toEqual([{ n: 2 }]);
	});
});
