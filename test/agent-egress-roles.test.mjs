import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { compilePolicy, policyRoles } from "../container/agent/egress/policy.mjs";
import { spawnSync } from "node:child_process";
import { probeProxy } from "../container/agent/egress/health.mjs";
import { probeRuntime, runtimeProgram } from "../container/agent/egress/probe-runtime.mjs";

const full = () => JSON.parse(readFileSync(new URL("../container/agent/egress/README.md", import.meta.url), "utf8").match(/```json\n([\s\S]*?)\n```/)[1]);
function subset(roles = ["aweb", "registry"]) {
  const policy = full();
  policy.roles = roles;
  policy.targets = Object.fromEntries(roles.map(role => [role, policy.targets[role]]));
  if (!roles.includes("signer")) delete policy.humanOrigin;
  if (!roles.includes("registry")) delete policy.authorityRecords;
  return policy;
}

test("legacy compilation stays byte identical and explicit full roles use the same order", () => {
  const policy = full(), compiled = compilePolicy(policy);
  assert.equal(createHash("sha256").update(JSON.stringify(compiled)).digest("hex"), "5ea593b96ea1fd0fc17166f59931f8579b6869b77a54c282b2d9b7c97fa322d4");
  assert.deepEqual(compilePolicy({ ...policy, roles: ["registry", "signer", "logs", "aweb", "secrets"] }), compiled);
});

test("all nonempty declared subsets compile only their actual services", () => {
  const names = ["aweb", "logs", "registry", "secrets", "signer"];
  for (let mask = 1; mask < 32; mask++) {
    const roles = names.filter((_, index) => mask & (1 << index)), policy = subset(roles);
    const compiled = compilePolicy(policy);
    for (const role of names) {
      const host = new URL(full().targets[role].origin).hostname;
      assert.equal(compiled.zone.includes(host + ". 30 IN A"), roles.includes(role));
      assert.equal(compiled.nginx.includes('"' + host + '"'), roles.includes(role));
    }
  }
});

test("missing, unknown, duplicate and extra roles or role-specific fields are refused", () => {
  for (const change of [
    p => { p.roles = []; }, p => { p.roles = null; }, p => { p.roles = "aweb"; },
    p => { p.roles.push("aweb"); }, p => { p.roles.push("unknown"); },
    p => { p.roles.push("logs"); }, p => { delete p.targets.aweb; },
    p => { p.targets.logs = full().targets.logs; }, p => { delete p.roles; },
    p => { p.targets = []; }, p => { p.humanOrigin = full().humanOrigin; },
  ]) {
    const policy = subset(); change(policy);
    assert.throws(() => compilePolicy(policy), /egress policy/);
  }
  for (const [key,roles] of [["humanOrigin",["signer"]],["authorityRecords",["registry"]]]) {
    const policy = subset(roles); delete policy[key];
    assert.throws(() => compilePolicy(policy), /egress policy/);
  }
  for (const roles of [["aweb"],["signer"]])
    assert.throws(()=>compilePolicy({...subset(roles),authorityRecords:full().authorityRecords}),/egress policy/);
});

test("registry requires provisioned TXT records independently of signer", () => {
  for (const roles of [["registry"],["aweb","registry"],["aweb","registry","secrets"]]) {
    const policy=subset(roles),compiled=compilePolicy(policy);
    assert.ok(compiled.zone.includes('_awid.team.example.invalid. 30 IN TXT "awid=v1;'));
    for (const records of [undefined,[],null,[{...policy.authorityRecords[0],text:"not an AWID record"}]]) {
      const invalid={...policy,authorityRecords:records};
      if (records===undefined)delete invalid.authorityRecords;
      assert.throws(()=>compilePolicy(invalid),/egress policy/);
    }
  }
});

test("health works without aweb and without invented signer fields", async () => {
  const policy = subset(["registry"]);
  assert.equal(await probeProxy({ policy, connect: async () => {}, resolve4: async host => {
    if (host === "registry.example.invalid") return [policy.frontAddress];
    throw Object.assign(new Error("not listed"), { code: "ENOTFOUND" });
  } }), true);
});

