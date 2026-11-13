/** One credential-free in-container boundary body, emitted unchanged by either
 * platform adapter. The plan is derived runtime data, not operator config. */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tcpReachable } from "./canary.mjs";
import { compilePolicy } from "./policy.mjs";
import { publicCACheck, mirrorsCheck } from "../accept.mjs";

export async function httpsStatus({host,path,timeoutMs,frontAddress,ca,port=443}) {
    const https = await import("node:https");
    return new Promise((resolve,reject) => {
      const request = https.request({hostname:host,servername:host,port,path,method:"GET",ca,agent:false,family:4,
        lookup:(_name,options,done)=>options.all?done(null,[{address:frontAddress,family:4}]):done(null,frontAddress,4),
      }, response => {
        let bytes=0;
        response.on("data",data=>{bytes+=data.length;if(bytes>65536)request.destroy(new Error("response too large"))});
        response.once("error",reject);response.once("end",()=>resolve(response.statusCode));response.resume();
      });
      const deadline=timeoutMs?setTimeout(()=>request.destroy(new Error("external origin timeout")),timeoutMs):undefined;
      request.once("close",()=>clearTimeout(deadline));
      request.setTimeout(timeoutMs??2000,()=>request.destroy(new Error("allowed service timeout")));
      request.once("error",reject);request.end();
    });
}

