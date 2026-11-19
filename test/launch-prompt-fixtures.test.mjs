import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEV_CHANNEL_ENTRIES, FLAG_IGNORED_ENTRIES, validateDevChannelEntries, normalizeScreen, matchDevChannelEntry, matchFlagIgnoredEntry,
  devChannelDifference, claudeVersionOf, launchPromptEngages } from "../lib/launch-prompt-fixtures.mjs";
import { raw296, raw289, linux296, flagIgnored, flagIgnoredHidden, edit } from "./helpers/dev-channel-screens.mjs";
import { CLAUDE_CHANNEL_ARGUMENTS } from "../mirrors/oats-aweb/lib/wake-receive.mjs";

const [DEV, PLUGIN] = CLAUDE_CHANNEL_ARGUMENTS.development.split(" ");
const provenance = JSON.parse(readFileSync(new URL("./fixtures/launch-prompts/dev-channel-provenance.json", import.meta.url), "utf8"));

test("normalization drops box rules, collapses whitespace and nothing else", () => {
  assert.equal(normalizeScreen("──────\n  A  b\n\n ╭─╮ \n\tC d \n"), "A b C d");
  assert.equal(normalizeScreen("Ab\n"), "Ab", "no case folding");
  assert.equal(normalizeScreen("x ─ y\n"), "x ─ y", "a box character inside text is kept");
  assert.equal(normalizeScreen(""), "");
});

test("recorded fixture bytes match their provenance", () => {
  for (const [name, row] of Object.entries(provenance)) {
    const bytes = readFileSync(new URL(`./fixtures/launch-prompts/${name}`, import.meta.url));
    assert.equal(bytes.length, row.bytes, name);
  }
});

test("the shipped tolerance list is one structurally valid entry with captured provenance", () => {
  assert.equal(DEV_CHANNEL_ENTRIES.length, 1);
  const [entry] = DEV_CHANNEL_ENTRIES;
  assert.equal(entry.text, normalizeScreen(raw296));
  assert.equal(entry.selected, "❯ 1. I am using this for local development");
  assert.deepEqual(entry.provenance.map(p => [p.claudeVersion, p.platform]).sort(), [["2.1.288", "linux-x64"], ["2.1.289", "darwin-arm64"], ["2.1.296", "darwin-arm64"], ["2.1.296", "linux-arm64"]]);
  assert.ok(Object.isFrozen(entry) && Object.isFrozen(DEV_CHANNEL_ENTRIES));
  assert.doesNotThrow(() => validateDevChannelEntries(structuredClone(DEV_CHANNEL_ENTRIES)));
});

for (const [name, mutate] of [
  ["the selection moved to Exit", t => t.replace("❯ 1. I am using this for local development 2. Exit", "1. I am using this for local development ❯ 2. Exit")],
  ["a second selection marker", t => t.replace("2. Exit", "❯ 2. Exit")],
  ["no selection marker", t => t.replace("❯ 1.", "1.")],
  ["a second channel", t => t.replace(PLUGIN, `${PLUGIN} plugin:other@market`)],
  ["text that is not normalized", t => t.replace("Exit Enter", "Exit  Enter")],
]) {
  test(`a hand-edited entry with ${name} fails validation`, () => {
    const entries = structuredClone(DEV_CHANNEL_ENTRIES);
    entries[0].text = mutate(entries[0].text);
    if (name === "the selection moved to Exit") entries[0].selected = "❯ 2. Exit";
    assert.throws(() => validateDevChannelEntries(entries), /dev-channel tolerance entry/);
  });
}

test("entries without id, selected or provenance fail validation", () => {
  for (const key of ["id", "selected", "provenance"]) {
    const entries = structuredClone(DEV_CHANNEL_ENTRIES);
    delete entries[0][key];
    assert.throws(() => validateDevChannelEntries(entries), /dev-channel tolerance entry/, key);
  }
  const entries = structuredClone(DEV_CHANNEL_ENTRIES);
  entries[0].provenance = [{ claudeVersion: "2.1.296" }];
  assert.throws(() => validateDevChannelEntries(entries), /provenance/);
});

for (const [label, screen] of [["2.1.296 darwin at 194 columns", raw296], ["2.1.289 darwin at 110 columns", raw289],
  ...["194x50", "110x35", "80x35", "60x35"].map(g => [`2.1.296 linux at ${g}`, linux296[g]])]) {
  test(`matches ${label}`, () => {
    assert.equal(matchDevChannelEntry(screen)?.id, DEV_CHANNEL_ENTRIES[0].id);
  });
}

