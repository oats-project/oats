// Pure request-URL shaping for the desktop app's privileged API proxy.
// Kept dependency-free and separate from main.mjs so the root `node --test`
// suite can cover it without loading Electron.
import { workspaceScoped } from "./renderer/workspace-routes.mjs";

export { workspaceScoped };

/** The origin request paths are resolved against: a reserved name (RFC 6761 `.invalid`), never an
 * address. The backend is reached only over main's socket (backend-client.mjs); a path that resolves
 * to any other origin is refused. */
const ORIGIN = "http://oats-backend.invalid";
const resolveOnOrigin = (pathname) => {
  const url = new URL(pathname, ORIGIN);
  return url.origin === ORIGIN ? url : null;
};

/** The request path (pathname and search) backendFetch sends for a URL apiUrl returned. */
export const requestPath = (url) => `${url.pathname}${url.search}`;

/** Classify specialized behavior from the pathname the backend will see.
 * This is NOT authorization: apiUrl must still enforce input/origin/workspace
 * constraints. In particular, even off-origin aliases need the same typed
 * refusal path and must never fall through a weaker raw-prefix guard. */
export function classifyApiRoute(pathname) {
  if (typeof pathname !== 'string') return null;
  try {
    const path = new URL(pathname, ORIGIN).pathname;
    switch (path) {
      case '/api/workspace-readiness': return 'readiness';
      case '/api/workspace-spawn-preview': return 'spawn-preview';
      case '/api/spawn': return 'spawn-apply';
      case '/api/instance-lifecycle': return 'lifecycle';
      case '/api/instance-events': return 'instance-events';
      case '/api/instance-git': return 'instance-git';
      // An instance's colour (#1421 §2) and its background flag (#1579): a routed one waits on ssh and the host (45 s),
      // past the default deadline (server/instance-record.mjs).
      case '/api/instance-color': return 'instance-color';
      case '/api/instance-background': return 'instance-background';
      case '/api/schedules': return 'schedules';
      case '/api/automations': return 'automations';
      case '/api/forge-connections':
      case '/api/instance-forge':
      case '/api/forge-roster':
      case '/api/instance-review-threads': return 'forge';
      case '/api/capabilities': return 'capabilities';
      case '/api/workspace-sync': return 'workspace-sync';
      case '/api/panel': return 'panel';
      // A remote window's Retry (#1117): answered once the server's `server roster` read has landed.
      case '/api/remote-roster/refresh': return 'remote-roster';
      // #517: a machine connect may install OATS and clone on the host; check, remove and the list wait on ssh.
      case '/api/server-connect': return 'machine-connect';
      case '/api/servers':
      case '/api/server-check':
      case '/api/server-remove': return 'machines';
      default:
        // A start or restart of an instance (`/api/start/<instance>`): the kernel may watch a launch prompt
        // for 30 s before it answers. Exactly the paths the server routes: one segment of its own characters,
        // so an encoded slash, a trailing slash or a longer path is no start.
        return /^\/api\/(?:start|restart)\/[A-Za-z0-9._-]+$/.test(path) ? 'instance-start' : null;
    }
  } catch { return null; }
}

/**
 * A window-bound request for a workspace the server does not serve (#481): the workspace id to
 * refuse with E_WORKSPACE_NOT_SERVED, or null to proxy it. `window` is the workspace the sending
 * window is bound to (null or undefined: an unbound window, never refused here). The request names
 * its workspaces with ?ws=, or, with none, it is the window's own. Any of them outside `advertised`
 * is refused, on every workspace-scoped route. With no advertised set known (startup, a restart with
 * nothing advertised before) nothing is refused: the request passes unrewritten and the server's own
 * refusal applies. Off-origin or malformed input is left to apiUrl, which throws.
 * @param {string} pathname
 * @param {string|null|undefined} window
 * @param {Set<string>|null|undefined} advertised
 * @returns {string|null}
 */
