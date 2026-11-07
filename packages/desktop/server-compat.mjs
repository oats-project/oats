// Server compatibility probe for the desktop app — extracted from main.mjs
// so the reuse decision is unit-testable (and mutation-checkable).
//
// Reusing ANY server that answers /api/panel is not enough: an OLDER
// installed backend (e.g. an old oats-web panel on the default port) passes the
// workspace probe while lacking the desktop endpoints (/api/version,
// /api/brain, /api/file) — Brain then 404s and looks broken.
// Reuse requires the server to identify itself as THIS checkout's bundled server:
// GET /api/version must answer { capability, version } matching
// the local packages/desktop/package.json identity. On any mismatch — 404 (older
// server), wrong capability, different version — the caller spawns its own
// checkout's server on a free port and NEVER kills the foreign one. The
// startup log says which: a server of this app at another version is named
// as such (versions found and local), before any workspace mismatch.

/**
 * Decide whether an existing server may be reused.
 *
 * @param {{ ok: boolean, status?: number, body?: any } | null} versionResponse
 *        result of probing GET /api/version (null = network failure)
 * @param {{ capability: string, version: string }} local
 *        this checkout's bundled-server identity (packages/desktop/package.json)
 * @returns {{ compatible: boolean, reason: string }}
 */
export function serverCompatible(versionResponse, local) {
  if (!versionResponse || !versionResponse.ok) {
    return { compatible: false, reason: "no /api/version (older server without desktop endpoints)" };
  }
  const b = versionResponse.body || {};
  if (b.capability !== local.capability) {
    return { compatible: false, reason: `capability "${b.capability}" != "${local.capability}"` };
  }
  if (b.version !== local.version) {
    return { compatible: false, reason: `version ${b.version} != local ${local.version}` };
  }
  return { compatible: true, reason: "matches local checkout" };
}

/**
 * The server-selection decision — the seam main.mjs::ensureServer runs, with
 * injectable probes so the reuse/spawn choice is testable end-to-end
 * (review srvcompat: fake-server tests that re-implement the decision leave
 * the production gate unprotected).
 *
 * @param {object} io
 * @param {() => Promise<Array<{id:string,name:string}>|{forbidden:true}|null>} io.panelWorkspaces
 * @param {() => Promise<{ok:boolean,status?:number,body?:any}|null>} io.probeVersion
 * @param {(workspaces: Array<{id:string}>) => string|null} io.matchWorkspace
 * @param {{capability:string,version:string}} io.local
 * @returns {Promise<{ action: "reuse", wsId: string } |
 *                    { action: "spawn", portOccupied: boolean, reason: string }>}
 *   portOccupied: a server IS listening on the port (wrong workspace or
 *   incompatible) — the caller must pick another port; reason is for logs.
 */
export async function selectServer(io) {
  const version = await io.probeVersion();
  const existing = await io.panelWorkspaces();
  if (existing?.forbidden) return { action: "spawn", portOccupied: true, reason: "another token" };
  if (!existing) return { action: "spawn", portOccupied: false, reason: "no server on the port" };
  // Identity first, so the log names the real cause (#698): this app's own
  // server at another version (another installed Desktop, a dev checkout, or
  // one an earlier Desktop left running) is reported as that, whatever it
  // serves. It is never stopped: HTTP cannot tell a live owner from an orphan.
  const found = version?.ok ? version.body : null;
  if (found?.capability === io.local.capability && found.version !== io.local.version) {
    return { action: "spawn", portOccupied: true,
      reason: `this app's server at version ${found.version} (this app is ${io.local.version}), not started by this app — left running` };
  }
  const wsId = io.matchWorkspace(existing);
  if (!wsId) {
    return { action: "spawn", portOccupied: true, reason: `serves ${existing.map((w) => w.name).join(", ")} — not the requested workspace` };
  }
  // Workspace coverage is necessary but NOT sufficient: an older installed
  // server answers /api/panel yet lacks the desktop endpoints. Reuse only a
  // server that identifies as THIS checkout via /api/version.
  const compat = serverCompatible(version, io.local);
  if (!compat.compatible) return { action: "spawn", portOccupied: true, reason: `incompatible (${compat.reason})` };
  return { action: "reuse", wsId };
}

/**
 * The full ensure step — selection PLUS the caller's consumption of it
 * (review srvcompat3: tests proved selectServer emits portOccupied but not
 * that the caller consumes it; reverting the caller to reason-string
 * matching left tests green). Injectable port/spawn effects.
 *
 * @param {object} io   selectServer's io PLUS:
 * @param {number} io.port                       current port
 * @param {(from: number) => Promise<number>} io.freePort
 * @param {(port: number) => void} io.spawnServer
 * @param {(msg: string) => void} [io.log]
 * @param {(io: object) => Promise<object>} [io.select]  the selection
 *        function — defaults to selectServer; injectable so consumer tests
 *        can supply arbitrary decisions (incl. arbitrary reason text) and
 *        prove the caller keys on portOccupied, never on wording
 * @returns {Promise<{ spawned: boolean, port: number, wsId: string|null }>}
 *   wsId is null when spawned (the caller verifies the new server's
 *   workspace during its readiness wait).
 */
export async function ensureServerOnPort(io) {
  const choice = await (io.select || selectServer)(io);
  if (choice.action === "reuse") return { spawned: false, port: io.port, wsId: choice.wsId };
  let port = io.port;
  if (choice.portOccupied) {
    const said = `server on ${port} — ${choice.reason}`;
    try { port = await io.freePort(port + 1); } catch (e) { io.log?.(`${said} — no free port for a dedicated one`); throw e; }
    io.log?.(`${said} — starting a dedicated one on ${port}`);
  }
  io.spawnServer(port);
  return { spawned: true, port, wsId: null };
}
