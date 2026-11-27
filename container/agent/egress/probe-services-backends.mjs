/** Services-host witness for a split agent/services pair. It runs on the
 * services host's Docker engine, selects the backend containers itself by
 * their Compose labels, and reads no credential, environment or log. */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertNamePrefix, docker, reportReceipt, tcpFromNetwork } from "./canary.mjs";
import { observeNetworks } from "./preflight-network.mjs";
import { admitRun, deploySource, interfaceAddresses } from "./split.mjs";

const safeName=value=>typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
// Only the fields the witness checks: never Config.Env, Cmd, Mounts or the
// healthcheck log in State.Health.Log.
const inspectTemplate='{"Id":{{json .Id}},"Image":{{json .Image}},"ConfigImage":{{json .Config.Image}},'
  +'"Project":{{json (index .Config.Labels "com.docker.compose.project")}},"Service":{{json (index .Config.Labels "com.docker.compose.service")}},'
  +'"ExposedPorts":{{json .Config.ExposedPorts}},"Status":{{json .State.Status}},"Health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},'
  +'"NetworkMode":{{json .HostConfig.NetworkMode}},"PortBindings":{{json .HostConfig.PortBindings}},"Ports":{{json .NetworkSettings.Ports}},'
  +'"Networks":{{json .NetworkSettings.Networks}}}';

function admitWitnessPlan(plan) {
  if (plan?.schema !== 1) {
    const schema = plan?.schema;
    const found = schema === undefined ? "none" : typeof schema === "number" ? String(schema) : `invalid ${typeof schema}`;
    throw Object.assign(new Error(`E_EGRESS_PLAN_SCHEMA: this witness reads plan schema 1; found ${found}; regenerate the plan with schema: 1`), { code: "E_EGRESS_PLAN_SCHEMA" });
  }
  const fields=["schema","run","servicesAddress","composeProject","policy","backends","canaryImage"];
  assert.ok(Object.keys(plan).sort().join(",") === [...fields,...(Object.hasOwn(plan,"namePrefix") ? ["namePrefix"] : [])].sort().join(","),
    "witness plan has an invalid field set");
  assertNamePrefix(plan.namePrefix);
  assert.ok(typeof plan.servicesAddress === "string" && isIP(plan.servicesAddress) === 4, "witness plan services-host address must be one IPv4 literal");
  assert.ok(typeof plan.composeProject === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(plan.composeProject), "witness plan Compose project name is invalid");
  assert.ok(typeof plan.canaryImage === "string" && /^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/.test(plan.canaryImage),
    "witness plan canary image must be pinned by digest");
  const backends=plan.backends;
  // Bundled PostgreSQL: both containers. External PostgreSQL: Redis alone.
  assert.ok(Array.isArray(backends) && ["redis","postgres,redis"].includes(backends.map(item=>item?.role).sort().join(","))
    && backends.every(item=>Object.keys(item).sort().join(",") === "port,role,service" && safeName(item.service)
      && Number.isInteger(item.port) && item.port > 0 && item.port <= 65535),
  "witness backends must be exactly [redis] or [postgres, redis], each {role,service,port}");
  const run=admitRun(plan.run,plan.policy);
  return {run,backends:[...backends].sort((left,right)=>left.role.localeCompare(right.role))};
}

