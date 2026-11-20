// Remote terminal reconnect (spec 03): a remote tab whose ssh link dies (exit 255) keeps its
// view, goes inert and re-opens a lease for the same target with backoff. Driven through
// createTerminalTab, the exact code shell.mjs runs, with a fake desk and a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createTerminalTab } from "../renderer/terminal-tab.mjs";
import { handle, opened, ready, confirmed } from "./helpers/terminal-wire.mjs";
import { terminalFailure, terminalMessage } from "../../client/terminal-contract.mjs";

const flush = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

/** Timers fire only when advanced; jump() moves the wall clock without firing (a sleeping laptop). */
function fakeClock() {
  let now = 1_000_000, next = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { at: now + Math.max(0, ms), fn }); return id; },
    clearTimeout: id => { timers.delete(id); },
    pending: () => timers.size,
    jump(ms) { now += ms; for (const timer of timers.values()) timer.at = Math.max(timer.at, now); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = Math.max(now, due[1].at); timers.delete(due[0]); due[1].fn(); await flush();
      }
      now = end; await flush();
    },
  };
}

const remote = { serverId: "build", instance: "dev", home: "/srv/agents/dev" };

/** `opens` scripts each termOpen in turn: a numeric id opens that lease, a string is a failure
 * code, a promise is an open still in flight. */
function rig({ opens = [1], local = false, ownsFocus = () => true, termReady, onLink } = {}) {
  const dom = new JSDOM("<!doctype html><body><button id=elsewhere>elsewhere</button></body>");
  const doc = dom.window.document, wrap = doc.createElement("div");
  doc.body.append(wrap);
  doc.getElementById("elsewhere").focus();
  const clock = fakeClock(), log = [], openedAt = [], exits = new Map(), queue = [...opens];
  let input, keys;
  const desk = {
    termOpen: async spec => {
      log.push("open"); openedAt.push(clock.now());
      assert.deepEqual(spec.remote ?? null, local ? null : remote, "every open is for the same admitted target");
      const next = queue.length ? queue.shift() : "E_TERM_REMOTE_UNREACHABLE";
      const value = await next;
      return typeof value === "number" ? opened(value) : typeof value === "string" ? terminalFailure(value) : value;
    },
    termReady: termReady || (h => ready(h)),
    termClose: h => { log.push(`closePty:${h.id}`); return confirmed(h); },
    termWrite: (h, data) => { log.push(`write:${h.id}:${data}`); return { ok: true }; },
    termResize: (h, cols, rows) => log.push(`resize:${h.id}:${cols}x${rows}`),
    onTermData: () => () => {},
    onTermExit: (h, cb) => { exits.set(h.id, cb); return () => { if (exits.get(h.id) === cb) exits.delete(h.id); }; },
  };
  const term = {
    cols: 100, rows: 30, options: {},
    onData: cb => { input = cb; return { dispose() {} }; },
    onResize: () => ({ dispose() {} }),
    focus: () => log.push("focus"),
    dispose: () => log.push("term.dispose"),
    write: () => {},
    attachCustomKeyEventHandler: handler => { keys = handler; },
  };
  const tab = createTerminalTab({
    desk, term, wrap, clock, ownsFocus, isActive: () => true, fit: () => {}, observe: () => () => {}, ...(onLink ? { onLink } : {}),
    ...(local ? { tmux: { session: "s", window: 1 } } : { remote, serverLabel: "Build box" }),
  });
  const exit = (id, extra = {}) => exits.get(id)({ terminalApi: 2, status: "ended", handle: handle(id),
    cleanupPending: false, exitCode: 255, reason: null, ...extra });
  return {
    doc, wrap, clock, log, openedAt, tab, term, exit, type: data => input(data),
    key: event => keys({ type: "keydown", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...event }),
    opens: () => log.filter(v => v === "open").length,
    strip: () => wrap.querySelector(".term-reconnect"),
    stripText: () => wrap.querySelector(".term-reconnect-text")?.textContent,
    button: () => wrap.querySelector(".term-reconnect button"),
    live: () => wrap.querySelector(".term-live"),
    banner: () => wrap.querySelector(".term-banner")?.textContent,
  };
}

