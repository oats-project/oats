/** Split agent/services host admission shared by the agent-host boundary
 * adapter (plan schema 2) and the services-host witness. Pure checks over the
 * derived plan and read-only host observations; no Docker access here. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { policyHash } from "./policy.mjs";
import { cidr } from "./preflight-network.mjs";

export function splitRefusal(code, text) {
  return Object.assign(new Error(`${code}: ${text}`), { code });
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hasKeys = (value, keys) => isObject(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const runIdentifier = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const validPort = port => Number.isInteger(port) && port > 0 && port <= 65535;

/** The wrapper's run binding; its policyHash must equal the hash recomputed
 * from the plan's own policy. */
export function admitRun(run, policy) {
  assert.ok(hasKeys(run, ["id", "policyHash", "servicesDeployment"]) && runIdentifier(run.id)
    && runIdentifier(run.servicesDeployment) && /^sha256:[0-9a-f]{64}$/.test(run.policyHash),
  "run binding is invalid: supply {id, policyHash, servicesDeployment}");
  if (run.policyHash !== policyHash(policy))
    throw splitRefusal("E_EGRESS_POLICY_HASH", "run.policyHash differs from policyHash(policy)");
  return run;
}

/** "Local to the agent host": inside any IPv4 Docker IPAM subnet on this
 * engine, or exactly equal to an IPv4 address on one of the host's own
 * interfaces. An address merely inside an interface's prefix is not local. */
export function isLocalAddress(address, { networks, links }) {
  assert.ok(Array.isArray(networks) && Array.isArray(links), "host network observations are incomplete");
  const value = cidr(address + "/32").start;
  for (const network of networks) for (const item of network?.IPAM?.Config ?? []) {
    if (typeof item?.Subnet !== "string" || isIP(item.Subnet.split("/")[0]) !== 4) continue;
    const range = cidr(item.Subnet);
    if (value >= range.start && value <= range.end) return true;
  }
  return interfaceAddresses(links).includes(address);
}

export function interfaceAddresses(links) {
  assert.ok(Array.isArray(links) && links.every(link => link && Array.isArray(link.addr_info)), "interface observation is incomplete");
  return links.flatMap(link => link.addr_info.filter(item => item?.family === "inet" && isIP(item.local) === 4).map(item => item.local));
}

/** Schema-2 `remoteBackends` to per-port tuples, sorted by role. Redis is
 * always on the services host; PostgreSQL is there too, or external at its
 * own pinned address, which the policy already denies IP-wide. */
export function admitRemoteBackends(remote, policy, observations) {
  const addresses = value => Array.isArray(value) && value.length > 1;
  if (Array.isArray(remote) || addresses(remote?.servicesAddress)
    || (Array.isArray(remote?.backends) && remote.backends.some(item => isObject(item) && !Object.hasOwn(item, "external") && Object.hasOwn(item, "address"))))
    throw splitRefusal("E_EGRESS_REMOTE_ADDRESSES", "split mode v1 takes exactly one services-host address");
  assert.ok(hasKeys(remote, ["servicesAddress", "backends"]), "remote backend inventory must be {servicesAddress, backends}");
  const { servicesAddress, backends } = remote;
  assert.ok(typeof servicesAddress === "string" && isIP(servicesAddress) === 4, "the services-host address must be one IPv4 literal");
  assert.ok(Array.isArray(backends) && backends.length === 2
    && backends.map(item => item?.role).sort().join(",") === "postgres,redis"
    && backends.every(item => validPort(item.port) && (hasKeys(item, ["role", "port"])
      || (item.role === "postgres" && hasKeys(item, ["role", "port", "address", "external"]) && item.external === true && isIP(item.address) === 4))),
  "remote backend inventory must be postgres and redis, each {role,port}; only postgres may add {address, external:true}");
  if (isLocalAddress(servicesAddress, observations))
    throw splitRefusal("E_EGRESS_REMOTE_LOCAL", "the services-host address is local to the agent host");
  const tuples = backends.map(item => ({ role:item.role, address:item.external ? item.address : servicesAddress, port:item.port, external:item.external === true }))
    .sort((left, right) => left.role.localeCompare(right.role));
  for (const tuple of tuples.filter(item => item.external)) {
    if (Object.values(policy.targets).some(target => target.addresses.includes(tuple.address)))
      throw splitRefusal("E_EGRESS_EXTERNAL_DB_TARGET", "the external database address is a declared egress target");
    if (!policy.deniedAddresses.includes(tuple.address) || tuple.address === servicesAddress)
      throw splitRefusal("E_EGRESS_EXTERNAL_DB_DENIED", "the external database address must be in policy.deniedAddresses and differ from the services-host address");
    if (isLocalAddress(tuple.address, observations))
      throw splitRefusal("E_EGRESS_REMOTE_LOCAL", "the external database address is local to the agent host");
  }
  return { servicesAddress, tuples };
}

/** The source commit of an extracted deploy copy. Every file its manifest
 * lists must still hash as recorded, and the running script must be listed. */
export function deploySource(directory, script) {
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    assert.ok(hasKeys(manifest, ["schema", "image", "source", "files", "installed"]) && manifest.schema === 1
      && manifest.image === "egress" && /^[a-f0-9]{40}$/.test(manifest.source)
      && isObject(manifest.files) && Object.hasOwn(manifest.files, script));
    for (const [name, digest] of Object.entries(manifest.files)) {
      assert.ok(/^(?:egress\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name));
      assert.equal(digest, "sha256:" + createHash("sha256").update(readFileSync(join(directory, name))).digest("hex"));
    }
    return manifest.source;
  } catch {
    throw splitRefusal("E_EGRESS_SOURCE_MANIFEST", `this check runs only from a deploy copy extracted from the reviewed egress image, whose manifest.json lists and hashes ${script}; extract /opt/oats/deploy from that image and run ${script} from the extracted copy, not from a source checkout`);
  }
}
