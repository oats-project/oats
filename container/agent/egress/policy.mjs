/** Compile the wrapper-rendered, non-secret policy for the proxy image. */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { isIP } from "node:net";

/** Keep legacy route indexes stable, regardless of declaration order. Self-
 * contained: probe-runtime.mjs serializes it into the in-container program. */
export function policyRoles(policy) {
  const names = ["aweb", "secrets", "logs", "signer", "registry"];
  if (!Object.hasOwn(policy, "roles")) return names;
  // Hosted services: every destination is an external role.
  if (Array.isArray(policy.roles) && policy.roles.length === 0) {
    const external = policy.externalTargets;
    assert.ok(external && typeof external === "object" && !Array.isArray(external) && Object.keys(external).length > 0,
      "egress policy empty roles require an external origin");
    return [];
  }
  assert.ok(Array.isArray(policy.roles) && policy.roles.length > 0
    && new Set(policy.roles).size === policy.roles.length
    && Array.from(policy.roles).every(role => names.includes(role)),
  "egress policy roles must be a nonempty distinct subset of aweb, logs, registry, secrets, signer");
  return names.filter(role => policy.roles.includes(role));
}

export function originHost(value) {
  assert.ok(typeof value === "string" && value.length <= 2048 && !/[\u0000-\u0020\u007f]/.test(value), "egress policy origin is invalid");
  let url;
  try { url = new URL(value); } catch { throw new Error("egress policy origin is invalid"); }
  assert.ok(url.protocol === "https:" && !url.port && !url.username && !url.password
    && url.pathname === "/" && !url.search && !url.hash && isIP(url.hostname) === 0,
  "egress policy requires an exact HTTPS origin on443 without credentials");
  assert.ok(url.hostname.length <= 253 && url.hostname.split(".").every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)), "egress policy requires an exact DNS hostname");
  return url.hostname;
}

const privateRanges = [["10.0.0.0",8], ["172.16.0.0",12], ["192.168.0.0",16]];
const forbiddenRanges = [["0.0.0.0",8], ["100.64.0.0",10], ["127.0.0.0",8], ["169.254.0.0",16],
  ["192.0.0.0",24], ["192.0.2.0",24], ["192.88.99.0",24], ["198.18.0.0",15],
  ["198.51.100.0",24], ["203.0.113.0",24], ["224.0.0.0",4], ["240.0.0.0",4]];
const ipv4 = ip => ip.split(".").reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
const inRanges = (ip, ranges) => ranges.some(([base, bits]) => {
  const mask = (0xffffffff << (32-bits)) >>> 0;
  return (ipv4(ip) & mask) === (ipv4(base) & mask);
});

/** External routes never inherit an internal ingress exception, including
 * public addresses already assigned to this deployment. Used again after DNS. */
export function externalAddressAllowed(policy, address) {
  return isIP(address) === 4 && !inRanges(address, [...privateRanges,...forbiddenRanges])
    && address !== policy.frontAddress
    && !policy.privateIngressAddresses.includes(address)
    && !policy.deniedAddresses.includes(address)
    && !Object.values(policy.targets).some(target=>target.addresses.includes(address));
}

const hasExternal = policy => Object.hasOwn(policy,"externalTargets") || Object.hasOwn(policy,"externalResolverAddresses");

/** Roles whose origin the component fixes. source and model also keep their
 * loopback ports; forge (the sandboxes design's decided GitHub API role,
 * docs/design/2026-11-19-sandboxes.md) takes its port from the named order. */
const fixedExternal={source:{origin:"https://github.com",port:10443},model:{origin:"https://api.anthropic.com",port:10444},
  forge:{origin:"https://api.github.com"}};

/** A deployment-named origin is exactly https://<lowercase DNS name>. */
function externalOriginHost(origin) {
  const refused="egress policy external origin must be exactly https://<lowercase DNS name>";
  let host;
  try { host=originHost(origin); } catch { throw new Error(refused); }
  assert.ok(origin === "https://"+host, refused);
  return host;
}