export async function probeRuntime(plan, io = {}) {
  const fs = io.fs || await import("node:fs");
  const net = await import("node:net");
  const expect = (ok, label) => { if (!ok) { const error = new Error(label); error.name = "BoundaryFailure"; throw error; } };
  const roles = ["aweb","secrets","logs","signer","registry"];
  const {policy,allowedPaths,deniedBackends,gateway,caFile} = plan;
  expect(policy && roles.every(role => policy.targets?.[role]) && net.isIP(policy.frontAddress) === 4, "runtime policy is incomplete");
  const identity = io.identity ? io.identity() : { uid:process.getuid(), gid:process.getgid() };
  expect(plan.uid > 0 && plan.gid > 0 && identity.uid === plan.uid && identity.gid === plan.gid, "probe identity differs from configured non-root user");
  const status = fs.readFileSync("/proc/self/status","utf8");
  expect(/^CapEff:\s+0+$/m.test(status) && /^NoNewPrivs:\s+1$/m.test(status), "probe capabilities or privilege guard differs");
  const resolv = fs.readFileSync("/etc/resolv.conf","utf8");
  const nameservers = [...resolv.matchAll(/^\s*nameserver\s+(\S+)/gm)].map(match => match[1]);
  expect(nameservers.length === 1 && nameservers[0] === policy.frontAddress, "probe resolver differs from owned proxy");
  for (const path of ["/run/secrets","/var/run/docker.sock","/run/docker.sock","/run/containerd/containerd.sock",
    "/etc/agent-login/claude-token","/state/home/.awid/controllers","/state/home/.awid/team-keys",...(plan.protectedPaths || [])]) {
    expect(typeof path === "string" && path.startsWith("/"), "protected path input is invalid");
    expect(!fs.existsSync(path), "protected path exists inside probe");
  }
  expect(fs.readdirSync("/state").length === 0 && fs.readdirSync("/etc/agent-login").length === 0,
    "credential-free state or login directory is not empty");
  let ca;
  if (caFile) {
    expect(fs.statSync(caFile).isFile() && fs.statSync(caFile).size <= 65536,"public CA material is invalid");
    ca = fs.readFileSync(caFile);
    expect(ca.length <= 65536 && ca.toString().includes("BEGIN CERTIFICATE") && !ca.toString().includes("PRIVATE KEY"), "public CA material is invalid");
    if (caFile === "/etc/agent-trust/ca.pem") {
      const env = io.environment || process.env;
      expect(env.SSL_CERT_FILE === caFile && env.NODE_EXTRA_CA_CERTS === caFile,"public CA trust settings differ");
      try { publicCACheck(fs, await import("node:crypto")); } catch { expect(false,"public CA material or read-only mount is invalid"); }
      // The approved image input extends the process's normal trust store.
      // Explicit `ca` would replace it and reject publicly certified targets.
      ca = undefined;
    }
  }
  if (plan.mirrors) {
    try { mirrorsCheck(fs); } catch { expect(false,"mirrors are not readable and read-only"); }
  }
  const dns = await import("node:dns/promises");
  const resolver = io.resolver || new dns.Resolver({ timeout:1000, tries:1 });
  resolver.setServers([policy.frontAddress]);
  const getStatus = io.getStatus || (options=>httpsStatus({...options,frontAddress:policy.frontAddress,ca}));
  for (const role of roles) {
    const target=policy.targets[role], origin=new URL(target.origin), path=allowedPaths?.[role];
    expect(origin.protocol === "https:" && !origin.port && !origin.username && !origin.password, "allowed origin is invalid");
    expect(typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !/[\\\u0000-\u0020\u007f#]/.test(path)
      && new URL(path,origin).origin === origin.origin, "allowed control path is invalid");
    let answers;
    try { answers=await resolver.resolve4(origin.hostname); } catch { expect(false,"allowed DNS lookup failed"); }
    expect(answers.length === 1 && answers[0] === policy.frontAddress,"allowed DNS answer bypasses proxy");
    let code;
    try { code=await getStatus({host:origin.hostname,path,ca}); } catch { expect(false,"allowed service request failed"); }
    expect(code === 200,"allowed service did not answer 200");
  }
  // Public services supply no operator backend log. These checks establish
  // observed proxy DNS and end-to-end TLS/HTTP, not public non-delivery proof.
  for (const target of Object.values(policy.externalTargets||{})) {
    const host=new URL(target.origin).hostname;
    let answers,code;
    try {answers=await resolver.resolve4(host);} catch {expect(false,"external DNS lookup failed");}
    expect(answers.length===1 && answers[0]===policy.frontAddress,"external DNS answer bypasses proxy");
    try {code=await getStatus({host,path:"/",timeoutMs:7000});} catch {expect(false,"external origin request failed");}
    expect(code>=200 && code<500,"external origin did not answer with a verified TLS control");
  }
  for (const record of policy.authorityRecords) {
    let answers;
    try { answers=await resolver.resolveTxt(record.name); } catch { expect(false,"namespace authority lookup failed"); }
    expect(answers.length === 1 && answers[0].join("") === record.text,"namespace authority differs from provisioned profile");
  }
  const humanHost=new URL(policy.humanOrigin).hostname;
  const {randomUUID}=await import("node:crypto");
  for (const host of [humanHost,"denied-"+randomUUID()+".invalid"]) {
    let denied=false;
    try { await resolver.resolve4(host); } catch (error) { denied=error.code === "ENOTFOUND"; }
    expect(denied,"unlisted DNS name was not refused");
  }
  const tlsReachable=io.tlsReachable || (async () => {
    const tls=await import("node:tls");
    return new Promise((resolve,reject)=>{
      const socket=tls.connect({host:policy.frontAddress,port:443,servername:humanHost,ca,rejectUnauthorized:true});
      socket.setTimeout(2000,()=>{socket.destroy();reject(new Error("human TLS denial timeout"))});
      socket.once("secureConnect",()=>{socket.destroy();resolve(true)});
      socket.once("error",error=>{
        const refused=["ECONNRESET","EPIPE","ERR_SSL_TLSV1_UNRECOGNIZED_NAME","ERR_SSL_TLSV1_ALERT_UNRECOGNIZED_NAME","ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE","ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR"];
        if(refused.includes(error.code))resolve(false);else reject(new Error("human TLS refusal was not established"));
      });
    });
  });
  let humanReachable;
  try { humanReachable=await tlsReachable(); } catch { expect(false,"human TLS refusal was not established"); }
  expect(!humanReachable,"human TLS origin is reachable");
  expect(Array.isArray(deniedBackends) && deniedBackends.length === 2
    && deniedBackends.map(item=>item.role).sort().join(",") === "postgres,redis", "live backend control inventory is incomplete");
  const endpoints=[];
  for(const backend of deniedBackends) {
    expect(policy.deniedAddresses.includes(backend.address),"backend control is not in denied policy inventory");
    endpoints.push(backend);
  }
  for(const target of Object.values(policy.targets)) for(const address of target.addresses)endpoints.push({address,port:443});
  endpoints.push(gateway);
  const tcp=io.tcpReachable || tcpReachable;
  const checked=new Set();
  for(const endpoint of endpoints) {
    expect(endpoint && net.isIP(endpoint.address) === 4 && Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port <= 65535,"denied endpoint input is invalid");
    const key=endpoint.address+":"+endpoint.port;if(checked.has(key))continue;checked.add(key);
    expect(!await tcp(endpoint.address,endpoint.port,{timeoutMs:800}),"denied TCP endpoint is reachable");
  }
  return true;
}

export function runtimeProgram(plan) {
  compilePolicy(plan.policy);
  return `const httpsStatus=(${httpsStatus.toString()});const tcpReachable=(${tcpReachable.toString()});const publicCACheck=(${publicCACheck.toString()});const mirrorsCheck=(${mirrorsCheck.toString()});const probeRuntime=(${probeRuntime.toString()});try{await probeRuntime(JSON.parse(${JSON.stringify(JSON.stringify(plan))}));process.stdout.write("OATS_EGRESS_BOUNDARY_PASS\\n");}catch(error){const label=error?.name==="BoundaryFailure"?error.message:"input or runtime operation failed";process.stderr.write("egress boundary: "+label+"\\n");process.exitCode=1;}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if(process.argv.length !== 4 || process.argv[2] !== "--emit-program")throw new Error("invalid arguments");
    process.stdout.write(runtimeProgram(JSON.parse(readFileSync(process.argv[3],"utf8"))));
  } catch { process.stderr.write("egress boundary: cannot emit runtime probe (values withheld)\n");process.exitCode=1; }
}
