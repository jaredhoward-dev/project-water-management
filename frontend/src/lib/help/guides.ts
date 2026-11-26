// Guides for the /help page: how-tos and "how it works" explainers, beside
// the glossary in ./content.ts. Each guide has its own page
// (/help/guides/<id>); diagrams are inline SVG components
// ($lib/components/help/diagrams), keyed by DiagramId.
//
// This module holds the types, lookup, markup and search; the guides' text
// lives in one module per contents group (./guides-start.ts, -howto, -use,
// -concept, -pages), each its own chunk (vite.config.ts helpArticlesChunk), so no one
// chunk of help text nears the bundle guard's per-chunk ceiling. A new group
// is a new guides-<group>.ts spread into GUIDES below.
//
// Inline text markup, parsed by `inline()` (no HTML, so nothing is {@html}):
//   **Save**                 a UI label, shown in bold
//   *Outcomes*               a section or a word to stress, in italics
//   [[ewr]]                  link to a glossary entry, labelled with its term
//   [[ewr|the Reserve]]      the same, with its own label
//   [[guide:add-data|label]] link to another guide
// Every reference must resolve (guarded by guides.test.ts).

import { TAB_LABELS, type TabId as WorkspaceTabId } from '#lib/workspace/tabs.js';
import { helpFor } from './content';
import { CONCEPT_GUIDES } from './guides-concept';
import { HOWTO_GUIDES } from './guides-howto';
import { PAGE_GUIDES } from './guides-pages';
import { START_GUIDES } from './guides-start';
import { USE_GUIDES } from './guides-use';
import type { ShotId } from './pictures';

export type GuideKind = 'start' | 'howto' | 'use' | 'concept' | 'page';

export const GUIDE_KIND_TITLES: Record<GuideKind, string> = {
	start: 'Start here',
	howto: 'How to',
	use: 'Using the results',
	concept: 'How it works',
	page: 'Pages, one by one'
};

/** The workspace tabs the setup path walks, in the order a catchment is set up. */
export const SETUP_TABS = ['overview', 'network', 'crops', 'transfers', 'series', 'settings', 'calibration', 'runs'] as const;

/**
 * Tabs under *Build the model* that the setup path skips: optional, not a
 * step every catchment needs (the Map, issue #288: a model builds and runs
 * without one; Warnings, issue #611, the project's list of warnings, not a setup step). Calibration joined the path once its panels moved there (issue #586 round 3).
 * "Getting around a project" still names them in place.
 */
export const OPTIONAL_MODEL_TABS: readonly string[] = ['map', 'warnings'];

/** Project workspace tabs a guide can point at (`?tab=`): every one. */
export type TabId = WorkspaceTabId;

/** Their names, the workspace's own (lib/workspace/tabs.ts), so help can't drift from a rename. */
export const TAB_TITLES: Record<TabId, string> = TAB_LABELS;

export const DIAGRAM_IDS = [
	'workflow',
	'network',
	'pipeline',
	'farm-day',
	'gr4j',
	'calibration-loop',
	'validation',
	'rain-sources'
] as const;
export type DiagramId = (typeof DIAGRAM_IDS)[number];

export type GuideBlock =
	| { type: 'p'; text: string }
	/** Numbered steps: things to do, in order. */
	| { type: 'steps'; items: string[] }
	| { type: 'list'; items: string[] }
	| { type: 'note'; tone: 'tip' | 'caution'; text: string }
	| { type: 'formula'; text: string }
	| { type: 'diagram'; id: DiagramId; caption: string }
	/** A close-up of the help illustration, with numbered stops on it. */
	| { type: 'picture'; shot: ShotId; caption: string; stops: PictureStop[] };

/** A numbered stop on an illustration (a guide picture, or the /help tour). */
export interface PictureStop {
	/** The feature's key in the shot's marker map ($lib/help/pictures.json). */
	spot: string;
	title: string;
	/** Inline markup, like guide text. */
	text: string;
	/** The guide that explains it in full. */
	guide?: string;
	/** Opens in place under "Show more": key points, and a close-up or a diagram. */
	more?: { points: string[]; shot?: ShotId; diagram?: DiagramId };
}

export interface GuideSection {
	heading: string;
	blocks: GuideBlock[];
}

export interface Guide {
	/** Stable slug: /help/guides/<id>. Lowercase, hyphenated. */
	id: string;
	title: string;
	/** One or two sentences for the guide list and search. */
	summary: string;
	kind: GuideKind;
	/** The workspace tab where the work happens, if there is one. */
	tab?: TabId;
	sections: GuideSection[];
	/** Glossary ids worth reading next. */
	terms?: string[];
	/** Other guide ids. */
	related?: string[];
}

export const GUIDES: Guide[] = [
	...START_GUIDES,
	...HOWTO_GUIDES,
	...USE_GUIDES,
	...CONCEPT_GUIDES,
	...PAGE_GUIDES
];

