import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePolicy } from "../container/agent/egress/policy.mjs";
import { boundaryControls } from "../container/agent/egress/boundary.mjs";
import { probeIngress, statusOf } from "../container/agent/egress/probe-ingress.mjs";
import { hosts, human, humanPath, startFixture } from "./fixtures/egress-humanrole/front.mjs";

const full = () => JSON.parse(readFileSync(new URL("../container/agent/egress/README.md", import.meta.url), "utf8").match(/```json\n([\s\S]*?)\n```/)[1]);
function secretsPolicy() {
  const policy = full();
  policy.roles = ["aweb", "logs", "registry", "secrets"];
  delete policy.targets.signer;
  return { ...policy, humanRole:"secrets", humanOrigin:"https://" + human };
}

test("humanRole policy table preserves legacy bytes and admits one explicit anchor", () => {
  const legacy = full(), compiled = compilePolicy(legacy);
  assert.equal(createHash("sha256").update(JSON.stringify(compiled)).digest("hex"), "5ea593b96ea1fd0fc17166f59931f8579b6869b77a54c282b2d9b7c97fa322d4");
  assert.deepEqual(compilePolicy({ ...legacy, humanRole:"signer" }), compiled);
  const policy = secretsPolicy(), noHuman = structuredClone(policy);
  delete noHuman.humanRole; delete noHuman.humanOrigin;
  assert.deepEqual(compilePolicy(policy), compilePolicy(noHuman));
  for (const value of [null, undefined, false, 1, "", "aweb", "Secrets", {}, []])
    assert.throws(() => compilePolicy({ ...policy, humanRole:value }), /egress policy/);
  for (const change of [
    p => { delete p.roles; },
    p => { p.roles.push("signer"); p.targets.signer = legacy.targets.signer; },
    p => { delete p.humanOrigin; },
    p => { p.roles = p.roles.filter(role => role !== "secrets"); delete p.targets.secrets; },
    p => { p.humanRole = "signer"; },
  ]) {
    const invalid = secretsPolicy(); change(invalid);
    assert.throws(() => compilePolicy(invalid), /humanRole: "secrets" needs declared roles that include secrets and exclude signer, plus humanOrigin/);
  }
  assert.throws(() => compilePolicy({ ...noHuman, humanOrigin:policy.humanOrigin }), /field set/);
  for (const role of Object.keys(policy.targets))
    assert.throws(() => compilePolicy({ ...policy, humanOrigin:policy.targets[role].origin }), /cannot route the human/);
  assert.throws(() => compilePolicy({ ...policy, humanOrigin:"https://github.com",
    externalTargets:{ source:{ origin:"https://github.com" } }, externalResolverAddresses:["1.1.1.1"] }), /overlaps/);
});

test("boundary report labels the secrets human anchor", () => {
  const policy = secretsPolicy();
  const report = boundaryControls({ policy, allowedPaths:Object.fromEntries(policy.roles.map(role => [role, "/ready"])) });
  assert.ok(report.declared.includes("secrets: human DNS/TLS refusal; separate ingress admission required"));
  assert.ok(report.declared.includes("registry: exact namespace authority TXT"));
  assert.ok(!report.declared.some(line => line.startsWith("signer:")));
});

test("four-role H1/H2 ingress with a shared Secrets console/API backend refuses three delivery mutants", async t => {
  const dir = mkdtempSync(join(tmpdir(), "oats-humanrole-"));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  writeFileSync(join(dir, "openssl.cnf"), "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=" + hosts.secrets
    + "\n[ext]\nsubjectAltName=" + [...Object.values(hosts), human].map(host => "DNS:" + host).join(",") + "\nbasicConstraints=critical,CA:TRUE\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "ca.pem"), "-config", join(dir, "openssl.cnf")], { stdio:"ignore", timeout:10000 });
  const fixture = await startFixture(dir); t.after(() => fixture.close());
  const policy = secretsPolicy();
  const routeLogs = Object.fromEntries(policy.roles.map(role => [role, { path:role === "registry" ? "/health" : "/ready", log:fixture.logs[role] }]));
  const calls = [];
  const options = { policy, routeLogs, address:"10.20.0.10", requestOrigin:policy.targets.secrets.origin,
    humanOrigin:policy.humanOrigin, humanLog:fixture.logs.secrets, humanPath, auditPath:"/ready",
    requestLog:fixture.logs.secrets, requestPath:"/ready", ca:readFileSync(join(dir, "ca.pem")),
    exchange:args => { calls.push(args); return statusOf({ ...args, address:"127.0.0.1", port:fixture.port }); } };
  assert.equal(await probeIngress(options), true);
  assert.equal(fixture.deliveries.length, 38);
  assert.equal(fixture.deliveries.filter(entry => entry.authority === human && entry.path.startsWith(humanPath + "?")).length, 2);
  for (const protocol of ["h1", "h2"]) {
    for (const authority of [human, human + ":443", hosts.secrets + ":444", hosts.secrets + ".unlisted.invalid"])
      assert.ok(calls.some(call => call.protocol === protocol && call.sni === hosts.secrets && call.authority === authority));
    for (const sni of ["", "unlisted.egress-probe.invalid"])
      assert.ok(calls.some(call => call.protocol === protocol && call.sni === sni));
  }
  for (const change of [o => { o.address = "10.20.0.99"; }, o => { o.requestOrigin = policy.targets.aweb.origin; },
    o => { o.requestLog = fixture.logs.logs; }, o => { o.requestPath = "/wrong"; }]) {
    const invalid = { ...options }; change(invalid); const before = calls.length;
    await assert.rejects(probeIngress(invalid), /secrets/); assert.equal(calls.length, before);
  }
  for (const mutant of ["human-forwarded", "role-misdelivery", "backend-421"]) {
    fixture.setMutant(mutant);
    const before = fixture.deliveries.length, callStart = calls.length;
    await assert.rejects(probeIngress(options), /forbidden probe reached a backend|ingress did not refuse a forbidden authority/);
    const forbidden = calls.slice(callStart).filter(call => call.sni !== call.authority && call.sni !== human);
    assert.ok(forbidden.some(call => fixture.deliveries.slice(before).some(entry => entry.path === call.path)), mutant);
    const log = readFileSync(fixture.logs[mutant === "role-misdelivery" ? "logs" : "secrets"], "utf8");
    assert.ok(forbidden.some(call => log.includes(call.path)), mutant + " leaves the forbidden tag in the backend log");
  }
  fixture.setMutant(undefined);
  const external = structuredClone(policy); external.targets.registry.addresses = ["8.8.8.8"];
  calls.length = 0;
  assert.equal(await probeIngress({ ...options, policy:external, routeLogs:{ ...routeLogs, registry:{ path:"/health", external:true } } }), true);
  const registryCalls = calls.filter(call => call.address === "8.8.8.8");
  assert.equal(registryCalls.length, 2);
  assert.ok(registryCalls.every(call => call.sni === hosts.registry && call.authority === hosts.registry && call.path.startsWith("/health?")));
});
