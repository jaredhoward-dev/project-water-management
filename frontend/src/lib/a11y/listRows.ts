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

/** Finds the candidates for the focus; each returns null when that one isn't on the page. */
export interface ListFocusFinders<T> {
	/** The row's ✕ (`remove`) or first field (`first`). */
	control(row: number, control: 'first' | 'remove'): T | null;
	/** The list's add button. */
	add(): T | null;
	/** What holds the focus when the list itself went (a heading): the last resort. */
	fallback(): T | null;
}

/**
 * The element to focus for `target`, in order: the row's control (a row whose ✕ is hidden, as the last review
 * date, gives its first field), else the add button (gone at a list's maximum, or with the list), else the fallback.
 */
export function resolveListFocus<T>(target: ListFocusTarget, find: ListFocusFinders<T>): T | null {
	if ('row' in target) {
		const el = find.control(target.row, target.control) ?? (target.control === 'remove' ? find.control(target.row, 'first') : null);
		if (el) return el;
	}
	return find.add() ?? find.fallback();
}

/** Each row of the list carries `data-row`, its ✕ `data-remove`, the list's add button(s) `data-add` (the first takes the focus). */
const FIELD = 'input:not([type="hidden"]), select, textarea, button';

export interface FocusListOptions {
	/** The add button, when it sits outside `box` (null: none now). Default: the first `[data-add]` in `box`. */
	add?: () => HTMLElement | null;
	/** The last resort, given tabindex -1 if it can't take the focus (the list's heading), for a list that can go away. */
	fallback?: () => HTMLElement | null;
}

/** After the edit has rendered, focus `target` inside `box` (the element holding the rows and, by default, the add button). */
export async function focusListTarget(box: HTMLElement | null | undefined, target: ListFocusTarget, opts: FocusListOptions = {}): Promise<void> {
	await tick();
	const live = box?.isConnected ? box : null;
	const fallback = opts.fallback?.() ?? null;
	const el = resolveListFocus<HTMLElement>(target, {
		control: (row, control) => live?.querySelectorAll<HTMLElement>('[data-row]')[row]?.querySelector<HTMLElement>(control === 'remove' ? '[data-remove]' : FIELD) ?? null,
		add: () => {
			const add = opts.add ? opts.add() : (live?.querySelector<HTMLElement>('[data-add]') ?? null);
			return add?.isConnected ? add : null;
		},
		fallback: () => (fallback?.isConnected ? fallback : null)
	});
	if (!el) return;
	if (el === fallback && !el.matches('a[href], button, input, select, textarea, [tabindex]')) el.tabIndex = -1;
	el.focus();
}
