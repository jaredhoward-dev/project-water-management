// The project's assistant (issue #610, docs/ui.md § Assistant), against the
// e2e API's scripted mock model (ASSISTANT_PROVIDER=mock). The gauge question
// from the issue: the answer streams in with a line for each tool it read the
// project with (the network, the series, the gauge's fit) and names the gauge;
// the disclaimer and the budget sit under the box; the sheet passes axe. With
// the assistant off (the second e2e API, which leaves it at its default) the
// header has no Assistant button. The button sits in one place on every
// section, after How this page works on the title's line, at every width. The
// sheet's layout: the question box pinned to its foot with the examples right
// above it, the disclaimer's first line in view and the rest folded, one way
// out (the ✕), at 1440×960 and on a phone. What a run needs: the Run model
// button's own check (get_run_readiness), shown as paragraphs, a list and bold.
// A dollar cap's refusal (issue #641, the POST answered 429 by page.route, since
// the e2e API runs without billing enforced): the server's words, the box
// closed, and Compare plans to the Plan page on Free's day; none on the Free pool.
// In a team catchment Compare plans opens the team's plan for its admin, and the
// price list with planLink's "ask a team admin" line for a member or a direct editor.
// A reverse trial (the status's `day` added by page.route, as an enforced API
// sends it): the questions-left meter, and its day cap's own words, no upsell.
// Invented data only.
import type { Page } from '@playwright/test';
import { acceptInvites, addMember, createProject, createRun, seedRunnableProject } from '../support/api.ts';
import { API_URL } from '../support/env.ts';
import { expectNoViolations } from '../support/a11y.ts';
import { expectNoSidewaysScroll } from '../support/reflow.ts';
import { ask, assistantButton, assistantSheet, openAssistant } from '../support/assistant.ts';
import { expect, test } from '../support/fixtures.ts';
import { viaMfaApi } from '../support/mfaApi.ts';
import { sectionHeader } from '../support/sectionHeader.ts';

