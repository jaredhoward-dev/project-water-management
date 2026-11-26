// A registry of invalid number fields (invalidFields.svelte.ts) for a part of a form that needs to know about its
// own fields (Fit automatically holds its button while one of its fields can't be read) while every field still
// counts in the form's own registry: its save bar, its leave guard and its Discard. Each field is recorded in both,
// and a Discard of the outer registry (its epoch) resets the fields here too.
//
// A field the outer form never saves (Fit's own search fields, issue #922) is not unsaved work there: `local` picks
// those, by field id, and they are recorded here only, so they hold the part's own button without lighting the page's
// save bar or asking at its leave guard. Nor do they follow the outer form's Discard (its epoch): only this
// registry's own reset puts them back (`epochFor`).
import { InvalidFields, type InvalidField } from './invalidFields.svelte';

export class ForwardingInvalidFields extends InvalidFields {
	readonly #outer: InvalidFields;
	readonly #local: (id: string) => boolean;

	/** `local` names, by field id, the fields kept out of the outer registry and its resets (by default none). */
	constructor(outer: InvalidFields, local: (id: string) => boolean = () => false) {
		super();
		this.#outer = outer;
		this.#local = local;
	}

	override get epoch(): number {
		return super.epoch + this.#outer.epoch;
	}

	override epochFor(id: string): number {
		return this.#local(id) ? super.epoch : this.epoch;
	}

	override set(key: string, field: InvalidField): void {
		super.set(key, field);
		if (this.#local(field.id)) this.#outer.delete(key);
		else this.#outer.set(key, field);
	}

	override delete(key: string): void {
		super.delete(key);
		// Unconditionally: a key the outer registry doesn't hold is a no-op there.
		this.#outer.delete(key);
	}
}
