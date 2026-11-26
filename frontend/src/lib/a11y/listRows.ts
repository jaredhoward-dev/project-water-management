// Editable lists whose rows carry no id of their own (the period lists: a
// setting's plain { start, end, reason } objects, saved as they are), issue #921.
// Keyed by position, removing a row re-rendered every row after it and removing
// the last row took the focused ✕ away with nothing to catch the focus (it fell
// to <body>), and adding a row left the focus on the add button (WCAG 2.4.3).
// RowKeys gives each row a key of its own for the {#each}, and listFocusTarget
// says where the focus goes: into the new row on an add; on a remove, the ✕ of
// the row now in its place (the next row, else the previous), else the list's
// add button. docs/design/ui-playbook.md § "A delete puts the focus on what took
// the row's place".
import { tick } from 'svelte';
import { rowAfterRemove } from './focusAfterRemove';

/**
 * Keys for the rows of a list whose items have no id. Tell it of each add and
 * remove before writing the list; `for(length)` then keeps every other row's
 * key. A list changed from outside (a discard, a reload) to another length is
 * fitted at its end; a same-length replacement keeps the keys and its rows
 * update in place.
 */
export class RowKeys {
	#keys: number[] = [];
	#next = 0;

	/** The keys for a list of `length` rows (a copy). */
	for(length: number): number[] {
		const n = Math.max(0, length);
		if (this.#keys.length > n) this.#keys.length = n;
		while (this.#keys.length < n) this.#keys.push(this.#next++);
		return [...this.#keys];
	}
	/** A row was appended. */
	added(): void {
		this.#keys.push(this.#next++);
	}
	/** The row at `index` was removed. */
	removed(index: number): void {
		if (index >= 0 && index < this.#keys.length) this.#keys.splice(index, 1);
	}
}

/** Where the focus goes after a list edit: a control of the row at `row`, or the list's add button. */
export type ListFocusTarget = { row: number; control: 'first' | 'remove' } | { add: true };

/**
 * The focus after an add (the list now has `length` rows, the new one last: its first field) or a remove
 * (`left` rows remain: the ✕ of the row in the removed one's place, else of the new last row, else the add button).
 */
export function listFocusTarget(edit: { added: true; length: number } | { removedAt: number; left: number }): ListFocusTarget {
	if ('added' in edit) return edit.length > 0 ? { row: edit.length - 1, control: 'first' } : { add: true };
	const at = rowAfterRemove(edit.removedAt, edit.left);
	return at === null ? { add: true } : { row: at, control: 'remove' };
}

/** Each row of the list carries `data-row`, its ✕ `data-remove`, the list's add button(s) `data-add` (the first takes the focus). */
const FIELD = 'input:not([type="hidden"]), select, textarea, button';

/** After the edit has rendered, focus `target` inside `box` (the element holding the rows and the add button). */
export async function focusListTarget(box: HTMLElement | null | undefined, target: ListFocusTarget): Promise<void> {
	await tick();
	if (!box) return;
	let el: HTMLElement | null = null;
	if ('row' in target) {
		const row = box.querySelectorAll<HTMLElement>('[data-row]')[target.row];
		el = row?.querySelector<HTMLElement>(target.control === 'remove' ? '[data-remove]' : FIELD) ?? null;
	}
	(el ?? box.querySelector<HTMLElement>('[data-add]'))?.focus();
}
