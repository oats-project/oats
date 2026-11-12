import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { probeProxy } from "../container/agent/egress/health.mjs";
import { superviseProxy } from "../container/agent/egress/supervisor.mjs";
import { compilePolicy } from "../container/agent/egress/policy.mjs";
import { assertComposeBoundary } from "../container/agent/egress/boundary.mjs";

// Native Docker-inspect/network-inspect response shapes at the system boundary.
function composeBoundary() {
  const approvedAgentMounts = [
    {Type:"bind", Source:"/fixture/state", Destination:"/state", RW:true},
    {Type:"bind", Source:"/fixture/login", Destination:"/etc/agent-login", RW:false},
    {Type:"bind", Source:"/fixture/operator.pub", Destination:"/etc/agent-ssh/authorized_keys", RW:false},
    {Type:"bind", Source:"/fixture/resolv.conf", Destination:"/etc/resolv.conf", RW:false},
  ];
  return {
    approvedAgentMounts,
    protectedSources: ["/fixture/services/keys", "/fixture/services/postgres", "/var/run/docker.sock"],
    agentsNetwork: { Id: "internal-agent-network", Internal: true, EnableIPv6: false },
    servicesNetwork: { Id: "service-network", Internal: false, EnableIPv6: false },
    agent: {
      Mounts: structuredClone(approvedAgentMounts),
      HostConfig: { NetworkMode: "proof_agents" },
      NetworkSettings: { Networks: { proof_agents: { NetworkID: "internal-agent-network" } } },
    },
    egress: {
      HostConfig: { NetworkMode: "proof_agents" },
      NetworkSettings: { Networks: {
        proof_agents: { NetworkID: "internal-agent-network" },
        proof_services: { NetworkID: "service-network" },
      } },
    },
  };
}

test("preflight accepts the isolated agent and sole dual-network proxy", () => {
  assert.doesNotThrow(() => assertComposeBoundary(composeBoundary()));
});

test("an alternate open agent bridge fails the boundary before launch", () => {
  const state = composeBoundary();
  state.agent.NetworkSettings.Networks.bridge = { NetworkID: "open-bridge" };
  assert.throws(() => assertComposeBoundary(state), /agent.*network/);
});

test("the agents network must be internal IPv4-only", () => {
  for (const [field, value] of [["Internal", false], ["EnableIPv6", true]]) {
    const state = composeBoundary();
    state.agentsNetwork[field] = value;
    assert.throws(() => assertComposeBoundary(state), /isolated IPv4 agents network/);
  }
});

test("only the proxy joins exactly the agents and services networks", () => {
  for (const change of [
    state => { state.egress.NetworkSettings.Networks.bridge = { NetworkID: "open-bridge" }; },
    state => { delete state.egress.NetworkSettings.Networks.proof_services; },
    state => { state.egress.NetworkSettings.Networks.proof_services.NetworkID = "another-service-network"; },
  ]) {
    const state = composeBoundary();
    change(state);
    assert.throws(() => assertComposeBoundary(state), /proxy.*networks/);
  }
});

test("missing network identities cannot establish a boundary", () => {
  const state = composeBoundary();
  state.agentsNetwork.Id = "";
  state.agent.NetworkSettings.Networks.proof_agents.NetworkID = "";
  state.egress.NetworkSettings.Networks.proof_agents.NetworkID = "";
  assert.throws(() => assertComposeBoundary(state), /identified.*networks/);
});


function proxyPolicy() {
  return {
    frontAddress: "172.30.0.2",
    privateIngressAddresses: ["10.20.0.10"],
    deniedAddresses: ["10.20.0.11", "10.20.0.12"],
    humanOrigin: "https://approve.example.invalid",
    authorityRecords: [{name:"_awid.team.example.invalid",text:"awid=v1; controller=did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7; registry=https://registry.example.invalid;"}],
    targets: {
      aweb: { origin: "https://aweb.example.invalid", addresses: ["10.20.0.10"] },
      secrets: { origin: "https://secrets.example.invalid", addresses: ["10.20.0.10"] },
      logs: { origin: "https://logs.example.invalid", addresses: ["10.20.0.10"] },
      signer: { origin: "https://prepare.example.invalid", addresses: ["10.20.0.10"] },
      registry: { origin: "https://registry.example.invalid", addresses: ["10.20.0.10"] },
    },
  };
}

