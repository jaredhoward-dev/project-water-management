import { describe, expect, it } from 'vitest';
import { escapeIsFor, innermostDialog, type NodeLike } from './dialogEscape';

const node = (nodeName: string, parentNode: NodeLike | null): NodeLike => ({ nodeName, parentNode });

// html > body > dialog (the grid modal) > div > dialog (the paste dialog) > textarea; and a sibling dialog (a question).
const root = node('HTML', null);
const body = node('BODY', root);
const grid = node('DIALOG', body);
const gridCell = node('INPUT', node('DIV', grid));
const paste = node('DIALOG', node('DIV', grid));
const pasteBox = node('TEXTAREA', node('DIV', paste));
const question = node('DIALOG', body);
const questionButton = node('BUTTON', question);
const outside = node('BUTTON', body);

describe('innermostDialog', () => {
	it('is the nearest dialog round the node, else null', () => {
		expect(innermostDialog(pasteBox)).toBe(paste);
		expect(innermostDialog(gridCell)).toBe(grid);
		expect(innermostDialog(grid)).toBe(grid);
		expect(innermostDialog(outside)).toBeNull();
		expect(innermostDialog(null)).toBeNull();
	});
});

describe('escapeIsFor', () => {
	it('gives an Escape from a dialog nested in another to the nested one, not the one round it', () => {
		expect(escapeIsFor(grid, pasteBox, body, root)).toBe(false);
		expect(escapeIsFor(paste, pasteBox, body, root)).toBe(true);
	});

	it("gives a key from the dialog's own controls to it (positive control)", () => {
		expect(escapeIsFor(grid, gridCell, body, root)).toBe(true);
	});

	it('leaves a key from a dialog stacked beside it, or from outside every dialog, alone', () => {
		expect(escapeIsFor(grid, questionButton, body, root)).toBe(false);
		expect(escapeIsFor(grid, outside, body, root)).toBe(false);
	});

	it('takes a key whose focus fell to <body> or the document', () => {
		expect(escapeIsFor(grid, body, body, root)).toBe(true);
		expect(escapeIsFor(grid, root, body, root)).toBe(true);
		expect(escapeIsFor(grid, null, body, root)).toBe(true);
	});
});
