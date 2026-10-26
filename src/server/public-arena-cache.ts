/** Public read cache. Keep private identity and mutations outside this helper. */
export async function publicArenaJson(request: Request, ctx: ExecutionContext, load: () => Promise<unknown>): Promise<Response> {
  const url = new URL(request.url);
  const cursor = url.pathname.endsWith('/standings') ? url.searchParams.get('cursor') : null;
  // Only the documented public cursor affects the cache key. Cookies, account
  // headers and unrelated query parameters never create spectator variants.
  url.search = '';
  if (cursor !== null) url.searchParams.set('cursor', cursor);
  const key = new Request(url.href);
  try {
    const cached = await caches.default.match(key);
    if (cached) return cached;
  } catch { /* Cache failure falls through to the public read model. */ }
  const response = Response.json(await load(), { headers: { 'Cache-Control': 'public, max-age=10, s-maxage=10' } });
  ctx.waitUntil(caches.default.put(key, response.clone()).catch(() => {}));
  return response;
}
