/** Private entry point of lib/host-run.mjs; no CLI or provider contract. One process per running
 *  home when the host stops: `node host-stop-child.mjs <home> <grace ms>` stops that home's session
 *  with the host (lib/core.mjs stopInstanceSession, `withHost`: its record asks for a resume and is
 *  written before the harness is signalled) and prints one JSON line:
 *    { ok: true, home, stopped, alreadyIdle, state }
 *    { ok: false, home, code, message, stillRunning }
 *  A stop waits synchronously for its harness, so each home has a process of its own and the homes
 *  stop side by side. It exits 0 whatever the stop answered: the answer is the line. */
import { stillRunningOf, stopInstanceSession } from "./core.mjs";
import { kernelCode, reportDefect } from "./errors.mjs";

const [home, grace] = process.argv.slice(2);
let answer;
try {
  const { stopped, alreadyIdle, state } = stopInstanceSession(home, { graceMs: Number(grace), withHost: true });
  answer = { ok: true, home, stopped, alreadyIdle, state };
} catch (e) {
  reportDefect(e); // the error becomes a row here: its stack would otherwise be lost
  answer = { ok: false, home, code: kernelCode(e, "E_SESSION_STOP_FAILED"), message: String(e?.message ?? e), stillRunning: stillRunningOf(e) };
}
process.stdout.write(`${JSON.stringify(answer)}\n`);
