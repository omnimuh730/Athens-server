const BFF_BASE = (process.env.AGENT_BFF_URL || "http://127.0.0.1:8780").replace(/\/$/, "");

/** Map Athens /api/agents/* paths to agent-bff /api/* paths. */
function mapBffPath(reqPath) {
  if (reqPath === "/health") return "/api/health";
  if (reqPath === "/dashboard") return "/api/dashboard";
  if (reqPath === "/deploy") return "/api/deploy";
  if (reqPath === "/activity") return "/api/activity";
  if (reqPath === "/job-sources") return "/api/job-sources";
  if (reqPath === "/jobs") return "/api/jobs";
  if (reqPath === "/models") return "/api/models";
  if (reqPath === "/runs") return "/api/runs";
  if (/^\/stream\//.test(reqPath)) return `/api${reqPath}`;
  if (/^\/runs\/[^/]+\/(events|resume|screenshots)/.test(reqPath)) return `/api${reqPath}`;
  return `/api${reqPath}`;
}

function buildUpstreamUrl(req) {
  const mapped = mapBffPath(req.path);
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return `${BFF_BASE}${mapped}${query}`;
}

function forwardResponseHeaders(upstream, res, extra = {}) {
  const out = { ...extra };
  const ct = upstream.headers.get("content-type");
  if (ct) out["Content-Type"] = ct;
  const cc = upstream.headers.get("cache-control");
  if (cc) out["Cache-Control"] = cc;
  return out;
}

/** Proxy JSON/binary/SSE requests to agent-bff. */
export async function proxyToAgentBff(req, res) {
  const url = buildUpstreamUrl(req);
  const headers = {};
  if (req.method !== "GET" && req.method !== "HEAD") {
    headers["Content-Type"] = "application/json";
  }

  let upstream;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? JSON.stringify(req.body ?? {}) : undefined,
    });
  } catch (err) {
    return res.status(502).json({
      success: false,
      error: `Agent BFF unreachable at ${BFF_BASE}. Start codex/agent-bff (npm run dev).`,
      detail: err?.message || String(err),
    });
  }

  const contentType = upstream.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream") && upstream.body) {
    res.writeHead(upstream.status, forwardResponseHeaders(upstream, res, {
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    }));
    const { Readable } = await import("node:stream");
    Readable.fromWeb(upstream.body).pipe(res);
    return;
  }

  if (contentType.includes("image/") && upstream.body) {
    res.writeHead(upstream.status, forwardResponseHeaders(upstream, res));
    const { Readable } = await import("node:stream");
    Readable.fromWeb(upstream.body).pipe(res);
    return;
  }

  const text = await upstream.text();
  res.status(upstream.status);
  if (contentType) res.set("Content-Type", contentType);
  return res.send(text);
}
