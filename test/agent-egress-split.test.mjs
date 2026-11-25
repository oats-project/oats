import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { policyHash } from "../container/agent/egress/policy.mjs";
import { classifyProgram, tcpClassify, tcpFromNetwork } from "../container/agent/egress/canary.mjs";

// The cross-language vector from the split-host spec. It exercises the hash
// helper only; it is not a valid compilePolicy input.
const vectorPolicy = {"schema":1,"humanOrigin":"https://approve.example.invalid","frontAddress":"172.30.0.2","privateIngressAddresses":[],"deniedAddresses":["10.20.0.11"],"targets":{"signer":{"origin":"https://prepare.example.invalid","addresses":["203.0.113.10"]},"aweb":{"origin":"https://aweb.example.invalid","addresses":["203.0.113.10"]}},"note":"é "};

test("policyHash matches the pinned cross-language vector", () => {
  assert.equal(policyHash(vectorPolicy), "sha256:89ccf024cd7fc89c045b95339895dc3f044eb248cf09159cdb876d787055b5d4");
});

test("policyHash sorts keys recursively, keeps array order and ignores declaration order", () => {
  assert.equal(policyHash({b:[2,1],a:{d:null,c:true}}), policyHash({a:{c:true,d:null},b:[2,1]}));
  assert.notEqual(policyHash({b:[2,1]}), policyHash({b:[1,2]}));
});

test("policyHash refuses values that are not portable JSON", () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [undefined, {a:undefined}, [()=>1], {a:NaN}, {a:Infinity}, {a:1.5}, {a:2**53}, {"é":1},
    {a:"\ud800"}, {a:1n}, {a:Symbol("s")}, {a:new Date(0)}, {a:new Map()}, cyclic]) {
    assert.throws(() => policyHash(value), /policyHash/, String(value?.a ?? value));
  }
});

test("tcpClassify reads a live listener as CONNECTED and refusal or silence as DENIED", async t => {
  const { createServer } = await import("node:net");
  const server = createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  assert.equal(await tcpClassify("127.0.0.1", port), "CONNECTED");
  server.close(); await new Promise(resolve => server.once("close", resolve));
  assert.equal(await tcpClassify("127.0.0.1", port), "DENIED");
  // An unrouted private address either times out or is unreachable: both deny.
  assert.equal(await tcpClassify("10.255.255.1", 9, { timeoutMs: 200 }), "DENIED");
  await assert.rejects(tcpClassify("not-an-ip", 1), /invalid probe endpoint/);
  await assert.rejects(tcpClassify("127.0.0.1", 0), /invalid probe endpoint/);
});

test("the classify canary program prints exactly one tri-state line", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", classifyProgram, "127.0.0.1", "1"], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "DENIED\n");
});

// Only the external Docker CLI is doubled: one classify run, then the exact
// absence observation. `run` holds the container's stdout and exit status.
function classifyDocker(t, { stdout = "DENIED\n", status = 0, absent = true } = {}) {
  const calls = [], original = childProcess.spawnSync;
  const ok = out => ({ status: 0, signal: null, stdout: out, stderr: "" });
  childProcess.spawnSync = (command, args) => {
    calls.push(args);
    assert.equal(command, "docker");
    if (args[0] === "run") {
      assert.equal(args[1], "--rm"); assert.equal(args.at(-3), classifyProgram);
      return { ...ok(stdout), status };
    }
    if (args[0] === "ps") return ok(absent ? "" : "a".repeat(12) + "\n");
    if (args[0] === "inspect") return { ...ok(""), status: 1 };
    assert.fail("unexpected Docker argv: " + JSON.stringify(args));
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawnSync = original; syncBuiltinESMExports(); });
  return calls;
}
const classifyOptions = { image: "sha256:" + "a".repeat(64), network: "fixture_services", address: "192.0.2.10", port: 5432, classify: true };

for (const line of ["CONNECTED", "DENIED", "ERROR EACCES"]) test(`classify mode returns ${line} with a verified receipt`, t => {
  const calls = classifyDocker(t, { stdout: line + "\n" });
  const { result, receipt } = tcpFromNetwork(classifyOptions);
  assert.equal(result, line);
  assert.equal(receipt.created, true); assert.equal(receipt.absentVerified, true);
  assert.deepEqual(calls[0].slice(-2), ["192.0.2.10", "5432"]);
});
for (const [label, mode] of [["empty output", { stdout: "" }], ["unexpected output", { stdout: "DENIED\nCONNECTED\n" }],
  ["a lowercase line", { stdout: "denied\n" }], ["a non-zero exit", { stdout: "DENIED\n", status: 1 }],
  ["an unconfirmed cleanup", { absent: false }]]) test(`classify mode refuses ${label}`, t => {
  classifyDocker(t, mode);
  assert.throws(() => tcpFromNetwork(classifyOptions), error => { assert.equal(error.receipts.length, 1); return true; });
});