test("exit 255 keeps the remote tab, makes input inert and shows the disconnected strip with Reconnect now", async () => {
  const r = rig();
  await r.tab.start();
  assert.equal(r.term.options.disableStdin, false, "a connected terminal takes input");
  r.exit(1);
  assert.equal(r.term.options.disableStdin, true, "keystrokes go nowhere while disconnected");
  r.type("lost"); assert.ok(!r.log.some(v => v.startsWith("write")), "nothing was sent");
  assert.equal(r.stripText(), "Disconnected from Build box. Reconnecting in 1s…");
  assert.equal(r.button().textContent, "Reconnect now"); assert.equal(r.button().type, "button");
  assert.equal(r.banner(), undefined, "no full overlay: the scrollback stays visible");
  assert.ok(!r.log.includes("term.dispose"), "the xterm and its scrollback are kept");
  assert.equal(r.doc.activeElement.id, "elsewhere", "the strip does not steal focus");
  const live = r.live();
  assert.equal(live.getAttribute("role"), "status"); assert.equal(live.getAttribute("aria-live"), "polite");
  assert.equal(live.textContent, "Disconnected from Build box.");
  assert.equal(r.strip().getAttribute("role"), null, "the visible strip is not itself a live region");
  assert.equal(r.strip().getAttribute("aria-live"), null);
  assert.ok(!r.strip().contains(live), "the countdown sits outside the live region");
  await r.tab.close();
});

test("attempts wait 1, 2, 4, 8 and 15 s, then 30 s each; a prepare timeout retries like a transport failure", async () => {
  const r = rig({ opens: [1, "E_TERM_REMOTE_UNREACHABLE", "E_TERM_PREPARE_TIMEOUT", "E_TERM_REMOTE_UNREACHABLE",
    "E_TERM_REMOTE_UNREACHABLE", "E_TERM_REMOTE_UNREACHABLE", "E_TERM_REMOTE_UNREACHABLE", "E_TERM_REMOTE_UNREACHABLE"] });
  await r.tab.start();
  const lost = r.clock.now(); r.exit(1);
  await r.clock.advance(1000 + 2000 + 4000 + 8000 + 15000 + 30000 + 30000);
  const gaps = r.openedAt.slice(1).map((at, i) => at - (i ? r.openedAt[i] : lost));
  assert.deepEqual(gaps, [1000, 2000, 4000, 8000, 15000, 30000, 30000]);
  assert.equal(r.stripText(), "Disconnected from Build box. Reconnecting in 30s…");
  await r.tab.close();
});

test("the countdown updates each second without re-announcing; an attempt in flight says Reconnecting", async () => {
  const gate = deferred();
  const r = rig({ opens: [1, "E_TERM_REMOTE_UNREACHABLE", "E_TERM_REMOTE_UNREACHABLE", "E_TERM_REMOTE_UNREACHABLE", gate.promise] });
  await r.tab.start(); r.exit(1);
  await r.clock.advance(1000 + 2000 + 4000);
  assert.equal(r.stripText(), "Disconnected from Build box. Reconnecting in 8s…");
  const announced = r.live().textContent;
  await r.clock.advance(3000);
  assert.equal(r.stripText(), "Disconnected from Build box. Reconnecting in 5s…");
  assert.equal(r.live().textContent, announced, "the live region changes only with the state");
  await r.clock.advance(5000);
  assert.equal(r.stripText(), "Reconnecting to Build box…");
  assert.equal(r.live().textContent, "Reconnecting to Build box…");
  assert.equal(r.button().getAttribute("aria-disabled"), "true", "Reconnect now has nothing to do while an attempt runs");
  gate.resolve(2); await r.clock.advance(0);
  await r.tab.close();
});

test("a successful attach clears the strip, re-enables input, sends the size, focuses only an owning tab and resets the backoff", async () => {
  for (const owns of [true, false]) {
    const r = rig({ opens: [1, "E_TERM_REMOTE_UNREACHABLE", 2, 3], ownsFocus: () => owns });
    await r.tab.start(); r.log.length = 0;
    r.exit(1);
    await r.clock.advance(1000 + 2000);
    assert.equal(r.strip(), null, "the strip clears");
    assert.equal(r.term.options.disableStdin, false, "input is re-enabled");
    assert.ok(r.log.includes("resize:2:100x30"), "the current size is sent to the new lease");
    assert.equal(r.log.includes("focus"), owns, "focus returns only to a tab that owns it");
    assert.equal(r.live().textContent, "Reconnected to Build box.");
    r.type("again"); assert.ok(r.log.includes("write:2:again"), "input reaches the new lease");
    const lost = r.clock.now(); r.exit(2);
    await r.clock.advance(1000);
    assert.equal(r.openedAt.at(-1) - lost, 1000, "a success resets the backoff to 1 s");
    await r.tab.close();
  }
});

