// Server identity check for the desktop app — extracted from main.mjs so the
// readiness decision is unit-testable (and mutation-checkable).
//
// Main only ever talks to a server it started itself, over that server's own
// socket and credential (server-host.mjs, backend-client.mjs); it never selects
// or reuses another one. After a replacement (a workspace add or its rollback)
// the new server is ready only once GET /api/version answers { capability,
// version } matching the local packages/desktop/package.json identity, and it
// advertises the workspace (workspace-registry.mjs createAddExecutor).

/**
 * Whether a /api/version answer identifies this checkout's bundled server.
 *
 * @param {{ ok: boolean, status?: number, body?: any } | null} versionResponse
 *        result of probing GET /api/version (null = transport failure)
 * @param {{ capability: string, version: string }} local
 *        this checkout's bundled-server identity (packages/desktop/package.json)
 * @returns {{ compatible: boolean, reason: string }}
 */
export function serverCompatible(versionResponse, local) {
  if (!versionResponse || !versionResponse.ok) {
    return { compatible: false, reason: "no /api/version answer" };
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
