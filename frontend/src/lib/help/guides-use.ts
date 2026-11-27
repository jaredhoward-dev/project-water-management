// The "Using the results" guides on /help, with one "How to" (pushing logger
// data) kept where it has always sat in the contents order.
// Joined into GUIDES by ./guides.ts, in this order, in a module (and a chunk,
// vite.config.ts helpArticlesChunk) of its own, so no one chunk of help text nears the
// bundle guard's per-chunk ceiling (2026-11-25). Same markup as every guide
// (./guides.ts `inline`); type-only import, so no cycle at run time.

import type { Guide } from './guides';

export const USE_GUIDES: Guide[] = [
	{
		id: 'compare-runs',
		title: 'Compare runs and try what-ifs',
		summary: 'Set up to two what-ifs against a baseline: which inputs changed, what that did to the results, and every figure in full.',
		kind: 'use',
		tab: 'compare',
		sections: [
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Run a baseline.',
							'Change one thing (raise a dam, add crops, add a transfer, refit the parameters) in the same project or in a copy, and run again. That run is a what-if. A scenario’s run, made and run on **Scenarios**, is a what-if too.',
							'Open **Compare runs** from the link at the top of the runs list on Runs & results (or **Compare with published**, or a scenario’s comparison); while it is open the sidebar shows it under Runs & results. It starts on the latest run (**What-if 1**) against the published run (**Baseline**), or against the run before it when nothing is published. Each run card has its own project and run picker, so any run from any project you can see can take any place.',
							'To weigh two changes against each other, press **+ Add a second what-if**. It picks the newest run that isn’t already on the page; **Remove** takes it off again.',
							'Read the cards (each what-if’s main change), then **What the change does**: each outcome for the baseline and every what-if, with the change from the baseline under each what-if’s value (dam storage at the end of the run too, as a share of each run’s own dam capacity), and the takeaways in plain words under it. **Days below the reserve, each year** shows the same test year by year (October to September); when a compared run has a rule table it is headed by the daily EWR the bars count (**Days below the pragmatic EWR, each year**, or the DRM table the daily EWR comes from), since the rule table judges whole months instead. Each run’s bars count its own daily EWR: when the runs’ sources differ, the chart says **each run’s daily EWR** and names each run’s beside it.',
							'Below that, **Full comparison** has every detail for the baseline against one what-if (pick which): **Inputs that differ** (every input difference), **Headline results**, fit and validation, uncertainty, the reserve by month, hydrological units and the daily series. There the baseline is run A and the what-if run B.',
							'To hand the result round, press **Export impact report** (with two what-ifs, pick which). It opens that what-if’s printable report with **Impact against the baseline** first: the same outcomes, takeaways and input changes. **Download PDF** saves it.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Results are daily averages over each run’s own period. When runs cover different periods the page warns you, and so do the takeaways: part of the change then comes from the dates, not from your edit. A takeaway appears only for a material change (a day a year below the reserve, a point of the demand supplied, a hydrological unit crossing 95 %); the table shows everything.'
					},
					{
						type: 'p',
						text: 'Each run shows its run notes in the full comparison, and the page says when either run is, or was, the project’s evidence run. The page’s address holds every run on it, so a comparison can be bookmarked or shared with anyone who can see the projects. **Back to runs** returns to Runs & results on the run you were looking at: the what-if when it belongs to the baseline’s project, else the baseline.'
					}
				]
			}
		],
		terms: ['run', 'project'],
		related: ['create-a-project', 'run-and-read-results']
	},
	{
		id: 'try-a-what-if',
		title: 'Model a what-if with a scenario',
		summary: 'Describe a change as a scenario on a saved run, keep the proposal apart from the assumptions, run it and read what it does.',
		kind: 'use',
		tab: 'scenarios',
		sections: [
			{
				heading: 'Before you start',
				blocks: [
					{
						type: 'p',
						text: 'A [[scenario]] is a list of [[scenario-change|changes]] on a [[base-run]]: the inputs that run stored, never the live model. Start from the run the change should be judged against, usually the [[published-baseline|published run]]. Each change is labelled a **Proposal** or a **Baseline assumption** ([[change-class]]): to see a proposal’s effect alone, settle the baseline assumptions (a corrected setting, new rain data) in the project first and run it again, then start the scenario on that run.'
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'On **Scenarios**, press **+ New scenario**, name it after the change (“Upper dam +20 %”) and pick its **Base run**.',
							'Open **Proposer** under **Application details** and tick **The proposer’s hydrological units**: the units whose owner is proposing the change. Changes to them, and anything the scenario adds, are the proposal.',
							'Add each change under **Add a change**: pick the kind, the target and the new value. It reads in words against the value it replaces. For many edits at once, **Edit in the model tables** and **Record** them ([[override-mode]]).',
							'Check the list: a red **Baseline assumptions changed** callout means some change alters what the river is taken to be today; a change marked **Doesn’t apply** must be fixed or removed before the scenario can run.',
							'Press **Run scenario**. **Scenario against its base** shows the headline results, each hydrological unit, [[assurance-of-supply]] and the daily series against the base run, every change as scenario − base.',
							'For a dam, read **Yield under this scenario** ([[firm-yield]]). For how sure the change is, open the full comparison and compute the [[paired-band|paired band]] ([[guide:read-the-uncertainty]]).'
						]
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'To test a demand restriction, use [[scale-demand|Scale demand]] (one change for the whole catchment, or for chosen units and months) rather than editing crop areas: it scales what each unit would take and leaves the crops as they are. Its **From** and **To** dates (both included) limit it to a stretch of the record, so a dry-year stress is one change per drought year, with the other years as the base. To test a wetter or drier climate, [[scale-series|scale every rain series]] the project has, one change each.'
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'A change applies to the base run’s stored inputs. When the model or the data move on, **Rebase…** on the “Based on” line of **Application details** carries the changes to a newer run and lists any that no longer apply.'
					}
				]
			}
		],
		terms: ['scenario', 'base-run', 'scenario-change', 'change-class', 'scale-demand', 'run-comparison'],
		related: ['scenarios-page', 'compare-runs', 'read-the-uncertainty']
	},
	{
		id: 'read-the-uncertainty',
		title: 'Read how sure a result is',
		summary: 'Uncertainty bands, sensitivity runs and the paired band: what each answers about EWR compliance, and how to run and read it.',
		kind: 'use',
		tab: 'river',
		sections: [
			{
				heading: 'Three questions, three tools',
				blocks: [
					{
						type: 'list',
						items: [
							'**How far could this result be off, given what the flow record can’t rule out?** The [[uncertainty-bands]]: many parameter sets that all fit the record acceptably, run through the whole model, with the 5–95 % range of what they give.',
							'**Which uncertain input moves it most?** The [[sensitivity-runs]]: rain, the pan coefficient, dam evaporation, abstraction and the dams’ starting storage, each changed alone, with a verdict on whether EWR compliance holds across the range.',
							'**How sure is the change between two runs?** The [[paired-band|paired band]]: the change under each kept parameter set, so the uncertainty both runs share cancels.'
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
							'On **EWR**, open **Uncertainty** from the page’s menu.',
							'On EWR, press **Run…** beside **Uncertainty bands** to open the form. Under **Run an ensemble**, set the rule before looking at any band ([[ensemble-acceptance]]): the number of parameter sets, the bounds and the three tests a set must pass. For an evidence report, use the rule the project declared ([[evidence-uncertainty-rule]]). Press **Run ensemble** and keep the tab open while the browser runs the sets.',
							'Read **Parameter sets kept** and the coverage line first. With fewer than 30 kept there is no band; with coverage of the held-out record below 70 % the band is too narrow to trust. Then read each result’s 5 %, median and 95 % beside this run’s own value.',
							'Under **Sensitivity runs**, press **Run sensitivity**. Read the verdict at each EWR site ([[sensitivity-verdict]]), then the tornado: the factor with the longest bar is the one better data would settle first.',
							'To weigh a change, open **Compare runs** with the run that has the ensemble as the baseline and the what-if beside it, and press **Compute the paired band** under **Uncertainty**.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Each tool leaves something out. The bands vary the runoff parameters, the pan coefficient, the rain source and the record judged against, never the abstraction or the dams’ starting storage; the sensitivity runs vary those one at a time and never together. A result that holds under both is well supported; one that is “not determinable with current data” says what to measure next.'
					}
				]
			}
		],
		terms: ['uncertainty-bands', 'ensemble-acceptance', 'sensitivity-runs', 'sensitivity-verdict', 'paired-band'],
		related: ['fit-automatically', 'compare-runs', 'river-page']
	},
	{
		id: 'plan-the-season',
		title: 'Weigh a season’s demand level',
		summary: 'Run the outcome matrix and the seasonal outlook at a few demand levels, read how past years went at each, and publish the level the WUA sets.',
		kind: 'use',
		tab: 'river',
		sections: [
			{
				heading: 'What the two panels answer',
				blocks: [
					{
						type: 'p',
						text: 'Both run the catchment at a few [[demand-level|demand levels]] (100, 85 and 70 % of today’s demand by default) and count how past years went. The [[outcome-matrix]] looks at the whole record, split into [[year-class|dry, normal and wet years]]: how the river fares at each level in each kind of year. The [[seasonal-outlook]] starts from the catchment as it stands on the decision date (dams, soil, the runoff model’s stores) and runs the coming season with the weather of each past year ([[analogue-years]]). Neither forecasts the weather, and neither recommends a level: the WUA decides.'
					}
				]
			},
			{
				heading: 'Steps',
				blocks: [
					{
						type: 'steps',
						items: [
							'Run the model on the latest data. Both panels need an ordinary run, not a scenario or forecast run.',
							'In **Model settings**, check **Outcome matrix** (how years are classed and the [[outcome-risk|risk cut-offs]]) and **Seasonal outlook** (the [[outlook-season|season]], the planning share and the review date).',
							'On **EWR**, press **Run…** beside **Outcome matrix**, type the levels and press **Run demand sweep**. Read across a row for one level in every kind of year, and down a column for every level in one kind of year.',
							'Under it, **How much irrigation can the catchment support?** reads the same sweep: for each level, the natural water in a year below which the river’s requirement started to fail (the [[irrigation-support|wettest year that failed]]), with the Key message in words.',
							'Press **Run…** beside **Seasonal outlook**, type the levels (and a monthly plan, if the WUA is considering one) and press **Run seasonal outlook**. Start with the risk line and **Where the season starts**, then read each level’s irrigation supplied, season-end storage, demand met and days below the EWR as the median with its 10–90 % range, and the [[planning-figure]]. **Key messages for farmers** sums it up in plain sentences.',
							'For a mid-season check, read the [[review-triggers]]: the level each band of total dam storage on the review date supported in past years.',
							'Once the WUA has decided, pick **Level the WUA has set** under **Farmers** and press **Publish to farmers** ([[outlook-publish]]).'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'A lower demand level doesn’t always mean fewer days below the EWR: part of the water irrigated from a dam drains back to the river on dry days. With fewer than 10 analogue years the outlook gives no ranges and no planning figure.'
					}
				]
			}
		],
		terms: ['demand-level', 'outcome-matrix', 'irrigation-support', 'seasonal-outlook', 'planning-figure', 'review-triggers'],
		related: ['river-page', 'run-and-read-results']
	},
	{
		id: 'share-with-a-team',
		title: 'Set up a team and share a project',
		summary: 'Make a team for your colleagues, give each a role, move a catchment into it, and share single projects with people outside it.',
		kind: 'use',
		tab: 'project',
		sections: [
			{
				heading: 'Make the team',
				blocks: [
					{
						type: 'steps',
						items: [
							'Open **Teams** in the sidebar and press **New team**. Name it after the consultancy, department or WUA; you are its owner.',
							'On the team’s page, under **Members**, type a colleague’s email and pick a **Role**, then press **Add**. Each person gets an [[invitation]] and joins once they accept it.',
							'Repeat for each colleague. The pending invitations are listed under the form, with **Resend** and **Revoke**; an invitation works for 7 days.'
						]
					},
					{
						type: 'p',
						text: 'A [[team]] role holds on every team project: a **viewer** reads them, an **editor** edits and runs them, and an **owner** owns them and manages the team. Change a member’s role from the list at any time.'
					}
				]
			},
			{
				heading: 'Put a catchment in the team',
				blocks: [
					{
						type: 'steps',
						items: [
							'For a new catchment, pick the team under **Belongs to** in the **New project** dialog.',
							'For an existing one, open it, go to its **Project** page and, under **Team**, choose the team in **Move to** and press **Move**. Only the project’s owners can move it.',
							'Everyone in the team now has the project with their team role. People listed under **Shared directly with** keep their own access too.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'An owner only through the team can’t make the project personal again: add yourself under Members as an owner first.'
					}
				]
			},
			{
				heading: 'Share one project with someone outside the team',
				blocks: [
					{
						type: 'list',
						items: [
							'**A colleague or client who works on the model**: add them under **Members** on the Project page with a [[roles|role]]. Anyone with a role is a member of that project only.',
							'**A farmer**: press **Invite farmers** under **Farmers** and tick their hydrological units. They read only those units, from the published run ([[farmer-link]]).',
							'**Someone who only needs to look** (a forum, an NGO): make a [[share-link]] under **Share links**. It opens the published baseline without signing in, for as long as you choose.'
						]
					},
					{
						type: 'p',
						text: 'Every addition, role change and link is recorded on the [[change-history|History]] page with who made it.'
					},
					{
						type: 'p',
						text: 'A team’s plan covers every catchment in it. Its admins see the plan and this month’s usage (catchments, reports, evidence packs issued and the assistant’s spend) from **Plan and usage** on the team’s page; your own catchments’ plan is under **Plan and usage** on your Account page. Where billing is set up, the page has **Upgrade** (to Pro for you, to Team for a team, monthly or yearly, each with its price; on a team you first choose the editor seats, 3 included, and the buttons show the price for them) or, once there is a subscription, **Manage billing** to change or cancel it. On a team, the editor seats start at the team’s editors when there are more than the 3 included, and the page says how many editors the team has.'
					},
					{
						type: 'p',
						text: 'Once a team has a subscription, the Plan card says what it costs (the price for its seats, monthly or yearly) and how many editor seats it has. To change them, type the new count under **Change seats** in the card and press **Change seats**: the question says the difference a month or a year, that the rest of this period is prorated on the next invoice, and how many editors would have no seat if you go below them. The new count shows once the payment provider confirms it, usually within seconds. A team with more editors than seats says so on the card: everyone keeps their access, and it names how many seats to add or editors to make viewers.'
					},
					{
						type: 'p',
						text: 'While the page says limits aren’t enforced yet, usage is counted against the plan so you can see where you stand, but nothing is refused or paused. When a plan ends (a trial or a cancellation), or a payment is overdue past 14 days (**Payment overdue; paid features paused until it is paid**), the account falls back to Free, which keeps fewer catchments live, and the page lists the catchments so you can choose which stay live. Once limits apply, data feeds, alerts and automatic runs pause on the others after a 14-day grace (each row says from when); nothing is deleted, everyone can still open, run, edit and export them, and they carry on as before on a plan again.'
					}
				]
			}
		],
		terms: ['team', 'roles', 'invitation', 'share-link'],
		related: ['project-page', 'create-a-project']
	},
	{
		id: 'push-logger-data',
		title: 'Push logger data with an API key',
		summary: 'Let a logger gateway or a script add daily readings to a project’s series without signing in, and keep an eye on it.',
		kind: 'howto',
		tab: 'project',
		sections: [
			{
				heading: 'Make a key',
				blocks: [
					{
						type: 'steps',
						items: [
							'Make sure the series exists: upload its record once on the **Data** tab, with the name the gateway will send. A key creates a series only when the project has none of that kind.',
							'As an owner, open the **Project** page and go to **API keys**.',
							'Give the key a **Name** that says where it runs (“Drift logger gateway”), choose how long it **Works for**, and under **What it may write** choose **Only these series** and tick the ones it feeds.',
							'Press **Make key** and copy the key at once: it is shown only this once. Store it in the gateway’s own settings, never in a shared file.'
						]
					}
				]
			},
			{
				heading: 'Send the readings',
				blocks: [
					{
						type: 'p',
						text: 'The gateway sends each day’s readings to the ingest address with the key, as in the example request shown under the new key: the series’ kind and name, its unit, the first date and one value a day. Only the days sent change, in the series’ own units, and sending the same days again changes nothing, so a gateway can safely resend the last week every day.'
					},
					{
						type: 'p',
						text: 'Each push shows in **History** as **API key “name”**. When the project re-runs automatically, a push that changed days queues a run. A push that looks wrong (a negative value, a value far above the record’s usual range, or a series it had to create) is still stored, but holds the automatic runs until a person runs the model.'
					}
				]
			},
			{
				heading: 'Keep an eye on it',
				blocks: [
					{
						type: 'list',
						items: [
							'The key’s row shows when it was **Last used**.',
							'Switch on **API data behind** in the Summary’s alert rules to be emailed when a series the key sends stops getting readings ([[alert-rules]]).',
							'If a key leaks or the gateway is retired, press **Revoke**: the key is refused from its next request. Make a new key for a replacement gateway.'
						]
					}
				]
			}
		],
		terms: ['api-key', 'alert-rules', 'change-history'],
		related: ['add-data']
	},
	{
		id: 'ask-the-assistant',
		title: 'Ask the assistant about a project',
		summary: 'Ask questions about a project’s model and results in plain words, and review the changes it recommends before you save or try any.',
		kind: 'use',
		sections: [
			{
				heading: 'Ask a question',
				blocks: [
					{
						type: 'steps',
						items: [
							'Open the project and press **Assistant** on the page title’s line, after **How this page works** (on a phone, its chat-bubble icon). It shows on every page of the project when your organisation has the assistant switched on.',
							'Type a question about this project, such as “Why does the simulated flow at the outlet gauge not respond to rainfall?”, and press **Send** (or Enter).',
							'The answer comes in as it is written. The lines above it say what the assistant read to answer: the network, a series, the run’s summary, a gauge’s fit or the help guides.',
							'Ask a follow-up in the same box: the assistant sees the whole conversation. **Stop** ends an answer early; **New conversation** starts again.'
						]
					},
					{
						type: 'p',
						text: '**Past chats**, at the top of the panel, lists your earlier conversations on this project, newest first. Open one to read it or carry on asking; **Delete** removes one, **Clear past chats** all of them. A recommended change in a past chat can’t be applied, since the project may have changed since: ask again for a fresh one.'
					},
					{
						type: 'note',
						tone: 'tip',
						text: 'Past chats are kept only in this browser, on this device: they never reach our servers, and signing out deletes them, so the next person on a shared computer sees none. In a private window, or with site data blocked, there are no past chats.'
					},
					{
						type: 'p',
						text: 'It reads the run you have open (on Runs & results, EWR and the other run pages), or the project’s latest run. It reads only what your [[roles|role]] lets you see, and it never changes anything.'
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Its answers are advice, not model output: check them against the run’s own results before you rely on them, as the line under the box says.'
					}
				]
			},
			{
				heading: 'Review a recommended change',
				blocks: [
					{
						type: 'p',
						text: 'Ask it what to change (“Which settings would you change to improve the fit at the outlet?”) and it may answer with a **Recommended change**: a title naming exactly what it changes, then each change, its value now and the suggested one, with why under it. A change it couldn’t make never appears on the card.'
					},
					{
						type: 'p',
						text: 'It keeps the model of the catchment apart from how its water is managed. The calibrated parameters (GR4J’s X1–X4, the pan coefficients, the CHIRPS bias settings) are fitted to the observed flow, so it changes them only in a **Recalibration**, to improve the fit, never to make the EWR, a yield or the assurance look better. For those it recommends a **Management change**: a dam’s runoff capture or release, a hands-off flow, a transfer’s months, rates or caps, the drought restriction or demand. When no management lever would help, it says so.'
					},
					{
						type: 'steps',
						items: [
							'A recalibration or a correction: press **Apply to the settings form** (editors and owners only). **Model settings** opens with the change in the form, not yet saved, and the **Reason for this change** filled in as “Assistant suggestion: …”. Check the values, then press **Save changes** to keep it, or **Discard** to drop it. Run the model to see what it does.',
							'A management change: press **Try it as a scenario** (editors and owners only). It becomes a [[scenario]] on the run you have open, named after the card, and **Scenarios** opens on it. Run it and compare it with the run to judge the change; the project itself is unchanged.'
						]
					},
					{
						type: 'p',
						text: 'Each is checked like any other save or scenario, and the [[change-history|History]] page keeps a saved change with its reason.'
					}
				]
			},
			{
				heading: 'Limits',
				blocks: [
					{
						type: 'list',
						items: [
							'Each person can send a set number of messages an hour. Past it, the panel says how long to wait.',
							'Each project has a monthly budget, shown under the box. Once it is used up the assistant rests until the date shown.',
							'What the assistant cost this month, in dollars against your plan’s allowance, is on **Plan and usage** (from your Account page, or the team’s page for a team’s catchments). It counts by the UTC month.',
							'Nothing you type is kept on our servers. Your browser keeps your 20 newest chats on each project until you delete them or sign out.'
						]
					}
				]
			}
		],
		terms: ['roles', 'change-history'],
		related: ['calibrate-by-hand', 'run-and-read-results']
	},
	{
		id: 'two-step-sign-in',
		title: 'Sign in with two steps',
		summary: 'Add a code from an authenticator app or by email to your password, keep your recovery codes, and get back in after losing your phone.',
		kind: 'use',
		sections: [
			{
				heading: 'What it is',
				blocks: [
					{
						type: 'p',
						text: '[[two-step-sign-in|Two-step sign-in]] asks for a 6-digit code after your password, so someone who learns the password still can’t get in. There are two ways to get the code, and you can turn on both: an **Authenticator app** on your phone (such as Google Authenticator, Microsoft Authenticator or Aegis; the stronger, since only your phone makes the codes) and a **Code by email** (the easier, each code working for 10 minutes, but only as safe as your inbox).'
					}
				]
			},
			{
				heading: 'Turn it on',
				blocks: [
					{
						type: 'steps',
						items: [
							'Open your **Account** page (the foot of the sidebar; on a phone, under **Menu**) and find **Two-step sign-in**.',
							'For the app, press **Set up the app**, enter your current password, scan the QR code with the app (or type the key it shows), and enter the app’s first code. For email, press **Turn on** beside **Code by email**, enter your password and the code we email you.',
							'The first way you turn on brings ten **recovery codes**, shown once: press **Download the codes** or **Copy the codes**, keep them away from your phone and your email (a password manager, or on paper), then press **I’ve saved them**.'
						]
					},
					{
						type: 'p',
						text: 'From then on, each sign-in asks for a code after the password. **Email me a code instead** or **Use a code from the app instead** switches between the two, and the recovery-code link takes one of those. Some actions ask for a fresh code even while you are signed in, such as signing or issuing an evidence pack. A browser that signed in before you set it up must sign out and in again before such an action.'
					}
				]
			},
			{
				heading: 'Recovery codes',
				blocks: [
					{
						type: 'p',
						text: 'Each recovery code works once, in place of a code from the app or the email. The Account page says how many are left and warns at two or fewer; **Make new recovery codes** (with a code) replaces the whole set, and the old ones stop working.'
					}
				]
			},
			{
				heading: 'A lost phone or inbox',
				blocks: [
					{
						type: 'steps',
						items: [
							'With a recovery code: sign in with it, then on the Account page **Remove** the app (or **Turn off** the email codes) and set it up again on the new phone.',
							'Without one: sign in with your password, and on the code step choose **Lost your phone and your recovery codes?** (or **Can’t get the email and lost your recovery codes?**). We email you a link that works for an hour.',
							'The link opens **Remove two-step sign-in**: press **Start the 3-day wait**. Until it ends your codes keep working, and we email you every day with a link to cancel; signing in with a code cancels it too.',
							'When the wait ends, two-step sign-in is removed and every device is signed out. Sign in with your password alone and set two-step sign-in up again on your Account page.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'If you get a removal email you didn’t ask for, someone knows your password: cancel it with a code and choose a new password.'
					}
				]
			},
			{
				heading: 'When a project requires it',
				blocks: [
					{
						type: 'p',
						text: 'An owner can require it: the **Two-step sign-in** panel on the **Project** page (owners only; a team’s admins have the same switch in the team’s settings, which covers every team project) has **Require two-step sign-in**, off by default. While it is on, the project’s owners give a code before they manage members, invitations, share links, API keys or data feeds, or delete the project, and so does anyone who signs a run. To turn it on you must yourself be signed in with a code, so it can’t lock everyone out.'
					},
					{
						type: 'p',
						text: 'Some actions always need it, whatever the switch says, because they reach farmers, the public or a licence decision: publishing to farmers, deciding applications, endorsing a baseline, and signing or issuing an evidence pack. Your Account page says so when your roles need it.'
					}
				]
			}
		],
		terms: ['two-step-sign-in', 'roles', 'pack-signoff'],
		related: ['share-with-a-team', 'issue-an-evidence-pack']
	},
	{
		id: 'issue-an-evidence-pack',
		title: 'Issue an evidence pack',
		summary: 'Turn a run’s evidence report into a signed, hashed pack with a short code that anyone can check on the public verify page.',
		kind: 'use',
		tab: 'runs',
		sections: [
			{
				heading: 'Before you start',
				blocks: [
					{
						type: 'list',
						items: [
							'The baseline must be the project’s [[evidence-run|nominated evidence run]]. For an [[application]], run the application on that baseline.',
							'Declare the [[evidence-uncertainty-rule|uncertainty rule]] under **Model settings → Evidence**, and run an ensemble to it, so the report has bands to cite.',
							'The signer needs two-step sign-in, and, while the project requires it, a current [[pack-signoff|registration check]] recorded on the **Project** page.'
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
							'Open the [[evidence-report]]: **Evidence report** beside **Report** on Runs & results, or from the head of a scenario’s comparison.',
							'Read the checks at the top. Fix every one marked “stops issue” ([[pack-issue-checks]]), run the model again and nominate the new run if the baseline changed, then read **Expect questions about**.',
							'For an application with registered volumes, press **Run at full authorised use**, so page 1 carries the [[full-authorised-use|impact against full authorised use]].',
							'Press **Create evidence pack**. The pack’s page opens: a draft, with its checklist under **Where this pack stands**.',
							'In Appendix B.2, the applicant’s specialist presses **Sign off this evidence pack…**, fills in their registration and ticks every confirmation. An assessor may add a second sign-off as a review.',
							'A line not yet ticked links to where it is done: **Go to Appendix B.2** for the sign-off, the Project page’s **Registration checks** for a signer’s check. When the frozen report itself can’t be issued, draft again from the evidence report once it passes: a draft no one has signed can simply be deleted, a signed one is withdrawn.',
							'Once every line of the checklist is ticked, an editor presses **Issue pack** and confirms. Signing and issuing ask for a fresh code, from the authenticator app or by email.',
							'The server then prints the pack’s PDF, builds its [[reproduction-bundle]] and re-runs it; the pack page shows each as it lands. Hand the [[pack-short-code|short code]] to whoever needs to check the pack, use **Send to the authority…** for the full pack, and **Share link…** for the public.'
						]
					},
					{
						type: 'note',
						tone: 'caution',
						text: 'Issuing is public and permanent: the verify page shows the signers’ names and registrations, and an issued pack is never edited or deleted. A change of evidence is **New version…**; a pack that shouldn’t stand is **Withdraw…**, with a reason anyone holding the code can read.'
					}
				]
			}
		],
		terms: ['evidence-pack', 'pack-lifecycle', 'manifest-hash', 'pack-short-code', 'pack-signoff', 'errata-since'],
		related: ['applications-page', 'run-and-read-results']
	}
];
