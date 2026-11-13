/** Fixed-role TLS byte connectors behind nginx's exact SNI map. The resolver
 * is never agent-facing; only an already validated IP reaches a TCP socket. */
import { Resolver } from "node:dns/promises";
import { createConnection, createServer } from "node:net";
import { compilePolicy, externalAddressAllowed } from "./policy.mjs";

export async function connectExternal(policy, host, {resolve4,connect=createConnection,signal,timeoutMs=5000}={}) {
  const routes=compilePolicy(policy).external;
  if (!routes.some(route=>route.host===host)) throw new Error("external hostname refused");
  let resolver;
  if (!resolve4) {
    resolver=new Resolver({timeout:1000,tries:1});
    resolver.setServers(policy.externalResolverAddresses);
    resolve4=name=>resolver.resolve4(name);
  }
  return new Promise((resolve,reject)=>{
    let socket,settled=false;
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);resolver?.cancel();};
    const fail=()=>{
      if (settled) return;
      settled=true;cleanup();socket?.destroy();reject(new Error("external destination refused"));
    };
    const abort=()=>fail();
    const timer=setTimeout(fail,timeoutMs);
    signal?.addEventListener("abort",abort,{once:true});
    if (signal?.aborted) {fail();return;}
    Promise.resolve().then(()=>resolve4(host)).then(answers=>{
      if (settled) return;
      // A mixed answer is a refusal, never an invitation to try its safe subset.
      if (!Array.isArray(answers) || answers.length<1 || answers.length>8
        || !answers.every(address=>externalAddressAllowed(policy,address))) {fail();return;}
      socket=connect({host:answers[0],port:443,family:4});
      socket.once("error",fail);
      socket.once("connect",()=>{
        if (settled) {socket.destroy();return;}
        settled=true;cleanup();resolve(socket);
      });
    }).catch(fail);
  });
}

export async function startExternalConnectors(policy, {resolve4,connect,say=line=>process.stderr.write(line+"\n")}={}) {
  const routes=compilePolicy(policy).external;
  const servers=[], sockets=new Set();
  let closing=false,fail;
  const failed=new Promise(resolve=>{fail=resolve;});
  const close=async()=>{
    closing=true;
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server=>new Promise(resolve=>server.close(()=>resolve()))));
  };
  try {
    for (const route of routes) {
      const server=createServer({pauseOnConnect:true},client=>{
        const controller=new AbortController();let upstream;
        sockets.add(client);
        client.once("close",()=>{sockets.delete(client);controller.abort();upstream?.destroy();});
        client.on("error",()=>client.destroy());
        client.setTimeout(300000,()=>client.destroy());
        connectExternal(policy,route.host,{resolve4,connect,signal:controller.signal}).then(socket=>{
          upstream=socket;
          if (client.destroyed) {socket.destroy();return;}
          sockets.add(socket);
          socket.once("close",()=>{sockets.delete(socket);client.destroy();});
          socket.on("error",()=>client.destroy());
          socket.setTimeout(300000,()=>socket.destroy());
          client.pipe(socket);socket.pipe(client);client.resume();
        }).catch(()=>{
          say(`egress: external connection refused (${route.role})`);
          client.destroy();
        });
      });
      server.maxConnections=128;
      servers.push(server);
      server.on("error",()=>{if(!closing)fail();});
      server.on("close",()=>{if(!closing)fail();});
      await new Promise((resolve,reject)=>{
        server.once("error",reject);
        server.listen(route.port,"127.0.0.1",()=>{server.removeListener("error",reject);resolve();});
      });
    }
    return {failed,close};
  } catch {
    await close();throw new Error("external connector startup failed");
  }
}
