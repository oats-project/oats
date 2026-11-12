/** One runtime ingress proof for both deployment wrappers. Backend access-log
 * controls prevent a backend-generated rejection from certifying non-delivery. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect as connectHttp2 } from "node:http2";
import { isIP } from "node:net";
import { checkServerIdentity, connect as connectTls } from "node:tls";
import { pathToFileURL } from "node:url";
import { originHost } from "./policy.mjs";

export function statusOf({ protocol, address, port, sni, authority, expectedHost, path, ca }) {
  return new Promise((resolve, reject) => {
    let finished = false, request, session, socket;
    const done = (error, status) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request?.destroy(); session?.destroy(); socket?.destroy();
      if (error) reject(error); else resolve(status);
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
      if (protocol === "h1") {
        request = httpsRequest({ ...tlsOptions, method:"GET", path, agent:false, headers:{ Host:authority } }, response => consume(response, () => response.statusCode));
        request.once("error", error => done(error)); request.end();
      } else {
        socket = connectTls({ ...tlsOptions, ALPNProtocols:["h2"] });
        socket.once("error", error => done(error));
        session = connectHttp2("https://" + expectedHost, { createConnection:() => socket });
        session.once("error", error => done(error));
        request = session.request({ ":method":"GET", ":path":path, ":authority":authority });
        let status;
        request.once("response", headers => { status = headers[":status"]; });
        consume(request, () => status); request.end();
      }
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

export async function probeIngress({ address, port = 443, requestOrigin, humanOrigin, requestLog, humanLog, ca, path = "/ready", requestPath = path, humanPath = path, exchange = statusOf }) {
  const requestHost = originHost(requestOrigin), humanHost = originHost(humanOrigin);
  assert.ok(requestHost !== humanHost && isIP(address) === 4, "ingress probe needs distinct origins and an IPv4 address");
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "ingress probe port is invalid");
  for (const controlPath of [requestPath, humanPath]) {
    assert.ok(typeof controlPath === "string" && controlPath.startsWith("/") && !controlPath.startsWith("//")
      && !/[\\\u0000-\u0020\u007f#]/.test(controlPath), "ingress probe path is invalid");
    assert.equal(new URL(controlPath, requestOrigin).origin, new URL(requestOrigin).origin, "ingress probe path is invalid");
  }
  // Establish readable audit inputs before making any requests.
  backendLog(requestLog); backendLog(humanLog);
  const goodRequest = [], goodHuman = [], forbidden = [];
  const send = async (protocol, sni, authority, kind) => {
    const id = "oats-egress-" + randomUUID();
    (kind === "request" ? goodRequest : kind === "human" ? goodHuman : forbidden).push(id);
    const controlPath = authority === humanHost || authority === humanHost + ":443" ? humanPath : requestPath;
    const url = new URL(controlPath, requestOrigin); url.searchParams.set("oats_egress_probe", id);
    try {
      const status = await exchange({ protocol, address, port, sni, authority,
        expectedHost:sni === humanHost ? humanHost : requestHost, path:url.pathname + url.search, ca });
      assert.equal(status, kind === "forbidden" ? 421 : 200,
        kind === "forbidden" ? "ingress did not refuse a forbidden authority" : "matched ingress control did not succeed");
    } catch (error) {
      const refused = new Set(["ECONNRESET", "EPIPE", "ERR_SSL_TLSV1_UNRECOGNIZED_NAME", "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", "ERR_SSL_TLSV1_ALERT_UNRECOGNIZED_NAME"]);
      if (kind !== "forbidden" || !refused.has(error.code)) throw error;
    }
  };
  for (const protocol of ["h1", "h2"]) {
    await send(protocol, requestHost, requestHost, "request");
    for (const [sni, authority] of [
      [requestHost, humanHost], [requestHost, humanHost + ":443"],
      [requestHost, requestHost + ":444"], [requestHost, requestHost + ".unlisted.invalid"],
      ["unlisted.egress-probe.invalid", humanHost], ["", humanHost],
    ]) await send(protocol, sni, authority, "forbidden");
    // A final live backend control is also a delivery barrier for access logs.
    await send(protocol, humanHost, humanHost, "human");
  }
  const deadline = Date.now() + 2000;
  let requestText, humanText;
  for (;;) {
    requestText = backendLog(requestLog); humanText = backendLog(humanLog);
    if (goodRequest.every(id => requestText.includes(id)) && goodHuman.every(id => humanText.includes(id))) break;
    assert.ok(Date.now() < deadline, "backend audit did not confirm the matched controls");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(forbidden.every(id => !requestText.includes(id) && !humanText.includes(id)), "forbidden probe reached a backend");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const flags = { "--address":"address", "--request-origin":"requestOrigin", "--human-origin":"humanOrigin",
      "--request-log":"requestLog", "--human-log":"humanLog", "--ca-file":"caFile", "--path":"path",
      "--request-path":"requestPath", "--human-path":"humanPath" };
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = flags[process.argv[index]], value = process.argv[index + 1];
      assert.ok(key && !Object.hasOwn(options, key) && value && !value.startsWith("--"), "ingress probe arguments are invalid");
      options[key] = value;
    }
    if (options.caFile) options.ca = readFileSync(options.caFile);
    await probeIngress(options);
    process.stdout.write("OATS_EGRESS_INGRESS_PASS\n");
  } catch {
    process.stderr.write("egress: ingress authority or backend non-delivery proof failed (values withheld)\n");
    process.exitCode = 1;
  }
}
