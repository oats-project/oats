import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { TEST_CONTROL_TOKEN } from "./helpers/control-auth.mjs";
import { createHarnessServer } from "../renderer/harness-server.mjs";

// The harness page resolves marked/dompurify via /node_modules/* — the route
// must serve browser-ready ESM and stay traversal-guarded.
test("harness-server: serves renderer files and /node_modules ESM, guards traversal", async () => {
  const server = createHarnessServer(new URL("http://127.0.0.1:1"), TEST_CONTROL_TOKEN); // api unused here
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
