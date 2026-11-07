import { withoutControlToken } from "./control-environment.mjs";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

/** The session a home without a recorded tmux session is looked for in: the kernel's default (0.31),
 * mirrored from the kernel's DEFAULT_TMUX_SESSION (its core module; the Desktop never imports it) — change both. */
export const DEFAULT_TMUX_SESSION = process.env.OATS_TMUX_SESSION || process.env.PI_AGENTS_TMUX_SESSION || "oats-agents";

const shells = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "login"]);

const paneNumber = (paneId) => Number(paneId.slice(1));

/** The agent's pane of one window's panes, [{ paneId: "%N", mark, ...rest }] (`mark`: the pane's
 * `@oats-agent`, "" when unset): the kernel's rule, lib/session-input.mjs `resolveAgentPane`, which
 * a client cannot import. This copy is for this computer's tmux only (the status reader below and
 * the Desktop's terminal open, packages/desktop/tmux-target.mjs), and test/desktop-tmux-status.test.mjs
 * pins it to the kernel's, sentences included. `name` is the window's recorded name, which is what
 * OATS marks the agent's pane with. One pane is the agent's, mark or not. Of several: the one marked
 * `name`; else the lowest pane id of those with no mark (the window's own: an OATS split comes
 * later), as another instance's mark is never this one's; two or more marked `name`, or no
 * candidate, it can't tell. { pane } (the element, null for no pane) or { error }. */
export function agentPane(panes, name) {
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

/** One read per socket, and at most one process snapshot per roster collection. */
export function createTmuxStatusReader({ exec = execFileSync } = {}) {
  const sockets = new Map();
  let processes;
  const run = (bin, args) => exec(bin, args, {
    env: withoutControlToken(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 4000, maxBuffer: 4 * 1024 * 1024,
  });
  function readSocket(socket) {
    if (!sockets.has(socket)) {
      try {
        const text = run("tmux", ["-u", ...(socket ? ["-S", socket] : []), "list-panes", "-a", "-F",
          "#{session_name}\t#{window_name}\t#{window_id}\t#{pane_id}\t#{pane_dead}\t#{pane_current_command}\t#{pane_pid}\t#{@oats-agent}"]);
        const panes = text.trim().split("\n").filter(Boolean).map((line) => {
          // The mark is last: whatever it holds, the fields before it are where they should be.
          const [session, window, id, paneId, dead, command, pid, ...mark] = line.split("\t");
          if (!session || !window || !/^@\d+$/.test(id) || !/^%\d+$/.test(paneId) || !/^[01]$/.test(dead) || !/^\d+$/.test(pid)) throw new Error("Invalid tmux status response");
          return { session, window, id, paneId, dead: dead === "1", command, pid, mark: mark.join("\t") };
        });
        sockets.set(socket, { panes });
      } catch (e) {
        const absent = /no server running|error connecting.*No such file or directory/i.test(String(e.stderr || ""));
        sockets.set(socket, absent ? { panes: [] } : { error: e.message || "Cannot reach terminal server" });
      }
    }
    return sockets.get(socket);
  }
  function hasHarness(pid) {
    if (!processes) {
      processes = run("ps", ["-axo", "pid=,ppid=,comm="]).split("\n")
        .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean);
    }
    const descendants = new Set([pid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [, child, parent, name] of processes) {
        if (!descendants.has(parent) || descendants.has(child)) continue;
        descendants.add(child); changed = true;
        if (!shells.has(basename(name).replace(/^-/, ""))) return true;
      }
    }
    return false;
  }
  return (meta, defaultSession = DEFAULT_TMUX_SESSION) => {
    const tmux = { ...meta.tmux, session: meta.tmux?.session || defaultSession, window: meta.tmux?.window || meta.instance };
    const status = readSocket(tmux.socket || "");
    const unknown = (error) => ({ tmux, running: null, runtimeState: "unreachable", runtimeError: error });
    if (status.error) return unknown(status.error);
    const { pane, error } = agentPane(status.panes.filter((p) => p.session === tmux.session && p.window === tmux.window), tmux.window);
    if (error) return unknown(error);
    if (!pane || pane.dead) return { tmux, running: false, runtimeState: "stopped" };
    tmux.id = pane.id;
    try {
      const running = !shells.has(pane.command.replace(/^-/, "")) || hasHarness(pane.pid);
      return { tmux, running, runtimeState: running ? "running" : "shell", paneCommand: pane.command };
    } catch (e) { return unknown(e.message); }
  };
}
