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

export function docker(args) {
  const result = spawnSync("docker", args, { encoding:"utf8", timeout:45000, maxBuffer:1024*1024 });
  assert.equal(result.status, 0, "Docker boundary operation failed (output withheld)");
  return result.stdout;
}

const safeName = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
export function tcpFromNetwork({ image, network, address, port, payload = false }) {
  assert.ok(safeName(network), "control network name is invalid");
  return docker(["run","--rm","--network",network,"--user","10001:10001","--cap-drop","ALL","--security-opt","no-new-privileges:true","--read-only","--entrypoint","node",image,"--input-type=module","-e",tcpProgram,address,String(port),payload ? "canary" : "tcp"]).trim() === "CONNECTED";
}

export async function withGatewayCanary({ image, controlNetwork, gatewayAddress, controlAddress = gatewayAddress, expectedProbeHits = 0 }, run) {
  assert.ok(safeName(controlNetwork) && isIP(controlAddress) === 4 && isIP(gatewayAddress) === 4, "gateway control inputs are invalid");
  assert.ok(expectedProbeHits === 0 || expectedProbeHits === 1, "gateway expected hit count is invalid");
  const name = "oats-egress-canary-" + randomUUID();
  try {
    docker(["run","-d","--name",name,"--network","host","--user","10001:10001","--cap-drop","ALL","--security-opt","no-new-privileges:true","--read-only","--entrypoint","node",image,"--input-type=module","-e",`(${serveCanary.toString()})(process.argv[1],process.argv[2])`,controlAddress,gatewayAddress]);
    let port;
    const deadline = Date.now() + 10000;
    while (!port) {
      const match = docker(["logs",name]).match(/^CANARY_PORT=(\d+)$/m);
      if (match) port = Number(match[1]);
      else { assert.ok(Date.now() < deadline, "host canary did not start"); await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(tcpFromNetwork({ image, network:controlNetwork, address:controlAddress, port, payload:true }), "host canary positive control failed");
    try { await run({ address:gatewayAddress, port }); }
    finally {
      assert.ok(tcpFromNetwork({ image, network:controlNetwork, address:controlAddress, port, payload:true }), "host canary final positive control failed");
    }
    assert.equal(docker(["logs",name]).match(/^CANARY_HIT$/gm)?.length, 2 + expectedProbeHits, "forbidden probe reached the host canary");
  } finally {
    // This name is ours; never prune or remove a caller's container/network.
    docker(["rm","-f",name]);
  }
}

export async function checkDockerGateway({ image, controlNetwork, controlAddress, gatewayAddress, probeContainer, expectedReachable = false }) {
  assert.ok(safeName(probeContainer), "probe container name is invalid");
  assert.equal(typeof expectedReachable, "boolean", "gateway expected reachability is invalid");
  await withGatewayCanary({ image, controlNetwork, controlAddress, gatewayAddress, expectedProbeHits:expectedReachable ? 1 : 0 }, async ({address,port}) => {
    const answer = docker(["exec",probeContainer,"node","--input-type=module","-e",tcpProgram,address,String(port),"canary"]).trim();
    assert.equal(answer, expectedReachable ? "CONNECTED" : "DENIED", expectedReachable ? "plain probe cannot reach its on-link host gateway" : "probe can reach the host gateway");
  });
}