/** The setup path on the /help landing page: one step per workspace tab. */
export const SETUP_STEPS: { tab: TabId; text: string; guide: string; optional?: boolean }[] = [
	{ tab: 'overview', text: 'Create a project, or copy one for a what-if.', guide: 'create-a-project' },
	{ tab: 'network', text: 'Hydrological units, dams and gauges, draining to one outlet.', guide: 'build-the-network' },
	{ tab: 'crops', text: 'Crop factors and the hectares on each hydrological unit.', guide: 'set-up-crops-and-demand', optional: true },
	{ tab: 'transfers', text: 'Pipelines or canals between hydrological units’ dams.', guide: 'add-a-transfer', optional: true },
	{ tab: 'series', text: 'Daily rain, and observed flow to calibrate.', guide: 'add-data' },
	{ tab: 'settings', text: 'Evaporation, rain gaps, how natural flow is made, and the EWR.', guide: 'set-the-ewr' },
	{ tab: 'calibration', text: 'Fit the runoff parameters to observed flow, and judge the fit.', guide: 'fit-automatically' },
	{ tab: 'runs', text: 'Run the model, read and compare results.', guide: 'run-and-read-results' }
];

// ---------------------------------------------------------------------------
// Lookup, inline markup and search
// ---------------------------------------------------------------------------

const byId = new Map(GUIDES.map((g) => [g.id, g]));

const norm = (s: string) =>
	s
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase();

export function guideFor(id: string): Guide | undefined {
	return byId.get(id);
}

/**
 * A guide's line in the help contents. A page guide's title is "<page>: <what it is for>", and the contents list it
 * by the page's name alone: the "Pages, one by one" group already says what the list is, and twelve full titles, two
 * or three lines each in the 13rem column, made the open group taller than a 1280×800 window (help.spec.ts). The
 * guide's own heading keeps the full title.
 */
export function guideNavLabel(g: Pick<Guide, 'kind' | 'title'>): string {
	if (g.kind !== 'page') return g.title;
	const colon = g.title.indexOf(':');
	return colon > 0 ? g.title.slice(0, colon) : g.title;
}

/** In-page anchor for a guide section, from its heading. */
export function sectionId(heading: string): string {
	return norm(heading)
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

export type InlinePart =
	| { kind: 'text'; text: string }
	| { kind: 'strong'; text: string }
	| { kind: 'em'; text: string }
	/** A glossary entry (`id`) or a guide (`guide`), with its label. */
	| { kind: 'term'; id: string; text: string }
	| { kind: 'guide'; id: string; text: string }
	/** A reference that doesn't resolve: shown as plain text (and failed by the tests). */
	| { kind: 'broken'; ref: string; text: string };

// *italics* only where the asterisks stand apart from a word (a space,
// punctuation or the ends either side), so 5*3 or a*b stays as written.
const INLINE = /\*\*(.+?)\*\*|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|(?<![\w*])\*([^*\s](?:[^*]*[^*\s])?)\*(?![\w*])/g;

/**
 * A glossary term as it reads mid-sentence: an ordinary capitalised first
 * word is lowercased ("Runoff model" → "runoff model"); acronyms and names
 * (EWR, CHIRPS, GR4J, A-pan, NSE) are left alone. Give a [[id|label]] when a
 * link starts a sentence.
 */
export function inSentence(term: string): string {
	return /^[A-Z][a-z]+(?![-\w])/.test(term) ? term[0]!.toLowerCase() + term.slice(1) : term;
}

/** Splits guide text into plain text, bold UI labels, italics and links. */
export function inline(text: string): InlinePart[] {
	const out: InlinePart[] = [];
	let last = 0;
	for (const m of text.matchAll(INLINE)) {
		if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
		last = m.index + m[0].length;
		if (m[1] !== undefined) {
			out.push({ kind: 'strong', text: m[1] });
			continue;
		}
		if (m[4] !== undefined) {
			out.push({ kind: 'em', text: m[4] });
			continue;
		}
		const ref = m[2]!.trim();
		const label = m[3]?.trim();
		if (ref.startsWith('guide:')) {
			const g = guideFor(ref.slice(6));
			out.push(g ? { kind: 'guide', id: g.id, text: label ?? g.title } : { kind: 'broken', ref, text: label ?? ref });
		} else {
			const e = helpFor(ref);
			out.push(e ? { kind: 'term', id: e.id, text: label ?? inSentence(e.term) } : { kind: 'broken', ref, text: label ?? ref });
		}
	}
	if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
	return out;
}

/** Guide text with the markup removed (for search). */
export function plainText(text: string): string {
	return inline(text)
		.map((p) => p.text)
		.join('');
}

function blockText(b: GuideBlock): string {
	switch (b.type) {
		case 'steps':
		case 'list':
			return b.items.map(plainText).join(' ');
		case 'diagram':
			return b.caption;
		case 'picture':
			return [b.caption, ...b.stops.map((s) => `${s.title} ${plainText(s.text)}`)].join(' ');
		default:
			return plainText(b.text);
	}
}

/**
 * Guides matching every word of `query`, best first: title matches before
 * summary matches before body matches. Empty query → no guides (the page
 * lists them itself).
 */
export function searchGuides(query: string, guides: readonly Guide[] = GUIDES): Guide[] {
	const words = norm(query).split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	const scored: { g: Guide; score: number; i: number }[] = [];
	guides.forEach((g, i) => {
		const title = norm(g.title);
		const summary = norm(g.summary);
		const body = norm(g.sections.flatMap((s) => [s.heading, ...s.blocks.map(blockText)]).join(' '));
		let score = 0;
		for (const w of words) {
			if (title.includes(w)) score += 3;
			else if (summary.includes(w)) score += 2;
			else if (body.includes(w)) score += 1;
			else return;
		}
		scored.push({ g, score, i });
	});
	return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.g);
}
