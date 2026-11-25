// Is bb reachable off loopback? (contract item 7.) bb's API has no login and runs commands,
// so the provider refuses a bb whose port answers on any address of this host that is not
// loopback (`BB_SERVER_BIND_HOST=0.0.0.0`, or any other listener there). It asks the
// network itself: a TCP connect to the port on each such address. A connection that opens
// is the finding; it needs no /proc, lsof or privilege, and is the same on every platform.
import { connect } from "node:net";
import { networkInterfaces } from "node:os";

const PROBE_TIMEOUT_MS = 500;

/** This host's addresses that are not loopback, as connectable hosts (an IPv6 link-local
 *  address carries its interface: fe80::1%eth0). */
export function nonLoopbackAddresses(interfaces = networkInterfaces()) {
  const out = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const family = entry.family === 6 || entry.family === "IPv6" ? 6 : 4;
      const linkLocal = family === 6 && /^fe[89ab]/i.test(entry.address);
      out.push({ address: entry.address, family, host: linkLocal ? `${entry.address}%${name}` : entry.address });
    }
  }
  return out;
}

/** Resolves true when a TCP connection to host:port opens within the timeout. */
export function accepts(host, port, family, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let socket;
    const done = (answer) => { socket?.destroy(); resolve(answer); };
    try { socket = connect({ host, port, family, timeout: timeoutMs }); }
    catch { resolve(false); return; }
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** The `address:port` pairs, off loopback, on which one of the ports accepts a connection. */
export async function exposedListeners(ports, { interfaces, probe = accepts } = {}) {
  const addresses = nonLoopbackAddresses(interfaces);
  const checks = [];
  for (const port of [...new Set(ports)]) {
    for (const { address, family, host } of addresses) {
      checks.push(probe(host, port, family).then((open) => (open ? `${family === 6 ? `[${address}]` : address}:${port}` : null)));
    }
  }
  return (await Promise.all(checks)).filter(Boolean).sort();
}
