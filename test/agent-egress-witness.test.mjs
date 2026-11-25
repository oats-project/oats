import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { policyHash } from "../container/agent/egress/policy.mjs";
import { classifyProgram } from "../container/agent/egress/canary.mjs";
import { deploySourceCommit, egressSource, stageEgressDeploy } from "./helpers/egress-deploy-copy.mjs";

const image = "sha256:" + "c".repeat(64), servicesAddress = "93.184.215.14";
const policy = {roles:["aweb"],frontAddress:"172.30.0.2",privateIngressAddresses:[],deniedAddresses:[],
  targets:{aweb:{origin:"https://aweb.example.invalid",addresses:[servicesAddress]}}};

function witnessPlan(mode = "bundled") {
  return {schema:1,run:{id:"run-1",policyHash:policyHash(policy),servicesDeployment:"services-b"},servicesAddress,composeProject:"services-b",policy,
    backends:[...(mode === "bundled" ? [{role:"postgres",service:"db",port:5432}] : []),{role:"redis",service:"cache",port:6379}],
    canaryImage:image,namePrefix:"witness-"};
}
/** The fields the witness's inspect template selects, for a clean backend. */
const hexId = (service, fill) => Buffer.from(service).toString("hex").padEnd(64, fill);
function backend(service, port, address) {
  return {Id:hexId(service,"0"),Image:"sha256:"+hexId(service,"1"),ConfigImage:service+":16",Project:"services-b",Service:service,
    ExposedPorts:{[port+"/tcp"]:{}},Status:"running",Health:"healthy",NetworkMode:"services-b_default",PortBindings:{},
    Ports:{[port+"/tcp"]:null},Networks:{"services-b_default":{IPAddress:address,Gateway:"172.40.0.1"}}};
}

// Only the external Docker CLI and `ip` are doubled, at their wire contract.
function witnessDocker(t, { containers, matches = {}, classify = () => "CONNECTED\n", links = [{ifname:"eth0",addr_info:[{family:"inet",local:"10.0.0.9",prefixlen:24}]}] }) {
  const calls = [], original = childProcess.spawnSync;
  const ok = stdout => ({status:0,signal:null,stdout,stderr:""});
  childProcess.spawnSync = (command, args) => {
    calls.push([command, ...args]);
    if (command === "ip") {
      if (JSON.stringify(args) === '["-j","-4","route","show","table","all"]') return ok("[]");
      assert.deepEqual(args, ["-j","address","show"]); return ok(JSON.stringify(links));
    }
    assert.equal(command, "docker");
    if (args[0] === "context") return ok('"unix:///var/run/docker.sock"');
    if (args[0] === "version") { assert.deepEqual(args, ["version","--format","{{.Server.Version}}"]); return ok("28.0.4\n"); }
    if (args[0] === "network" && args[1] === "ls") return ok("");
    if (args[0] === "ps" && args[1] === "--no-trunc") {
      assert.equal(args.length, 8);
      assert.equal(args[3], "label=com.docker.compose.project=services-b"); assert.deepEqual(args.slice(6), ["--format","{{.ID}}"]);
      const service = args[5].slice("label=com.docker.compose.service=".length);
      return ok((matches[service] ?? (containers[service] ? [containers[service].Id] : [])).map(id => id + "\n").join(""));
    }
    if (args[0] === "inspect" && args[1] === "--format") {
      assert.doesNotMatch(args[2], /Env|Log|Cmd|Mounts/, "the witness never reads environment, logs, commands or mounts");
      const found = Object.values(containers).find(item => item.Id === args[3]);
      assert.ok(found); return ok(JSON.stringify(found) + "\n");
    }
    if (args[0] === "run") {
      assert.equal(args[1], "--rm"); assert.ok(args[3].startsWith("witness-"));
      assert.equal(args[args.indexOf("-e") + 1], classifyProgram); assert.equal(args[args.indexOf("--entrypoint") + 2], image);
      return ok(classify(args[args.indexOf("--network") + 1], args.at(-2), Number(args.at(-1))));
    }
    if (args[0] === "ps") return ok("");
    if (args[0] === "inspect") return {...ok(""),status:1};
    assert.fail("unexpected argv: " + JSON.stringify(args));
  };
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawnSync = original; syncBuiltinESMExports(); });
  return calls;
}
const clean = () => ({db:backend("db",5432,"172.40.0.3"),cache:backend("cache",6379,"172.40.0.4")});

async function stagedWitness(t) {
  const directory = stageEgressDeploy(t);
  const module = await import(pathToFileURL(join(directory, "egress/probe-services-backends.mjs")).href + "?" + Math.random());
  const write = process.stderr.write, lines = [];
  process.stderr.write = line => { lines.push(String(line)); return true; };
  t.after(() => { process.stderr.write = write; });
  return {directory, lines, probeServicesBackends: module.probeServicesBackends};
}
const record = (role, service, port, address) => ({role,service,containerId:hexId(service,"0"),image:service+":16",imageId:"sha256:"+hexId(service,"1"),
  networks:["services-b_default"],port,health:"healthy",published:false,control:"CONNECTED"});

