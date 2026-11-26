// The glossary's articles for "Natural flow and calibration" (category 'flow', the last
// section of articles.ts until 2026-11-25). Same shape and rules as
// articles.ts. A module of its own, like articles-data.ts, so the /help pages
// load the glossary's long text in chunks each under the bundle guard's
// per-chunk ceiling (vite.config.ts helpArticlesChunk): articles.ts's chunk
// had come within 0.4 KB of it. content.ts joins them.

import type { HelpArticle } from './types';

export const FLOW_ARTICLES: Record<string, HelpArticle> = {
	'natural-flow': {
		long: 'The runoff model, GR4J, turns daily rain into natural flow. The workbook fell back to a Pitman flow column on days the rain model gave nothing (quirk Q7); the app does not, so natural flow always comes from the runoff model.\n\nGR4J runs once for each hydrological unit with land, on its own rain, and each unit’s runoff is its own; the natural flow at the outlet is their routed sum.',
		aliases: ['naturalised flow', 'virgin flow'],
		related: ['calibration', 'flow-share', 'runoff-model'],
		source: 'b023 Flow data sheet; docs/model.md §2.4'
	},
	'farm-runoff': {
		long: 'The unit’s own GR4J runoff, on its own rain (Per unit). Runs made before engine 1.109.0 under Fragmentation gave it natural flow × the unit’s natural MAR share.',
		related: ['natural-flow', 'flow-share'],
		source: 'b023 Fragmented flow'
	},
	'upstream-inflow': {
		long: 'Upstream elements are always computed first, so a hydrological unit sees today’s outflow of its upstream neighbours.',
		related: ['network', 'farm-outflow'],
		source: 'b023 farm element sheet'
	},
	'farm-outflow': {
		long: 'It becomes the next element’s upstream inflow. At the outflow gauge it is the catchment’s simulated outflow.',
		related: ['upstream-inflow', 'spill', 'return-flow'],
		source: 'b023 farm element sheet'
	},
	'calibration': {
		long: 'Tune by hand (change a parameter, run, and compare simulated with observed flow: hydrograph and statistics such as NSE and PBIAS), or let Fit automatically search for the parameters. Calibrate over a period with a good observed record; the workbook uses its own calibration date window, separate from the main run.',
		aliases: ['flow calibration', 'tuning'],
		related: ['gr4j', 'nse', 'pbias', 'observed-flow'],
		source: 'b023 Help (Calibration function; Flow Calibration Cfg)'
	},
	'runoff-model': {
		long: 'GR4J is the only runoff model since engine 1.0.0, so there is nothing to choose. The workbook’s own model, the legacy runoff model, did not conserve water and was removed; runs made with it before then still open, labelled “Workbook comparison”, but can’t be re-run.\n\nThe runoff model only changes how rain becomes natural flow. Flow shares, hydrological units, dams, transfers and the EWR are the same whichever model made the flow, so an old legacy run and a GR4J run compare directly.',
		aliases: ['rain-runoff model', 'rainfall-runoff'],
		related: ['calibration', 'natural-flow', 'gr4j', 'legacy-runoff-model'],
		source: 'docs/model.md §2.4; issues #4, #16'
	},
	'gr4j': {
		long: 'GR4J (Perrin, Michel & Andréassian 2003) is used worldwide. Rain first meets evaporation; what is left partly fills a soil-moisture (production) store of capacity X1. The rest, plus what percolates out of that store, is spread in time by two unit hydrographs of time base X4 days. 90 % goes through a routing store (reference capacity X3), and 10 % goes straight to the outlet.\n\nX2 exchanges water with groundwater outside the catchment. It is fixed at 0 by default, so the catchment is closed and the balance rain − evaporation − flow = change in storage holds every day. The model first runs a warm-up (a year by default) over the start of the record, so the stores begin at a realistic level; warm-up days are never shown or scored.\n\nTypical values: X1 100–1 200 mm, X3 20–300 mm, X4 1.1–2.9 days.',
		aliases: ['X1', 'X2', 'X3', 'X4', 'production store', 'routing store', 'unit hydrograph', 'warm-up', 'Perrin'],
		related: ['runoff-model', 'pan-coefficient', 'actual-evaporation'],
		source: 'Perrin et al. (2003), J. Hydrol. 279; docs/model.md § Rain to flow: GR4J'
	},
	'pan-coefficient': {
		long: 'A Class-A pan evaporates more than a catchment’s soils and plants could, so conceptual runoff models scale it down. 0.7 is a common flat value. Monthly values (for example the WR90 or Midgley factors) can be entered instead. The coefficient does not affect irrigation demand, which uses crop factors on the A-pan directly. It is used only while GR4J’s potential evaporation is set to pan coefficient × A-pan; with a monthly PE row entered directly GR4J ignores it.\n\nThree presets fill the row as a starting point (still editable; picking one writes its name into the optional “Pan coefficient source” note): Generic (flat 0.70), Winter rainfall (e.g. Western Cape) and Summer rainfall. They are indicative, from FAO-56 Table 5 climate classes (Allen et al. 1998) — confirm against local humidity and wind. A run warns, and Settings hints, when a month sits outside FAO-56’s usual 0.6–0.85 range for a Class A pan; that is a plausibility check, not a hard limit, so a value further out still saves and runs.\n\nThe FAO-56 Table 5 helper fills the row from monthly humidity and wind, the pan’s siting and its fetch, and writes the table cells and your note on where the humidity and wind came from into the same source note. The note is provenance only: fits and runs record it, and editing it never marks a fit’s forcing as changed.\n\nBecause GR4J’s parameters trade off against evaporation, the coefficient is held fixed and never calibrated: a fit records the coefficient it ran under, and changing it afterwards marks the fit record “Forcing changed since fit”.',
		aliases: ['PET', 'potential evaporation', 'k pan', 'pan coefficient preset', 'FAO-56'],
		related: ['gr4j', 'apan', 'auto-calibration'],
		source: 'Issue #4 §1 (forcing); FAO-56 Table 5 (Allen et al. 1998); docs/model.md §2.4a'
	},
	'gr4j-pe': {
		long: 'One A-pan row drives three things: GR4J’s potential evaporation (× the pan coefficient), irrigation demand (× the crop factors) and dam evaporation (× the dam evaporation factor). With **Pan coefficient × A-pan**, the default and what every earlier run did, changing the A-pan row moves all three.\n\n**Monthly PE, entered directly** gives GR4J its own 12 values in mm (Oct … Sep), for example a station’s FAO-56 reference evapotranspiration (ET₀) × a stated factor, with a required note of the source. GR4J then runs on that row alone; the pan coefficient is not used, and irrigation demand and dam evaporation still read the A-pan row, so a PE change moves the runoff model and nothing else. A row of zeros is refused, as a zero A-pan row is.\n\n**Evaporation from the map**, under this group, proposes the row from a reference-ET grid averaged over the catchment boundary, as it stands (factor 1); **Use** saves it with a source note naming the grid, its version and years.\n\nSettings shows the annual PE GR4J runs on under either choice. A fit records the PE input it ran under, so changing it marks the fit record “Forcing changed since fit”.',
		aliases: ['PE', 'PET', 'ET0', 'ET₀', 'reference evapotranspiration', 'monthly PE', 'evaporation source'],
		related: ['pan-coefficient', 'apan', 'gr4j'],
		source: 'Issue #39; FAO-56 (Allen et al. 1998); docs/model.md §2.4a'
	},
	'areal-rain': {
		long: 'A valley rain gauge or a 0.05° satellite product such as CHIRPS can read well below the rain that falls on a mountain catchment as a whole: orographic rain on the ridges is what they miss most. GR4J conserves water, so on such rain it cannot make the flow the gauge records without importing water through X2, which would hide the rain error in a parameter.\n\nThe correction multiplies the rain GR4J runs on (catchment rain, else corrected CHIRPS, else forecast) by a factor per month (Oct … Sep, each 0.25–4), with the method and a required note of the source. The preferred basis is an **independent MAP**: the catchment’s mean annual precipitation from WR2012, an isohyetal map or a gridded MAP averaged over the catchment, divided by the forcing’s own mean annual rain over its complete water years (one flat factor, since an annual MAP says nothing about the seasons). **Rain gauges** in or near the catchment are the other independent basis. A factor **fitted** to the flow record is allowed but makes the rain level a calibrated multiplier that trades off against X1 and the evaporation, and every run says so.\n\nOnly the runoff model reads it. Irrigation demand’s effective rain and rain on the dams keep the recorded rain, because the fields and dams sit in the valley where the gauge is. The runoff coefficient, the WR2012 rain scaling, the water account and the plausibility checks read the corrected rain, which runs show as the daily “Areal catchment rainfall” column. A fit records the factors it ran under, so changing them marks the fit record “Forcing changed since fit”.',
		aliases: ['areal rain', 'areal rainfall', 'rain factor', 'MAP correction', 'orographic rain', 'rain scaling', 'arealRain'],
		related: ['gr4j', 'chirps-bias', 'rain-final', 'gr4j-pe'],
		source: 'Engine 1.13.0; docs/model.md §2.4g; docs/calibration-research.md § Rain forcing'
	},
	'unit-rain': {
		long: 'Model settings → Flow generation sets how natural flow is made: **Per unit**, the only method (Fragmentation, one GR4J run on the catchment rain split between the units, was retired in engine 1.109.0, and every project moved to Per unit; a fit made under it reads “Parameters not fitted for this method”, so refit). GR4J runs once for each unit with land, with the one calibrated parameter set, the catchment’s evaporation and the unit’s own area, and each unit’s runoff is its own inflow; the natural flow at the outlet is their routed sum. A unit given a rainfall station runs on that station (see A unit’s rainfall station). A unit without one runs on, in this order:\n\n• **Its own rain gauge**, with the catchment gauge’s checks for long zero runs and multi-day totals; its gaps and the days those checks set aside take its CHIRPS levelled to its MAP.\n• **The catchment gauge × unit MAP ÷ gauge MAP**, when the gauge’s MAP is set here and the unit has a MAP. Days the gauge has none take the unit’s CHIRPS levelled to its MAP.\n• **Its own CHIRPS**, levelled by its MAP ÷ the CHIRPS mean annual rain over the MAP period (1991–2020 by default, at least 10 complete years), or with the catchment’s CHIRPS correction when it has no MAP. CHIRPS that averages 0 mm a year looks broken: it is skipped, with a warning.\n• **Otherwise the catchment rain**, with the areal rainfall correction; the run warns, naming the unit, and Run readiness and Model settings list it.\n\n**Reference gauge for the units’ CHIRPS** (optional): 12 monthly factors, the gauge’s checked rain ÷ CHIRPS at the cell under the reference unit’s centre, correct every unit’s CHIRPS for its season; each unit is then levelled so its yearly total is its own MAP. A month with under 90 shared days or 50 mm of CHIRPS takes 1, with a warning.\n\nEvery factor is held between 0.25 and 4, and a held one warns; one outside 0.5–2 warns too but is used. A CHIRPS-GEFS forecast is corrected like the unit’s CHIRPS; an uploaded forecast takes the MAP ratio. Demand, rain on the dams and the WR2012 check keep the catchment rain. Set up each unit’s CHIRPS under Data feeds, Rain for each unit (it reads CHIRPS rnl, from 1981, about three weeks behind each month), and its MAP on the unit’s form. The run lists each unit’s rule, factor and source.\n\nA seasonal outlook, the uncertainty ensemble’s CHIRPS-only member and a run resumed from a saved model state don’t refit the rules and factors: they keep each unit’s **pinned** as the base run had them, so their history runs at the levels the base run used, and the run’s panel says when the reference gauge’s factors were pinned.',
		aliases: ['flow generation', 'per unit', 'per-unit rain', 'rain per unit', 'unit rain', 'rain for each unit', 'semi-distributed GR4J', 'unitRain'],
		related: ['rain-stations', 'unit-map', 'areal-rain', 'gr4j', 'flow-share'],
		source: 'docs/model.md §2.4h; issues #482 and #500'
	},
	'rain-stations': {
		long: 'Under Model settings → Flow generation, each hydrological unit with land has a **Driver rainfall**: a **rainfall station**, its own **CHIRPS, bias-corrected**, its own **CHIRPS, raw (levelled to the unit’s MAP)**, or **Not set** (as before stations, see Flow generation). A unit has one driver: picking CHIRPS takes its station away, and picking a station takes its CHIRPS away.\n\n**CHIRPS as the driver** is the unit’s own CHIRPS (Data feeds, Rain for each unit), whatever other records it has, levelled to the unit’s MAP by k_unit: its MAP ÷ the mean annual rain of its CHIRPS over the MAP period, held between 0.25 and 4. **Raw** is never bias-corrected, only levelled. **Bias-corrected** is first corrected month by month against a point rainfall record: the reference gauge (Units without a station) when there is one, else the catchment’s CHIRPS bias factors (the catchment gauge against the catchment CHIRPS), then levelled. With no point record to correct against it runs raw, levelled to its MAP, and says so under the choice and in the run’s warnings. The unit’s MAP, its CHIRPS mean annual rain and the factor show beside the choice. A unit with no CHIRPS of its own runs as Not set until it has one, and Run readiness lists it.\n\nA **rainfall station** is a catchment rain series added with Add data → Rainfall: station, with its own MAP and source. Several units may share a station.\n\n• **On the station’s days** the unit runs on the station’s rain × unit MAP ÷ station MAP, held between 0.25 and 4 (a held ratio warns, and one outside 0.5–2 warns but is used). Untick **Scale to unit MAP** to run on the station’s rain as recorded; without a MAP on either side the ratio is 1, with a warning.\n• **On its gaps and unreliable days** (days its checks set aside, and periods marked unreliable) the first source in **Then patch gaps from** with a reading fills in, in the order you set: another station × unit MAP ÷ that station’s MAP (each station used for patching is adjusted to the unit’s MAP), or **CHIRPS, corrected**: the unit’s own CHIRPS, corrected month by month against the rain of the station chosen under **Gaps: CHIRPS corrected against** (its own station by default) taken to the unit’s MAP, so a filled day sits at the unit’s MAP like a station day. It is used as it is: the correction already carries the unit’s level, so the MAP ratio isn’t applied again. CHIRPS alone is the default. A CHIRPS correction needs at least 5 complete years in common, or it is refused and the next source is used.\n• Each station in the list says how many of the main station’s gap days it fills, and which days it counted: the run’s days before any forecast, since forecast days are never patched. One with no reading on any of them, or with no MAP while scaling is on, can’t help: it is greyed out and says why. Use Up and Down to reorder, Remove to drop one, and Add a source for another (at most 8). An empty list sends the gaps to the next fallback.\n• Satellite rain is **never** a station unit’s main rain, only the fill.\n\nA station’s CHIRPS for its checks is read at its own coordinates, or, without them, from the unit it **stands in**. Tick several units to give them one driver (and, for a station, one patching priority) at once. Changing a unit’s driver changes the rain GR4J runs on: refit afterwards.\n\n**Unreliable periods** (Model settings → Rain gaps, under Flagged rain) can be marked on any rain record, not only a station: a unit’s own gauge and the alternative catchment gauge too. A run reads those days as missing, so the record’s next source stands in: for a station its corrected CHIRPS, for a unit’s own gauge its own CHIRPS, levelled, then the next link of its rule, for the alternative gauge the next source of its rain-source period. A station’s and a unit gauge’s are blanked after their zero-run and accumulation checks, so a marked period never looks like a blank outage. A station’s count only while it is assigned. The catchment gauge’s own days are the missing periods under Flagged zero runs. The stored series never changes.',
		aliases: ['rainfall station', 'rain station', 'station per unit', 'assigned station', 'scale to unit MAP', 'bias-correct against', 'rainStations', 'patch gaps', 'patching priority', 'patch station', 'driver rainfall', 'CHIRPS driver', 'raw CHIRPS', 'bias-corrected CHIRPS', 'k_unit'],
		related: ['unit-rain', 'unit-map', 'chirps-bias', 'flow-share'],
		source: 'docs/model.md §2.4i; issues #553, #612'
	},
	'catchment-rain-station': {
		long: 'Under Model settings → Flow generation, **The catchment’s rainfall station** sets where the catchment rain comes from: the rain demand and the dams read, and the rain GR4J runs on for a unit scaled from the catchment gauge or with no rain of its own. **No station** (the default) keeps the catchment rain series, as before stations.\n\nWith a station it follows the same rule as a unit’s station (see A unit’s rainfall station):\n\n• **On the station’s days** the catchment runs on its rain × catchment MAP ÷ station MAP, held between 0.25 and 4; untick **Scale to catchment MAP** to run on its rain as recorded. The catchment MAP is the one entered under **Catchment MAP** with its source, else the land units’ area-weighted mean MAP; with neither (a unit has no MAP) the ratio is 1, with a warning.\n• **On its gaps and unreliable days** the first source in **Then patch gaps from** with a reading fills in: another station × catchment MAP ÷ that station’s MAP, or **CHIRPS, corrected**: the catchment’s CHIRPS corrected month by month against the rain of the station chosen under **Gaps: CHIRPS corrected against** (its own by default) at the catchment’s MAP. CHIRPS alone is the default; an empty list sends the gaps to the forecast, else they are dry.\n• Each station in the list says how many of the main station’s gap days it fills over the run’s days before any forecast, or why it can’t help (no record, no MAP, or no reading on any of those gaps): such a station is greyed out.\n\nUnder a catchment station the areal rainfall correction, the rain-source periods and the gap-filling product are not read: the station and its patching priority replace them, and the run warns. Changing the station changes the rain GR4J runs on: refit afterwards.',
		aliases: ['catchment station', 'catchment rainfall station', 'catchment rain station', 'station for the catchment'],
		related: ['rain-stations', 'unit-rain', 'chirps-bias', 'areal-rain'],
		source: 'docs/model.md §2.4i; issue #612'
	},
	'actual-evaporation': {
		long: 'The part of potential evaporation that rain meets directly, plus what the soil-moisture store can give up. On dry days with a dry store it falls well below PET.',
		related: ['gr4j', 'pan-coefficient'],
		source: 'Perrin et al. (2003)'
	},
	'wr2012-check': {
		long: 'WR2012 (Water Resources of South Africa 2012) gives each quaternary catchment a naturalised mean annual runoff (MAR) and mean monthly flows: the river as it would be with no hydrological units, dams or abstraction. Enter them from the study for the quaternary this project lies in, with the period they cover and where they come from. The app doesn’t ship WR2012 data.\n\nEach run then compares its simulated natural flow, never the outflow, with the reference. The reference is scaled to the modelled catchment by the area ratio (the default), or, if you choose it and the quaternary MAP is entered, by the area and the rainfall ratio (the run’s mean annual rain ÷ the quaternary MAP). Runoff doesn’t scale in proportion to rain, so treat the rainfall scaling as a first estimate.\n\nThe report gives the MAR ratio over the complete water years both cover and over the whole run, the 12 monthly ratios with the dry-season months marked, and the correlation of the monthly pattern. A MAR that differs by 10 % is noted, by 25 % (or 15 % wetter) is queried, and by 50 % makes the run unusable for EWR findings until it is explained. The thresholds are editable.\n\nMonthly means are in million m³ per month (not m³/s) and should add up to the MAR within 5 %. A MAR larger than the rain on the quaternary (MAP × area) is rejected.',
		aliases: ['WR2012', 'naturalised flow', 'naturalized flow', 'MAR', 'quaternary', 'Water Resources of South Africa'],
		related: ['natural-flow', 'wr2012-penalty', 'gr4j'],
		source: 'Bailey & Pitman, Water Resources of South Africa 2012 Study (WRC); docs/model.md § WR2012 check',
		countries: ['ZA']
	},
	'catchment-area': {
		long: 'Each hydrological unit makes its runoff over its own area (Per unit, the only method), so once a unit has land the units’ areas are the catchment’s and this override is not used: the run warns if it is set and differs. It applies only to a model with no unit with land. 1 mm over 1 km² = 1 000 m³.',
		related: ['farm-area', 'gr4j'],
		source: 'b023 Farm spec (total area)'
	},
	'rain-threshold': {
		long: 'Filters out drizzle that the soil absorbs, so it doesn’t reduce irrigation demand (“Rain threshold for demand”). GR4J uses all the rain. The workbook’s default, and a new project’s, is 2 mm. In the legacy runoff model (removed in engine 1.0.0) the same thresholded rain also drove runoff (quirk Q6).',
		related: ['effective-rainfall', 'legacy-runoff-model'],
		source: 'b023 Flow Calibration Cfg; docs/model.md §3 Q6'
	},
	'base-flow': {
		long: 'GR4J has no separate base-flow store: its routing store carries most of the storm flow too. Where the app needs base flow (Low flows judged on) it separates it from the flow with the Lyne–Hollick filter. The Base flow column of a daily table belongs to a legacy run (engine < 1.0.0): there base flow receded day by day along the recession curve, and a big enough rain pulse reset it to the pulse size.',
		aliases: ['baseflow', 'low flow', 'quickflow'],
		related: ['gr4j', 'legacy-runoff-model'],
		source: 'b023 Flow data; docs/model.md §2.4'
	},
	'legacy-runoff-model': {
		long: 'The workbook’s empirical model: rain above the threshold made a peak a · rain^b × catchment area × a summer or winter factor (a summer month, or a winter month before a big storm switched it to winter response), which then receded along a recession curve, next to a slowly receding base flow. The engine audit found that it does not conserve water: one small storm could return several times its own volume as flow, so it was never evidence and engine 1.0.0 removed it.\n\nRuns made with it before then still open read-only, badged “Workbook comparison”: they can be compared and exported, but not re-run, nominated as evidence, signed or published. Their daily table keeps the model’s own columns (summer flag, rain flow, response flow, base flow). A project still set to it runs GR4J, with a warning to check the GR4J parameters.',
		aliases: ['legacy model', 'workbook recession', 'peak coefficient', 'summer factor', 'winter factor', 'summer months', 'recession curve', 'workbook comparison'],
		related: ['runoff-model', 'gr4j', 'base-flow'],
		source: 'docs/model.md §2.4 (retired); docs/engine-audit.md H1; issue #16'
	}
};
