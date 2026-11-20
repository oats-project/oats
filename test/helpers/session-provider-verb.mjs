// One verb on a provider home, as a process of its own (so a test can kill it, or run several side by
// side): `node session-provider-verb.mjs <verb> <home>` prints one JSON line, `{ ok: true, stopped }` (`stopped`: the verb says it stopped a session) or
// `{ ok: false, code, message }` (`code` null for an error that is no kernel answer: a defect).
import { inputInstanceSession, restartInstanceSession, startInstanceSession, stopInstanceSession } from "../../lib/core.mjs";

const [verb, home] = process.argv.slice(2);
const VERBS = {
  start: () => startInstanceSession(home, {}),
  restart: () => restartInstanceSession(home, {}),
  resume: () => startInstanceSession(home, { resume: true }),
  stop: () => stopInstanceSession(home, {}),
  "host stop": () => stopInstanceSession(home, { withHost: true, graceMs: 20000 }),
  input: () => inputInstanceSession(home, "a mail"),
};
let answer;
try { const said = await VERBS[verb](); answer = { ok: true, stopped: said?.stopped === true }; }
catch (e) { answer = { ok: false, code: typeof e?.code === "string" ? e.code : null, message: String(e?.stack ?? e).slice(0, 600) }; }
process.stdout.write(`${JSON.stringify(answer)}\n`);