test("one policy produces authoritative DNS and exact TLS routes for the five services", () => {
  const result = compilePolicy(proxyPolicy());
  for (const host of ["aweb.example.invalid", "secrets.example.invalid", "logs.example.invalid", "prepare.example.invalid", "registry.example.invalid"]) {
    assert.match(result.zone, new RegExp(host.replaceAll(".", "\\.") + "\\. 30 IN A 172\\.30\\.0\\.2"));
    assert.ok(result.nginx.includes('"'+host+'"'), "the configured service is explicitly routed");
  }
  assert.match(result.nginx, /ssl_preread on;/);
  assert.match(result.nginx, /default "";/, "unknown SNI has no upstream");
  assert.doesNotMatch(result.nginx, /ssl_certificate|proxy_ssl on|resolver /, "no TLS termination or live upstream DNS");
  assert.doesNotMatch(result.zone, /approve\.example\.invalid/);
  assert.doesNotMatch(result.corefile, /forward|proxy/, "the agent resolver never recurses upstream");
});

test("proxy policy rejects wildcard, credential, human-login and unbound destinations", () => {
  const cases = [
    policy => { policy.targets.aweb.origin = "http://aweb.example.invalid"; },
    policy => { policy.targets.aweb.origin = "https://*.example.invalid"; },
    policy => { policy.targets.aweb.origin = "https://user:private-value@aweb.example.invalid"; },
    policy => { policy.targets.aweb.origin = "https://aweb.example.invalid:5432"; },
    policy => { policy.targets.aweb.origin = "https://aweb.example.invalid/private"; },
    policy => { policy.targets.signer.origin = policy.humanOrigin; },
    policy => { policy.targets.postgres = { origin: "https://db.example.invalid", addresses: ["10.20.0.11"] }; },
    policy => { delete policy.targets.signer; },
    policy => { policy.frontAddress = "172.30.0.2; injected"; },
    policy => { policy.targets.aweb.addresses = ["10.20.0.10; injected"]; },
  ];
  for (const change of cases) {
    const policy = proxyPolicy();
    change(policy);
    assert.throws(() => compilePolicy(policy), error => {
      assert.doesNotMatch(error.message, /private-value|injected/, "rejected input values are not echoed");
      return /egress policy/.test(error.message);
    });
  }
});

test("pinned ingress never grants metadata, loopback, DB or Redis destinations", () => {
  for (const ip of ["127.0.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "10.20.0.11", "10.20.0.12", "10.20.0.99"]) {
    const policy = proxyPolicy();
    policy.targets.aweb.addresses = [ip];
    assert.throws(() => compilePolicy(policy), /egress policy upstream address denied/);
  }
  const policy = proxyPolicy();
  policy.privateIngressAddresses.push("169.254.169.254", "10.20.0.11");
  policy.targets.aweb.addresses = ["169.254.169.254"];
  assert.throws(() => compilePolicy(policy), /egress policy upstream address denied/);
  policy.targets.aweb.addresses = ["10.20.0.11"];
  assert.throws(() => compilePolicy(policy), /egress policy upstream address denied/);
});

test("proxy policy rejects ambiguous hosts and unexpected payload fields", () => {
  for (const change of [
    policy => { policy.password = "private-payload"; },
    policy => { policy.targets.aweb.token = "private-payload"; },
    policy => { policy.targets.logs.origin = policy.targets.secrets.origin; },
    policy => { policy.targets.aweb.addresses = Array(9).fill("10.20.0.10"); },
  ]) {
    const policy = proxyPolicy(); change(policy);
    assert.throws(() => compilePolicy(policy), error => /egress policy/.test(error.message) && !error.message.includes("private-payload"));
  }
});


test("a proxy child exit fails the image and ends its owned peer", async (t) => {
  const children = [], readiness = [], said = [];
  const running = superviseProxy({
    spawnChild() {
      const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>process.exit(0));process.stdout.write("ready");setInterval(()=>{},1000)'], {stdio:["ignore","pipe","ignore"]});
      children.push(child);
      readiness.push(new Promise(resolve => child.stdout.once("data", resolve)));
      return child;
    },
    onSignal() { return () => {}; }, say: line => said.push(line), graceMs:100,
  });
  t.after(async () => { for(const child of children)child.kill("SIGKILL");await running; });
  assert.equal(children.length,2,"the proxy must own both DNS and TLS children");
  await Promise.all(readiness);
  children[0].kill("SIGKILL");
  assert.equal(await running,1,"loss of either proxy component must fail the image");
  assert.notEqual(children[1].exitCode,null,"the peer is awaited before the supervisor returns");
  assert.ok(said.some(line=>line.includes("dns exited")));
});


