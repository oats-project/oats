/** Host-local terminal transport. Delivery policy belongs to the caller. */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const shells = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "login"]);
const isShellProcess = (name) => shells.has(basename(name).replace(/^-/, ""));
function tmux(target, args, { exec = execFileSync, input, timeout = 10000, killSignal } = {}) {
  // launchd does not supply a UTF-8 locale. In that environment tmux replaces
  // the tab delimiters in list-panes output with underscores unless forced.
  return exec("tmux", ["-u", "-S", target.socket, ...args], {
    encoding: "utf8", input, timeout, ...(killSignal ? { killSignal } : {}), maxBuffer: 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
/** The tmux pane option OATS sets on the agent's pane whenever it creates or respawns it, its value
 *  the instance's window name (the instance name). Internal: what OATS sets, not an API (#1569). */
export const AGENT_PANE_OPTION = "@oats-agent";
const paneNumber = (paneId) => Number(paneId.slice(1));
/** Which of a window's panes is the agent's (#1569), the one rule every reader applies (the client's
 *  tmux-status keeps a copy, held to this one by a parity test). `panes`: the window's panes, each
 *  `{ paneId: "%N", mark }` (`mark`: the pane's AGENT_PANE_OPTION, "" when unset; any other field is
 *  carried along); `name`: the instance's window name. One pane is the agent's, mark or not. Of
 *  several: the one marked with `name`; else, when none is, the unmarked pane with the lowest id
 *  (tmux's creation order: the window's own pane, before any split of it). A pane marked with another
 *  name is never the agent's. → `{ pane }` (the element itself, null for no panes), or `{ error }`
 *  when it cannot tell: the sentence every refusal and status's `runtimeError` carry. */
export function resolveAgentPane(panes, name) {
  if (panes.length <= 1) return { pane: panes[0] ?? null };
  const byId = [...panes].sort((a, b) => paneNumber(a.paneId) - paneNumber(b.paneId));
  const ids = (list) => list.map((p) => p.paneId).join(", ");
  const ours = byId.filter((p) => p.mark === name);
  if (ours.length === 1) return { pane: ours[0] };
  if (ours.length > 1) return { error: `the window has ${ours.length} panes marked as ${name}'s agent pane (${ids(ours)}); close all but the agent's with tmux kill-pane -t <id>, or close the window and start the instance` };
  const unmarked = byId.find((p) => !p.mark);
  if (unmarked) return { pane: unmarked };
  return { error: `the window has ${byId.length} panes and none is ${name}'s agent pane (${ids(byId)}); close the panes that aren't, or close the window and start the instance` };
}
// Public inspection opts into window geometry; input and other session operations
// retain their existing transport result and do not depend on size parsing.
// `includePanes` adds `panes`, the window's pane count (the viewer selects the agent's pane in a split window).
// `includePid` adds `panePid`, the agent's pane's own process id as tmux names it ("" when it names
// none): for the kernel's own use (inputSessionTarget), never part of an answer.
export function inspectSessionTarget(target, io, { includeSize = false, includePanes = false, includePid = false } = {}) {
  const format = "#{pane_id}\t#{pane_dead}\t#{pane_current_command}\t#{pane_pid}"
    + (includeSize ? "\t#{window_width}\t#{window_height}" : "") + `\t#{${AGENT_PANE_OPTION}}`;
  let rows;
  try {
    const output = tmux(target, ["list-panes", "-t", `=${target.session}:=${target.window}`, "-F", format], io);
    // Preserve dimension whitespace for validation, and the original parsing for other callers.
    rows = (includeSize ? output : output.trim()).split("\n").filter(Boolean);
  } catch (e) {
    // A missing window on a reachable server is absence. A lost socket is not.
    if (/can't find (window|session)/i.test(String(e.stderr || ""))) return { backend: "tmux", present: false, state: "stopped" };
    throw e;
  }
  const state = createSessionPaneInspector(io)(rows, { includeSize, includePid, name: target.window });
  return includePanes ? { ...state, panes: rows.length } : state;
}
/** The shell/descendant rule's answer when the process table cannot establish it (#1641): unknown,
 *  never a fallback shell, with the reason status carries as `runtimeError`. */
const unestablished = (why) => new Error(`${why}, so whether the harness runs cannot be told`);
/** Interpret one window's panes: resolve the agent's pane (resolveAgentPane, `name` the window's
 *  instance name), then judge that pane alone with the lifecycle's shell/descendant rule; the other
 *  panes never make it unknown. Each row is `id, dead, command, pid[, cols, rows], mark` (the mark may
 *  be missing). A status read shares one inspector across windows so both successful and failed
 *  process scans cost one child. */
export function createSessionPaneInspector(io) {
  let processRead;
  // Rows are `{ pid, ppid, name }`, `name` "" when ps printed none. A line that is not a process row
  // is never dropped silently: `malformed` keeps the snapshot from proving a fallback shell.
  const readProcesses = () => {
    if (!processRead) {
      try {
        const output = (io?.exec || execFileSync)("ps", ["-axo", "pid=,ppid=,comm="], {
          encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
        });
        const rows = [];
        let malformed = false;
        for (const line of output.split("\n")) {
          if (!line.trim()) continue;
          const row = line.trim().match(/^(\d+)\s+(\d+)(?:\s+(.*))?$/);
          if (row) rows.push({ pid: row[1], ppid: row[2], name: row[3] ?? "" });
          else malformed = true;
        }
        processRead = { rows, malformed };
      } catch (error) { processRead = { error }; }
    }
    if (processRead.error) throw processRead.error;
    return processRead;
  };
  return (rows, { includeSize = false, includePid = false, name } = {}) => {
    if (!rows.length) return { backend: "tmux", present: false, state: "stopped" };
    const panes = rows.map((row) => {
      const fields = row.split("\t");
      if (!/^%\d+$/.test(fields[0])) throw new Error("invalid tmux pane response");
      return { paneId: fields[0], mark: fields[includeSize ? 6 : 4] ?? "", fields };
    });
    const { pane, error } = resolveAgentPane(panes, name);
    if (error) throw new Error(error);
    const [paneId, dead, command, panePid, cols, rowsCount] = pane.fields;
    if (!["0", "1"].includes(dead)) throw new Error("invalid tmux pane response");
    if (includeSize && ![cols, rowsCount].every(value => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)))) {
      throw new Error("invalid tmux pane response");
    }
    let state = dead === "1" ? "stopped" : "unknown";
    let shell = shells.has(command);
    if (dead === "0" && (command === "" || command === "unset") && /^\d+$/.test(panePid)) {
      // A missing tmux label can still be a fallback shell. Only the pane's
      // own comm can establish that; an optional failed read stays unknown.
      try {
        const own = readProcesses().rows.find((p) => p.pid === panePid);
        shell = own ? isShellProcess(own.name) : false;
      } catch { /* missing process information is not proof of a fallback shell */ }
    }
    if (dead === "0" && shell) {
      // tmux names the pane's foreground process group's leader: the launch's own shell
      // (default-shell -c) while the harness runs as its child, on macOS and Linux alike.
      // Only the pane's own process, in the snapshot as a shell, with no non-shell
      // descendant, is a fallback prompt. A live non-shell process is the harness running;
      // anything else is unknown, never the prompt (#1641).
      if (!/^\d+$/.test(panePid)) throw new Error("tmux returned no pane process id");
      const { rows: processes, malformed } = readProcesses();
      const own = processes.find((p) => p.pid === panePid);
      // A ps that cannot see the pane (another PID namespace, a sandbox) or a pane respawned since
      // tmux answered.
      if (!own) throw unestablished(`the process table has no process ${panePid}, the agent's pane's own`);
      const descendants = new Set([panePid]);
      let active = !isShellProcess(own.name) && own.name !== "", unnamed = own.name === "" ? own.pid : null;
      for (let changed = true; changed;) {
        changed = false;
        for (const { pid, ppid, name } of processes) {
          if (descendants.has(ppid) && !descendants.has(pid)) {
            descendants.add(pid); changed = true;
            if (name === "") unnamed ??= pid;
            else if (!isShellProcess(name)) active = true;
          }
        }
      }
      if (!active && unnamed !== null) throw unestablished(`process ${unnamed} in the agent's pane has no command name in the process table`);
      // A line that is not a process row may be one of the pane's processes.
      if (!active && malformed) throw unestablished("the process table has a line that is not a process");
      state = active ? "unknown" : "shell";
    }
    return { backend: "tmux", present: dead === "0", state, paneId,
      ...(includeSize && dead === "0" ? { size: { cols: Number(cols), rows: Number(rowsCount) } } : {}),
      ...(includePid ? { panePid: /^\d+$/.test(panePid) ? panePid : "" } : {}) };
  };
}
// Settling gives a large bracketed paste time before the single Enter. Screen
// bytes are observations only: neither change nor silence proves acceptance
// or authorizes another key. Each phase has one monotonic observation budget.
const SETTLE_FLOOR_MS = 200, SETTLE_MS_PER_KIB = 3, SETTLE_CAP_MS = 2000, SETTLE_POLL_MS = 100;
const OBSERVE_CAP_MS = 1000, OBSERVE_WAITS_MS = [300, 600];
const REGION_LINES = 15, HISTORY_LINES = 200;
const GEOMETRY = "#{pane_width}x#{pane_height}";
const realSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** One look at the pane, or null when it cannot be read: `region`, the bottom
 *  15 lines of the visible pane (trailing blank rows dropped, and each line's
 *  trailing spaces, which a redraw pads differently); `all`, the
 *  visible pane with up to 200 lines of history above it; and `size`, the
 *  pane's geometry, read before and after the capture in the same tmux call
 *  (null when it moved in between). */
function capturePane(target, paneId, io, deadline, now) {
  const timeout = Math.floor(deadline - now());
  if (timeout <= 0) return null;
  try {
    const lines = tmux(target, ["display-message", "-p", "-t", paneId, GEOMETRY, ";",
      "capture-pane", "-p", "-J", "-t", paneId, "-S", `-${HISTORY_LINES}`, ";",
      // A read-only probe must not outlive its timeout by ignoring TERM.
      "display-message", "-p", "-t", paneId, GEOMETRY], { ...io, timeout, killSignal: "SIGKILL" }).split("\n");
    if (now() >= deadline) return null;
    if (lines.at(-1) === "") lines.pop();
    const first = lines.shift(), last = lines.pop();
    if (!/^\d+x\d+$/.test(first) || !/^\d+x\d+$/.test(last)) return null;
    for (let i = 0; i < lines.length; i++) lines[i] = lines[i].trimEnd();
    while (lines.length && !lines.at(-1)) lines.pop();
    const look = { size: first === last ? first : null, region: lines.slice(-REGION_LINES).join("\n"), all: lines.join("\n") };
    return now() < deadline ? look : null;
  } catch { return null; }
}
const sameLook = (a, b) => a.size === b.size && a.region === b.region;
/** Width-independent text: each run of one box-drawing character kept as one,
 *  so a rule of any length reads the same, then whitespace dropped. Runs are
 *  collapsed first, so a glyph is never merged with a rule on the next line. */
const flat = (text) => text.replace(/([\u2500-\u257f])\1+/g, "$1").replace(/\s+/g, "");
/** Whether the pane after Enter shows what it showed before. On a pane of the
 *  same size this is exact bytes. Only when its size was seen to change (a
 *  resize, a second client attaching) is a reflow allowed for: then the two
 *  bottom regions must agree at the bottom, and each must already be present,
 *  width aside, in the other's capture with history, so content that appeared
 *  or disappeared still reads as a change. */
function unchanged(a, b) {
  if (a.size !== null && a.size === b.size) return a.region === b.region;
  const x = flat(a.region), y = flat(b.region);
  if (!x || !y) return x === y;
  return (x.endsWith(y) || y.endsWith(x)) && flat(b.all).includes(x) && flat(a.all).includes(y);
}
/** One literal paste and one Enter. `submitted` means terminal commands
 * succeeded; `verified` means only that a bounded look changed afterward.
 * Neither is model acceptance. Terminal failures throw; observation failures
 * yield unverified, never a refusal or permission to retransmit.
 *
 * `unsubmitted` (lib/session-input-lock.mjs unsubmittedPaste; the caller holds the home's input
 * lock, and has checked what refuses an input: this function's Enter for a note is an input's Enter
 * like any other). The note of a paste with no Enter yet: written once this paste is in the pane,
 * cleared once this Enter is sent. One found at the start is an earlier input's text, pasted and
 * never submitted (its process was killed between its paste and its Enter, or its Enter failed).
 * - Still in the input line, as far as can be told (the pane runs the process the note names, and
 *   the note is recent: `stale` false): it is submitted FIRST, with an Enter of its own, as the
 *   message it was, so this text is never run into it.
 * - Anything else gets no key, and the note is cleared: another pane process (the session was
 *   restarted: the line is gone), a pane whose process tmux does not name (nothing proves it is
 *   the same one), or a note past its age (a person may have sent or deleted the text since, and
 *   an Enter would answer whatever the pane shows now).
 * The note is kept on a best effort: a write or a removal the system refuses never stops the
 * input (its text is in the pane by then, or already submitted). */
export function inputSessionTarget(target, text, io, { unsubmitted } = {}) {
  const { panePid, ...state } = inspectSessionTarget(target, io, { includePid: !!unsubmitted });
  if (!state.present || state.state === "shell") throw new Error(`cannot submit input: session is ${state.state}`);
  const sleep = io?.sleep || realSleep, now = io?.now || (() => performance.now());
  const wait = (ms, deadline) => { const remaining = deadline - now(); if (remaining > 0) sleep(Math.min(ms, remaining)); };
  // The note's own file: kept when the system lets it be. What a lost note costs is said where it is used.
  const note = (act) => { try { act(); } catch { /* the input goes on without the note */ } };
  const left = unsubmitted?.read();
  if (left) {
    if (!left.stale && panePid !== "" && left.paneId === state.paneId && left.panePid === panePid) {
      tmux(target, ["send-keys", "-t", state.paneId, "Enter"], io);
      // The terminal keeps the order of that Enter and the paste below; the pause lets the
      // harness take the line before more text arrives.
      wait(SETTLE_FLOOR_MS, now() + SETTLE_FLOOR_MS);
    }
    // (A note that cannot be removed is written over by this input's own, below, or outlives its age.)
    note(() => unsubmitted.clear());
  }
  // Bracketed paste preserves multiline input as one user message. No text
  // is evaluated by a shell or interpreted as tmux key names.
  const buffer = `oats-${randomUUID()}`;
  let settleDeadline;
  try {
    tmux(target, ["load-buffer", "-b", buffer, "-"], { ...io, input: text });
    tmux(target, ["paste-buffer", "-p", "-b", buffer, "-t", state.paneId], io);
    settleDeadline = now() + SETTLE_CAP_MS;
    // From here the text is in the pane with no Enter: noted until the Enter below is sent. A note
    // that cannot be written does not stop the Enter: the text would stay unsubmitted, un-noted.
    if (unsubmitted) note(() => unsubmitted.write({ paneId: state.paneId, panePid }));
  } finally {
    try { tmux(target, ["delete-buffer", "-b", buffer], io); } catch { /* already consumed or disconnected */ }
  }
  // The budget starts at paste completion, before cleanup. Cleanup/Enter keep
  // their original command timeouts; only observation probes/sleeps are clipped.
  wait(SETTLE_FLOOR_MS + Math.ceil(Buffer.byteLength(text) / 1024) * SETTLE_MS_PER_KIB, settleDeadline);
  let before = capturePane(target, state.paneId, io, settleDeadline, now);
  while (before !== null && now() < settleDeadline) {
    wait(SETTLE_POLL_MS, settleDeadline);
    const next = capturePane(target, state.paneId, io, settleDeadline, now);
    const settled = next !== null && sameLook(next, before);
    before = next;
    if (settled) break;
  }
  if (now() >= settleDeadline) before = null;
  tmux(target, ["send-keys", "-t", state.paneId, "Enter"], io);
  // Submitted: a note that cannot be removed now is a stale one later, never a failed input.
  if (unsubmitted) note(() => unsubmitted.clear());
  const observeDeadline = now() + OBSERVE_CAP_MS;
  if (before !== null) {
    for (const delay of OBSERVE_WAITS_MS) {
      wait(delay, observeDeadline);
      const after = capturePane(target, state.paneId, io, observeDeadline, now);
      if (after === null) break;
      const changed = !unchanged(before, after);
      if (now() >= observeDeadline) break;
      if (changed) return { ...state, submitted: true, verified: true };
    }
  }
  return { ...state, submitted: true, verified: false };
}
