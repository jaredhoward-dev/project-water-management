// The billing-admin workflow's payload (owner-action.mjs): ids only, never an
// address, and a refusal that names the input but never its value. The
// backend's ops/ownerActions.test.ts parses these payloads with the Lambda's
// own schema.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildPayload, WORKFLOW_ACTIONS } from './owner-action.mjs';

const ACCOUNT = '5c4d3e2f-1a0b-4c9d-8e7f-6a5b4c3d2e1f';
const PERSON = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b';
const TEAM = '0b0e7f4e-2f7c-4a43-9d55-3f1f7a8f1c01';
const PROJECT = '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
/** The dispatch form's defaults, as the event file carries them. */
const blank = { account_id: '', user_id: '', team_id: '', plan: 'none', until: '', replace: false, reason: '', month: '', project_id: '', reference: '' };
const build = (inputs) => buildPayload({ ...blank, ...inputs }, 'octocat');
const errors = (inputs) => {
	const r = build(inputs);
	assert.ok('errors' in r, `expected a refusal for ${JSON.stringify(inputs)}`);
	return r.errors.join('\n');
};

test('builds each action’s payload from ids, marked via workflow', () => {
	assert.deepEqual(build({ action: 'billing-grant', account_id: ACCOUNT.toUpperCase(), plan: 'team', until: '2027-01-31', reason: ' Invoice INV-0042 ' }), {
		payload: { action: 'billing-grant', via: 'workflow', accountId: ACCOUNT, reason: 'Invoice INV-0042', by: 'octocat', plan: 'team', replace: false, until: '2027-01-31' },
	});
	assert.deepEqual(build({ action: 'billing-grant', user_id: PERSON, plan: 'pro', reason: 'Founding user', replace: 'true' }), {
		payload: { action: 'billing-grant', via: 'workflow', userId: PERSON, reason: 'Founding user', by: 'octocat', plan: 'pro', replace: true },
	});
	assert.deepEqual(build({ action: 'billing-revoke', team_id: TEAM, reason: 'Pilot ended' }), {
		payload: { action: 'billing-revoke', via: 'workflow', teamId: TEAM, reason: 'Pilot ended', by: 'octocat' },
	});
	assert.deepEqual(build({ action: 'billing-grants' }), { payload: { action: 'billing-grants', via: 'workflow' } });
	assert.deepEqual(build({ action: 'billing-grants', account_id: ACCOUNT }), { payload: { action: 'billing-grants', via: 'workflow', accountId: ACCOUNT } });
	assert.deepEqual(build({ action: 'billing-report', month: '2026-11' }), { payload: { action: 'billing-report', via: 'workflow', month: '2026-11' } });
	assert.deepEqual(build({ action: 'billing-report' }), { payload: { action: 'billing-report', via: 'workflow' } });
	assert.deepEqual(build({ action: 'authority-confirm', project_id: PROJECT, user_id: PERSON, reference: 'CMA letter 2026/07' }), {
		payload: { action: 'authority-confirm', via: 'workflow', projectId: PROJECT, userId: PERSON, reference: 'CMA letter 2026/07' },
	});
});

test('refuses any input containing @, naming the input and never the value', () => {
	for (const [inputs, field] of [
		[{ action: 'billing-grant', account_id: 'someone@example.org', plan: 'team', reason: 'r' }, 'account_id'],
		[{ action: 'billing-grant', account_id: ACCOUNT, plan: 'team', reason: 'for someone@example.org' }, 'reason'],
		[{ action: 'authority-confirm', project_id: PROJECT, user_id: PERSON, reference: 'from someone@example.org' }, 'reference'],
		[{ action: 'billing-grants', email: 'someone@example.org' }, 'email'],
	]) {
		const e = errors(inputs);
		assert.match(e, new RegExp(`input ${field} contains @`));
		assert.doesNotMatch(e, /someone/);
	}
});

test('refuses malformed ids, dates and text, and inputs the action doesn’t read', () => {
	assert.match(errors({ action: 'billing-grants', account_id: 'acct_123' }), /account_id is not a uuid/);
	assert.match(errors({ action: 'billing-grant', plan: 'team', reason: 'r' }), /exactly one of/);
	assert.match(errors({ action: 'billing-grant', account_id: ACCOUNT, team_id: TEAM, plan: 'team', reason: 'r' }), /exactly one of/);
	assert.match(errors({ action: 'billing-grants', account_id: ACCOUNT, user_id: PERSON }), /at most one of/);
	assert.match(errors({ action: 'billing-grant', account_id: ACCOUNT, reason: 'r' }), /plan must be pro or team/);
	assert.match(errors({ action: 'billing-grant', account_id: ACCOUNT, plan: 'team', until: '31/01/2027', reason: 'r' }), /until is not YYYY-MM-DD/);
	assert.match(errors({ action: 'billing-revoke', account_id: ACCOUNT, reason: ' ' }), /reason must be 1–500/);
	assert.match(errors({ action: 'billing-revoke', account_id: ACCOUNT, reason: 'r'.repeat(501) }), /reason must be 1–500/);
	assert.match(errors({ action: 'billing-report', month: '2026-13' }), /month is not YYYY-MM/);
	assert.match(errors({ action: 'billing-report', team_id: TEAM }), /team_id is not used by billing-report/);
	assert.match(errors({ action: 'authority-confirm', project_id: PROJECT, reference: 'r' }), /user_id is required/);
	assert.match(errors({ action: 'authority-confirm', user_id: PERSON, reference: 'r' }), /project_id is required/);
	assert.match(errors({ action: 'authority-confirm', project_id: PROJECT, user_id: PERSON, team_id: TEAM, reference: 'r' }), /team_id is not used/);
	assert.match(errors({ action: 'billing-account', user_id: PERSON }), /not one the workflow offers/);
	// A PO number may identify a client, and the repo is public: billing-invoice is a direct invoke only.
	assert.match(errors({ action: 'billing-invoice', account_id: ACCOUNT, plan: 'team' }), /not one the workflow offers/);
	assert.match(errors({ action: 'billing-delete' }), /not one the workflow offers/);
});

test('the workflow offers exactly these actions and no address input', () => {
	const yml = readFileSync(new URL('../../.github/workflows/billing-admin.yml', import.meta.url), 'utf8');
	const inputs = yml.slice(yml.indexOf('    inputs:'), yml.indexOf('\npermissions:'));
	const options = [...inputs.slice(inputs.indexOf('options:')).matchAll(/^ {10}- (\S+)$/gm)].map((m) => m[1]);
	// The action's choices come first; the plan's (none, pro, team) after.
	assert.deepEqual(options.slice(0, WORKFLOW_ACTIONS.length + 1), [...WORKFLOW_ACTIONS, 'none']);
	assert.doesNotMatch(inputs, /billing-account/);
	assert.doesNotMatch(inputs, /billing-invoice/);
	assert.doesNotMatch(inputs, /^ {6}po:/m);
	assert.doesNotMatch(inputs, /^ {6}email:/m);
	// Both jobs run the check: preflight before anyone approves, act before it invokes.
	assert.equal(yml.match(/scripts\/release\/owner-action\.mjs check/g)?.length, 1);
	assert.equal(yml.match(/scripts\/release\/owner-action\.mjs payload/g)?.length, 1);
});
