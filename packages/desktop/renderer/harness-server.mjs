#!/usr/bin/env node
/* oats desktop — dev harness server (NOT part of the app).
   Serves the renderer directory and proxies /api/* to a running backend
   server over its socket, so the harness page is same-origin with the API.

     node packages/desktop/renderer/harness-server.mjs [--port 4899] --api-socket <path> --token-file <path>

   The backend's credential (--token-file, the file the backend itself was
   started with) stays in this process: the browser never sees it. At start
   the harness makes a token of its own and prints the page's URL with it,
   `http://127.0.0.1:<port>/harness.html#t=<token>`; every /api/ request must
   carry it as `x-oats-harness-token`, besides the loopback Host/Origin guard,
   else 401 and nothing reaches the backend. The harness then sends the
   request over the socket with the backend's credential and only the headers
   the backend needs (method, content-type, origin, a fixed host). Static
   files need no token; the credential file is never served, and must not lie
   inside any directory the harness serves.

   Exports createHarnessServer so tests can exercise the security boundary
   behaviorally (started only when run as a script, below). */
import { createServer, request as httpRequest } from "node:http";
import { readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };
/** The directories the harness serves files from. */
export const STATIC_ROOTS = Object.freeze([HERE, join(HERE, "..", "node_modules"), join(HERE, "..", "..", "client")]);
export const HARNESS_TOKEN_HEADER = "x-oats-harness-token";

const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
const tokenMatches = (given, expected) => {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given, "utf8"), b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};
/** Whether `file`'s real path lies inside one of `roots` (each taken by its real path). */
export function insideRoots(file, roots = STATIC_ROOTS) {
  let real; try { real = realpathSync(file); } catch { return false; }
  return roots.some((root) => { let r; try { r = realpathSync(root); } catch { return false; } return real === r || real.startsWith(r + sep); });
}

/**
 * @param {object} o
 * @param {string} o.apiSocket      the backend's socket
 * @param {string} o.secret         the backend's credential (never sent to the browser)
 * @param {string} o.harnessToken   the token the page sends as x-oats-harness-token
 * @param {{ dev: number, ino: number } | null} [o.secretFile]  the credential file's identity: never served
 */
export function createHarnessServer({ apiSocket, secret, harnessToken, secretFile = null }) {
  return createServer((req, res) => {
    // Same Host/Origin guard as the backend itself: the harness can reach
    // mutating endpoints upstream, so a page resolving to 127.0.0.1 must be
    // rejected HERE — never launder a forged origin into a trusted one.
    const okHost = (h) => h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
    const host = String(req.headers.host || "").replace(/:\d+$/, "");
    let originOk = true;
    if (req.headers.origin !== undefined) {
      try { originOk = okHost(new URL(String(req.headers.origin)).hostname); } catch { originOk = false; }
    }
    if (!okHost(host) || !originOk) return json(res, 403, { error: "forbidden origin" });
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { return json(res, 400, { error: "malformed request target" }); }
    if (url.pathname.startsWith("/api/")) {
      if (!tokenMatches(req.headers[HARNESS_TOKEN_HEADER], harnessToken)) return json(res, 401, { error: "unauthorized", code: "E_UNAUTHORIZED" });
      // Only what the backend needs: never the browser's own authorization or the harness token.
      const headers = { host: "localhost", authorization: `Bearer ${secret}` };
      if (req.headers["content-type"] !== undefined) headers["content-type"] = String(req.headers["content-type"]);
      if (req.headers.origin !== undefined) headers.origin = String(req.headers.origin);
      let p;
      try {
        p = httpRequest({ socketPath: apiSocket, path: url.pathname + url.search, method: req.method, headers }, (up) => {
          const out = {};
          for (const name of ["content-type", "cache-control"]) if (up.headers[name] !== undefined) out[name] = up.headers[name];
          res.writeHead(up.statusCode, out); up.pipe(res);
        });
      } catch { return json(res, 400, { error: "malformed request" }); }
      p.on("error", () => { if (!res.headersSent) json(res, 502, { error: "backend unreachable" }); else res.destroy(); });
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
    let st; try { st = statSync(file); } catch { res.writeHead(404); res.end("not found"); return; }
    if (!st.isFile()) { res.writeHead(404); res.end("not found"); return; }
    // The credential file, whatever name reaches it (a link, a hard link), is never served.
    if (secretFile && st.dev === secretFile.dev && st.ino === secretFile.ino) return json(res, 403, { error: "forbidden" });
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "content-type": `${TYPES[ext] || "application/octet-stream"}; charset=utf-8`, "cache-control": "no-store" });
    res.end(readFileSync(file));
  });
}

// script mode: `node harness-server.mjs [--port n] --api-socket <path> --token-file <path>`
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { readSecretFile, StartupRefusal } = await import("../server/request-checks.mjs");
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
  };
  const refuse = (message) => { console.error(`harness: ${message}`); process.exit(1); };
  const port = Number(flag("port", 4899));
  const apiSocket = flag("api-socket"), tokenFile = flag("token-file");
  if (args.includes("--api")) refuse("--api is gone: pass --api-socket <path> --token-file <path>");
  if (!apiSocket || !tokenFile) refuse("--api-socket <path> and --token-file <path> are required");
  if (insideRoots(tokenFile)) refuse("--token-file must not be inside a directory the harness serves");
  let secret, secretFile;
  try {
    ({ secret, identity: secretFile } = readSecretFile(tokenFile));
  } catch (e) { refuse(e instanceof StartupRefusal ? e.message : "--token-file: cannot read the token file"); }
  const harnessToken = randomBytes(32).toString("base64url");
  createHarnessServer({ apiSocket, secret, harnessToken, secretFile }).listen(port, "127.0.0.1", () => {
    console.log(`harness at http://127.0.0.1:${port}/harness.html#t=${harnessToken}`);
  });
}