function runtime(policy = subset()) {
  const calls = { https: [], tls: [], tcp: [], dns: [], txt: [] };
  const plan = { policy, uid: 20001, gid: 20001,
    allowedPaths: Object.fromEntries(Object.keys(policy.targets).map(role => [role, "/ready"])),
    deniedBackends: [{role:"postgres",address:"10.20.0.11",port:5432},{role:"redis",address:"10.20.0.12",port:6379}],
    gateway: { address: "172.30.0.1", port: 40000 } };
  const io = {
    identity: () => ({ uid: 20001, gid: 20001 }),
    fs: { readdirSync: () => [], existsSync: () => false, readFileSync: path => path === "/etc/resolv.conf"
      ? "nameserver 172.30.0.2\n" : "CapEff:\t0000000000000000\nNoNewPrivs:\t1\n" },
    resolver: { setServers: () => {}, resolve4: async host => {
      calls.dns.push(host);
      if (Object.values(policy.targets).some(target => new URL(target.origin).hostname === host)) return [policy.frontAddress];
      throw Object.assign(new Error("not listed"), { code: "ENOTFOUND" });
    }, resolveTxt: async host => {
      calls.txt.push(host);
      return policy.authorityRecords.filter(record => record.name === host).map(record => [record.text]);
    } },
    getStatus: async options => { calls.https.push(options); return 200; },
    tlsReachable: async options => { calls.tls.push(options); return false; },
    tcpReachable: async (address, port) => { calls.tcp.push([address, port]); return false; },
  };
  return { plan, io, calls };
}

test("ingress names the signer requirement before sending any controls", async () => {
  const {probeIngress}=await import("../container/agent/egress/probe-ingress.mjs");
  let sent=0;
  await assert.rejects(probeIngress({
    address:"10.20.0.10",requestOrigin:full().targets.signer.origin,humanOrigin:full().humanOrigin,
    policy:subset(),routeLogs:{},exchange:async()=>{sent++;throw new Error("no control may be sent");},
  }),{code:"ERR_ASSERTION",message:/^ingress admission requires the signer role/});
  assert.equal(sent,0);
});

test("runtime follows the compiler's canonical role order for reversed declarations", async () => {
  for (const roles of [["registry","aweb"],Object.keys(full().targets).reverse()]) {
    const {plan,io,calls}=runtime(subset(roles));
    assert.equal(await probeRuntime(plan,io),true);
    assert.deepEqual(calls.https.map(options=>options.host),
      policyRoles(plan.policy).map(role=>new URL(plan.policy.targets[role].origin).hostname));
  }
});

