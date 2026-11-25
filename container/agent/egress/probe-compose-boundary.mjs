/** Compose adapter for the shared in-container boundary body. It inspects the
 * caller's actual probe/network and creates only its own temporary canary. */
import assert from "node:assert/strict";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compilePolicy } from "./policy.mjs";
import { assertComposeBoundary, assertPublicMountSource, boundaryControls, ipv4Gateway } from "./boundary.mjs";
import { assertNamePrefix, docker, tcpFromNetwork, withGatewayCanary } from "./canary.mjs";
import { runtimeProgram } from "./probe-runtime.mjs";
import { observeNetworks } from "./preflight-network.mjs";
import { admitRemoteBackends, admitRun, deploySource } from "./split.mjs";
import { agentEnvironment } from "../accept.mjs";

function json(args) {
  const text=docker(args);
  try { return JSON.parse(text); } catch { throw new Error("Docker returned invalid JSON (output withheld)"); }
}
const safeName=value=>typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);

export async function probeComposeBoundary(plan) {
  const receipts=[];
  let unownedNames=[];
  try {
    if (plan?.schema !== 1 && plan?.schema !== 2) {
      const schema = plan?.schema;
      const found = schema === undefined ? "none" : typeof schema === "number" ? String(schema) : `invalid ${typeof schema}`;
      throw Object.assign(new Error(`E_EGRESS_PLAN_SCHEMA: this probe reads runtime plan schema 1 (local) or 2 (split); found ${found}; regenerate the plan with schema: 1 or schema: 2`), { code: "E_EGRESS_PLAN_SCHEMA" });
    }
    return await runBoundary(plan,receipts,plan.schema === 2 ? admitSplit(plan) : undefined);
  }
  catch (error) {
    receipts.splice(0,receipts.length,...new Map([...receipts,...(error.receipts || [])].map(receipt=>[receipt.name,receipt])).values());
    error.receipts=receipts;
    unownedNames=error.unownedNames || [];
    throw error;
  } finally {
    // Report partial attempts on refusal as well as fully cleaned-up runs.
    for (const receipt of receipts) reportReceipt(receipt,unownedNames.includes(receipt.name));
  }
}
function reportReceipt(receipt, unowned) {
  process.stderr.write("egress boundary receipt: "+JSON.stringify(receipt)+"\n");
  if (!receipt.absentVerified) {
    const classification=receipt.created && !unowned ? "leftover" : "unowned or unverified";
    process.stderr.write("egress boundary "+classification+": "+receipt.name+"\n");
  }
}
/** Schema 2 (split hosts): the run binding, this deploy copy's source commit
 * and the services-host tuples, refused before any container is inspected. */
function admitSplit(plan) {
  assert.ok(!Object.hasOwn(plan,"deniedBackends"),"plan schema 2 replaces deniedBackends with remoteBackends");
  compilePolicy(plan.policy);
  const run=admitRun(plan.run,plan.policy);
  const sourceCommit=deploySource(fileURLToPath(new URL("..",import.meta.url)),"egress/probe-compose-boundary.mjs");
  return {run,sourceCommit,...admitRemoteBackends(plan.remoteBackends,plan.policy,observeNetworks())};
}
/** Each tuple from the proxy's outward bridge. Every tuple must be DENIED,
 * except that an external PostgreSQL may also answer CONNECTED there. */
