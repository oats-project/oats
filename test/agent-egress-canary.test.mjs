import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeComposeBoundary } from "../container/agent/egress/probe-compose-boundary.mjs";
import { syncBuiltinESMExports } from "node:module";
import { tcpFromNetwork, withGatewayCanary, checkDockerGateway, tcpProgram } from "../container/agent/egress/canary.mjs";

const image="sha256:"+"a".repeat(64), network="fixture_services";
const options={image,network,address:"172.27.91.10",port:443};
const gateway={image,controlNetwork:network,controlAddress:"172.27.91.1",gatewayAddress:"172.27.90.1"};
const uuid="[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";

// Only the external Docker CLI is doubled. Every command must match its wire
// contract; its in-memory inventory stands in for the daemon, not our helpers.
function recordingDocker(t, mode={}) {
  const calls=[],inventory=new Map(),errors=[];
  let runs=0,observations=0;
  const original=childProcess.spawnSync;
  const ok=stdout=>({status:0,signal:null,stdout,stderr:""});
  childProcess.spawnSync=(command,args,settings)=>{
    calls.push(args);
    try {
      assert.equal(command,"docker");
      assert.equal(settings.encoding,"utf8");assert.equal(settings.timeout,45000);
      if(Object.hasOwn(mode.responses || {},JSON.stringify(args)))return ok(JSON.stringify(mode.responses[JSON.stringify(args)]));
      if(args[0]==="exec" && args[1]==="-i") {
        assert.deepEqual(args,["exec","-i","fixture_probe","node","--input-type=module","-"]);
        assert.match(settings.input,/probeRuntime/);
        return ok("OATS_EGRESS_BOUNDARY_PASS\n");
      }
      if(args[0]==="run") {
        runs++;
        const detached=args[1]==="-d",name=args[3],label=args[5],net=args[7];
        assert.match(name,new RegExp("^"+(mode.prefix || (detached?"oats-egress-canary-":"oats-egress-tcp-")).replaceAll(".","\\.")+uuid+"$"));
        assert.match(label,new RegExp("^org\\.oats\\.egress\\.attempt="+uuid+"$"));
        const suffix=detached?args.slice(-2):args.slice(-3);
        const program=args[20];
        assert.deepEqual(args,["run",detached?"-d":"--rm","--name",name,"--label",label,"--network",net,"--user","10001:10001","--cap-drop","ALL","--security-opt","no-new-privileges:true","--read-only","--entrypoint","node",image,"--input-type=module","-e",program,...suffix]);
        assert.equal(net,detached?"host":network);
        if(detached)assert.match(program,/serveCanary/);else assert.equal(program,tcpProgram);
        assert.ok(!inventory.has(name));
        inventory.set(name,{Name:"/"+name,Config:{Labels:{"org.oats.egress.attempt":label.split("=")[1]}}});
        if(mode.collision && runs===(mode.failRun || 1)) {
          inventory.get(name).Config.Labels["org.oats.egress.attempt"]="someone-else";
          return {...ok(""),status:125,stderr:'Conflict. The container name "/'+name+'" is already in use by container "foreign".'};
        }
        if(mode.noCreate && runs===1){inventory.delete(name);return {...ok(""),status:null,error:{code:"ETIMEDOUT"}};}
        if(mode.foreign && runs===1)inventory.get(name).Config.Labels["org.oats.egress.attempt"]="someone-else";
        if((mode.timeout || mode.signal || mode.foreign) && runs===1)return {...ok(""),status:null,signal:"SIGTERM",...(mode.signal?{}:{error:Object.assign(new Error("timed out"),{code:"ETIMEDOUT"})})};
        if(!detached)inventory.delete(name);
        return ok(detached?"container-id\n":mode.denied?"DENIED\n":"CONNECTED\n");
      }
      if(args[0]==="ps") {
        assert.deepEqual(args,["ps","-a","--filter",args[3],"--format","{{.ID}}"]);
        const matches=[...inventory.keys()].filter(name=>new RegExp(args[3].slice(5)).test(name));
        assert.ok(args[3].startsWith("name=^") && args[3].endsWith("$"));
        observations++;
        if(mode.badListing)return ok("malformed listing\n");
        if(mode.observation || (mode.firstObservation && observations===1))return {...ok(""),status:1,stderr:"daemon unavailable"};
        return ok(matches.map(()=>"a".repeat(12)).join("\n"));
      }
      if(args[0]==="inspect") {
        assert.equal(args.length,2);
        if(mode.inspectFailure || ((mode.noCreate || mode.firstObservation) && !inventory.has(args[1])))return {...ok(""),status:1};
        assert.ok(inventory.has(args[1]),"inspect must target the exact allocated name");
        if (mode.takeover) inventory.get(args[1]).Config.Labels["org.oats.egress.attempt"]="someone-else";
        return ok(mode.badInspect?"not json":JSON.stringify([inventory.get(args[1])]));
      }
      if(args[0]==="rm") {
        assert.deepEqual(args,["rm","-f",args[2]]);
        assert.ok(inventory.has(args[2]));
        assert.notEqual(inventory.get(args[2]).Config.Labels["org.oats.egress.attempt"],"someone-else");
        if(mode.removeFailure)return {...ok(""),status:1};
        inventory.delete(args[2]);return ok(args[2]+"\n");
      }
      if(args[0]==="logs") {
        assert.equal(args.length,2);assert.ok(inventory.has(args[1]));
        return ok("CANARY_PORT=31415\n"+"CANARY_HIT\n".repeat(mode.expectedHits ?? 2));
      }
      if(args[0]==="exec") {
        assert.deepEqual(args,["exec","fixture_probe","node","--input-type=module","-e",tcpProgram,gateway.gatewayAddress,"31415","canary"]);
        return ok(mode.reachable?"CONNECTED\n":"DENIED\n");
      }
      assert.fail("unknown Docker argv: "+JSON.stringify(args));
    } catch(error) {errors.push(error);throw error;}
  };
  syncBuiltinESMExports();
  t.after(()=>{childProcess.spawnSync=original;syncBuiltinESMExports();assert.deepEqual(errors,[]);});
  return {calls,inventory};
}
function receipt(value,prefix,net=network) {
  assert.deepEqual(Object.keys(value).sort(),["absentVerified","created","image","name","network"]);
  assert.ok(value.name.startsWith(prefix));assert.equal(value.image,image);assert.equal(value.network,net);
}

