import { describe, expect, it } from 'vitest';
import { ForwardingInvalidFields } from './forwardingInvalidFields.svelte';
import { InvalidFields } from './invalidFields.svelte';

describe('ForwardingInvalidFields', () => {
	const field = { id: 'f-budget', label: 'Model runs per fit', message: 'Enter a number from 50 to 10 000' };

	it('records a field in its own list and the outer one, and forgets it in both', () => {
		const outer = new InvalidFields();
		const inner = new ForwardingInvalidFields(outer);
		inner.set('a', field);
		expect(inner.fields).toEqual([field]);
		expect(outer.fields).toEqual([field]);
		inner.delete('a');
		expect(inner.count).toBe(0);
		expect(outer.count).toBe(0);
	});

	it('does not see the outer registry’s other fields', () => {
		const outer = new InvalidFields();
		const inner = new ForwardingInvalidFields(outer);
		outer.set('elsewhere', { ...field, id: 'other' });
		expect(inner.count).toBe(0);
		expect(outer.count).toBe(1);
	});

	it('moves its epoch on a reset of either registry, so its fields follow the form’s Discard', () => {
		const outer = new InvalidFields();
		const inner = new ForwardingInvalidFields(outer);
		const e0 = inner.epoch;
		outer.reset();
		const e1 = inner.epoch;
		expect(e1).not.toBe(e0);
		inner.reset();
		expect(inner.epoch).not.toBe(e1);
	});
});