test('answers why the simulated flow at a gauge doesn’t respond to rainfall, from the project’s own data', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Assistant gauge farm');
	await createRun(page.request, project.id, 'Baseline');
	await page.goto(`/projects/${project.id}`);
	const sheet = await openAssistant(page);
	await expect(sheet.getByTestId('assistant-disclaimer')).not.toBeEmpty();
	await expect(sheet.getByTestId('assistant-budget')).toContainText('of this month’s budget left');

	const answer = await ask(sheet, 'Why does the simulated flow at gauge Outflow gauge not respond to rainfall?');
	await expect(sheet.getByTestId('assistant-question')).toHaveText(/Outflow gauge not respond to rainfall/);
	// A line for each tool the mock reads the project with, in order, each finished
	// (backend/src/assistant/providers/mock.ts: the network, the runoff of the dam above
	// the gauge, the gauge's outflow, its fit).
	const tools = answer.getByTestId('assistant-tool');
	await expect(tools).toHaveText([/^Reading the network/, /^Reading a series/, /^Reading a series/, /^Checking a gauge's fit/]);
	for (const [i, tool] of ['get_network', 'get_series', 'get_series', 'get_gauge_fit'].entries()) {
		await expect(tools.nth(i)).toHaveAttribute('data-tool', tool);
		await expect(tools.nth(i)).toHaveAttribute('data-status', 'done');
	}
	// The mock's answer, its four lines from what the tools read: the seed's two dams drain
	// straight into Outflow gauge (get_network lists Lower farm first), the series' means and
	// the outlet's calibration statistics (the run's, numbers that depend on the engine).
	const N = '-?\\d+\\.\\d{2}';
	await expect(answer.getByTestId('assistant-text')).toHaveText(
		new RegExp(
			[
				'^Gauge Outflow gauge has 2 dam\\(s\\) upstream: Lower farm, Upper farm\\.',
				`Runoff at Lower farm averages ${N} and the gauge’s outflow ${N} in the series read\\.`,
				`The fit at the gauge: NSE ${N}, KGE ${N}, PBIAS ${N}\\.`,
				'The dams upstream fill before they spill, so rain above them reaches the gauge only once they are full: check their capacity and starting level before changing GR4J\\.$'
			].join('\\s*')
		)
	);
	await expect(sheet.getByRole('status')).toHaveText('The assistant answered.');
	await expectNoViolations(page);

	// Closing keeps the conversation (it lives in the page); New conversation starts over.
	await sheet.getByRole('button', { name: 'Close dialog' }).click();
	await expect(sheet).toBeHidden();
	await openAssistant(page);
	await expect(sheet.getByTestId('assistant-answer')).toHaveCount(1);
	await sheet.getByRole('button', { name: 'New conversation' }).click();
	await expect(sheet.getByTestId('assistant-answer')).toHaveCount(0);
});

test('answers what a run needs from the Run model button’s own check, formatted as paragraphs, a list and bold (the 2026-10-30 production test)', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Assistant empty farm');
	await page.goto(`/projects/${project.id}`);
	const sheet = await openAssistant(page);
	const answer = await ask(sheet, 'What do I need before I can run the model?');
	const tool = answer.getByTestId('assistant-tool');
	await expect(tool).toHaveText([/^Checking what a run needs/]);
	await expect(tool).toHaveAttribute('data-tool', 'get_run_readiness');
	const text = answer.getByTestId('assistant-text');
	// The words before the tool call and the answer after it are two paragraphs, not one run-on line.
	await expect(text.locator('p').first()).toHaveText('Let me check what a run needs.');
	await expect(text.locator('strong').first()).toHaveText('Before a run');
	// The blockers are the Run model button's own (engine runReady.ts), a list, its marks gone.
	await expect(text.locator('li')).toHaveText(['A run needs a network.', 'A run needs a rainfall series.']);
	await expect(text).not.toContainText('**');
	await expect(text).not.toContainText('- A run');
	await expect(text).toContainText('Not needed to start a run: Nothing else stops a run from starting.');
	await expectNoViolations(page);
});

test('with the assistant off the header has no Assistant button (control: on, it has)', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Assistant off farm');
	await page.goto(`/projects/${project.id}`);
	await expect(assistantButton(page)).toBeVisible();

	// The second e2e API leaves ASSISTANT_PROVIDER at its default, off: GET …/assistant answers { available: false }.
	await viaMfaApi(page);
	await page.reload();
	await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
	await expect(sectionHeader(page).getByTestId('assistant-open')).toHaveCount(0);
	await expect(assistantSheet(page)).toHaveCount(0);
});

test('the Assistant button is in one place on every section: after the guide on the title’s line, never in More actions', async ({ page, owner }) => {
	void owner;
	const project = await seedRunnableProject(page.request, 'Assistant place farm');
	await createRun(page.request, project.id, 'Baseline');
	for (const size of [
		{ width: 1440, height: 900 },
		{ width: 360, height: 740 }
	]) {
		await page.setViewportSize(size);
		for (const tab of ['overview', 'network', 'settings', 'runs']) {
			await page.goto(`/projects/${project.id}?tab=${tab}`);
			const at = `${tab} at ${size.width}`;
			const h = sectionHeader(page);
			const button = assistantButton(page);
			await expect(button, at).toBeVisible();
			// Not one of the tab's actions (on a phone those fold into More actions).
			await expect(h.getByTestId('header-own').getByTestId('assistant-open'), at).toHaveCount(0);
			const guide = (await h.getByTestId('section-guide').boundingBox())!;
			const box = (await button.boundingBox())!;
			// Right after the guide, centred on its line.
			expect(box.x, at).toBeGreaterThan(guide.x + guide.width);
			expect(Math.abs(box.y + box.height / 2 - (guide.y + guide.height / 2)), at).toBeLessThan(4);
			// Its word on a wide screen; on a phone the icon alone, a 36 px circle, still named Assistant.
			if (size.width === 1440) await expect(button, at).toHaveText('Assistant');
			else expect(box.height, at).toBeGreaterThanOrEqual(36);
		}
	}
	await expectNoViolations(page);
});

