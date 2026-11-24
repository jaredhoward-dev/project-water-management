// The operator's confirmation that someone acts for a project's responsible
// authority (authority_confirm_by_operator, 229_authority_delegates, issue
// #523 G5), on a schema-owner connection. Two callers: the local script
// (scripts/authority-confirm.ts) and the migrate Lambda's authority-confirm
// action (ops/ownerActions.ts, production). No dotenv here: the migrate
// Lambda bundles this module.
import type pg from 'pg';

/** Nobody has the address (or id). `message` quotes it (the local script's terminal); a public answer says only the code. */
export class NoPersonError extends Error {
	readonly code = 'no_person';
	constructor(who: string) {
		super(who.includes('@') ? `no account with the address ${who}` : `no person ${who}`);
		this.name = 'NoPersonError';
	}
}

/**
 * Who to confirm: an address (lowercased; the local script and the operator's
 * direct invoke) or the person's id (the billing-admin workflow, whose public
 * run never carries an address).
 */
export type Person = string | { email: string } | { userId: string };

/** Confirm the person for the project; returns their id and display name. */
export async function confirmAuthorityDelegate(client: pg.ClientBase, projectId: string, person: Person, reference: string): Promise<{ userId: string; name: string }> {
	const p = typeof person === 'string' ? { email: person } : person;
	const { rows } =
		'email' in p
			? await client.query<{ id: string; name: string }>('SELECT id, display_name AS name FROM app_user WHERE lower(email::text) = $1', [p.email])
			: await client.query<{ id: string; name: string }>('SELECT id, display_name AS name FROM app_user WHERE id = $1', [p.userId]);
	if (!rows[0]) throw new NoPersonError('email' in p ? p.email : p.userId);
	await client.query('SELECT authority_confirm_by_operator($1, $2, $3)', [projectId, rows[0].id, reference]);
	return { userId: rows[0].id, name: rows[0].name };
}