test("the witness passes the clean bundled case with its pinned JSON shape", async t => {
  const {probeServicesBackends, lines} = await stagedWitness(t);
  const calls = witnessDocker(t, {containers:clean()});
  const result = await probeServicesBackends(witnessPlan());
  assert.deepEqual(Object.keys(result), ["passed","run","sourceCommit","servicesAddress","canaryImage","observed","backends","receipts"]);
  assert.deepEqual({...result,receipts:undefined}, {passed:true,run:witnessPlan().run,sourceCommit:deploySourceCommit,servicesAddress,canaryImage:image,
    observed:{composeProject:"services-b",hostAddresses:["10.0.0.9"],addressOnHost:false,engineVersion:"28.0.4"},
    backends:[record("postgres","db",5432),record("redis","cache",6379)],receipts:undefined});
  assert.equal(result.receipts.length, 2); assert.ok(result.receipts.every(r => r.created && r.absentVerified && r.network === "services-b_default"));
  assert.deepEqual(calls.filter(call => call[1] === "run").map(call => call.slice(-2)), [["172.40.0.3","5432"],["172.40.0.4","6379"]]);
  assert.equal(lines.filter(line => line.startsWith("services witness receipt: ")).length, 2);
});

test("a redis-only witness passes for an external PostgreSQL, and a NAT'd address is only observed", async t => {
  const {probeServicesBackends} = await stagedWitness(t);
  witnessDocker(t, {containers:{cache:clean().cache}, links:[{ifname:"eth0",addr_info:[{family:"inet",local:servicesAddress,prefixlen:24},{family:"inet6",local:"fe80::1",prefixlen:64}]}]});
  const result = await probeServicesBackends(witnessPlan("external"));
  assert.deepEqual(result.backends, [record("redis","cache",6379)]);
  assert.deepEqual(result.observed, {composeProject:"services-b",hostAddresses:[servicesAddress],addressOnHost:true,engineVersion:"28.0.4"});
});

test("a backend on several networks needs CONNECTED from each of them", async t => {
  const {probeServicesBackends} = await stagedWitness(t);
  const containers = clean();
  containers.cache.Networks["services-b_cache"] = {IPAddress:"172.41.0.4"};
  const calls = witnessDocker(t, {containers, classify:network => network === "services-b_cache" ? "DENIED\n" : "CONNECTED\n"});
  await assert.rejects(probeServicesBackends(witnessPlan()), /backend control from its own network was not CONNECTED/);
  assert.deepEqual(calls.filter(call => call[1] === "run").map(call => call.slice(-2)), [["172.40.0.3","5432"],["172.40.0.4","6379"],["172.41.0.4","6379"]]);
});

test("a port Compose records without a protocol is exposed as TCP, as Docker reads it", async t => {
  const {probeServicesBackends} = await stagedWitness(t);
  // Compose 2.38 writes expose: ["6379"] as ExposedPorts {"6379":{}}; the engine maps it to 6379/tcp.
  const containers = clean(); containers.cache.ExposedPorts = {"6379":{}};
  witnessDocker(t, {containers});
  assert.equal((await probeServicesBackends(witnessPlan())).passed, true);
  containers.cache.ExposedPorts = {"6379/udp":{}};
  await assert.rejects(probeServicesBackends(witnessPlan()), /does not expose its declared port/);
});

const refusals = [
  ["no container matching a role's project and service", {matches:{cache:[]}},
    /^exactly one running container labelled services-b\/cache is required for redis; found 0$/],
  ["more than one matching container", {matches:{cache:["a".repeat(64),"b".repeat(64)]}},
    /^exactly one running container labelled services-b\/cache is required for redis; found 2$/],
  ["a published port binding", {change:c => { c.cache.PortBindings = {"6379/tcp":[{HostIp:"",HostPort:"6379"}]}; }}, /publishes a port/],
  ["a published port in the live port map", {change:c => { c.cache.Ports = {"6379/tcp":[{HostIp:"0.0.0.0",HostPort:"32768"}]}; }}, /publishes a port/],
  ["host network mode", {change:c => { c.cache.NetworkMode = "host"; c.cache.Networks = {host:{IPAddress:""}}; }}, /host network mode/],
  ["a container network mode", {change:c => { c.cache.NetworkMode = "container:abc"; c.cache.Networks = {}; }}, /own network/],
  ["an unhealthy container", {change:c => { c.db.Health = "unhealthy"; }}, /^postgres must be running and healthy$/],
  ["a container without a healthcheck", {change:c => { c.db.Health = null; }}, /^postgres has no healthcheck; add one to its Compose service$/],
  ["a container that is not running", {change:c => { c.db.Status = "paused"; }}, /^postgres must be running and healthy$/],
  ["an unexposed port", {change:c => { c.db.ExposedPorts = {"5433/tcp":{}}; }}, /does not expose its declared port/],
  ["labels that differ from the selection", {change:c => { c.db.Project = "other"; }},
    /^exactly one running container labelled services-b\/db is required for postgres; found 0$/],
  ["a DENIED control", {classify:() => "DENIED\n"}, /not CONNECTED/],
  ["an ERROR control", {classify:() => "ERROR EACCES\n"}, /not CONNECTED/],
];
for (const [label, mode, pattern] of refusals) test(`the witness refuses ${label}`, async t => {
  const {probeServicesBackends} = await stagedWitness(t);
  const containers = clean(); mode.change?.(containers);
  witnessDocker(t, {containers, matches:mode.matches, classify:mode.classify});
  await assert.rejects(probeServicesBackends(witnessPlan()), error => { assert.match(error.message, pattern); return true; });
});

