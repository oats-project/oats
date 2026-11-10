/** Operator-only client for the pinned oats-login-receive forced-command protocol.
 *  Its response is metadata, never a remote OATS envelope or shell output to forward. */
import { execFileSync } from "node:child_process";
import { getServer, operatorSshArgv, readServerOperatorRoutes, serverError } from "./servers.mjs";

const HARNESSES = new Set(["claude", "codex", "pi", "opencode"]);
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FINGERPRINT = /^sha256:[a-f0-9]{16}$/;
const delivery = (message) => serverError("E_HARNESS_TOKEN_DELIVERY", message);
const unexpected = () => delivery("Unexpected reply from the server's credential receiver.");
function replacedAt(value) {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value;
}

function receiverReply(call, action, harness, name) {
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
    throw delivery(`The server refused the credential: ${reply.error.replace(/[\x00-\x1f\x7f]/g, " ")}`);
  }
  if (call.status !== 0 || !replacedAt(reply.replacedAt) || (action === "remove" ? reply.fingerprint !== null : typeof reply.fingerprint !== "string" || !FINGERPRINT.test(reply.fingerprint))) throw unexpected();
  return { fingerprint: reply.fingerprint, replacedAt: reply.replacedAt };
}

/** The operator transport is chosen and validated before any input is consumed or SSH runs. */
export async function harnessToken({ action, harness, server, name }, io = {}) {
  if (!["status", "remove"].includes(action) || !HARNESSES.has(harness) || typeof server !== "string" || !server) throw serverError("E_BAD_ARGS", "Give status or remove, a harness, and --server <id>.");
  const registration = getServer(server), route = readServerOperatorRoutes()[server];
  if (!route) throw serverError("E_HARNESS_TOKEN_ROUTE", `Server ${server} has no operator SSH route. Register one with oats server add ${server} --operator-ssh <alias> --replace (or oats server connect). Credentials never use the agent route.`);
  const selectedName = name ?? registration.label;
  if (typeof selectedName !== "string" || !NAME.test(selectedName)) throw serverError("E_BAD_ARGS", "Give --name <team>: lowercase letters, digits and dashes, starting with a letter or digit, at most 63 characters. A server label is used only when it follows these rules.");
  const [bin, ...args] = operatorSshArgv(route.operatorSshHost, [action, harness, selectedName]);
  let call;
  try {
    call = { status: 0, stdout: (io.execFileSync ?? execFileSync)(bin, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 65536, timeout: 60000 }) };
  } catch (error) { call = { status: error.status, stdout: error.stdout, code: error.code, signal: error.signal }; }
  return { server, action, harness, name: selectedName, ...receiverReply(call, action, harness, selectedName), warnings: [] };
}
