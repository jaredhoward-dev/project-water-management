import { describe, expect, it } from 'vitest';
import { listFocusTarget, resolveListFocus, RowKeys, type ListFocusFinders } from './listRows';

describe('listFocusTarget', () => {
	it('puts the focus in the new row (the last) after an add', () => {
		expect(listFocusTarget({ added: true, length: 1 })).toEqual({ row: 0, control: 'first' });
		expect(listFocusTarget({ added: true, length: 4 })).toEqual({ row: 3, control: 'first' });
	});
	it('puts the focus on the next row’s ✕ after a remove', () => {
		expect(listFocusTarget({ removedAt: 0, left: 2 })).toEqual({ row: 0, control: 'remove' });
		expect(listFocusTarget({ removedAt: 1, left: 2 })).toEqual({ row: 1, control: 'remove' });
	});
	it('takes the previous row when the last was removed', () => {
		expect(listFocusTarget({ removedAt: 2, left: 2 })).toEqual({ row: 1, control: 'remove' });
	});
	it('falls back to the add button once the list is empty', () => {
		expect(listFocusTarget({ removedAt: 0, left: 0 })).toEqual({ add: true });
		expect(listFocusTarget({ added: true, length: 0 })).toEqual({ add: true });
	});
});

describe('RowKeys', () => {
	it('gives each row its own key', () => {
		const k = new RowKeys();
		const keys = k.for(3);
		expect(new Set(keys).size).toBe(3);
		expect(k.for(3)).toEqual(keys);
	});
	it('keeps the other rows’ keys when one is removed', () => {
		const k = new RowKeys();
		const [a, , c] = k.for(3);
		k.removed(1);
		expect(k.for(2)).toEqual([a, c]);
	});
	it('gives an added row a key never used before', () => {
		const k = new RowKeys();
		const before = k.for(2);
		k.removed(1);
		k.added();
		const after = k.for(2);
		expect(after[0]).toBe(before[0]);
		expect(before).not.toContain(after[1]);
	});
	it('fits a list changed from outside at its end', () => {
		const k = new RowKeys();
		const [a, b] = k.for(3);
		expect(k.for(2)).toEqual([a, b]);
		const grown = k.for(4);
		expect(grown.slice(0, 2)).toEqual([a, b]);
		expect(new Set(grown).size).toBe(4);
		expect(k.for(0)).toEqual([]);
	});
	it('ignores a remove outside the list', () => {
		const k = new RowKeys();
		const keys = k.for(2);
		k.removed(5);
		k.removed(-1);
		expect(k.for(2)).toEqual(keys);
	});
	it('returns a copy, so a caller can’t change its keys', () => {
		const k = new RowKeys();
		const keys = k.for(2);
		keys.pop();
		expect(k.for(2)).toHaveLength(2);
	});
});

describe('resolveListFocus', () => {
	// A fake page: rows as [first field, ✕ or null], the add button and the fallback, each null when gone.
	const page = (rows: [string, string | null][], add: string | null, fallback: string | null = 'heading'): ListFocusFinders<string> => ({
		control: (row, control) => rows[row]?.[control === 'first' ? 0 : 1] ?? null,
		add: () => add,
		fallback: () => fallback
	});
	it('focuses the row’s control', () => {
		expect(resolveListFocus({ row: 1, control: 'remove' }, page([['f0', 'x0'], ['f1', 'x1']], 'add'))).toBe('x1');
		expect(resolveListFocus({ row: 0, control: 'first' }, page([['f0', 'x0']], 'add'))).toBe('f0');
	});
	it('takes the row’s first field when its ✕ is hidden (the last review date keeps no ✕)', () => {
		expect(resolveListFocus({ row: 0, control: 'remove' }, page([['f0', null]], 'add'))).toBe('f0');
	});
	it('takes the add button when the row isn’t there', () => {
		expect(resolveListFocus({ row: 3, control: 'remove' }, page([['f0', 'x0']], 'add'))).toBe('add');
		expect(resolveListFocus({ add: true }, page([], 'add'))).toBe('add');
	});
	it('takes the fallback when the list and its add button went (a deleted record’s last period)', () => {
		expect(resolveListFocus({ add: true }, page([], null))).toBe('heading');
		expect(resolveListFocus({ add: true }, page([], null, null))).toBeNull();
	});
});