function witnessBackend(plan,backend,receipts) {
  const labels=["--filter",`label=com.docker.compose.project=${plan.composeProject}`,"--filter",`label=com.docker.compose.service=${backend.service}`];
  const ids=docker(["ps","--no-trunc",...labels,"--format","{{.ID}}"]).split("\n").filter(Boolean);
  const selection=found=>`exactly one running container labelled ${plan.composeProject}/${backend.service} is required for ${backend.role}; found ${found}`;
  assert.ok(ids.length === 1,selection(ids.length));
  assert.ok(/^[a-f0-9]{64}$/.test(ids[0]),"Docker returned an invalid container ID (output withheld)");
  let info;
  try { info=JSON.parse(docker(["inspect","--format",inspectTemplate,ids[0]])); }
  catch { throw new Error("Docker returned invalid inspect output (output withheld)"); }
  // A container whose labels changed after selection no longer matches.
  assert.ok(info.Id === ids[0] && info.Project === plan.composeProject && info.Service === backend.service,selection(0));
  assert.ok(info.Status !== "running" || info.Health !== null,`${backend.role} has no healthcheck; add one to its Compose service`);
  assert.ok(info.Status === "running" && info.Health === "healthy",`${backend.role} must be running and healthy`);
  assert.ok(info.NetworkMode !== "host",`${backend.role} uses host network mode`);
  const bindings=Object.values(info.PortBindings ?? {}).flat(), live=Object.values(info.Ports ?? {}).flat();
  assert.ok(bindings.filter(Boolean).length === 0 && live.filter(Boolean).length === 0,`${backend.role} publishes a port on the services host`);
  // Docker reads a port without a protocol as TCP; Compose records expose that way.
  const exposed=info.ExposedPorts ?? {};
  assert.ok(Object.hasOwn(exposed,`${backend.port}/tcp`) || Object.hasOwn(exposed,String(backend.port)),`${backend.role} does not expose its declared port`);
  const networks=Object.entries(info.Networks ?? {});
  assert.ok(!info.NetworkMode.startsWith("container:") && networks.length > 0
    && networks.every(([name,endpoint])=>safeName(name) && isIP(endpoint?.IPAddress) === 4),
  `${backend.role} has no own network for its control`);
  for (const [network,endpoint] of networks) {
    const {result,receipt}=tcpFromNetwork({image:plan.canaryImage,network,address:endpoint.IPAddress,port:backend.port,classify:true,namePrefix:plan.namePrefix});
    receipts.push(receipt);
    assert.ok(receipt.absentVerified && result === "CONNECTED",`${backend.role} backend control from its own network was not CONNECTED`);
  }
  return {role:backend.role,service:backend.service,containerId:info.Id,image:info.ConfigImage,imageId:info.Image,
    networks:networks.map(([name])=>name),port:backend.port,health:"healthy",published:false,control:"CONNECTED"};
}

export async function probeServicesBackends(plan) {
  const receipts=[];
  let unownedNames=[];
  try {
    const {run,backends}=admitWitnessPlan(plan);
    const sourceCommit=deploySource(fileURLToPath(new URL("..",import.meta.url)),"egress/probe-services-backends.mjs");
    // An observation, not a refusal: a NAT'd public address is legitimately absent.
    const hostAddresses=interfaceAddresses(observeNetworks().links);
    const engineVersion=docker(["version","--format","{{.Server.Version}}"]).trim();
    assert.ok(/^[0-9][0-9A-Za-z.+~-]{0,63}$/.test(engineVersion),"Docker returned an invalid engine version (output withheld)");
    const records=backends.map(backend=>witnessBackend(plan,backend,receipts));
    return {passed:true,run,sourceCommit,servicesAddress:plan.servicesAddress,canaryImage:plan.canaryImage,
      observed:{composeProject:plan.composeProject,hostAddresses,addressOnHost:hostAddresses.includes(plan.servicesAddress),engineVersion},
      backends:records,receipts};
  } catch (error) {
    receipts.splice(0,receipts.length,...new Map([...receipts,...(error.receipts || [])].map(receipt=>[receipt.name,receipt])).values());
    error.receipts=receipts;
    unownedNames=error.unownedNames || [];
    throw error;
  } finally {
    for (const receipt of receipts) reportReceipt(receipt,unownedNames.includes(receipt.name),"services witness");
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const args=process.argv.slice(2), jsonMode=args.includes("--json");
  if (jsonMode) args.splice(args.indexOf("--json"),1);
  try {
    assert.ok(args.length===2 && args[0]==="--plan","pass the derived witness plan with --plan");
    const stat=statSync(args[1]);assert.ok(stat.isFile() && stat.size<=128*1024,"witness plan file is invalid");
    let plan;try {plan=JSON.parse(readFileSync(args[1],"utf8"));} catch {throw new Error("witness plan JSON is invalid (values withheld)");}
    const result=await probeServicesBackends(plan);
    process.stdout.write(jsonMode ? JSON.stringify(result)+"\n" : "OATS_SERVICES_WITNESS_PASS\n");
  } catch(error) {
    if(jsonMode) process.stdout.write(JSON.stringify({passed:false,receipts:error.receipts || [],error:"services witness refused"})+"\n");
    process.stderr.write("services witness: "+String(error.message).split("\n")[0]+"\n");
    process.exitCode=1;
  }
}
