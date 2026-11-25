/** The smoke and deployment adapters share these exact server/client bodies. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isIP } from "node:net";

export async function tcpReachable(address, port, { payload = false, timeoutMs = 1500 } = {}) {
  const { createConnection, isIP } = await import("node:net");
  if (isIP(address) !== 4 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid probe endpoint");
  return new Promise(resolve => {
    let ended = false;
    const socket = createConnection({ host:address, port });
    const finish = ok => { if (!ended) { ended = true; socket.destroy(); resolve(ok); } };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("connect", () => { if (!payload) finish(true); });
    socket.once("data", data => { if (payload) finish(data.toString() === "canary"); });
    socket.once("end", () => finish(false));
  });
}

/** Tri-state TCP control for split-host negatives. A refusal, an unreachable
 * host or network, or no answer inside the deadline is DENIED; every other
 * socket error is reported, never read as a denial. */
export async function tcpClassify(address, port, { timeoutMs = 3000 } = {}) {
  const { createConnection, isIP } = await import("node:net");
  if (isIP(address) !== 4 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid probe endpoint");
  return new Promise(resolve => {
    let ended = false;
    const socket = createConnection({ host:address, port });
    const finish = result => { if (!ended) { ended = true; socket.destroy(); resolve(result); } };
    socket.setTimeout(timeoutMs, () => finish("DENIED"));
    socket.once("connect", () => finish("CONNECTED"));
    socket.once("error", error => finish(["ECONNREFUSED","EHOSTUNREACH","ENETUNREACH"].includes(error.code) ? "DENIED"
      : "ERROR " + (/^[A-Z0-9_]{1,64}$/.test(error.code ?? "") ? error.code : "UNKNOWN")));
  });
}
const classifyLine = /^(?:CONNECTED|DENIED|ERROR [A-Z0-9_]{1,64})$/;

export async function serveCanary(address, probeAddress = address) {
  const { createServer } = await import("node:net");
  const onConnection = socket => {
    process.stdout.write("CANARY_HIT\n");
    socket.end("canary");
  };
  const listen = (server, port, host) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const control = createServer(onConnection);
  await listen(control, 0, address);
  const port = control.address().port;
  if (probeAddress !== address) {
    const probe = createServer(onConnection);
    try { await listen(probe, port, probeAddress); }
    catch (error) {
      // Isolated Docker bridges deliberately have no host gateway address.
      // Every other bind failure invalidates this proof, including a busy port.
      if (error.code !== "EADDRNOTAVAIL") throw error;
    }
  }
  process.stdout.write("CANARY_PORT=" + port + "\n");
}

export const tcpProgram = `const tcpReachable=(${tcpReachable.toString()});const ok=await tcpReachable(process.argv[1],Number(process.argv[2]),{payload:process.argv[3]==="canary"});process.stdout.write(ok?"CONNECTED\\n":"DENIED\\n");`;
export const classifyProgram = `const tcpClassify=(${tcpClassify.toString()});process.stdout.write(await tcpClassify(process.argv[1],Number(process.argv[2]))+"\\n");`;

function dockerResult(args) {
  try { return spawnSync("docker", args, { encoding:"utf8", timeout:45000, maxBuffer:1024*1024 }); }
  catch (error) { return {status:null,error,stdout:"",stderr:""}; }
}
const completed = result => result.status === 0 && !result.error && !result.signal;
export function docker(args) {
  const result = dockerResult(args);
  assert.ok(completed(result), "Docker boundary operation failed (output withheld)");
  return result.stdout;
}

/** One stderr receipt line per attempt, plus a leftover or unowned line when
 * absence was not verified. `label` names the calling check. */
export function reportReceipt(receipt, unowned, label = "egress boundary") {
  process.stderr.write(label+" receipt: "+JSON.stringify(receipt)+"\n");
  if (!receipt.absentVerified) {
    const classification=receipt.created && !unowned ? "leftover" : "unowned or unverified";
    process.stderr.write(label+" "+classification+": "+receipt.name+"\n");
  }
}

const safeName = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
export function assertNamePrefix(prefix) {
  assert.ok(prefix === undefined || (typeof prefix === "string" && prefix.length >= 2 && prefix.length <= 64
    && /^[A-Za-z0-9][A-Za-z0-9_.-]*-$/.test(prefix)), "container name prefix must be 2-64 Docker-safe characters ending in -");
}
const ownershipLabel = "org.oats.egress.attempt";
function ownedContainer({ image, network, namePrefix }, defaultPrefix) {
  assertNamePrefix(namePrefix);
  const receipt = {name:(namePrefix ?? defaultPrefix)+randomUUID(), image, network, created:false, absentVerified:false};
  return {receipt, token:randomUUID(), uncertain:false, collision:false};
}
function withReceipts(error, receipts, cleanup) {
  error.receipts = [...new Map([...receipts, ...(error.receipts || [])].map(receipt => [receipt.name, receipt])).values()];
  if (cleanup?.unownedNames) error.unownedNames=[...new Set([...(error.unownedNames || []),...cleanup.unownedNames])];
  return error;
}
function startContainer(attempt, mode, command) {
  const {receipt:r, token} = attempt;
  const result = dockerResult(["run",mode,"--name",r.name,"--label",ownershipLabel+"="+token,"--network",r.network,
    "--user","10001:10001","--cap-drop","ALL","--security-opt","no-new-privileges:true","--read-only","--entrypoint","node",r.image,...command]);
  if (completed(result)) { r.created = true; return result.stdout; }
  attempt.uncertain = true;
  // An explicit collision is never ours, even if the existing container has a
  // familiar label. A lost response instead requires an exact ownership read.
  attempt.collision = !result.error && !result.signal && /Conflict.*container name.*already in use/is.test(result.stderr || "");
  throw new Error((attempt.collision ? "container name collision: " : "container run failed: ")+r.name);
}
function releaseContainer(attempt) {
  const {receipt:r} = attempt;
  let failure;
  const fail = () => { failure ||= new Error("container cleanup or observation failed: "+r.name); };
  const verifyAbsent = () => {
    // Docker's name filter is a regexp: a dot in a caller prefix is literal.
    const exact = r.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const result = dockerResult(["ps","-a","--filter","name=^"+exact+"$","--format","{{.ID}}"]);
    if (!completed(result)) { fail(); return false; }
    const ids=result.stdout.trim();
    if (ids !== "" && !/^[a-f0-9]{12,64}$/.test(ids)) { fail(); return false; }
    r.absentVerified = ids === "";
    return r.absentVerified;
  };
  if (attempt.collision) { if (!verifyAbsent()) fail(); return failure; }
  // --rm usually leaves no container. Uncertain runs must inspect first: a
  // timeout or signal is no evidence of either creation or absence.
  if (!attempt.uncertain && verifyAbsent()) return failure;
  const result = dockerResult(["inspect",r.name]);
  let info;
  if (completed(result)) {
    try { const items=JSON.parse(result.stdout); if (Array.isArray(items) && items.length===1) info=items[0]; }
    catch { fail(); }
  } else fail();
  if (info?.Name === "/"+r.name && info.Config?.Labels?.[ownershipLabel] === attempt.token) {
    r.created = true;
    if (!completed(dockerResult(["rm","-f",r.name]))) fail();
  } else {
    fail();
    // Creation evidence is historical. A replaced name or failed ownership
    // observation must never be presented as an owned leftover.
    failure.unownedNames=[r.name];
  }
  if (!verifyAbsent()) fail();
  return failure;
}

/** Local mode returns `{reachable,receipt}`. Classify mode returns
 * `{result,receipt}`, where result is exactly CONNECTED, DENIED or
 * `ERROR <code>`; any other output, a non-zero exit or an unconfirmed cleanup
 * throws with the receipt. */
export function tcpFromNetwork({ image, network, address, port, payload = false, classify = false, namePrefix }) {
  let attempt, reachable, result, failure;
  try {
    assert.ok(safeName(network), "control network name is invalid");
    assert.ok(!(classify && payload), "classify mode takes no payload");
    attempt=ownedContainer({image,network,namePrefix},"oats-egress-tcp-");
    if (classify) {
      const output=startContainer(attempt,"--rm",["--input-type=module","-e",classifyProgram,address,String(port)]);
      assert.ok(output.endsWith("\n") && classifyLine.test(output.slice(0,-1)),"TCP classify control returned unexpected output");
      result=output.slice(0,-1);
    } else reachable=startContainer(attempt,"--rm",["--input-type=module","-e",tcpProgram,address,String(port),payload ? "canary" : "tcp"]).trim() === "CONNECTED";
  } catch (error) { failure=error; }
  const cleanup=attempt && releaseContainer(attempt);
  if (failure || cleanup) throw withReceipts(failure || cleanup,attempt ? [attempt.receipt] : [],cleanup);
  return classify ? {result,receipt:attempt.receipt} : {reachable,receipt:attempt.receipt};
}

export async function withGatewayCanary({ image, controlNetwork, gatewayAddress, controlAddress = gatewayAddress, expectedProbeHits = 0, namePrefix }, run) {
  let attempt;
  try {
    assert.ok(safeName(controlNetwork) && isIP(controlAddress) === 4 && isIP(gatewayAddress) === 4, "gateway control inputs are invalid");
    assert.ok(expectedProbeHits === 0 || expectedProbeHits === 1, "gateway expected hit count is invalid");
    attempt=ownedContainer({image,network:"host",namePrefix},"oats-egress-canary-");
  } catch (error) { throw withReceipts(error,[]); }
  const name=attempt.receipt.name, receipts=[attempt.receipt];
  const positiveControl = port => {
    const result=tcpFromNetwork({image,network:controlNetwork,address:controlAddress,port,payload:true,namePrefix});
    receipts.push(result.receipt);
    return result.reachable;
  };
  let failure;
  try {
    startContainer(attempt,"-d",["--input-type=module","-e",`(${serveCanary.toString()})(process.argv[1],process.argv[2])`,controlAddress,gatewayAddress]);
    let port;
    const deadline = Date.now() + 10000;
    while (!port) {
      const match = docker(["logs",name]).match(/^CANARY_PORT=(\d+)$/m);
      if (match) port = Number(match[1]);
      else { assert.ok(Date.now() < deadline, "host canary did not start"); await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(positiveControl(port), "host canary positive control failed");
    try { await run({ address:gatewayAddress, port }); }
    finally { assert.ok(positiveControl(port), "host canary final positive control failed"); }
    assert.equal(docker(["logs",name]).match(/^CANARY_HIT$/gm)?.length, 2 + expectedProbeHits, "forbidden probe reached the host canary");
  } catch (error) { failure=withReceipts(error,receipts); }
  const cleanup=releaseContainer(attempt);
  if (failure || cleanup) throw withReceipts(failure || cleanup,receipts,cleanup);
  return receipts;
}

export async function checkDockerGateway({ image, controlNetwork, controlAddress, gatewayAddress, probeContainer, expectedReachable = false, namePrefix }) {
  try {
    assert.ok(safeName(probeContainer), "probe container name is invalid");
    assert.equal(typeof expectedReachable, "boolean", "gateway expected reachability is invalid");
  } catch (error) { throw withReceipts(error,[]); }
  return withGatewayCanary({ image, controlNetwork, controlAddress, gatewayAddress, expectedProbeHits:expectedReachable ? 1 : 0, namePrefix }, async ({address,port}) => {
    const answer = docker(["exec",probeContainer,"node","--input-type=module","-e",tcpProgram,address,String(port),"canary"]).trim();
    assert.equal(answer, expectedReachable ? "CONNECTED" : "DENIED", expectedReachable ? "plain probe cannot reach its on-link host gateway" : "probe can reach the host gateway");
  });
}
