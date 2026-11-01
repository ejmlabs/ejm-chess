const EDGE_CACHE = 'public, max-age=10, s-maxage=10';
// Browsers revalidate each read against the edge copy, so a refresh never stacks a stale local copy on the edge window.
export const PUBLIC_BROWSER_CACHE = 'public, no-cache';

function forBrowser(response: Response): Response {
  const browser = new Response(response.body, response);
  browser.headers.set('Cache-Control', PUBLIC_BROWSER_CACHE);
  return browser;
}

/**
 * The one cache for unauthenticated public JSON reads. `params` are the query parameters the route
 * documents; they and the path are the whole cache key. Cookies, account headers and every other
 * parameter never create a variant, and a failed read is never stored.
 * Keep private identity and mutations outside this helper.
 */
export async function publicJson(request: Request, ctx: ExecutionContext, params: readonly string[], load: () => Promise<unknown>): Promise<Response> {
  const source = new URL(request.url);
  const url = new URL(source.pathname, source.origin);
  for (const name of params) {
    const value = source.searchParams.get(name);
    if (value !== null) url.searchParams.set(name, value);
  }
  const key = new Request(url.href);
  try {
    const cached = await caches.default.match(key);
    if (cached) return forBrowser(cached);
  } catch { /* Cache failure falls through to the public read model. */ }
  const response = Response.json(await load(), { headers: { 'Cache-Control': EDGE_CACHE } });
  ctx.waitUntil(caches.default.put(key, response.clone()).catch(() => {}));
  return forBrowser(response);
}
