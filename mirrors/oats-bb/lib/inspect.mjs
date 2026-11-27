// inspect and inspectMany: what bb shows of a home's thread, from one `bb thread list`.
import { isAbsolute } from "node:path";
import { bbClient } from "./bb.mjs";
import { ProviderError, bounded, fail, isObject, recode } from "./errors.mjs";
import { UNRECOGNISED, processLook } from "./processes.mjs";
import { inspectHome, readEndpoint } from "./threads.mjs";

function readHome(entry) {
  if (!isObject(entry)) throw fail("E_SESSION_UNAVAILABLE", "the inspect input is not an object");
  if (typeof entry.home !== "string" || !isAbsolute(entry.home)) throw fail("E_SESSION_UNAVAILABLE", "the inspect input's home must be an absolute path");
  return { home: entry.home, endpoint: readEndpoint(entry.endpoint) };
}

/** bb unreachable, or any other failed read, is an error: never "stopped". */
const unavailable = (error) => recode("E_SESSION_UNAVAILABLE", error);

/** Whether bb is at the version the provider is pinned to (`settings.oats.bb.version`),
 *  read as readiness reads it (`bb --version`), once per call at most and only when asked.
 *  → a function → Promise<boolean>: false also where the version cannot be read, or no
 *  pin is set. It decides one thing (settle, below) and refuses nothing: an inspect is
 *  answered at any bb version. */
function pinnedVersion(settings, { deadline, env }) {
  let read = null;
  return () => {
    read ??= settings.version == null ? Promise.resolve(false)
      : bbClient({ cli: settings.cli, hostDaemonPort: settings.hostDaemonPort, server: null, deadline, env }).version().then((version) => version === settings.version, (error) => {
        if (!(error instanceof ProviderError)) throw error;
        return false;
      });
    return read;
  };
}

/** An inspect answer whose `running` the process look left open (UNRECOGNISED: a harness
 *  in the home, by its name, the thread's id and its working directory, whose parent is
 *  not bb's runner as this provider knows it), settled by bb's version (contract r29, A20,
 *  the release lane's ruling). At the provider's pin the runner's command line is the one
 *  the contract tests pin, so that process is one the agent itself started and left
 *  running: `running: false`. At another version, or where the version cannot be read, bb
 *  may have moved its runner: `running: null`, it cannot be told. */
async function settle(answer, atPin) {
  return answer.running === UNRECOGNISED ? { ...answer, running: (await atPin()) ? false : null } : answer;
}

/** → { present, state, running, open? } */
export async function inspect(input, settings, { deadline, env = process.env } = {}) {
  try {
    const subject = readHome(input);
    const bb = bbClient({ cli: settings.cli, hostDaemonPort: settings.hostDaemonPort, server: subject.endpoint.server, deadline, env });
    return await settle(inspectHome(subject, await bb.threads(), processLook()), pinnedVersion(settings, { deadline, env }));
  } catch (error) { throw unavailable(error); }
}

/** → { results: [<inspect answer> | { error: { code, message } }] }, in the input's
 *  order: one thread list per bb server, whatever the number of homes. */
export async function inspectMany(input, settings, { deadline, env = process.env } = {}) {
  if (!isObject(input) || !Array.isArray(input.homes)) throw fail("E_SESSION_UNAVAILABLE", "the inspectMany input has no homes list");
  const lists = new Map();
  // One look at this host's processes for all the homes, and only if a thread needs it
  // (one in error, or one at rest: lib/threads.mjs). And one read of bb's version, only
  // if a home's answer needs it.
  const processes = processLook();
  const atPin = pinnedVersion(settings, { deadline, env });
  const listOf = (server) => {
    if (!lists.has(server)) lists.set(server, bbClient({ cli: settings.cli, hostDaemonPort: settings.hostDaemonPort, server, deadline, env }).threads().then((threads) => ({ threads }), (error) => ({ error })));
    return lists.get(server);
  };
  const results = await Promise.all(input.homes.map(async (entry) => {
    try {
      const subject = readHome(entry);
      const read = await listOf(subject.endpoint.server);
      if (read.error) throw read.error;
      return await settle(inspectHome(subject, read.threads, processes), atPin);
    } catch (error) {
      const refused = unavailable(error);
      return { error: { code: refused.code, message: bounded(refused.message) } };
    }
  }));
  return { results };
}
