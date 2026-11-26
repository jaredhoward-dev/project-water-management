#!/usr/bin/env node
// The billing-admin workflow's payload (.github/workflows/billing-admin.yml;
// docs/deployment.md § Owner actions; issue #641).
//
// The workflow runs in a public repo, and we can't rule out GitHub showing a
// run's workflow_dispatch inputs (its page, the API, a later change). So it
// takes ids only: a billing account, a person, a team or a project, by UUID,
// plus a plan, dates and the free text a customer or the History reads. Any
// input containing `@` is refused, whatever its field: an address has no
// place in it. The address forms of the owner actions, and the
// `billing-account` lookup that turns an address into these ids, are for the
// operator's own `aws lambda invoke` from their SSO session only.
//
// The payload is marked `via: "workflow"`, which the migrate Lambda's schema
// (backend/src/ops/ownerActions.ts) holds to the same rule: no `email`, no
// lookup. This check runs first, in the preflight job, so a bad input fails
// before anyone is asked to approve it; and again in the act job, which
// builds the payload.
//
// A refusal names the input, never its value (the log is public).
//
//   node scripts/release/owner-action.mjs check            validate $GITHUB_EVENT_PATH's inputs
//   node scripts/release/owner-action.mjs payload <file>   validate, then write the Lambda's event to <file>
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The actions the workflow offers: every owner action but the address lookup (billing-account). */
export const WORKFLOW_ACTIONS = ['billing-grants', 'billing-grant', 'billing-revoke', 'billing-report', 'authority-confirm', 'billing-conflicts', 'billing-conflict-resolve'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** A grant's editor seats in all, as `pnpm dev:billing:grant --seats n` takes them; the Lambda bounds it at 100000 (MAX_GRANT_SEATS). */
const SEATS = /^[1-9][0-9]{0,5}$/;
const ID_INPUTS = /** @type {const} */ (['account_id', 'user_id', 'team_id', 'project_id']);
/** The inputs each action reads; any other given a value is refused, so nothing is silently ignored. */
const READS = {
	'billing-grant': ['account_id', 'user_id', 'team_id', 'plan', 'until', 'seats', 'replace', 'reason'],
	'billing-revoke': ['account_id', 'user_id', 'team_id', 'reason'],
	'billing-grants': ['account_id', 'user_id', 'team_id'],
	'billing-report': ['month'],
	'authority-confirm': ['project_id', 'user_id', 'reference'],
	'billing-conflicts': ['all'],
	'billing-conflict-resolve': ['conflict_id', 'reason'],
};
/** An input's default (unset) value: empty, `plan: none`, `replace: false`. */
const unset = (k, v) => v === undefined || v === null || v === '' || (k === 'plan' && v === 'none') || ((k === 'replace' || k === 'all') && (v === false || v === 'false'));
const str = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v));

/**
 * The Lambda's event for the workflow's inputs, or `{ errors }` naming each
 * refused input (never its value).
 * @param {Record<string, unknown>} inputs the event file's `.inputs`
 * @param {string} actor the GitHub login that started the run (`by`)
 * @returns {{ payload: Record<string, unknown> } | { errors: string[] }}
 */
export function buildPayload(inputs, actor) {
	const errors = [];
	const i = inputs ?? {};
	for (const [k, v] of Object.entries(i)) {
		if (typeof v === 'string' && v.includes('@')) errors.push(`input ${k} contains @: the workflow takes ids only, never an address (look the id up through your SSO session, docs/deployment.md § Owner actions)`);
	}
	if (errors.length) return { errors };
	const action = str(i.action);
	if (!WORKFLOW_ACTIONS.includes(action)) return { errors: ['input action is not one the workflow offers'] };
	for (const k of ID_INPUTS) if (!unset(k, i[k]) && !UUID.test(str(i[k]))) errors.push(`input ${k} is not a uuid`);
	for (const [k, v] of Object.entries(i)) {
		if (k !== 'action' && !unset(k, v) && !READS[action].includes(k)) errors.push(`input ${k} is not used by ${action}: leave it empty`);
	}
	const id = (k) => str(i[k]).toLowerCase();
	const targets = ['account_id', 'user_id', 'team_id'].filter((k) => !unset(k, i[k]));
	const who = () =>
		Object.fromEntries(targets.map((k) => [{ account_id: 'accountId', user_id: 'userId', team_id: 'teamId' }[k], id(k)]));
	const text = (k, max) => {
		const v = str(i[k]);
		if (v.length < 1 || v.length > max) errors.push(`input ${k} must be 1–${max} characters`);
		return v;
	};
	/** @type {Record<string, unknown>} */
	let payload = { action, via: 'workflow' };
	if (action === 'billing-grant' || action === 'billing-revoke') {
		if (targets.length !== 1) errors.push('give exactly one of account_id, user_id and team_id');
		payload = { ...payload, ...who(), reason: text('reason', 500), by: actor };
		if (action === 'billing-grant') {
			const plan = str(i.plan);
			if (plan !== 'pro' && plan !== 'team') errors.push('input plan must be pro or team');
			const until = str(i.until);
			if (until && !DAY.test(until)) errors.push('input until is not YYYY-MM-DD');
			const seats = str(i.seats);
			if (seats && (!SEATS.test(seats) || Number(seats) > 100000)) errors.push('input seats is not a whole number of editor seats from 1 to 100000');
			payload = { ...payload, plan, replace: i.replace === true || i.replace === 'true', ...(until ? { until } : {}), ...(seats ? { seats: Number(seats) } : {}) };
		}
	} else if (action === 'billing-grants') {
		if (targets.length > 1) errors.push('give at most one of account_id, user_id and team_id');
		payload = { ...payload, ...who() };
	} else if (action === 'billing-report') {
		const month = str(i.month);
		if (month && !MONTH.test(month)) errors.push('input month is not YYYY-MM');
		if (month) payload.month = month;
	} else if (action === 'billing-conflicts') {
		payload = { ...payload, all: i.all === true || i.all === 'true' };
	} else if (action === 'billing-conflict-resolve') {
		const idText = str(i.conflict_id);
		if (!/^[1-9][0-9]{0,14}$/.test(idText)) errors.push('input conflict_id is not a conflict id (the # in the conflicts list)');
		payload = { ...payload, conflictId: Number(idText), reason: text('reason', 500), by: actor };
	} else if (action === 'authority-confirm') {
		if (unset('project_id', i.project_id)) errors.push('input project_id is required');
		if (unset('user_id', i.user_id)) errors.push('input user_id is required (the person’s id, never their address)');
		payload = { ...payload, projectId: id('project_id'), userId: id('user_id'), reference: text('reference', 200) };
	}
	if (!actor && (action === 'billing-grant' || action === 'billing-revoke' || action === 'billing-conflict-resolve')) errors.push('GITHUB_ACTOR is not set');
	return errors.length ? { errors } : { payload };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const [mode, out] = process.argv.slice(2);
	if ((mode !== 'check' && mode !== 'payload') || (mode === 'payload' && !out)) {
		console.error('usage: owner-action.mjs check | payload <file>');
		process.exit(2);
	}
	const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
	const r = buildPayload(event.inputs ?? {}, process.env.GITHUB_ACTOR ?? '');
	if ('errors' in r) {
		for (const e of r.errors) console.log(`::error::${e}`);
		process.exit(1);
	}
	if (mode === 'payload') writeFileSync(out, JSON.stringify(r.payload));
	console.log(`The inputs are ids only and well formed (${r.payload.action}).`);
}
