// The one rule for "two dam areas agree" (issue #867): the comparison
// (compare.ts, modelled against observed) and the S1/S2 agreement
// (sentinel/agreement.ts, radar against Sentinel-2) both call withinOfFull,
// so a pair at exactly the boundary can't agree in one and not the other.
// Before, the agreement subtracted shares (|a/F − b/F| ≤ 0.1) while the
// comparison subtracted areas (|a − b| ≤ 0.1·F), and at exactly 0.1 F they
// could round apart (0.4 − 0.3 is 0.10000000000000003 > 0.1).
//
// Kept free of any engine import: the fetcher's bundle takes in
// sentinel/agreement.ts, and compare.ts imports the engine.

/** Two areas agree when they differ by at most this share of the full area F (docs/model.md § Modelled vs observed dam area). */
export const WITHIN_SHARE = 0.1;

/**
 * The tolerance on the boundary, relative to the band (WITHIN_SHARE·F): a difference that is the band to within
 * floating-point rounding counts as within. 1e-9 of 0.1 F is a fraction of a square millimetre on a 1 km² dam, far
 * under any pixel, so it decides only exact ties.
 */
export const WITHIN_REL_TOLERANCE = 1e-9;

/** Whether two areas (m²) are within `share` of the full area `fullM2` (m²), the band's edge included. */
export function withinOfFull(aM2: number, bM2: number, fullM2: number, share: number = WITHIN_SHARE): boolean {
	return Math.abs(aM2 - bM2) <= share * fullM2 * (1 + WITHIN_REL_TOLERANCE);
}
