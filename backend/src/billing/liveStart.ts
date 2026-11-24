// A new project (a copy or an import) asked to start with automatic runs on,
// on an account whose live catchments are all in use: 340_live_catchment_gaps
// starts it with them off rather than refusing it (issue #641: Free never
// rations copying, importing or modelling; docs/billing.md § Live catchments
// (Free)). The routes ask this after the insert to say so in their answer.
import type { Db } from '../db/tx.js';
import { resolveAutoRun } from '../runs/autoRun.js';

/** The answer's `autoRunsOff` when it happened: the limit that kept automatic runs off. */
export const AUTO_RUNS_OFF = 'live_catchments' as const;

/** Whether `projectId` was asked to start with automatic runs on (`asked`, its settings) and was stored with them off. */
export async function autoRunsStartedOff(db: Db, projectId: string, asked: unknown): Promise<boolean> {
	if (!resolveAutoRun(asked).enabled) return false;
	const { rows } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [projectId]);
	return rows.length > 0 && !resolveAutoRun(rows[0]!.settings).enabled;
}
