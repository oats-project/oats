// The backend client: main's only way to talk to the server child it started.
//
// Main holds one LEASE per server generation: { generation, child, socketPath, secret, ready }.
// A lease becomes ready only on that child's own stdout ready line (watchReadyLine), and is revoked
// on the child's exit or error, on stop and at the start of a replacement (server-host.mjs owns
// those transitions). backendFetch sends only on the current ready lease, over its Unix socket,
// with `host: localhost` and `authorization: Bearer <secret>` set last (a caller's own spelling of
// either is dropped). It reads the whole reply (bounded) and answers a WHATWG Response built from
// those bytes, so callers keep .ok/.status/.json()/.text()/.body.getReader(). A lease covers the
// whole reply: revoking it aborts every request in flight on it, body included, and a reply whose
// lease is no longer current and ready after its last byte is discarded (a transport failure).
// Without a current ready lease nothing is sent. A caller that commits state after a later await
// keeps its own generation check right before the commit (server-host.mjs `held()`, with main's epoch).
//
// The secret lives in the lease only: never in a URL, a log line, an error message or a reply.
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";

export const READY_LINE = "oats-desktop-server ready";

/** A transport failure of backendFetch; `code` says which, the message names no secret or path. */
export class BackendUnavailable extends Error {
  constructor(code, message) { super(message); this.name = "BackendUnavailable"; this.code = code; }
}
const unavailable = (code, message) => new BackendUnavailable(code, message);

const NULL_BODY = new Set([101, 204, 205, 304]);
/** No backend reply is larger than this; one that is fails as a transport failure. */
export const MAX_REPLY_BYTES = 64 * 1024 * 1024;

/** Whether `path` is one backendFetch may send: `/` or a path under `/api/`, never a URL. */
export function backendPath(path) {
  return typeof path === "string" && (path === "/" || path.startsWith("/api/")) && !/[\s\\]/.test(path);
}

/** A caller's headers (an object, a Headers or entry pairs) as a plain lowercase object, without
 * `authorization` or `host` in any spelling. */
