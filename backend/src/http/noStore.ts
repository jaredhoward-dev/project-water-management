// Every API answer is `Cache-Control: no-store` unless its route says
// otherwise (docs/security.md § Infrastructure → Caching). Most answers carry
// someone's data: an account, a project, a share link's catchment, an
// invitation's address. CloudFront caches nothing under /api/* (its
// CachingDisabled policy), but that says nothing to the browser, which may
// keep a response without the header in its disk cache, where the next person
// on a shared computer can find it. A route that wants another policy sets
// its own Cache-Control, and this leaves it alone.
import { createMiddleware } from 'hono/factory';

export const NO_STORE = 'no-store';

/** After the route (and the error handler) answered: `no-store` unless the answer already has a Cache-Control. */
export const noStoreByDefault = createMiddleware(async (c, next) => {
	await next();
	if (!c.res.headers.has('cache-control')) c.res.headers.set('Cache-Control', NO_STORE);
});
