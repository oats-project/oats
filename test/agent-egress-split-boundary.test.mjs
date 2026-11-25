import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deploySourceCommit as sha, egressSource as source, stageEgressDeploy as stageDeploy } from "./helpers/egress-deploy-copy.mjs";
import { policyHash } from "../container/agent/egress/policy.mjs";
import { classifyProgram, tcpProgram } from "../container/agent/egress/canary.mjs";

const image = "sha256:" + "a".repeat(64), servicesAddress = "93.184.215.14";

function splitPolicy() {
  return {roles:["aweb","logs","secrets"],humanRole:"secrets",humanOrigin:"https://approve.example.invalid",frontAddress:"172.30.0.2",
    privateIngressAddresses:[],deniedAddresses:["10.20.0.11"],
    targets:Object.fromEntries(["aweb","logs","secrets"].map(role=>[role,{origin:`https://${role}.example.invalid`,addresses:[servicesAddress]}]))};
}

/** The schema-2 plan and the Docker inspect answers for its probe, proxy and
 * networks, as the deployment wrapper derives and the engine reports them. */
function splitFixture(t, mode = "bundled") {
  const dir = mkdtempSync(join(tmpdir(), "oats-split-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mounts = ["/state","/etc/agent-login","/etc/agent-ssh/authorized_keys","/etc/resolv.conf"].map((Destination,index) => {
    const Source = join(dir, "mount-" + index); writeFileSync(Source, ""); return {Type:"bind",Source,Destination,RW:index === 0};
  });
  const policy = splitPolicy();
  const HostConfig = {NetworkMode:"split_agents",Privileged:false,ReadonlyRootfs:true,CapDrop:["ALL"],SecurityOpt:["no-new-privileges:true"],PidMode:"",IpcMode:"private"};
  const probe = {Id:"probe-id",Image:image,State:{Running:true},HostConfig,Mounts:mounts,
    Config:{Image:image,User:"20001:20001",Entrypoint:["sleep"],Cmd:["infinity"],Env:[]},NetworkSettings:{Networks:{split_agents:{NetworkID:"agents-id"}}}};
  const policySource = join(dir, "policy.json"); writeFileSync(policySource, JSON.stringify(policy));
  const proxy = {Id:"proxy-id",Image:image,State:{Running:true,Health:{Status:"healthy"}},
    HostConfig:{...HostConfig,Sysctls:{"net.ipv4.ip_forward":"0"}},Mounts:[{Type:"bind",Source:policySource,Destination:"/etc/egress/policy.json",RW:false}],
    Config:{Image:image,User:"10001:10001",Entrypoint:["node"],Env:[]},
    NetworkSettings:{Networks:{split_agents:{NetworkID:"agents-id",IPAddress:policy.frontAddress},split_services:{NetworkID:"services-id"}}}};
  const responses = {};
  for (const [args, value] of [
    [["inspect","split_probe"],[probe]],[["inspect","split_proxy"],[proxy]],
    [["network","inspect","split_agents"],[{Id:"agents-id",Internal:true,EnableIPv6:false,Options:{"com.docker.network.bridge.gateway_mode_ipv4":"isolated"},IPAM:{Config:[{Gateway:"172.30.0.1"}]},Containers:{"probe-id":{},"proxy-id":{}}}]],
    [["network","inspect","split_services"],[{Id:"services-id",Internal:false,EnableIPv6:false,IPAM:{Config:[{Gateway:"172.30.1.1"}]}}]],
    [["image","inspect",image],[{Id:image,Config:{Env:[],Entrypoint:["node"]}}]],
    [["exec","split_proxy","node","-e","process.stdout.write(require('node:fs').readFileSync('/etc/egress/policy.json','utf8'))"],policy],
  ]) responses[JSON.stringify(args)] = value;
  const remoteBackends = mode === "bundled"
    ? {servicesAddress,backends:[{role:"postgres",port:5432},{role:"redis",port:6379}]}
    : {servicesAddress,backends:[{role:"redis",port:6379},{role:"postgres",port:5432,address:"10.20.0.11",external:true}]};
  const plan = {schema:2,policy,probeContainer:"split_probe",proxyContainer:"split_proxy",agentsNetwork:"split_agents",servicesNetwork:"split_services",
    probeImage:image,proxyImage:image,uid:20001,gid:20001,approvedProbeMounts:mounts,protectedSources:[join(dir,"private-key")],allowedPaths:{aweb:"/ready",logs:"/ready",secrets:"/ready"},
    remoteBackends,run:{id:"run-1",policyHash:policyHash(policy),servicesDeployment:"services-b"},namePrefix:"split-"};
  return {plan,responses,dir};
}