function externalRoutes(policy, hosts) {
  if (!hasExternal(policy)) return [];
  const targets=policy.externalTargets, resolvers=policy.externalResolverAddresses;
  assert.ok(targets && typeof targets === "object" && !Array.isArray(targets) && Object.keys(targets).length > 0,
    "egress policy external targets must name at least one role");
  assert.ok(Object.keys(targets).length <= 16, "egress policy allows at most 16 external roles");
  assert.ok(Object.keys(targets).every(role=>/^[a-z][a-z0-9-]{0,31}$/.test(role)),
    "egress policy external role names must match ^[a-z][a-z0-9-]{0,31}$");
  assert.ok(Array.isArray(resolvers) && resolvers.length >= 1 && resolvers.length <= 4
    && new Set(resolvers).size === resolvers.length
    && resolvers.every(ip=>externalAddressAllowed(policy,ip)),
  "egress policy external resolver addresses must be distinct approved public IPv4 addresses");
  // Internal only: the agent always reaches every role on :443 by name.
  const fixedOf=role=>Object.hasOwn(fixedExternal,role) ? fixedExternal[role] : undefined;
  const named=Object.keys(targets).filter(role=>!fixedOf(role)?.port).sort();
  const routes=Object.keys(targets).sort().map(role=>{
    const target=targets[role], fixed=fixedOf(role);
    if (fixed) assert.ok(target && Object.keys(target).join(",") === "origin" && target.origin === fixed.origin,
      "egress policy external role origin is fixed");
    else assert.ok(target && typeof target === "object" && !Array.isArray(target) && Object.keys(target).join(",") === "origin",
      "egress policy external target has an invalid field set");
    const host=fixed ? originHost(target.origin) : externalOriginHost(target.origin);
    assert.ok(!hosts.includes(host) && (!policy.humanOrigin || host !== originHost(policy.humanOrigin)),
      "egress policy external hostname overlaps deployment origins");
    return {role,host,port:fixed?.port ?? 10445+named.indexOf(role)};
  });
  assert.ok(new Set(routes.map(route=>route.host)).size === routes.length, "egress policy external hostnames must be distinct");
  return routes;
}