test("emitted runtime executes the shared role helper before its real identity guard", () => {
  const {plan}=runtime(subset(["registry","aweb"]));
  // Fail before any filesystem/network probes on this host. A missing emitted
  // dependency would be refused as an incomplete runtime policy before this guard.
  plan.uid=process.getuid()===20001?20002:20001;
  const result=spawnSync(process.execPath,["--input-type=module","-"],{
    input:runtimeProgram(plan),encoding:"utf8",timeout:5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status,1);
  assert.equal(result.stdout,"");
  assert.equal(result.stderr,"egress boundary: probe identity differs from configured non-root user\n");
});

test("shared runtime role validation still refuses malformed declarations before probing", async () => {
  const {plan,io}=runtime();
  const sparse=["aweb"];sparse.length=2;
  for (const roles of [null,"aweb",["unknown"],["aweb","aweb"],sparse])
    await assert.rejects(probeRuntime({...plan,policy:{...plan.policy,roles}},io),{
      name:"BoundaryFailure",message:"runtime policy is incomplete",
    });
});

test("runtime derives role controls but always probes unlisted TLS/DNS, backends and gateway", async () => {
  for (const roles of [["aweb"], ["signer"], ["aweb", "registry"], ["aweb", "registry", "secrets"], ["registry"], Object.keys(full().targets)]) {
    const {plan,io,calls} = runtime(subset(roles));
    assert.equal(await probeRuntime(plan, io), true);
    assert.equal(calls.https.length, roles.length);
    assert.deepEqual(calls.txt,(plan.policy.authorityRecords??[]).map(record=>record.name));
    assert.ok(calls.dns.some(host => /^denied-.*\.invalid$/.test(host)));
    assert.ok(calls.tls.some(options => /^denied-.*\.invalid$/.test(options.host)));
    assert.ok(calls.tcp.some(([ip, port]) => ip === plan.gateway.address && port === plan.gateway.port));
    assert.ok(calls.tcp.some(([ip, port]) => ip === "10.20.0.11" && port === 5432));
    assert.ok(calls.tcp.some(([ip, port]) => ip === "10.20.0.12" && port === 6379));
    assert.match(runtimeProgram(plan), /OATS_EGRESS_BOUNDARY_PASS/);
  }
});

test("registry runtime refuses missing or incorrect authority TXT evidence", async () => {
  for (const roles of [["aweb","registry"],["aweb","registry","secrets"]]) {
    const {plan,io}=runtime(subset(roles));
    assert.equal(await probeRuntime(plan,io),true);
    for (const answer of [[],[["awid=v1; controller=wrong; registry=https://elsewhere.invalid;"]]])
      await assert.rejects(probeRuntime(plan,{...io,resolver:{...io.resolver,resolveTxt:async()=>answer}}),/namespace authority differs/);
    await assert.rejects(probeRuntime(plan,{...io,resolver:{...io.resolver,resolveTxt:async()=>{
      throw Object.assign(new Error("missing TXT"),{code:"ENOTFOUND"});
    }}}),/namespace authority lookup failed/);
    for (const records of [undefined,[]])
      await assert.rejects(probeRuntime({...plan,policy:{...plan.policy,authorityRecords:records}},io),/namespace authority/);
  }
});

test("subset cannot drop universal controls or add an undeclared allowed path", async () => {
  const {plan,io} = runtime();
  await assert.rejects(probeRuntime(plan, {...io,tlsReachable:async()=>true}), /TLS.*reachable/);
  await assert.rejects(probeRuntime(plan, {...io,tcpReachable:async()=>true}), /denied TCP/);
  for (const paths of [{aweb:"/ready"},{...plan.allowedPaths,signer:"/ready"}])
    await assert.rejects(probeRuntime({...plan,allowedPaths:paths},io), /control paths.*roles/);
  await assert.rejects(probeRuntime({...plan,gateway:undefined},io), /endpoint/);
  await assert.rejects(probeRuntime({...plan,deniedBackends:[]},io), /backend/);
});

const networkInput = () => ({ AGENTS_SUBNET:"172.27.90.0/24",AGENTS_GATEWAY:"172.27.90.1",AGENT_IP:"172.27.90.3",
  EGRESS_ADDRESS:"172.27.90.2",SERVICES_SUBNET:"172.27.91.0/24",SERVICES_GATEWAY:"172.27.91.1" });
const observations = () => ({ networks:[{Id:"existing",Driver:"bridge",IPAM:{Config:[{Subnet:"10.10.0.0/24",Gateway:"10.10.0.1"}]}}],
  routes:[{dst:"default",gateway:"192.168.1.1"},{dst:"192.168.1.0/24"}],
  links:[{ifname:"eth0",addr_info:[{family:"inet",local:"192.168.1.2",prefixlen:24}]}] });

test("preflight rejects overlap with every Docker IPAM entry, route and link", async () => {
  const {admitNetworkPlan} = await import("../container/agent/egress/preflight-network.mjs");
  assert.deepEqual(admitNetworkPlan(networkInput(),observations()),networkInput());
  for (const change of [
    o=>o.networks[0].IPAM.Config.push({Subnet:"172.27.90.0/25"}),
    o=>o.networks[0].IPAM.Config.push({Subnet:"172.27.88.0/22"}),
    o=>o.routes.push({dst:"172.27.91.0/25"}),
    o=>o.links.push({ifname:"vpn0",addr_info:[{family:"inet",local:"172.27.90.127",prefixlen:25}]}),
  ]) {
    const seen=observations();change(seen);
    assert.throws(()=>admitNetworkPlan(networkInput(),seen),/overlap/);
  }
});

test("preflight refuses missing observations, malformed CIDRs and unusable endpoints", async () => {
  const {admitNetworkPlan} = await import("../container/agent/egress/preflight-network.mjs");
  for (const change of [
    p=>{delete p.AGENTS_GATEWAY},p=>{p.AGENTS_SUBNET="172.27.90.5/24"},
    p=>{p.EGRESS_ADDRESS=p.AGENT_IP},p=>{p.AGENT_IP=p.AGENTS_GATEWAY},
    p=>{p.AGENT_IP="172.27.90.255"},p=>{p.AGENT_IP="172.27.91.3"},
    p=>{p.SERVICES_SUBNET=p.AGENTS_SUBNET},p=>{p.AGENTS_SUBNET="0.0.0.0/0"},
  ]) {const input=networkInput();change(input);assert.throws(()=>admitNetworkPlan(input,observations()));}
  for (const change of [
    o=>{delete o.routes},o=>{o.networks[0].IPAM.Config.push({Subnet:"bad"})},
    o=>{o.routes.push({dst:"bad"})},o=>{o.links.push({ifname:"unreadable"})},
  ]) {const seen=observations();change(seen);assert.throws(()=>admitNetworkPlan(networkInput(),seen));}
});

test("preflight observation commands are read-only and each failure is a refusal", async () => {
  const {observeNetworks} = await import("../container/agent/egress/preflight-network.mjs");
  const seen=observations(),calls=[];
  const replies = ['"unix:///var/run/docker.sock"','existing\n',JSON.stringify(seen.networks),JSON.stringify(seen.routes),JSON.stringify(seen.links)];
  const run=(command,args)=>{calls.push([command,...args]);return{status:0,stdout:replies[calls.length-1]};};
  assert.deepEqual(observeNetworks(run),seen);
  assert.deepEqual(calls,[
    ["docker","context","inspect","--format","{{json .Endpoints.docker.Host}}"],
    ["docker","network","ls","--quiet","--no-trunc"], ["docker","network","inspect","existing"],
    ["ip","-j","-4","route","show","table","all"], ["ip","-j","address","show"],
  ]);
  for(let fail=0;fail<replies.length;fail++) {
    let index=0;
    assert.throws(()=>observeNetworks(()=> index++===fail?{status:1,stdout:"",stderr:"private diagnostic"}:{status:0,stdout:replies[index-1]}),/observation failed/);
  }
  assert.throws(()=>observeNetworks(()=>({status:0,stdout:"not-json"})),/observation/);
  assert.throws(()=>observeNetworks(()=>({status:0,stdout:'"tcp://remote:2376"'})),/local/);
});

test("control report identifies universal versus declared obligations and refuses a missing IPv4 gateway", async () => {
  const {boundaryControls,ipv4Gateway} = await import("../container/agent/egress/boundary.mjs");
  const {plan}=runtime(),report=boundaryControls(plan);
  assert.ok(report.universal.some(item=>item.includes("gateway")));
  assert.ok(report.universal.some(item=>item.includes("unlisted TLS")));
  assert.equal(report.declared.length,3);
  assert.ok(report.declared.every(item=>/^(aweb|registry):/.test(item)));
  assert.ok(report.declared.includes("registry: exact namespace authority TXT"));
  assert.throws(()=>ipv4Gateway({IPAM:{Config:[{Subnet:"172.27.90.0/24"}]}},"agents"),/explicit IPv4 IPAM gateway/);
  assert.throws(()=>ipv4Gateway({IPAM:{Config:[{Gateway:"fd00::1"}]}},"agents"),/IPv4/);
});

test("reviewed team-image CI builds the proxy and runs all three real Compose declarations", async () => {
  const {parse}=await import("yaml");
  const workflow=parse(readFileSync(new URL("../.github/workflows/team-image.yml",import.meta.url),"utf8"));
  const steps=workflow.jobs.verify.steps;
  const build=steps.findIndex(step=>step.run?.includes("container/agent/egress"));
  const proof=steps.findIndex(step=>step.run?.includes("agent-egress-boundary-image.py"));
  assert.ok(build>=0 && proof>build);
  assert.match(steps[proof].run,/full/);
  assert.match(steps[proof].run,/aweb,registry[\s'"]/);
  assert.match(steps[proof].run,/aweb,registry,secrets/);
  const wrapper=parse(readFileSync(new URL("../container/agent/egress/compose.minimal.yaml",import.meta.url),"utf8"));
  assert.equal(wrapper.networks.agents.internal,true);
  assert.equal(wrapper.networks.agents.driver_opts["com.docker.network.bridge.gateway_mode_ipv4"],"isolated");
  assert.match(wrapper.networks.agents.ipam.config[0].gateway,/AGENTS_GATEWAY/);
  assert.match(wrapper.networks.services.ipam.config[0].gateway,/SERVICES_GATEWAY/);
});
