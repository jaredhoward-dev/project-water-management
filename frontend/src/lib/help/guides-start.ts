// The "Start here" guides on /help.
// Joined into GUIDES by ./guides.ts, in this order, in a module (and a chunk,
// vite.config.ts helpArticlesChunk) of its own, so no one chunk of help text nears the
// bundle guard's per-chunk ceiling (2026-11-25). Same markup as every guide
// (./guides.ts `inline`); type-only import, so no cycle at run time.

import type { Guide } from './guides';

export const START_GUIDES: Guide[] = [
	{
		id: 'the-whole-process',
		title: 'The whole process, from catchment to results',
		summary:
			'The order to set a catchment up in, what each step needs, and how calibration and what-if runs fit in.',
		kind: 'start',
		tab: 'overview',
		sections: [
			{
				heading: 'What the app answers',
				blocks: [
					{
						type: 'p',
						text: 'A project models one river catchment day by day. Rain becomes natural flow, the flow is shared between the hydrological units, each hydrological unit fills its dam and irrigates, and whatever is left reaches the outlet. Every run answers three questions: how much water is there, can each hydrological unit’s irrigation be met, and does enough stay in the river for the [[ewr]]?'
					},
					{
						type: 'diagram',
						id: 'workflow',
						caption:
							'The setup order follows the workspace’s **Build the model** section, top to bottom; the results are under **Outcomes**. Calibrate and run again until the fit is good enough, then use runs and copies of the project for what-ifs.'
					}
				]
			},
			{
				heading: 'The steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'**Create the project** on the Projects page. See [[guide:create-a-project|Create a project]].',
							'**Network**: add the hydrological units and gauges, say what each drains into, and end at one outflow gauge. Give the hydrological units their areas. See [[guide:build-the-network|Build the river network]].',
							'**Crops & demand** (optional): crops with monthly crop factors, then the hectares each hydrological unit plants. Skip it if nothing is irrigated. See [[guide:set-up-crops-and-demand|Set up crops and demand]].',
							'**Transfers** (optional): pipelines or canals from one hydrological unit’s dam to another. See [[guide:add-a-transfer|Add a transfer]].',
							'**Data**: upload daily rainfall (required) and observed flow at the outlet (needed to calibrate). See [[guide:add-data|Upload rainfall and flow data]].',
							'**Model settings**: A-pan evaporation, how rain gaps are filled, how natural flow is made, the EWR and the simulation period. See [[guide:set-the-ewr|Set the EWR]].',
							'**Calibration**: the runoff model’s parameters, the calibration record and window, and fitting them to the observed flow. See [[guide:fit-automatically|Fit the runoff model automatically]].',
							'**Run** the model on the Runs & results tab, then read the results. See [[guide:run-and-read-results|Run the model and read the results]].',
							'**Iterate**: improve the calibration, run again, and compare runs on **Compare runs**. Copy the project to try a what-if without touching the original. See [[guide:compare-runs|Compare runs and try what-ifs]].'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'The **Summary** tab has a setup checklist that follows these steps. Each line says what is there or what to do next, and links to the tab. It also tells you when the project has changed since the last run. Once there is a run, the Summary opens on the results instead: four cards for the newest run, irrigation first: **Irrigation supplied** (the share of demand, and how many hydrological units fell below 95 %), the **Shortfall** (the demand not supplied over the run, in Mm³, and in an average year), **Units curtailed** (the days a drought restriction cut demand; without any, the **Worst-supplied unit** and its share) and how full the dams are, each with its change from the run before (the worst-supplied unit has none). The EWR’s results are on the **EWR** page (a link under the supply list goes there), and the calibration fit on **Calibration**. Then **Needs attention** cards (run warnings, new or old data and hydrological units with nothing planted, each a link to where it is fixed), with the **Active alerts** under them; and **Supply by hydrological unit**, the eight least supplied first (**Show all** lists the rest), where a hydrological unit’s name opens its planted areas and **More on Hydrological units** opens that page. The **Dams today** card opens the **Dams** tab. Once the run’s last day is more than a week old, the card says so by its date (**Dams on 31 Dec 2024**), and “this week” and “last 30 days” elsewhere give way to the date the figures end on in the same way. The published baseline and a link to **Project** sit under the supply list. Once every setup step is done, the checklist leaves the page: a **Setup complete** button at the top, beside the rain date, opens the steps over the page.'
					}
				]
			},
			{
				heading: 'Getting around a project',
				blocks: [
					{
						type: 'p',
						text: 'A project’s tabs are grouped in three sections. **Review** holds the Project page, Applications, the History of changes and the **Restriction log** (every restriction published to farmers; it opens from the Publication panel in Runs & results and shows here while open). **Build the model** is what the model is made of, in setup order: Network, the **Map** (the geography: boundary, parcels, dams, gauges and rivers; the Network’s header links to it too), Crops & demand, Transfers, Data, **Warnings** (every warning and problem in the project with its fix, its count of open items beside it), Model settings and Calibration (fitting the runoff parameters and judging the fit, together). **Outcomes** is what the model says: the Summary (where a project opens), EWR, **Outputs** (the planning outputs for one run, on one page), Hydrological units, Runs & results (**Compare runs** opens from there, and from Scenarios, and shows under it while open), Dams, Scenarios and Allocations.'
					},
					{
						type: 'p',
						text: '**Project**, under *Review*, is what the project is and who can open it, in one column: **Project details** (name, description, time zone and WUA name, saved with **Save changes** at the foot of the page, as model edits are) and the **Import record** of an imported project; then the **Team**, **Members**, **Farmers** and, for owners, **Share links**; then **Recent notes** and the model’s headline facts (hydrological units, catchment area, dam capacity, irrigated area, transfers, time series, runs and the outflow gauge, each a link to where it is edited) and **Scheduled reports**. Owners also find **API keys** under **Share links**, and the page holds the licensing panels. **Download** in its header takes a copy of the project. The Summary links there under **Model facts, details, team and sharing**.'
					},
					{
						type: 'p',
						text: '**Dams** has a card for each hydrological unit’s dam: how full it was at the end of the latest run, its change over the last 30 days and its last year as a small line (% full, with its first and last day and its lowest level marked; point at it to read a day). The emptiest dams come first, every card shown. Pick a card to chart that dam’s storage (as % full or m³, over 30 days, a year or the whole run); the link can be shared. Under the chart is the assurance of supply of the hydrological unit the dam serves (a dam has none of its own): how often and how fully its demand was met, and its stress by month, with a link to the unit on Hydrological units. Under that, **Proposed from the register and the map** is one line of what the register of dams (for reference only) and the dam’s polygon on the map propose for that dam; open it, or follow a card’s **Proposals**, for the values and their sources. Its **Dam of** picks another dam (the chart follows) or a hydrological unit with no dam yet. Between the chart and the assurance of supply, **Seen from space** is one line of how the run’s dam surface area compares with what Digital Earth Africa’s satellites saw of the dam’s outline on the map: how many clear views (at least 90% of the dam seen) were compared and how many disagree. Open it for the chart of the run’s area beside the views, the days seen full (likely spilling), seen empty, or where the model and the satellite disagree, and every view in a table. A dam needs its outline drawn on the Map to be seen; an outline that DE Africa Waterbodies merged with a neighbouring water body is compared on views of its own outline only (WOfS and Sentinel). When more than one satellite saw the dam clearly on a day, the most trusted view is compared: Sentinel-2, then WOfS, then Waterbodies, then Sentinel-1 radar. Radar sees through cloud but is never called full or empty on its own; its views are rings on the chart, with a double-line strip under their days. Wind can make radar read a dam lower than it is, so when radar views are among those compared the summary also gives the average difference without them. A card’s figures are the latest run’s; its capacity is the model’s now, and a dam whose own settings (or how its hydrological unit draws on it) were edited since the run says **Dam settings changed since the run** and what changed, until the model is run again (the Network’s map marks it the same way); edits upstream of it aren’t checked, so re-run after those too. A dam with a minimum operating level also shows how many days of its last year it sat at that minimum. Each card also opens the dam’s hydrological unit on the Network (**On the Network**) and the hydrological unit’s **Planted areas**. Before the first run the cards show each dam’s capacity only.'
					},
					{
						type: 'p',
						text: 'On a wide screen the sections are in the sidebar down the left, under the catchment’s name and your role (owner, editor or viewer); **Projects**, **Teams** and **Help** are at the top of it, and your account at the foot. A number beside **Data** counts the rainfall and evaporation series that are more than a week behind. On a phone, the **Menu** button in the bar at the top opens Projects, Teams and Help, and the catchment’s name and your role take the bar’s title, and the project’s sections sit behind a **Sections** button under it that names the tab you are on. The arrow keys move from one tab to the next.'
					},
					{
						type: 'p',
						text: 'Each section opens with one header: its name, a line saying what it shows (the run on the Summary and on EWR, the hydrological units and dams on the Network, where the runoff parameters came from on Calibration, how many series are behind on Data), and its actions on the right. **Rain up to** says how current the rainfall is (click it for every series). Editors also get **Add data**, which uploads a file, on the pages that ask for data (**Summary**, **Crops & demand**, **Data**, **Model settings** and **Calibration**); the other pages’ headers end on their own actions. **Run model** is on **Runs & results** only, where the header holds the run form (an optional **Run label**, **Run forecast** when there is forecast rain, and **Run model**). When new data has arrived since the last run, a notice line under the header of any page says so, with **Re-run model**. On a phone the page’s own actions are in one **⋯** list (**More actions**) beside **Rain up to**, **How this page works** is the **?** beside the name, and **Add data** (where the page has it) or, on Runs & results, the run form ends the header.'
					},
					{
						type: 'p',
						text: 'Each page adds its own actions to the header. The Network has **Map** (the geographic map: boundary, parcels, dams and gauges), **Tables**, **+ Add hydrological unit** and, once there is an outlet, **+ Add other user**; the Map **Upload map file**, **Start from the map** while the model is empty (the boundary, then the dams, abstraction points and gauges, and the units, their areas and their order are proposed, each value ticked to take it), **Divide the model** once it has hydrological units (with an elevation model: each point on the map stands for its hydrological unit, and its own area and order are proposed beside its values now, each ticked to take it; each proposed piece carries its number on the map and on its card), and a **Getting started** pill while the boundary or the rain feed reading it is still to do. The Map’s tools sit on the map’s left edge: **Measure**, **Draw**, **Point** (place a point), **Delineate** (when the server has an elevation model: the elevation model’s own channels are drawn as solid **terrain channels**, named in the bar and the Key beside the river network’s dashed lines, which are for reference only; click a terrain channel and the catchment above it, following the terrain, is proposed over the dimmed channels, to accept or reject, or pick **Sub-catchments, one per click** and each click gets the land that drains to it before any other click, to save as areas; each point goes on the nearest terrain channel, and one beside a much larger channel is offered that channel first, since a click can land on a hillside stream beside the river meant) and **Trace** (a dam, when the server has water occurrence data: click inside a dam and its outline is proposed as a drawing to adjust and save); a strip over the map names the tool that’s on, and Escape leaves it. **Layers** turns on the optional layers (quaternary catchments, the river network from HydroRIVERS, the DEM rivers, the hydrological units, the MAP, CHIRPS and DEM grids, and the relief) and sets the **Area fill**, and the search box over the map’s top edge finds a gauge, a registered dam, a quaternary or a place ([[map-search]]); **Key** says what the colours mean and what the areas are coloured by. Beside the map, one panel at a time: **Details** of the picked feature, **Features** (with **Download GeoJSON** and **Every feature**, the table), **Checks**, **Layers** and **Key**; the map’s own **Layers** button (under the zoom buttons) and **Key** button (bottom left, beside **Show everything**) open those tabs, or on a phone a panel over the map. While drawing, **Snap to features** puts a corner on a neighbour’s corner or edge (hold Alt to place one exactly), and a polygon’s card has **Split along a line**; Crops & demand **Tables**, **Load crop factors…**, **Import plantings…** and **+ Add crop**; Transfers **Show on the Network** and **+ Add transfer**; Data **Preview all data**; Calibration **Fit the parameters**, which jumps to that panel. EWR, Outputs and Hydrological units have a menu to pick the run and a link to it in Runs & results, and Dams the same link; Scenarios has **+ New scenario**; Allocations **Download CSV**, **Import** and **+ Add volume**; Project **Download**; Applications **Decide the longest waiting**. Notices sit in one line under the header: that you can only view the project, what an upload added, or that new data has arrived since the last run, with **Re-run model** for editors.'
					},
					{
						type: 'p',
						text: '**Model settings** is one long form. On a wide screen a column down its left lists every panel under its task (**EWR the results are judged by** first, then **Data & rain**, **Demand & supply**, **Runoff**, **EWR & Reserve**, **Reading results**, **Automatic runs**), marks the one you are reading and stays in view as you scroll; in a narrower window it is the row of links over the page. **Find a setting** (at the top of the column, or **Find** at the start of the row) lists the panels and the settings whose names match what you type: pick one to go straight to it, or press Enter for the first. A setting that lives on another page now is listed with that page’s name and goes there: **Data feeds** is on **Data**, and **API keys** and **Scheduled reports** are on **Project**. The panels that set up a fit (**Flow calibration**, **Calibration record**, **Fit the parameters**, **WR2012 check**) are on **Calibration**, with the same save bar: edits on both pages save together. Each panel says what it is set to now under its heading. The explanation under each field is hidden until you tick **Explain each setting under its field**, at the top of the form (your browser remembers it); every field keeps its ⓘ. A panel with something to fix before saving has a red dot in the menu, and the save bar links to it.'
					},
					{
						type: 'p',
						text: 'Nothing you edit takes you off the page. **Tables** opens a full table over the page: the Network’s has the **Hydrological unit table**, **Crop factors**, **Planted areas**, **Transfers** and **Demands**, Crops & demand’s the crop factors and planted areas. **+ Add hydrological unit**, or **Edit** on its row under **All hydrological units** (or a double-click on it in the drawing), opens its form in a sheet over the page, its sections folded to a line of their values: the menu over the form, or a section’s heading, opens one, **Show every field** opens them all, and **Explain each setting under its field** shows the help under each field; **+ Add crop**, or **Edit** on a crop’s row, opens the crop’s. Each grid and sheet has its own **Save changes**, **Discard model changes** and **Done**, which brings you back where you were. With a change there not yet saved, **Done**, **Close**, Esc or the ✕ asks first: **Stay** keeps the sheet open with your change, **Leave without saving** closes it and drops it. Esc in a dialog opened over a grid, such as **Paste from a spreadsheet…**, closes only that dialog. Removing a hydrological unit from its own sheet asks the same after the remove question (**Stay** removes nothing), and the focus moves to the row now in its place. The **Hydrological unit table**, **Crop factors**, **Planted areas**, **Transfers**’ monthly rates and the **Irrigation systems** also take a block copied from a spreadsheet, or a CSV file: paste it into any cell, or use **Paste from a spreadsheet…** above the grid. With the names in the first column and a heading row (as **Download the table as CSV** gives them), rows and columns can come in any order; a bare block of numbers fills from the cell you pasted into. In **Crop factors** a crop name the project doesn’t have adds that crop, so a list of crop types comes in at once; in **Irrigation systems** a new name adds a system. A preview lists every value it would change before **Apply**, and nothing is kept until you save. The monthly A-pan (**Model settings → Demand**) and the pan coefficients (**Calibration → Flow calibration**) take a paste the same way. Each of these says its layout under **Expected format** in the paste dialog: the headings, the units, how decimals are read, and an example file to download and fill in. **Help → File formats** gathers every upload and paste box’s Expected format in one page, each with its example file.'
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'To change one hydrological unit’s planted areas without leaving the page you are on, open its **Planted areas**: select the hydrological unit on the Network and follow **Irrigated** on its card beside the map, pick the hydrological unit’s name in the Summary’s **Supply by hydrological unit**, its name beside its bar on Crops & demand, or **Planted areas** on its card on Hydrological units or Dams. It opens beside the page and saves with the rest of the model.'
					},
					{
						type: 'p',
						text: 'Notes keep what lives in people’s heads (“dam raised in 2019 per owner”) against what it is about. The speech-bubble button, with a count once there are notes, is on each hydrological unit on the Network (its card beside the map and its row in the Hydrological unit table), on a run’s record in Runs & results, beside each panel’s heading on Model settings and Calibration and on **Recent notes** on the Project page. It opens the notes in a panel down the right: write a new one at the top, and the notes, newest first, scroll under it. Everyone on the project can add one; you edit your own. On a hydrological unit, **Also show to this hydrological unit’s farmers** lets its farmers read it too; every other note stays with the project team.'
					}
				]
			},
			{
				heading: 'What “good enough” means',
				blocks: [
					{
						type: 'p',
						text: 'A run is only as trustworthy as its calibration. Judge the parameters by the **validation** scores (days the fit never saw), not by the in-sample fit, and check the simulated natural flow against [[wr2012-check|WR2012]] where you can. The guides under “How it works” explain why.'
					}
				]
			}
		],
		terms: ['water-balance', 'project', 'run'],
		related: ['how-the-model-works', 'how-calibration-works']
	}
];
