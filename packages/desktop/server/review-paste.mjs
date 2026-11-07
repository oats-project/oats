/** Deliver a composed review-threads block into an instance's agent pane: ONE bracketed paste
 * (`paste-buffer -p`, `-r` so tmux adds no CR), never send-keys, never Enter.
 * The pane is the kernel's answer (`inspect`, `oats session inspect --json` `paneId`, #1569), never the
 * window's active pane: in a window with more than one pane the active one may be another program's,
 * a no-echo prompt among them. A refused or unreadable inspect refuses the paste, so a kernel that
 * cannot tell, or one older than #1569 on a split window, pastes nothing. A pane id names a pane of one
 * tmux server only, so the row read again after the inspect must record the same server, session and
 * window as the row the kernel was asked for, and the pane must be one of that anchored window's, or
 * nothing is pasted.
 * The per-request buffer is deleted on every path: `-d` on success, an explicit delete-buffer on
 * any failure after load-buffer. The block itself carries no CR/LF (review-threads.mjs).
 * Every tmux call goes to the tmux server the instance's row records (`tmux.socket`), through the
 * helper the terminals use; the socket is read from the row only. A recorded socket that fails
 * validation is refused before any tmux call: the paste never tries the default server instead. */
import { withoutControlToken } from "../../client/control-environment.mjs";
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmuxSocketArgs } from '../local-tmux-io.mjs';

/** `inspect(inst)`: a promise of the kernel's envelope for the row's home (cli-adapter.mjs `cliSessionInspect`). */
export function createReviewPaste({ exec = execFileSync, find, tmuxTarget, inspect, random = () => randomBytes(8).toString('hex') }) {
  /** null when the target can take a paste, else a stable code. */
  function check(target) {
    const inst = find(target);
    if (!inst) return 'E_NOT_RUNNING';
    if (inst.server || inst.remote) return 'E_REMOTE_TERMINAL';
    if (inst.running !== true) return 'E_NOT_RUNNING';
    try { tmuxTarget(inst); tmuxSocketArgs(inst.tmux?.socket); } catch { return 'E_TERMINAL_UNSUPPORTED'; }
    return null;
  }
  /** Where a row's terminal is: its tmux server (no socket: the default one), session and window. */
  const endpoint = inst => JSON.stringify([inst?.tmux?.socket || null, inst?.tmux?.session ?? null, inst?.tmux?.window ?? null]);
  /** The agent's pane of `inst`, `%N`, or a stable code. */
  async function agentPane(inst) {
    let answer;
    try { answer = await inspect(inst); } catch { answer = null; }
    const seen = answer?.ok === true ? answer.result : null;
    if (!seen || typeof seen !== 'object') return { code: 'E_TERMINAL_UNSUPPORTED' };
    // A kernel without `running` (session-inspect-running) says a live harness as `state: unknown`.
    const running = seen.running === true || (seen.running === undefined && seen.state === 'unknown');
    if (seen.present !== true || !running) return { code: 'E_NOT_RUNNING' };
    if (typeof seen.paneId !== 'string' || !/^%\d+$/.test(seen.paneId)) return { code: 'E_TERMINAL_UNSUPPORTED' };
    return { pane: seen.paneId };
  }
  async function paste(target, text) {
    const early = check(target);
    if (early) return early;
    if (typeof text !== 'string' || !text || /[\r\n]/.test(text)) return 'E_BAD_ARGS';
    const asked = find(target);
    const { pane, code } = await agentPane(asked);
    if (code) return code;
    // The row is read again after the inspect: the roster may have moved on meanwhile, and a restart
    // onto another server can hand the same pane id to another program there.
    const refused = check(target);
    if (refused) return refused;
    const inst = find(target), name = `oatsrt-${random()}`;
    if (endpoint(inst) !== endpoint(asked)) return 'E_TERMINAL_UNSUPPORTED';
    let loaded = false, server;
    try {
      server = tmuxSocketArgs(inst.tmux?.socket);
      const panes = exec('tmux', [...server, 'list-panes', '-t', tmuxTarget(inst), '-F', '#{pane_id}'], { encoding: 'utf8', timeout: 4000, env: withoutControlToken() });
      if (!String(panes).split('\n').includes(pane)) return 'E_TERMINAL_UNSUPPORTED';
      exec('tmux', [...server, 'load-buffer', '-b', name, '-'], { input: text, timeout: 4000, env: withoutControlToken() });
      loaded = true;
      exec('tmux', [...server, 'paste-buffer', '-p', '-r', '-d', '-b', name, '-t', pane], { timeout: 4000, env: withoutControlToken() });
      return null;
    } catch {
      if (loaded) { try { exec('tmux', [...server, 'delete-buffer', '-b', name], { timeout: 4000, env: withoutControlToken() }); } catch { /* gone already */ } }
      return 'E_PASTE_FAILED';
    }
  }
  return { check, paste };
}
