/** One runtime ingress proof for both deployment wrappers. Backend access-log
 * controls prevent a backend-generated rejection from certifying non-delivery. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as connectHttp2 } from "node:http2";
import { isIP } from "node:net";
import { checkServerIdentity, connect as connectTls, rootCertificates } from "node:tls";
import { pathToFileURL } from "node:url";
import { compilePolicy, originHost } from "./policy.mjs";

export function statusOf({ protocol, address, port, sni, authority, expectedHost, path, ca }) {
  return new Promise((resolve, reject) => {
    let finished = false, request, session, socket, agent, tlsEstablished = false, receivedResponse = false;
    const done = (error, status) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request?.destroy(); session?.destroy(); socket?.destroy(); agent?.destroy();
      if (error) {
        error.tlsEstablished = tlsEstablished;
        error.beforeHttpResponse = !receivedResponse;
        error.peerHandshakeRefusal = !tlsEstablished && !receivedResponse
          && error.code === "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR";
        reject(error);
      } else resolve(status);
    };
    const timer = setTimeout(() => done(Object.assign(new Error("timeout"), { code:"EGRESS_PROBE_TIMEOUT" })), 3000);
    const tlsOptions = { host:address, port, servername:sni, ca, rejectUnauthorized:true,
      // Malicious negative probes deliberately decouple SNI and authority. Keep
      // chain validation and check the certificate against a known service name.
      checkServerIdentity: (_host, cert) => checkServerIdentity(expectedHost, cert) };
    const consume = (stream, status) => {
      let bytes = 0;
      stream.on("data", data => { bytes += data.length; if (bytes > 65536) done(new Error("response too large")); });
      stream.once("error", error => done(error));
      stream.once("end", () => done(null, status()));
      stream.resume();
    };
    try {
      socket = connectTls({ ...tlsOptions, ALPNProtocols:protocol === "h2" ? ["h2"] : ["http/1.1"] });
      socket.once("error", error => done(error));
      // Wait for authenticated TLS before writing HTTP. Otherwise an early peer
      // alert can surface as a generic HTTP write EPROTO instead of a TLS alert.
      socket.once("secureConnect", () => {
        tlsEstablished = true;
        try {
          if (protocol === "h1") {
            agent = new HttpsAgent({ keepAlive:false });
            agent.createConnection = () => socket;
            request = httpsRequest({ hostname:expectedHost, port, method:"GET", path, agent, headers:{ Host:authority } }, response => {
              receivedResponse = true; consume(response, () => response.statusCode);
            });
            request.once("error", error => done(error)); request.end();
          } else {
            session = connectHttp2("https://" + expectedHost, { createConnection:() => socket });
            session.once("error", error => done(error));
            request = session.request({ ":method":"GET", ":path":path, ":authority":authority });
            let status;
            request.once("response", headers => { receivedResponse = true; status = headers[":status"]; });
            consume(request, () => status); request.end();
          }
        } catch (error) { done(error); }
      });
    } catch (error) { done(error); }
  });
}

function backendLog(path) {
  try {
    const stat = statSync(path);
    assert.ok(stat.isFile() && stat.size <= 8 * 1024 * 1024);
    return readFileSync(path, "utf8");
  } catch { throw new Error("backend audit log is unavailable or too large"); }
}

export async function probeIngress({ address, port = 443, requestOrigin, humanOrigin, requestLog, humanLog,
  ca, path = "/ready", requestPath, humanPath = path, auditPath, policy, routeLogs, exchange = statusOf }) {
  const requestHost = originHost(requestOrigin), humanHost = originHost(humanOrigin);
  assert.ok(requestHost !== humanHost && isIP(address) === 4, "ingress probe needs distinct origins and an IPv4 address");
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "ingress probe port is invalid");
  let routes;
  if (policy !== undefined || routeLogs !== undefined) {
    assert.ok(policy && routeLogs && typeof routeLogs === "object" && !Array.isArray(routeLogs),"policy and per-route audit inputs are required together");
    compilePolicy(policy);
    assert.equal(policy.targets.signer.origin,requestOrigin,"signer origin differs from derived policy");
    assert.equal(policy.humanOrigin,humanOrigin,"human origin differs from derived policy");
    assert.ok(policy.targets.signer.addresses.includes(address),"ingress address is not a pinned signer address");
    assert.deepEqual(Object.keys(routeLogs).sort(),Object.keys(policy.targets).sort(),"per-route audit inputs must name exactly the policy roles");
    routes=Object.entries(policy.targets).map(([role,target])=>{
      const audit=routeLogs[role];
      assert.ok(audit && typeof audit === "object" && !Array.isArray(audit)
        && Object.keys(audit).sort().join(",")==="log,path" && typeof audit.log === "string" && audit.log.length>0,"per-route audit input is invalid");
      return {role,origin:target.origin,host:originHost(target.origin),addresses:target.addresses,path:audit.path,log:audit.log};
    });
    const signer=routes.find(route=>route.role==="signer");
    if(requestLog !== undefined)assert.equal(requestLog,signer.log,"signer backend log differs from per-route audit input");
    if(requestPath !== undefined)assert.equal(requestPath,signer.path,"signer control path differs from per-route audit input");
  } else routes=[{role:"signer",origin:requestOrigin,host:requestHost,addresses:[address],path:requestPath ?? path,log:requestLog}];
  for (const controlPath of [auditPath,humanPath,...routes.map(route=>route.path)]) {
    assert.ok(typeof controlPath === "string" && controlPath.startsWith("/") && !controlPath.startsWith("//")
      && !/[\\\u0000-\u0020\u007f#]/.test(controlPath), "ingress probe path is invalid");
    assert.equal(new URL(controlPath,requestOrigin).origin,new URL(requestOrigin).origin,"ingress probe path is invalid");
  }
  const logs=[...new Set([humanLog,...routes.map(route=>route.log)])];
  for(const log of logs)backendLog(log);
  const matched=[],forbidden=[];
  const send=async(protocol,route,targetAddress,sni,authority,kind)=>{
    const id="oats-egress-"+randomUUID();
    if(kind==="forbidden")forbidden.push(id);else matched.push({id,log:kind==="human"||kind==="human-coverage"?humanLog:route.log});
    const coverage=kind==="coverage"||kind==="human-coverage";
    const controlPath=kind==="forbidden"||coverage?auditPath:kind==="human"?humanPath:route.path;
    const url=new URL(controlPath,route.origin);url.searchParams.set("oats_egress_probe",id);
    try {
      const status=await exchange({protocol,address:targetAddress,port,sni,authority,
        expectedHost:sni===humanHost?humanHost:route.host,path:url.pathname+url.search,ca});
      if(coverage)assert.ok(Number.isInteger(status)&&status>=200&&status<500,"backend audit coverage control did not succeed");
      else assert.equal(status,kind==="forbidden"?421:200,
        kind==="forbidden"?"ingress did not refuse a forbidden authority":"matched ingress control did not succeed");
    } catch(error) {
      const refused=new Set(["ECONNRESET","EPIPE","ERR_SSL_TLSV1_UNRECOGNIZED_NAME","ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE","ERR_SSL_TLSV1_ALERT_UNRECOGNIZED_NAME"]);
      const noServiceSni=sni==="unlisted.egress-probe.invalid"||sni==="";
      const peerInternalRefusal=noServiceSni&&error.code==="ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR"&&error.peerHandshakeRefusal===true;
      // The shipped Node/OpenSSL spells handshake_failure with SSL/TLS.
      // It is a pre-TLS refusal only for the explicit no-service SNI probes.
      const peerHandshakeFailure=noServiceSni&&["ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE","ERR_SSL_TLS_ALERT_HANDSHAKE_FAILURE"].includes(error.code)
        &&error.tlsEstablished===false&&error.beforeHttpResponse===true;
      const otherRefusal=refused.has(error.code)&&error.beforeHttpResponse===true&&(noServiceSni||error.tlsEstablished===true);
      if(kind!=="forbidden"||(!peerInternalRefusal&&!peerHandshakeFailure&&!otherRefusal))throw error;
    }
  };
  for(const protocol of ["h1","h2"]) {
    // Coverage controls establish logging at every backend for the same path
    // used by negatives. Their 4xx responses never replace readiness controls.
    for(const route of routes)for(const targetAddress of route.addresses)
      await send(protocol,route,targetAddress,route.host,route.host,"coverage");
    await send(protocol,routes.find(route=>route.role==="signer"),address,humanHost,humanHost,"human-coverage");
    const unknownChecked=new Set();
    for(const route of routes)for(const targetAddress of route.addresses) {
      await send(protocol,route,targetAddress,route.host,route.host,"matched");
      for(const authority of [humanHost,humanHost+":443",route.host+":444",route.host+".unlisted.invalid"])
        await send(protocol,route,targetAddress,route.host,authority,"forbidden");
      if(!unknownChecked.has(targetAddress)) {
        unknownChecked.add(targetAddress);
        for(const sni of ["unlisted.egress-probe.invalid",""])await send(protocol,route,targetAddress,sni,humanHost,"forbidden");
      }
    }
    // Each backend needs a later matched record to flush preceding deliveries.
    for(const route of routes)for(const targetAddress of route.addresses)
      await send(protocol,route,targetAddress,route.host,route.host,"matched");
    for(const route of routes)for(const targetAddress of route.addresses)
      await send(protocol,route,targetAddress,route.host,route.host,"coverage");
    await send(protocol,routes.find(route=>route.role==="signer"),address,humanHost,humanHost,"human-coverage");
    await send(protocol,routes.find(route=>route.role==="signer"),address,humanHost,humanHost,"human");
  }
  const deadline=Date.now()+2000;
  let texts;
  for(;;) {
    texts=new Map(logs.map(log=>[log,backendLog(log)]));
    if(matched.every(({id,log})=>texts.get(log).includes(id)))break;
    assert.ok(Date.now()<deadline,"backend audit did not confirm the matched controls");
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(forbidden.every(id=>[...texts.values()].every(text=>!text.includes(id))),"forbidden probe reached a backend");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const flags = { "--address":"address", "--request-origin":"requestOrigin", "--human-origin":"humanOrigin",
      "--request-log":"requestLog", "--human-log":"humanLog", "--ca-file":"caFile", "--path":"path",
      "--request-path":"requestPath", "--human-path":"humanPath", "--policy":"policyFile", "--route-logs":"routeLogsFile", "--audit-path":"auditPath" };
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = flags[process.argv[index]], value = process.argv[index + 1];
      assert.ok(key && !Object.hasOwn(options, key) && value && !value.startsWith("--"), "ingress probe arguments are invalid");
      options[key] = value;
    }
    assert.ok(options.policyFile && options.routeLogsFile && options.auditPath,"ingress admission requires the derived policy and audit inputs");
    const readJson=(file,max)=>{const stat=statSync(file);assert.ok(stat.isFile()&&stat.size<=max,"probe input file is invalid");return JSON.parse(readFileSync(file,"utf8"));};
    if(options.policyFile)options.policy=readJson(options.policyFile,65536);
    if(options.routeLogsFile)options.routeLogs=readJson(options.routeLogsFile,128*1024);
    if (options.caFile) {assert.ok(statSync(options.caFile).size<=65536,"public CA input is too large");options.ca = [...rootCertificates,readFileSync(options.caFile)];}
    await probeIngress(options);
    process.stdout.write("OATS_EGRESS_INGRESS_PASS\n");
  } catch {
    process.stderr.write("egress: ingress authority or backend non-delivery proof failed (values withheld)\n");
    process.exitCode = 1;
  }
}