test("service-key, DB and engine-socket mounts never enter the agent", () => {
  for (const mount of [
    {Type:"bind",Source:"/fixture/services/keys",Destination:"/run/secrets",RW:false},
    {Type:"bind",Source:"/fixture/services/postgres",Destination:"/data",RW:false},
    {Type:"bind",Source:"/var/run/docker.sock",Destination:"/engine.sock",RW:false},
  ]) {
    const state = composeBoundary(); state.agent.Mounts.push(mount);
    assert.throws(() => assertComposeBoundary(state), /agent.*mount/);
  }
  const state = composeBoundary();
  state.agent.Mounts[0].Source = "/fixture/services";
  state.approvedAgentMounts[0].Source = "/fixture/services";
  assert.throws(() => assertComposeBoundary(state), /agent.*protected/,
    "a broad state bind must not expose private service subdirectories even when configured");
});


test("proxy health requires exact DNS, an authoritative denial and a live TLS listener", async () => {
  const policy = proxyPolicy();
  const dns = async name => {
    if(name === "aweb.example.invalid") return ["172.30.0.2"];
    throw Object.assign(new Error("fixture NXDOMAIN"),{code:"ENOTFOUND"});
  };
  assert.equal(await probeProxy({policy,resolve4:dns,connect:async()=>{}}),true);
});


test("the proxy fragment has only the policy mount and two controlled networks", async () => {
  const source = new URL("../container/agent/egress/compose.egress.yaml",import.meta.url);
  assert.ok(existsSync(source),"the reusable egress service fragment is required");
  const {parse} = await import("yaml");
  const config = parse(readFileSync(source,"utf8"));
  const proxy = config.services.egress;
  assert.equal(proxy.user,"10001:10001");
  assert.equal(proxy.read_only,true);
  assert.deepEqual(proxy.cap_drop,["ALL"]);
  assert.deepEqual(proxy.security_opt,["no-new-privileges:true"]);
  assert.equal(proxy.privileged,false);
  assert.equal(proxy.sysctls["net.ipv4.ip_forward"],"0");
  assert.equal(proxy.sysctls["net.ipv4.ip_unprivileged_port_start"],"0");
  assert.deepEqual(Object.keys(proxy.networks).sort(),["agents","services"]);
  assert.deepEqual(proxy.volumes,[{type:"bind",source:"${EGRESS_POLICY_FILE:?Set EGRESS_POLICY_FILE}",target:"/etc/egress/policy.json",read_only:true,bind:{create_host_path:false}}]);
  assert.deepEqual(proxy.tmpfs,["/tmp:rw,nosuid,nodev,size=16m,mode=1777"]);
  assert.equal(proxy.pids_limit,64);
  assert.deepEqual(proxy.healthcheck.test,["CMD","node","/opt/egress/health.mjs"]);
  const dockerfile = readFileSync(new URL("../container/agent/egress/Dockerfile",import.meta.url),"utf8");
  assert.equal((dockerfile.match(/^FROM .+@sha256:[0-9a-f]{64}/gm)||[]).length,2);
  assert.match(dockerfile,/^USER 10001:10001$/m);
});

test("sender verification has a fifth pinned HTTPS registry route", () => {
  const policy = proxyPolicy();
  policy.targets.registry = {origin:"https://registry.example.invalid",addresses:["10.20.0.10"]};
  const result = compilePolicy(policy);
  assert.match(result.zone,/registry\.example\.invalid\. 30 IN A 172\.30\.0\.2/);
  assert.ok(result.nginx.includes('"registry.example.invalid"'));
  const denied = structuredClone(policy);
  denied.targets.registry.addresses = ["169.254.169.254"];
  assert.throws(() => compilePolicy(denied), /upstream address denied/);
});

test("only provisioned public namespace TXT records enter the authoritative zone", () => {
  const policy = proxyPolicy();
  policy.authorityRecords = [{name:"_awid.team.example.invalid",text:"awid=v1; controller=did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7; registry=https://registry.example.invalid;"}];
  const result = compilePolicy(policy);
  assert.ok(result.zone.includes('_awid.team.example.invalid. 30 IN TXT "awid=v1; controller=did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7; registry=https://registry.example.invalid;"'));
  assert.doesNotMatch(result.corefile,/forward/);
  for (const record of [
    {name:"*.example.invalid",text:policy.authorityRecords[0].text},
    {name:"_awid.team.example.invalid\nmalformed",text:policy.authorityRecords[0].text},
    {name:"_awid.team.example.invalid",text:"awid=v1;\nmalformed"},
  ]) assert.throws(()=>compilePolicy({...policy,authorityRecords:[record]}),/egress policy/);
});
