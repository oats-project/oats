/** Compile the wrapper-rendered, non-secret policy for the proxy image. */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { isIP } from "node:net";

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

function externalRoutes(policy, hosts) {
  if (!Object.hasOwn(policy,"externalTargets") && !Object.hasOwn(policy,"externalResolverAddresses")) return [];
  const expected={source:{origin:"https://github.com",port:10443},model:{origin:"https://api.anthropic.com",port:10444}};
  const targets=policy.externalTargets, resolvers=policy.externalResolverAddresses;
  assert.ok(targets && typeof targets === "object" && !Array.isArray(targets)
    && Object.keys(targets).length > 0 && Object.keys(targets).every(role=>Object.hasOwn(expected,role)),
  "egress policy external targets require only source/model roles");
  assert.ok(Array.isArray(resolvers) && resolvers.length >= 1 && resolvers.length <= 4
    && new Set(resolvers).size === resolvers.length
    && resolvers.every(ip=>externalAddressAllowed(policy,ip)),
  "egress policy external resolver addresses must be distinct approved public IPv4 addresses");
  return Object.keys(targets).sort().map(role=>{
    const target=targets[role];
    assert.ok(target && Object.keys(target).join(",") === "origin" && target.origin === expected[role].origin,
      "egress policy external role origin is fixed");
    const host=originHost(target.origin);
    assert.ok(!hosts.includes(host) && host !== originHost(policy.humanOrigin),
      "egress policy external hostname overlaps deployment origins");
    return {role,host,port:expected[role].port};
  });
}

export function compilePolicy(policy) {
  assert.ok(policy && typeof policy === "object" && !Array.isArray(policy)
    && ["authorityRecords,deniedAddresses,frontAddress,humanOrigin,privateIngressAddresses,targets",
      "authorityRecords,deniedAddresses,externalResolverAddresses,externalTargets,frontAddress,humanOrigin,privateIngressAddresses,targets"]
      .includes(Object.keys(policy).sort().join(",")), "egress policy has an invalid field set");
  assert.ok(isIP(policy.frontAddress) === 4, "egress policy front address must be IPv4");
  assert.ok(policy.targets && Object.keys(policy.targets).sort().join(",") === "aweb,logs,registry,secrets,signer", "egress policy requires exactly the five named services");
  for (const list of [policy.privateIngressAddresses, policy.deniedAddresses]) assert.ok(Array.isArray(list)
    && list.length <= 64 && list.every(ip => isIP(ip) === 4), "egress policy address sets must contain IPv4 literals");
  const targets = ["aweb", "secrets", "logs", "signer", "registry"].map(name => policy.targets[name]);
  for (const target of targets) assert.ok(target && typeof target === "object"
    && Object.keys(target).sort().join(",") === "addresses,origin", "egress policy target has an invalid field set");
  const hosts = targets.map(target => originHost(target.origin));
  assert.ok(new Set(hosts).size === hosts.length, "egress policy service hostnames must be distinct");
  assert.ok(!hosts.includes(originHost(policy.humanOrigin)), "egress policy cannot route the human login origin");
  for (const target of targets) assert.ok(Array.isArray(target.addresses) && target.addresses.length > 0 && target.addresses.length <= 8
    && target.addresses.every(ip => isIP(ip) === 4), "egress policy upstream addresses must be pinned IPv4 literals");
  for (const target of targets) for (const ip of target.addresses) {
    assert.ok(!inRanges(ip, forbiddenRanges) && !policy.deniedAddresses.includes(ip)
      && (!inRanges(ip, privateRanges) || policy.privateIngressAddresses.includes(ip)), "egress policy upstream address denied");
  }
  const external=externalRoutes(policy,hosts);
  // Records have already passed the existing AWID parser and profile binding in
  // the wrapper. Here only their DNS owner/data envelope is serialized.
  assert.ok(Array.isArray(policy.authorityRecords) && policy.authorityRecords.length > 0
    && policy.authorityRecords.length <= 64, "egress policy requires provisioned namespace authority records");
  const recordNames = new Set();
  for (const record of policy.authorityRecords) {
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
  const zone = [
    "$ORIGIN .", "$TTL 30",
    `. 30 IN SOA ${hosts[0]}. hostmaster.egress.invalid. 1 60 30 3600 30`,
    `. 30 IN NS ${hosts[0]}.`,
    ...hosts.map(host => `${host}. 30 IN A ${policy.frontAddress}`),
    ...external.map(({host})=>`${host}. 30 IN A ${policy.frontAddress}`),
    ...policy.authorityRecords.map(record => `${record.name}. 30 IN TXT ${record.text.match(/.{1,240}/g).map(part => JSON.stringify(part)).join(" ")}`), "",
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


export function loadPolicy(path = "/etc/egress/policy.json") {
  try {
    const stat = statSync(path);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 65536);
    return JSON.parse(readFileSync(path,"utf8"));
  } catch { throw new Error("egress policy file is invalid"); }
}
