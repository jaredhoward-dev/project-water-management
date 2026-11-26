// What the calibration worker is given for an uncertainty ensemble (issue #4
// phase 9, docs/model.md §2.10e), and what it posts back. The options are
// always the server's resolved ones (with the seed the database drew): the
// browser runs exactly the ensemble the server will check.
import type { EnsembleHeader, EnsembleProgress, EnsembleResult, MemberResult, ModelInput, PairedResult, ResolvedEnsembleOptions } from '@water-management/engine';

export type EnsembleJob =
	| { kind: 'ensemble'; input: ModelInput; options: ResolvedEnsembleOptions }
	| {
			kind: 'paired';
			input: ModelInput;
			/** `engineVersion`: the engine the baseline ensemble was stored on; on another engine, `baselineInput` (its run's inputs) is needed too (issue #897). */
			baseline: { options: ResolvedEnsembleOptions; header: EnsembleHeader; members: MemberResult[]; engineVersion: string };
			baselineInput?: ModelInput;
	  };

export type EnsembleWorkerMessage =
	| { type: 'ensemble-progress'; progress: EnsembleProgress }
	| { type: 'ensemble-done'; result: EnsembleResult | PairedResult }
	| { type: 'error'; message: string };
