// The "How it works" guides on /help.
// Joined into GUIDES by ./guides.ts, in this order, in a module (and a chunk,
// vite.config.ts helpArticlesChunk) of its own, so no one chunk of help text nears the
// bundle guard's per-chunk ceiling (2026-11-25). Same markup as every guide
// (./guides.ts `inline`); type-only import, so no cycle at run time.

import type { Guide } from './guides';

export const CONCEPT_GUIDES: Guide[] = [
	{
		id: 'how-the-model-works',
		title: 'How the model works',
		summary: 'The chain from daily rain to hydrological unit supply, dam storage, outflow and the EWR check.',
		kind: 'concept',
		sections: [
			{
				heading: 'The daily chain',
				blocks: [
					{
						type: 'diagram',
						id: 'pipeline',
						caption:
							'One run, every day of the simulation window. The runoff model makes the catchment’s natural flow; the network then routes it through hydrological units and dams to the outflow gauge, where the EWR and the calibration are checked.'
					},
					{
						type: 'steps',
						items: [
							'**Rain.** Each day takes the first available of catchment rain, bias-corrected CHIRPS and forecast rain. See [[guide:rain-gap-filling|How rain gaps are filled]].',
							'**Natural flow.** The [[runoff-model]] (GR4J) turns rain and evaporation into the flow the catchment would produce with no hydrological units. Under [[unit-rain|flow generation]] (Per unit) it runs once for each unit with land, each on its own rain: its rainfall station × unit MAP ÷ station MAP when it has one; else the unit’s own gauge; else the catchment gauge × unit MAP ÷ gauge MAP; else the unit’s own CHIRPS, levelled to its MAP; else the catchment rain. The outlet’s natural flow is then their routed sum.',
							'**Shares.** The EWR is split between the hydrological units by each unit’s [[flow-share|natural MAR share]], from GR4J on its own rain; each unit’s runoff is its own.',
							'**Demand.** Crops, A-pan and effective rain give each hydrological unit’s [[crop-requirement|crop water requirement]]; divided by the [[irrigation-efficiency|irrigation efficiency]] it is the [[irrigation-demand|abstraction demand]], what the hydrological unit takes from its dam and the river.',
							'**Hydrological unit balance.** Upstream first, each hydrological unit fills its dam, irrigates, spills and passes water on. See [[guide:a-day-on-a-farm|A day on one hydrological unit]].',
							'**Outlet.** The outflow gauge’s flow is the simulated outflow. It is checked against the EWR and scored against observed flow. Every other gauge ticked as an **EWR site** (the default) is checked too, and a shortfall at any EWR site is charged to the hydrological units upstream of it ([[ewr-charge]]); a gauge unticked only measures.'
						]
					}
				]
			},
			{
				heading: 'Properties you can rely on',
				blocks: [
					{
						type: 'list',
						items: [
							'Flows and volumes are m³/day inside the model. Nothing is rounded mid-calculation; rounding is for display only.',
							'Every hydrological unit’s daily balance closes: inflow + rain on the dam − irrigation use − dam evaporation − change in storage = outflow. Invariant tests check this on random networks, and every run checks it again on its own results (**Arithmetic checks** on Runs & results).',
							'A run is a snapshot: it records its inputs and engine version, so its results can always be explained and reproduced.',
							'Where the engine departs from the Water Balance Tool workbook, the engine audit records why.'
						]
					}
				]
			}
		],
		terms: ['water-balance', 'natural-flow', 'farm-runoff', 'farm-outflow'],
		related: ['a-day-on-a-farm', 'how-gr4j-works', 'rain-gap-filling']
	},
	{
		id: 'a-day-on-a-farm',
		title: 'A day on one hydrological unit',
		summary: 'How a hydrological unit element splits its inflows around the dam, irrigates, spills and passes water downstream.',
		kind: 'concept',
		tab: 'network',
		sections: [
			{
				heading: 'One hydrological unit, up close',
				blocks: [
					{
						type: 'picture',
						shot: 'farm',
						caption: 'A hydrological unit (here a farm) on a tributary: its dam, the orchard it irrigates and the pipeline to a neighbour’s dam. Follow the numbers in the order the model works through a day.',
						stops: [
							{ spot: 'upstream', title: 'Inflow from upstream', text: 'The stream brings the outflow of the elements above. The [[upstream-to-dam|upstream share]] of it enters the dam.' },
							{ spot: 'runoff', title: 'The hydrological unit’s own runoff', text: 'The hydrological unit’s [[flow-share|share]] of the catchment’s natural flow. Its [[runoff-to-dam|own-runoff share]] drains into the dam.' },
							{ spot: 'storage', title: 'Dam storage', text: 'Yesterday’s storage plus rain on the dam, today’s captured inflow, diversion and transfers, less [[dam-evaporation|evaporation]], [[dam-seepage|seepage]] and irrigation, up to the [[dam-capacity|capacity]].' },
							{ spot: 'spill', title: 'Spill over the wall', text: 'Water above capacity [[spill|spills]] and continues downstream the same day.' },
							{ spot: 'irrigation', title: 'Irrigation draw', text: 'The dam supplies the hydrological unit’s [[irrigation-demand|irrigation demand]], or what it holds above its [[dam-min|minimum level]] if that is less.' },
							{ spot: 'crops', title: 'The crops', text: 'The crop gets the supply × the [[irrigation-efficiency|irrigation efficiency]]. Part of the losses runs back to the river as [[return-flow|return flow]]; the rest leaves the catchment.' },
							{ spot: 'transfer', title: 'Transfer to a neighbour', text: 'A [[transfer]] can move water out of (or into) this dam in chosen months.' },
							{ spot: 'outflow', title: 'Outflow', text: 'Spill, water that passed below the dam, seepage and return flow leave as the hydrological unit’s [[farm-outflow|outflow]], the next element’s inflow.' }
						]
					}
				]
			},
			{
				heading: 'Around the dam',
				blocks: [
					{
						type: 'diagram',
						id: 'farm-day',
						caption:
							'Water arriving from upstream and the hydrological unit’s own runoff each split into a part that enters the dam and a part that passes below it. A diversion can take some of the bypass back into the dam. Irrigation draws from the dam; spill, bypass and return flow leave downstream.'
					},
					{
						type: 'steps',
						items: [
							'Upstream inflow × [[upstream-to-dam|upstream share]] enters the dam; the rest passes below it.',
							'Hydrological unit runoff × [[runoff-to-dam|own-runoff share]] enters the dam; the rest passes below it.',
							'The [[diversion]] takes up to its daily capacity from the water passing below, back into the dam.',
							'A [[transfer]] adds to or takes from the dam. Transfers move first, before any hydrological unit irrigates.',
							'The dam catches the rain on its surface and loses [[dam-evaporation|open-water evaporation]] and any [[dam-seepage|seepage]]; the share of the seepage set by **Seepage returning** (all of it by default) reaches the river below the wall, and the rest leaves the catchment.',
							'Irrigation takes the smaller of the [[irrigation-demand|demand]] and what the dam holds above its [[dam-min|minimum level]] (yesterday’s storage plus today’s inflows and the rain on it, less evaporation and seepage).',
							'Storage above capacity [[spill|spills]]. [[return-flow|Return flow]] is the share of the irrigation water supplied that returns to the river the same day (never more than the losses).',
							'Outflow = spill + water passing below the dam not diverted + returning seepage + return flow. It is the next element’s upstream inflow.'
						]
					}
				]
			},
			{
				heading: 'The balance',
				blocks: [
					{
						type: 'formula',
						text: 'upstream inflow + runoff + transfer + rain on the dam − (irrigation − return flow) − dam evaporation − seepage lost − Δ storage = outflow'
					},
					{
						type: 'p',
						text: 'It closes to the cubic metre every day ([[balance-check|the balance check]]). The seepage that returns is part of the outflow; the seepage lost (what **Seepage returning** doesn’t return) and the dam’s evaporation leave the catchment.'
					}
				]
			}
		],
		terms: ['dam-storage', 'dam-evaporation', 'irrigation-efficiency', 'irrigation-supplied', 'irrigation-deficit'],
		related: ['how-the-model-works', 'build-the-network']
	},
	{
		id: 'how-gr4j-works',
		title: 'How GR4J turns rain into flow',
		summary: 'Two stores and two unit hydrographs, four parameters, and a water balance that always closes.',
		kind: 'concept',
		tab: 'calibration',
		sections: [
			{
				heading: 'Under the ground',
				blocks: [
					{
						type: 'picture',
						shot: 'soil',
						caption: 'The cut face of the catchment beside the river. GR4J is a conceptual model: its two stores stand roughly for the moist soil and the groundwater, not for measured layers.',
						stops: [
							{ spot: 'rain', title: 'Rain', text: 'Rain first meets evaporation. What is left is net rain.' },
							{ spot: 'evaporation', title: 'Evaporation', text: 'Plants and soil return water to the air, up to the [[pan-coefficient|potential evaporation]].' },
							{ spot: 'soil', title: 'The soil store (X1)', text: 'Net rain partly fills the production store. A larger X1 holds more rain back, so less of it becomes flow.' },
							{ spot: 'groundwater', title: 'The routing store (X3)', text: 'Water that percolates on is released slowly. A larger X3 means slower, longer recessions between storms.' },
							{ spot: 'river', title: 'Flow in the river', text: 'The routing store’s release plus a quick direct part is the [[natural-flow]]; X4 sets how many days a storm takes to arrive.' }
						]
					}
				]
			},
			{
				heading: 'The structure',
				blocks: [
					{
						type: 'diagram',
						id: 'gr4j',
						caption:
							'GR4J (Perrin et al. 2003). Rain first meets evaporation. What is left partly fills the soil (production) store; the rest, with what percolates out of it, is spread in time by two unit hydrographs. 90 % passes through the routing store, 10 % goes directly to the outlet.'
					},
					{
						type: 'list',
						items: [
							'**X1** (mm): capacity of the soil-moisture store. Larger means more rain is held and evaporated, so less flow. Typical 100–1 200.',
							'**X2** (mm/day): exchange with groundwater outside the catchment. Fixed at 0 by default, so the catchment is closed.',
							'**X3** (mm): capacity of the routing store. Larger means slower, longer recessions. Typical 20–300.',
							'**X4** (days): time base of the unit hydrographs, the timing of the peak. Typical 1.1–2.9.'
						]
					}
				]
			},
			{
				heading: 'Forcing and warm-up',
				blocks: [
					{
						type: 'p',
						text: 'Rain is the gap-filled catchment rain, with no rain threshold. Potential evaporation is the monthly [[pan-coefficient]] × A-pan, spread over the days of the month. A warm-up (a year by default) runs over the start of the record first, so the stores begin at a realistic level; warm-up days are never shown or scored.'
					},
					{
						type: 'formula',
						text: 'rain − actual evaporation − flow − groundwater exchange = change in storage   (every day)'
					},
					{
						type: 'p',
						text: 'The **Runoff model** panel on a GR4J run shows this balance in mm and as a share of rain. It is the first thing to check when a fit looks too wet or too dry.'
					}
				]
			}
		],
		terms: ['gr4j', 'actual-evaporation', 'pan-coefficient', 'runoff-model'],
		related: ['how-calibration-works', 'calibrate-by-hand']
	},
	{
		id: 'how-calibration-works',
		title: 'How calibration works',
		summary:
			'What is scored, how the optimiser searches, and why validation on unseen days matters more than the fit.',
		kind: 'concept',
		tab: 'calibration',
		sections: [
			{
				heading: 'What is scored',
				blocks: [
					{
						type: 'picture',
						shot: 'weir',
						caption: 'The catchment outlet. The observed record comes from here; the model’s simulated outflow is its prediction of the same place.',
						stops: [
							{ spot: 'gauge', title: 'The gauging hut', text: 'A gauge or logger records the water level, turned into [[observed-flow|observed flow]] by a rating curve. High flows beyond the highest measurement are extrapolated, so they are the least certain.' },
							{ spot: 'weir', title: 'The weir', text: 'A control that makes level and flow relate reliably. The model’s [[outflow-gauge]] stands for this point.' },
							{ spot: 'reach', title: 'The river above it', text: 'What arrives here is the whole catchment’s outflow, hydrological units and dams included, which is why the whole model is scored, not the runoff model alone.' }
						]
					},
					{
						type: 'p',
						text: 'An observed gauge or logger measures the river as it is, with its hydrological units and dams. So every candidate parameter set runs the **whole model** (runoff model, then the network) and scores the simulated outflow against the observed record. The fitted parameters describe the natural catchment; the network adds the impacts.'
					},
					{
						type: 'p',
						text: 'Scored days are days with an observation, inside the [[calibration-window]], outside every [[calibration-exclusions|exclusion]], and not left out by the [[quality-flags|quality flags]] (by default days below the lowest gauging, suspect and infilled days; days above the highest gauging are censored). At least 30 are needed.'
					}
				]
			},
			{
				heading: 'The search',
				blocks: [
					{
						type: 'diagram',
						id: 'calibration-loop',
						caption:
							'Fit automatically. DDS starts from the current parameters, perturbs them within their bounds, runs the whole model and keeps a candidate only when it scores better. By default it tries 1 500 candidates per search.'
					},
					{
						type: 'p',
						text: 'The optimiser is DDS (Tolson & Shoemaker 2007). Early on it perturbs every parameter; later it changes fewer, homing in on the best set found. Candidates are always kept within the [[calibration-bounds|bounds]]. The search is deterministic for a seed: the same data, engine version and seed give the same fit. The app runs five searches (starts) from different seeds and keeps the best; when several reach nearly the same score with scattered parameters, the notes say the record can’t pin those parameters down.'
					},
					{
						type: 'list',
						items: [
							'**KGE′ (Kling–Gupta, 2012)** (default): correlation, bias and variability in one score, less peak-dominated than NSE.',
							'**Year-balanced KGE′**: each water year counts once, so a few wet years can’t dominate a drought-heavy record.',
							'**Non-parametric KGE**: rank correlation, the flow-duration curve’s shape and the bias, so less sensitive to rating error at the extremes.',
							'**NSE on √Q** (medium flows) and **NSE on log Q** (low flows).',
							'**Mean of KGE′(Q) and KGE′(1/Q)** (the scores table calls it **Low/high-flow KGE′ (Q and 1/Q)**): half the score on the flows, half on their inverses, so recessions and low flows count as much as the peaks. Suggested when the fit feeds an EWR (low-flow) decision.'
						]
					},
					{
						type: 'p',
						text: 'Choose the [[calibration-objective|objective]] by what the fit will feed, before seeing any score, never by which one scores best: scores of different objectives don’t compare.'
					}
				]
			},
			{
				heading: 'Validation: the honest measure',
				blocks: [
					{
						type: 'diagram',
						id: 'validation',
						caption:
							'Each test fits on one part of the record and scores another part it never saw. The dry → wet test fits on the driest water years and scores the wettest, which is the hardest test for a catchment used in drought.'
					},
					{
						type: 'list',
						items: [
							'**Split-sample** (Klemeš 1986): fit on the first half of the scored days, score the second half.',
							'**Dry → wet**: with at least 4 water years of 180 or more observed days, fit on the driest half and score the wettest half.',
							'**Independent record** (optional): score the fitted parameters against the second instrument, for example the logger when the fit used the gauge.'
						]
					},
					{
						type: 'p',
						text: 'The result adds plain-language notes on its limits: too few years to test wet years, wet years barely wetter than dry ones, or a validation score more than 0.2 below its calibration score. A short record that is mostly drought gets these notes rather than a clean bill of health.'
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'A fit that scores well in-sample but poorly in validation usually means the record can’t pin the parameters down, not that the optimiser failed. More model runs won’t help; more varied data, typical bounds or a WR2012 check will.'
					}
				]
			}
		],
		terms: ['auto-calibration', 'fit-record', 'kge', 'nse', 'log-nse', 'pbias'],
		related: ['fit-automatically', 'calibrate-by-hand', 'check-against-wr2012']
	},
	{
		id: 'rain-gap-filling',
		title: 'How rain gaps are filled',
		summary: 'Which rain series a day uses, and how CHIRPS is bias-corrected to the catchment before it fills a gap.',
		kind: 'concept',
		tab: 'series',
		sections: [
			{
				heading: 'One value per day',
				blocks: [
					{
						type: 'diagram',
						id: 'rain-sources',
						caption:
							'Each day takes the first series that has a value. CHIRPS is scaled by its calendar month’s catchment ÷ CHIRPS factor before it is used. A day with no value anywhere is treated as dry, and the run counts those days.'
					},
					{
						type: 'p',
						text: 'A 0 is a reading, so it blocks the fallback. Long wet-season runs of zeros that the **Data checks** flag are the exception: by default a run treats their days as blank where CHIRPS reads more than 2 mm, so CHIRPS fills those, and a day CHIRPS reads 2 mm or less keeps its 0, since CHIRPS reports too many light-rain days ([[zero-rain-runs|zero-rain runs]]). On **Model settings → Rain gaps** you can change the 2 mm, keep a confirmed dry spell dry, run every flagged run as recorded, or list other bad periods to treat as missing. The uploaded series is never changed.'
					},
					{
						type: 'p',
						text: 'A large reading after 3 to 7 blank days, on a day CHIRPS reads little although it saw rain over those days, looks like several days read at once ([[rain-accumulations|a multi-day accumulation]]). By default a run keeps its recorded total and spreads it over the days it covers in proportion to bias-corrected CHIRPS. Days recorded as 0 are readings, so a large reading after them is real rain and stays on its day. More than 7 blank days in a row is an outage: such a reading straight after one is set aside and CHIRPS fills its day, since it may hold weeks of rain or one day’s. Under **Multi-day accumulations** on the same panel you can run them as recorded, keep readings you know were one day’s rain, or list accumulations the check misses.'
					},
					{
						type: 'p',
						text: 'The result is the [[rain-final|final catchment rainfall]], which the runoff model (GR4J) and the effective-rain part of demand use. The daily CSV export puts it beside CHIRPS as uploaded and bias-corrected CHIRPS, so filled days can be checked.'
					},
					{
						type: 'p',
						text: 'Under [[unit-rain|flow generation]] (**Model settings → Flow generation**), each unit with land gets a rain series of its own: its [[rain-stations|rainfall station]] × unit MAP ÷ station MAP when it is given one, its gaps filled by its CHIRPS corrected against a station; else, in this order, its **own gauge**, with the same zero-run and accumulation checks, its gaps and set-aside days taking its CHIRPS levelled to its MAP; else the **catchment gauge × unit MAP ÷ gauge MAP**, when the gauge’s MAP is set and the unit has one; else its **own CHIRPS**, levelled by its MAP ÷ the CHIRPS mean over the MAP period; else the catchment rain, with a warning. Demand, rain on the dams and the WR2012 check keep the catchment rain. A seasonal outlook, the uncertainty ensemble’s CHIRPS-only member and a run resumed from a saved state keep each unit’s rule and factors **pinned** as the base run had them, rather than refitting them on a shorter record; the run’s Rain for each unit panel then says its factors are pinned.'
					},
					{
						type: 'p',
						text: 'Where Settings assigns a rainfall station, the **Data** page shows what a run reads: a hydrological unit’s row, or **Average catchment rainfall**, says how its rain is made (the station × area MAP ÷ station MAP, gaps from CHIRPS corrected against a station), and **Show rain used** charts that rain with the station and CHIRPS lines behind it and a strip for the days that didn’t come from the station. **Download (CSV) → Full** has every one of those lines by day.'
					}
				]
			},
			{
				heading: 'The CHIRPS factors',
				blocks: [
					{
						type: 'formula',
						text: 'factor(month) = Σ catchment rain ÷ Σ CHIRPS   over the days of that calendar month that have both'
					},
					{
						type: 'list',
						items: [
							'Water years that read far below CHIRPS are left out whole, and so are the days of flagged zero runs (unless kept dry), of periods listed as missing and of multi-day accumulations, because their catchment rain is suspect.',
							'A month with fewer than 90 shared days, or under 50 mm of CHIRPS on them, uses the factor pooled over all months.',
							'Factors are kept between 0.25 and 4. Each run lists them in its warnings and the summary CSV.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Choose **Raw CHIRPS** only when the series you loaded is already corrected to the catchment; otherwise it is corrected twice.'
					}
				]
			}
		],
		terms: ['rain-catchment', 'chirps', 'chirps-bias', 'zero-rain-runs', 'rain-forecast'],
		related: ['add-data', 'how-the-model-works']
	},
	{
		id: 'curtailment-targets',
		title: 'Curtailment targets',
		summary: 'How the app compares each hydrological unit’s supply with a fairness benchmark and works out the cut that meets the EWR.',
		kind: 'concept',
		tab: 'supply',
		sections: [
			{
				heading: 'The idea',
				blocks: [
					{
						type: 'p',
						text: 'Over the [[report-window|reporting window]], add up what every hydrological unit asked for and what it received. Their ratio is the catchment’s [[equitable-share|equitable share of supply]] (a **fairness benchmark**): had the supplied water been shared in proportion to demand, every hydrological unit would have received that fraction.'
					},
					{
						type: 'formula',
						text: 'equitable share volume = demand × Σ supplied ÷ Σ demand          above (−) / below (+) equitable share = equitable share volume − supplied'
					},
					{
						type: 'p',
						text: 'The differences cancel across the hydrological units, so this only compares; a positive value is not water the hydrological unit can get. Each hydrological unit’s [[ewr-charge|EWR charge]] (its share of the shortfall at the EWR sites below it) is then split into [[ewr-charge-split|irrigating less and storing less]], and the supply cut for the irrigation part is added: the **total change** in supply. Negative means reduce. The volume left never goes below 0, nor below the hydrological unit’s [[basic-needs-floor|basic-needs floor]] (25 litres a person a day for the people its domestic and municipal demands serve); what the floor keeps of the cut is shown in its row.'
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'The equitable share is a fairness benchmark only: it assumes water can move freely between hydrological units, and ignores network position, storage, licences and existing lawful use. Not an allocation or licence condition.'
					}
				]
			}
		],
		terms: ['irrigation-demand', 'irrigation-supplied', 'pragmatic-ewr', 'equitable-share', 'ewr-charge', 'ewr-charge-split', 'demand-left', 'basic-needs-floor'],
		related: ['set-the-ewr', 'run-and-read-results']
	}
];