test("the witness refuses a policy hash mismatch, an inventory other than [redis] or [postgres, redis] and other plan schemas", async t => {
  const {probeServicesBackends} = await stagedWitness(t);
  const calls = witnessDocker(t, {containers:clean()});
  const plan = witnessPlan();
  await assert.rejects(probeServicesBackends({...plan,policy:{...policy,deniedAddresses:["10.20.0.11"]}}), error => { assert.equal(error.code,"E_EGRESS_POLICY_HASH"); return true; });
  for (const backends of [[plan.backends[0]], [plan.backends[1],plan.backends[1]], [], [...plan.backends,{role:"postgres",service:"db2",port:5432}],
    [{...plan.backends[0],port:0},plan.backends[1]], [{...plan.backends[0],service:"bad name"},plan.backends[1]]])
    await assert.rejects(probeServicesBackends({...plan,backends}), /witness backends must be exactly/);
  for (const change of [{composeProject:"Services"}, {canaryImage:"node:22"}, {servicesAddress:"not-ip"}, {extra:1}, {namePrefix:"x"}])
    await assert.rejects(probeServicesBackends({...plan,...change}), /witness plan|prefix/);
  for (const [schema, found] of [[undefined,"none"],[2,"2"],["1","invalid string"]])
    await assert.rejects(probeServicesBackends({...plan,schema}), error => {
      assert.equal(error.message, `E_EGRESS_PLAN_SCHEMA: this witness reads plan schema 1; found ${found}; regenerate the plan with schema: 1`); return true; });
  assert.ok(!calls.some(call => call[1] === "ps" || call[1] === "inspect" || call[1] === "run"), "plan refusals precede container access");
});

test("the witness CLI prints refusal JSON and the extraction remedy when run from a source checkout", t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "oats-witness-checkout-"))); t.after(() => rmSync(dir, {recursive:true,force:true}));
  const plan = join(dir, "plan.json"); writeFileSync(plan, JSON.stringify(witnessPlan()));
  for (const flags of [[], ["--json"]]) {
    const result = childProcess.spawnSync(process.execPath, [join(egressSource, "egress/probe-services-backends.mjs"), "--plan", plan, ...flags], {encoding:"utf8",timeout:10000,env:{PATH:dir}});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^services witness: E_EGRESS_SOURCE_MANIFEST: .*run egress\/probe-services-backends\.mjs from the extracted copy, not from a source checkout\n$/);
    assert.equal(result.stdout, flags.length ? JSON.stringify({passed:false,receipts:[],error:"services witness refused"}) + "\n" : "");
  }
});

test("the witness CLI writes the pass token or the full JSON from an extracted copy", t => {
  const directory = stageEgressDeploy(t), plan = join(directory, "witness.json");
  writeFileSync(plan, JSON.stringify(witnessPlan("external")));
  const preload = join(directory, "double.mjs");
  writeFileSync(preload, `import assert from "node:assert/strict";import childProcess from "node:child_process";import {syncBuiltinESMExports} from "node:module";`
    + `import {classifyProgram} from ${JSON.stringify(pathToFileURL(join(directory, "egress/canary.mjs")).href)};`
    + `const image=${JSON.stringify(image)};` + witnessDocker.toString()
    + `\nwitnessDocker({after:()=>{}},{containers:{cache:${JSON.stringify(clean().cache)}}});`);
  for (const flags of [[], ["--json"]]) {
    const result = childProcess.spawnSync(process.execPath, ["--import", preload, join(directory, "egress/probe-services-backends.mjs"), "--plan", plan, ...flags], {encoding:"utf8",timeout:10000,env:{PATH:directory}});
    assert.equal(result.status, 0, result.stderr);
    if (flags.length) { const out = JSON.parse(result.stdout); assert.equal(out.passed, true); assert.deepEqual(out.backends, [record("redis","cache",6379)]); }
    else assert.equal(result.stdout, "OATS_SERVICES_WITNESS_PASS\n");
  }
});