function callerHeaders(given) {
  const out = {};
  if (!given) return out;
  const entries = typeof given.entries === "function" && !Array.isArray(given) ? [...given.entries()]
    : Array.isArray(given) ? given : Object.entries(given);
  for (const [name, value] of entries) {
    const key = String(name).toLowerCase();
    if (key === "authorization" || key === "host" || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * @param {object} [io]
 * @param {typeof httpRequest} [io.request]   node:http's request (injectable)
 * @param {(lease: object, error: Error) => void} [io.onSocketLost]  a connect to the current ready
 *        lease failed with ENOENT (its socket file is gone); the lease is already revoked
 * @param {number} [io.maxBytes]  the reply budget
 */
export function createBackendClient({ request = httpRequest, onSocketLost = () => {}, maxBytes = MAX_REPLY_BYTES } = {}) {
  let current = null;
  let generation = 0;

  /** A new lease for a child just started; it becomes the current one, not ready. */
  function begin({ child, socketPath, secret }) {
    if (current) revoke(current);
    const lease = { generation: ++generation, child, socketPath, secret, ready: false, revoked: false, abort: new AbortController(), waiters: [] };
    current = lease;
    return lease;
  }
  /** The lease's child printed its ready line: it is ready, if it is still the current one. */
  function markReady(lease) {
    if (lease !== current || lease.revoked || lease.ready) return false;
    lease.ready = true;
    for (const w of lease.waiters.splice(0)) w.ok();
    return true;
  }
  /** Revoke a lease (the current one when none is named): every request in flight on it fails. */
  function revoke(lease = current, reason = "E_BACKEND_REVOKED") {
    if (!lease || lease.revoked) return;
    lease.revoked = true; lease.ready = false;
    if (current === lease) current = null;
    lease.abort.abort(unavailable(reason, "the backend server changed while the request was in flight"));
    for (const w of lease.waiters.splice(0)) w.bad(unavailable(reason, "the backend server ended before it was ready"));
  }
  /** Resolves when `lease` is ready; rejects once it is revoked first. */
  function whenReady(lease) {
    if (lease.ready) return Promise.resolve();
    if (lease.revoked) return Promise.reject(unavailable("E_BACKEND_REVOKED", "the backend server ended before it was ready"));
    return new Promise((ok, bad) => lease.waiters.push({ ok, bad }));
  }

  /** The one way main reaches the server. Rejects (BackendUnavailable) with nothing sent when there is no
   * current ready lease or the path is not one it may send. The whole reply is read (bounded, under the
   * caller's signal and the lease's own) before it resolves, and only while its lease is still current and
   * ready after the last byte. */
  async function backendFetch(path, init = {}) {
    if (!backendPath(path)) throw unavailable("E_BAD_PATH", "backendFetch takes a path under /api/, never a URL");
    const lease = current;
    if (!lease || !lease.ready || lease.revoked) throw unavailable("E_BACKEND_UNAVAILABLE", "the backend server is not ready");
    const body = init.body;
    if (body !== undefined && body !== null && typeof body !== "string" && !(body instanceof Uint8Array)) {
      throw unavailable("E_BAD_BODY", "backendFetch sends a string or bytes body");
    }
    const headers = { ...callerHeaders(init.headers), host: "localhost" };
    headers.authorization = `Bearer ${lease.secret}`; // last: nothing a caller passed replaces it
    const signal = init.signal ? AbortSignal.any([init.signal, lease.abort.signal]) : lease.abort.signal;
    const live = () => lease === current && lease.ready && !lease.revoked;
    const revokedError = () => unavailable("E_BACKEND_REVOKED", "the backend server changed while the request was in flight");
    let reply;
    try {
      reply = await new Promise((resolve, reject) => {
        let req;
        try { req = request({ socketPath: lease.socketPath, path, method: init.method || "GET", headers, signal }); }
        catch { return reject(unavailable("E_BAD_REQUEST", "the request could not be made")); }
        let answered = false;
        req.on("error", (error) => {
          if (error?.code === "ENOENT" && !answered && live()) {
            revoke(lease, "E_BACKEND_SOCKET_LOST");
            try { onSocketLost(lease, error); } catch { /* reported by the callee */ }
          }
          reject(error);
        });
        req.on("response", (res) => {
          answered = true;
          const chunks = []; let size = 0;
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxBytes) { res.destroy(unavailable("E_BACKEND_REPLY_LIMIT", "the backend reply exceeds its budget")); return; }
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("aborted", () => reject(unavailable("E_BACKEND_TRANSPORT", "the backend reply was cut short")));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks, size) }));
        });
        if (body !== undefined && body !== null) req.write(body);
        req.end();
      });
    } catch (error) {
      if (lease.revoked) throw revokedError();
      if (init.signal?.aborted) throw init.signal.reason ?? error;
      throw error instanceof BackendUnavailable ? error : unavailable("E_BACKEND_TRANSPORT", "the backend server could not be reached");
    }
    // After the last byte: a reply of a lease revoked meanwhile is discarded.
    if (!live()) throw revokedError();
    const h = new Headers();
    for (const [k, v] of Object.entries(reply.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
    return new Response(NULL_BODY.has(reply.status) ? null : reply.bytes, { status: reply.status, headers: h });
  }

  return { begin, markReady, revoke, whenReady, current: () => current, fetch: backendFetch };
}

/** Watch a child's stdout line by line; `onReady()` once on the exact ready line. Returns a stop function. */
export function watchReadyLine(stream, onReady) {
  let buffered = "", seen = false;
  const onData = (chunk) => {
    if (seen) return;
    buffered += String(chunk);
    const lines = buffered.split("\n");
    buffered = lines.pop().slice(-4096);
    if (lines.some((line) => line.replace(/\r$/, "") === READY_LINE)) { seen = true; stream.off("data", onData); onReady(); }
  };
  stream.on("data", onData);
  return () => stream.off("data", onData);
}

/**
 * The socket-loss recovery (a temp cleaner removed the socket file under a running app): the
 * first loss replaces the server; another inside `windowMs` of the last replacement is a failed
 * start. `replace()` and `fail(message)` are main's.
 */
export function createSocketLossRecovery({ replace, fail, log = () => {}, now = Date.now, windowMs = 60_000 }) {
  let last = -Infinity;
  return function lost() {
    const at = now();
    if (at - last < windowMs) {
      fail("the backend server's socket disappeared again within a minute of its replacement; not restarting it");
      return "failed";
    }
    last = at;
    log("the backend server's socket disappeared; starting a new server");
    void Promise.resolve().then(replace).catch((e) => fail(`the backend server could not be restarted: ${e?.message || e}`));
    return "replaced";
  };
}
