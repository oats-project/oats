/** Disposable real TLS ingress and HTTP backends; Secrets console/API share one log. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createSecureServer } from "node:http2";
import { join } from "node:path";
import { createSecureContext } from "node:tls";
import { pathToFileURL } from "node:url";

export const hosts = { aweb:"aweb.example.invalid", secrets:"secrets.example.invalid",
  logs:"logs.example.invalid", registry:"registry.example.invalid" };
export const human = "console.example.invalid";
export const humanPath = "/console.css";

export async function startFixture(dir, { host = "127.0.0.1", port = 0 } = {}) {
  const logs = Object.fromEntries(Object.keys(hosts).map(role => [role, join(dir, role + ".log")]));
  for (const log of Object.values(logs)) writeFileSync(log, "");
  const deliveries = [];
  const servers = [], sessions = new Set();
  const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const backends = {};
  for (const role of Object.keys(hosts)) {
    const backend = createServer((req, res) => {
      appendFileSync(logs[role], req.url + "\n");
      deliveries.push({ role, authority:req.headers.host, path:req.url });
      const pathname = new URL(req.url, "https://fixture.invalid").pathname;
      const wanted = req.headers.host === human ? humanPath : role === "registry" ? "/health" : "/ready";
      res.writeHead(req.headers["x-fixture-refuse"] ? 421 : pathname === wanted ? 200 : 404);
      res.end("control");
    });
    servers.push(backend); await listen(backend); backends[role] = backend.address().port;
  }
  const key = readFileSync(join(dir, "key.pem")), cert = readFileSync(join(dir, "ca.pem"));
  const ctx = createSecureContext({ key, cert });
  let mutant;
  const ingress = createSecureServer({ key, cert, allowHTTP1:true,
    SNICallback:(name, done) => Object.values(hosts).includes(name) || name === human
      ? done(null, ctx) : done(new Error("unlisted SNI")) });
  ingress.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
  ingress.on("request", (req, res) => {
    const authority = req.headers[":authority"] || req.headers.host, sni = req.socket.servername;
    const matched = authority === sni || authority === sni + ":443";
    const selected = existsSync(join(dir, "mutant")) ? readFileSync(join(dir, "mutant"), "utf8").trim() : mutant;
    const humanAttack = sni === hosts.secrets && [human, human + ":443"].includes(authority);
    const roleAttack = sni === hosts.aweb && [human, human + ":443"].includes(authority);
    const forward = humanAttack && ["human-forwarded", "backend-421"].includes(selected)
      || roleAttack && selected === "role-misdelivery";
    if (!matched && !forward) { res.writeHead(421); res.end(); return; }
    const role = forward ? (roleAttack ? "logs" : "secrets")
      : sni === human ? "secrets" : Object.keys(hosts).find(name => hosts[name] === sni);
    if (!role) { res.writeHead(421); res.end(); return; }
    const upstream = request({ hostname:"127.0.0.1", port:backends[role], path:req.url,
      headers:{ host:forward && selected === "human-forwarded" ? hosts.secrets : authority,
        ...(forward && selected !== "human-forwarded" ? { "x-fixture-refuse":"true" } : {}) } }, response => {
      res.writeHead(response.statusCode); response.pipe(res);
    });
    upstream.on("error", () => { res.writeHead(502); res.end(); }); upstream.end();
  });
  await new Promise(resolve => ingress.listen(port, host, resolve));
  return { logs, deliveries, port:ingress.address().port, setMutant:value => { mutant = value; },
    async close() {
      for (const session of sessions) session.destroy();
      await Promise.all([ingress, ...servers].map(server => new Promise(resolve => {
        server.closeAllConnections?.(); server.close(resolve);
      })));
    } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startFixture(process.argv[2], { host:"0.0.0.0", port:443 });
  process.stdout.write("TLS_CONTROLS_READY\n");
}
