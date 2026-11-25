import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { compilePolicy, policyHash } from "../container/agent/egress/policy.mjs";
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

// The in-container body with doubled kernel/network observations, as in
// agent-egress.test.mjs; the services-host tuples are outside deniedAddresses.
function runtimeCase() {
  const policy = {roles:["aweb"],frontAddress:"172.30.0.2",privateIngressAddresses:[],deniedAddresses:[],
    targets:{aweb:{origin:"https://aweb.example.invalid",addresses:["93.184.215.14"]}}};
  const plan = {policy,uid:20001,gid:20001,allowedPaths:{aweb:"/ready"},gateway:{address:"10.20.0.1",port:40000},
    remoteEndpoints:[{role:"postgres",address:"93.184.215.14",port:5432},{role:"redis",address:"93.184.215.14",port:6379}]};
  const classified = [];
  const io = {
    identity:()=>({uid:20001,gid:20001}),
    fs:{readdirSync:()=>[],readFileSync:path=>path==="/etc/resolv.conf"?"nameserver 172.30.0.2\n":"CapEff:\t0000000000000000\nNoNewPrivs:\t1\n",existsSync:()=>false},
    resolver:{setServers:()=>{},resolve4:async host=>{
      if(host==="aweb.example.invalid")return["172.30.0.2"];
      throw Object.assign(new Error("NXDOMAIN"),{code:"ENOTFOUND"});
    }},
    getStatus:async()=>200,tlsReachable:async()=>false,tcpReachable:async()=>false,
    tcpClassify:async(address,port)=>{classified.push(address+":"+port);return "DENIED";},
  };
  return {plan,io,classified};
}

test("the runtime body checks schema-2 tuples DENIED without requiring deniedAddresses membership", async () => {
  const {probeRuntime} = await import("../container/agent/egress/probe-runtime.mjs");
  const {plan,io,classified} = runtimeCase();
  assert.equal(await probeRuntime(plan,io),true);
  assert.deepEqual(classified,["93.184.215.14:5432","93.184.215.14:6379"]);
  for (const answer of ["CONNECTED","ERROR EACCES","","denied"])
    await assert.rejects(probeRuntime(plan,{...io,tcpClassify:async()=>answer}),/isolated agent did not get DENIED from a services-host backend/);
  for (const remoteEndpoints of [[], [plan.remoteEndpoints[0]], [plan.remoteEndpoints[0],{...plan.remoteEndpoints[0]}],
    [plan.remoteEndpoints[0],{...plan.remoteEndpoints[1],address:"not-ip"}], [plan.remoteEndpoints[0],{...plan.remoteEndpoints[1],port:0}]])
    await assert.rejects(probeRuntime({...plan,remoteEndpoints},io),/remote backend endpoint inventory is invalid/);
  await assert.rejects(probeRuntime({...plan,deniedBackends:plan.remoteEndpoints},io),/exactly one backend inventory/);
});

