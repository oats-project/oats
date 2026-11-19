/** The word `oats status`, `oats status --server <id>` and `oats server roster` print for an instance
 *  row in text, and the way back they print under a row whose session was lost (#1617, #1628). Rows
 *  in, strings out: the row is a `status --json` instance row, this kernel's or a host's (the roster
 *  relays its `sessionEnd`), read as it is. A host on a kernel before `sessionEnd` (feature
 *  session-resume) sends none, and its rows read `idle` as before. The JSON is never changed here.
 *  Rows in, strings out, but for one read: a local lost row's reason (lostLine). Dependency-free. */
import { terminalText } from "./refused-text.mjs";
import { shellWord } from "./shell-word.mjs";
import { HOST_STOP_REASON, lostReasonOf } from "./session-end.mjs";
import { SESSION_END } from "./session-resume-contract.mjs";

const isLost = (i) => i.running === false && i.sessionEnd === SESSION_END.LOST;

/** `running` true is RUNNING; false is LOST when the session was lost (`sessionEnd: "lost"`, the
 *  judgement the resume sweep acts on), else idle (stopped, exited, never launched, or not said);
 *  null (a server that cannot be read, a Herdr home) is unknown, never idle. */
export const livenessWord = (i) => i.running === true ? "RUNNING" : i.running === false ? (isLost(i) ? "LOST" : "idle") : "unknown";

/** A row's word: a retire under way wins over its liveness. */
export const statusWord = (i) => i.retirePending ? "RETIRING" : livenessWord(i);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Plain status's claim line, or null unless running. The clock defaults to the CLI machine's
 *  timezone; explicit `now` and `timeZone` keep calendar-boundary tests independent of the host.
 *  Elapsed words match the client's waitedText without a dependency on packages/client. */
export function waitingLine(i, { now = Date.now(), timeZone } = {}) {
  if (i.running !== true || !i.waitingOnYou) return null;
  const claim = i.waitingOnYou, since = Date.parse(claim.since);
  let timing = "";
  if (Number.isFinite(since)) {
    const clock = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    const parts = (at) => Object.fromEntries(clock.formatToParts(at).map(p => [p.type, p.value]));
    const at = parts(since), today = parts(now);
    const time = `${at.hour}:${at.minute}`;
    let start = time;
    if (at.year !== today.year) {
      start = `${at.year.padStart(4, "0")}-${at.month}-${at.day.padStart(2, "0")} ${time}`;
    } else if (at.month !== today.month || at.day !== today.day) start = `${MONTHS[Number(at.month) - 1]} ${at.day} ${time}`;
    timing = ` since ${start}`;
    const ms = now - since;
    if (ms >= 0) {
      const min = Math.floor(ms / 60000), h = Math.floor(min / 60);
      const elapsed = min < 1 ? "under a minute" : min < 60 ? `${min} min` : h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`;
      timing += `, ${elapsed}`;
    }
  }
  return `! needs input (${claim.reason ?? "unknown"})${timing}${claim.message ? `: ${claim.message}` : ""}`;
}

/** What a lost row says of why it was lost, by the reason its home records (lib/session-end.mjs). */
const LOST_REASON_SAID = Object.freeze({ [HOST_STOP_REASON]: "stopped with the host" });

/** The one line under a LOST row that says how to bring it back, or null for any other row. Local:
 *  the resume by hand, or the next sweep, after why it was lost when its home records that (read
 *  here from the home: the row carries no reason). `host` (a `--server` or roster row): both refuse
 *  `--server` (E_BAD_ARGS), so the line says to run them on that host; its home is not read. */
export function lostLine(i, { host } = {}) {
  if (i.retirePending || !isLost(i)) return null;
  const start = typeof i.home === "string" && i.home ? `oats session start --resume --home ${shellWord(i.home)}` : null;
  if (host !== undefined) return terminalText(`lost: on ${host}, run ${start ? `${start} there, or its next oats session resume` : "oats session resume there"}`);
  const why = start ? LOST_REASON_SAID[lostReasonOf(i.home, i)] : undefined;
  const lost = why ? `lost (${why})` : "lost";
  const sweep = "the next oats session resume (run when OATS Desktop or oats tui opens)";
  return terminalText(start ? `${lost}: ${start} brings it back; so does ${sweep} if it can vouch for the loss` : `${lost}: ${sweep} brings it back if it can vouch for the loss`);
}