// Only the external Docker CLI and `ip` are doubled, at their wire contract.
// `classify(address,port)` answers each outward-bridge control.
// `loaded` is what the running proxy's /tmp/egress/policy.hash holds: the hash
// of the policy it compiled at startup, or null when the file is missing.
const loadedHashCommand = ["exec","split_proxy","node","-e","process.stdout.write(require('node:fs').readFileSync('/tmp/egress/policy.hash','utf8'))"];
function splitDocker(t, responses, { classify = () => ({stdout:"DENIED\n"}), runtime = {status:0,stdout:"OATS_EGRESS_BOUNDARY_PASS\n"},
  absent = () => true, links = [{ifname:"eth0",addr_info:[{family:"inet",local:"10.0.0.4",prefixlen:24}]}],
  loaded = policyHash(splitPolicy()) } = {}) {
  const calls = [], programs = [], original = childProcess.spawnSync;
  const ok = stdout => ({status:0,signal:null,stdout,stderr:""});
  childProcess.spawnSync = (command, args, settings) => {
    calls.push([command, ...args]);
    if (command === "ip") {
      if (JSON.stringify(args) === '["-j","-4","route","show","table","all"]') return ok("[]");
      assert.deepEqual(args, ["-j","address","show"]); return ok(JSON.stringify(links));
    }
    assert.equal(command, "docker");
    if (Object.hasOwn(responses, JSON.stringify(args))) return ok(JSON.stringify(responses[JSON.stringify(args)]));
    if (JSON.stringify(args) === JSON.stringify(loadedHashCommand))
      return loaded === null ? {status:1,signal:null,stdout:"",stderr:"ENOENT"} : ok(loaded);
    if (args[0] === "context") return ok('"unix:///var/run/docker.sock"');
    if (args[0] === "network" && args[1] === "ls") return ok("agents-id\nservices-id\n");
    if (args[0] === "network" && args[1] === "inspect") {
      assert.deepEqual(args.slice(2), ["agents-id","services-id"]);
      return ok(JSON.stringify([{IPAM:{Config:[{Subnet:"172.30.0.0/24"}]}},{IPAM:{Config:[{Subnet:"172.30.1.0/24"}]}}]));
    }
    if (args[0] === "exec" && args[1] === "-i") { programs.push(settings.input); return {signal:null,stderr:"",...runtime}; }
    if (args[0] === "run" && args[1] === "-d") return ok("canary-id\n");
    if (args[0] === "run") {
      assert.ok(args[3].startsWith("split-"));
      const program = args[args.indexOf("-e") + 1];
      if (program === tcpProgram) {
        // Upstream :443 positive controls, or the gateway canary's own controls.
        if (args.at(-1) === "tcp") assert.equal(args.at(-2), "443"); else assert.equal(args.at(-1), "canary");
        return ok("CONNECTED\n");
      }
      assert.equal(program, classifyProgram);
      assert.equal(args[args.indexOf("--network") + 1], "split_services");
      return {signal:null,stderr:"",status:0,...classify(args.at(-2), Number(args.at(-1)))};
    }
    if (args[0] === "logs") return ok("CANARY_PORT=31415\nCANARY_HIT\nCANARY_HIT\n");
    if (args[0] === "ps") return ok(absent(args[3]) ? "" : "a".repeat(12) + "\n");
    if (args[0] === "inspect") return {...ok(""),status:1};
    if (args[0] === "rm") return ok("");
    assert.fail("unexpected argv: " + JSON.stringify(args));
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawnSync = original; syncBuiltinESMExports(); });
  return {calls,programs};
}

async function stagedProbe(t) {
  const directory = stageDeploy(t);
  const module = await import(pathToFileURL(join(directory, "egress/probe-compose-boundary.mjs")).href + "?" + Math.random());
  return {directory, probeComposeBoundary: module.probeComposeBoundary};
}
function quiet(t) {
  const write = process.stderr.write, lines = [];
  process.stderr.write = line => { lines.push(String(line)); return true; };
  t.after(() => { process.stderr.write = write; });
  return lines;
}
// Each row names the address it tested: the services host, or an external
// PostgreSQL's own pinned address.
const rows = (external, outwardPostgres = "DENIED") => {
  const postgres = external ? "10.20.0.11" : servicesAddress;
  return [
    {role:"postgres",port:5432,address:postgres,vantage:"isolated-agent",result:"DENIED",required:true},
    {role:"postgres",port:5432,address:postgres,vantage:"outward-bridge",result:outwardPostgres,required:!external},
    {role:"redis",port:6379,address:servicesAddress,vantage:"isolated-agent",result:"DENIED",required:true},
    {role:"redis",port:6379,address:servicesAddress,vantage:"outward-bridge",result:"DENIED",required:true}];
};
const rowKeys = results => results.map(row => Object.keys(row).join(","));
const expectedRowKeys = Array(4).fill("role,port,address,vantage,result,required");

