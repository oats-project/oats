// The wire between the kernel and this provider (the kernel's session-provider contract):
// one JSON request on stdin, exactly one JSON document on stdout, exit 0 for a result and
// for a refusal alike. A refusal says nothing happened. Where the provider cannot tell
// (a spawn or a tell whose fate is unknown) it answers nothing and exits nonzero: a failed
// call, which the kernel treats as uncertain. All of the envelope lives here.
//
//   request  { schemaVersion: 1, wire: "1.3", phase: "session", capability, provider, verb, input }
//   answer   the same five header keys, then  ok: true,  result: { … }
//                                         or  ok: false, error: { code, message }
//
// The settings are the home's recorded ones, in OATS_SETTINGS (the hook environment); the
// readiness verb, which also runs for a soul with no home, may carry them in its input.
import { InDoubt, ProviderError, bounded, isObject } from "./errors.mjs";
import { graceOf } from "./stop.mjs";

export const PROVIDER = "bb";
// The one version of this wire the provider speaks. The manifest declares the same
// (`sessionProviders.bb.wire`), and the kernel sends its own in every request: a kernel
// that speaks another, or names none, is refused before anything is read or done.
export const WIRE = "1.3";
// What a failure the provider did not classify means, per verb (contract item 1).
const VERB_FAILURE = {
  launch: "E_SESSION_START_FAILED",
  inspect: "E_SESSION_UNAVAILABLE",
  inspectMany: "E_SESSION_UNAVAILABLE",
  input: "E_SESSION_INPUT_FAILED",
  stop: "E_SESSION_STOP_FAILED",
  check: "E_BACKEND_NOT_READY",
};
export const VERBS = Object.freeze(Object.keys(VERB_FAILURE));
// The provider's own time per call, inside the kernel's (launch 120 s; stop 20 s plus its
// graceSeconds; the others, the readiness check included, 20 s).
const VERB_BUDGET_MS = { launch: 100_000, inspect: 16_000, inspectMany: 16_000, input: 16_000, stop: 16_000, check: 16_000 };
const budgetMs = (verb, input) => VERB_BUDGET_MS[verb] + (verb === "stop" ? graceOf(input) * 1000 : 0);
const MAX_STDIN = 8 * 1024 * 1024;

export async function readStdin(stream = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_STDIN) throw new ProviderError("E_BACKEND_REQUEST", `the request is larger than ${MAX_STDIN} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The settings the kernel recorded for the home (OATS_SETTINGS), or none. */
export function settingsFromEnv(env) {
  if (typeof env.OATS_SETTINGS !== "string" || !env.OATS_SETTINGS.trim()) return {};
  try { return JSON.parse(env.OATS_SETTINGS); }
  catch { throw new ProviderError("E_BACKEND_SETTINGS", "OATS_SETTINGS is not JSON"); }
}

function refusal(error, fallback) {
  if (error instanceof ProviderError) return { code: error.code, message: bounded(error.message) };
  // A bug of ours, or of the platform: the verb's own failure, with the text.
  return { code: fallback, message: bounded(`the bb provider failed: ${error?.message ?? String(error)}`) };
}

/** Run one call. `handlers[verb](input, rawSettings, {deadline, env})` resolves the
 *  result or throws. → the answer envelope. It throws only InDoubt: an outcome that is
 *  neither a result nor a refusal has no envelope (the caller ends the call nonzero). */
export async function answer(verb, text, handlers, { env = process.env, now = Date.now } = {}) {
  const head = { schemaVersion: 1, phase: "session", capability: env.OATS_CAPABILITY ?? null, provider: PROVIDER, verb };
  const fallback = VERB_FAILURE[verb] ?? "E_BACKEND_REQUEST";
  try {
    let request;
    try { request = JSON.parse(text); }
    catch { throw new ProviderError(fallback, "the request on stdin is not one JSON document"); }
    if (!isObject(request)) throw new ProviderError(fallback, "the request is not a JSON object");
    if (typeof request.capability === "string") head.capability = request.capability;
    if (typeof request.provider === "string") head.provider = request.provider;
    if (request.wire !== WIRE) {
      const theirs = typeof request.wire === "string" && /^\d{1,3}\.\d{1,3}$/.test(request.wire) ? `wire ${request.wire}` : request.wire === undefined ? "no wire version (an older kernel)" : "a wire version this provider cannot read";
      throw new ProviderError("E_BACKEND_WIRE", `the kernel speaks ${theirs}, and this provider (oats.bb) speaks wire ${WIRE}: use an OATS and an oats.bb release that agree`);
    }
    if (request.schemaVersion !== 1) throw new ProviderError(fallback, `the request's schemaVersion is ${JSON.stringify(request.schemaVersion)}; this provider speaks 1`);
    if (request.phase !== "session") throw new ProviderError(fallback, `the request's phase is ${JSON.stringify(request.phase)}, not "session"`);
    if (request.verb !== verb) throw new ProviderError(fallback, `the request's verb is ${JSON.stringify(request.verb)}, and the command run is ${verb}`);
    if (request.provider !== PROVIDER) throw new ProviderError(fallback, `the request names the session provider ${JSON.stringify(request.provider)}; this one is ${PROVIDER}`);
    const settings = verb === "check" && isObject(request.input) && request.input.settings !== undefined && request.input.settings !== null
      ? request.input.settings : settingsFromEnv(env);
    const result = await handlers[verb](request.input, settings, { deadline: now() + budgetMs(verb, request.input), env });
    return { ...head, ok: true, result };
  } catch (error) {
    if (error instanceof InDoubt) throw error;
    return { ...head, ok: false, error: refusal(error, fallback) };
  }
}
