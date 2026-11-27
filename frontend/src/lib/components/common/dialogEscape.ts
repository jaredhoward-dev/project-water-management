// Which dialog an Escape keydown belongs to (Dialog.svelte, a dialog with a `beforeclose`, which listens for
// Escape on the window). A dialog can sit inside another one's DOM: the hydrological unit table's Paste from a
// spreadsheet… dialog is drawn by NetworkTab inside the grid modal. An Escape from inside the paste dialog is
// inside the grid modal too, and the grid modal took it: it asked its leave guard and shut, over the paste
// dialog the person meant to close. The key is the innermost dialog's round its target.

/** The bit of a DOM node this needs: its parent and its name. */
export interface NodeLike {
	readonly nodeName: string;
	readonly parentNode: NodeLike | null;
}

/** The innermost <dialog> that holds `node` (itself, when it is one), else null. */
export function innermostDialog(node: NodeLike | null): NodeLike | null {
	for (let n = node; n; n = n.parentNode) if (n.nodeName === 'DIALOG') return n;
	return null;
}

/**
 * Whether an Escape that reached the window with this `target` is `dialog`'s to handle: the focus fell out of
 * every dialog to <body> or the document (a control that had it was disabled), or the innermost dialog round
 * the target is this one. A key from another dialog, stacked on this one (the question `beforeclose` asks) or
 * nested inside it (a paste dialog over a grid), is that dialog's.
 */
export function escapeIsFor(dialog: NodeLike, target: NodeLike | null, body: NodeLike | null, root: NodeLike | null): boolean {
	if (!target || target === body || target === root) return true;
	return innermostDialog(target) === dialog;
}