test("the 0e386f0f probe source refuses a schema-2 plan", t => {
  const fixture = fileURLToPath(new URL("./fixtures/egress-probe-0e386f0f/probe-compose-boundary.mjs", import.meta.url));
  const bytes = readFileSync(fixture);
  // Git's blob id for container/agent/egress/probe-compose-boundary.mjs at 0e386f0f.
  assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), "d7d8ff14a440d056412dc7fc3e8410dcf6e7590d");
  const directory = stageDeploy(t);
  copyFileSync(fixture, join(directory, "egress/probe-compose-boundary.mjs"));
  const plan = join(directory, "plan.json");
  writeFileSync(plan, JSON.stringify(splitFixture(t).plan));
  for (const flags of [[], ["--json"]]) {
    const result = childProcess.spawnSync(process.execPath, [join(directory, "egress/probe-compose-boundary.mjs"), "--plan", plan, ...flags], {encoding:"utf8",timeout:10000,env:{PATH:process.env.PATH}});
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "egress boundary: E_EGRESS_PLAN_SCHEMA: this probe reads runtime plan schema 1; found 2; regenerate the plan with schema: 1\n");
    assert.equal(result.stdout, flags.length ? JSON.stringify({passed:false,receipts:[],error:"boundary probe refused"}) + "\n" : "");
  }
});

test("split mode from a source checkout refuses with the extraction remedy before engine access", t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "oats-split-checkout-"))); t.after(() => rmSync(dir, {recursive:true,force:true}));
  const plan = join(dir, "plan.json"); writeFileSync(plan, JSON.stringify(splitFixture(t).plan));
  const result = childProcess.spawnSync(process.execPath, [join(source, "egress/probe-compose-boundary.mjs"), "--plan", plan], {encoding:"utf8",timeout:10000,env:{PATH:dir}});
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.match(result.stderr, /^egress boundary: E_EGRESS_SOURCE_MANIFEST: .*extract \/opt\/oats\/deploy from that image and run egress\/probe-compose-boundary\.mjs from the extracted copy, not from a source checkout\n$/);
});

test("a deploy copy whose listed file no longer matches its manifest refuses", async t => {
  const {directory, probeComposeBoundary} = await stagedProbe(t);
  appendFileSync(join(directory, "egress/canary.mjs"), "\n");
  const fixture = splitFixture(t);
  const double = splitDocker(t, fixture.responses);
  quiet(t);
  await assert.rejects(probeComposeBoundary(fixture.plan), error => { assert.equal(error.code, "E_EGRESS_SOURCE_MANIFEST"); return true; });
  assert.deepEqual(double.calls, []);
});