export function windowRefusal(pathname, window, advertised) {
  if (typeof window !== 'string' || !(advertised instanceof Set) || !advertised.size || typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  let url;
  try { url = resolveOnOrigin(pathname); } catch { return null; }
  if (!url || !workspaceScoped(url.pathname)) return null;
  const asked = url.searchParams.getAll('ws');
  return (asked.length ? asked : [window]).find((id) => !advertised.has(id)) ?? null;
}

/**
 * Build the request a renderer api() call becomes: a URL on a fixed origin whose path and search
 * (requestPath) main sends to its own server over its socket (backend-client.mjs).
 *
 * SECURITY: the renderer (or anything that reaches the preload bridge) never
 * names where the privileged request goes. `new URL("//host/x", origin)` — and
 * the backslash variant "/\\host/x", which WHATWG URL normalizes the same
 * way — would resolve to a DIFFERENT origin, so the resolved origin is
 * checked, not just the input shape, and such input is refused.
 *
 * @param {string} pathname  must start with "/" and stay a path
 * @param {string|null} wsId verified workspace id — pinned onto
 *                           workspace-scoped endpoints unless the caller
 *                           selects a workspace the server itself advertises
 * @param {Set<string>} [allowedWs] workspace ids the connected server
 *                           advertises (from /api/panel `workspaces[]`); a
 *                           caller ?ws= outside this set is overwritten
 * @param {{ bound?: boolean }} [options] `bound`: the request comes from a
 *                           window bound to `wsId` (#481). An omitted ?ws= is
 *                           that window's workspace and an explicit one is
 *                           never overwritten: main refuses an unadvertised
 *                           one first (windowRefusal).
 * @returns {URL}
 * @throws  on off-origin or malformed input
 */
export function apiUrl(pathname, wsId = null, allowedWs = undefined, { bound = false } = {}) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) {
    throw new Error("api: pathname must start with /");
  }
  const url = resolveOnOrigin(pathname);
  if (!url) {
    throw new Error("api: pathname resolved off-origin");
  }
  // Pinning here makes an omitted ?ws= fail SAFE (the verified workspace, or
  // a bound window's own) even before views append it themselves.
  if (wsId && workspaceScoped(url.pathname)) {
    // Preserve duplicate selectors for the strict server boundary to REFUSE;
    // set() must not turn malformed requests into an admitted read.
    if ((url.pathname === '/api/spawn' || url.pathname === '/api/automations' || url.pathname === '/api/forge-roster' || url.pathname === '/api/team-members' || /^\/api\/(?:instance|workspace)-[a-z-]+$/.test(url.pathname)) && url.searchParams.getAll('ws').length > 1) return url;
    const asked = url.searchParams.get("ws");
    // Workspace switching is a real feature on shared multi-workspace
    // servers — but only to workspaces the server actually advertises;
    // anything else from an unbound window is overwritten with the verified
    // id. A bound window's unadvertised one was refused before this.
    if (!asked || !bound && (!(allowedWs instanceof Set) || !allowedWs.has(asked))) {
      url.searchParams.set("ws", wsId);
    }
  }
  return url;
}

/**
 * The selectors a caller may name with ?ws= on the connected server (#482): every workspace view the
 * switcher lists (`/api/panel` `workspaces[].id`) and every deployment those views hold
 * (`workspaces[].deployments[]`). Rows are addressed to their deployment, so a deployment id must
 * survive apiUrl unchanged; a view id is still refused by the server on instance-addressed routes.
 * @param {unknown} workspaces  the panel's `workspaces` list
 * @returns {Set<string>}
 */
export function servedSelectors(workspaces) {
  const ids = new Set();
  for (const w of Array.isArray(workspaces) ? workspaces : []) {
    if (typeof w?.id === 'string' && w.id) ids.add(w.id);
    for (const id of Array.isArray(w?.deployments) ? w.deployments : []) if (typeof id === 'string' && id) ids.add(id);
  }
  return ids;
}

/**
 * Build fetch init for a proxied api() call. Views follow the Fetch
 * contract: common.mjs::postJson already serializes the body and sets
 * content-type — string bodies and supplied headers must pass through
 * UNCHANGED (double-serialization made /api/spawn parse a JSON string and
 * reject every spawn). Object bodies (the shell's own convenience calls)
 * are serialized here, exactly once.
 */
export function apiInit(opts) {
  const init = { method: opts?.method || "GET" };
  if (opts?.headers && typeof opts.headers === "object") init.headers = { ...opts.headers };
  if (opts?.body !== undefined) {
    if (typeof opts.body === "string") {
      init.body = opts.body;
      init.headers = { "content-type": "application/json", ...init.headers };
    } else {
      init.body = JSON.stringify(opts.body);
      init.headers = { ...init.headers, "content-type": "application/json" };
    }
  }
  return init;
}

/**
 * A read of a deployment this Desktop knows but its server does not advertise (#461): the
 * workspace id to refuse with E_WORKSPACE_NOT_SERVED, or null to proxy as usual. Only the roster
 * and agents reads, only a local deployment (an absolute path), only once an advertised set is
 * known (during a server replacement, the outgoing server's: the deployment is not served until the
 * new server advertises it, and its read must not be rewritten to another), and only for a path the
 * Desktop itself knows (`known`, checked before anything touches the filesystem). An unknown id
 * keeps today's rewrite to the verified workspace, which the renderer adopts.
 * @param {string} pathname
 * @param {{ allowedWs: Set<string>, known: (path: string) => boolean }} state
 * @returns {string|null}
 */
export function unservedWorkspace(pathname, { allowedWs, known }) {
  if (!(allowedWs instanceof Set) || !allowedWs.size || typeof pathname !== 'string') return null;
  let url;
  try { url = resolveOnOrigin(pathname); } catch { return null; }
  if (!url || !['/api/panel', '/api/agents'].includes(url.pathname)) return null;
  const asked = url.searchParams.getAll('ws');
  if (asked.length !== 1 || !asked[0].startsWith('/') || allowedWs.has(asked[0])) return null;
  try { return known(asked[0]) === true ? asked[0] : null; } catch { return null; }
}

/**
 * The proxy's refusal for an unserved deployment, as main wires it: `state()` reads the live
 * connection facts at call time. Returns the `{ ok, status, body }` the api channel resolves
 * with (404 E_WORKSPACE_NOT_SERVED, `body(workspace)`), or null to proxy as usual.
 * @param {{ state: () => { allowedWs: Set<string>, known: (path: string) => boolean },
 *           body: (workspace: string) => object }} io
 */
export function createUnservedRefusal({ state, body }) {
  return (pathname) => {
    const workspace = unservedWorkspace(pathname, state());
    return workspace ? { ok: false, status: 404, body: body(workspace) } : null;
  };
}