test("Reconnect now cancels the wait and tries at once", async () => {
  const r = rig({ opens: [1, "E_TERM_REMOTE_UNREACHABLE", "E_TERM_REMOTE_UNREACHABLE", "E_TERM_REMOTE_UNREACHABLE", 2] });
  await r.tab.start(); r.exit(1);
  await r.clock.advance(1000 + 2000 + 4000);
  assert.equal(r.opens(), 4);
  r.button().click(); await r.clock.advance(0);
  assert.equal(r.opens(), 5, "tried at once, not after 8 s");
  assert.equal(r.strip(), null, "and reconnected");
  await r.tab.close();
});

test("close during the wait: no attempt starts after it and no timer is left", async () => {
  const r = rig({ opens: [1, "E_TERM_REMOTE_UNREACHABLE"] });
  await r.tab.start(); r.exit(1);
  await r.clock.advance(1000);
  assert.equal(r.opens(), 2);
  assert.equal((await r.tab.close()).ok, true);
  await r.clock.advance(120000);
  assert.equal(r.opens(), 2, "no attempt after the close");
  assert.equal(r.clock.pending(), 0, "no timer survives the close");
  assert.equal(r.log.filter(v => v === "term.dispose").length, 1);
});

test("close during an in-flight open: that lease is closed as soon as it resolves and nothing further runs", async () => {
  const gate = deferred();
  const r = rig({ opens: [1, gate.promise] });
  await r.tab.start(); r.exit(1);
  await r.clock.advance(1000);
  assert.equal(r.opens(), 2);
  const closing = r.tab.close();
  gate.resolve(7); assert.equal((await closing).ok, true);
  assert.ok(r.log.includes("closePty:7"), "the late lease is closed");
  assert.ok(!r.log.some(v => v.startsWith("resize:7")), "and never set up");
  await r.clock.advance(120000);
  assert.equal(r.opens(), 2);
});

test("every refusal but a transport failure stops reconnecting with its message and Close this tab", async () => {
  for (const code of ["E_TERM_REMOTE_GONE", "E_TERM_REMOTE_NO_SSH", "E_TERM_OPEN_FAILED", "E_TERM_CONTEXT_CHANGED", "E_TERM_CAP", "E_TERM_BAD_ARGS"]) {
    const r = rig({ opens: [1, code] });
    await r.tab.start(); r.exit(1);
    await r.clock.advance(1000);
    const final = `${terminalMessage(code, "Build box")} Close this tab.`;
    assert.equal(r.banner(), final, code);
    assert.equal(r.strip(), null, `${code}: the strip gives way to the final banner`);
    assert.equal(r.live().textContent, final, `${code}: the stop is announced`);
    assert.equal(r.term.options.disableStdin, true, `${code}: input stays inert`);
    await r.clock.advance(120000);
    assert.equal(r.opens(), 2, `${code}: no further attempt`);
    assert.equal(r.clock.pending(), 0);
    await r.tab.close();
  }
});

test("a non-255 exit ends as today, also after a reconnect", async () => {
  for (const exitCode of [0, 1, null]) {
    const r = rig();
    await r.tab.start(); r.exit(1, { exitCode });
    assert.equal(r.banner(), "session ended — close this tab");
    assert.equal(r.strip(), null);
    await r.clock.advance(120000); assert.equal(r.opens(), 1, `exit ${exitCode} never reconnects`);
    await r.tab.close();
  }
  const r = rig({ opens: [1, 2] });
  await r.tab.start(); r.exit(1); await r.clock.advance(1000);
  r.exit(2, { exitCode: 1 });
  assert.equal(r.banner(), "session ended — close this tab");
  await r.clock.advance(120000); assert.equal(r.opens(), 2);
  await r.tab.close();
});

test("a local tab never reconnects, whatever its exit code", async () => {
  const r = rig({ local: true });
  await r.tab.start(); r.exit(1);
  assert.equal(r.banner(), "session ended — close this tab");
  assert.equal(r.strip(), null); assert.equal(r.live(), null);
  await r.clock.advance(120000); assert.equal(r.opens(), 1);
  await r.tab.close();
});

test("the next open waits for the old lease's cleanup to be confirmed; Reconnect now does not skip it", async () => {
  const r = rig({ opens: [1, 2] });
  await r.tab.start();
  r.exit(1, { cleanupPending: true, status: "closing" });
  await r.clock.advance(5000);
  r.button().click(); await r.clock.advance(0);
  assert.equal(r.opens(), 1, "no open while the old lease is still held");
  r.exit(1, { cleanupPending: false });
  await r.clock.advance(0);
  assert.equal(r.opens(), 2, "the due attempt runs once cleanup is confirmed");
  assert.equal(r.strip(), null);
  await r.tab.close();
});

