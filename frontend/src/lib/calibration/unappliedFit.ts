// What changed in the form since an unapplied fit ran (issue #920): the engine's fitRecordStatus, run against the
// form as it stands for each step's record as Apply would make it, so a result whose calibration window, exclusions,
// record or forcing settings moved after the fit says so before it is applied. Pure, so it is unit-tested; the panel
// (components/calibration/FitPanel.svelte) shows the lines over the result.
import { fitRecordCaveats, fitRecordStatus, type ProjectSettings, type ZoneFitStep } from '@water-management/engine';
import { fitRecordFor } from './fit';
import type { FitRan } from './fitSession.svelte';
import { locationSettings } from './zones';

type LocNodes = Parameters<typeof locationSettings>[1];

/**
 * The caveats of each step's fit against the form now, prefixed with the location's name when there is more than one
 * step. The parameters are left out: before Apply the form holds the old ones, and Apply writes the fitted. Only what
 * the settings hold is compared (the series the fit loaded are the ones a run reads until the data changes, which the
 * fit record's own status says once applied). Empty when nothing changed.
 */
export function unappliedFitCaveats(steps: readonly ZoneFitStep[], ran: Pick<FitRan, 'settings' | 'validate' | 'validationRecord'>, form: ProjectSettings, nodes: LocNodes): string[] {
	const out: string[] = [];
	for (const st of steps) {
		const record = fitRecordFor(st.report, locationSettings(ran.settings, nodes, st.zoneNodeId), { validate: ran.validate, validationRecord: ran.validationRecord });
		const status = { ...fitRecordStatus(locationSettings(form, nodes, st.zoneNodeId), record), editedParams: [] };
		for (const c of fitRecordCaveats(status)) {
			const line = steps.length > 1 ? `${st.name}: ${c}` : c;
			if (!out.includes(line)) out.push(line);
		}
	}
	return out;
}
