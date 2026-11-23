import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	allLanguages,
	catalogueGroups,
	cell,
	commonSources,
	helpGroup,
	helpHash,
	IDS,
	incompleteProblem,
	isOffered,
	missingMail,
	missingSite,
	placeholders,
	renderIds,
	renderSheet,
	report,
	resolveLanguage,
	sectionOf,
	sheetOf,
	sheetPath,
	siteGroups,
	sources,
	staleSite,
	translatedLanguages
} from './i18n_sheet.mjs';
import { messageId, pluralId } from './i18n_extract.mjs';
import { makeFixture } from './i18n_fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('cells escape pipes and keep paragraphs on one table row', () => {
	assert.equal(cell('a | b'), 'a \\| b');
	assert.equal(cell('one\n\ntwo'), 'one<br><br>two');
});

test('placeholders are unique and sorted', () => {
	assert.deepEqual(placeholders('{b} of {a}, {b}'), ['a', 'b']);
	assert.deepEqual(placeholders('none'), []);
});

test('a key falls in its longest matching section, never a mere string prefix', () => {
	const sections = { farm: 'x', 'farm.dam': 'y', 'farm.damPage': 'z' };
	assert.equal(sectionOf('farm.dam.title', sections), 'farm.dam');
	assert.equal(sectionOf('farm.damPage.up', sections), 'farm.damPage');
	assert.equal(sectionOf('farm.other', sections), 'farm');
	assert.equal(sectionOf('login.x', sections), null);
});

test('only untranslated keys are listed, with placeholders and notes as context', () => {
	const groups = catalogueGroups({
		en: { 'a.one': 'One {n}', 'a.two': 'Two', 'b.x': 'Bee' },
		af: { 'a.two': 'Twee' },
		sections: { a: 'Section A', b: 'Section B' },
		notes: { 'a.one': 'A note.' }
	});
	assert.deepEqual(
		groups.map((g) => [g.section, g.rows.map((r) => [r.key, r.context])]),
		[
			['a', [['a.one', 'A note. Keep: {n}']]],
			['b', [['b.x', '']]]
		]
	);
});

test('a glossary entry leaves the sheet only with a translation stamped from the current English', () => {
	const entry = { id: 'x', term: 'T', short: 'S', long: 'L', category: 'farmer' };
	const other = { id: 'y', term: 'T', short: 'S', long: 'L', category: 'basics' };
	assert.equal(helpGroup([entry, other], {}).rows.length, 3);
	assert.equal(helpGroup([entry], { x: { term: 'a', short: 'b', long: 'c', sourceHash: helpHash(entry) } }).rows.length, 0);
	const stale = helpGroup([entry], { x: { term: 'a', short: 'b', long: 'c', sourceHash: 'old' } });
	assert.equal(stale.rows.length, 3);
	assert.match(stale.rows[0].context, /English changed/);
});

const XX = { code: 'xx', name: 'Xx' };