test("exit 255 before the first ready is handled the same way", async () => {
  const gate = deferred();
  const r = rig({ opens: [1, 2], termReady: h => h.id === 1 ? gate.promise : ready(h) });
  const starting = r.tab.start(); await flush();
  r.exit(1); gate.resolve(ready(handle(1))); await starting;
  assert.equal(r.stripText(), "Disconnected from Build box. Reconnecting in 1s…");
  assert.ok(!r.log.includes("focus"), "no healthy focus for a lease that died before ready");
  await r.clock.advance(1000);
  assert.equal(r.strip(), null, "reconnected");
  await r.tab.close();
});

test("after sleep an overdue attempt runs at once, and only once", async () => {
  const r = rig({ opens: [1, "E_TERM_REMOTE_UNREACHABLE", "E_TERM_REMOTE_UNREACHABLE", "E_TERM_REMOTE_UNREACHABLE"] });
  await r.tab.start(); r.exit(1);
  await r.clock.advance(1000 + 2000 + 4000);
  assert.equal(r.opens(), 4);
  r.clock.jump(10 * 60 * 1000);
  await r.clock.advance(0);
  assert.equal(r.opens(), 5, "one overdue attempt, not a burst of the missed ones");
  assert.equal(r.stripText(), "Disconnected from Build box. Reconnecting in 15s…");
  await r.tab.close();
});

test("a user close before the link's exit arrives never reconnects", async () => {
  const r = rig({ opens: [1, 2] });
  await r.tab.start();
  const closing = r.tab.close();
  r.exit(1); await closing;
  await r.clock.advance(120000);
  assert.equal(r.opens(), 1);
  assert.equal(r.strip(), null);
});

test("while disconnected, Tab moves from the inert terminal to Reconnect now (Shift+Tab leaves the pane backwards); connected, Tab goes to the agent", async () => {
  const r = rig({ opens: [1, 2] });
  await r.tab.start();
  assert.equal(r.key({ key: "Tab" }), true, "a connected terminal keeps Tab for the agent");
  r.exit(1);
  assert.equal(r.key({ key: "Tab" }), false, "xterm leaves Tab to the browser, which moves focus to Reconnect now");
  assert.equal(r.key({ key: "Tab", shiftKey: true }), false);
  assert.equal(r.key({ key: "Tab", ctrlKey: true }), true, "a chord is not focus navigation");
  assert.ok(!r.log.some(v => v.startsWith("write")));
  await r.clock.advance(1000);
  assert.equal(r.strip(), null);
  assert.equal(r.key({ key: "Tab" }), true, "reconnected: Tab goes to the agent again");
  await r.tab.close();
});

test("an attempt's own lease that dies before it is ready continues the backoff: no reset, no burst, no stop", async () => {
  const gate = deferred();
  const r = rig({ opens: [1, 2, 3], termReady: h => h.id === 2 ? gate.promise : ready(h) });
  await r.tab.start(); r.exit(1);
  await r.clock.advance(1000);
  assert.equal(r.opens(), 2, "the first attempt is in flight, waiting for its ready");
  const lost = r.clock.now(); r.exit(2); gate.resolve(ready(handle(2))); await r.clock.advance(0);
  assert.equal(r.stripText(), "Disconnected from Build box. Reconnecting in 2s…", "the second wait, not the first again");
  await r.clock.advance(1000); assert.equal(r.opens(), 2, "no burst");
  await r.clock.advance(1000);
  assert.equal(r.openedAt.at(-1) - lost, 2000); assert.equal(r.strip(), null, "lease 3 connected");
  await r.tab.close();
});

test("a remote tab's first open failure names the server as a reconnect does", async () => {
  const r = rig({ opens: ["E_TERM_REMOTE_UNREACHABLE"] });
  await r.tab.start();
  assert.equal(r.banner(), "could not attach: Couldn't reach Build box.");
  await r.tab.close();
});

const NO_ANSWER = "E_TERM_REMOTE_NO_ANSWER", UNREACHABLE = "E_TERM_REMOTE_UNREACHABLE";
const noAnswerFinal = "OATS on this computer gave no answer while connecting to Build box. Close this tab.";

