import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createHarnessServer, HARNESS_TOKEN_HEADER } from "../renderer/harness-server.mjs";
import { backendSecret, privateSocketDir, startBackend } from "./helpers/backend-server.mjs";
import { NO_CLI_ENV } from "../scripts/smoke-probes.mjs";

// The harness page resolves marked/dompurify via /node_modules/* — the route
// must serve browser-ready ESM and stay traversal-guarded.
test("harness-server: serves renderer files and /node_modules ESM, guards traversal", async () => {
  const server = createHarnessServer({ apiSocket: "/nonexistent/s", secret: backendSecret(), harnessToken: "t" }); // api unused here
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const get = (p, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers });
  try {
    assert.equal((await get("/")).status, 200, "harness page serves");
    assert.equal((await get("/views/markdown.mjs")).status, 200, "view module serves");
    assert.equal((await get("/identity-marks.mjs")).status, 200, "identity component serves");
    const colors = await get("/client/soul-colors.mjs");
    assert.equal(colors.status, 200, "the pure color module serves from the shared home, where identity-marks.mjs imports it");
    assert.match(await colors.text(), /export const SOUL_COLORS/);
    const marked = await get("/node_modules/marked/lib/marked.esm.js");
    assert.equal(marked.status, 200, "marked ESM serves through /node_modules");
    assert.ok((marked.headers.get("content-type") || "").includes("text/javascript"), "ESM content-type");
    assert.equal((await get("/node_modules/dompurify/dist/purify.es.mjs")).status, 200, "dompurify ESM serves");
    assert.equal((await get("/node_modules/%2e%2e/package.json")).status, 404, "encoded traversal out of node_modules rejected");
    assert.equal((await get("/%2e%2e/package.json")).status, 404, "encoded traversal out of renderer rejected");
    // Renderer modules import the shared home (packages/client) as ../../client/x.mjs, or one more
    // ../ from views/. The renderer is this server's root, so a browser clamps both to /client/x.mjs.
    for (const [specifier, from] of [["../../../client/remote-address.mjs", "/views/common.mjs"], ["../../client/deployment-contract.mjs", "/shell.mjs"]]) {
      assert.ok((await (await get(from)).text()).includes(`from "${specifier}"`), `${from} imports ${specifier}`);
      const shared = new URL(specifier, `http://127.0.0.1:${port}${from}`);
      assert.equal(shared.pathname, `/client/${specifier.split("/").at(-1)}`);
      const moved = await get(shared.pathname);
      assert.equal(moved.status, 200, `${shared.pathname} serves from the shared home`);
      assert.ok((moved.headers.get("content-type") || "").includes("text/javascript"), "ESM content-type");
    }
    assert.match(await (await get("/client/harness-names.mjs")).text(), /export const HARNESSES/);
    assert.equal((await get("/client/%2e%2e/desktop/package.json")).status, 404, "encoded traversal out of the shared home rejected");
    assert.equal((await get("/client/absent.mjs")).status, 404, "a module the shared home does not have");
    // fetch cannot forge Host — raw request for the rebinding case
    const hostile = await new Promise((resolve, reject) => {
      const rq = httpRequest({ host: "127.0.0.1", port, path: "/", headers: { host: "evil.example" } }, (rs) => resolve(rs.statusCode));
      rq.on("error", reject); rq.end();
    });
    assert.equal(hostile, 403, "hostile Host rejected");
  } finally { server.close(); }
});

/* ── A11: the harness's own token, and the backend's credential kept from the browser ── */
const HARNESS = fileURLToPath(new URL("../renderer/harness-server.mjs", import.meta.url));
/** A stand-in backend on a private socket: records each request's method, path and headers. */
async function fakeBackend(t) {
  const socket = privateSocketDir(); const seen = [];
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); res.writeHead(200, { "content-type": "application/json", "x-backend-extra": "1" }); res.end('{"answered":true}'); });
  });
  await new Promise((ok) => server.listen(socket.socketPath, ok));
  t.after(() => { server.close(); socket.remove(); });
  return { socketPath: socket.socketPath, seen };
}
async function harness(t, apiSocket, secret, options = {}) {
  const harnessToken = backendSecret();
  const server = createHarnessServer({ apiSocket, secret, harnessToken, ...options });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = server.address().port;
  const raw = (path, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const rq = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (rs) => {
      let text = ""; rs.on("data", (c) => { text += c; }); rs.on("end", () => resolve({ status: rs.statusCode, headers: rs.headers, text }));
    });
    rq.on("error", reject); if (body !== undefined) rq.write(body); rq.end();
  });
  return { harnessToken, port, raw };
}

