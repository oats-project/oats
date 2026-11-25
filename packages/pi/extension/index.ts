/**
 * OATS pi runtime bridge — minimal glue.
 *
 * The kernel materializes every spawned instance's exact set in
 * .agents/skills; this bridge contributes it inside an instance, plus the
 * pre-workspace oats-getting-started bootstrap outside one, and drives the
 * memory session events. Inside an instance it also reports what the session
 * waits on a person for (an open dialog, a turn that failed) as the home's
 * waiting claim. Ambient skills coexist with the OATS-composed set.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendLogEntry, PACKAGED_SKILLS_DIR } from "./core-loader.mjs";
import { reportFailedTurn } from "./failed-turn.mjs";
import { reportUiPrompt } from "./ui-prompt.mjs";
import { waitingClaim } from "./waiting-claim.mjs";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  const agentHome = process.env.OATS_INSTANCE_HOME;
  const isInstance = !!agentHome && existsSync(join(agentHome, "instance.json"));

  pi.on("resources_discover", async () => {
    if (isInstance) {
      const local = join(agentHome!, ".agents", "skills");
      return existsSync(local) ? { skillPaths: [local] } : undefined;
    }
    const gettingStarted = join(PACKAGED_SKILLS_DIR, "oats-getting-started");
    return existsSync(gettingStarted) ? { skillPaths: [gettingStarted] } : undefined;
  });

  if (isInstance) {
    holdOpeningTask(pi);
    const claim = waitingClaim(pi, agentHome!);
    reportFailedTurn(pi, claim);
    reportUiPrompt(pi, claim);

    pi.on("session_compact", async (event) => {
      if (!existsSync(join(agentHome!, "STATE.md"))) return;
      try {
        const summary = (event.compactionEntry?.summary ?? "").replace(/\s+/g, " ").trim();
        appendLogEntry(
          join(agentHome!, "log.md"),
          `**Compaction** (${event.reason}): ${summary.slice(0, 400)}${summary.length > 400 ? "…" : ""}`,
          "Instance Log",
        );
      } catch { /* memory automation must never break a session */ }
      pi.sendMessage({
        customType: "oats-memory",
        content: "Context was just compacted. Before continuing, update ./STATE.md (Plan/Progress/Next) so a fresh session could resume from files alone.",
        display: false,
      }, { deliverAs: "steer" });
    });

    pi.on("session_start", async (event, ctx) => {
      if (event.reason !== "startup" && event.reason !== "resume" && event.reason !== "new") return;
      if (!existsSync(join(agentHome!, "STATE.md"))) return;
      // A home's first startup gets no resume nudge, whatever a capability
      // seeded into its STATE.md.
      if (event.reason === "startup" && !hasWorkedBefore(agentHome!, ctx)) return;
      pi.sendMessage({
        customType: "oats-memory",
        content: `You are agent instance home ${agentHome}. Read ./STATE.md and the recent entries of ./log.md now, then continue from STATE.md's "Next" section. Keep STATE.md current as you work.`,
        display: false,
      }, { deliverAs: "steer", triggerTurn: false });
    });
  }
}

/**
 * Whether pi kept an earlier session of this home. pi files a session only
 * once it holds a message (an assistant one in pi 0.80.3,
 * core/session-manager.js:641-665; any in pi 1.x), groups sessions by working
 * directory, and starts each file with a header naming its cwd and start time
 * (docs/session-format.md). A session that started before the home was
 * created belongs to an earlier instance of the same name. Where the birth
 * time is unknown (0, or ctime, which libuv reports without statx) none is
 * told apart. A file last written before the home was created is skipped
 * unread. Unreadable history reads as none: memory automation must never
 * break a session.
 */
