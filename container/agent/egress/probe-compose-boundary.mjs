/** Compose adapter for the shared in-container boundary body. It inspects the
 * caller's actual probe/network and creates only its own temporary canary. */
import assert from "node:assert/strict";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { compilePolicy } from "./policy.mjs";
import { assertComposeBoundary, assertPublicMountSource } from "./boundary.mjs";
import { docker, tcpFromNetwork, withGatewayCanary } from "./canary.mjs";
import { runtimeProgram } from "./probe-runtime.mjs";
import { agentEnvironment } from "../accept.mjs";

function json(args) {
  const text=docker(args);
  try { return JSON.parse(text); } catch { throw new Error("Docker returned invalid JSON (output withheld)"); }
}
const safeName=value=>typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);

export async function probeComposeBoundary(plan) {
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
  assertPublicMountSource(realpathSync(proxy.Mounts[0].Source),plan.protectedSources,"proxy");
  const livePolicy=json(["exec",plan.proxyContainer,"node","-e","process.stdout.write(require('node:fs').readFileSync('/etc/egress/policy.json','utf8'))"]);
  assert.deepEqual(livePolicy,plan.policy,"live proxy policy differs from derived policy");
  assert.ok(Array.isArray(plan.deniedBackends) && plan.deniedBackends.length===2
    && plan.deniedBackends.map(item=>item.role).sort().join(",")==="postgres,redis","backend control inventory is incomplete");
  const controls=[];
  for(const backend of plan.deniedBackends) {
    assert.ok(plan.policy.deniedAddresses.includes(backend.address),"backend control is absent from denied policy inventory");
    controls.push({...backend,network:backend.controlNetwork||plan.servicesNetwork});
  }
  for(const target of Object.values(plan.policy.targets))for(const address of target.addresses)controls.push({address,port:443,network:plan.servicesNetwork});
  for(const control of controls)assert.ok(isIP(control.address)===4 && Number.isInteger(control.port) && control.port>0 && control.port<=65535 && safeName(control.network)
    && control.network!==plan.agentsNetwork,"positive control endpoint or network is invalid");
  const verifyControls=()=>{
    const checked=new Set();
    for(const control of controls) {
      const key=[control.network,control.address,control.port].join(":");if(checked.has(key))continue;checked.add(key);
      assert.ok(tcpFromNetwork({image:plan.proxyImage,...control}),"live upstream or backend positive control failed");
    }
  };
  verifyControls();
  const gateway=agentsNetwork.IPAM?.Config?.find(item=>isIP(item.Gateway)===4)?.Gateway;
  const controlAddress=servicesNetwork.IPAM?.Config?.find(item=>isIP(item.Gateway)===4)?.Gateway;
  assert.ok(gateway,"agents network needs an explicit IPv4 IPAM gateway; configure ipam.config gateway before probing");
  assert.ok(controlAddress,"services network needs an identified IPv4 gateway for the owned host canary");
  await withGatewayCanary({image:plan.proxyImage,controlNetwork:plan.servicesNetwork,controlAddress,gatewayAddress:gateway},async endpoint=>{
    const program=runtimeProgram({policy:plan.policy,allowedPaths:plan.allowedPaths,deniedBackends:plan.deniedBackends,
      uid:plan.uid,gid:plan.gid,caFile:plan.caFile,mirrors:approvedMounts.some(mount=>mount.Destination === "/mirrors"),
      protectedPaths:plan.protectedPaths||[],gateway:endpoint});
    const result=spawnSync("docker",["exec","-i",plan.probeContainer,"node","--input-type=module","-"],{input:program,encoding:"utf8",timeout:45000,maxBuffer:1024*1024});
    if(result.status!==0) {
      const first=(result.stderr||"").split("\n")[0];
      throw new Error(/^egress boundary: [A-Za-z0-9 /:._-]{1,160}$/.test(first)?first:"in-container boundary probe failed (output withheld)");
    }
    assert.equal(result.stdout.trim(),"OATS_EGRESS_BOUNDARY_PASS","in-container boundary probe did not confirm all checks");
  });
  verifyControls();
  return true;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    assert.ok(process.argv.length===4 && process.argv[2]==="--plan","pass the derived runtime plan with --plan");
    const stat=statSync(process.argv[3]);assert.ok(stat.isFile() && stat.size<=128*1024,"runtime plan file is invalid");
    let plan;try {plan=JSON.parse(readFileSync(process.argv[3],"utf8"));} catch {throw new Error("runtime plan JSON is invalid (values withheld)");}
    await probeComposeBoundary(plan);
    process.stdout.write("OATS_EGRESS_BOUNDARY_PASS\n");
  } catch(error) {process.stderr.write("egress boundary: "+String(error.message).split("\n")[0]+"\n");process.exitCode=1;}
}
