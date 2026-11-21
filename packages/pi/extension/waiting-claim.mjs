/**
 * waiting-claim.mjs — the bridge's waiting claim on its home: the kernel's own
 * (`oats instance waiting`, producer `oats.pi`), which shows the instance as
 * needing input and, with reason `question`, holds a scheduled wake's Enter.
 *
 * A producer holds one claim, and the bridge has two things to say: a dialog is
 * open (ui-prompt.mjs) and the last turn failed (failed-turn.mjs). The open
 * dialog is shown over the failed turn, because an Enter would answer it, and a
 * dialog that closes shows the failed turn again while it still stands.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";

/** The characters the kernel refuses in a claim's message: a copy of its set
 *  (lib/refused-text.mjs REFUSED_TEXT), which this package cannot import before it
 *  has found the kernel. A claim the kernel refuses is a stuck instance nobody
 *  sees. A test pins the two equal. */
export const MESSAGE_REFUSED = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF\u{E0000}-\u{E007F}]/gu;
/** The kernel's longest message, in code points (lib/instance-events.mjs WAITING_MESSAGE_MAX). */
const MESSAGE_MAX = 200;

/** One message the kernel accepts, whatever the text: one line, the refused
 *  characters replaced, cut to fit. "" for a text that says nothing. */
export function claimMessage(text) {
  const line = typeof text === "string" ? text.replace(/\s+/gu, " ").trim().replace(MESSAGE_REFUSED, "\ufffd") : "";
  const points = [...line];
  return points.length > MESSAGE_MAX ? `${points.slice(0, MESSAGE_MAX - 1).join("")}…` : line;
}

/** The home's claim: `asked(message)` while a dialog is open (a string, "" for one
 *  with no words) and `asked(undefined)` once it closed; `turnFailed(message)` for a
 *  turn that failed and `turnFailed(undefined)` once that is over.
 *
 *  A write starts a process only when the claim to show changes. This process cannot
 *  know what an earlier pi in the session claimed (a /reload, a pi started again in
 *  the pane), so its first write always goes, a clear included. Writes run one at a
 *  time, so a clear cannot pass the set it answers, and a session that ends waits
 *  for them: a /reload's next bridge starts its own queue, and a set still under way
 *  would land after its clear, and a pi that exits would leave a dialog's claim
 *  behind. A session that ends closes its dialog. A write is bounded by its timeout,
 *  and a failed one is dropped: reporting must never break a session. */
export function waitingClaim(pi, home) {
  let question;
  let failure;
  let shown;
  let writes = Promise.resolve();
  const waiting = (...args) => {
    const argv = ["instance", "waiting", ...args, "--producer", "oats.pi", "--home", home, "--json"];
    writes = writes.then(() => new Promise((done) => {
      execFile(join(home, ".oats", "bin", "oats"), argv, { cwd: home, timeout: 5000 }, () => done());
    }));
  };
  const show = () => {
    const [reason, message] = question !== undefined ? ["question", question] : failure !== undefined ? ["attention", failure] : [];
    const next = reason === undefined ? "" : `${reason} ${message}`;
    if (next === shown) return;
    shown = next;
    if (reason === undefined) waiting("clear");
    else waiting("set", "--reason", reason, ...(message ? [`--message=${message}`] : []));
  };
  pi.on("session_shutdown", () => {
    question = undefined;
    show();
    return writes;
  });
  return {
    asked(message) { question = message; show(); },
    turnFailed(message) { failure = message; show(); },
  };
}