test('the sheet renders a table row per string and counts them, headed by the language name', () => {
	const md = renderSheet(XX, [{ name: 'on the site', title: 'Site', groups: [{ section: 's', description: 'D', rows: [{ key: 'k', english: 'E | F', context: '' }] }] }]);
	assert.match(md, /^# Xx translation sheet$/m);
	assert.match(md, /^1 strings: 1 on the site\.$/m);
	assert.match(md, /^\| `k` \| E \\\| F \|  \|  \|$/m);
	assert.match(md, /pnpm gen:i18n:export xx/);
	assert.match(md, /pnpm gen:i18n:apply xx/);
});

const site = (list) => new Map(list.map((m) => [m.id, m]));
const text = (english, section, context) => ({ id: messageId(english, context), kind: 'text', english, context, section });
const days = { id: pluralId({ one: 'day', other: 'days' }), kind: 'plural', forms: { one: 'day', other: 'days' }, section: 'b' };

test('site messages are listed by id in section order, a counted word a row per form, with context, notes and placeholders', () => {
	const messages = site([text('B first', 'b'), text('Hello {name}', 'a'), text('Create account', 'a', 'page title'), days]);
	const groups = siteGroups({ messages, af: {}, sections: { a: 'Section A', b: 'Section B', c: 'Unused' }, notes: { 'Hello {name}': 'A greeting.', days: 'A count.' } });
	assert.deepEqual(
		groups.map((g) => [g.section, g.rows.map((r) => [r.key, r.english, r.context])]),
		[
			[
				'a',
				[
					[messageId('Hello {name}'), 'Hello {name}', 'A greeting. Keep: {name}'],
					[messageId('Create account', 'page title'), 'Create account', 'Meaning: page title. The same English elsewhere has its own row.']
				]
			],
			[
				'b',
				[
					[messageId('B first'), 'B first', ''],
					[`${days.id}.one`, 'day', 'A count.'],
					[`${days.id}.other`, 'days', '']
				]
			]
		]
	);
});

test('a translated site message leaves the sheet; a translation whose id no message has is stale and fails the check', () => {
	const messages = site([text('Kept', 'a'), text('Edited English', 'a'), days]);
	const af = { [messageId('Kept')]: 'x', [messageId('Old English')]: 'y', [days.id]: { one: 'x', other: 'y' } };
	const groups = siteGroups({ messages, af, sections: { a: 'A', b: 'B' } });
	assert.deepEqual(groups.flatMap((g) => g.rows.map((r) => r.english)), ['Edited English']);
	const stale = staleSite(messages, af);
	assert.deepEqual(stale, [messageId('Old English')]);
	const r = report({ site: groups, mail: [], help: [], helpAf: {}, staleSiteIds: stale });
	assert.deepEqual(r.stale, stale);
	assert.match(r.text, /Stale site translations/);
});

test('the id list is sorted and counted', () => {
	const ids = renderIds(site([text('b', 'a'), text('a', 'a')]));
	assert.match(ids, /^export const MESSAGE_COUNT = 2;$/m);
	assert.ok(ids.indexOf(`'${messageId('a')}'`) < ids.indexOf(`'${messageId('b')}'`) === messageId('a') < messageId('b'));
});

test('resolveLanguage finds a code in the table and refuses one that isn’t there', async () => {
	const en = await resolveLanguage('en');
	assert.equal(en.code, 'en');
	await assert.rejects(resolveLanguage('zz'), /"zz" isn't in/);
});

test('translatedLanguages is every language but the fallback', async () => {
	const langs = await translatedLanguages();
	assert.ok(langs.every((l) => l.code !== 'en'));
	const { DEFAULT_LOCALE } = await allLanguages();
	assert.equal(DEFAULT_LOCALE, 'en');
});

test('the committed sheets and the id list are current for every language (pnpm gen:i18n:sheet)', async () => {
	const common = await commonSources();
	assert.deepEqual(common.problems, []);
	assert.equal(readFileSync(path.join(ROOT, IDS), 'utf8'), renderIds(common.messages));
	for (const lang of await translatedLanguages()) {
		const src = await sources(lang.code, common);
		assert.equal(readFileSync(path.join(ROOT, sheetPath(lang.code)), 'utf8'), sheetOf(lang, src), `${sheetPath(lang.code)} is out of date`);
	}
});

// ---- A stand-in language, end to end, against a throwaway repo (never committed as a real catalogue) ----

test('a language with no catalogue files yet lists everything untranslated (a fixture root, not the real repo)', async () => {
	const { root, cleanup } = makeFixture();
	try {
		const common = await commonSources(root);
		assert.deepEqual(common.problems, []);
		const langs = await translatedLanguages(root);
		assert.deepEqual(
			langs.map((l) => l.code),
			['xx']
		);
		const src = await sources('xx', common);
		assert.equal(src.site.length, 1);
		assert.deepEqual(src.site[0].rows.map((r) => r.english), ['Stand-in message']);
		assert.equal(src.mail.length, 1);
		assert.deepEqual(src.mail[0].rows.map((r) => r.english), ['Hello {name}']);
		assert.equal(helpGroup(src.help, src.helpAf).rows.length, 3);
	} finally {
		cleanup();
	}
});

// ---- Completeness: an offered language must have every site message and email string (check:i18n fails otherwise) ----

const XX_LANGS = (row) => ({
	'packages/engine/src/languages.ts': `export const LANGUAGES = [
	{ code: 'en', name: 'English', intl: 'en-ZA', decimalMark: '.' },
	${row}
];
export const LOCALES = LANGUAGES.map((l) => l.code);
export const DEFAULT_LOCALE = 'en';
`
});
const XX_SITE = (words) => ({ 'frontend/src/lib/i18n/messages/xx.ts': `export const xx = ${JSON.stringify(words)};\n` });

/** The fixture's xx row and sources, with `extra` files on top. */
async function xxCase(extra) {
	const { root, cleanup } = makeFixture(extra);
	try {
		const [lang] = await translatedLanguages(root);
		return { lang, src: await sources('xx', await commonSources(root)) };
	} finally {
		cleanup();
	}
}

test('an offered language with an untranslated site message fails, naming the id, its English and the fix', async () => {
	const { lang, src } = await xxCase({});
	assert.equal(isOffered(lang), true);
	assert.deepEqual(src.missingSiteIds, [messageId('Stand-in message')]);
	const problem = incompleteProblem(lang, src);
	assert.ok(problem);
	assert.match(problem, /Xx .*\(xx\) is offered but 1 site message has no translation/);
	assert.ok(problem.includes(`${messageId('Stand-in message')}  "Stand-in message"`));
	assert.match(problem, /pnpm gen:i18n:export xx <dir>/);
	assert.match(problem, /i18n-translator and i18n-checker/);
	assert.match(problem, /pnpm gen:i18n:apply xx/);
});

const XX_MAIL = (words) => ({ 'backend/src/mail/i18n/xx.ts': `export const xx = ${JSON.stringify(words)};\n` });
const XX_SITE_DONE = XX_SITE({ [messageId('Stand-in message')]: 'Plaasvervanger' });

test('an offered language with every site message but an untranslated email string fails, naming the key, its English and the fix', async () => {
	const { lang, src } = await xxCase(XX_SITE_DONE);
	assert.deepEqual(src.missingSiteIds, []);
	assert.deepEqual(src.missingMailKeys, ['mail.hello']);
	const problem = incompleteProblem(lang, src);
	assert.ok(problem);
	assert.doesNotMatch(problem, /site message/);
	assert.match(problem, /Xx .*\(xx\) is offered but 1 email string has no translation, so every email to someone who chose it is sent in English \(mailLanguage/);
	assert.ok(problem.includes('  mail.hello  "Hello {name}"'));
	assert.match(problem, /pnpm gen:i18n:export xx <dir>/);
	assert.match(problem, /pnpm gen:i18n:apply xx/);
});

test('an offered language missing both names both, under one fix', async () => {
	const { lang, src } = await xxCase({});
	const problem = incompleteProblem(lang, src);
	assert.match(problem, /1 site message has no translation/);
	assert.match(problem, /1 email string has no translation/);
	assert.equal(problem.match(/Translate them:/g).length, 1);
});

test('an offered language whose site and email catalogues are complete passes, even with the glossary untranslated', async () => {
	const { lang, src } = await xxCase({ ...XX_SITE_DONE, ...XX_MAIL({ 'mail.hello': 'Hallo {name}' }) });
	assert.deepEqual(src.missingSiteIds, []);
	assert.deepEqual(src.missingMailKeys, []);
	assert.equal(incompleteProblem(lang, src), null);
	assert.equal(helpGroup(src.help, src.helpAf).rows.length, 3, 'the glossary entry is still untranslated');
});

test('an email key is missing until it has words; a key English no longer has is not counted', () => {
	const en = { 'mail.a': 'A', 'mail.b': 'B' };
	assert.deepEqual(missingMail(en, {}), ['mail.a', 'mail.b']);
	assert.deepEqual(missingMail(en, { 'mail.a': 'Aa', 'mail.gone': 'x' }), ['mail.b']);
	assert.deepEqual(missingMail(en, { 'mail.a': 'Aa', 'mail.b': 'Bb' }), []);
});

test('a language marked translating: true is reported but never fails for being incomplete', async () => {
	const { lang, src } = await xxCase(XX_LANGS(`{ code: 'xx', name: 'Xx', intl: 'en-ZA', decimalMark: '.', translating: true }`));
	assert.equal(isOffered(lang), false);
	assert.equal(src.missingSiteIds.length, 1);
	assert.equal(src.missingMailKeys.length, 1);
	assert.equal(incompleteProblem(lang, src), null);
	assert.match(report(src).text, /No words yet: 1 site strings/);
});

test('a counted word is missing until its translation has at least the other form', () => {
	const messages = site([days]);
	assert.deepEqual(missingSite(messages, {}), [days.id]);
	assert.deepEqual(missingSite(messages, { [days.id]: { one: 'dag' } }), [days.id]);
	assert.deepEqual(missingSite(messages, { [days.id]: { one: 'dag', other: 'dae' } }), []);
});

test('every offered language in the real table has every site message and email string translated', async () => {
	const common = await commonSources();
	for (const lang of await translatedLanguages()) {
		const src = await sources(lang.code, common);
		assert.equal(incompleteProblem(lang, src), null);
	}
});
