/** Read-only Linux engine-host observations. No network creation or fallback
 * after an observation fails. Rerun immediately before creating the wrapper. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

const keys = ["AGENTS_SUBNET", "AGENTS_GATEWAY", "AGENT_IP", "EGRESS_ADDRESS", "SERVICES_SUBNET", "SERVICES_GATEWAY"];
const number = ip => ip.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
function cidr(value, canonical = false) {
  assert.ok(typeof value === "string", "network CIDR is missing");
  const [ip, prefix, extra] = value.split("/");
  assert.ok(isIP(ip) === 4 && extra === undefined && /^(?:[0-9]|[12][0-9]|3[0-2])$/.test(prefix), "network CIDR is invalid");
  const size = 2 ** (32 - Number(prefix)), start = Math.floor(number(ip) / size) * size;
  assert.ok(!canonical || number(ip) === start, "network CIDR must use its network address");
  return { start, end: start + size - 1, bits: Number(prefix) };
}
const overlaps = (left, right) => left.start <= right.end && right.start <= left.end;

export function admitNetworkPlan(input, {networks, routes, links}) {
  assert.ok(Array.isArray(networks) && Array.isArray(routes) && Array.isArray(links), "network observations are incomplete");
  const plan = Object.fromEntries(keys.map(key => [key, input[key]]));
  const agents = cidr(plan.AGENTS_SUBNET, true), services = cidr(plan.SERVICES_SUBNET, true);
  const privateRanges = [cidr("10.0.0.0/8"), cidr("172.16.0.0/12"), cidr("192.168.0.0/16")];
  for (const range of [agents, services]) assert.ok(range.bits <= 29 && privateRanges.some(privateRange =>
    range.start >= privateRange.start && range.end <= privateRange.end), "wrapper networks require private IPv4 CIDRs with at least eight addresses");
  assert.ok(!overlaps(agents, services), "wrapper subnets overlap");
  for (const [range, addresses] of [[agents,[plan.AGENTS_GATEWAY,plan.AGENT_IP,plan.EGRESS_ADDRESS]], [services,[plan.SERVICES_GATEWAY]]]) {
    assert.ok(new Set(addresses).size === addresses.length && addresses.every(ip => isIP(ip) === 4
      && number(ip) > range.start && number(ip) < range.end), "wrapper endpoints must be distinct usable addresses inside their subnet");
  }
  const observed = [];
  for (const network of networks) {
    assert.ok(network && network.IPAM && (Array.isArray(network.IPAM.Config)
      || (network.IPAM.Config === null && ["host", "null"].includes(network.Driver))), "Docker IPAM observation is incomplete");
    for (const item of network.IPAM.Config ?? []) {
      assert.ok(item && typeof item.Subnet === "string", "Docker IPAM subnet observation is incomplete");
      if (isIP(item.Subnet.split("/")[0]) === 6) {
        assert.ok(item.Subnet.split("/").length === 2 && /\/(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/.test(item.Subnet), "Docker IPv6 IPAM observation is invalid");
      } else observed.push(cidr(item.Subnet));
    }
  }
  for (const route of routes) {
    assert.ok(route && typeof route.dst === "string", "route observation is incomplete");
    // A default route describes reachability, not an assigned/connected range.
    // Every more-specific route in every table remains an overlap veto.
    if (route.dst !== "default") observed.push(cidr(route.dst.includes("/") ? route.dst : route.dst + "/32"));
  }
  for (const link of links) {
    assert.ok(link && typeof link.ifname === "string" && Array.isArray(link.addr_info), "link observation is incomplete");
    for (const address of link.addr_info) {
      assert.ok(address && ["inet", "inet6"].includes(address.family) && Number.isInteger(address.prefixlen), "link address observation is incomplete");
      if (address.family === "inet") observed.push(cidr(address.local + "/" + address.prefixlen));
      else assert.ok(isIP(address.local) === 6 && address.prefixlen >= 0 && address.prefixlen <= 128, "IPv6 link observation is invalid");
    }
  }
  assert.ok(observed.every(range => !overlaps(range, agents) && !overlaps(range, services)), "wrapper subnet overlaps observed Docker IPAM, route or link");
  return plan;
}

export function observeNetworks(run = spawnSync) {
  const read = (command, args, json = true) => {
    const result = run(command, args, {encoding:"utf8",timeout:15000,maxBuffer:4*1024*1024});
    assert.ok(!result.error && result.status === 0 && typeof result.stdout === "string", "network observation failed (output withheld)");
    if (!json) return result.stdout;
    try { return JSON.parse(result.stdout); } catch { throw new Error("network observation returned invalid JSON (output withheld)"); }
  };
  const endpoint = read("docker", ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]);
  assert.ok(typeof endpoint === "string" && endpoint.startsWith("unix:///"), "preflight requires a local Linux Docker engine");
  const ids = read("docker", ["network", "ls", "--quiet", "--no-trunc"], false).trim().split(/\s+/).filter(Boolean);
  assert.ok(ids.every(id => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)), "network observation contains an invalid identifier");
  const networks = ids.length ? read("docker", ["network", "inspect", ...ids]) : [];
  assert.ok(Array.isArray(networks) && networks.length === ids.length, "network observation inventory is incomplete");
  const routes = read("ip", ["-j", "-4", "route", "show", "table", "all"]);
  const links = read("ip", ["-j", "address", "show"]);
  return { networks, routes, links };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.ok(process.argv.length === 2 && process.platform === "linux", "run preflight without arguments on the Linux Docker engine host");
    assert.ok(!process.env.DOCKER_HOST && !process.env.DOCKER_TLS_VERIFY && !process.env.DOCKER_CERT_PATH,
      "unset Docker connection overrides before local engine-host preflight");
    const plan = admitNetworkPlan(process.env, observeNetworks());
    process.stdout.write(keys.map(key => `${key}=${plan[key]}\n`).join(""));
  } catch (error) { process.stderr.write("egress preflight: " + String(error.message).split("\n")[0] + "\n"); process.exitCode = 1; }
}