test("no answer from this computer's oats is retried 3 times in a row, then reconnecting stops", async () => {
  const r = rig({ opens: [1, NO_ANSWER, NO_ANSWER, NO_ANSWER, NO_ANSWER, 2] });
  await r.tab.start(); r.exit(1);
  await r.clock.advance(1000 + 2000 + 4000);
  assert.equal(r.opens(), 4, "three no-answer attempts so far");
  assert.equal(r.banner(), undefined, "still reconnecting");
  await r.clock.advance(8000);
  assert.equal(r.opens(), 5, "the third retry ran");
  assert.equal(r.banner(), noAnswerFinal);
  assert.equal(r.live().textContent, noAnswerFinal);
  assert.equal(r.strip(), null);
  await r.clock.advance(120000);
  assert.equal(r.opens(), 5, "no attempt after the stop"); assert.equal(r.clock.pending(), 0);
  await r.tab.close();
});

test("the no-answer count resets on an E_SSH answer and on a successful attach", async () => {
  const r = rig({ opens: [1, NO_ANSWER, NO_ANSWER, NO_ANSWER, UNREACHABLE, NO_ANSWER, NO_ANSWER, NO_ANSWER, 2,
    NO_ANSWER, NO_ANSWER, NO_ANSWER, 3] });
  await r.tab.start(); r.exit(1);
  await r.clock.advance(1000 + 2000 + 4000 + 8000 + 15000 + 30000 + 30000 + 30000);
  assert.equal(r.opens(), 9, "the E_SSH answer between the runs of no-answer kept it going");
  assert.equal(r.strip(), null); assert.equal(r.banner(), undefined, "reconnected");
  r.exit(2);
  await r.clock.advance(1000 + 2000 + 4000 + 8000);
  assert.equal(r.opens(), 13, "a success started the count again");
  assert.equal(r.strip(), null); assert.equal(r.banner(), undefined);
  await r.tab.close();
});

test("an unreachable server (E_SSH) is retried without limit", async () => {
  const r = rig({ opens: [1, ...Array(12).fill(UNREACHABLE)] });
  await r.tab.start(); r.exit(1);
  await r.clock.advance(1000 + 2000 + 4000 + 8000 + 15000 + 30000 * 7);
  assert.equal(r.opens(), 13);
  assert.equal(r.banner(), undefined, "never stops on its own");
  assert.match(r.stripText(), /^Disconnected from Build box\. Reconnecting in \d+s…$/);
  await r.tab.close();
});

test("a first open that gets no answer says so, naming the server", async () => {
  const r = rig({ opens: [NO_ANSWER] });
  await r.tab.start();
  assert.equal(r.banner(), "could not attach: OATS on this computer gave no answer while connecting to Build box.");
  await r.tab.close();
});

test("a prepare timeout between no-answers neither resets nor counts toward the cap", async () => {
  const r = rig({ opens: [1, NO_ANSWER, NO_ANSWER, "E_TERM_PREPARE_TIMEOUT", NO_ANSWER, NO_ANSWER, 2] });
  await r.tab.start(); r.exit(1);
  await r.clock.advance(1000 + 2000 + 4000 + 8000);
  assert.equal(r.opens(), 5, "no-answer, no-answer, timeout, no-answer");
  assert.equal(r.banner(), undefined, "three no-answers so far: still reconnecting");
  await r.clock.advance(15000);
  assert.equal(r.opens(), 6);
  assert.equal(r.banner(), noAnswerFinal, "the fourth no-answer stops; the timeout did not reset the count");
  await r.tab.close();
});

// The Desktop UI rework, slice 4: the shell says a drop and a reconnect on the status line (no question); the tab tells
// it once per episode, and the strip in the pane keeps its countdown and Reconnect now.
test("the link's drop is told once per episode and its reconnect once; the strip is unchanged", async () => {
  const told = [];
  const r = rig({ opens: [1, "E_TERM_REMOTE_UNREACHABLE", "E_TERM_REMOTE_UNREACHABLE", 2], onLink: event => told.push(event) });
  await r.tab.start();
  r.exit(1);
  assert.deepEqual(told, [{ state: "disconnected", server: "Build box" }]);
  assert.ok(r.strip(), "the strip shows, as before");
  await r.clock.advance(1000 + 2000 + 4000);
  assert.deepEqual(told, [{ state: "disconnected", server: "Build box" }, { state: "reconnected", server: "Build box" }], "failed attempts tell nothing more");
  assert.equal(r.strip(), null);
  await r.tab.close();
});
