// Isolated renderer module + CSSOM only; no OS, browser, app or real storage.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";

const source = readFileSync(new URL("../renderer/theme.mjs", import.meta.url), "utf8");
const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../renderer/theme.css", import.meta.url), "utf8");
const KEY = "oatsweb.theme";
function fixture(t, { saved = null, readError = false, writeError = false, noStorage = false, osDark = true } = {}) {
  const dom = new JSDOM(html); // scripts and external resource loading disabled
  t.after(() => dom.window.close());
  const style = dom.window.document.createElement("style");
  style.textContent = css; dom.window.document.head.append(style);
  const reads = [], writes = [], osListeners = [];
  let mediaQueries = 0;
  const context = {
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    window: { matchMedia() { mediaQueries++; return {
      matches: osDark, addEventListener: (_, fn) => osListeners.push(fn),
    }; } },
  };
  if (!noStorage) context.localStorage = {
    getItem(key) { reads.push(key); if (readError) throw new Error("storage blocked"); return saved; },
    setItem(key, value) { writes.push([key, value]); if (writeError) throw new Error("storage full"); saved = value; },
  };
  const theme = runInNewContext(`${source.replace(/\bexport /g, "")}\n({
    THEMES, initTheme, currentTheme, appliedTheme, applyTheme, setTheme, toggleTheme, refreshHostTheme, onThemeChange, xtermTheme
  })`, context);
  return { theme, doc: context.document, reads, writes,
    mediaQueries: () => mediaQueries,
    changeOS(dark) { for (const listener of osListeners) listener({ matches: dark }); },
  };
}

test("initial HTML is Light (once White) before scripts run; public choices have stable labels and order", t => {
  const { doc, theme } = fixture(t);
  assert.equal(doc.documentElement.dataset.theme, "light");
  assert.equal(theme.currentTheme(), "light");
  assert.deepEqual(Array.from(theme.THEMES, item => [item.id, item.label]), [
    // The Appearance sheet's words (the Desktop UI rework, slice 4): White is Light and This computer is System; the ids stay.
    ["light", "Light"], ["solarized", "Solarized"], ["dark", "Dark"], ["host", "System"],
  ]);
  assert.ok(Object.isFrozen(theme.THEMES));
  for (const item of theme.THEMES) assert.ok(Object.isFrozen(item));
});

for (const osDark of [false, true]) {
  for (const saved of [null, "", "bogus", "LIGHT", "white", "system", "__proto__", "#ff0000", " dark ", "HOST", "omarchy", "This computer"]) {
    test(`OS ${osDark ? "dark" : "light"}, invalid/missing ${JSON.stringify(saved)} defaults to White`, t => {
      const u = fixture(t, { saved, osDark });
      u.doc.documentElement.dataset.theme = "dark";
      assert.equal(u.theme.initTheme(), "light");
      assert.equal(u.doc.documentElement.dataset.theme, "light");
      u.changeOS(true); u.changeOS(false);
      assert.equal(u.theme.currentTheme(), "light");
      assert.equal(u.mediaQueries(), 0, "OS preference is not consulted or subscribed");
      assert.deepEqual(u.reads, [KEY]);
      assert.deepEqual(u.writes, [], "initialization doesn't rewrite preferences");
    });
  }
}
for (const saved of ["light", "solarized", "dark"]) test(`honors saved ${saved} via the legacy key`, t => {
  const u = fixture(t, { saved });
  assert.equal(u.theme.initTheme(), saved);
  u.changeOS(true); u.changeOS(false);
  assert.equal(u.theme.currentTheme(), saved);
  assert.deepEqual(u.reads, [KEY]);
  assert.deepEqual(u.writes, []);
});

for (const storage of [{}, { readError: true }, { writeError: true }, { noStorage: true }]) {
  test(`storage ${JSON.stringify(storage)}: selection and cycling remain usable`, t => {
    const u = fixture(t, storage);
    assert.equal(u.theme.initTheme(), "light");
    // White → Solarized → Dark → This computer → White.
    for (const expected of ["solarized", "dark", "host", "light", "solarized"]) {
      assert.equal(u.theme.toggleTheme(), expected);
      assert.equal(u.theme.currentTheme(), expected);
    }
    assert.equal(u.theme.setTheme("dark"), "dark");
    assert.equal(u.theme.currentTheme(), "dark");
    if (!storage.noStorage) assert.deepEqual(u.writes, ["solarized", "dark", "host", "light", "solarized", "dark"].map(value => [KEY, value]));
  });
}

