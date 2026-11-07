import { TEST_CONTROL_TOKEN, controlFetch as fetch } from './helpers/control-auth.mjs';
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

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
  const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const proc = spawn(process.execPath, [fileURLToPath(new URL("../server/oats-web.mjs", import.meta.url)), "start", "--port", String(port), "--dir", ws], {
    detached: true, stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, OATS_DESKTOP_TOKEN: TEST_CONTROL_TOKEN, OATS_HOME_DIR: join(temp, ".oats"), OATS_DESKTOP_OATS_BIN: fake, PATH: "/nonexistent", SHELL: "/bin/false" },
  });
  let stderr = ""; proc.stderr.on("data", data => { stderr += data; });
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    let ready = false;
    for (let n = 0; n < 50; n++) {
      try { ready = (await fetch(base + "/api/version")).ok; if (ready) break; } catch { /* startup */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready, stderr);
    const probe = await (await post("/api/cli/reprobe", {})).json();
    assert.equal(probe.scheduleApi, 1, JSON.stringify(probe));
    const read = await fetch(base + "/api/schedules"); assert.equal(read.status, 405); assert.equal((await read.json()).code, 'E_METHOD_NOT_ALLOWED');
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
    const exited = proc.exitCode !== null || proc.signalCode !== null ? Promise.resolve() : once(proc, "exit");
    try { process.kill(-proc.pid, "SIGTERM"); } catch { /* already stopped */ }
    await exited; rmSync(temp, { recursive: true, force: true });
  }
});
