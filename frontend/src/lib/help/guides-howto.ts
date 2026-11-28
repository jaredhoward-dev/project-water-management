// The "How to" guides on /help.
// Joined into GUIDES by ./guides.ts, in this order, in a module (and a chunk,
// vite.config.ts helpArticlesChunk) of its own, so no one chunk of help text nears the
// bundle guard's per-chunk ceiling (2026-11-25). Same markup as every guide
// (./guides.ts `inline`); type-only import, so no cycle at run time.

import type { Guide } from './guides';

export const HOWTO_GUIDES: Guide[] = [
	{
		id: 'create-a-project',
		title: 'Create a project',
		summary: 'Start a new catchment, put it in a team, and copy an existing one to try a what-if.',
		kind: 'howto',
		tab: 'overview',
		sections: [
			{
				heading: 'A new project',
				blocks: [
					{
						type: 'steps',
						items: [
							'Open **Projects** in the sidebar (on a phone, under **Menu**) and press **New project**.',
							'Give it a name, usually the catchment or river. Under **Belongs to**, pick a team if others will work on it, and press **Create project**.',
							'The project opens on its **Summary** tab. Work through the setup checklist from the top.'
						]
					},
					{
						type: 'p',
						text: 'One project holds one catchment: its network, crops, settings, input series and runs. A Water Balance Tool workbook becomes one project: anyone can bring one in with **Import workbook** on the Projects page (and a project downloaded from the app with **Import project file (.json)**).'
					}
				]
			},
			{
				heading: 'Start from an example',
				blocks: [
					{
						type: 'p',
						text: 'To look round a finished model before building your own, press **Start from an example** on the Projects page while you have no projects. It makes an invented winter-rainfall catchment your own project (four hydrological units, fruit farms with dams, two transfers, a calibrated runoff model and 15 years of made-up rainfall), runs it and opens that run on **Runs & results**. Every name and number in it is made up. Change it as you like, and delete it from its row’s **⋯** menu when you’re done.'
					}
				]
			},
			{
				heading: 'Reading the Projects page',
				blocks: [
					{
						type: 'p',
						text: 'Each row says how its catchment is doing, from its published run (or its latest run when none is published): irrigation supplied over the run in words (the share of demand, green from 95 %, amber from 80 %), the hydrological units short this week, the lowest dam, how far the rain data goes (**Rain to 31 Dec 2024 (20 months ago)**), when the project was last edited and when it last ran. Once a catchment’s figures are more than a week old, “this week” and “last 30 days” become the dates they end on (“short in the week to 31 Dec 2024”). **Needs attention** at the top lists the catchments to look at first (red or amber irrigation supply, hydrological units short, alerts firing, failing feeds, newer rain than the figures, figures over a week old), each with its reasons. The chips filter by owner, and **Sort** or a column heading orders the list; both stay in the page’s address.'
					}
				]
			},
			{
				heading: 'A copy for a what-if',
				blocks: [
					{
						type: 'steps',
						items: [
							'On the Projects page, open the **⋯** menu on the project’s row, choose **Copy…** and name the copy. The model and the data are copied; runs are not.',
							'Name it after the change you plan, for example “Raise dam 3 by 20 %”.',
							'Make the change in the copy and run it. The original and its runs are untouched.',
							'Compare the copy’s run with the original’s. See [[guide:compare-runs|Compare runs and try what-ifs]].'
						]
					}
				]
			},
			{
				heading: 'Who can do what',
				blocks: [
					{
						type: 'p',
						text: '[[roles|Editors]] change the model, upload data and run it. Viewers see everything, can fit the runoff model to explore, and can download results, but can’t save or run. A viewer’s workspace says “View only”. In a team, each person has the same role on every team project as in the team; owners can also delete, share and move the project (sharing and moving are on its **Project** page).'
					}
				]
			}
		],
		terms: ['project', 'run'],
		related: ['the-whole-process', 'build-the-network']
	},
	{
		id: 'build-the-network',
		title: 'Build the river network',
		summary: 'Add hydrological units and gauges, connect each one to the element it drains into, and end at one outflow gauge.',
		kind: 'howto',
		tab: 'network',
		sections: [
			{
				heading: 'The shape of a network',
				blocks: [
					{
						type: 'p',
						text: 'The network is a tree. Each element drains into exactly one element downstream, and exactly one element, the [[outflow-gauge]], drains nowhere. An element can have several upstream neighbours. The model works out the calculation order itself, upstream first.'
					},
					{
						type: 'diagram',
						id: 'network',
						caption:
							'A small network. Hydrological units are circles, hydrological units with a dam are filled squares, gauges are triangles, and the outflow gauge is filled. The dashed arrow is a transfer between two dams.'
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Start with **Add outflow gauge**: the gauge at the catchment outlet.',
							'Press **+ Add hydrological unit** for each hydrological unit (its form opens in a sheet over the map), set its **Kind**, and set **Drains into** to the element directly below it on the river. To enter many at once, use the hydrological unit table (**Tables** › **Hydrological unit table**).',
							'Add gauges where you want to read flow in the middle of the catchment, for example at a weir with a record.',
							'Give every hydrological unit its **area** (km²).',
							'For a hydrological unit with a dam, set the [[dam-capacity]], the [[dam-initial|initial storage]], its [[dam-min|minimum level]], and how much of the upstream inflow and of its own runoff enter the dam. A hydrological unit’s full form (**Edit** on its row under **All hydrological units**, or double-click it in the drawing) also has the dam’s [[dam-evaporation|area when full]] and its [[dam-seepage|seepage]].',
							'Set the share of the water supplied that returns to the river as [[return-flow|return flow]] (10 % for a new unit) and any [[diversion|diversion back to the dam]]. The hydrological unit’s [[irrigation-efficiency|irrigation efficiency]] comes from its crops’ [[irrigation-system|irrigation systems]] (Crops & demand). Under **Supply**, set where its irrigation comes from (the [[supply-rule|supply rule]]); **Split the crops’ water between sources** gives it a [[crop-supply-table|crop supply table]]: fixed shares from its own dam, the river at the unit and another unit’s dam. Where the crops or a demand take from the river at a pump of their own ([[water-source]]), give the pump’s capacity and, if it draws from a pool, the **Pool at the pump** (m³): it starts full, the pump draws it once the river’s share is used, and it refills from what the river has left.',
								'Only with evidence (a gauge below that the model keeps over- or under-simulating at low flows), set the unit’s **Base-flow loss and gain** (m³/day): water its own runoff loses to groundwater, out of the catchment, or gains from a spring or aquifer beyond the divide, before it reaches the river or the dam ([[base-flow-loss-gain]]); **Vary by month** under the section sets each month apart, a loss in the wet months and a gain in the dry. A river losing water between two units is a bed loss instead (**Bed losses in the reach below**).',
							'Press **Save changes** on the save bar (or in the hydrological unit’s sheet).'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'In the schematic you can drag a hydrological unit onto another to change what it drains into. A drop that would make a loop, or move the outlet, is refused with the reason. In the hydrological unit table (**Tables** › **Hydrological unit table**), **Sort by flow path** orders the rows from each headwater down. Once the model has been run, the map shades each hydrological unit by the share of its irrigation demand that run supplied (95% or more, 70–95%, under 70%; **Colour hydrological units by** › **Supply, latest run**, on by default); a hydrological unit added since the run is hatched. The same menu colours the hydrological units by their dam level at the end of the latest run. A name longer than 17 characters is shortened on the map, keeping the ending when two names would otherwise look alike (hover a hydrological unit, or read the list beside the map, for its full name); a transfer that can’t curve clear of the names is drawn round them.'
					}
				]
			},
			{
				heading: 'Dams and natural areas',
				blocks: [
					{
						type: 'p',
						text: 'A hydrological unit also covers two other cases, set by its parameters:'
					},
					{
						type: 'list',
						items: [
							'**Stand-alone dam**: no crop areas (so no irrigation), 100 % of its runoff (and of upstream inflow, if it sits on the main stem) into the dam, and no diversion.',
							'**Natural area**: no crops, no dam capture and no diversion. It simply passes its runoff on.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'A river that splits in two (a bifurcation) can’t be drawn. Use a transfer for the side channel, or merge the hydrological units.'
					}
				]
			}
		],
		terms: ['network', 'element-farm', 'element-gauge', 'outflow-gauge', 'upstream-to-dam', 'runoff-to-dam'],
		related: ['a-day-on-a-farm', 'add-a-transfer']
	},
	{
		id: 'set-up-crops-and-demand',
		title: 'Set up crops and irrigation demand',
		summary: 'Crops with monthly crop factors, the hectares on each hydrological unit, A-pan evaporation and effective rain.',
		kind: 'howto',
		tab: 'crops',
		sections: [
			{
				heading: 'How demand is worked out',
				blocks: [
					{
						type: 'formula',
						text: 'gross demand (m³/day) = Σ crops [ area × A-pan (mm/month) × crop factor ] ÷ days in the month'
					},
					{
						type: 'formula',
						text: 'effective rain Pe = cropped area × the day’s rain (0 at or below the threshold) × effective-rain fraction; crop requirement = gross − min(soil store + Pe, gross)'
					},
					{
						type: 'formula',
						text: 'irrigation demand (abstraction) = crop requirement ÷ irrigation efficiency'
					},
					{
						type: 'p',
						text: 'Gross demand is the same every day of a month. Rain above the [[rain-threshold]] covers the day’s demand first; what the crop can’t use that day stays in the [[soil-water-store]] (25 mm by default) and covers the following days, so wet spells need less irrigation after the rain too. The hydrological unit then abstracts more than the crop needs, to cover its application losses ([[irrigation-efficiency]]).'
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Crop factors multiply **A-pan** evaporation, not FAO reference ET₀. A published FAO-56 Kc overstates demand by about 18–67 % (a third at a pan coefficient of 0.75) unless you first multiply it by the pan coefficient (usually 0.60–0.85).'
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'On **Crops & demand**, press **+ Add crop**: its sheet opens over the page. Name it and enter its 12 monthly [[crop-factor|crop factors]] (Oct … Sep). Each crop then has a row in the **Crops** list, largest planted area first, with its colour, area, the month it needs most water and a small chart of its factors (Oct to Sep, the highest marked with its value; point at it to read a month); **Edit** on the row opens the sheet again. A warning icon on a row means a factor above 1.0 (hover or focus it; it opens the sheet). With more than nine crops, the smallest share one grey colour as **Other**, named in their own row.',
							'Under **Planted area by hydrological unit**, press **Edit areas** and enter the hectares of each crop on each hydrological unit in the grid. Leave a crop blank on hydrological units that don’t grow it. Each hydrological unit then gets a bar split by crop in the list’s colours, largest hydrological unit first (hover a segment for its crop and hectares); a note under the bars names any hydrological unit with nothing planted, whose demand is zero.',
							'Check **Irrigation demand by month**: what the catchment abstracts for its crops per month (the gross demand ÷ each hydrological unit’s [[irrigation-efficiency|irrigation efficiency]], so an efficiency below 100 % raises it), stacked by crop, with the year’s total under it. **Show table** gives m³/day per month, the mean, and Mm³ per year per hydrological unit and for the catchment. It comes before effective rain, which a run takes off day by day. It uses the monthly A-pan means: with a daily [[apan|A-pan]] series on the **Data** tab, runs use that on the days it has a value, so their demand differs, and a line under the heading says so.',
							'On **Model settings → Demand**, enter the 12 monthly [[apan|A-pan evaporation]] values (or, when an A-pan grid is loaded on the server, take them from **Calibration → Flow calibration → Evaporation from the map**, whose **Use** saves them at once), the [[effective-rainfall|effective-rain fraction]], the [[soil-water-store|soil-water store]] and the [[rain-threshold]].',
							'To bring in a list kept in a spreadsheet (a scheme’s register, a farm survey; hundreds of rows at once), press **Import plantings…** and load a CSV file or paste the rows: a heading row, then one row per farm and crop with its area in hectares (Farm, Crop, Area (ha), and optionally Irrigation system; **Download the template** under **Expected format** has the layout). Farms and crops are matched by name, whatever the capitals and spacing. A crop the project doesn’t have is added with crop factors of 0 and marked **needs crop factors** until you fill them in; a farm it doesn’t have is listed, and with **Add them as new hydrological units** ticked it becomes a new unit draining into the outlet, marked **Needs placing** on the Network until you set its area and where it drains. The preview counts what changes and lists every row it can’t read by its line; nothing changes until **Apply**, and then you save as after any edit.',
							'Give each crop its [[irrigation-system|irrigation system]] in its sheet (a unit can override it per crop in **Edit areas**); the systems and their efficiencies are under **Tables** › **Irrigation systems**. Each hydrological unit’s [[irrigation-efficiency|irrigation efficiency]] is its crops’ systems combined.',
							'Press **Save changes** on the save bar.'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'The full tables are under **Tables** in the section header (Crop factors, Planted areas): they open over the page, and **Done** brings you back (with a change not yet saved, it asks first: **Stay** or **Leave without saving**). The Crop factors grid also has **Load crop factors…**, to overwrite them from the reference library, a Water Balance Tool workbook or a node-based workbook ([[load-crop-factors]]). To change just one hydrological unit, click its name beside its bar, or select it on the **Network** and follow **Irrigated** on its card: its crops and hectares open beside the page, with its demand, and save with the rest of the model. With its parcels linked on the **Map**, that panel also shows **From land cover**: the area a land-cover map shows as cropland in them. Pick the area and the crop it is planted to (the land cover doesn’t say which), and **Use** saves it with its source. Under it, **Actual ET from satellite** says how the newest run’s crop water use compares with FAO WaPOR’s actual ET over the parcels, dekad by dekad; open it for each half water year, the dekads and a CSV. A difference points at the crops, areas, crop factors or A-pan to check; nothing changes by itself. It is off unless switched on for the site.'
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'With A-pan at 0 in every month the crops need no water, and every hydrological unit looks fully supplied. The Summary’s checklist warns about this.'
					}
				]
			}
		],
		terms: ['irrigation-demand', 'crop-requirement', 'irrigation-efficiency', 'crop-area', 'february-days'],
		related: ['build-the-network', 'curtailment-targets']
	},
	{
		id: 'add-data',
		title: 'Upload rainfall and flow data',
		summary: 'CSV format, updating a series with new days, and the checks to read before you trust a record.',
		kind: 'howto',
		tab: 'series',
		sections: [
			{
				heading: 'What the model needs',
				blocks: [
					{
						type: 'list',
						items: [
							'[[rain-catchment|Catchment rainfall]] (mm/day): required. It drives natural flow and effective rain.',
							'[[chirps|CHIRPS rainfall]] (mm/day): optional. It fills the days catchment rain is blank.',
							'[[rain-forecast|Forecast rainfall]] (mm/day): optional. It extends the record a few days ahead.',
							'[[observed-flow|Observed flow]] at the outlet (m³/s), from a gauge, a logger or both: needed to calibrate.'
						]
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Prepare a CSV with two columns, **date,value**, one row per day. A header row is optional. Leave a missing day blank rather than writing 0. Commas, semicolons or tabs, and decimal points or decimal commas, are worked out from the file. A daily table exported from the DWS hydrology site loads as it is: days its quality code marks as missing, and negative placeholders such as -999, become gaps.',
							'Press **Add data** in the section header, or drop the file on the page. Both are on **Summary**, **Crops & demand**, **Data**, **Model settings** and **Calibration**; another page says where to drop it.',
							'Check the series the form guessed from the file name and header, and the preview chart.',
							'For an existing series keep **Append / update**: new days are added and overlapping days corrected. The preview counts new, changed and unchanged days. Use **Replace** only to overwrite the whole series.',
							'Upload. If the file would change days already stored, the form asks first: it says how many days and between which dates, and **Show the changes** lists each one. Press **Overwrite** to go ahead, or **Back**. The values it replaces are kept: in the **History** tab, pick that change and press **Restore the earlier values**. **Cancel**, the close button or Esc asks before throwing away a file you have picked but not uploaded.',
							'Press **Re-run model** in the notice under the header when you are ready.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'A missing rain day written as 0 looks like a dry day, and it stops CHIRPS filling the gap. The **Data checks** panel flags long runs of zero rain in the wet season and years that read far below CHIRPS. By default a run treats a flagged run’s days as missing where CHIRPS reads more than 2 mm, so CHIRPS fills them, and keeps the 0 on drier days; **Model settings → Rain gaps** ([[zero-rain-runs|zero-rain runs]]) sets that threshold and keeps a confirmed dry spell dry.'
					}
				]
			},
			{
				heading: 'Checks to read on the Data tab',
				blocks: [
					{
						type: 'list',
						items: [
							'The table lists the series that are **behind** first: rainfall or evaporation a run reads whose data is more than a week old, the same ones the number beside **Data** counts, each marked **Behind**. Then the last date of each series, its coverage per year and % missing. With many series the first six show and **Show all** lists the rest. Click a row (or its **View**) to chart it: the chart, below the table, comes into view; the link can be shared, and Back returns to the series before.',
							'**Series details**, under the chart, holds the charted series’ **Name**, **Product** (a CHIRPS series’ product and version), **Measured at** (where a flow record was measured: the outlet, or a gauge inside the network, which makes that gauge a calibration location, **Calibration → Calibration record**), its **Source** and the **Upload unit** it was converted from. Editors change the name, product, where measured and source there, each saved as it changes; a new name that changes which series runs read (they read the first of each kind by name) asks first, and a series a data feed or an API key writes by its name keeps it (nor can a series take a name one of them writes to). A row placed at a gauge says *At gauge* and its name.',
							'**Data checks**: negative values, outliers, flat stretches, suspect zero rain and breaks in catchment rain’s ratio to CHIRPS, which the [[double-mass|double-mass]] chart shows by water year.',
							'The chart of the catchment rain a run reads shades the days a run treats as missing or spreads a [[rain-accumulations|multi-day accumulation]] over.',
							'With both a gauge and a logger, the [[gauge-logger-agreement|gauge vs logger]] table flags water years where they disagree. Choose the record you trust as the calibration flow series (**Calibration → Calibration record**).',
							'A [[reference-gauge]] on a neighbouring river is kept for ranking wet and dry years only. The model never reads it.',
							'**Preview all data** (in the header, beside **Add data**) or a row’s own **Preview** opens every series’ daily values side by side, searchable by date or value, plus how the model used each day: rain used and its source after gap-fill, the CHIRPS bias factor and corrected value, flow in m³/day, and any calibration exclusion. Its **View** picks the columns: All, one unit with land (its station raw and adjusted to the unit’s MAP, its CHIRPS raw and bias-corrected with the twelve monthly factors above the table, its rain used and where each day came from), the rainfall stations, the average catchment rainfall or the flow records.'
						]
					}
				]
			}
		],
		terms: ['units', 'rain-final', 'chirps-bias'],
		related: ['rain-gap-filling', 'how-calibration-works', 'load-data-feeds']
	},
	{
		id: 'load-data-feeds',
		title: 'Load rainfall and flow automatically with data feeds',
		summary: 'Attach a CHIRPS, CHIRPS-GEFS or DWS feed, set one up from the catchment boundary, and read whether each is keeping up.',
		kind: 'howto',
		tab: 'series',
		sections: [
			{
				heading: 'What a feed does',
				blocks: [
					{
						type: 'p',
						text: 'A [[data-feeds|data feed]] fetches one source once a day and merges its new days into one series: [[chirps|CHIRPS]] daily rainfall, the [[chirps-gefs|CHIRPS-GEFS]] 16-day forecast, or a [[dws-flow|DWS gauge’s]] verified daily flow. A day the source has no value for never erases what is there. Runs read the series as they read an uploaded one.'
					}
				]
			},
			{
				heading: 'Rain over the catchment boundary',
				blocks: [
					{
						type: 'steps',
						items: [
							'Put the catchment boundary on the **Map** (delineate, draw or upload it).',
							'Open **Data → Data feeds**, press **Attach a feed** (an editor: **Rain from the map**) and choose the **Area** *The catchment boundary, from the map* (the Map’s own link opens it too).',
							'Read the proposal: the CHIRPS cells the boundary covers, the share of each inside it and its weight. A boundary over about 2 500 km² needs feeds for its parts.',
							'An owner presses **Apply**. Where runs already read a CHIRPS record (**Runs read**), the owner chooses: **Keep** it, the default, and the feed goes into a new series named to sort after it, so runs keep reading the record, read from its first day (rnl when that is before 1998); or **Replace** it, and the feed reads the whole record again from its first day and takes its place once complete (the old values stay in the History). The daily product and start date can be changed before Apply.'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'See [[boundary-rain|rain from the catchment boundary]] for how the cells are weighted.'
					}
				]
			},
			{
				heading: 'Rain for each unit',
				blocks: [
					{
						type: 'steps',
						items: [
							'Give each hydrological unit its parcel on the **Map** (delineate, draw or upload it, and link it to the unit).',
							'Open **Data → Data feeds**, press **Attach a feed** and choose the **Area** *Each unit’s parcel*: one CHIRPS feed per unit, over the cells its parcel covers.',
							'An owner picks the daily product (*rnl* from 1981 by default) and presses **Create the feed** (**Create 4 feeds** for four units; **Update** where a unit has one already). Units without a parcel are listed, with a link to the map.',
							'Give each unit its MAP and source on its form, then, under **Model settings → Flow generation**, give each unit its rainfall station, and refit.'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'See [[unit-rain|runoff from each unit’s own rain]] for which rain each unit runs on.'
					}
				]
			},
			{
				heading: 'Attach a feed by hand',
				blocks: [
					{
						type: 'steps',
						items: [
							'Press **Attach a feed** (owners) and choose the **Source**, then **Into series**: the kind of series it writes. CHIRPS goes into the CHIRPS series, so it fills the days catchment rain is blank; into catchment rain it becomes the catchment rain itself, used raw.',
							'For CHIRPS, choose the **Daily product**: *sat* from 1998, with preliminary days, or *rnl* from 1981, final days only (see [[chirps-version|CHIRPS product and version]]). Without a start date the feed reads the last 60 days, then keeps up.',
							'For CHIRPS and the forecast, give the **Area**: grid cells (latitude, longitude, an optional weight, one a line) or a bounding box (south, west, north, east). A box on the coast can leave out sea cells. CHIRPS’s Area also offers the catchment boundary and each unit’s parcel, from the map (above).',
							'For DWS flow, pick from **Nearest gauging stations** (river gauges within 50 km of the outlet, with the years their record covers) or type the station code, such as A2H012.',
							'If the series already has data, the form asks: use a separate series, or fill only its empty days. Then press **Attach feed**, and **Run now** to fetch at once rather than wait for the daily run.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Verified DWS flow lags by months and is revised in arrears: it suits calibration, not day-to-day operation.'
					}
				]
			},
			{
				heading: 'Is it keeping up?',
				blocks: [
					{
						type: 'list',
						items: [
							'Each card says its state in words: **OK**, **Stale** (no new day for longer than the source usually takes), **Failing** (with the reason), **Waiting** or **Off**, and when its last data and last check were.',
							'A warning above the list counts the feeds that need attention, and the Projects page lists failing feeds under **Needs attention**.',
							'A **Sample data** badge means this server reads invented sample files, not the real sources ([[synthetic-data]]).',
							'The Data tab marks a rain series **Behind** once its last day is more than a week old ([[data-freshness]]).'
						]
					}
				]
			}
		],
		terms: ['data-feeds', 'boundary-rain', 'unit-rain-feeds', 'chirps-version', 'dws-flow', 'chirps-gefs'],
		related: ['add-data', 'start-from-the-map']
	},
	{
		id: 'start-from-the-map',
		title: 'Start a catchment from the map',
		summary: 'Delineate or draw the boundary, place the dams and gauges, and let the map propose the units, their areas and their order.',
		kind: 'howto',
		tab: 'map',
		sections: [
			{
				heading: 'Before you start',
				blocks: [
					{
						type: 'p',
						text: 'This works on a model with no hydrological units yet, and the units follow your own boundaries: have each unit’s boundary ready to draw or upload (or save sub-catchments from clicks). With an [[elevation-model|elevation model]] on the server, the units’ order comes from the terrain and each area is checked against it; without one, you set the order on the Network. Nothing reaches the model until you tick it.'
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'On the **Map**, press **Start from the map** (or the link on the empty map). Step one is the boundary.',
							'**Delineate from the outlet**: the terrain channels appear; click the one at the catchment’s outlet. The outlet goes on the nearest terrain channel ([[outlet-placement]]), and the catchment above it is proposed. Check it against the relief and the mapped rivers, then **Accept as the catchment boundary**. Or draw the boundary, or upload it from a file (GeoJSON, KML or a zipped shapefile).',
							'Put each unit’s boundary on the map (draw it, upload it, or save sub-catchments from clicks), and place the dams, the abstraction points and the gauges with **Place a point** or by drawing a dam’s outline.',
							'In the sheet, say what each feature is (a unit’s boundary, part of its unit’s composite dam, its unit’s river pump, another water user, a gauge in the network, or not in the model) and which gauge is the outlet, then propose. A dam or an abstraction point is never a unit of its own.',
							'Read the proposal. Each unit is tinted and numbered on the map, and its card gives its boundary’s area, what it drains into, and the dams and pumps inside it. Read the warnings: a boundary whose area is far off what the terrain drains to its outflow, boundaries that add up past the catchment, dropped features and their reasons.',
							'Tick the values to take (**Tick every value** takes them all), name the units, and apply. One model revision writes them, each unit’s area its boundary, and links each unit’s dams and pump to it.',
							'Follow the data step’s links in order: rain from the boundary, the nearest gauging stations, each unit’s composite dam (its volume and the area draining to it are yours to enter; the register of dams is a reference only), cultivated area from land cover, then run the model.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'The areas come from a 30 m global elevation model, not a survey. In flat land a divide can be hundreds of metres out; check each piece against the map before you tick it.'
					}
				]
			},
			{
				heading: 'A model that already has units',
				blocks: [
					{
						type: 'p',
						text: 'Use **Divide the model** instead ([[divide-model]]): say which unit each boundary stands for, and each unit’s area and order are proposed beside its values now. Or click the rivers with **Sub-catchments, one per click** ([[sub-catchments]]), save the pieces as areas, link each to its unit and **Use** its [[map-area|area]].'
					}
				]
			}
		],
		terms: ['start-from-map', 'delineation', 'terrain-channels', 'outlet-placement', 'dam-siting', 'area-basis'],
		related: ['map-page', 'build-the-network', 'load-data-feeds']
	},
	{
		id: 'add-a-transfer',
		title: 'Add a transfer',
		summary: 'Move water from one hydrological unit’s dam to another in chosen months, up to a pipe or canal capacity.',
		kind: 'howto',
		tab: 'transfers',
		sections: [
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'On **Transfers**, press **+ Add transfer** in the section header. Each rule is a card: along its top, pick its source (**From**) and destination (**To**) hydrological units.',
							'Under **Max rate by month**, enter its [[transfer-rate|maximum rate]] in m³/s for each [[transfer-months|month]] it runs in, Oct … Sep; leave a month blank to keep it off. **… in every month** copies the largest rate to all twelve.',
							'Under **Limits**, enter a daily cap in m³ if there is one.',
							'Under **Source**, keep **Takes from** on the source’s dam and set the [[transfer-min-storage|minimum storage]] it keeps, or pick the river for an [[transfer-offtake|off-take]] and fill in its fields.',
							'With several transfers, set each one’s [[transfer-priority|priority]] under **Limits**: lower moves first.',
							'The **On** switch at the top right of the card leaves a rule in the model but stops it running (the card turns grey and says **off**); **Remove** deletes it, asking first once it has a rate.',
							'Save, then run.'
						]
					}
				]
			},
			{
				heading: 'What moves each day',
				blocks: [
					{
						type: 'picture',
						shot: 'transfer',
						caption: 'A transfer pipeline on piers, crossing the river between two dams.',
						stops: [
							{ spot: 'pipe', title: 'The pipeline', text: 'Its capacity is the transfer’s [[transfer-rate|maximum rate]] in each [[transfer-months|month]]; a blank month is off.' }
						]
					},
					{
						type: 'formula',
						text: 'transfer = min( source’s water above its minimum, room at the destination, the month’s rate × 86 400, daily cap ),   0 in a month that is off'
					},
					{
						type: 'p',
						text: 'The source’s water is yesterday’s storage above the higher of the transfer’s minimum and the dam’s own [[dam-min|minimum level]], less what earlier transfers took. The room at the destination is the free space in its dam plus that day’s irrigation demand, so water is never pumped into a full dam only to spill. Transfers move before any hydrological unit irrigates.'
					},
					{
						type: 'p',
						text: 'Between two hydrological units, what leaves the source enters the destination: a dam transfer creates and loses no water, and a river [[transfer-offtake|off-take]] loses only its **Losses on the way**. A rule whose **To** is **Outside the catchment** ([[transfer-outside]]) is different: its water leaves the model, and counts as the source unit’s use. Transfers with the same priority share a source dam, or a destination’s room, in proportion to their own limits, so the order of the list never changes a result.'
					}
				]
			}
		],
		terms: ['transfer', 'transfer-priority', 'transfer-min-storage'],
		related: ['build-the-network', 'a-day-on-a-farm']
	},
	{
		id: 'set-the-ewr',
		title: 'Set the EWR and the reporting window',
		summary:
			'Enter the monthly pragmatic EWR, then choose the period the curtailment report averages over.',
		kind: 'howto',
		tab: 'settings',
		sections: [
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Take the monthly Reserve flows for the river’s [[ecological-category]], usually from the [[desktop-reserve-model]] tables without high flows.',
							'Pick one value per month (often a percentile) and convert it to m³/day.',
							'On **Model settings → EWR**, the first choice is **Daily EWR from**: keep *The pragmatic EWR* and enter the 12 values in the **Pragmatic EWR** row under it, Oct … Sep. The l/s equivalent and the annual volume help catch a unit slip.',
							'Or take the daily EWR straight from the Desktop Reserve Model: set **Daily EWR from** to *The DRM TAB file* or *The DRM percentile tables* ([[ewr-daily-source|the daily EWR at the outlet]]), load the DRM’s .tab or .rul file or paste the values (**Fill from:** beside **Daily EWR from**; a .tab’s flows are shown in m³/s before you use them, a paste’s values in a preview before **Apply**), and choose how the tables are scaled to the catchment, by MAR or by area, with the table’s MAR or area. Under the percentile tables a .rul fills three tables, and **The EWR is the Reserve table** picks which Reserve table is the EWR: the total Reserve flow (with high flows, the default) or the Reserve flow without high flows. Every run then says which EWR it was judged by and the scale factor.',
							'Optionally, on **Model settings → Reporting** (under *Demand & supply*, above the EWR), set the **Curtailment reporting window** ([[report-window|reporting window]]) to a drought or dry season. The curtailment table then averages over that period only.',
							'To assess the EWR above the outlet too, add a gauge on the **Network** tab at each EWR site of the Reserve determination (a gauge is an **EWR site** until unticked; untick one that only records flow).',
							'Save and run.',
							'With a Reserve rule table too (**Model settings → Reserve rule tables**, after the EWR), choose which one the results are judged by in **EWR the results are judged by**, the first panel on **Model settings**: automatic (the outlet’s rule table, else the first site’s, else the pragmatic EWR), the pragmatic EWR, or one site’s rule table. It changes no result, so no re-run is needed; EWR says at the top which one is in use.'
						]
					}
				]
			},
			{
				heading: 'Where the EWR is checked',
				blocks: [
					{
						type: 'picture',
						shot: 'river',
						caption: 'A reach of the river. The EWR is the flow that must stay in it, every day, for the ecosystem to hold its target condition.',
						stops: [
							{ spot: 'river', title: 'The river channel', text: 'Checked every day at the outlet against the [[pragmatic-ewr]], and at every gauge ticked as an **EWR site** against the EWR of everything upstream of it.' }
						]
					},
					{
						type: 'p',
						text: 'The EWR is assessed at EWR sites: the outflow gauge, against the full [[pragmatic-ewr]], and every gauge ticked as an **EWR site** (each gauge is, until unticked on its form), against the [[ewr-share|EWR shares]] of everything upstream of it. On a day a site falls short, the shortfall is charged to the hydrological units upstream of it in proportion to what each took that day, never more than it took; the rest is natural. That [[ewr-charge]] says which hydrological unit causes a shortfall. The results report [[ewr-days-not-met]], an EWR grid by month and, with an observed record, whether the model fails on the days the real river did ([[ewr-agreement]]).'
					}
				]
			}
		],
		terms: ['ewr', 'ewr-shortfall', 'ewr-charge', 'ewr-share'],
		related: ['curtailment-targets', 'run-and-read-results']
	},
	{
		id: 'calibrate-by-hand',
		title: 'Calibrate by hand',
		summary: 'Change a runoff parameter, run, and read the hydrograph and statistics until the fit is right.',
		kind: 'howto',
		tab: 'calibration',
		sections: [
			{
				heading: 'Before you start',
				blocks: [
					{
						type: 'list',
						items: [
							'On **Calibration → Calibration record**, choose the calibration flow series (gauge or logger) and the [[calibration-window]]: a period with a record you trust.',
							'Add [[calibration-exclusions]] for periods you can’t trust, each with its reason.',
							'Enter each record’s gauged range (its highest and lowest field gauging) under [[quality-flags|Quality flags]] (the line under the exclusions: **Change** opens it), so days read off the extrapolated rating curve are flagged.',
							'The [[runoff-model]] is GR4J: its parameters are under **Flow calibration**. (The workbook’s legacy model was removed in engine 1.0.0.)'
						]
					}
				]
			},
			{
				heading: 'The loop',
				blocks: [
					{
						type: 'steps',
						items: [
							'Change one parameter at a time. For GR4J start with X1 (soil store: less flow when larger), then X4 (timing of the peaks), then X3 (how slowly flow recedes).',
							'To see what the change does first, press **Preview** on the save bar: the last run against the same run with your unsaved change, worked out in your browser (KGE, NSE, PBIAS and supply). Nothing is saved and no run is made.',
							'Save and run.',
							'A run started on **Calibration** opens there, under **How the shown run fits**. Read the **Hydrograph** (observed flow against simulated outflow) and **Calibration against observed flow**: [[kge|KGE]], [[nse|NSE]], [[pbias|PBIAS]], [[log-nse]] and the annual water balance.',
							'Fix volume first (PBIAS near 0), then the shape of the peaks, then the recessions and low flows.',
							'Compare the run with the previous one to see what the change did.'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'Hand calibration is scored only on days the parameters were tuned on (in-sample). Before relying on the parameters, run **Fit automatically** with validation to see how they score on days they never saw.'
					}
				]
			}
		],
		terms: ['calibration', 'gr4j', 'runoff-model', 'base-flow'],
		related: ['fit-automatically', 'how-calibration-works', 'how-gr4j-works']
	},
	{
		id: 'fit-automatically',
		title: 'Fit the runoff model automatically',
		summary:
			'Let the optimiser search the parameters, read the validation scores, then apply and save the fit.',
		kind: 'howto',
		tab: 'calibration',
		sections: [
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'On **Calibration → Calibration record**, set the calibration flow series, window and exclusions first. The fit uses the form as it stands.',
							'Under **Calibration → Fit the parameters → Fit automatically**, choose the **Objective** by what the fit will feed (see *Choosing an objective* below), before you see any score.',
							'Keep **Validate** (split-sample and dry → wet) ticked. With both a gauge and a logger, you can also score the fit against the record it doesn’t use (**Also validate against**).',
							'The **Search** line above the button shows the bounds, model runs, starts and seed; **Change** opens them. Choose **Bounds** Typical (Perrin et al.’s published range) when a short record can’t pin the parameters down, and leave **Model runs per fit** (1 500) and **Starts** (5) at their defaults unless you have a reason. These search fields belong to the fit alone: they are never saved, the save bar doesn’t count them, and **Discard** leaves them as typed. Each start is a separate search from its own seed and the best is kept; the notes say when starts reach nearly the same score with scattered parameters.',
							'Press **Fit automatically**. A progress bar shows the stage and the best score so far; **Cancel** stops it. You can open other tabs while it runs: the fit carries on, and its result waits on this page.',
							'If you change the calibration record, window, exclusions or forcing before applying the result, a warning over it lists what changed: its scores were made on the settings before, so fit again rather than apply it.',
							'Read the result: the notes, current vs fitted parameters, and the scores table. The shaded validation columns are the honest measure.',
							'Press **Apply to form**, then **Save changes** on the save bar. Nothing is stored until you save.',
							'Run the model with the new parameters. A run started from Calibration opens there, under **How the shown run fits**, so you read the new fit on the same page.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Expect validation to score below the fit. When it is much lower, or the notes say wet-year behaviour is weakly constrained, the record can’t pin the parameters down. Report that; don’t hide it.'
					}
				]
			},
			{
				heading: 'Choosing an objective',
				blocks: [
					{
						type: 'p',
						text: 'Each [[calibration-objective|objective]] weighs the record differently, so choose it by what the fit will feed, and before you see any score:'
					},
					{
						type: 'list',
						items: [
							'**KGE′** (default): the overall water balance, peaks and events.',
							'**Year-balanced KGE′**: a record where a few wet years would otherwise dominate.',
							'**Mean of KGE′(Q) and KGE′(1/Q)**: EWR, low-flow and assurance-of-supply decisions, when the gauge’s low flows are well rated.',
							'**Non-parametric KGE**: the same decisions when the rating at the extremes is uncertain. It reads the rank order and the shape of the flow-duration curve, so it is less sensitive to rating error.',
							'**NSE on √Q or log Q**: mainly to compare with older studies that used them.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Don’t fit several objectives and keep the one whose score looks best. Scores of different objectives don’t compare, and choosing after seeing them is the overfitting the [[calibration-rules]] exist to stop. To try several, list them in the rules: every fit is then judged on one [[calibration-selection-score|selection score]] on a held-out test, chosen in advance.'
					},
					{
						type: 'p',
						text: 'Check a low-flow fit for volume too: the [[wr2012-fit-statistics]] and KGE′ are reported beside every fit.'
					}
				]
			},
			{
				heading: 'Afterwards',
				blocks: [
					{
						type: 'p',
						text: 'The saved parameters carry a [[fit-record]]: objective, seed, window, exclusions, engine version and every score. Each run keeps the record it was made with. Editing a fitted parameter by hand marks the record “parameters edited since fit”. The same inputs, engine version and seed reproduce the fit exactly.'
					}
				]
			}
		],
		terms: ['auto-calibration', 'calibration-objective', 'validation-tests', 'calibration-bounds', 'calibration-search', 'kge', 'wr2012-penalty'],
		related: ['how-calibration-works', 'calibrate-by-hand', 'check-against-wr2012']
	},
	{
		id: 'check-against-wr2012',
		title: 'Check natural flow against WR2012',
		summary:
			'Enter the quaternary’s published naturalised flow, and every run compares its natural flow with it.',
		kind: 'howto',
		tab: 'calibration',
		sections: [
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Find the [[quaternary]] the catchment lies in, and its WR2012 naturalised MAR and 12 monthly mean flows. The app doesn’t ship WR2012 data.',
							'On **Calibration → WR2012 check**, tick **Compare runs with WR2012 naturalised flow**.',
							'Enter the quaternary code, its area, MAP (optional), MAR in Mm³/a, the period and the source.',
							'Enter the monthly means in **Mm³ per month**. Their sum should match the MAR within 5 %; the m³/s row shows a unit slip.',
							'Under **How the check judges**, choose the scaling (area, or area and rainfall) and save. Every run from now on has a **WR2012 check** panel.'
						]
					}
				]
			},
			{
				heading: 'Reading the check',
				blocks: [
					{
						type: 'p',
						text: 'The run compares simulated **natural** flow (never the outflow) with the scaled reference: the MAR ratio, the 12 monthly ratios with dry-season months marked, and the correlation of the monthly pattern. A MAR off by 10 % is noted, by 25 % (or 15 % too wet) queried, and by 50 % makes the run unusable for EWR findings until explained. The thresholds are editable.'
					},
					{
						type: 'p',
						text: 'The optional [[wr2012-penalty|MAR penalty]], switched on in **Fit the parameters → Fit automatically**, makes the fit pull the natural MAR towards WR2012, and shows the fit with and without it.'
					}
				]
			}
		],
		terms: ['wr2012-check', 'map', 'wr90'],
		related: ['fit-automatically', 'how-calibration-works']
	},
	{
		id: 'run-and-read-results',
		title: 'Run the model and read the results',
		summary: 'What each results section shows, in order, and what to look at first.',
		kind: 'howto',
		tab: 'runs',
		sections: [
			{
				heading: 'Run',
				blocks: [
					{
						type: 'steps',
						items: [
							'With unsaved changes, **Run model** asks first and offers **Save and run**.',
							'On **Runs & results**, optionally type a **Run label** in the header, then press **Run model** beside it (the other sections, Calibration included, have none). It needs a network and a rainfall series; until then the page says what is missing.',
							'The runs are listed on the left, newest first, beside the run shown; pick one to show it (with a single run, the list is one row above it). Its header links to **EWR** and **Hydrological units** for that run. A run tagged **Can’t be re-run** was made before runs stored their inputs.',
							'While it runs, **Run model** reads **Running model…** with its progress, and it keeps going if you open another tab or project: come back and the progress carries on. If it fails while Runs & results isn’t open, the project page says so (**Dismiss** clears it, as does the next run).',
							'The new run opens when it finishes. A run keeps a snapshot of the inputs it used, so later edits never change it.'
						]
					}
				]
			},
			{
				heading: 'Read, top to bottom',
				blocks: [
					{
						type: 'list',
						items: [
							'**Summary**: first what to check before relying on the run, then (folded away) notes on how the input data were handled, and a line of model checks (arithmetic checks, calibration, plausibility, the WR2012 flag), each linking to its panel. Then a sentence or two in plain words (which hydrological units fell short, then how often the river’s requirement was met), and the headline figures, the calibration NSE and PBIAS among them when there is observed flow. The table per hydrological unit is on **Hydrological units** (see below).',
							'**Water balance by water year**: summed over the hydrological units (rain with the runoff coefficient under it, storage at the start and end, each gain and loss, in Mm³, and the residual with the runoff model’s under it, each of which should be 0), with a link to EWR’s water account, the catchment’s own. How the run fits observed flow (the hydrograph, flow duration, calibration, the runoff model, the WR2012 check, EWR vs observed and the plausibility checks) is on **Calibration**, for the same run: the Summary’s model checks link there.',
							'**Record**: the run’s notes, whether it is the project’s evidence run (see below), how to reproduce it, its validation statement and its publication.',
							'**The model’s working**: **Arithmetic checks** (the engine’s own checks on the run: whether each hydrological unit’s daily balance closes and the reports add up, the list behind **Show the N checks** when every check passed; whether the water balance closes in every water year, with a link to the table; and **Trace a day**; see [[balance-check|the arithmetic checks]]; a failed one is a bug in the model, not your data), **Accumulated flow at each unit** (each hydrological unit’s daily flow accumulated down the network, one line per unit and one for the catchment outlet, in m³/s or m³/day: 20 from the unit above and 25 of the unit’s own runoff is 45 at the unit. **Flow shown** picks **Natural, accumulated** (the unit’s own runoff plus every unit’s upstream, every branch: the flow with no dam or abstraction above it), **Modelled, arriving at the unit** (the flow from upstream plus its own runoff, after the dams and abstractions above it), **Modelled, leaving the unit** (its outflow, after its own) or **Incremental only** (its own runoff alone). Tick the units to draw, drag across the chart to zoom into a period, Shift+drag or **Earlier** / **Later** to move it; **Show the numbers** gives each line’s mean, lowest and highest over the days in view and, for the natural flow, the unit’s own share of it) and **Chart any daily series**: any stored daily series of the catchment, a hydrological unit or a gauge. Water a river off-take delivers isn’t in **Dam transfers** (that series nets only the transfers from a unit’s dam): chart the receiving unit’s **Delivered by river off-takes into this unit** for it, and the source unit’s **Taken from the river for …** for what each off-take took.'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'The row of links under the header, **On this page**, jumps to each of these sections and marks the one you are reading; it stays in view as you scroll. In a narrower window the last few are under **More** at its end. On a wide screen it is a column down the right of the results instead, each link named as its panel’s heading, with the main panels of **EWR** and **Hydrological units** listed under their pages at its foot. **EWR**, **Hydrological units**, **Data**, **Model settings**, **Calibration** and **Compare runs** have the same menu, a column down the left of the page on a wide screen, and a hydrological unit’s form on the Network has it as a row of links over the form.'
					},
					{
						type: 'p',
						text: '**EWR**, under *Outcomes* in the sections, is the page for the EWR’s results, one run at a time (the newest, or pick another from its **Run** menu; the link under the Summary’s supply list opens it too). A line at the top says which EWR the results are judged by, with **Change** to choose another in Model settings → **EWR the results are judged by**. Two tiles: the headline, **EWR not met** (the share of days at the outflow gauge, the days, and how many in an average year) or, when a Reserve rule table judges the results, **Reserve rules met** (the share of whole months, at which site, with the pragmatic EWR’s days under it); and the mean simulated outflow and its share of natural flow, each with its change from the run before (the worst month is the EWR by month grid’s **All years** row). Beside them (under them on a narrow screen), **Days below the reserve** in each of the run’s last twelve months (with a Reserve rule table judging, it is headed **Days below the pragmatic EWR**, the daily test it counts). Then EWR against outflow with a **30 days / 1 year / All** switch and the days below the pragmatic EWR shaded, beside the days below the reserve each water year. When a Reserve rule table judges the results (by whole months), those bars are headed **Days below the pragmatic EWR, each water year**, the daily test they count, and the chart is headed **Flow vs pragmatic EWR** (or **Flow vs daily EWR** when the daily EWR comes from the DRM tables) when the table is at another site than the outlet, since it then draws only that EWR (with the outlet’s table it draws the rule requirement too). Below them, the findings: **Reserve rules met, by month** (without a rule table, one line saying it needs one, with a link to Model settings → Reserve rule tables), **Days below the EWR, by month** with the EWR required and met at each site each water year, and the water account (the catchment’s, from natural flow, in m³, with a link to the run’s water balance on Runs & results). Then, under **How sure, and what if**, the tools you run yourself: the uncertainty bands on those findings (with the sensitivity runs), the outcome matrix and the seasonal outlook, each one row with **Run…** until it has run. On the EWR by month heat map (as % of days) and the reserve strip at the top, **green** means the EWR was not met on fewer than 5 % of the days, **amber** fewer than 20 %, and **red** 20 % or more; these are provisional defaults until the hydrologist confirms them (a team can set its own for its portfolio).'
					},
					{
						type: 'p',
						text: '**Hydrological units**, also under *Outcomes*, is the hydrological units’ page for one run (the newest, or pick another from the run menu in its header; the Summary’s **Supply by hydrological unit** links there). Three tiles: irrigation supplied, with the hydrological units below 95 % and its change from the run before under it; the hydrological units short on any of the run’s last 7 days (**Short this week**, which opens the curtailment over those days) and the total shortfall. Then a card per hydrological unit, the three least supplied first (**Show all** lists the rest in place), in the Summary’s and the Network’s colours: its % supplied, its shortfall, its days short in the reporting window and in the last 7 days, and any cut the curtailment asks of it, with links to its hydrological unit on the Network and its planted areas. Pick a card, or a unit from the menu at the top of the chart (**‹** and **›** step through them, least supplied first), to chart that hydrological unit’s supply against its demand (the days it was short shaded), over **30 days / 1 year / All**, with a link to its dam’s storage on the **Dams** page; the link can be shared, and on a wide screen the chart stays beside the cards as you scroll. Under the chart is that unit’s assurance of supply: how often and how fully its demand was met, and a strip of its stress by month, with a link to every year’s grid. Below them: the **Hydrological unit results** table (hydrological units under 95 % flagged, with a small bar beside each %), the **Curtailment** targets with their **Reporting window** (each hydrological unit’s supply against a fairness benchmark, its EWR charge and the supply cut that meets it, and the EWR sites; see [[guide:curtailment-targets|Curtailment targets]]) and **Assurance of supply**.'
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'The **Download** menu on a run gives the daily series and the summary as CSV, for your own checks or a report. The two tables with a column per hydrological unit, **Fragmented flow** and **Fragmented EWR**, have a **Preview** beside them that shows the file’s table first, searchable by date, with **Download CSV** to save it. **Report**, beside it, opens a printable catchment report of the run: the network, the inputs it used, calibration, curtailment, EWR compliance for the outlet and every hydrological unit, the hydrological unit table, warnings, self-checks and the run’s notes. Press **Download PDF** once it has finished preparing and choose **Save as PDF** in the print dialog; it prints on A4 in the light theme, without the app’s sidebar or menu bar. **Generate PDF** and **Email me the PDF** make the same PDF on the server instead; the emailed link opens a page that names the catchment and run, says whether the PDF is queued, being made, ready or failed, and offers **Download the PDF** for an hour. Viewers can open it too.'
					}
				]
			},
			{
				heading: 'Notes and the evidence run',
				blocks: [
					{
						type: 'p',
						text: 'Under **Run notes**, write why the run’s results stand, for example why a WR2012 query stands, and press **Save notes**. Everyone who can see the project reads them, in run comparison and in the summary CSV too. The **Notes** button at the right of that heading is something else: the team’s discussion of the run, where anyone on the project can add a comment.'
					},
					{
						type: 'p',
						text: 'Under **Evidence**, give the reason and press **Nominate as evidence** to mark the run the project’s results rely on ([[evidence-run]]). A nomination can’t be edited or removed; nominating another run replaces it, and both stay in the **Nomination history**. A run of the legacy runoff model, made before engine 1.0.0 removed it (badged **Workbook comparison**), a scenario run and a forecast run can’t be nominated: their **Evidence** panel says why and links to the evidence run.'
					},
					{
						type: 'p',
						text: 'A run made by an engine with a known bug (or with parameters from a calibration that had one) is tagged **May be affected** in the run list, and its header shows **May be affected by a known bug**. Each bug changes results only under its own conditions: press the badge to open the run’s **Validation statement**, whose errata table says when, then re-run on the current engine and compare. When new bugs are confirmed that touch a project’s runs, each of its owners gets one email for that catchment listing them all, each with when it changes results, how many runs it may affect and what to do; a run that meets none of a bug’s conditions is unaffected.'
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'A project keeps its newest runs (20 by default) and deletes the oldest when a new run goes over that. Evidence runs, current or former, are never deleted, and a project that has nominated one can’t be deleted either.'
					}
				]
			}
		],
		terms: ['run', 'fraction-supplied', 'ewr-days-not-met', 'natural-flow'],
		related: ['compare-runs', 'how-the-model-works']
	}
];