test("TCP defaults name every run and return reachable plus a verified receipt", t=>{
  const double=recordingDocker(t);
  const result=tcpFromNetwork(options);
  assert.equal(result.reachable,true);receipt(result.receipt,"oats-egress-tcp-");
  assert.equal(result.receipt.created,true);assert.equal(result.receipt.absentVerified,true);
  assert.equal(double.inventory.size,0);
});
test("TCP denial remains an explicit false reachability result",t=>{
  recordingDocker(t,{denied:true});assert.equal(tcpFromNetwork(options).reachable,false);
});
test("custom prefixes are used for every canary and TCP control and escaped for exact absence",async t=>{
  const double=recordingDocker(t,{prefix:"lab.test-"});
  const receipts=await withGatewayCanary({...gateway,namePrefix:"lab.test-"},endpoint=>assert.deepEqual(endpoint,{address:gateway.gatewayAddress,port:31415}));
  assert.equal(receipts.length,3);assert.equal(new Set(receipts.map(r=>r.name)).size,3);
  for(const [i,r] of receipts.entries()){receipt(r,"lab.test-",i===0?"host":network);assert.equal(r.created,true);assert.equal(r.absentVerified,true);}
  for(const args of double.calls.filter(args=>args[0]==="ps"))assert.match(args[3],/^name=\^lab\\\.test-/);
  const labels=double.calls.filter(args=>args[0]==="run").map(args=>args[5]);assert.equal(new Set(labels).size,3);
  assert.equal(double.inventory.size,0);
});
test("gateway default name is unchanged and receipts pass through checkDockerGateway",async t=>{
  recordingDocker(t);
  const receipts=await checkDockerGateway({...gateway,probeContainer:"fixture_probe"});
  assert.equal(receipts.length,3);receipt(receipts[0],"oats-egress-canary-","host");
});
test("invalid prefixes refuse before any Docker command",async t=>{
  const double=recordingDocker(t);
  for(const namePrefix of ["-","a","-a-","bad space-","x/",null,"a".repeat(64)+"-","line-\n"]){
    assert.throws(()=>tcpFromNetwork({...options,namePrefix}),error=>{assert.match(error.message,/prefix/);assert.deepEqual(error.receipts,[]);return true;});
    await assert.rejects(withGatewayCanary({...gateway,namePrefix},()=>{}),error=>{assert.match(error.message,/prefix/);assert.deepEqual(error.receipts,[]);return true;});
  }
  assert.deepEqual(double.calls,[]);
});
test("a reported name collision never removes the existing container",t=>{
  const double=recordingDocker(t,{collision:true});
  assert.throws(()=>tcpFromNetwork(options),error=>{
    assert.match(error.message,/collision/);assert.equal(error.receipts.length,1);
    assert.equal(error.receipts[0].created,false);assert.equal(error.receipts[0].absentVerified,false);return true;
  });
  assert.ok(!double.calls.some(args=>args[0]==="rm"));assert.equal(double.inventory.size,1);
});
for(const mode of [{timeout:true},{signal:true}])test("uncertain run inspects ownership, removes exactly its name, verifies absence and still refuses "+JSON.stringify(mode),t=>{
  const double=recordingDocker(t,mode);
  assert.throws(()=>tcpFromNetwork(options),error=>{
    const [r]=error.receipts;receipt(r,"oats-egress-tcp-");assert.equal(r.created,true);assert.equal(r.absentVerified,true);
    assert.deepEqual(double.calls.slice(1).map(args=>args[0]),["inspect","rm","ps"]);
    assert.deepEqual(double.calls[1],["inspect",r.name]);assert.deepEqual(double.calls[2],["rm","-f",r.name]);return true;
  });
});
test("a lost collision response cannot authorize removal by name",t=>{
  const double=recordingDocker(t,{foreign:true});
  assert.throws(()=>tcpFromNetwork(options),error=>{assert.equal(error.receipts[0].created,false);assert.equal(error.receipts[0].absentVerified,false);return true;});
  assert.ok(!double.calls.some(args=>args[0]==="rm"));
});
test("failed absence observations refuse even if run itself succeeded",t=>{
  const double=recordingDocker(t,{observation:true,inspectFailure:true});
  assert.throws(()=>tcpFromNetwork(options),error=>{const [r]=error.receipts;assert.equal(r.created,true);assert.equal(r.absentVerified,false);assert.ok(error.message.includes(r.name));return true;});
  assert.ok(!double.calls.some(args=>args[0]==="rm"));
});
for(const mode of [{timeout:true,inspectFailure:true},{timeout:true,badInspect:true},{timeout:true,removeFailure:true}])test("uncertain lifecycle with failed inspection or cleanup refuses "+JSON.stringify(mode),t=>{
  const double=recordingDocker(t,mode);
  assert.throws(()=>tcpFromNetwork(options),error=>{assert.equal(error.receipts[0].absentVerified,false);return true;});
  if(!mode.removeFailure)assert.ok(!double.calls.some(args=>args[0]==="rm"));
});
test("gateway assertion keeps its semantics and all cleanup receipts on failure",async t=>{
  const double=recordingDocker(t,{reachable:true});
  await assert.rejects(checkDockerGateway({...gateway,probeContainer:"fixture_probe"}),error=>{
    assert.equal(error.code,"ERR_ASSERTION");assert.equal(error.actual,"CONNECTED");assert.equal(error.expected,"DENIED");
    assert.equal(error.receipts.length,3);assert.ok(error.receipts.every(r=>r.created&&r.absentVerified));return true;
  });
  assert.equal(double.inventory.size,0);
});

