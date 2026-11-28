// Scrolling a spec can rely on. A scroll is a one-off: `window.scrollTo(0, scrollHeight)` lands where the page's end
// is at that moment, and a page still growing (a panel loading under the fold, a table filling) leaves it short, so a
// read straight after it measures the wrong place (scenarios-page.spec.ts, CI run 46033108045: the rail read at the
// top, 85 px). These redo the scroll until the page is really there, each poll a fresh scroll against the page as it
// now is, so they wait on the measured condition itself rather than on time. measureChecks.test.ts sends one-off
// scrolls here.
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Scroll the window (a Page) or a scroll box (a Locator) to its end, and return once it is at the end: scrolled, and
 * nothing left below. The box's height is fractional while scrollTop and scrollHeight are whole pixels, so "at the end"
 * allows the one pixel of rounding.
 */
export async function scrollToEnd(target: Page | Locator): Promise<void> {
	const atEnd =
		'mouse' in target
			? () =>
					target.evaluate(() => {
						const root = document.documentElement;
						// settled: polled below, redone until the window is at its end.
						window.scrollTo({ top: root.scrollHeight, behavior: 'instant' });
						return window.scrollY > 0 && Math.ceil(window.scrollY + window.innerHeight) >= root.scrollHeight - 1;
					})
			: () =>
					target.evaluate((el) => {
						// settled: polled below, redone until the box is at its end.
						el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
						return el.scrollTop > 0 && Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 1;
					});
	await expect.poll(atEnd, { message: 'scrolled to the end' }).toBe(true);
}

/** Scroll the window to `y` px from the top and return once it is there (the page may still be growing to that height). */
export async function scrollToY(page: Page, y: number): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate((top) => {
					window.scrollTo({ top, behavior: 'instant' });
					return Math.round(document.scrollingElement!.scrollTop);
				}, y),
			{ message: `scrolled to ${y}` }
		)
		.toBe(y);
}

/**
 * Turn the mouse wheel and return once the scroll it started has ended. Chromium animates a wheel scroll, and
 * `mouse.wheel` returns before the animation finishes, so a scroll position read straight after it is a frame of the
 * animation, and the rest can still move the page under a later step. `scrollend` (on the document, or captured from a
 * scroll box) is the browser's own signal that the scroll has finished; the listener is installed before the wheel
 * turns. The wheel must be able to scroll something under the mouse.
 */
export async function wheelAndSettle(page: Page, dx: number, dy: number): Promise<void> {
	await page.evaluate(() => {
		const w = window as Window & { __wheelEnded?: boolean };
		w.__wheelEnded = false;
		document.addEventListener('scrollend', () => (w.__wheelEnded = true), { once: true, capture: true });
	});
	await page.mouse.wheel(dx, dy); // settled: its scrollend is awaited next.
	await expect.poll(() => page.evaluate(() => (window as Window & { __wheelEnded?: boolean }).__wheelEnded), { message: 'the wheel’s scroll ended' }).toBe(true);
}