test("public application/selection never project arbitrary names; applyTheme remains non-persisting", t => {
  const u = fixture(t);
  assert.equal(u.theme.applyTheme("solarized"), "solarized");
  assert.deepEqual(u.writes, []);
  for (const invalid of [undefined, null, {}, ["dark"], 1, "WHITE", "__proto__", "red; background:url(x)"]) {
    assert.equal(u.theme.setTheme(invalid), "light");
    assert.equal(u.doc.documentElement.dataset.theme, "light");
  }
  u.doc.documentElement.dataset.theme = "corrupt";
  assert.equal(u.theme.currentTheme(), "light");
  assert.equal(u.theme.toggleTheme(), "solarized");
  assert.equal(u.theme.applyTheme("invalid"), "light");
});

test("listeners receive validated live themes, survive failures and unsubscribe", t => {
  const u = fixture(t, { writeError: true });
  const events = [];
  const offBroken = u.theme.onThemeChange(() => { throw new Error("inert listener failed"); });
  const off = u.theme.onThemeChange(name => events.push([name, u.theme.currentTheme()]));
  u.theme.setTheme("solarized"); u.theme.toggleTheme(); u.theme.setTheme("not-a-theme");
  assert.deepEqual(events, [["solarized", "solarized"], ["dark", "dark"], ["light", "light"]]);
  off(); offBroken(); u.theme.toggleTheme();
  assert.equal(events.length, 3);
});

