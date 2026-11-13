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
    agentsNetwork: { Id: "internal-agent-network", Internal: true, EnableIPv6: false, Options:{"com.docker.network.bridge.gateway_mode_ipv4":"isolated"} },
    servicesNetwork: { Id: "service-network", Internal: false, EnableIPv6: false },
    agent: {
      Mounts: structuredClone(approvedAgentMounts),
      HostConfig: { NetworkMode: "proof_agents", CapDrop:["ALL"], CapAdd:[], SecurityOpt:["no-new-privileges:true"], ReadonlyRootfs:true, Privileged:false, PidMode:"", IpcMode:"private" },
      NetworkSettings: { Networks: { proof_agents: { NetworkID: "internal-agent-network" } } },
    },
    egress: {
      Config: {User:"10001:10001"},
      HostConfig: { NetworkMode: "proof_agents", CapDrop:["ALL"], CapAdd:[], SecurityOpt:["no-new-privileges:true"], ReadonlyRootfs:true, Privileged:false, PidMode:"", IpcMode:"private" },
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

test("the proxy must use the approved non-root UID and GID", () => {
  for(const user of ["0:0","10001","10002:10002"]){
    const state=composeBoundary();state.egress.Config.User=user;
    assert.throws(()=>assertComposeBoundary(state),/proxy.*UID/);
  }
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

function externalPolicy() {
  return {...proxyPolicy(), externalTargets: {
    source: {origin:"https://github.com"}, model: {origin:"https://api.anthropic.com"},
  }, externalResolverAddresses:["1.1.1.1","8.8.8.8"]};
}

test("the closed proxy build context admits each Dockerfile COPY source", () => {
  const root=new URL("../container/agent/egress/",import.meta.url);
  const dockerfile=readFileSync(new URL("Dockerfile",root),"utf8");
  const admitted=readFileSync(new URL(".dockerignore",root),"utf8").trim().split("\n");
  assert.equal(admitted[0],"**");
  for(const line of dockerfile.split("\n").filter(line=>line.startsWith("COPY --chmod="))) {
    for(const source of line.trim().split(/\s+/).slice(2,-1)) {
      assert.ok(admitted.includes("!"+source),"Dockerfile source excluded from the closed context: "+source);
      assert.ok(existsSync(new URL(source,root)));
    }
  }
});

test("external source and model roles keep DNS at the proxy and use separate owned connectors", () => {
  const result=compilePolicy(externalPolicy());
  for (const host of ["github.com","api.anthropic.com"]) {
    assert.ok(result.zone.includes(`${host}. 30 IN A 172.30.0.2`));
    assert.ok(result.nginx.includes(`"${host}" external_`));
  }
  assert.match(result.nginx,/server 127\.0\.0\.1:10443;/);
  assert.match(result.nginx,/server 127\.0\.0\.1:10444;/);
  assert.doesNotMatch(result.nginx,/resolver |proxy_ssl|ssl_certificate/);
  assert.doesNotMatch(result.corefile,/forward|proxy/);
  assert.match(result.corefile,/class denial/);
  assert.match(result.nginx,/sni_refused/);
  assert.match(result.nginx,/access_log \/dev\/stderr refused if=\$log_refused;/);
  assert.match(result.nginx,/server 10\.20\.0\.10:443;/,"internal targets remain pinned");
});

test("external policy refuses unscoped roles, missing resolvers and unsafe resolver addresses", () => {
  for (const change of [
    p=>{p.externalTargets.knowledge={origin:"https://api.github.com"};},
    p=>{p.externalTargets.source.origin="https://example.com";},
    p=>{p.externalTargets.source.origin="https://github.com:444";},
    p=>{p.externalTargets.model.addresses=["1.1.1.1"];},
    p=>{delete p.externalResolverAddresses;},
    p=>{delete p.externalTargets;},
    p=>{p.externalTargets={};},
    p=>{p.externalResolverAddresses=[];},
    p=>{p.externalResolverAddresses=["1.1.1.1","1.1.1.1"];},
    p=>{p.externalResolverAddresses=Array(5).fill("1.1.1.1");},
    ...["0.0.0.0","10.0.0.1","127.0.0.1","169.254.169.254","172.30.0.2",
      "192.168.0.1","100.64.0.1","192.0.2.1","224.0.0.1","240.0.0.1","::1"].map(ip=>p=>{p.externalResolverAddresses=[ip];}),
    p=>{p.targets.aweb.addresses=["9.9.9.9"];p.externalResolverAddresses=["9.9.9.9"];},
    p=>{p.deniedAddresses.push("1.1.1.1");},
    p=>{p.privateIngressAddresses.push("1.1.1.1");},
    p=>{p.targets.aweb.origin="https://github.com";},
    p=>{p.humanOrigin="https://api.anthropic.com";},
  ]) {
    const policy=externalPolicy();change(policy);
    assert.throws(()=>compilePolicy(policy),/egress policy/);
  }
  const source=externalPolicy();delete source.externalTargets.model;
  assert.doesNotThrow(()=>compilePolicy(source),"either role can be independently enabled");
});

test("external resolution refuses mixed or deployment answers before opening any socket", async () => {
  const {connectExternal}=await import("../container/agent/egress/external.mjs");
  const policy=externalPolicy();let calls=0;
  for (const answers of [["140.82.112.3","127.0.0.1"],["10.20.0.10"],["172.30.0.2"],[],["::1"]]) {
    await assert.rejects(connectExternal(policy,"github.com",{
      resolve4:async host=>{assert.equal(host,"github.com");return answers;},
      connect:()=>{calls++;throw new Error("must not connect");},
    }),/external destination refused/);
  }
  assert.equal(calls,0);
  await assert.rejects(connectExternal(policy,"not-listed.invalid",{
    resolve4:async()=>{throw new Error("undeclared host must not resolve");},
  }),/external hostname refused/);
});

test("external connector passes only the validated IPv4 literal to the socket boundary", async () => {
  const {connectExternal}=await import("../container/agent/egress/external.mjs");
  const {PassThrough}=await import("node:stream");const stream=new PassThrough();
  const policy=externalPolicy();let lookups=0,options;
  const socket=await connectExternal(policy,"github.com",{
    resolve4:async()=>{lookups++;return ["140.82.112.3"];},
    connect:value=>{options=value;queueMicrotask(()=>stream.emit("connect"));return stream;},
  });
  assert.equal(socket,stream);assert.equal(lookups,1);
  assert.deepEqual(options,{host:"140.82.112.3",port:443,family:4});
  stream.destroy();
});

test("external DNS timeout and cancelled clients cannot later open an upstream socket", async () => {
  const {connectExternal}=await import("../container/agent/egress/external.mjs");
  for (const mode of ["timeout","abort"]) {
    let answer,calls=0;
    const controller=new AbortController();
    const pending=connectExternal(externalPolicy(),"github.com",{
      resolve4:()=>new Promise(resolve=>{answer=resolve;}),
      connect:()=>{calls++;throw new Error("late socket");},
      signal:controller.signal,timeoutMs:20,
    });
    if(mode==="abort") controller.abort();
    await assert.rejects(pending,/external destination refused/);
    answer?.(["140.82.112.3"]);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,0);
  }
});

test("the proxy owns external connectors and does not launch children if a connector cannot bind", async () => {
  const {createServer}=await import("node:net");
  const blocker=createServer();await new Promise((resolve,reject)=>{
    blocker.once("error",reject);blocker.listen(10443,"127.0.0.1",resolve);
  });
  let launches=0;
  try {
    const code=await superviseProxy({policy:externalPolicy(),spawnChild:()=>{launches++;throw new Error("must not launch");},
      onSignal:()=>()=>{},say:()=>{}});
    assert.equal(code,1);assert.equal(launches,0);
  } finally {await new Promise(resolve=>blocker.close(resolve));}
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


test("runtime privileges cannot bypass the admitted egress boundary", () => {
  for (const role of ["agent", "egress"]) for (const [key,value] of [
    ["Privileged",true], ["CapAdd",["NET_ADMIN"]], ["CapDrop",[]],
    ["SecurityOpt",[]], ["ReadonlyRootfs",false], ["PidMode","host"],
    ["NetworkMode","host"], ["NetworkMode","container:other"],
    ["ExtraHosts",["bypass:10.20.0.10"]], ["Dns",["1.1.1.1"]], ["Devices",[{PathOnHost:"/dev/mem"}]],
  ]) {
    const state=composeBoundary();state[role].HostConfig[key]=value;
    assert.throws(()=>assertComposeBoundary(state),/runtime isolation/);
  }
});

test("an internal bridge with a reachable host gateway is not isolated", () => {
  const state=composeBoundary();
  state.agentsNetwork.Options={};
  assert.throws(()=>assertComposeBoundary(state),/isolated gateway mode/);
});

test("the shared ingress probe proves both protocol refusals before backend delivery", async t => {
  const moduleUrl=new URL("../container/agent/egress/probe-ingress.mjs",import.meta.url);
  assert.ok(existsSync(moduleUrl),"the shared runtime ingress refusal probe is required");
  const {probeIngress,statusOf}=await import(moduleUrl);
  const {mkdtempSync,writeFileSync,appendFileSync,rmSync}=await import("node:fs");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  const {execFileSync}=await import("node:child_process");
  const {createSecureServer}=await import("node:http2");
  const dir=mkdtempSync(join(tmpdir(),"oats-egress-ingress-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(join(dir,"openssl.cnf"),'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=prepare.example.invalid\n[ext]\nsubjectAltName=DNS:prepare.example.invalid,DNS:approve.example.invalid,DNS:aweb.example.invalid,DNS:secrets.example.invalid,DNS:logs.example.invalid,DNS:registry.example.invalid\nbasicConstraints=critical,CA:TRUE\n');
  execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-sha256","-nodes","-days","1","-keyout",join(dir,"key.pem"),"-out",join(dir,"cert.pem"),"-config",join(dir,"openssl.cnf")],{stdio:"ignore"});
  const requestLog=join(dir,"request.log"),humanLog=join(dir,"human.log");
  writeFileSync(requestLog,"");writeFileSync(humanLog,"");
  const serviceRoutes={
    "prepare.example.invalid":{path:"/readyz",log:requestLog},
    "approve.example.invalid":{path:"/handoff-assets/handoff.css",log:humanLog},
    ...Object.fromEntries(["aweb","secrets","logs","registry"].map(role=>[role+".example.invalid",{path:role==="registry"?"/health":"/ready",log:join(dir,role+".log")}]))
  };
  for(const route of Object.values(serviceRoutes))writeFileSync(route.log,"");
  let strict=true, strictTls=false, weakSni=null, delayRegistryPort=false, misrouteSecrets=false;
  let misrouteSecretsSni="secrets.example.invalid", coverageStatus=404;
  let secretsMisdeliveries=0;
  const pendingRegistry=[];
  const {createSecureContext}=await import("node:tls");
  const context=createSecureContext({key:readFileSync(join(dir,"key.pem")),cert:readFileSync(join(dir,"cert.pem"))});
  const server=createSecureServer({key:readFileSync(join(dir,"key.pem")),cert:readFileSync(join(dir,"cert.pem")),allowHTTP1:true,
    SNICallback:(name,done)=>{
      if(strictTls && !Object.hasOwn(serviceRoutes,name))done(new Error("unlisted SNI"));
      else done(null,context);
    }});
  const sessions=new Set();server.on("session",s=>{sessions.add(s);s.on("close",()=>sessions.delete(s))});
  server.on("request",(req,res)=>{
    const authority=req.headers[":authority"]||req.headers.host;
    const sni=req.socket.servername;
    const matched=authority===sni || authority===sni+":443";
    if(misrouteSecrets&&sni===misrouteSecretsSni&&(authority==="approve.example.invalid"||authority==="approve.example.invalid:443")) {
      secretsMisdeliveries++;
      // This backend deliberately retains only health-request lines.
      if(["/ready","/live"].includes(new URL(req.url,"https://fixture.invalid").pathname))
        appendFileSync(serviceRoutes["secrets.example.invalid"].log,req.url+"\n");
      res.writeHead(421);res.end();return;
    }
    const delayed=delayRegistryPort&&req.httpVersionMajor===2&&sni==="registry.example.invalid"&&authority==="registry.example.invalid:444";
    if(strict&&!matched&&sni!==weakSni&&!delayed){res.writeHead(421);res.end();return}
    const host=authority?.split(":")[0];
    if(!Object.hasOwn(serviceRoutes,host)){res.writeHead(421);res.end();return}
    const pathname=new URL(req.url,"https://fixture.invalid").pathname, wanted=serviceRoutes[host].path;
    const loggable=host!=="secrets.example.invalid"||["/ready","/live"].includes(pathname);
    if(host==="registry.example.invalid"&&matched&&pendingRegistry.length)
      appendFileSync(serviceRoutes[host].log,pendingRegistry.splice(0).join("\n")+"\n");
    if(delayed)pendingRegistry.push(req.url);
    else if(loggable)appendFileSync(serviceRoutes[host].log,req.url+"\n");
    // A misrouted backend may itself return 421: status alone proves nothing.
    const status=!matched?421:pathname===wanted?200:coverageStatus;
    res.writeHead(status,status===302?{Location:"https://outside.egress-probe.invalid/not-followed"}:{});res.end();
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{for(const s of sessions)s.destroy();server.closeAllConnections?.();server.close(resolve)}));
  const options={address:"127.0.0.1",port:server.address().port,requestOrigin:"https://prepare.example.invalid",humanOrigin:"https://approve.example.invalid",ca:readFileSync(join(dir,"cert.pem")),requestLog,humanLog,requestPath:"/readyz",humanPath:"/handoff-assets/handoff.css",auditPath:"/ready"};
  assert.equal(await probeIngress(options),true);
  const policy=proxyPolicy();
  const routeLogs=Object.fromEntries(Object.entries(policy.targets).map(([role,target])=>{
    const route=serviceRoutes[new URL(target.origin).hostname];return[role,{path:route.path,log:route.log}];
  }));
  const full={...options,address:policy.targets.signer.addresses[0],policy,routeLogs,exchange:args=>statusOf({...args,address:"127.0.0.1",port:options.port})};
  const before=Object.fromEntries(Object.entries(routeLogs).map(([role,route])=>[role,readFileSync(route.log,"utf8").length]));
  const humanBefore=readFileSync(humanLog,"utf8").length;
  assert.equal(await probeIngress(full),true);
  const humanLines=readFileSync(humanLog,"utf8").slice(humanBefore).trim().split("\n");
  assert.equal(humanLines.filter(line=>line.startsWith("/handoff-assets/handoff.css?")).length,2,"valid human200 controls keep their CSS path");
  assert.equal(humanLines.filter(line=>line.startsWith("/ready?")).length,4,"separate human log-coverage controls use the common audit path");
  for(const [role,route] of Object.entries(routeLogs))assert.equal((readFileSync(route.log,"utf8").slice(before[role]).match(/oats_egress_probe=/g)||[]).length,8,role+" needs H1/H2 service controls and initial/final audit coverage");
  misrouteSecrets=true;
  await assert.rejects(()=>probeIngress(full),/forbidden probe reached a backend/,
    "health-only Secrets logging must expose a delivered human-authority request even when its backend returns421");
  assert.equal(secretsMisdeliveries,4,"the H1/H2 bare/explicit human authorities must actually reach the backend");
  secretsMisdeliveries=0;misrouteSecretsSni="registry.example.invalid";
  await assert.rejects(()=>probeIngress(full),/forbidden probe reached a backend/,
    "a registry health-route misdelivery into Secrets must use the common observed path");
  assert.equal(secretsMisdeliveries,4);
  misrouteSecrets=false;
  await assert.rejects(()=>probeIngress({...full,auditPath:"/audit-unlogged"}),/backend audit did not confirm/,
    "a4xx without the route's common-path log witness cannot qualify coverage");
  coverageStatus=503;
  await assert.rejects(()=>probeIngress(full),/backend audit coverage control did not succeed/);
  coverageStatus=302;
  assert.equal(await probeIngress(full),true,"coverage redirects are observed without following a new destination");
  coverageStatus=404;
  await assert.rejects(()=>probeIngress({...full,exchange:args=>args.sni==="registry.example.invalid"&&args.authority===args.sni&&args.path.startsWith("/ready?")
    ?Promise.reject(Object.assign(new Error("coverage timeout"),{code:"EGRESS_PROBE_TIMEOUT",tlsEstablished:true,beforeHttpResponse:true}))
    :full.exchange(args)}),error=>error.code==="EGRESS_PROBE_TIMEOUT","coverage timeout cannot become a refusal PASS");
  delayRegistryPort=true;
  await assert.rejects(()=>probeIngress(full),/forbidden probe reached a backend/,
    "a route's buffered forbidden delivery must be flushed by a later matched control");
  delayRegistryPort=false;
  await assert.rejects(()=>probeIngress({...full,address:"10.20.0.99"}),/ingress address.*signer/);
  for(const bad of [Object.fromEntries(Object.entries(routeLogs).filter(([role])=>role!=="registry")),{...routeLogs,extra:routeLogs.aweb}])
    await assert.rejects(()=>probeIngress({...full,routeLogs:bad}),/exactly the policy roles/);
  await assert.rejects(()=>probeIngress({...full,routeLogs:{...routeLogs,aweb:{...routeLogs.aweb,path:"//elsewhere.invalid/ready"}}}),/ingress probe path/);
  weakSni="aweb.example.invalid";
  await assert.rejects(()=>probeIngress(full),/forbidden probe reached a backend/,"a non-signer SNI must not front the human origin");
  weakSni=null;
  strictTls=true;
  assert.equal(await probeIngress(options),true);
  strictTls=false;
  const {createServer}=await import("node:net");
  let hang=false, alertDescription=80;
  const alertSockets=new Set();
  // TLS 1.2 fatal internal_error (RFC 5246 alert description 80), before HTTP.
  const alertServer=createServer(socket=>{
    alertSockets.add(socket);socket.on("close",()=>alertSockets.delete(socket));
    socket.once("data",()=>{if(!hang)socket.end(Buffer.from([21,3,3,0,2,2,alertDescription]))});
  });
  await new Promise(resolve=>alertServer.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>{for(const socket of alertSockets)socket.destroy();alertServer.close(resolve)}));
  const alertPort=alertServer.address().port;
  const unlisted=sni=>sni==="unlisted.egress-probe.invalid"||sni==="";
  const unknownRefusal=args=>statusOf({...args,port:unlisted(args.sni)?alertPort:options.port});
  assert.equal(await probeIngress({...options,exchange:unknownRefusal}),true,
    "unknown/empty SNI fatal handshake refusals still require live matched controls and backend audit");
  await assert.rejects(()=>probeIngress({...options,exchange:args=>{
    if(args.sni==="prepare.example.invalid" && args.authority==="approve.example.invalid")return Promise.reject(Object.assign(new Error("reset before TLS"),{
      code:"ECONNRESET",beforeHttpResponse:true,peerHandshakeRefusal:false,tlsEstablished:false,
    }));
    return statusOf({...args,port:options.port});
  }}),error=>error.code==="ECONNRESET","known-SNI authority checks must actually establish TLS before any transport refusal counts");
  const knownRefusal=args=>statusOf({...args,port:args.sni==="prepare.example.invalid"&&args.authority==="approve.example.invalid"?alertPort:options.port});
  await assert.rejects(()=>probeIngress({...options,exchange:knownRefusal}),error=>error.code==="ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR");
  await assert.rejects(()=>probeIngress({...options,exchange:args=>statusOf({...args,port:alertPort})}),error=>error.code==="ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
    "a matched control cannot turn its TLS failure into a pass");
  await assert.rejects(()=>probeIngress({...options,ca:[]}),error=>error.code==="DEPTH_ZERO_SELF_SIGNED_CERT");
  await assert.rejects(()=>probeIngress({...options,exchange:args=>{
    if(unlisted(args.sni))return Promise.reject(Object.assign(new Error("post-response transport error"),{
      code:"ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",beforeHttpResponse:false,peerHandshakeRefusal:false,
    }));
    return statusOf({...args,port:options.port});
  }}),error=>error.code==="ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR", "an alert after HTTP is not a handshake refusal");
  // Node/OpenSSL versions spell the same peer handshake_failure differently.
  // Exercise the shipped spelling too; it never admits a known SNI pre-TLS.
  const shippedHandshake="ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE";
  const shippedRefusal=args=>unlisted(args.sni)?Promise.reject(Object.assign(new Error("peer handshake_failure"),{
    code:shippedHandshake,beforeHttpResponse:true,peerHandshakeRefusal:false,tlsEstablished:false,
  })):statusOf({...args,port:options.port});
  assert.equal(await probeIngress({...options,exchange:shippedRefusal}),true);
  await assert.rejects(()=>probeIngress({...options,exchange:args=>args.sni==="prepare.example.invalid"&&args.authority==="approve.example.invalid"
    ?Promise.reject(Object.assign(new Error("known SNI handshake_failure"),{code:shippedHandshake,beforeHttpResponse:true,tlsEstablished:false}))
    :statusOf({...args,port:options.port})}),error=>error.code===shippedHandshake);
  alertDescription=40;
  assert.equal(await probeIngress({...options,exchange:unknownRefusal}),true,"actual peer handshake_failure before HTTP refuses unlisted/absent SNI");
  alertDescription=80;
  hang=true;
  await assert.rejects(()=>probeIngress({...options,exchange:unknownRefusal}),error=>error.code==="EGRESS_PROBE_TIMEOUT");
  hang=false; strict=false;
  await assert.rejects(()=>probeIngress(options),/forbidden probe reached a backend/);
});

test("ingress control paths cannot select another origin or inject a fragment", async () => {
  const {probeIngress}=await import("../container/agent/egress/probe-ingress.mjs");
  for (const path of ["/\\other.invalid/ready","//other.invalid/ready","https://other.invalid/ready","/ready#fragment","/ready\r\nInjected"]) {
    for (const field of ["requestPath","humanPath","auditPath"]) await assert.rejects(()=>probeIngress({
      address:"127.0.0.1",requestOrigin:"https://prepare.example.invalid",humanOrigin:"https://approve.example.invalid",
      auditPath:"/ready",[field]:path,requestLog:"/missing-audit",humanLog:"/missing-audit",
    }),/ingress probe path is invalid/);
  }
});

test("the reusable gateway canary has one live TCP client body", async t => {
  const url=new URL("../container/agent/egress/canary.mjs",import.meta.url);
  assert.ok(existsSync(url),"the actual-network probe must reuse the smoke canary body");
  const {serveCanary,tcpReachable}=await import(url);
  const child=spawn(process.execPath,["--input-type=module","-e",`(${serveCanary.toString()})("127.0.0.1")`],{stdio:["ignore","pipe","pipe"]});
  let out="";
  child.stdout.on("data",data=>{out+=data});
  const port=await new Promise((resolve,reject)=>{
    child.once("error",reject);
    const read=data=>{const match=String(data).match(/CANARY_PORT=(\d+)/);if(match){child.stdout.off("data",read);resolve(Number(match[1]))}};
    child.stdout.on("data",read);
  });
  t.after(async()=>{child.kill("SIGKILL");await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once("close",resolve))});
  assert.equal(await tcpReachable("127.0.0.1",port,{payload:true}),true);
  assert.equal(await tcpReachable("127.0.0.1",port),true);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("canary positive control was not received")),1000);
    const check=()=>{if((out.match(/CANARY_HIT/g)||[]).length===2){clearTimeout(timer);child.stdout.off("data",check);resolve()}};
    child.stdout.on("data",check);check();
  });
  child.kill("SIGKILL");await new Promise(resolve=>child.once("close",resolve));
  assert.equal(await tcpReachable("127.0.0.1",port),false,"a dead listener cannot serve as the positive control");
  assert.equal(out.match(/CANARY_HIT/g)?.length,2);
});

