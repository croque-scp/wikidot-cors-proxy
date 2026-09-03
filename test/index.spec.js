import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../src";

const PROXY = "https://proxy.example.com";
const TARGET = "https://scp-wiki.wikidot.com/scp-173";

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockUpstream(body = "hello", init = {}) {
  // Return a fresh Response per call: a body stream cannot be reused across separate Worker request handlers
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Set-Cookie": "session=secret",
          ...init.headers,
        },
      }),
  );
}

async function run(request, testEnv = env) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

// A rate limiter that denies every request, to force the 429 path deterministically
const denyLimiter = {
  ...env,
  RATE_LIMITER: { limit: async () => ({ success: false }) },
};

describe("cors-proxy", () => {
  it("answers CORS preflight", async () => {
    const response = await run(
      new Request(`${PROXY}/?url=${TARGET}`, { method: "OPTIONS" }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
      "X-Proxy-Cache",
    );
  });

  it("proxies a wikidot URL with CORS headers and strips cookies", async () => {
    mockUpstream("the body");
    const response = await run(
      new Request(`${PROXY}/?url=${encodeURIComponent(TARGET)}`),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("the body");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("X-Cache")).toBe("MISS");
    // Origin sent no Cache-Control, so the client gets the safe default
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Proxy-Origin-Cache-Control")).toBeNull();
  });

  it("strips X-Frame-Options so proxied files can be embedded", async () => {
    mockUpstream("a file", { headers: { "X-Frame-Options": "SAMEORIGIN" } });
    const response = await run(
      new Request(`${PROXY}/?url=${encodeURIComponent(TARGET + "?xfo")}`),
    );
    expect(response.headers.get("X-Frame-Options")).toBeNull();
  });

  it("strips Content-Disposition so files are never forced to download", async () => {
    mockUpstream("a pdf", {
      headers: { "Content-Disposition": 'attachment; filename="x.pdf"' },
    });
    const response = await run(
      new Request(`${PROXY}/?url=${encodeURIComponent(TARGET + "?cd")}`),
    );
    expect(response.headers.get("Content-Disposition")).toBeNull();
  });

  it("preserves the origin's Content-Security-Policy (we only strip framing/download blockers)", async () => {
    mockUpstream("a page", {
      headers: { "Content-Security-Policy": "default-src 'self'" },
    });
    const response = await run(
      new Request(`${PROXY}/?url=${encodeURIComponent(TARGET + "?csp")}`),
    );
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'self'",
    );
  });

  it("mirrors the origin's Cache-Control to the client", async () => {
    mockUpstream("cached asset", {
      headers: { "Cache-Control": "max-age=600" },
    });
    const response = await run(
      new Request(
        `${PROXY}/?url=${encodeURIComponent("https://scp-wiki.wdfiles.com/local--code/x/1")}`,
      ),
    );
    expect(response.headers.get("Cache-Control")).toBe("max-age=600");
  });

  it("rejects non-wikidot hosts", async () => {
    const fetchSpy = mockUpstream();
    const response = await run(
      new Request(`${PROXY}/?url=${encodeURIComponent("https://evil.com/")}`),
    );
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects look-alike hosts", async () => {
    const response = await run(
      new Request(
        `${PROXY}/?url=${encodeURIComponent("https://wikidot.com.evil.com/")}`,
      ),
    );
    expect(response.status).toBe(400);
  });

  it("serves documentation at root when no url is given", async () => {
    const response = await run(new Request(`${PROXY}/`));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Magic proxy");
  });

  it("allows wdfiles.com targets", async () => {
    mockUpstream("a file");
    const response = await run(
      new Request(
        `${PROXY}/?url=${encodeURIComponent("https://scp-wiki.wdfiles.com/local--files/scp-173/173.jpg")}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("a file");
  });

  it("forwards the caller's User-Agent and Referer upstream", async () => {
    const fetchSpy = mockUpstream("ok");
    await run(
      new Request(`${PROXY}/?url=${encodeURIComponent(TARGET + "?c=3")}`, {
        headers: {
          "User-Agent": "CoolTool/1.0",
          Origin: "https://my-tool.example",
        },
      }),
    );
    const forwarded = fetchSpy.mock.calls[0][1].headers;
    expect(forwarded["User-Agent"]).toBe("CoolTool/1.0");
    expect(forwarded["Referer"]).toBe("https://my-tool.example");
  });

  it("refuses top-level document navigations", async () => {
    const fetchSpy = mockUpstream();
    const response = await run(
      new Request(`${PROXY}/?url=${encodeURIComponent(TARGET)}`, {
        headers: { "Sec-Fetch-Dest": "document" },
      }),
    );
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows iframe embedding of wdfiles targets", async () => {
    const fetchSpy = mockUpstream("<html>uploaded</html>");
    const response = await run(
      new Request(
        `${PROXY}/?url=${encodeURIComponent("https://scp-wiki.wdfiles.com/local--files/scp-173/embed.html")}`,
        { headers: { "Sec-Fetch-Dest": "iframe" } },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>uploaded</html>");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("allows top-level document navigation to wdfiles targets", async () => {
    const fetchSpy = mockUpstream("a pdf");
    const response = await run(
      new Request(
        `${PROXY}/?url=${encodeURIComponent("https://scp-wiki.wdfiles.com/local--files/scp-173/doc.pdf")}`,
        { headers: { "Sec-Fetch-Dest": "document" } },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("a pdf");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("still refuses iframe embedding of wikidot targets", async () => {
    const fetchSpy = mockUpstream();
    const response = await run(
      new Request(`${PROXY}/?url=${encodeURIComponent(TARGET)}`, {
        headers: { "Sec-Fetch-Dest": "iframe" },
      }),
    );
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows embedding wikidot.com file URLs (they redirect to wdfiles)", async () => {
    mockUpstream("<h1>file</h1>");
    const response = await run(
      new Request(
        `${PROXY}/?url=${encodeURIComponent("https://scp-wiki.wikidot.com/local--files/scp-001/embed.html")}`,
        { headers: { "Sec-Fetch-Dest": "iframe" } },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>file</h1>");
  });

  it("does not rate-limit wdfiles navigations (iframe embeds)", async () => {
    mockUpstream("embed");
    const response = await run(
      new Request(
        `${PROXY}/?url=${encodeURIComponent("https://scp-wiki.wdfiles.com/local--files/scp-001/twine.html")}`,
        { headers: { "Sec-Fetch-Dest": "iframe" } },
      ),
      denyLimiter,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("embed");
  });

  it("still rate-limits JS fetches", async () => {
    const fetchSpy = mockUpstream();
    const response = await run(
      new Request(`${PROXY}/?url=${encodeURIComponent(TARGET)}`),
      denyLimiter,
    );
    expect(response.status).toBe(429);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses navigations that omit Sec-Fetch (Upgrade-Insecure-Requests)", async () => {
    const fetchSpy = mockUpstream();
    const response = await run(
      new Request(`${PROXY}/?url=${encodeURIComponent(TARGET)}`, {
        headers: { "Upgrade-Insecure-Requests": "1" },
      }),
    );
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("redirects http to https (via CF-Visitor)", async () => {
    const response = await run(
      new Request(`${PROXY}/?url=${encodeURIComponent(TARGET)}`, {
        headers: { "CF-Visitor": '{"scheme":"http"}' },
      }),
    );
    expect(response.status).toBe(301);
    const location = response.headers.get("Location");
    expect(location.startsWith("https://proxy.example.com/?url=")).toBe(true);
    expect(decodeURIComponent(location)).toContain(TARGET);
  });

  it("still proxies a JS fetch (Sec-Fetch-Dest: empty)", async () => {
    mockUpstream("from js");
    const response = await run(
      new Request(`${PROXY}/?url=${encodeURIComponent(TARGET + "?x=js")}`, {
        headers: { "Sec-Fetch-Dest": "empty" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("from js");
  });

  it("serves docs on a bare navigation without proxying", async () => {
    const response = await run(
      new Request(`${PROXY}/`, { headers: { "Sec-Fetch-Dest": "document" } }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Magic proxy");
  });

  it("serves a second request from cache", async () => {
    const url = `${PROXY}/?url=${encodeURIComponent(TARGET + "?a=1")}`;
    const fetchSpy = mockUpstream("cached body");

    const first = await run(new Request(url));
    expect(first.headers.get("X-Cache")).toBe("MISS");

    const second = await run(new Request(url));
    expect(second.headers.get("X-Cache")).toBe("HIT");
    expect(await second.text()).toBe("cached body");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("no-store bypasses the cache on both read and write", async () => {
    const url = `${PROXY}/?url=${encodeURIComponent(TARGET + "?b=2")}`;
    const fetchSpy = mockUpstream("fresh");
    const headers = { "X-Proxy-Cache": "no-store" };

    await run(new Request(url, { headers }));
    await run(new Request(url, { headers }));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
