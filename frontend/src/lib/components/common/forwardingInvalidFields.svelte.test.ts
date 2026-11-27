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

	it('keeps a field the form never saves out of the outer registry, in its own list only (issue #922)', () => {
		const outer = new InvalidFields();
		const inner = new ForwardingInvalidFields(outer, (id) => id === 'f-budget');
		inner.set('a', field);
		inner.set('b', { ...field, id: 'f-penalty', label: 'WR2012 MAR penalty weight' });
		expect(inner.fields.map((f) => f.id)).toEqual(['f-budget', 'f-penalty']);
		expect(outer.fields.map((f) => f.id)).toEqual(['f-penalty']);
		inner.delete('a');
		inner.delete('b');
		expect(inner.count).toBe(0);
		expect(outer.count).toBe(0);
	});

	it('keeps a local field off the outer registry’s resets: only its own reset puts it back (issue #922)', () => {
		const outer = new InvalidFields();
		const inner = new ForwardingInvalidFields(outer, (id) => id === 'f-budget');
		const local0 = inner.epochFor('f-budget');
		const shared0 = inner.epochFor('f-penalty');
		outer.reset();
		expect(inner.epochFor('f-budget')).toBe(local0);
		expect(inner.epochFor('f-penalty')).not.toBe(shared0);
		const shared1 = inner.epochFor('f-penalty');
		inner.reset();
		expect(inner.epochFor('f-budget')).not.toBe(local0);
		expect(inner.epochFor('f-penalty')).not.toBe(shared1);
	});

	it('answers its plain epoch for any field of a plain registry', () => {
		const plain = new InvalidFields();
		const e0 = plain.epochFor('x');
		plain.reset();
		expect(plain.epochFor('x')).toBe(plain.epoch);
		expect(plain.epochFor('x')).not.toBe(e0);
	});
});