test("the in-container boundary body rejects a live denied endpoint or a key mount", async () => {
  const url=new URL("../container/agent/egress/probe-runtime.mjs",import.meta.url);
  assert.ok(existsSync(url),"the actual agents-network probe body is required");
  const {probeRuntime}=await import(url);
  const policy=proxyPolicy();
  const plan={policy,uid:20001,gid:20001,allowedPaths:{aweb:"/ready",secrets:"/ready",logs:"/ready",signer:"/readyz",registry:"/health"},deniedBackends:[{role:"postgres",address:"10.20.0.11",port:5432},{role:"redis",address:"10.20.0.12",port:6379}],gateway:{address:"10.20.0.1",port:40000}};
  const io={
    identity:()=>({uid:20001,gid:20001}),
    fs:{readdirSync:()=>[],readFileSync:path=>path==="/etc/resolv.conf"?"nameserver 172.30.0.2\n":"CapEff:\t0000000000000000\nNoNewPrivs:\t1\n",existsSync:()=>false},
    resolver:{setServers:servers=>assert.deepEqual(servers,["172.30.0.2"]),resolve4:async host=>{
      if(Object.values(policy.targets).some(t=>new URL(t.origin).hostname===host))return["172.30.0.2"];
      throw Object.assign(new Error("NXDOMAIN"),{code:"ENOTFOUND"});
    },resolveTxt:async name=>policy.authorityRecords.filter(r=>r.name===name).map(r=>[r.text])},
    getStatus:async()=>200,tlsReachable:async()=>false,tcpReachable:async()=>false,
  };
  assert.equal(await probeRuntime(plan,io),true);
  const trustPath="/etc/agent-trust/ca.pem",pem=(await import("node:tls")).rootCertificates[0];
  let rootControls=0;
  const trustIO={...io,environment:{SSL_CERT_FILE:trustPath,NODE_EXTRA_CA_CERTS:trustPath},fs:{...io.fs,
    statSync:()=>({isFile:()=>true,size:pem.length,nlink:1}),
    readFileSync:(path,...args)=>path===trustPath?pem:io.fs.readFileSync(path,...args),
    constants:{W_OK:2},accessSync:()=>{throw Object.assign(new Error("read-only fixture"),{code:"EROFS"})}},
    getStatus:async({ca})=>{assert.equal(ca,undefined,"supported trust extends normal roots rather than replacing them");rootControls++;return 200;}};
  assert.equal(await probeRuntime({...plan,caFile:trustPath},trustIO),true);
  assert.equal(rootControls,5);

  const externalSeen=[];
  const externalIO={...io,resolver:{...io.resolver,resolve4:async host=>
    ["github.com","api.anthropic.com"].includes(host)?[policy.frontAddress]:io.resolver.resolve4(host)},
    getStatus:async({host,path})=>{
      if(["github.com","api.anthropic.com"].includes(host)) {assert.equal(path,"/");externalSeen.push(host);}
      return host==="api.anthropic.com"?404:200;
    }};
  const extended={...plan,policy:externalPolicy()};
  assert.equal(await probeRuntime(extended,externalIO),true);
  assert.deepEqual(externalSeen.sort(),["api.anthropic.com","github.com"]);
  await assert.rejects(()=>probeRuntime(extended,{...externalIO,getStatus:async({host})=>host==="api.anthropic.com"?503:200}),/external origin did not answer/);
  await assert.rejects(()=>probeRuntime(extended,{...externalIO,resolver:{...externalIO.resolver,
    resolve4:async host=>host==="github.com"?["140.82.112.3"]:externalIO.resolver.resolve4(host)}}),/external DNS answer bypasses proxy/);

  await assert.rejects(()=>probeRuntime(plan,{...io,tcpReachable:async()=>true}),/denied TCP endpoint is reachable/);
  await assert.rejects(()=>probeRuntime(plan,{...io,fs:{...io.fs,existsSync:path=>path==="/run/secrets"}}),/protected path exists inside probe/);
  await assert.rejects(()=>probeRuntime(plan,{...io,tlsReachable:async()=>true}),/human TLS origin is reachable/);
  await assert.rejects(()=>probeRuntime(plan,{...io,fs:{...io.fs,readdirSync:()=>["credential"]}}),/credential-free state or login directory is not empty/);
  await assert.rejects(()=>probeRuntime(plan,{...io,getStatus:async()=>503}),/allowed service did not answer 200/);
});

