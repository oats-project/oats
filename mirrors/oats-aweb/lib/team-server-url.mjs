// The aweb service URL in the form AWID's aweb.team-server/1 record holds it. aw 1.36.56 publishes
// only a canonical URL and refuses any other (awid/team_server.go:116 CanonicalTeamServerURL), while
// register strips a trailing slash (cmd/aw/helpers.go:851 cleanBaseURL). Setup puts the service in
// this form once, so register, the record and connect all name the same URL.
import { isIP } from "node:net";

const MAX_URL_BYTES = 2048; // awid TeamServerMaxURLBytes
const QUERY_OR_USERINFO = "must not include userinfo, params, query or fragment";

/** { url } in aw's canonical form, or { reason } as aw words its refusal (after "server_url "). */
export function canonicalTeamServerURL(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { reason: "is required" };
  let parsed;
  try { parsed = new URL(value); } catch { return { reason: "is not a URL" }; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { reason: "must use https" };
  if (parsed.username || parsed.password || /[?#]/.test(value)) return { reason: QUERY_OR_USERINFO };
  const host = parsed.hostname;
  if (!host) return { reason: "must include a host" };
  const path = parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname;
  if (path.endsWith("/") || path.includes("//")) return { reason: "must not end with a slash or contain empty segments" };
  if (path.split("/").pop().includes(";")) return { reason: QUERY_OR_USERINFO };
  const bare = host.replace(/^\[(.*)\]$/, "$1");
  // Go's net.IP.IsLoopback: 127.0.0.0/8, ::1, and 127.0.0.0/8 mapped into IPv6 (which URL writes as ::ffff:7fXX:XXXX).
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(bare);
  const loopback = host === "localhost" || host.endsWith(".localhost") || (isIP(bare) === 4 && bare.startsWith("127.")) || bare === "::1" || (!!mapped && parseInt(mapped[1], 16) >> 8 === 0x7f);
  if (parsed.protocol === "http:" && !loopback) return { reason: "must use https outside loopback hosts" };
  if (isIP(bare) && !loopback) return { reason: "must not use a literal IP address" };
  const url = `${parsed.protocol}//${parsed.host}${path}`;
  if (Buffer.byteLength(url) > MAX_URL_BYTES) return { reason: `must be at most ${MAX_URL_BYTES} bytes` };
  return { url };
}