function runtimeFixture(t) {
  const dir=mkdtempSync(join(tmpdir(),"oats-canary-receipts-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const mounts=["/state","/etc/agent-login","/etc/agent-ssh/authorized_keys","/etc/resolv.conf"].map((Destination,index)=>{
    const Source=join(dir,"mount-"+index);writeFileSync(Source,"");return {Type:"bind",Source,Destination,RW:index===0};
  });
  const policy={roles:["aweb"],frontAddress:"172.27.90.2",privateIngressAddresses:["172.27.91.10"],deniedAddresses:["172.27.91.11","172.27.91.12"],
    targets:{aweb:{origin:"https://aweb.example.invalid",addresses:["172.27.91.10"]}}};
  const HostConfig={NetworkMode:"fixture_agents",Privileged:false,ReadonlyRootfs:true,CapDrop:["ALL"],SecurityOpt:["no-new-privileges:true"],PidMode:"",IpcMode:"private"};
  const probe={Id:"probe-id",Image:image,State:{Running:true},HostConfig,Mounts:mounts,
    Config:{Image:image,User:"20001:20001",Entrypoint:["sleep"],Cmd:["infinity"],Env:[]},NetworkSettings:{Networks:{fixture_agents:{NetworkID:"agents-id"}}}};
  const Source=join(dir,"policy.json");writeFileSync(Source,JSON.stringify(policy));
  const proxy={Id:"proxy-id",Image:image,State:{Running:true,Health:{Status:"healthy"}},
    HostConfig:{...HostConfig,Sysctls:{"net.ipv4.ip_forward":"0"}},Mounts:[{Type:"bind",Source,Destination:"/etc/egress/policy.json",RW:false}],
    Config:{Image:image,User:"10001:10001",Entrypoint:["node"],Env:[]},
    NetworkSettings:{Networks:{fixture_agents:{NetworkID:"agents-id",IPAddress:policy.frontAddress},fixture_services:{NetworkID:"services-id"}}}};
  const responses={};
  for(const [args,value] of [
    [["inspect","fixture_probe"],[probe]],[["inspect","fixture_proxy"],[proxy]],
    [["network","inspect","fixture_agents"],[{Id:"agents-id",Internal:true,EnableIPv6:false,Options:{"com.docker.network.bridge.gateway_mode_ipv4":"isolated"},IPAM:{Config:[{Gateway:gateway.gatewayAddress}]},Containers:{"probe-id":{},"proxy-id":{}}}]],
    [["network","inspect",network],[{Id:"services-id",Internal:false,EnableIPv6:false,IPAM:{Config:[{Gateway:gateway.controlAddress}]}}]],
    [["image","inspect",image],[{Id:image,Config:{Env:[],Entrypoint:["node"]}}]],
    [["exec","fixture_proxy","node","-e","process.stdout.write(require('node:fs').readFileSync('/etc/egress/policy.json','utf8'))"],policy],
  ])responses[JSON.stringify(args)]=value;
  return {dir,responses,plan:{schema:1,policy,probeContainer:"fixture_probe",proxyContainer:"fixture_proxy",agentsNetwork:"fixture_agents",servicesNetwork:network,
    probeImage:image,proxyImage:image,uid:20001,gid:20001,approvedProbeMounts:mounts,protectedSources:[join(dir,"private-key")],allowedPaths:{aweb:"/ready"},
    deniedBackends:[{role:"postgres",address:policy.deniedAddresses[0],port:5432},{role:"redis",address:policy.deniedAddresses[1],port:6379}]}};
}
test("exported Compose probe returns every helper receipt and passes the plan prefix to all runs",async t=>{
  const fixture=runtimeFixture(t);
  recordingDocker(t,{responses:fixture.responses,prefix:"caller-"});
  const result=await probeComposeBoundary({...fixture.plan,namePrefix:"caller-"});
  assert.equal(result.passed,true);assert.equal(result.receipts.length,9);
  assert.ok(result.receipts.every(r=>r.name.startsWith("caller-")&&r.created&&r.absentVerified));
});
test("Compose refusal carries the failed attempt plus previously collected receipts",async t=>{
  const fixture=runtimeFixture(t);
  recordingDocker(t,{responses:fixture.responses,collision:true});
  await assert.rejects(probeComposeBoundary(fixture.plan),error=>{
    assert.equal(error.receipts.length,1);assert.equal(error.receipts[0].created,false);assert.equal(error.receipts[0].absentVerified,false);return true;
  });
});
test("CLI refusal distinguishes confirmed leftovers from unowned or unverified names in both modes",t=>{
  const fixture=runtimeFixture(t), planFile=join(fixture.dir,"plan.json"),preload=join(fixture.dir,"docker-double.mjs");
  writeFileSync(planFile,JSON.stringify(fixture.plan));
  const imports=`import assert from 'node:assert/strict';import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {tcpProgram} from ${JSON.stringify(new URL("../container/agent/egress/canary.mjs",import.meta.url).href)};`;
  for (const mode of [{collision:true},{timeout:true,inspectFailure:true},{timeout:true,removeFailure:true}]) {
    writeFileSync(preload,imports+`const image=${JSON.stringify(image)},network=${JSON.stringify(network)},gateway=${JSON.stringify(gateway)},uuid=${JSON.stringify(uuid)};`+recordingDocker.toString()+`\nrecordingDocker({after:fn=>process.on('exit',fn)},${JSON.stringify({responses:fixture.responses,...mode})});`);
    const cli=fileURLToPath(new URL("../container/agent/egress/probe-compose-boundary.mjs",import.meta.url));
    for(const flags of [[],["--json"]]){
      const result=childProcess.spawnSync(process.execPath,["--import",preload,cli,"--plan",planFile,...flags],{encoding:"utf8",timeout:5000});
      assert.equal(result.status,1);assert.equal(result.signal,null);
      const line=result.stderr.split("\n").find(line=>line.startsWith("egress boundary receipt: "));
      assert.ok(line,result.stderr);const r=JSON.parse(line.slice("egress boundary receipt: ".length));
      assert.equal(r.created,Boolean(mode.removeFailure));assert.equal(r.absentVerified,false);
      const classification=r.created ? "leftover" : "unowned or unverified";
      assert.ok(result.stderr.includes("egress boundary "+classification+": "+r.name+"\n"));
      if (!r.created) assert.doesNotMatch(result.stderr,/egress boundary leftover:/);
      if(flags.length)assert.deepEqual(JSON.parse(result.stdout),{passed:false,receipts:[r],error:"boundary probe refused"});
      else assert.equal(result.stdout,"");
      assert.doesNotMatch(result.stdout,/foreign|Conflict/);
    }
  }
});