test("A11: /api/ without the harness token is 401 and nothing reaches the backend", async (t) => {
  const backend = await fakeBackend(t), secret = backendSecret();
  const h = await harness(t, backend.socketPath, secret);
  for (const headers of [{}, { [HARNESS_TOKEN_HEADER]: "wrong" }, { [HARNESS_TOKEN_HEADER]: `${h.harnessToken}x` }, { authorization: `Bearer ${secret}` }]) {
    const r = await h.raw("/api/cli", { headers });
    assert.equal(r.status, 401, JSON.stringify(headers));
  }
  assert.equal((await h.raw("/api/cli/reprobe", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status, 401);
  assert.equal(backend.seen.length, 0);
});

test("A11: with the token, the request is proxied with the backend secret and only the headers it needs", async (t) => {
  const backend = await fakeBackend(t), secret = backendSecret();
  const h = await harness(t, backend.socketPath, secret);
  const r = await h.raw("/api/cli/reprobe?x=1", { method: "POST", body: "{}", headers: { [HARNESS_TOKEN_HEADER]: h.harnessToken, "content-type": "application/json",
    origin: `http://127.0.0.1:${h.port}`, authorization: "Bearer the-browsers-own", cookie: "c=1", "x-other": "y" } });
  assert.equal(r.status, 200);
  assert.equal(r.text, '{"answered":true}');
  assert.equal(backend.seen.length, 1);
  const [sent] = backend.seen;
  assert.equal(sent.method, "POST"); assert.equal(sent.url, "/api/cli/reprobe?x=1"); assert.equal(sent.body, "{}");
  assert.equal(sent.headers.authorization, `Bearer ${secret}`, "the backend secret, not the browser's authorization");
  assert.equal(sent.headers.host, "localhost");
  assert.equal(sent.headers["content-type"], "application/json");
  assert.equal(sent.headers.origin, `http://127.0.0.1:${h.port}`);
  for (const name of [HARNESS_TOKEN_HEADER, "cookie", "x-other"]) assert.equal(sent.headers[name], undefined, `${name} is not forwarded`);
  assert.equal(r.headers["x-backend-extra"], undefined, "only the response headers the page needs");
});

test("A11: the backend secret appears in no harness response or page", async (t) => {
  const backend = await fakeBackend(t), secret = backendSecret();
  const h = await harness(t, backend.socketPath, secret);
  const answers = await Promise.all([h.raw("/"), h.raw("/harness.html"), h.raw("/api/cli"), h.raw("/api/cli", { headers: { [HARNESS_TOKEN_HEADER]: h.harnessToken } }),
    h.raw("//"), h.raw("/no-such-file")]);
  for (const r of answers) assert.equal(`${JSON.stringify(r.headers)}${r.text}`.includes(secret), false);
});

test("A11: a malformed target is a 400, static and /api/ alike, and the harness keeps serving", async (t) => {
  const backend = await fakeBackend(t);
  const h = await harness(t, backend.socketPath, backendSecret());
  for (const path of ["//", "http://[/api/x", "http://[::1/x"]) assert.equal((await h.raw(path)).status, 400, path);
  assert.equal((await h.raw("/harness.html")).status, 200, "still serving");
  assert.equal(backend.seen.length, 0);
});

test("A11: the static handler refuses the credential file's inode, whatever path names it", async (t) => {
  const backend = await fakeBackend(t);
  const page = fileURLToPath(new URL("../renderer/harness.html", import.meta.url));
  const st = statSync(page);
  const h = await harness(t, backend.socketPath, backendSecret(), { secretFile: { dev: st.dev, ino: st.ino } });
  const r = await h.raw("/harness.html");
  assert.equal(r.status, 403);
  assert.equal(r.text.includes("<html"), false, "no content");
});

/** Run the harness as a script; resolves its first stdout line, or its exit. */
async function script(t, args) {
  const child = spawn(process.execPath, [HARNESS, "--port", "0", ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...NO_CLI_ENV } });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => { stdout += d; }); child.stderr.on("data", (d) => { stderr += d; });
  const exited = once(child, "exit").then(([code]) => ({ code }));
  for (let n = 0; !stdout.includes("\n"); n++) {
    const done = await Promise.race([exited, new Promise((ok) => setTimeout(() => ok(null), 25))]);
    if (done) return { ...done, stdout, stderr };
    if (n > 400) throw new Error(`harness neither started nor exited: ${stderr}`);
  }
  return { code: null, stdout, stderr };
}

test("A11: a token file inside a directory the harness serves refuses the start", async (t) => {
  const secret = backendSecret();
  for (const dir of [fileURLToPath(new URL("../renderer/", import.meta.url)), fileURLToPath(new URL("../../client/", import.meta.url))]) {
    const file = join(dir, `.oats-t-token-${process.pid}`);
    writeFileSync(file, `${secret}\n`, { mode: 0o600 });
    try {
      const r = await script(t, ["--api-socket", "/nonexistent/s", "--token-file", file]);
      assert.notEqual(r.code, 0, `${dir}: refused`);
      assert.equal(r.code === null, false, `${dir}: it exited`);
      assert.match(r.stderr, /--token-file/);
      assert.equal(`${r.stdout}${r.stderr}`.includes(secret), false);
    } finally { rmSync(file, { force: true }); }
  }
});

test("A11: end to end, the harness script reaches the real backend over its socket, and prints its own URL", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "oats-t-harness-")); chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, "token");
  const backend = await startBackend({ env: { ...process.env, ...NO_CLI_ENV }, tokenFile });
  t.after(() => backend.stop());
  const r = await script(t, ["--api-socket", backend.socketPath, "--token-file", tokenFile]);
  const m = /^harness at http:\/\/127\.0\.0\.1:(\d+)\/harness\.html#t=([A-Za-z0-9_-]{43})\n/.exec(r.stdout);
  assert.ok(m, r.stdout + r.stderr);
  assert.equal(r.stdout.includes(backend.secret), false, "the backend secret is not printed");
  const ask = (headers) => fetch(`http://127.0.0.1:${m[1]}/api/version`, { headers });
  assert.equal((await ask({})).status, 401);
  const ok = await ask({ [HARNESS_TOKEN_HEADER]: m[2] });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).capability, "@awebai/oats-desktop");
});
