/** Preflight checks over admitted runtime metadata. Passing these does not
 * prove firewall/CNI enforcement; the shared journey also probes the boundary. */
import assert from "node:assert/strict";
import { posix } from "node:path";

export function assertComposeBoundary({ agent, egress, agentsNetwork, servicesNetwork, approvedAgentMounts, protectedSources }) {
  assert.ok(typeof agentsNetwork.Id === "string" && agentsNetwork.Id.length > 0
    && typeof servicesNetwork.Id === "string" && servicesNetwork.Id.length > 0
    && agentsNetwork.Id !== servicesNetwork.Id, "expected distinct identified runtime networks");
  assert.ok(agentsNetwork.Internal === true && agentsNetwork.EnableIPv6 === false, "expected an isolated IPv4 agents network");
  for (const info of [agent, egress]) {
    const host = info.HostConfig;
    assert.ok(host && host.Privileged === false && host.ReadonlyRootfs === true
      && JSON.stringify(host.CapDrop) === '["ALL"]' && (host.CapAdd ?? []).length === 0
      && JSON.stringify(host.SecurityOpt) === '["no-new-privileges:true"]'
      && !host.PidMode && host.IpcMode === "private"
      && typeof host.NetworkMode === "string" && host.NetworkMode !== "host"
      && !host.NetworkMode.startsWith("container:")
      && !(host.ExtraHosts||[]).length && !(host.Dns||[]).length
      && !(host.Devices||[]).length && !(host.DeviceRequests||[]).length,
    "runtime isolation differs from the approved boundary");
  }
  assert.equal(agentsNetwork.Options?.["com.docker.network.bridge.gateway_mode_ipv4"], "isolated",
    "agents network requires isolated gateway mode");
  const endpoints = Object.values(agent.NetworkSettings?.Networks ?? {});
  assert.equal(endpoints.length, 1, "agent must have exactly one isolated network");
  assert.equal(endpoints[0].NetworkID, agentsNetwork.Id, "agent network must be the approved isolated network");
  const proxyNetworks = Object.values(egress.NetworkSettings?.Networks ?? {}).map(endpoint => endpoint.NetworkID);
  assert.ok(proxyNetworks.length === 2 && new Set(proxyNetworks).size === 2
    && proxyNetworks.includes(agentsNetwork.Id) && proxyNetworks.includes(servicesNetwork.Id),
  "proxy must join exactly the agents and services networks");
  assert.ok(Array.isArray(agent.Mounts) && Array.isArray(approvedAgentMounts)
    && Array.isArray(protectedSources), "agent mount inventory must be complete");
  const mountKey = mount => JSON.stringify([mount.Type, mount.Source, mount.Destination, mount.RW]);
  const actual = agent.Mounts.map(mountKey).sort(), expected = approvedAgentMounts.map(mountKey).sort();
  assert.ok(actual.length === expected.length && actual.every((key,index) => key === expected[index]), "agent mounts differ from the approved inputs");
  for (const mount of agent.Mounts) {
    assert.ok(typeof mount.Destination === "string" && mount.Destination.startsWith("/")
      && !posix.normalize(mount.Destination).startsWith("/run/secrets"), "agent must not mount service secrets");
    assertPublicMountSource(mount.Source, protectedSources);
    if (["/etc/agent-trust/ca.pem", "/mirrors"].includes(mount.Destination)) {
      assert.equal(mount.RW,false,"public input mounts must be read-only");
      for (const writable of agent.Mounts.filter(item => item.RW)) assertPublicMountSource(mount.Source,[writable.Source],"public input");
    }
  }
}

export function assertPublicMountSource(value, protectedSources, label = "agent") {
  assert.ok(typeof value === "string" && value.startsWith("/"), `${label} mount source must be an absolute runtime path`);
  const source = posix.normalize(value);
  for (const protectedSource of [...protectedSources, "/run/docker.sock", "/var/run/docker.sock"]) {
    assert.ok(typeof protectedSource === "string" && protectedSource.startsWith("/"), `${label} protected-source inventory is invalid`);
    const secret = posix.normalize(protectedSource);
    assert.ok(source !== secret && !source.startsWith(secret + "/") && !secret.startsWith(source.endsWith("/") ? source : source + "/"), `${label} mount overlaps a protected service source`);
  }
}
