import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { compilePolicy, loadPolicy } from "./policy.mjs";

function connectTlsPort() {
  return new Promise((resolve,reject) => {
    const socket = createConnection({host:"127.0.0.1",port:443});
    socket.setTimeout(1000,()=>{socket.destroy();reject(new Error("TLS listener timeout"));});
    socket.once("error",reject);
    socket.once("connect",()=>{socket.destroy();resolve();});
  });
}

export async function probeProxy({policy = loadPolicy(),resolve4,connect = connectTlsPort} = {}) {
  compilePolicy(policy);
  if (!resolve4) {
    const resolver = new Resolver({timeout:1000,tries:1});
    resolver.setServers(["127.0.0.1"]);
    resolve4 = name => resolver.resolve4(name);
  }
  const answers = await resolve4(new URL(policy.targets.aweb.origin).hostname);
  assert.ok(answers.length === 1 && answers[0] === policy.frontAddress,"egress DNS address differs from policy");
  let refused = false;
  try { await resolve4(`denied-${randomUUID()}.invalid`); }
  catch (error) { refused = error.code === "ENOTFOUND"; }
  assert.ok(refused,"egress DNS did not refuse an unlisted name");
  await connect();
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await probeProxy(); process.stdout.write("EGRESS_READY\n"); }
  catch { process.stderr.write("egress: health failed\n"); process.exitCode = 1; }
}
