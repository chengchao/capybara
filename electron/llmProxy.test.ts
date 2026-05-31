import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";

import { createLlmProxy, type LlmProxy } from "./llmProxy";

const REAL_KEY = "sk-ant-real-secret";

type Upstream = {
  origin: string;
  /** x-api-key seen on the most recent request that reached the upstream. */
  lastApiKey: string | undefined;
  hits: number;
  stop(): Promise<void>;
};

/** A fake Anthropic that records the key it received and replies per handler. */
function startUpstream(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<Upstream> {
  const state = { lastApiKey: undefined as string | undefined, hits: 0 };
  const server: Server = createServer((req, res) => {
    state.hits += 1;
    const key = req.headers["x-api-key"];
    state.lastApiKey = Array.isArray(key) ? key[0] : key;
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("upstream bind failed");
      resolve({
        origin: `http://127.0.0.1:${addr.port}`,
        get lastApiKey() {
          return state.lastApiKey;
        },
        get hits() {
          return state.hits;
        },
        stop: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function withProxy(
  upstream: Upstream,
  getApiKey: () => string | undefined = () => REAL_KEY,
): Promise<LlmProxy> {
  const proxy = await createLlmProxy({ getApiKey, upstreamOrigin: upstream.origin });
  cleanups.push(() => proxy.stop());
  return proxy;
}

test("swaps the token for the real key and passes status + body through", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  cleanups.push(() => upstream.stop());
  const proxy = await withProxy(upstream);

  const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": proxy.token, "content-type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [] }),
  });

  expect(resp.status).toBe(200);
  expect(await resp.json()).toEqual({ ok: true });
  // The agent never sent the real key; the proxy injected it.
  expect(upstream.lastApiKey).toBe(REAL_KEY);
});

test("rejects a wrong token with 401 and never reaches the upstream", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200);
    res.end("should not happen");
  });
  cleanups.push(() => upstream.stop());
  const proxy = await withProxy(upstream);

  const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": "not-the-token" },
  });

  expect(resp.status).toBe(401);
  expect(upstream.hits).toBe(0);
});

test("returns 503 when no key is available", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200);
    res.end("should not happen");
  });
  cleanups.push(() => upstream.stop());
  const proxy = await withProxy(upstream, () => undefined);

  const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": proxy.token },
  });

  expect(resp.status).toBe(503);
  expect(upstream.hits).toBe(0);
});

test("stop() resolves promptly even with an in-flight streaming connection", async () => {
  let upstreamRes: import("node:http").ServerResponse | undefined;
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: open\ndata: 1\n\n");
    upstreamRes = res; // deliberately never end → the connection stays open
  });
  cleanups.push(() => {
    try {
      upstreamRes?.destroy();
    } catch {
      // already gone
    }
  });
  cleanups.push(() => upstream.stop());
  const proxy = await withProxy(upstream);

  const controller = new AbortController();
  const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": proxy.token },
    signal: controller.signal,
  });
  expect(resp.status).toBe(200);

  // closeAllConnections() makes this resolve promptly; without it server.close()
  // would block on the open connection and the race below would time out.
  const outcome = await Promise.race([
    proxy.stop().then(() => "stopped"),
    new Promise((r) => setTimeout(() => r("timeout"), 2000)),
  ]);
  expect(outcome).toBe("stopped");

  controller.abort();
  await resp.body?.cancel().catch(() => {});
});

test("streams a chunked SSE response straight through", async () => {
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("event: a\ndata: 1\n\n");
    res.write("event: b\ndata: 2\n\n");
    res.end();
  });
  cleanups.push(() => upstream.stop());
  const proxy = await withProxy(upstream);

  const resp = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": proxy.token },
  });

  expect(resp.headers.get("content-type")).toBe("text/event-stream");
  expect(await resp.text()).toBe("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
});
