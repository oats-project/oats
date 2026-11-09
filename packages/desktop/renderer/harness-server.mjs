#!/usr/bin/env node
/* Development renderer host and API proxy. It validates its own browser origin
   and keeps the backend control token in this server process.

   node harness-server.mjs [--port 4899] [--api http://127.0.0.1:4820]
   OATS_DESKTOP_TOKEN must match the backend's token. */
import { createServer, request as httpRequest } from "node:http";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTROL_TOKEN_HEADER, controlRequestHeaders, loopbackHost } from "../control-request.mjs";
import { requireControlToken, takeControlToken } from "../control-token.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };

export function createHarnessServer(api, token) {
  requireControlToken(token);
  api = new URL(api);
  if (api.protocol !== "http:" || !loopbackHost({ host: api.host }) || api.username || api.password || api.pathname !== "/" || api.search || api.hash)
    throw new Error("harness backend must be a loopback HTTP origin");
  const server = createServer((req, res) => {
    const headers = controlRequestHeaders(req);
    const deny = () => { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "forbidden" })); };
    // Accept the bound port under the loopback names used by a browser.
    const port = server.address()?.port;
    const hostOk = typeof headers.host === "string" && ["127.0.0.1", "localhost", "[::1]"].some(host =>
      headers.host === `${host}:${port}` || port === 80 && headers.host === host);
    if (!hostOk || !loopbackHost(headers) || headers.origin !== undefined &&
      (typeof headers.origin !== "string" || headers.origin !== `http://${headers.host}`)) return deny();
    let url;
    try { url = new URL(req.url, "http://localhost"); }
    catch { res.writeHead(400); res.end("bad request"); return; }
    if (url.pathname.startsWith("/api/")) {
      // The harness has checked the browser origin. Only this process supplies the backend header.
      const forwarded = { ...req.headers, host: api.host, [CONTROL_TOKEN_HEADER]: token };
      delete forwarded.origin;
      const p = httpRequest({
        hostname: api.hostname.replace(/^\[|\]$/g, ""), port: api.port, path: url.pathname + url.search,
        method: req.method, headers: forwarded,
      }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
      p.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "backend unavailable" }));
      });
      req.pipe(p);
      return;
    }
    // static files: the renderer dir, plus /node_modules/* pinned to the
    // package's node_modules (browser-ready ESM deps — marked, dompurify —
    // resolve through the importmap; still traversal-guarded), plus /client/*
    // pinned to the shared home (packages/client). The renderer is this
    // server's root, so a module's `../../client/x.mjs` cannot climb above it:
    // the browser clamps it to /client/x.mjs, which is served from there.
    const NM = join(HERE, "..", "node_modules");
    const CLIENT = join(HERE, "..", "..", "client");
    const mount = [["/node_modules", NM], ["/client", CLIENT]].find(([prefix]) => url.pathname.startsWith(`${prefix}/`));
    const base = mount ? mount[1] : HERE;
    const rel = url.pathname === "/" ? "/harness.html" : mount ? url.pathname.slice(mount[0].length) : url.pathname;
    const file = normalize(join(base, rel));
    if (!(file === base || file.startsWith(base + sep)) || !existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "content-type": `${TYPES[ext] || "application/octet-stream"}; charset=utf-8`, "cache-control": "no-store" });
    res.end(readFileSync(file));
  });
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  return server;
}

// script mode: `node harness-server.mjs [--port n] [--api url]`
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let token;
  try { token = takeControlToken(process.env); }
  catch (error) { console.error(`oats-desktop harness: ${error.message}`); process.exit(1); }
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const port = Number(flag("port", 4899));
  const api = new URL(flag("api", "http://127.0.0.1:4820"));
  createHarnessServer(api, token).listen(port, "127.0.0.1", () => {
    console.log(`harness at http://127.0.0.1:${port}/  (API proxied to ${api.origin})`);
  });
}