test("the emitted runtime program carries the classify body for schema-2 tuples", async () => {
  const {runtimeProgram} = await import("../container/agent/egress/probe-runtime.mjs");
  const {plan} = runtimeCase();
  const program = runtimeProgram(plan);
  assert.match(program,/const tcpClassify=\(async function tcpClassify/);
  assert.match(program,/remoteEndpoints/);
});

// ---- Split-host plan admission (pure) ----
const servicesAddress = "93.184.215.14";
function splitPolicy() {
  return {roles:["aweb","logs","secrets"],humanRole:"secrets",humanOrigin:"https://approve.example.invalid",frontAddress:"172.30.0.2",
    privateIngressAddresses:[],deniedAddresses:["10.20.0.11"],
    targets:Object.fromEntries(["aweb","logs","secrets"].map(role=>[role,{origin:`https://${role}.example.invalid`,addresses:[servicesAddress]}]))};
}
function remote(mode = "bundled") {
  return {servicesAddress, backends: mode === "bundled"
    ? [{role:"postgres",port:5432},{role:"redis",port:6379}]
    : [{role:"redis",port:6379},{role:"postgres",port:5432,address:"10.20.0.11",external:true}]};
}
const observed = {
  networks:[{IPAM:{Config:[{Subnet:"172.30.0.0/24"},{Subnet:"fd00::/64"}]}},{IPAM:{Config:null},Driver:"host"}],
  links:[{ifname:"eth0",addr_info:[{family:"inet",local:"10.0.0.4",prefixlen:24},{family:"inet6",local:"fe80::1",prefixlen:64}]}],
};
const codeOf = code => error => { assert.equal(error.code, code, error.message); assert.ok(error.message.startsWith(code + ": ")); return true; };

test("a shared front address compiles and yields per-port tuples, never an IP-wide deny", async () => {
  const { admitRemoteBackends } = await import("../container/agent/egress/split.mjs");
  const policy = splitPolicy();
  compilePolicy(policy);
  assert.ok(!policy.deniedAddresses.includes(servicesAddress));
  assert.deepEqual(admitRemoteBackends(remote(), policy, observed), {servicesAddress, tuples:[
    {role:"postgres",address:servicesAddress,port:5432,external:false},{role:"redis",address:servicesAddress,port:6379,external:false}]});
  assert.deepEqual(admitRemoteBackends(remote("external"), policy, observed).tuples, [
    {role:"postgres",address:"10.20.0.11",port:5432,external:true},{role:"redis",address:servicesAddress,port:6379,external:false}]);
  // A services host in the agent host's own interface prefix is legitimate.
  assert.doesNotThrow(() => admitRemoteBackends({...remote(),servicesAddress:"10.0.0.5"}, {...policy,targets:{...policy.targets}}, observed));
});

test("split mode v1 takes exactly one services-host address", async () => {
  const { admitRemoteBackends } = await import("../container/agent/egress/split.mjs");
  const policy = splitPolicy();
  for (const value of [[remote(),remote()], {...remote(),servicesAddress:[servicesAddress,"93.184.215.15"]},
    {...remote(),servicesAddress:[servicesAddress]}, {...remote(),servicesAddress:[]}, {...remote(),servicesAddress:42},
    {...remote(),servicesAddress:null}, {...remote(),servicesAddress:{}},
    {...remote(),backends:[{role:"postgres",port:5432},{role:"redis",port:6379,address:"93.184.215.15"}]},
    {...remote(),backends:[{role:"postgres",port:5432,address:"10.20.0.11",external:false},{role:"redis",port:6379}]},
    {...remote(),backends:[{role:"postgres",port:5432,address:"10.20.0.11",external:"yes"},{role:"redis",port:6379}]}])
    assert.throws(() => admitRemoteBackends(value, policy, observed), codeOf("E_EGRESS_REMOTE_ADDRESSES"));
});

test("an address inside a Docker subnet or equal to an agent-host interface address is local", async () => {
  const { admitRemoteBackends } = await import("../container/agent/egress/split.mjs");
  const policy = splitPolicy();
  for (const address of ["172.30.0.9","10.0.0.4"]) {
    assert.throws(() => admitRemoteBackends({...remote(),servicesAddress:address}, policy, observed), codeOf("E_EGRESS_REMOTE_LOCAL"));
    const external = remote("external"); external.backends[1].address = address;
    assert.throws(() => admitRemoteBackends(external, {...policy,deniedAddresses:[address]}, observed), codeOf("E_EGRESS_REMOTE_LOCAL"));
  }
});

test("an external database address must be denied IP-wide, distinct and never a target", async () => {
  const { admitRemoteBackends } = await import("../container/agent/egress/split.mjs");
  const policy = splitPolicy();
  const external = address => { const value = remote("external"); value.backends[1].address = address; return value; };
  assert.throws(() => admitRemoteBackends(external(servicesAddress), policy, observed), codeOf("E_EGRESS_EXTERNAL_DB_TARGET"));
  assert.throws(() => admitRemoteBackends(external("93.184.215.20"), policy, observed), codeOf("E_EGRESS_EXTERNAL_DB_DENIED"));
  const otherServices = {...external("10.20.0.11"),servicesAddress:"10.20.0.11"};
  assert.throws(() => admitRemoteBackends(otherServices, policy, observed), codeOf("E_EGRESS_EXTERNAL_DB_DENIED"));
});

test("remote backend inventories other than postgres plus redis refuse", async () => {
  const { admitRemoteBackends } = await import("../container/agent/egress/split.mjs");
  const policy = splitPolicy();
  for (const backends of [[], [{role:"redis",port:6379}], [{role:"redis",port:6379},{role:"redis",port:6380}],
    [{role:"postgres",port:0},{role:"redis",port:6379}], [{role:"postgres",port:5432,extra:1},{role:"redis",port:6379}],
    [{role:"postgres",port:5432},{role:"redis",port:6379,external:true,address:"10.20.0.11"}]])
    assert.throws(() => admitRemoteBackends({servicesAddress,backends}, policy, observed), /remote backend inventory/);
  assert.throws(() => admitRemoteBackends({servicesAddress:"not-ip",backends:remote().backends}, policy, observed), /services-host address must be one IPv4/);
});

test("the run binding requires the recomputed policy hash and bounded identifiers", async () => {
  const { admitRun } = await import("../container/agent/egress/split.mjs");
  const policy = splitPolicy(), run = {id:"run-2026.11.24:1",policyHash:policyHash(policy),servicesDeployment:"services-b"};
  assert.deepEqual(admitRun(run, policy), run);
  assert.throws(() => admitRun({...run,policyHash:policyHash({...policy,deniedAddresses:[]})}, policy), codeOf("E_EGRESS_POLICY_HASH"));
  for (const bad of [undefined, {...run,extra:1}, {...run,id:""}, {...run,id:"a b"}, {...run,id:"x".repeat(129)},
    {...run,servicesDeployment:7}, {...run,policyHash:"sha256:ABC"}])
    assert.throws(() => admitRun(bad, policy), /run binding is invalid/);
});
