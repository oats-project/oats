// "This computer", renderer side (#602): main's state validated again, applied as a
// built-in base plus overrides, remembered for the next first paint, and a host
// theme that could not be used said once. The shipped theme module over a jsdom
// document (as theme-selection.test.mjs runs it), the real host-theme module and
// the real notification centre; a fake bridge and a fake storage. No browser, no
// Electron, no real storage. The derivation's contrast is held in
// theme-contrast.test.mjs, against the shared inventory.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { createHostTheme, validHostState } from "../renderer/host-theme.mjs";
import { createNotificationCenter } from "../renderer/notifications.mjs";
import { hostState, systemState } from "./helpers/host-theme-fixture.mjs";

const read = name => readFileSync(new URL(`../renderer/${name}`, import.meta.url), "utf8");
const themeSource = read("theme.mjs"), html = read("index.html"), css = read("theme.css");
const KEY = "oatsweb.theme", STORE = "oats.desktop.hostTheme";
const flush = () => new Promise(resolve => setImmediate(resolve));
const DARK_TERM = "#1a1b26", WHITE_TERM = "#ffffff"; // --term-bg of the built-in Dark (slice 3d: the app's --bg) and White

function fakeStorage(initial = {}, { broken = false } = {}) {
  const values = new Map(Object.entries(initial));
  return { values,
    getItem(key) { if (broken) throw new Error("storage blocked"); return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { if (broken) throw new Error("storage full"); values.set(key, String(value)); } };
}
/** The preload bridge: `hostTheme()` answers `answer` (a state, or a promise the test settles); `push` is main's push. */
function fakeDesk(answer = new Promise(() => {})) {
  const subscribers = new Set();
  return { subscribers, asked: 0,
    hostTheme() { this.asked++; return Promise.resolve(answer); },
    onHostThemeChanged(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    push(state) { for (const fn of [...subscribers]) fn(state); } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/** One Desktop window: its document, the shipped theme module, its host theme and its notification centre. */
function desktopWindow(t, { storage = fakeStorage(), desk = fakeDesk(), start = true, attach = true } = {}) {
  const dom = new JSDOM(html); // scripts and external resource loading disabled
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const style = doc.createElement("style"); style.textContent = css; doc.head.append(style);
  const theme = runInNewContext(`${themeSource.replace(/\bexport /g, "")}\n({
    THEMES, initTheme, currentTheme, appliedTheme, setTheme, toggleTheme, refreshHostTheme, onThemeChange, xtermTheme, terminalFontWeight
  })`, { document: doc, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ...(storage ? { localStorage: storage } : {}) });
  const changes = [];
  theme.onThemeChange(name => changes.push(name));
  const host = createHostTheme({ desk, storage, onChange: () => theme.refreshHostTheme() });
  t.after(() => host.dispose());
  const posted = [];
  const center = createNotificationCenter({ document: doc });
  t.after(() => center.dispose());
  const notify = (message, options) => { posted.push([message, options]); return center.notify(message, options); };
  theme.initTheme(host);
  if (start) host.start();
  if (attach) host.attach(notify);
  const root = doc.documentElement;
  return { doc, root, theme, host, desk, storage, changes, posted, center, notify,
    base: () => root.dataset.theme, inline: () => root.style.cssText, token: name => root.style.getPropertyValue(name),
    toasts: () => [...doc.querySelectorAll(".app-toast")].map(card => ({
      text: card.querySelector(".app-toast-text").textContent, detail: card.querySelector(".app-toast-detail")?.textContent ?? null, card })) };
}
const choseHost = { [KEY]: "host" };
const SHOWING = base => `This computer's theme could not be read. Showing ${base} instead.`;

// ── what main sends is checked again ────────────────────────────────────────

test("validHostState: the three shapes main sends, as clean copies; anything else is refused", () => {
  const omarchy = hostState("tokyo-night");
  assert.deepEqual(validHostState(omarchy), omarchy);
  assert.notEqual(validHostState(omarchy).colors.ansi, omarchy.colors.ansi, "a copy");
  assert.deepEqual(validHostState({ ...omarchy, name: "tokyo-night", path: "/somewhere", colors: { ...omarchy.colors, extra: "#000000" } }), omarchy, "only the known fields are kept");
  assert.deepEqual(validHostState(systemState("dark")), { source: "system", mode: "dark" });
  for (const reason of ["missing", "unreadable", "invalid"]) assert.deepEqual(validHostState(systemState("light", reason)), systemState("light", reason));
  const refused = [
    null, undefined, "omarchy", 7, [], {},
    { source: "gnome", mode: "dark" }, { source: "system" }, { source: "system", mode: "auto" }, { source: "system", mode: "Dark" },
    { source: "system", mode: "dark", problem: null }, { source: "system", mode: "dark", problem: "missing" },
    { source: "system", mode: "dark", problem: { origin: "gnome", reason: "missing" } },
    { source: "system", mode: "dark", problem: { origin: "omarchy", reason: "ENOENT: /home/someone/colors.toml" } },
    { source: "omarchy", mode: "dark" }, { source: "omarchy", mode: "dark", colors: "tokyo" },
    { ...omarchy, mode: "dim" },
    { ...omarchy, colors: { ...omarchy.colors, background: "#1A1B26" } },
    { ...omarchy, colors: { ...omarchy.colors, accent: "blue" } },
    { ...omarchy, colors: { ...omarchy.colors, canvas: "#13141c80" } },
    { ...omarchy, colors: { ...omarchy.colors, selection: undefined } },
    { ...omarchy, colors: { ...omarchy.colors, ansi: omarchy.colors.ansi.slice(1) } },
    { ...omarchy, colors: { ...omarchy.colors, ansi: [...omarchy.colors.ansi.slice(1), "url(x)"] } },
    { ...omarchy, colors: { ...omarchy.colors, ansi: "#1a1b26".repeat(16) } },
  ];
  for (const value of refused) assert.equal(validHostState(value), null, JSON.stringify(value) ?? String(value));
});

// ── 4. live change: chrome tokens follow a pushed state ─────────────────────

test("a pushed Omarchy state shows the host palette on the base of its polarity, and follows the next push", t => {
  const w = desktopWindow(t, { storage: fakeStorage(choseHost) });
  assert.equal(w.theme.currentTheme(), "host");
  const tokyo = hostState("tokyo-night"), rose = hostState("rose-pine");
  w.changes.length = 0;
  w.desk.push(tokyo);
  assert.equal(w.base(), "dark", "a dark host theme sits on Dark");
  assert.equal(w.theme.appliedTheme(), "dark"); assert.equal(w.theme.currentTheme(), "host");
  assert.equal(w.token("--term-bg"), tokyo.colors.background);
  assert.equal(w.token("--surface"), tokyo.colors.background);
  assert.equal(w.token("--bg"), tokyo.colors.canvas);
  assert.equal(w.token("--ansi-red"), tokyo.colors.ansi[1]);
  assert.match(w.token("--fg"), /^#[0-9a-f]{6}$/); assert.match(w.token("--accent"), /^#[0-9a-f]{6}$/);
  assert.equal(w.theme.xtermTheme().background, tokyo.colors.background);
  assert.equal(w.theme.xtermTheme().brightWhite, tokyo.colors.ansi[15]);
  assert.equal(w.theme.terminalFontWeight(), 400, "Dark's weight, from the base");
  assert.equal(w.token("--term-font-weight"), "", "the weight is not an override");
  assert.equal(w.token("--accent-fg"), ""); assert.equal(w.token("--md-code-bg"), "", "what the host does not supply stays the base theme's");
  assert.deepEqual(w.changes, ["host"], "one notification to the theme listeners");

  w.desk.push(rose);
  assert.equal(w.base(), "light", "a light host theme sits on White");
  assert.equal(w.token("--term-bg"), rose.colors.background);
  assert.equal(w.theme.xtermTheme().red, rose.colors.ansi[1]);
  assert.equal(w.theme.terminalFontWeight(), 475, "White's weight");
  assert.deepEqual(w.changes, ["host", "host"]);
  assert.deepEqual(w.toasts(), [], "nothing is announced for a theme that could be read");
  assert.deepEqual(JSON.parse(w.storage.values.get(STORE)), rose, "the last state shown is remembered for the next first paint");
});

// ── 5. system appearance ────────────────────────────────────────────────────

test("a computer with no Omarchy theme: Dark or White by the system appearance, exactly as those themes are, with nothing announced", t => {
  const w = desktopWindow(t, { storage: fakeStorage(choseHost) });
  w.desk.push(systemState("dark"));
  assert.equal(w.base(), "dark"); assert.equal(w.inline(), "", "no palette is imported");
  assert.equal(w.theme.xtermTheme().background, DARK_TERM); assert.equal(w.theme.terminalFontWeight(), 400);
  w.desk.push(systemState("light"));
  assert.equal(w.base(), "light"); assert.equal(w.inline(), "");
  assert.equal(w.theme.xtermTheme().background, WHITE_TERM); assert.equal(w.theme.terminalFontWeight(), 475);
  assert.equal(w.theme.currentTheme(), "host");
  assert.deepEqual(w.posted, []); assert.deepEqual(w.toasts(), []);
  assert.deepEqual(JSON.parse(w.storage.values.get(STORE)), systemState("light"));
});

// ── 3. fallback: a host theme that cannot be used ───────────────────────────

test("a problem state applies no override, shows the base by the system's mode and is said once; a good state then applies and dismisses it", t => {
  const w = desktopWindow(t, { storage: fakeStorage(choseHost) });
  w.desk.push(hostState("tokyo-night"));
  assert.notEqual(w.inline(), "");
  w.desk.push(systemState("light", "missing"));
  assert.equal(w.inline(), "", "every override of the palette shown before is gone: nothing is partly applied");
  assert.equal(w.base(), "light");
  assert.equal(w.theme.xtermTheme().background, WHITE_TERM);
  assert.deepEqual(w.toasts().map(({ text, detail }) => [text, detail]), [[SHOWING("White"), "The Omarchy theme has no colors file."]]);
  assert.deepEqual(w.posted[0][1], { sticky: true, detail: "The Omarchy theme has no colors file." }, "sticky, with the reason behind Details");
  assert.doesNotMatch(w.toasts()[0].card.textContent, /[/\\]|colors\.toml|omarchy\//, "no path in the text");
  // Re-reads and theme refreshes of the same problem do not post again.
  w.desk.push(systemState("light", "missing")); w.theme.refreshHostTheme(); w.theme.setTheme("host");
  assert.equal(w.toasts().length, 1); assert.equal(w.posted.length, 1);
  assert.deepEqual(JSON.parse(w.storage.values.get(STORE)), hostState("tokyo-night"), "a problem is not what the next first paint should show");

  w.desk.push(hostState("rose-pine"));
  assert.deepEqual(w.toasts(), [], "dismissed");
  assert.equal(w.token("--term-bg"), hostState("rose-pine").colors.background);
});

test("each reason has its own words, by the base shown: Dark or White", t => {
  for (const [reason, detail] of [["missing", "The Omarchy theme has no colors file."],
    ["unreadable", "The Omarchy theme's colors file could not be read."], ["invalid", "The Omarchy theme's colors are not usable."]]) {
    for (const [mode, label] of [["dark", "Dark"], ["light", "White"]]) {
      const w = desktopWindow(t, { storage: fakeStorage(choseHost) });
      w.desk.push(systemState(mode, reason));
      assert.deepEqual(w.toasts().map(({ text, detail: shown }) => [text, shown]), [[SHOWING(label), detail]], `${reason}, ${mode}`);
      assert.equal(w.base(), mode); assert.equal(w.inline(), "");
    }
  }
});

test("a palette the derivation refuses is a problem of its own (`invalid`): no override at all, the base of the palette's polarity, one notice", t => {
  const w = desktopWindow(t, { storage: fakeStorage(choseHost) });
  const good = hostState("rose-pine"), impossible = hostState("impossible");
  w.desk.push(good);
  w.changes.length = 0;
  w.desk.push(impossible);
  assert.equal(w.inline(), "", "after a failed derivation the root carries no inline property");
  for (const property of ["--bg", "--surface", "--fg", "--accent", "--term-bg", "--ansi-red", "--term-sel"]) assert.equal(w.token(property), "", property);
  assert.equal(w.base(), impossible.mode, "the palette's own polarity");
  assert.equal(w.theme.xtermTheme().background, DARK_TERM, "Dark as it is");
  assert.deepEqual(w.toasts().map(({ text, detail }) => [text, detail]), [[SHOWING("Dark"), "The Omarchy theme's colors are not usable."]]);
  assert.deepEqual(w.changes, ["host"]);
  assert.deepEqual(JSON.parse(w.storage.values.get(STORE)), good, "an unusable palette is not remembered");
  w.desk.push(impossible); w.theme.refreshHostTheme();
  assert.equal(w.toasts().length, 1);
  w.desk.push(good);
  assert.deepEqual(w.toasts(), []); assert.equal(w.token("--term-bg"), good.colors.background);
});

test("one notice per episode: not posted again after its × or after the centre clears; replaced when the reason or the base changes", t => {
  const w = desktopWindow(t, { storage: fakeStorage(choseHost) });
  w.desk.push(systemState("dark", "missing"));
  w.toasts()[0].card.querySelector(".app-toast-dismiss").click();
  assert.deepEqual(w.toasts(), []);
  w.desk.push(systemState("dark", "missing")); w.theme.refreshHostTheme();
  assert.deepEqual(w.toasts(), [], "the operator dismissed it: the same episode is not said again");

  w.desk.push(systemState("dark", "unreadable"));
  assert.deepEqual(w.toasts().map(({ detail }) => detail), ["The Omarchy theme's colors file could not be read."], "another reason is another episode");
  w.desk.push(systemState("dark", "invalid"));
  assert.deepEqual(w.toasts().map(({ detail }) => detail), ["The Omarchy theme's colors are not usable."], "replaced, not stacked");
  w.desk.push(systemState("light", "invalid"));
  assert.deepEqual(w.toasts().map(({ text }) => text), [SHOWING("White")], "the notice names the base actually shown");

  w.center.clear(); // a workspace switch clears every notice, sticky ones too
  w.desk.push(systemState("light", "invalid")); w.theme.refreshHostTheme();
  assert.deepEqual(w.toasts(), [], "not posted again within the episode");
  assert.equal(w.posted.length, 4);
});

test("the notice exists only while This computer is the choice: another theme dismisses it, and a window with another choice never posts it", t => {
  const w = desktopWindow(t, { storage: fakeStorage(choseHost) });
  w.desk.push(systemState("dark", "unreadable"));
  assert.equal(w.toasts().length, 1);
  w.theme.setTheme("solarized");
  assert.deepEqual(w.toasts(), [], "choosing another theme dismisses it");
  w.desk.push(systemState("dark", "missing"));
  assert.deepEqual(w.toasts(), []); assert.equal(w.base(), "solarized");
  w.theme.setTheme("host");
  assert.deepEqual(w.toasts().map(({ detail }) => detail), ["The Omarchy theme has no colors file."], "back on This computer, the current problem is said");

  const other = desktopWindow(t, { storage: fakeStorage({ [KEY]: "dark" }) });
  other.desk.push(systemState("light", "invalid")); other.desk.push(hostState("impossible"));
  assert.deepEqual(other.posted, []); assert.equal(other.base(), "dark"); assert.equal(other.inline(), "");
});

test("a problem known before the notification centre exists is said when it is attached", async t => {
  const w = desktopWindow(t, { storage: fakeStorage(choseHost), desk: fakeDesk(systemState("dark", "unreadable")), attach: false });
  await flush();
  assert.equal(w.base(), "dark"); assert.deepEqual(w.posted, []);
  w.host.attach(w.notify);
  assert.deepEqual(w.toasts().map(({ detail }) => detail), ["The Omarchy theme's colors file could not be read."]);
  w.host.attach(w.notify);
  assert.equal(w.posted.length, 1);
});

// ── first paint, and the answer to the first read ───────────────────────────

test("first paint: the stored last state is applied synchronously in initTheme, then reconciled with main's answer", async t => {
  const tokyo = hostState("tokyo-night"), rose = hostState("rose-pine");
  const answer = deferred();
  const w = desktopWindow(t, { storage: fakeStorage({ ...choseHost, [STORE]: JSON.stringify(tokyo) }), desk: fakeDesk(answer.promise) });
  // Nothing has been awaited: main has not answered.
  assert.equal(w.base(), "dark", "no White flash for an operator whose host theme is dark");
  assert.equal(w.token("--term-bg"), tokyo.colors.background);
  assert.deepEqual(w.changes, ["host"]);
  assert.equal(w.desk.asked, 0, "the read is asked for after the paint");
  await flush();
  assert.equal(w.desk.asked, 1);
  answer.resolve(rose); await flush();
  assert.equal(w.base(), "light"); assert.equal(w.token("--term-bg"), rose.colors.background);
  assert.deepEqual(JSON.parse(w.storage.values.get(STORE)), rose);
});

test("a stored last state that no longer validates is ignored; so is a stored problem", t => {
  const good = hostState("tokyo-night");
  for (const stored of ["not json", "null", JSON.stringify({ ...good, mode: "dim" }), JSON.stringify({ ...good, colors: { ...good.colors, background: "red" } }),
    JSON.stringify(systemState("dark", "missing"))]) {
    const w = desktopWindow(t, { storage: fakeStorage({ ...choseHost, [STORE]: stored }), start: false });
    assert.equal(w.theme.currentTheme(), "host");
    assert.equal(w.base(), "light", `${stored}: nothing known yet shows White`);
    assert.equal(w.inline(), ""); assert.deepEqual(w.posted, []);
  }
});

test("the stored state is not applied, and nothing is stored, while another theme is the choice; choosing This computer then shows the latest state at once", t => {
  const tokyo = hostState("tokyo-night"), rose = hostState("rose-pine");
  const w = desktopWindow(t, { storage: fakeStorage({ [KEY]: "solarized", [STORE]: JSON.stringify(tokyo) }) });
  assert.equal(w.base(), "solarized"); assert.equal(w.inline(), "");
  w.changes.length = 0;
  w.desk.push(rose);
  assert.equal(w.base(), "solarized"); assert.equal(w.inline(), ""); assert.deepEqual(w.changes, [], "a push is not a theme change in this window");
  assert.deepEqual(JSON.parse(w.storage.values.get(STORE)), tokyo, "only a state that was shown is remembered");
  assert.equal(w.theme.setTheme("host"), "host");
  assert.equal(w.base(), "light"); assert.equal(w.token("--term-bg"), rose.colors.background);
  assert.equal(w.storage.values.get(KEY), "host");
});

test("latest intent: the answer to the first read is dropped when a push arrived meanwhile, on success and on rejection", async t => {
  const tokyo = hostState("tokyo-night"), rose = hostState("rose-pine");
  const late = deferred();
  const w = desktopWindow(t, { storage: fakeStorage(choseHost), desk: fakeDesk(late.promise) });
  await flush();
  w.desk.push(rose);
  late.resolve(tokyo); await flush();
  assert.equal(w.token("--term-bg"), rose.colors.background, "the push is newer than the answer");
  assert.equal(w.base(), "light");

  const failing = deferred();
  const x = desktopWindow(t, { storage: fakeStorage(choseHost), desk: fakeDesk(failing.promise) });
  await flush();
  x.desk.push(rose);
  failing.reject(new Error("bridge gone")); await flush();
  assert.equal(x.token("--term-bg"), rose.colors.background, "a rejected read changes nothing and is not an error of the window");

  const alone = deferred();
  const y = desktopWindow(t, { storage: fakeStorage(choseHost), desk: fakeDesk(alone.promise) });
  await flush();
  alone.resolve(tokyo); await flush();
  assert.equal(y.token("--term-bg"), tokyo.colors.background, "with no push, the answer is used");
});

test("a state that does not validate is not used: the theme shown stays", t => {
  const w = desktopWindow(t, { storage: fakeStorage(choseHost) });
  const tokyo = hostState("tokyo-night");
  w.desk.push(tokyo);
  w.changes.length = 0;
  for (const bad of [null, "dark", {}, { source: "omarchy", mode: "dark", colors: { ...tokyo.colors, background: "javascript:1" } }, { ...tokyo, mode: "dusk" }]) w.desk.push(bad);
  assert.equal(w.token("--term-bg"), tokyo.colors.background);
  assert.deepEqual(w.changes, []); assert.deepEqual(w.posted, []);
});

// ── several windows, storage, the bridge ────────────────────────────────────

test("several windows: each gets the push, and each applies it only if its own choice is This computer", t => {
  const desk = fakeDesk(), storage = fakeStorage(choseHost);
  const a = desktopWindow(t, { desk, storage });
  const b = desktopWindow(t, { desk, storage });
  b.theme.setTheme("dark");
  assert.equal(desk.subscribers.size, 2);
  const tokyo = hostState("tokyo-night");
  desk.push(tokyo);
  assert.equal(a.token("--term-bg"), tokyo.colors.background);
  assert.equal(b.inline(), ""); assert.equal(b.base(), "dark"); assert.equal(b.theme.currentTheme(), "dark");
  assert.equal(a.theme.currentTheme(), "host", "a window keeps its own choice until it reloads");
});

test("storage unavailable: the choice and the host theme still work in memory", t => {
  for (const storage of [fakeStorage({}, { broken: true }), null]) {
    const w = desktopWindow(t, { storage });
    assert.equal(w.theme.currentTheme(), "light");
    assert.equal(w.theme.setTheme("host"), "host");
    const tokyo = hostState("tokyo-night");
    w.desk.push(tokyo);
    assert.equal(w.token("--term-bg"), tokyo.colors.background); assert.equal(w.base(), "dark");
    w.desk.push(systemState("light", "missing"));
    assert.equal(w.toasts().length, 1); assert.equal(w.inline(), "");
  }
});

test("a window without the bridge (or with an older preload) shows White for This computer and does not throw", async t => {
  for (const desk of [null, {}]) {
    const w = desktopWindow(t, { storage: fakeStorage(choseHost), desk });
    await flush();
    assert.equal(w.theme.currentTheme(), "host"); assert.equal(w.base(), "light"); assert.equal(w.inline(), "");
    assert.deepEqual(w.posted, []);
  }
});

test("dispose unsubscribes from main's pushes and drops a late answer", async t => {
  const answer = deferred(), desk = fakeDesk(answer.promise);
  const w = desktopWindow(t, { storage: fakeStorage(choseHost), desk });
  assert.equal(desk.subscribers.size, 1);
  w.host.start();
  assert.equal(desk.subscribers.size, 1, "started once");
  await flush();
  w.host.dispose();
  assert.equal(desk.subscribers.size, 0);
  answer.resolve(hostState("tokyo-night")); await flush();
  assert.equal(w.inline(), ""); assert.equal(w.base(), "light");
});
