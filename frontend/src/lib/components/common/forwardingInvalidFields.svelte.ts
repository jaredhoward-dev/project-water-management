// A registry of invalid number fields (invalidFields.svelte.ts) for a part of a form that needs to know about its
// own fields (Fit automatically holds its button while one of its fields can't be read) while every field still
// counts in the form's own registry: its save bar, its leave guard and its Discard. Each field is recorded in both,
// and a Discard of the outer registry (its epoch) resets the fields here too.
import { InvalidFields, type InvalidField } from './invalidFields.svelte';

export class ForwardingInvalidFields extends InvalidFields {
	readonly #outer: InvalidFields;

	constructor(outer: InvalidFields) {
		super();
		this.#outer = outer;
	}

	override get epoch(): number {
		return super.epoch + this.#outer.epoch;
	}

	override set(key: string, field: InvalidField): void {
		super.set(key, field);
		this.#outer.set(key, field);
	}

	override delete(key: string): void {
		super.delete(key);
		this.#outer.delete(key);
	}
}