test("xterm follows all three live CSS palettes including selection and all 16 ANSI tokens", t => {
  const u = fixture(t);
  const cssTokens = name => Object.fromEntries([...css.match(new RegExp(`\\[data-theme="${name}"\\] \\{([\\s\\S]*?)\\n\\}`))[1]
    .matchAll(/--([\w-]+):\s*(#[0-9a-f]{6}(?:[0-9a-f]{2})?)\b/gi)].map(match => [match[1], match[2]]));
  const projections = { background: "term-bg", foreground: "term-fg", cursor: "term-fg", cursorAccent: "term-bg", selectionBackground: "term-sel", selectionForeground: "term-sel-fg" };
  const changes = [];
  const off = u.theme.onThemeChange(() => changes.push(u.theme.xtermTheme()));
  t.after(off);
  for (const name of ["light", "solarized", "dark"]) {
    u.theme.setTheme(name);
    const result = changes.at(-1), tokens = cssTokens(name);
    assert.equal(Object.keys(result).length, 22);
    for (const [field, token] of Object.entries(projections)) assert.equal(result[field], tokens[token], `${name} ${field}`);
    for (const [token, value] of Object.entries(tokens).filter(([token]) => token.startsWith("ansi-"))) {
      const field = token.slice(5).replace(/-(\w)/g, (_, letter) => letter.toUpperCase());
      assert.equal(result[field], value, `${name} ${field}`);
    }
  }
});

// "This computer" (#602): a choice, not a palette. What it shows comes from a host source
// (renderer/host-theme.mjs; a stub here, the real one in host-theme.test.mjs).
const rootStyle = doc => doc.documentElement.style;

test("This computer saves and restores as `host`; the choice is not the applied theme; with no host source it shows White", t => {
  const u = fixture(t, { saved: "host" });
  u.doc.documentElement.dataset.theme = "dark";
  assert.equal(u.theme.initTheme(), "host");
  assert.equal(u.theme.currentTheme(), "host", "the choice");
  assert.equal(u.theme.appliedTheme(), "light", "what is applied");
  assert.equal(u.doc.documentElement.dataset.theme, "light", "data-theme stays a built-in id: it is the CSS hook");
  assert.deepEqual(u.reads, [KEY]); assert.deepEqual(u.writes, [], "restoring does not rewrite the preference");
  assert.equal(u.mediaQueries(), 0, "the renderer does not consult the OS itself");
  assert.equal(u.theme.setTheme("solarized"), "solarized");
  assert.equal(u.theme.appliedTheme(), "solarized"); assert.equal(u.theme.currentTheme(), "solarized");
  assert.equal(u.theme.setTheme("host"), "host");
  assert.deepEqual(u.writes, [[KEY, "solarized"], [KEY, "host"]]);
  assert.equal(u.theme.toggleTheme(), "light", "the cycle closes: This computer → White");
});

test("This computer applies the host source's base and its overrides in one pass, and notifies listeners once", t => {
  const calls = [];
  const host = { state: { mode: "dark", tokens: { "--bg": "#101010", "--term-bg": "#202020" } },
    mode() { return this.state.mode; },
    tokens(base) { calls.push(["tokens", base("md-code-bg")]); return this.state.tokens; },
    shown(chosen) { calls.push(["shown", chosen]); } };
  const u = fixture(t, { saved: "host" });
  const heard = [];
  u.theme.onThemeChange(name => heard.push([name, u.doc.documentElement.dataset.theme, rootStyle(u.doc).getPropertyValue("--bg")]));
  assert.equal(u.theme.initTheme(host), "host");
  assert.equal(u.doc.documentElement.dataset.theme, "dark", "the base, by the host's polarity");
  assert.equal(rootStyle(u.doc).getPropertyValue("--bg"), "#101010");
  assert.equal(u.theme.xtermTheme().background, "#202020", "terminals read the override through the same tokens");
  assert.deepEqual(calls, [["tokens", "#ffffff10"], ["shown", true]], "the source reads the base theme's own tokens (Dark's here), and hears the result");
  assert.deepEqual(heard, [["host", "dark", "#101010"]], "one notification, after every property is set");

  host.state = { mode: "light", tokens: { "--bg": "#fafafa" } };
  u.theme.refreshHostTheme();
  assert.equal(u.doc.documentElement.dataset.theme, "light");
  assert.equal(rootStyle(u.doc).getPropertyValue("--bg"), "#fafafa");
  assert.equal(rootStyle(u.doc).getPropertyValue("--term-bg"), "", "an override the new palette does not set is gone");
  assert.equal(u.theme.xtermTheme().background, "#ffffff", "so the base theme's value shows");
  assert.equal(heard.length, 2); assert.deepEqual(heard[1], ["host", "light", "#fafafa"]);
  assert.deepEqual(calls.slice(2), [["tokens", "#ffffff60"], ["shown", true]], "White's token this time");

  host.state = { mode: "dark", tokens: null };
  u.theme.refreshHostTheme();
  assert.equal(u.doc.documentElement.dataset.theme, "dark");
  assert.equal(rootStyle(u.doc).cssText, "", "no palette: the base theme exactly, with no override");
  assert.equal(u.theme.currentTheme(), "host"); assert.equal(u.theme.appliedTheme(), "dark");
});

test("leaving This computer removes every inline override; refreshing the host does nothing for another choice", t => {
  const calls = [];
  const tokens = { "--bg": "#101010", "--surface": "#111111", "--fg": "#eeeeee", "--term-bg": "#202020", "--ansi-red": "#ff0000" };
  const host = { mode: () => "dark", tokens: () => tokens, shown: chosen => calls.push(chosen) };
  const u = fixture(t, { saved: "host" });
  u.theme.initTheme(host);
  for (const [property, value] of Object.entries(tokens)) assert.equal(rootStyle(u.doc).getPropertyValue(property), value);
  for (const next of ["dark", "solarized", "light"]) {
    u.theme.setTheme("host");
    assert.equal(rootStyle(u.doc).getPropertyValue("--bg"), "#101010");
    assert.equal(u.theme.setTheme(next), next);
    for (const property of Object.keys(tokens)) assert.equal(rootStyle(u.doc).getPropertyValue(property), "", `${next}: ${property} is no longer set inline`);
    assert.equal(rootStyle(u.doc).cssText, "", `${next} is exactly the built-in theme`);
    assert.equal(u.doc.documentElement.dataset.theme, next);
    assert.equal(calls.at(-1), false, "the source hears that it is no longer the choice");
  }
  const heard = [];
  u.theme.onThemeChange(name => heard.push(name));
  u.theme.refreshHostTheme();
  assert.deepEqual(heard, [], "a host change is not applied in a window whose choice is another theme");
  assert.equal(u.doc.documentElement.dataset.theme, "light"); assert.equal(rootStyle(u.doc).cssText, "");
});

test("a host source that throws leaves the base theme with no override, and the theme is still applied", t => {
  const u = fixture(t);
  const heard = [];
  u.theme.onThemeChange(name => heard.push(name));
  u.theme.initTheme({ mode: () => "dark", tokens: () => { throw new Error("inert source failed"); }, shown: () => { throw new Error("inert source failed"); } });
  assert.equal(u.theme.setTheme("host"), "host");
  assert.equal(u.doc.documentElement.dataset.theme, "dark");
  assert.equal(rootStyle(u.doc).cssText, "");
  assert.deepEqual(heard, ["light", "host"]);
});

// The default (#602). A Desktop with no saved choice starts in the fallback the shell passes
// to initTheme: `host` on Linux, `light` elsewhere (also the one-argument call). A default is
// not a choice: starting stores nothing, so it stays a default until the user chooses.
const darkHost = () => ({ mode: () => "dark", tokens: () => ({ "--bg": "#101010" }), shown() {} });

for (const [what, storage] of [
  ["nothing saved", {}], ["an empty saved value", { saved: "" }], ["a saved value that is not a theme", { saved: "blue" }],
  ["a saved label, not an id", { saved: "This computer" }], ["a saved id in another case", { saved: "HOST" }],
  ["storage that throws on read", { readError: true }], ["storage that throws on read and on write", { readError: true, writeError: true }],
  ["no storage", { noStorage: true }],
]) {
  test(`with the \`host\` fallback, ${what} starts in This computer, and nothing is written`, t => {
    const u = fixture(t, storage);
    assert.equal(u.theme.initTheme(darkHost(), "host"), "host");
    assert.equal(u.theme.currentTheme(), "host", "the choice");
    assert.equal(u.theme.appliedTheme(), "dark", "shown on the host's base");
    assert.equal(rootStyle(u.doc).getPropertyValue("--bg"), "#101010", "with the host's overrides");
    assert.deepEqual(u.writes, [], "a default is not a choice: starting stores nothing");
    assert.equal(u.mediaQueries(), 0, "the renderer does not consult the OS itself");
    // Choosing works from there, in memory where storage does not.
    assert.equal(u.theme.toggleTheme(), "light", "the cycle goes on from This computer");
    assert.equal(rootStyle(u.doc).cssText, "");
    assert.equal(u.theme.setTheme("dark"), "dark");
    assert.equal(u.theme.currentTheme(), "dark");
    if (!storage.noStorage) assert.deepEqual(u.writes, [[KEY, "light"], [KEY, "dark"]], "only a choice is stored");
  });
}

test("the `host` default with no host source shows White, reports the choice as `host` and does not throw", t => {
  const u = fixture(t);
  u.doc.documentElement.dataset.theme = "dark";
  assert.equal(u.theme.initTheme(null, "host"), "host");
  assert.equal(u.theme.currentTheme(), "host");
  assert.equal(u.theme.appliedTheme(), "light");
  assert.equal(u.doc.documentElement.dataset.theme, "light");
  assert.equal(rootStyle(u.doc).cssText, "");
  assert.deepEqual(u.writes, []);
});

test("the `host` default shows what a saved `host` shows: the host source's base and overrides, in one pass", t => {
  const show = (storage, fallback) => {
    const calls = [], heard = [];
    const host = { state: { mode: "dark", tokens: { "--bg": "#101010", "--term-bg": "#202020" } },
      mode() { return this.state.mode; },
      tokens(base) { calls.push(["tokens", base("md-code-bg")]); return this.state.tokens; },
      shown(chosen) { calls.push(["shown", chosen]); } };
    const u = fixture(t, storage);
    const root = u.doc.documentElement;
    const seen = () => ({ choice: u.theme.currentTheme(), applied: u.theme.appliedTheme(), base: root.dataset.theme,
      bg: rootStyle(u.doc).getPropertyValue("--bg"), termBg: rootStyle(u.doc).getPropertyValue("--term-bg"), terminal: u.theme.xtermTheme().background });
    u.theme.onThemeChange(name => heard.push([name, root.dataset.theme, rootStyle(u.doc).getPropertyValue("--bg")]));
    const returned = u.theme.initTheme(host, fallback);
    const first = seen();
    // The host's theme changes: followed, as for a saved choice.
    host.state = { mode: "light", tokens: { "--bg": "#fafafa" } };
    u.theme.refreshHostTheme();
    return { returned, first, afterChange: seen(), calls, heard, writes: u.writes };
  };
  const byDefault = show({}, "host");
  assert.deepEqual(byDefault, show({ saved: "host" }), "the same as when `host` is the saved choice");
  assert.equal(byDefault.returned, "host");
  assert.deepEqual(byDefault.first, { choice: "host", applied: "dark", base: "dark", bg: "#101010", termBg: "#202020", terminal: "#202020" });
  assert.deepEqual(byDefault.afterChange, { choice: "host", applied: "light", base: "light", bg: "#fafafa", termBg: "", terminal: "#ffffff" });
  assert.deepEqual(byDefault.calls, [["tokens", "#ffffff10"], ["shown", true], ["tokens", "#ffffff60"], ["shown", true]]);
  assert.deepEqual(byDefault.heard, [["host", "dark", "#101010"], ["host", "light", "#fafafa"]], "one notification per pass");
  assert.deepEqual(byDefault.writes, []);
});

for (const saved of ["light", "solarized", "dark", "host"]) {
  test(`a saved ${saved} is applied whatever the fallback, and not rewritten`, t => {
    for (const fallback of ["host", "light", "dark", "nonsense", undefined]) {
      const u = fixture(t, { saved });
      assert.equal(u.theme.initTheme(darkHost(), fallback), saved, `fallback ${JSON.stringify(fallback)}`);
      assert.equal(u.theme.currentTheme(), saved);
      assert.deepEqual(u.reads, [KEY]);
      assert.deepEqual(u.writes, [], "restoring does not rewrite the preference");
    }
  });
}

test("elsewhere the default is White: the `light` fallback, the one-argument call, and a fallback that is not a theme", t => {
  for (const saved of [null, "blue"]) {
    for (const fallback of ["light", undefined, null, "nonsense", "", "HOST", "This computer", "system", "__proto__", 7, {}, ["host"]]) {
      const u = fixture(t, { saved });
      u.doc.documentElement.dataset.theme = "dark";
      assert.equal(u.theme.initTheme(darkHost(), fallback), "light", `saved ${JSON.stringify(saved)}, fallback ${JSON.stringify(fallback)}`);
      assert.equal(u.theme.currentTheme(), "light");
      assert.equal(u.doc.documentElement.dataset.theme, "light");
      assert.equal(rootStyle(u.doc).cssText, "", "the host source is not shown");
      assert.deepEqual(u.writes, []);
    }
  }
});

test("the shell passes the platform's default to initTheme: `host` where navigator.platform includes Linux, `light` otherwise", () => {
  const shell = readFileSync(new URL("../renderer/shell.mjs", import.meta.url), "utf8");
  const calls = [...shell.matchAll(/\binitTheme\(([^;\n]*)\);/g)];
  assert.equal(calls.length, 1, "the shell initializes the theme in one place");
  const hostTheme = {};
  for (const [platform, expected] of [["Linux x86_64", "host"], ["Linux aarch64", "host"], ["Linux armv8l", "host"],
    ["MacIntel", "light"], ["Win32", "light"], ["FreeBSD amd64", "light"], ["", "light"]]) {
    // The shipped call's own arguments, evaluated against a platform.
    const args = runInNewContext(`[${calls[0][1]}]`, { hostTheme, navigator: { platform } });
    assert.equal(args.length, 2, "the host source, then the default");
    assert.equal(args[0], hostTheme);
    assert.equal(args[1], expected, platform || "(no platform)");
  }
});
