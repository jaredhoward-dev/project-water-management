// The imported files' SHA-256 (SourceList.svelte, issue #326 E5) when the
// clipboard refuses: the full hash used to live only in the code's tooltip,
// and the message said to select it from there, which no tooltip allows (and
// a phone never shows one). Now the full hash replaces the short one and is
// selected, so the keyboard's or the menu's copy takes it.
import { seedRunnableProject } from '../support/api.ts';
import { expect, test } from '../support/fixtures.ts';
import { boundaryGeoJson, openMap, uploadThroughSheet } from '../support/map.ts';

test('a refused copy writes the full hash out, selected', async ({ page, owner }) => {
	void owner;
	// No clipboard permission: writeText rejects, as a browser without the grant does.
	await page.addInitScript(() => {
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });
	});
	const project = await seedRunnableProject(page.request, 'Map source copy refused');
	await openMap(page, project.id);
	await uploadThroughSheet(page, null, 'boundary.geojson', boundaryGeoJson());

	await page.getByTestId('section-header').getByRole('link', { name: 'Upload map file' }).click();
	const sheet = page.getByRole('dialog', { name: 'Upload a map file' });
	const hash = sheet.getByTestId('map-source-hash');
	await expect(hash).toHaveText(/^[0-9a-f]{12}…$/);
	await sheet.getByRole('button', { name: 'Copy the SHA-256 of boundary.geojson' }).click();

	await expect(sheet.getByTestId('map-sources').getByRole('status')).toHaveText('Couldn’t copy automatically. The full hash is selected: copy it with your keyboard or menu.');
	await expect(hash).toHaveText(/^[0-9a-f]{64}$/);
	const full = await hash.textContent();
	expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(full);
});