test("a pane too narrow to wrap at word boundaries (2.1.296 linux at 40 columns) is no match", () => {
  assert.equal(matchDevChannelEntry(linux296["40x35"]), null);
  assert.equal(devChannelDifference(linux296["40x35"]).firstDifference.index, 74);
});

test("equality, not containment: any extra or missing text is no match", () => {
  assert.equal(matchDevChannelEntry(raw296 + "  Press any key\n"), null);
  assert.equal(matchDevChannelEntry(edit(raw296, "  Enter to confirm · Esc to cancel\n", "")), null);
  assert.equal(matchDevChannelEntry(""), null);
});

test("differed names the nearest entry and the first difference in bounded snippets", () => {
  const screen = edit(raw296, PLUGIN, "plugin:other-channel@elsewhere");
  const { nearest, firstDifference } = devChannelDifference(screen);
  assert.equal(nearest, DEV_CHANNEL_ENTRIES[0].id);
  const text = DEV_CHANNEL_ENTRIES[0].text;
  assert.equal(firstDifference.index, text.indexOf(PLUGIN) + "plugin:".length);
  assert.equal(firstDifference.expected, text.slice(firstDifference.index, firstDifference.index + 40));
  assert.ok(firstDifference.expected.length <= 40 && firstDifference.found.length <= 40);
  assert.ok(firstDifference.found.startsWith("other-channel@elsewhere"));
  const short = devChannelDifference("  WARNING: Loading\n");
  assert.equal(short.firstDifference.index, "WARNING: Loading".length);
  assert.equal(short.firstDifference.found, "");
});

test("differed picks the entry with the longest common prefix", () => {
  const entries = validateDevChannelEntries([...structuredClone(DEV_CHANNEL_ENTRIES), { ...structuredClone(DEV_CHANNEL_ENTRIES[0]),
    id: "other", text: DEV_CHANNEL_ENTRIES[0].text.replace("WARNING: Loading", "WARNING: Opening") }]);
  assert.equal(devChannelDifference(edit(raw296, "Loading", "Opening") + "x\n", entries).nearest, "other");
  assert.equal(devChannelDifference(raw296 + "x\n", entries).nearest, DEV_CHANNEL_ENTRIES[0].id);
});

test("engagement agrees with the provider's channel arguments", () => {
  for (const [mode, argument] of Object.entries(CLAUDE_CHANNEL_ARGUMENTS)) {
    assert.equal(launchPromptEngages({ harness: "claude", argv: argument.split(" ") }), mode === "development", mode);
  }
});

test("engagement is exactly claude with the single development-channel aweb argument", () => {
  assert.equal(launchPromptEngages({ harness: "claude", argv: ["--model", "x", DEV, PLUGIN] }), true);
  assert.equal(launchPromptEngages({ harness: "claude", argv: [DEV, PLUGIN, "--model", "x"] }), true);
  for (const [harness, argv] of [["codex", [DEV, PLUGIN]], ["pi", [DEV, PLUGIN]], ["claude", []],
    ["claude", ["--channels", PLUGIN]], ["claude", [DEV, "plugin:other@x"]], ["claude", [DEV, PLUGIN, "plugin:other@x"]],
    ["claude", [DEV, PLUGIN, "--channels", PLUGIN]], ["claude", [`${DEV}=${PLUGIN}`]], ["claude", [DEV, PLUGIN, DEV, PLUGIN]], ["claude", "nope"]]) {
    assert.equal(launchPromptEngages({ harness, argv }), false, `${harness} ${JSON.stringify(argv)}`);
  }
});

test("the Claude version comes from the executable's real path, never from running it", t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-claude-version-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const marker = join(base, "executed");
  const script = `#!/bin/sh\ntouch ${marker}\n`;
  const place = (path) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, script); chmodSync(path, 0o755); return path; };
  const cask = place(join(base, "Caskroom/claude-code@latest/2.1.296/claude"));
  symlinkSync(cask, join(base, "claude-cask"));
  const versions = place(join(base, "share/claude/versions/2.1.297"));
  symlinkSync(versions, join(base, "claude-versions"));
  const plain = place(join(base, "bin/2.1/claude"));
  assert.deepEqual(claudeVersionOf(join(base, "claude-cask")), { claudeVersion: "2.1.296", claudeVersionSource: "executable-path" });
  assert.deepEqual(claudeVersionOf(join(base, "claude-versions")), { claudeVersion: "2.1.297", claudeVersionSource: "executable-path" });
  assert.deepEqual(claudeVersionOf(plain), { claudeVersion: "unknown", claudeVersionSource: "unknown" });
  assert.deepEqual(claudeVersionOf(join(base, "missing")), { claudeVersion: "unknown", claudeVersionSource: "unknown" });
  assert.deepEqual(claudeVersionOf(undefined), { claudeVersion: "unknown", claudeVersionSource: "unknown" });
  assert.equal(existsSync(marker), false);
});