test("shared address: :443 controls succeed while PostgreSQL and Redis at that address are DENIED from both vantages", async t => {
  const {probeComposeBoundary} = await stagedProbe(t);
  const fixture = splitFixture(t);
  const double = splitDocker(t, fixture.responses);
  const lines = quiet(t);
  const result = await probeComposeBoundary(fixture.plan);
  assert.deepEqual(Object.keys(result), ["passed","mode","receipts","run","sourceCommit","remote"]);
  assert.deepEqual({...result, receipts:undefined}, {passed:true,mode:"split",receipts:undefined,run:fixture.plan.run,sourceCommit:sha,
    remote:{servicesAddress,vantage:["isolated-agent","outward-bridge"],results:rows(false)}});
  assert.deepEqual(rowKeys(result.remote.results), expectedRowKeys);
  // Two :443 controls (before and after), the gateway canary and its two controls, two outward-bridge classifications.
  assert.equal(result.receipts.length, 7);
  assert.ok(result.receipts.every(r => r.created && r.absentVerified && r.name.startsWith("split-")));
  const runs = double.calls.filter(call => call[1] === "run" && call[2] === "--rm");
  assert.deepEqual(runs.filter(call => call.includes(classifyProgram)).map(call => call.slice(-2)), [[servicesAddress,"5432"],[servicesAddress,"6379"]]);
  assert.deepEqual(runs.filter(call => call.at(-1) === "tcp").map(call => call.slice(-3, -1)), [[servicesAddress,"443"],[servicesAddress,"443"]]);
  const [program] = double.programs;
  const runtimePlan = JSON.parse(JSON.parse(program.match(/JSON\.parse\(("(?:[^"\\]|\\.)*")\)/)[1]));
  assert.deepEqual(runtimePlan.remoteEndpoints, [{role:"postgres",address:servicesAddress,port:5432},{role:"redis",address:servicesAddress,port:6379}]);
  assert.ok(!Object.hasOwn(runtimePlan, "deniedBackends"));
  assert.ok(lines.includes("egress boundary universal: PostgreSQL and Redis tuples DENIED from the isolated agent and, where required, the outward bridge\n"));
});

test("external PostgreSQL passes with the outward bridge CONNECTED, recorded as not required", async t => {
  const {probeComposeBoundary} = await stagedProbe(t);
  const fixture = splitFixture(t, "external");
  const double = splitDocker(t, fixture.responses, {classify:(address,port) => ({stdout: address === "10.20.0.11" && port === 5432 ? "CONNECTED\n" : "DENIED\n"})});
  quiet(t);
  const result = await probeComposeBoundary(fixture.plan);
  assert.deepEqual(result.remote.results, rows(true, "CONNECTED"));
  assert.deepEqual(rowKeys(result.remote.results), expectedRowKeys);
  const runtimePlan = JSON.parse(JSON.parse(double.programs[0].match(/JSON\.parse\(("(?:[^"\\]|\\.)*")\)/)[1]));
  assert.deepEqual(runtimePlan.remoteEndpoints, [{role:"postgres",address:"10.20.0.11",port:5432},{role:"redis",address:servicesAddress,port:6379}]);
});

test("an external PostgreSQL that the isolated agent reaches refuses", async t => {
  const {probeComposeBoundary} = await stagedProbe(t);
  const fixture = splitFixture(t, "external");
  splitDocker(t, fixture.responses, {runtime:{status:1,stdout:"",stderr:"egress boundary: isolated agent did not get DENIED from a services-host backend\n"}});
  quiet(t);
  await assert.rejects(probeComposeBoundary(fixture.plan), /isolated agent did not get DENIED from a services-host backend/);
});

for (const [label, answer] of [["CONNECTED", {stdout:"CONNECTED\n"}], ["ERROR", {stdout:"ERROR EACCES\n"}], ["empty output", {stdout:""}],
  ["a non-zero exit", {stdout:"DENIED\n",status:1}]]) {
  test(`bundled outward-bridge ${label} refuses`, async t => {
    const {probeComposeBoundary} = await stagedProbe(t);
    const fixture = splitFixture(t);
    const double = splitDocker(t, fixture.responses, {classify:(address,port) => port === 6379 ? answer : {stdout:"DENIED\n"}});
    quiet(t);
    await assert.rejects(probeComposeBoundary(fixture.plan), error => { assert.equal(error.receipts.length, 3); assert.ok(error.receipts.every(r => r.name.startsWith("split-"))); return true; });
    assert.deepEqual(double.programs, [], "the runtime body never runs after a refused outward-bridge control");
  });
}
test("an external PostgreSQL ERROR from the outward bridge still refuses", async t => {
  const {probeComposeBoundary} = await stagedProbe(t);
  const fixture = splitFixture(t, "external");
  splitDocker(t, fixture.responses, {classify:(address) => ({stdout: address === "10.20.0.11" ? "ERROR EACCES\n" : "DENIED\n"})});
  quiet(t);
  await assert.rejects(probeComposeBoundary(fixture.plan), /outward bridge/);
});
test("an outward-bridge control whose cleanup is unconfirmed refuses", async t => {
  const {probeComposeBoundary} = await stagedProbe(t);
  const fixture = splitFixture(t);
  let classifyName;
  const double = splitDocker(t, fixture.responses, {classify:() => ({stdout:"DENIED\n"}), absent:filter => {
    const name = filter.slice("name=^".length, -1).replaceAll("\\", "");
    const call = double.calls.find(call => call[1] === "run" && call[4] === name);
    if (call?.includes(classifyProgram)) classifyName = name;
    return !call?.includes(classifyProgram);
  }});
  quiet(t);
  await assert.rejects(probeComposeBoundary(fixture.plan), error => {
    assert.equal(error.receipts.find(r => r.name === classifyName).absentVerified, false); return true;
  });
});

for (const [label, loaded] of [["a different policy", policyHash({...splitPolicy(),deniedAddresses:[]})], ["a missing record", null],
  ["a malformed record", "sha256:not-a-hash"], ["a record with trailing data", policyHash(splitPolicy()) + "\n"]]) {
  test(`a running proxy that loaded ${label} refuses before any network control`, async t => {
    const {probeComposeBoundary} = await stagedProbe(t);
    const fixture = splitFixture(t);
    const double = splitDocker(t, fixture.responses, {loaded});
    quiet(t);
    await assert.rejects(probeComposeBoundary(fixture.plan), error => {
      assert.equal(error.message, "E_EGRESS_POLICY_STALE: the running proxy loaded a different policy than this plan; recreate the proxy, then prove again");
      assert.equal(error.code, "E_EGRESS_POLICY_STALE"); assert.deepEqual(error.receipts, []); return true;
    });
    assert.ok(double.calls.some(call => JSON.stringify(call.slice(1)) === JSON.stringify(loadedHashCommand)));
    assert.ok(!double.calls.some(call => call[1] === "run" || (call[1] === "exec" && call[2] === "-i")), "no control or runtime body runs");
  });
}
test("a passing split proof read the running proxy's loaded policy hash", async t => {
  const {probeComposeBoundary} = await stagedProbe(t);
  const fixture = splitFixture(t);
  const double = splitDocker(t, fixture.responses);
  quiet(t);
  assert.equal((await probeComposeBoundary(fixture.plan)).passed, true);
  const order = double.calls.map(call => JSON.stringify(call.slice(1)) === JSON.stringify(loadedHashCommand) ? "hash" : call[1]);
  assert.ok(order.indexOf("hash") >= 0 && order.indexOf("hash") < order.indexOf("run"), "the loaded policy is read before the first control");
});

test("split plans refuse a local services address, a second address, a hash mismatch and a schema-1 backend list", async t => {
  const {probeComposeBoundary} = await stagedProbe(t);
  quiet(t);
  const fixture = splitFixture(t);
  const cases = [
    [{remoteBackends:{...fixture.plan.remoteBackends,servicesAddress:"172.30.1.20"}}, "E_EGRESS_REMOTE_LOCAL"],
    [{remoteBackends:{...fixture.plan.remoteBackends,servicesAddress:"10.0.0.4"}}, "E_EGRESS_REMOTE_LOCAL"],
    [{remoteBackends:{...fixture.plan.remoteBackends,servicesAddress:[servicesAddress,"93.184.215.15"]}}, "E_EGRESS_REMOTE_ADDRESSES"],
    [{run:{...fixture.plan.run,policyHash:"sha256:" + "0".repeat(64)}}, "E_EGRESS_POLICY_HASH"],
  ];
  for (const [change, code] of cases) {
    const double = splitDocker(t, fixture.responses);
    await assert.rejects(probeComposeBoundary({...fixture.plan,...change}), error => { assert.equal(error.code, code); return true; });
    assert.ok(!double.calls.some(call => call[1] === "inspect" || call[1] === "run"), "refused before inspecting or creating containers");
  }
  await assert.rejects(probeComposeBoundary({...fixture.plan,deniedBackends:[]}), /plan schema 2 replaces deniedBackends with remoteBackends/);
});

test("reviewed team-image CI runs the split leg after building the egress image", async () => {
  const { parse } = await import("yaml");
  const steps = parse(readFileSync(new URL("../.github/workflows/team-image.yml", import.meta.url), "utf8")).jobs.verify.steps;
  const build = steps.findIndex(step => step.run?.includes("--file container/agent/egress/Dockerfile"));
  const leg = steps.findIndex(step => /agent-egress-boundary-image\.py "\$EGRESS_IMAGE" "\$AGENT_IMAGE" split$/.test(step.run?.trim() ?? ""));
  assert.ok(build >= 0 && leg > build);
  const script = readFileSync(new URL("./agent-egress-boundary-image.py", import.meta.url), "utf8");
  assert.match(script, /docker\("cp", container \+ ":\/opt\/oats\/deploy", str\(deploy\)\)/, "the split leg runs the extracted deploy copy");
  assert.match(script, /json\.dumps\(policy, sort_keys=True, separators=\(",", ":"\), ensure_ascii=False\)/, "the leg hashes the policy as other languages do");
  for (const mutant of ["local services address", "published port", "non-local listener", "stale proxy policy"])
    assert.ok(script.includes(`print("PASS ${mutant} mutant", flush=True)`), `the split leg runs the ${mutant} mutant`);
});
