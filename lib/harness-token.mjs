/** Operator-only client for the pinned oats-login-receive forced-command protocol.
 *  Its response is metadata, never a remote OATS envelope or shell output to forward. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readStreamBounded } from "./attachments.mjs";
import { getServer, operatorSshArgv, readServerOperatorRoutes, runRemote, serverError, targetOf } from "./servers.mjs";
import { shellWord } from "./shell-word.mjs";

const HARNESSES = new Set(["claude", "codex", "pi", "opencode"]);
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FINGERPRINT = /^sha256:[a-f0-9]{16}$/;
const delivery = (message) => serverError("E_HARNESS_TOKEN_DELIVERY", message);
const unexpected = () => delivery("Unexpected reply from the server's credential receiver.");
function replacedAt(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value;
}

function receiverReply(call, action, harness, name, secret = "") {
  // Hitting maxBuffer also signals the child; it is a bad reply, not a failed hop.
  if (call.code === "ENOBUFS") throw unexpected();
  if (call.status === 255 || ["ENOENT", "ETIMEDOUT"].includes(call.code) || call.signal) throw delivery("Couldn't reach the server. Check the operator SSH alias and connection.");
  let reply;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(call.stdout ?? "")).trim();
    if (/[\r\n]/.test(text)) throw unexpected();
    reply = JSON.parse(text);
  } catch { throw unexpected(); }
  if (!reply || reply.harness !== harness || reply.name !== name || typeof reply.ok !== "boolean") throw unexpected();
  if (!reply.ok) {
    if (call.status !== 1 || typeof reply.error !== "string" || !reply.error || reply.error.length > 2048) throw unexpected();
    const reason = secret ? reply.error.replaceAll(secret, "<redacted>") : reply.error;
    throw delivery(`The server refused the credential: ${reason.replace(/[\x00-\x1f\x7f]/g, " ")}`);
  }
  if (call.status !== 0 || !replacedAt(reply.replacedAt) || (action === "remove" ? reply.fingerprint !== null : typeof reply.fingerprint !== "string" || !FINGERPRINT.test(reply.fingerprint))) throw unexpected();
  return { fingerprint: reply.fingerprint, replacedAt: reply.replacedAt };
}

async function credentialBytes(input, harness) {
  const bad = (message) => serverError("E_HARNESS_TOKEN_INPUT", message);
  if (input === undefined) throw serverError("E_HARNESS_TOKEN_UNSUPPORTED", harness === "claude"
    ? "Interactive Claude token setup is not available. Pipe an existing inference-only setup-token with --stdin."
    : harness === "opencode" ? "Interactive opencode sign-in is not supported. Pipe a provider API key with --stdin."
      : "Browser sign-in needs refreshing credentials and an agent-writable auth file, which the read-only operator route cannot support. Pipe a non-refreshing provider API key with --stdin.");
  if (input?.isTTY) throw bad("Pipe the credential with --stdin; terminal input would show it.");
  if (!Buffer.isBuffer(input) && (!input || typeof input[Symbol.asyncIterator] !== "function")) throw bad("Supply credential bytes or a readable stdin stream.");
  let raw;
  try { raw = Buffer.isBuffer(input) ? input : await readStreamBounded(input, 65536); }
  catch (e) { throw bad(e?.code === "E_UPLOAD_TOO_LARGE" ? "The credential input is larger than 64 KiB." : "Couldn't read the credential from stdin."); }
  if (raw.length > 65536) throw bad("The credential input is larger than 64 KiB.");
  let value;
  try { value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw).replace(/^[\x09-\x0d\x20]+|[\x09-\x0d\x20]+$/g, ""); }
  catch { throw bad("The credential must be UTF-8 text."); }
  if (!value || /[\0\r\n]/.test(value)) throw bad("Give one non-empty credential line with no NUL bytes.");
  const bytes = Buffer.from(value);
  if (bytes.length > 65535) throw bad("The credential must leave room for its final newline within 64 KiB.");
  if (harness === "claude" && (!value.startsWith("sk-ant-oat") || bytes.length > 512)) throw bad("This is not a Claude setup-token. Pipe an inference-only token beginning with sk-ant-oat.");
  return bytes;
}

function olderSessions(registration, server, harness, at, secret, io) {
  const { envelope } = runRemote(targetOf(registration), ["status", "--json", "--dir", registration.workspace], { execFileSync: io.execFileSync, serverId: server, timeoutMs: 60000 });
  if (!envelope.ok || !Array.isArray(envelope.result?.agents)) throw unexpected();
  // The receiver truncates to whole seconds; starts during that second may still
  // have read the previous file. Include them rather than silently miss a session.
  const before = Date.parse(at) + 1000;
  const out = [];
  for (const agent of envelope.result.agents) for (const row of agent.instances ?? []) {
    if ((row.harness ?? row.runtime ?? agent.harness ?? agent.runtime) !== harness || row.startedAt === null) continue;
    if (typeof row.startedAt !== "string" || !Number.isFinite(Date.parse(row.startedAt))) throw unexpected();
    if (Date.parse(row.startedAt) >= before) continue;
    const item = { instance: row.instance, agent: agent.name, home: row.home, startedAt: row.startedAt };
    if (Object.values(item).some((v) => typeof v !== "string" || !v || v.includes(secret))) throw unexpected();
    out.push(item);
  }
  return out;
}

/** The operator transport is chosen and validated before any input is consumed or SSH runs. */
export async function harnessToken({ action, harness, server, name, input }, io = {}) {
  if (!["set", "status", "remove"].includes(action) || !HARNESSES.has(harness) || typeof server !== "string" || !server || (action !== "set" && input !== undefined)) throw serverError("E_BAD_ARGS", "Give set, status or remove, a harness, and --server <id>. Only set reads stdin.");
  const registration = getServer(server), route = readServerOperatorRoutes()[server];
  if (!route) {
    const command = ["oats", "server", "add", server, "--ssh", registration.sshHost, "--workspace", registration.workspace];
    for (const [key, flag] of [["label", "--label"], ["oatsPath", "--oats"], ["path", "--path"]]) {
      if (registration[key] !== undefined) command.push(flag, registration[key]);
    }
    throw serverError("E_HARNESS_TOKEN_ROUTE", `Server ${server} has no operator SSH route. Register one with ${command.map(shellWord).join(" ")} --operator-ssh <alias> --replace. Credentials never use the agent route.`);
  }
  const selectedName = name ?? registration.label;
  if (typeof selectedName !== "string" || !NAME.test(selectedName)) throw serverError("E_BAD_ARGS", "Give --name <team>: lowercase letters, digits and dashes, starting with a letter or digit, at most 63 characters. A server label is used only when it follows these rules.");
  const credential = action === "set" ? await credentialBytes(input, harness) : undefined;
  const [bin, ...args] = operatorSshArgv(route.operatorSshHost, [action === "set" ? "install" : action, harness, selectedName]);
  let call;
  try {
    call = { status: 0, stdout: (io.execFileSync ?? execFileSync)(bin, args, { stdio: [credential ? "pipe" : "ignore", "pipe", "pipe"], ...(credential ? { input: credential } : {}), maxBuffer: 65536, timeout: 60000 }) };
  } catch (error) { call = { status: error.status, stdout: error.stdout, code: error.code, signal: error.signal }; }
  // Even debug output must not forward a receiver that unexpectedly echoes input, including a
  // truncated prefix that cannot be safely redacted. Transport facts are enough to diagnose the hop.
  io.debug?.(`operator SSH: exit ${Number.isInteger(call.status) ? call.status : "unknown"}${["ENOENT", "ETIMEDOUT", "ENOBUFS", "EACCES"].includes(call.code) ? ", " + call.code : ""}`);
  const secret = credential?.toString("utf8") ?? "";
  const result = { server, action, harness, name: selectedName, ...receiverReply(call, action, harness, selectedName, secret), warnings: [] };
  if (credential) {
    if (result.fingerprint !== "sha256:" + createHash("sha256").update(credential).digest("hex").slice(0, 16)) throw unexpected();
    try { result.staleInstances = olderSessions(registration, server, harness, result.replacedAt, secret, io); }
    catch { result.staleInstances = null; result.warnings.push("The credential was installed, but older sessions could not be listed. Existing sessions pick it up at their next start; nothing was restarted."); }
  }
  return result;
}