function hasWorkedBefore(home: string, ctx: ExtensionContext): boolean {
  try {
    const sessions = ctx.sessionManager;
    const dir = sessions.getSessionDir();
    const current = sessions.getSessionFile();
    const cwd = sessions.getCwd();
    const { birthtimeMs, ctimeMs } = statSync(home);
    const born = birthtimeMs !== ctimeMs ? birthtimeMs : 0;
    const head = Buffer.alloc(16 * 1024);
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (!name.endsWith(".jsonl") || file === current) continue;
      if (statSync(file).mtimeMs < born) continue;
      const header = sessionHeader(file, head);
      if (header?.type === "session" && header.cwd === cwd && typeof header.timestamp === "string" && Date.parse(header.timestamp) >= born) return true;
    }
  } catch { /* no history read */ }
  return false;
}

/** A session file's first line, parsed, or undefined. Only its head is read. */
function sessionHeader(file: string, head: Buffer): { type?: unknown; cwd?: unknown; timestamp?: unknown } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const text = head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString("utf8");
    const end = text.indexOf("\n");
    return end < 0 ? undefined : JSON.parse(text.slice(0, end));
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * The opening task runs once, after any turn another extension starts, as
 * pi's input processing made it. pi sends the launch's `@TASK.md` as the
 * session's first prompt with no streamingBehavior (pi 1.3.0
 * modes/interactive/interactive-mode.js:894-897, as an SDK session.prompt()
 * does) and refuses it while another extension's run (the @awebai/pi welcome)
 * is active. The bridge never sends or alters a message: it holds that prompt
 * on pi's own path, in its input handler and again in before_agent_start (a
 * run can start during the prompt's preflight), until no run is active.
 * pi 1.2 and later count the prompt's own run as active from before its
 * before_agent_start (core/agent-session.js:1392-1397) and queue a message
 * sent meanwhile into that run; their event carries messageType, and there
 * only the input handler holds. A run that an extension behind the bridge starts (or that starts
 * while one awaits) in its own input handling of the prompt, or on a pi
 * before 1.2 in its before_agent_start, can still make pi refuse it, and pi
 * says nothing an extension could act on. Every later prompt is left to pi.
 * A session that shuts down releases the hold.
 */
function holdOpeningTask(pi: ExtensionAPI) {
  let taken = false;
  // The opening prompt has yet to reach before_agent_start.
  let awaitingStart = false;
  const waiters: (() => void)[] = [];
  let shutDown = false;
  // pi refuses a prompt while pi-agent-core holds a run (ctx.signal is that
  // run's), and one with no streamingBehavior while the session is not idle.
  const busy = (ctx: ExtensionContext) => ctx.signal !== undefined || !ctx.isIdle();
  const untilFree = async (ctx: ExtensionContext) => {
    while (!shutDown && busy(ctx)) await new Promise<void>((resolve) => waiters.push(resolve));
  };
  const wake = () => { for (const resume of waiters.splice(0)) resume(); };
  // Waiters re-check on agent_settled (pi 0.80.4 and later). A pi without it
  // releases a run only once every agent_end listener has finished, which no
  // event marks: from agent_end, waiters re-check every 25 ms until none is
  // left waiting or another run starts.
  let recheck: ReturnType<typeof setTimeout> | undefined;
  const stopRechecking = () => { clearTimeout(recheck); recheck = undefined; };
  const recheckWaiters = () => {
    recheck = undefined;
    if (!waiters.length) return;
    wake();
    recheck = setTimeout(recheckWaiters, 25);
  };

  pi.on("input", async (event, ctx) => {
    if (taken || event.source !== "interactive" || event.streamingBehavior !== undefined) return { action: "continue" };
    taken = true;
    awaitingStart = true;
    await untilFree(ctx);
    return { action: "continue" };
  });
  pi.on("before_agent_start", async (event, ctx) => {
    // On pi 1.2 and later (messageType) the session's run is the prompt's own.
    if (!awaitingStart || event.messageType !== undefined) return;
    awaitingStart = false;
    await untilFree(ctx);
  });
  pi.on("agent_start", stopRechecking);
  pi.on("agent_end", () => { stopRechecking(); recheck = setTimeout(recheckWaiters, 0); });
  pi.on("agent_settled", () => { stopRechecking(); wake(); });
  pi.on("session_shutdown", () => { shutDown = true; stopRechecking(); wake(); });
}