const NOTICE = "▎ --dangerously-load-development-channels ignored\n▎ (plugin:aweb-channel@awebai-marketplace)\n▎ Channels are not currently available\n";

test("the shipped flag-ignored entry is the notice block of the live 2.1.296 capture", () => {
  assert.equal(FLAG_IGNORED_ENTRIES.length, 1);
  const [entry] = FLAG_IGNORED_ENTRIES;
  assert.equal(entry.kind, "flag-ignored");
  assert.equal(entry.input, "none", "the entry says it takes no input");
  assert.equal(entry.text, `${DEV} ignored (${PLUGIN}) Channels are not currently available`);
  assert.deepEqual(entry.provenance.map(p => [p.claudeVersion, p.platform]), [["2.1.296", "darwin-arm64"]]);
  assert.ok(Object.isFrozen(entry) && Object.isFrozen(FLAG_IGNORED_ENTRIES));
  assert.ok(DEV_CHANNEL_ENTRIES.every(e => e.kind === "confirmation"));
  assert.equal(matchFlagIgnoredEntry(flagIgnored)?.id, entry.id);
  assert.equal(matchDevChannelEntry(flagIgnored), null, "the notice never confirms anything");
  assert.equal(matchFlagIgnoredEntry(raw296), null);
});

test("a notice hidden behind 'more notices hidden' is no match: the visible block is another notice", () => {
  assert.equal(matchFlagIgnoredEntry(flagIgnoredHidden), null);
});

test("the notice block matches at any wrapping: the rows' ▎ is dropped before the same normalization", () => {
  const wide = edit(flagIgnored, NOTICE, `▎ ${DEV} ignored (${PLUGIN})\n▎ Channels are not currently available\n`);
  assert.equal(matchFlagIgnoredEntry(wide)?.id, FLAG_IGNORED_ENTRIES[0].id);
  const narrow = edit(flagIgnored, NOTICE, `▎ ${DEV}\n▎ ignored\n▎ (${PLUGIN})\n▎ Channels are not\n▎ currently available\n`);
  assert.equal(matchFlagIgnoredEntry(narrow)?.id, FLAG_IGNORED_ENTRIES[0].id);
});

for (const [name, notice] of [
  ["another plugin", NOTICE.replace(PLUGIN, "plugin:other-channel@elsewhere")],
  ["another notice wording", NOTICE.replace("Channels are not currently available", "Channels are not available")],
  ["an extra line in the block", NOTICE + "▎ Run claude /channels to learn more\n"],
  ["an extra line above it in the block", "▎ Auto mode is now Claude Code's default permission mode.\n" + NOTICE],
  ["the notice text without the block marker", NOTICE.replaceAll("▎ ", "  ")],
  ["the notice text inside a longer row", NOTICE.replace("▎ --dangerously", "▎ note: --dangerously")],
  ["the block marker indented", NOTICE.replaceAll("▎ ", " ▎ ")],
]) {
  test(`a flag-ignored near-miss is no match: ${name}`, () => {
    assert.equal(matchFlagIgnoredEntry(edit(flagIgnored, NOTICE, notice)), null);
  });
}

for (const [name, mutate] of [
  ["no kind", e => { delete e.kind; }],
  ["no input statement", e => { delete e.input; }],
  ["an input other than none", e => { e.input = "Enter"; }],
  ["an unknown kind", e => { e.kind = "notice"; }],
  ["a selection marker", e => { e.text = `❯ ${e.text}`; }],
  ["a selected option", e => { e.selected = "❯ 1. I am using this for local development"; }],
  ["a second channel", e => { e.text = e.text.replace(PLUGIN, `${PLUGIN} plugin:other@market`); }],
  ["no development flag", e => { e.text = e.text.replace(`${DEV} `, ""); }],
  ["text that is not normalized", e => { e.text = e.text.replace(" ignored", "  ignored"); }],
]) {
  test(`a hand-edited flag-ignored entry with ${name} fails validation`, () => {
    const entries = structuredClone([...DEV_CHANNEL_ENTRIES, ...FLAG_IGNORED_ENTRIES]);
    mutate(entries[1]);
    assert.throws(() => validateDevChannelEntries(entries), /dev-channel tolerance entry/);
  });
}