function outwardBridge(plan,split,receipts) {
  return split.tuples.map(tuple=>{
    const {result,receipt}=tcpFromNetwork({image:plan.proxyImage,network:plan.servicesNetwork,address:tuple.address,port:tuple.port,classify:true,namePrefix:plan.namePrefix});
    receipts.push(receipt);
    const required=!tuple.external;
    assert.ok(receipt.absentVerified && (result === "DENIED" || (!required && result === "CONNECTED")),
      "outward bridge did not get DENIED from a services-host backend");
    return {role:tuple.role,port:tuple.port,vantage:"outward-bridge",result,required};
  });
}
async function runBoundary(plan,receipts,split) {
  assertNamePrefix(plan.namePrefix);
  compilePolicy(plan.policy);
  for(const key of ["probeContainer","proxyContainer","agentsNetwork","servicesNetwork"])assert.ok(safeName(plan[key]),"runtime resource name is invalid");
  for(const image of [plan.probeImage,plan.proxyImage])assert.ok(typeof image === "string" && /^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/.test(image),"reviewed probe and proxy images must be pinned by digest");
  assert.ok(Number.isInteger(plan.uid) && plan.uid>0 && Number.isInteger(plan.gid) && plan.gid>0,"configured probe UID/GID is invalid");
  const probe=json(["inspect",plan.probeContainer])[0],proxy=json(["inspect",plan.proxyContainer])[0];
  const agentsNetwork=json(["network","inspect",plan.agentsNetwork])[0],servicesNetwork=json(["network","inspect",plan.servicesNetwork])[0];
  // This adapter runs on the Docker engine host. Resolve approved and actual
  // bind sources there; a source symlink must not evade protected-root checks.
  const canonicalMounts=mounts=>mounts.map(mount=>({...mount,Source:realpathSync(mount.Source)}));
  let actualMounts,approvedMounts;
  try {actualMounts=canonicalMounts(probe.Mounts);approvedMounts=canonicalMounts(plan.approvedProbeMounts);} catch {throw new Error("probe source paths must resolve on the Docker engine host");}
  assertComposeBoundary({agent:{...probe,Mounts:actualMounts},egress:proxy,agentsNetwork,servicesNetwork,approvedAgentMounts:approvedMounts,protectedSources:plan.protectedSources});
  assert.equal(probe.State.Running,true,"credential-free probe must be running");
  assert.equal(proxy.State.Running,true,"owned proxy must be running");
  assert.equal(proxy.State.Health?.Status,"healthy","owned proxy must be healthy before runtime proof");
  assert.deepEqual(probe.Config.Entrypoint,["sleep"],"probe must use the inert sleep entrypoint");
  assert.deepEqual(probe.Config.Cmd,["infinity"],"probe must not start agents or host run");
  assert.equal(probe.Config.User,`${plan.uid}:${plan.gid}`,"probe must use the configured non-root UID/GID");
  for(const [info,reference] of [[probe,plan.probeImage],[proxy,plan.proxyImage]]) {
    const image=json(["image","inspect",reference])[0];
    assert.equal(info.Config.Image,reference,"container image reference differs from reviewed source");
    assert.equal(info.Image,image.Id,"container image content differs from reviewed source");
    const expectedEnv = agentEnvironment(image.Config.Env||[], info === probe && plan.caFile === "/etc/agent-trust/ca.pem");
    assert.deepEqual([...(info.Config.Env||[])].sort(),[...expectedEnv].sort(),"probe or proxy environment differs from reviewed image (values withheld)");
    assert.ok((info.HostConfig.Devices||[]).length===0 && (info.HostConfig.DeviceRequests||[]).length===0,"probe or proxy has an unexpected device");
  }
  assert.deepEqual(proxy.Config.Entrypoint,json(["image","inspect",plan.proxyImage])[0].Config.Entrypoint,"proxy must run its reviewed entrypoint");
  assert.equal(proxy.HostConfig.Sysctls?.["net.ipv4.ip_forward"],"0","proxy must not forward IP packets");
  const endpoints=Object.keys(agentsNetwork.Containers||{}).sort();
  assert.deepEqual(endpoints,[probe.Id,proxy.Id].sort(),"only probe and proxy may join the agents network during preflight");
  assert.equal(proxy.NetworkSettings.Networks[plan.agentsNetwork].IPAddress,plan.policy.frontAddress,"proxy address differs from runtime policy");
  assert.ok(proxy.Mounts.length===1 && proxy.Mounts[0].Type==="bind" && proxy.Mounts[0].Destination==="/etc/egress/policy.json" && proxy.Mounts[0].RW===false,
    "proxy must mount only its read-only public policy");
  let policySource;
  try {policySource=realpathSync(proxy.Mounts[0].Source);}
  catch {throw new Error("proxy policy source must resolve on the Docker engine host");}
  assertPublicMountSource(policySource,plan.protectedSources,"proxy");
  const livePolicy=json(["exec",plan.proxyContainer,"node","-e","process.stdout.write(require('node:fs').readFileSync('/etc/egress/policy.json','utf8'))"]);
  assert.deepEqual(livePolicy,plan.policy,"live proxy policy differs from derived policy");
  const report = boundaryControls(plan);
  const controls=[];
  // Split-host backends live on another engine: no live positive control here.
  if(!split) {
    assert.ok(Array.isArray(plan.deniedBackends) && plan.deniedBackends.length===2
      && plan.deniedBackends.map(item=>item.role).sort().join(",")==="postgres,redis","backend control inventory is incomplete");
    for(const backend of plan.deniedBackends) {
      assert.ok(plan.policy.deniedAddresses.includes(backend.address),"backend control is absent from denied policy inventory");
      controls.push({...backend,network:backend.controlNetwork||plan.servicesNetwork});
    }
  }
  for(const target of Object.values(plan.policy.targets))for(const address of target.addresses)controls.push({address,port:443,network:plan.servicesNetwork});
  for(const control of controls)assert.ok(isIP(control.address)===4 && Number.isInteger(control.port) && control.port>0 && control.port<=65535 && safeName(control.network)
    && control.network!==plan.agentsNetwork,"positive control endpoint or network is invalid");
  const gateway=ipv4Gateway(agentsNetwork,"agents"),controlAddress=ipv4Gateway(servicesNetwork,"services");
  const verifyControls=()=>{
    const checked=new Set();
    for(const control of controls) {
      const key=[control.network,control.address,control.port].join(":");if(checked.has(key))continue;checked.add(key);
      const result=tcpFromNetwork({image:plan.proxyImage,...control,namePrefix:plan.namePrefix});
      receipts.push(result.receipt);
      assert.ok(result.reachable,"live upstream or backend positive control failed");
    }
  };
  verifyControls();
  const outward=split && outwardBridge(plan,split,receipts);
  const backends=split ? {remoteEndpoints:split.tuples.map(({role,address,port})=>({role,address,port}))} : {deniedBackends:plan.deniedBackends};
  receipts.push(...await withGatewayCanary({image:plan.proxyImage,controlNetwork:plan.servicesNetwork,controlAddress,gatewayAddress:gateway,namePrefix:plan.namePrefix},async endpoint=>{
    const program=runtimeProgram({policy:plan.policy,allowedPaths:plan.allowedPaths,...backends,
      uid:plan.uid,gid:plan.gid,caFile:plan.caFile,mirrors:approvedMounts.some(mount=>mount.Destination === "/mirrors"),
      protectedPaths:plan.protectedPaths||[],gateway:endpoint});
    const result=spawnSync("docker",["exec","-i",plan.probeContainer,"node","--input-type=module","-"],{input:program,encoding:"utf8",timeout:45000,maxBuffer:1024*1024});
    if(result.status!==0) {
      const first=(result.stderr||"").split("\n")[0];
      throw new Error(/^egress boundary: [A-Za-z0-9 /:._-]{1,160}$/.test(first)?first:"in-container boundary probe failed (output withheld)");
    }
    assert.equal(result.stdout.trim(),"OATS_EGRESS_BOUNDARY_PASS","in-container boundary probe did not confirm all checks");
  }));
  verifyControls();
  for (const group of ["universal", "declared"]) for (const control of report[group])
    process.stderr.write(`egress boundary ${group}: ${control}\n`);
  if(!split) return {passed:true,receipts};
  // The runtime body refused anything but DENIED from the isolated agent.
  const results=split.tuples.flatMap((tuple,index)=>[
    {role:tuple.role,port:tuple.port,vantage:"isolated-agent",result:"DENIED",required:true},outward[index]]);
  return {passed:true,mode:"split",receipts,run:split.run,sourceCommit:split.sourceCommit,
    remote:{servicesAddress:split.servicesAddress,vantage:["isolated-agent","outward-bridge"],results}};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const args=process.argv.slice(2), jsonMode=args.includes("--json");
  if (jsonMode) args.splice(args.indexOf("--json"),1);
  try {
    assert.ok(args.length===2 && args[0]==="--plan","pass the derived runtime plan with --plan");
    const stat=statSync(args[1]);assert.ok(stat.isFile() && stat.size<=128*1024,"runtime plan file is invalid");
    let plan;try {plan=JSON.parse(readFileSync(args[1],"utf8"));} catch {throw new Error("runtime plan JSON is invalid (values withheld)");}
    const result=await probeComposeBoundary(plan);
    process.stdout.write(jsonMode ? JSON.stringify(result)+"\n" : "OATS_EGRESS_BOUNDARY_PASS\n");
  } catch(error) {
    const result={passed:false,receipts:error.receipts || [],error:"boundary probe refused"};
    if(jsonMode) process.stdout.write(JSON.stringify(result)+"\n");
    process.stderr.write("egress boundary: "+String(error.message).split("\n")[0]+"\n");
    process.exitCode=1;
  }
}