/** The sheet's layout (docs/ui.md § Assistant): the box at the sheet's foot, inside the window; the examples just above it. */
async function expectComposerPinned(page: Page) {
	const sheet = assistantSheet(page);
	const box = await sheet.getByRole('textbox', { name: 'Your question' }).boundingBox();
	const send = await sheet.getByRole('button', { name: 'Send' }).boundingBox();
	const line = await sheet.getByTestId('assistant-disclaimer').locator('summary').boundingBox();
	const fold = await sheet.getByTestId('assistant-disclaimer').boundingBox();
	const vh = page.viewportSize()!.height;
	expect(box && send && line && fold).toBeTruthy();
	expect(send!.y + send!.height).toBeLessThanOrEqual(vh);
	expect(line!.y + line!.height).toBeLessThanOrEqual(vh);
	// Pinned: the disclaimer (closed, its line; open, its paragraphs) ends within 24 px of the window's foot.
	expect(fold!.y + fold!.height).toBeLessThanOrEqual(vh);
	expect(vh - (fold!.y + fold!.height)).toBeLessThan(24);
	return box!;
}

for (const size of [
	{ width: 1440, height: 960 },
	{ width: 390, height: 844 }
]) {
	test(`the sheet at ${size.width}: box pinned to the foot, examples beside it, the disclaimer folded, one way out`, async ({ page, owner }) => {
		void owner;
		await page.setViewportSize(size);
		const project = await seedRunnableProject(page.request, `Assistant layout farm ${size.width}`);
		await page.goto(`/projects/${project.id}`);
		const sheet = await openAssistant(page);
		// Asking is what the sheet is for: the box has the focus.
		await expect(sheet.getByRole('textbox', { name: 'Your question' })).toBeFocused();

		const box = await expectComposerPinned(page);
		// No gap between the empty state and the box: the last example ends within 32 px above it.
		const examples = sheet.getByRole('list', { name: 'For example' }).getByRole('button');
		await expect(examples).toHaveCount(2);
		const last = (await examples.last().boundingBox())!;
		expect(box.y - (last.y + last.height)).toBeGreaterThanOrEqual(0);
		expect(box.y - (last.y + last.height)).toBeLessThan(80);

		// The disclaimer: what the answers are, in view; the report's paragraphs one click away.
		const disclaimer = sheet.getByTestId('assistant-disclaimer');
		await expect(disclaimer.locator('summary')).toContainText('The assistant’s answers are advice, not model output');
		const full = disclaimer.getByRole('region', { name: 'The full disclaimer' });
		await expect(full).toBeHidden();
		await disclaimer.locator('summary').click();
		await expect(full).toBeVisible();
		await expect(full).toContainText('Terms of use');
		await expectComposerPinned(page);

		// One way out: the ✕ (no Close button in the foot as well).
		await expect(sheet.getByRole('button', { name: 'Close', exact: true })).toHaveCount(0);
		await expectNoSidewaysScroll(page);
		await expectNoViolations(page);

		// A conversation scrolls above the box, which stays where it was.
		await ask(sheet, 'Why does the simulated flow at gauge Outflow gauge not respond to rainfall?');
		await expectComposerPinned(page);
		await expect(sheet.getByTestId('assistant-text')).toBeInViewport();
		await sheet.getByRole('button', { name: 'Close dialog' }).click();
		await expect(sheet).toBeHidden();
	});
}

/** Answers the assistant's POST with a dollar cap's 429, as usage.ts beginTurn sends it (with billing enforced). */
async function refuseWith(page: Page, code: string, error: string, plan?: string) {
	const resetsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
	await page.route(/\/projects\/[^/]+\/assistant\/messages$/, (route) =>
		route.request().method() === 'POST'
			? route.fulfill({
					status: 429,
					contentType: 'application/json',
					headers: { 'retry-after': '10800' },
					body: JSON.stringify({ error, code, params: { seconds: 10800, resetsAt, ...(plan ? { plan } : {}) } })
				})
			: route.fallback()
	);
}