test("public CA and source mirrors cannot overlap writable state or be mounted writable", () => {
  for(const destination of ["/etc/agent-trust/ca.pem","/mirrors"]){
    const valid=composeBoundary();
    const mount={Type:"bind",Source:"/operator/public-input",Destination:destination,RW:false};
    valid.agent.Mounts.push({...mount});valid.approvedAgentMounts.push({...mount});
    assert.doesNotThrow(()=>assertComposeBoundary(valid));
    const writable=structuredClone(valid);writable.agent.Mounts.at(-1).RW=true;writable.approvedAgentMounts.at(-1).RW=true;
    assert.throws(()=>assertComposeBoundary(writable),/public input.*read-only/);
    const nested=structuredClone(valid);nested.agent.Mounts.at(-1).Source="/fixture/state/public-input";nested.approvedAgentMounts.at(-1).Source="/fixture/state/public-input";
    assert.throws(()=>assertComposeBoundary(nested),/public input.*protected/);
  }
});


test("an unavailable proxy policy source has a fixed path-free diagnostic", async t => {
  const {mkdtempSync,writeFileSync,rmSync}=await import("node:fs");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  const {fileURLToPath}=await import("node:url");
  const dir=mkdtempSync(join(tmpdir(),"oats-egress-policy-source-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const state=composeBoundary(), policy=proxyPolicy();
  const probeImage="sha256:"+"a".repeat(64),proxyImage="sha256:"+"b".repeat(64);
  const mounts=state.approvedAgentMounts.map((mount,index)=>{
    const source=join(dir,"mount-"+index);writeFileSync(source,"");return {...mount,Source:source};
  });
  const probe={...state.agent,Id:"probe-id",Image:probeImage,Mounts:mounts,State:{Running:true},
    Config:{Image:probeImage,User:"20001:20001",Entrypoint:["sleep"],Cmd:["infinity"],Env:[]}};
  const proxy={...state.egress,Id:"proxy-id",Image:proxyImage,State:{Running:true,Health:{Status:"healthy"}},
    Config:{Image:proxyImage,User:"10001:10001",Entrypoint:["node"],Env:[]},
    Mounts:[{Type:"bind",Source:join(dir,"withheld-private-path-marker"),Destination:"/etc/egress/policy.json",RW:false}]};
  proxy.HostConfig={...proxy.HostConfig,Sysctls:{"net.ipv4.ip_forward":"0"}};
  proxy.NetworkSettings=structuredClone(proxy.NetworkSettings);
  proxy.NetworkSettings.Networks.proof_agents.IPAddress=policy.frontAddress;
  const responses={
    "inspect probe":[probe],"inspect proxy":[proxy],
    "network inspect proof_agents":[{...state.agentsNetwork,Containers:{"probe-id":{},"proxy-id":{}}}],
    "network inspect proof_services":[state.servicesNetwork],
    ["image inspect "+probeImage]:[{Id:probeImage,Config:{Env:[]}}],
    ["image inspect "+proxyImage]:[{Id:proxyImage,Config:{Env:[],Entrypoint:["node"]}}],
  };
  writeFileSync(join(dir,"docker"),"#!/usr/bin/env node\nconst r="+JSON.stringify(responses)+";const k=process.argv.slice(2).join(' ');if(!Object.hasOwn(r,k))process.exit(2);process.stdout.write(JSON.stringify(r[k]));\n",{mode:0o755});
  const plan=join(dir,"plan.json");
  writeFileSync(plan,JSON.stringify({policy,probeContainer:"probe",proxyContainer:"proxy",agentsNetwork:"proof_agents",servicesNetwork:"proof_services",
    probeImage,proxyImage,uid:20001,gid:20001,approvedProbeMounts:mounts,protectedSources:state.protectedSources}));
  const child=spawn(process.execPath,[fileURLToPath(new URL("../container/agent/egress/probe-compose-boundary.mjs",import.meta.url)),"--plan",plan],{
    env:{...process.env,PATH:dir+":"+process.env.PATH},stdio:["ignore","pipe","pipe"],timeout:5000});
  let stdout="",stderr="";child.stdout.on("data",data=>stdout+=data);child.stderr.on("data",data=>stderr+=data);
  const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve)});
  assert.equal(code,1);assert.equal(stdout,"");
  assert.equal(stderr,"egress boundary: proxy policy source must resolve on the Docker engine host\n");
  assert.doesNotMatch(stderr,/withheld-private-path-marker/);
});