test("timeout without confirmed creation can verify absence but still refuses",t=>{
  recordingDocker(t,{noCreate:true});
  assert.throws(()=>tcpFromNetwork(options),error=>{assert.equal(error.receipts[0].created,false);assert.equal(error.receipts[0].absentVerified,true);return true;});
});
test("a failed observation refuses even after owned cleanup and a successful final absence check",async t=>{
  const double=recordingDocker(t,{firstObservation:true});
  await assert.rejects(withGatewayCanary(gateway,()=>{}),error=>{
    assert.equal(error.receipts.length,2);assert.ok(error.receipts.every(r=>r.absentVerified));return true;
  });
  assert.equal(double.inventory.size,0);
});
test("malformed absence output is refused",t=>{
  recordingDocker(t,{badListing:true,inspectFailure:true});
  assert.throws(()=>tcpFromNetwork(options),error=>{assert.equal(error.receipts[0].absentVerified,false);return true;});
});
test("a detached canary timeout also returns its cleanup receipt",async t=>{
  const double=recordingDocker(t,{timeout:true});
  await assert.rejects(withGatewayCanary(gateway,()=>assert.fail("uncertain canary must not run the probe")),error=>{
    assert.equal(error.receipts.length,1);receipt(error.receipts[0],"oats-egress-canary-","host");
    assert.equal(error.receipts[0].created,true);assert.equal(error.receipts[0].absentVerified,true);return true;
  });
  assert.equal(double.inventory.size,0);
});

