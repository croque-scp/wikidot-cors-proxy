// CORS + caching proxy for Wikidot

const ALLOWED_HOST_SUFFIXES = ["wikidot.com", "wdfiles.com"];

const DEFAULT_MAX_AGE = 3600;
const STORE_TTL = 86400; // Freshness is enforced per-request against X-Proxy-Cached-At, not this TTL

// The client receives the origin's own Cache-Control, so the browser caches each resource for as long as Wikidot intends. This header carries that value through the edge cache so HITs can replay it, then is stripped before responding
const ORIGIN_CC_HEADER = "X-Proxy-Origin-Cache-Control";
const DEFAULT_CLIENT_CACHE_CONTROL = "no-store";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "X-Proxy-Cache, Content-Type",
    "Access-Control-Expose-Headers": "X-Cache, X-Proxy-Cached-At",
    "Access-Control-Max-Age": "86400",
  };
}

function textResponse(body, status, extraHeaders) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function documentation(origin) {
  const host = origin.replace(/^https?:\/\//, "");
  const target = "https://scp-wiki.wikidot.com/component:croqstyle/code/1";
  return (
    `
${host}
CORS + caching proxy for *.wikidot.com and *.wdfiles.com

Fetch Wikidot pages and files from browser JavaScript (normally blocked by
CORS), with caching to ease the load on Wikidot.

Supports read-only operations (GET) on public resources only.

You do not need to use a CORS proxy when accessing Wikidot resources by any
means other than browser Javascript.

Usage: in browser-side fetches, pass the encoded target URL as ?url=:

  ${origin}/?url=THE_ENCODED_ADDRESS

E.g. to fetch the text of a CSS code block:

  const target = "${target}";
  const proxied = "${origin}/?url=" + encodeURIComponent(target);
  const response = await fetch(proxied);
  const text = await response.text();  // or .blob() for images

Caching: responses are reused for up to an hour by default. Override per
request with the X-Proxy-Cache header:

  await fetch(proxied, { headers: { "X-Proxy-Cache": "max-age=3600" } });

  max-age=3600    accept a cached copy up to 1h old (very efficient)
  max-age=30      accept a cached copy up to 30s old (kinda efficient)
  no-cache        always fetch a fresh copy (inefficient, very impolite)

X-Cache response header tells you if it was cached or not (HIT / MISS).

Rate limit: 60 requests per 10 seconds per IP, then HTTP 429.

Source code: https://github.com/croque-scp/wikidot-cors-proxy
`.trim() + "\n"
  );
}

function parseCacheDirective(header) {
  const directive = { read: true, write: true, maxAge: DEFAULT_MAX_AGE };
  if (!header) return directive;

  for (const token of header.toLowerCase().split(",")) {
    const [key, value] = token.trim().split("=");
    switch (key) {
      case "no-store":
        directive.read = false;
        directive.write = false;
        break;
      case "no-cache":
        directive.read = false;
        break;
      case "max-age": {
        const seconds = Number(value);
        if (!isNaN(seconds)) directive.maxAge = seconds;
        break;
      }
    }
  }
  return directive;
}

function resolveTarget(rawUrl) {
  if (!rawUrl) return null;
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return null;
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return null;
  const host = target.hostname.toLowerCase();
  const allowed = ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  return allowed ? target : null;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse("Only GET, HEAD and OPTIONS are supported.\n", 405, {
        Allow: "GET, HEAD, OPTIONS",
      });
    }

    const url = new URL(request.url);

    // Browsers omit Sec-Fetch metadata over plain HTTP, which the navigation guard below depends on, so upgrade it
    const scheme = (request.headers.get("CF-Visitor") || "").includes(
      '"scheme":"http"',
    )
      ? "http:"
      : url.protocol;
    if (scheme === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }

    const target = resolveTarget(url.searchParams.get("url"));

    if (!target) {
      const status = url.searchParams.has("url") ? 400 : 200;
      return textResponse(documentation(url.origin), status);
    }

    // Refuse document navigations (rendering proxied HTML could be a phishing vector and also just doesn't feel right)
    // Sec-Fetch-Dest cannot be forged by browser JS; Upgrade-Insecure-Requests is the fallback for plain HTTP that omits it
    const dest = request.headers.get("Sec-Fetch-Dest");
    const isNavigation =
      ["document", "iframe", "frame", "embed", "object"].includes(dest) ||
      (!dest && request.headers.has("Upgrade-Insecure-Requests"));
    if (isNavigation) {
      return textResponse(
        `
dumbass this cors proxy is meant to be used in javascript

go read ${url.origin} again
`.trim() + "\n",
        403,
      );
    }

    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "anonymous";
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return textResponse("Too many requests, slow down.\n", 429, {
          "Retry-After": "10",
        });
      }
    }

    const directive = parseCacheDirective(request.headers.get("X-Proxy-Cache"));

    // Key on the target URL alone, so all consumers share one cached copy
    const cache = caches.default;
    const cacheKey = new Request(target.toString(), { method: "GET" });

    if (directive.read) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const cachedAt = Number(cached.headers.get("X-Proxy-Cached-At")) || 0;
        const age = Math.max(0, Math.floor(Date.now() / 1000) - cachedAt);
        if (age <= directive.maxAge) {
          const response = new Response(cached.body, cached);
          response.headers.set("X-Cache", "HIT");
          response.headers.set("Age", String(age));
          response.headers.set(
            "Cache-Control",
            cached.headers.get(ORIGIN_CC_HEADER) ||
              DEFAULT_CLIENT_CACHE_CONTROL,
          );
          response.headers.delete(ORIGIN_CC_HEADER);
          return response;
        }
      }
    }

    // Forward requester info to Wikidot
    const forwardHeaders = { Accept: request.headers.get("Accept") || "*/*" };
    const userAgent = request.headers.get("User-Agent");
    if (userAgent) forwardHeaders["User-Agent"] = userAgent;
    const referer =
      request.headers.get("Referer") || request.headers.get("Origin");
    if (referer) forwardHeaders["Referer"] = referer;

    let originResponse;
    try {
      originResponse = await fetch(target.toString(), {
        method: request.method,
        headers: forwardHeaders,
        redirect: "follow",
      });
    } catch (error) {
      return textResponse(`Upstream fetch failed: ${error.message}\n`, 502);
    }

    const now = Math.floor(Date.now() / 1000);
    const clientCacheControl =
      originResponse.headers.get("Cache-Control") ||
      DEFAULT_CLIENT_CACHE_CONTROL;
    const headers = new Headers(originResponse.headers);
    headers.delete("Set-Cookie");
    headers.delete("Cache-Control");
    for (const [key, value] of Object.entries(corsHeaders())) {
      headers.set(key, value);
    }
    headers.set("Cache-Control", `public, max-age=${STORE_TTL}`);
    headers.set(ORIGIN_CC_HEADER, clientCacheControl);
    headers.set("X-Proxy-Cached-At", String(now));
    headers.set("X-Cache", "MISS");

    const response = new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers,
    });

    // Cache the clone, which keeps our TTL and ORIGIN_CC_HEADER, before overwriting Cache-Control on the client response
    if (directive.write && response.ok) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    response.headers.set("Cache-Control", clientCacheControl);
    response.headers.delete(ORIGIN_CC_HEADER);
    return response;
  },
};