test('a dollar cap: Free’s day shows the server’s words, closes the box and offers Compare plans; the Free pool doesn’t', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Assistant capped farm');
	const day = 'That’s today’s free assistant use. It’s back at midnight (UTC). Everything else in your catchment keeps working: runs, calibration, scenarios and exports have no limit on Free.';
	await refuseWith(page, 'assistant_daily_cap', day, 'free');
	await page.goto(`/projects/${project.id}`);
	const sheet = await openAssistant(page);
	const box = sheet.getByRole('textbox', { name: 'Your question' });
	await box.fill('How full is the dam?');
	await sheet.getByRole('button', { name: 'Send' }).click();
	const cap = sheet.getByTestId('assistant-cap');
	await expect(cap).toHaveAttribute('data-code', 'assistant_daily_cap');
	await expect(cap).toContainText(day);
	await expect(cap).toContainText(/Back .+ your time\./);
	await expect(box).toBeDisabled();
	// Not taken: the question goes back in the box.
	await expect(box).toHaveValue('How full is the dam?');
	const plans = cap.getByRole('link', { name: 'Compare plans' });
	await expect(plans).toHaveAttribute('href', /\/account\/plan$/);
	await expectNoViolations(page);
	await plans.click();
	await expect(page).toHaveURL(/\/account\/plan$/);

	// The Free pool: the same closed box, never an upgrade prompt.
	await page.unrouteAll({ behavior: 'wait' });
	const pool = 'The free assistant has reached its shared limit for today. It’s back tomorrow. This isn’t something you did, and your work isn’t affected.';
	await refuseWith(page, 'assistant_free_pool_spent', pool, 'free');
	await page.goto(`/projects/${project.id}`);
	const again = await openAssistant(page);
	await again.getByRole('textbox', { name: 'Your question' }).fill('How full is the dam?');
	await again.getByRole('button', { name: 'Send' }).click();
	const poolCap = again.getByTestId('assistant-cap');
	await expect(poolCap).toHaveAttribute('data-code', 'assistant_free_pool_spent');
	await expect(poolCap).toContainText(pool);
	await expect(again.getByRole('textbox', { name: 'Your question' })).toBeDisabled();
	await expect(poolCap.getByRole('link', { name: 'Compare plans' })).toHaveCount(0);
	await expect(poolCap).not.toContainText('Pro includes');
});