export function compilePolicy(policy) {
  assert.ok(policy && typeof policy === "object" && !Array.isArray(policy), "egress policy has an invalid field set");
  const roles = policyRoles(policy), signer = roles.includes("signer"), registry = roles.includes("registry");
  const hasHumanRole = Object.hasOwn(policy, "humanRole"), secrets = policy.humanRole === "secrets";
  const fields = ["deniedAddresses", "frontAddress", "privateIngressAddresses", "targets"];
  if (signer || secrets) fields.push("humanOrigin");
  if (hasHumanRole) fields.push("humanRole");
  // With external roles the registry can be one of them, so the agent still
  // needs its namespace authority locally.
  if (registry || (hasExternal(policy) && Object.hasOwn(policy, "authorityRecords"))) fields.push("authorityRecords");
  if (Object.hasOwn(policy, "roles")) fields.push("roles");
  if (hasExternal(policy)) fields.push("externalTargets", "externalResolverAddresses");
  assert.ok(Object.keys(policy).sort().join(",") === fields.sort().join(",")
    && (!hasHumanRole || (policy.humanRole === "signer" && signer)
      || (secrets && Object.hasOwn(policy, "roles") && roles.includes("secrets") && !signer)),
  'egress policy has an invalid field set; supply authorityRecords with registry and humanOrigin with signer; humanRole must name a declared signer or secrets anchor; humanRole: "secrets" needs declared roles that include secrets and exclude signer, plus humanOrigin');
  assert.ok(isIP(policy.frontAddress) === 4, "egress policy front address must be IPv4");
  assert.ok(policy.targets && typeof policy.targets === "object" && !Array.isArray(policy.targets)
    && Object.keys(policy.targets).sort().join(",") === [...roles].sort().join(","),
  "egress policy targets must match exactly the declared roles (default: five named services)");
  for (const list of [policy.privateIngressAddresses, policy.deniedAddresses]) assert.ok(Array.isArray(list)
    && list.length <= 64 && list.every(ip => isIP(ip) === 4), "egress policy address sets must contain IPv4 literals");
  const targets = roles.map(name => policy.targets[name]);
  for (const target of targets) assert.ok(target && typeof target === "object"
    && Object.keys(target).sort().join(",") === "addresses,origin", "egress policy target has an invalid field set");
  const hosts = targets.map(target => originHost(target.origin));
  assert.ok(new Set(hosts).size === hosts.length, "egress policy service hostnames must be distinct");
  if (signer || secrets) assert.ok(!hosts.includes(originHost(policy.humanOrigin)), "egress policy cannot route the human login origin");
  for (const target of targets) assert.ok(Array.isArray(target.addresses) && target.addresses.length > 0 && target.addresses.length <= 8
    && target.addresses.every(ip => isIP(ip) === 4), "egress policy upstream addresses must be pinned IPv4 literals");
  for (const target of targets) for (const ip of target.addresses) {
    assert.ok(!inRanges(ip, forbiddenRanges) && !policy.deniedAddresses.includes(ip)
      && (!inRanges(ip, privateRanges) || policy.privateIngressAddresses.includes(ip)), "egress policy upstream address denied");
  }
  const external=externalRoutes(policy,hosts);
  // Registry discovery needs these records even without signer. The wrapper
  // applies the existing AWID parser and registry binding before serialization;
  // here only the DNS owner/data envelope is checked.
  if (registry || Object.hasOwn(policy, "authorityRecords")) assert.ok(Array.isArray(policy.authorityRecords) && policy.authorityRecords.length > 0
    && policy.authorityRecords.length <= 64, "egress policy requires provisioned namespace authority records");
  const recordNames = new Set();
  for (const record of policy.authorityRecords ?? []) {
    assert.ok(record && Object.keys(record).sort().join(",") === "name,text"
      && typeof record.name === "string" && record.name.length <= 253
      && record.name.startsWith("_awid.") && record.name.slice(6).split(".").every(label =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      && !recordNames.has(record.name), "egress policy authority record owner is invalid");
    recordNames.add(record.name);
    assert.ok(typeof record.text === "string" && record.text.length <= 2048
      && record.text.startsWith("awid=v1;") && /^[\x20-\x7e]+$/.test(record.text),
    "egress policy authority record data is invalid");
  }
  // Hosted services declare no internal role: the first external host names the zone.
  const zoneHost = hosts[0] ?? external[0].host;
  const zone = [
    "$ORIGIN .", "$TTL 30",
    `. 30 IN SOA ${zoneHost}. hostmaster.egress.invalid. 1 60 30 3600 30`,
    `. 30 IN NS ${zoneHost}.`,
    ...hosts.map(host => `${host}. 30 IN A ${policy.frontAddress}`),
    ...external.map(({host})=>`${host}. 30 IN A ${policy.frontAddress}`),
    ...(policy.authorityRecords ?? []).map(record => `${record.name}. 30 IN TXT ${record.text.match(/.{1,240}/g).map(part => JSON.stringify(part)).join(" ")}`), "",
  ].join("\n");
  const nginx = [
    "load_module /usr/lib/nginx/modules/ngx_stream_module.so;",
    "pid /tmp/egress/nginx.pid;", "error_log stderr warn;", "worker_processes 1;",
    "events { worker_connections 256; }", "stream {",
    ...(external.length?[
      `  log_format refused escape=json '{"kind":"sni_refused","name":"$ssl_preread_server_name"}';`,
      '  map $route $log_refused { "" 1; default 0; }',
      "  access_log /dev/stderr refused if=$log_refused;",
    ]:[]),
    "  map $ssl_preread_server_name $route {", '    default "";',
    ...hosts.map((host, index) => `    "${host}" route_${index};`),
    ...external.map(({role,host})=>`    "${host}" external_${role};`), "  }",
    ...targets.map((target, index) => `  upstream route_${index} { ${target.addresses.map(ip => `server ${ip}:443;`).join(" ")} }`),
    ...external.map(({role,port})=>`  upstream external_${role} { server 127.0.0.1:${port}; }`),
    "  server { listen 443; ssl_preread on; proxy_connect_timeout 5s; proxy_timeout 300s; proxy_pass $route; }",
    "}", "",
  ].join("\n");
  const corefile = ".:53 {\n  file /tmp/egress/allow.zone . {\n    reload 0\n  }\n"
    +(external.length?"  log . {\n    class denial\n  }\n":"")+"}\n";
  return { zone, nginx, corefile, external };
}


/** Canonical JSON (sorted ASCII keys, given array order, no whitespace,
 * JSON.stringify scalars) restricted to values every language encodes the same
 * way: safe integers only, ASCII keys, well-formed strings, plain objects. */
function canonicalJSON(value, seen = new Set()) {
  const refuse = () => { throw new Error("policyHash: input is not a portable JSON value"); };
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isSafeInteger(value) ? JSON.stringify(value) : refuse();
  if (typeof value === "string") return value.isWellFormed() ? JSON.stringify(value) : refuse();
  if (typeof value !== "object" || seen.has(value)) refuse();
  seen.add(value);
  let text;
  if (Array.isArray(value)) text = "[" + Array.from(value, item => canonicalJSON(item, seen)).join(",") + "]";
  else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) refuse();
    const keys = Object.keys(value).sort();
    if (!keys.every(key => /^[\x00-\x7f]*$/.test(key))) refuse();
    text = "{" + keys.map(key => JSON.stringify(key) + ":" + canonicalJSON(value[key], seen)).join(",") + "}";
  }
  seen.delete(value);
  return text;
}

/** The run-binding digest the split-host wrapper, boundary adapter and services
 * witness each compute over the same derived policy object. */
export function policyHash(policy) {
  return "sha256:" + createHash("sha256").update(canonicalJSON(policy), "utf8").digest("hex");
}

export function loadPolicy(path = "/etc/egress/policy.json") {
  try {
    const stat = statSync(path);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 65536);
    return JSON.parse(readFileSync(path,"utf8"));
  } catch { throw new Error("egress policy file is invalid"); }
}
