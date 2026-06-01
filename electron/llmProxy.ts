import { randomBytes } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from "node:http";
import { request as httpsRequest } from "node:https";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";

// RFC 7230 §6.1 hop-by-hop headers: meaningful only for a single transport
// connection, so a proxy must not forward them in either direction. Stripping
// `transfer-encoding`/`connection` also lets Node manage response framing,
// which is what makes SSE streams pass through cleanly.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

export type LlmProxy = {
  /** Loopback URL to hand the agent as `ANTHROPIC_BASE_URL`. */
  baseUrl: string;
  /** Disposable per-run token the agent sends as `x-api-key`. */
  token: string;
  stop(): Promise<void>;
};

export type CreateLlmProxyOptions = {
  /** Resolves the real Anthropic key at request time (may change in Settings). */
  getApiKey: () => string | undefined;
  /** Upstream origin; defaults to the Anthropic API. Overridden in tests. */
  upstreamOrigin?: string;
};

function filterHeaders(
  headers: IncomingHttpHeaders,
  drop: (lowerName: string) => boolean,
): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || drop(lower)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * A loopback HTTP proxy that holds the real BYOK key and exposes only a
 * disposable token to the agent subprocess. Requests authenticate with the
 * token (sent as `x-api-key`); the proxy swaps in the real key and forwards to
 * a single fixed upstream, so it can never be turned into an open relay.
 */
export function createLlmProxy(opts: CreateLlmProxyOptions): Promise<LlmProxy> {
  const upstream = new URL(opts.upstreamOrigin ?? DEFAULT_UPSTREAM);
  const token = randomBytes(32).toString("hex");
  const sendUpstream = upstream.protocol === "http:" ? httpRequest : httpsRequest;
  const upstreamPort = upstream.port || (upstream.protocol === "http:" ? "80" : "443");

  const server: Server = createServer((req, res) => {
    if (req.headers["x-api-key"] !== token) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { type: "authentication_error", message: "invalid token" } }),
      );
      return;
    }

    const apiKey = opts.getApiKey();
    if (!apiKey) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "api_error", message: "no api key available" } }));
      return;
    }

    const headers = filterHeaders(
      req.headers,
      (name) => name === "authorization" || name === "x-api-key" || name === "host",
    );
    headers["x-api-key"] = apiKey;
    headers["host"] = upstream.host;

    const upstreamReq = sendUpstream(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          filterHeaders(upstreamRes.headers, () => false),
        );
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on("error", (err) => {
      if (res.headersSent || res.writableEnded || res.destroyed) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { type: "api_error", message: `upstream error: ${err.message}` } }),
      );
    });
    // The agent connection dropping must surface as a handled `req`/`res` error
    // (an unhandled stream 'error' is thrown and would crash main), and must
    // tear down the in-flight upstream request rather than leave it dangling.
    req.on("error", () => upstreamReq.destroy());
    res.on("error", () => upstreamReq.destroy());
    res.on("close", () => {
      if (!res.writableEnded) upstreamReq.destroy();
    });
    req.pipe(upstreamReq);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("llm proxy failed to bind a loopback port"));
        return;
      }
      server.removeListener("error", reject);
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        token,
        // closeAllConnections() forcibly shuts open keep-alive/streaming sockets
        // so close()'s callback fires promptly. Without it, close() waits for
        // every connection to drain, which hangs app quit if a turn is mid-stream.
        stop: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

let active: LlmProxy | null = null;

export async function startLlmProxy(opts: CreateLlmProxyOptions): Promise<LlmProxy> {
  if (!active) active = await createLlmProxy(opts);
  return active;
}

export function getLlmProxy(): LlmProxy {
  if (!active) throw new Error("llm proxy not started");
  return active;
}

export async function stopLlmProxy(): Promise<void> {
  const proxy = active;
  active = null;
  if (proxy) await proxy.stop();
}