// Compare plans in a team catchment (docs/billing.md § Who the plan belongs to): only a team admin reads the team's
// plan, so a team member, or an editor shared the catchment directly, gets the price list and whose plan it is.
test('a dollar cap in a team catchment: Compare plans opens the team’s plan for its admin, and the price list with “ask a team admin” for a member or a direct editor', async ({ page, owner, signIn }) => {
	void owner;
	const team = (await (await page.request.post(`${API_URL}/teams`, { data: { name: 'Assistant Plan WUA' } })).json()) as { team: { id: string } };
	const made = await page.request.post(`${API_URL}/projects`, { data: { name: 'Assistant team plan', teamId: team.team.id } });
	expect(made.status()).toBe(201);
	const projectId = ((await made.json()) as { project: { id: string } }).project.id;
	const member = await signIn('Assistant team member');
	expect((await page.request.post(`${API_URL}/teams/${team.team.id}/members`, { data: { email: member.user.email, role: 'member' } })).status()).toBe(201);
	expect(await acceptInvites(member.user.email, team.team.id)).toBe(1);
	const direct = await signIn('Assistant direct editor');
	await addMember(page.request, projectId, direct.user.email, 'editor');
	const words = 'That’s today’s free assistant use. It’s back at midnight (UTC).';

	const capped = async (p: Page) => {
		await refuseWith(p, 'assistant_daily_cap', words, 'free');
		await p.goto(`/projects/${projectId}`);
		const sheet = await openAssistant(p);
		await sheet.getByRole('textbox', { name: 'Your question' }).fill('How full is the dam?');
		await sheet.getByRole('button', { name: 'Send' }).click();
		const cap = sheet.getByTestId('assistant-cap');
		await expect(cap).toContainText(words);
		return cap;
	};

	// The admin (who made the team): the team's plan, no "ask".
	const adminCap = await capped(page);
	await expect(adminCap.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', `/teams/${team.team.id}/plan`);
	await expect(adminCap.getByTestId('plan-ask-admin')).toHaveCount(0);

	// A team member: the price list, naming the team.
	const memberCap = await capped(member.page);
	await expect(memberCap.getByTestId('plan-ask-admin')).toHaveText('This catchment is on Assistant Plan WUA’s plan: ask a team admin to change it.');
	const plans = memberCap.getByRole('link', { name: 'Compare plans' });
	await expect(plans).toHaveAttribute('href', '/welcome/pricing');
	await expectNoViolations(member.page);
	await plans.click();
	await expect(member.page).toHaveURL(/\/welcome\/pricing$/);

	// Shared directly, outside the team: the team's name is private to its members.
	const directCap = await capped(direct.page);
	await expect(directCap.getByTestId('plan-ask-admin')).toHaveText('This catchment is on its team’s plan: ask a team admin to change it.');
	await expect(directCap.getByRole('link', { name: 'Compare plans' })).toHaveAttribute('href', '/welcome/pricing');
});

/** Adds `day` to the assistant's status, as the API sends it for a capped account with billing enforced (usage.ts dayMeter). */
async function statusWithDay(page: Page, day: Record<string, unknown>) {
	await page.route(/\/projects\/[^/]+\/assistant$/, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback();
		const res = await route.fetch();
		const status = await res.json();
		await route.fulfill({ response: res, json: { ...status, day } });
	});
}

test('a reverse trial: the day meter estimates questions left, and its day cap has its own words with no Compare plans', async ({ page, owner }) => {
	void owner;
	const project = await createProject(page.request, 'Assistant trial farm');
	await statusWithDay(page, {
		kind: 'trial',
		usdMicrosPerDay: 1_000_000,
		usdMicrosLeft: 600_000,
		messagesLeft: null,
		trialUsdMicrosLeft: 1_500_000,
		medianTurnUsdMicros: 100_000,
		resetsAt: new Date(Date.now() + 3 * 3600_000).toISOString()
	});
	const words = 'That’s today’s assistant use on your trial. It’s back at midnight, South African time. Everything else in your catchment keeps working.';
	await refuseWith(page, 'assistant_trial_daily_cap', words);
	await page.goto(`/projects/${project.id}`);
	const sheet = await openAssistant(page);
	// The estimate, worded as one, above the month's budget.
	// clock-free: "today" is the meter's fixed wording for the SAST day, not a date the clock moves.
	await expect(sheet.getByTestId('assistant-day-meter')).toHaveText('About 6 questions left today on your trial, at what your questions usually cost (an estimate).');
	await expect(sheet.getByTestId('assistant-budget')).toBeVisible();
	const box = sheet.getByRole('textbox', { name: 'Your question' });
	await box.fill('How full is the dam?');
	await sheet.getByRole('button', { name: 'Send' }).click();
	const cap = sheet.getByTestId('assistant-cap');
	await expect(cap).toHaveAttribute('data-code', 'assistant_trial_daily_cap');
	await expect(cap).toContainText(words);
	await expect(cap).toContainText(/Back .+ your time\./);
	await expect(box).toBeDisabled();
	await expect(box).toHaveValue('How full is the dam?');
	await expect(cap.getByRole('link', { name: 'Compare plans' })).toHaveCount(0);
	await expect(sheet.getByText('The question wasn’t sent')).toHaveCount(0);
	await expectNoViolations(page);
});
