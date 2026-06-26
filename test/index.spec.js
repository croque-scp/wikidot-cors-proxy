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

async function run(request) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

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
    expect(await response.text()).toContain("CORS + caching proxy");
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
    expect(await response.text()).toContain("CORS + caching proxy");
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