test("Compose aggregates earlier upstream receipts with an uncertain nested control",async t=>{
  const fixture=runtimeFixture(t);
  const double=recordingDocker(t,{responses:fixture.responses,collision:true,failRun:5});
  await assert.rejects(probeComposeBoundary(fixture.plan),error=>{
    assert.equal(error.receipts.length,5);assert.equal(new Set(error.receipts.map(r=>r.name)).size,5);
    assert.ok(error.receipts.slice(0,4).every(r=>r.created&&r.absentVerified));
    assert.equal(error.receipts[4].created,false);assert.equal(error.receipts[4].absentVerified,false);return true;
  });
  assert.equal(double.inventory.size,1);
});
test("CLI success returns the full receipts JSON and retains the default token",t=>{
  const fixture=runtimeFixture(t),planFile=join(fixture.dir,"plan.json"),preload=join(fixture.dir,"docker-double.mjs");
  writeFileSync(planFile,JSON.stringify({...fixture.plan,namePrefix:"cli.test-"}));
  writeFileSync(preload,`import assert from 'node:assert/strict';import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {tcpProgram} from ${JSON.stringify(new URL("../container/agent/egress/canary.mjs",import.meta.url).href)};`
    +`const image=${JSON.stringify(image)},network=${JSON.stringify(network)},gateway=${JSON.stringify(gateway)},uuid=${JSON.stringify(uuid)};`+recordingDocker.toString()
    +`\nrecordingDocker({after:fn=>process.on('exit',fn)},${JSON.stringify({responses:fixture.responses,prefix:"cli.test-"})});`);
  for(const flags of [[],["--json"]]){
    const result=childProcess.spawnSync(process.execPath,["--import",preload,fileURLToPath(new URL("../container/agent/egress/probe-compose-boundary.mjs",import.meta.url)),"--plan",planFile,...flags],{encoding:"utf8",timeout:5000});
    assert.equal(result.status,0,result.stderr);
    const receipts=result.stderr.split("\n").filter(line=>line.startsWith("egress boundary receipt: ")).map(line=>JSON.parse(line.slice("egress boundary receipt: ".length)));
    assert.equal(receipts.length,9);assert.ok(receipts.every(r=>r.created&&r.absentVerified&&r.name.startsWith("cli.test-")));
    if(flags.length)assert.deepEqual(JSON.parse(result.stdout),{passed:true,receipts});else assert.equal(result.stdout,"OATS_EGRESS_BOUNDARY_PASS\n");
    assert.doesNotMatch(result.stderr,/egress boundary leftover:/);
  }
});

test("a replaced name keeps historical creation evidence but is diagnosed as unowned",async t=>{
  const fixture=runtimeFixture(t);
  const double=recordingDocker(t,{responses:fixture.responses,takeover:true});
  const lines=[],write=process.stderr.write;
  process.stderr.write=line=>{lines.push(line);return true;};
  t.after(()=>{process.stderr.write=write;});
  await assert.rejects(probeComposeBoundary(fixture.plan),error=>{
    const r=error.receipts.find(r=>r.network==="host");
    assert.equal(r.created,true);assert.equal(r.absentVerified,false);
    assert.ok(lines.includes("egress boundary unowned or unverified: "+r.name+"\n"));
    assert.ok(!lines.includes("egress boundary leftover: "+r.name+"\n"));return true;
  });
  assert.ok(!double.calls.some(args=>args[0]==="rm"));
});
