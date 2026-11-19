import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackend } from "./helpers/backend-server.mjs";

test("real HTTP schedule endpoint requires an explicit mutation workspace and keeps the CLI contract", async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "oats-schedule-http-")));
  const ws = join(temp, "workspace"); mkdirSync(join(ws, "agents"), { recursive: true });
  writeFileSync(join(ws, "oats-config.yaml"), "name: schedule-fixture\n");
  const log = join(temp, "calls.jsonl"), fake = join(temp, "oats");
  writeFileSync(fake, `#!${process.execPath}
import {appendFileSync,readFileSync} from 'node:fs';
const a=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
const result=a[0]==='schedule'?{schedules:[],scheduler:{installed:false,active:false},operation:a[1]}:a[0]==='server'?{groups:[]}:{};
console.log(JSON.stringify(a[0]==='version'?{schemaVersion:1,name:'@awebai/oats',version:'0.26.0',desktopApi:1,scheduleApi:1,features:['schedule'],remote:['schedule','roster']}:{schemaVersion:1,ok:true,result}));
`, { mode: 0o700 });
  // The extensionless fixture is explicitly ESM regardless of the temp path.
  writeFileSync(join(temp, "package.json"), '{"type":"module"}');
  // The real backend on a private socket with a fresh credential (helpers/backend-server.mjs), in a process group of its own.
  const s = await startBackend({ dirs: [ws], detached: true,
    env: { ...process.env, OATS_HOME_DIR: join(temp, ".oats"), OATS_DESKTOP_OATS_BIN: fake, PATH: "/nonexistent", SHELL: "/bin/false" } });
  const post = (path, body) => s.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const probe = await (await post("/api/cli/reprobe", {})).json();
    assert.equal(probe.scheduleApi, 1, JSON.stringify(probe));
    const read = await s.request("/api/schedules"); assert.equal(read.status, 405); assert.equal((await read.json()).code, 'E_METHOD_NOT_ALLOWED');
    // Reading and switching left this route for /api/automations (§2.3a, §3b).
    for (const operation of ['list', 'disable']) {
      const moved = await post(`/api/schedules?ws=${encodeURIComponent(ws)}`, { operation, id: 'daily' });
      assert.equal((await moved.json()).code, 'E_BAD_ARGS', operation);
    }
    for (const query of ["", "?ws=%2Fmissing"]) {
      const response = await post("/api/schedules" + query, { operation: "remove", id: "daily" });
      assert.equal(response.status, 409); assert.equal((await response.json()).code, "E_WORKSPACE_UNKNOWN");
    }
    const response = await post(`/api/schedules?ws=${encodeURIComponent(ws)}`, { operation: "remove", id: "daily" });
    assert.equal(response.status, 200); assert.equal((await response.json()).operation, "remove");
    const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(calls.filter(a => a[0] === "schedule" && a[1] === "remove"), [["schedule", "remove", "daily", "--dir", ws, "--json"]]);
    assert.equal(calls.some(a => a[0] === 'schedule' && ['list', 'show', 'disable'].includes(a[1])), false);
  } finally {
    await s.stop(); rmSync(temp, { recursive: true, force: true });
  }
});
