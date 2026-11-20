// #1879 acceptance 6 (the notice, Pepe's condition 2 and Juan's condition 3): while the accepted CLI is above
// this Desktop's tested bound, the card's place holds one line, the notice: the why, then the held-back core,
// naming the exact CLI version as the Desktop to install; below it that version's GitHub Release; then Choose
// oats…, Retry and the docs link, and no install command (it would downgrade the CLI). A refused operation
// carries the same sentence. In the style of cli-degradation.test.mjs: the renderer's cli-status.mjs over the
// /api/cli answer, in a JSDOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const cs = await import("../renderer/views/cli-status.mjs");

// The notice as decided on #1879, spelled here independently of the builder (packages/client/above-tested-notice.mjs).
const NOTICE = (testedThrough, version) => `This Desktop was tested with oats CLIs up to ${testedThrough}; the installed CLI is ${version}. `
  + `Stop, Remove, schedules, triggers and every other change except Spawn, Start, Restart, colour and background are off until you install OATS Desktop ${version}.`;
const accepted = (version, extra = {}) => ({ ok: true, bin: "/new/oats", version, source: "path", required: { desktopApi: 1, range: ">=0.26.0, tested through 0.69" },
  install: "npm install -g @awebai/oats@0.69.17", probedAt: 1, tried: [], features: [], ...extra });
const above = (version, testedThrough = "0.69") => accepted(version, { aboveTested: true, testedThrough });
const words = (node) => node.textContent.replace(/\s+/g, " ").trim();

async function notice(payload) {
  const doc = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" }).window.document;
  const opened = [];
  const ctx = { api: async () => payload, chooseCliBinary: async () => null, openExternal: (url) => opened.push(url) };
  await cs.refreshCli(ctx);
  const mounted = cs.aboveTestedCard(doc, ctx);
  doc.body.append(mounted.el);
  return { el: mounted.el, opened, dispose() { mounted.dispose(); cs.resetCliStateForTests(); } };
}

for (const [version, testedThrough] of [["0.70.2", "0.69"], ["1.4.2", "0.69"], ["0.72.0", "0.71"]]) {
  test(`acceptance (notice): a CLI ${version} above a Desktop tested through ${testedThrough} shows one line, the why and then the core, naming the Desktop ${version} to install`, async () => {
    const { el, dispose } = await notice(above(version, testedThrough));
    try {
      assert.equal(el.hidden, false);
      const lines = el.querySelectorAll(".cli-notice");
      assert.equal(lines.length, 1, "one line");
      assert.equal(words(lines[0]), NOTICE(testedThrough, version));
      assert.equal(lines[0].querySelector("br"), null);
      assert.ok(!lines[0].textContent.trim().includes("\n"), "no line break inside it");
      assert.equal(lines[0].getAttribute("role"), "status");
      assert.ok(words(lines[0]).endsWith(`until you install OATS Desktop ${version}.`), "the exact CLI version is the Desktop to install");
    } finally { dispose(); }
  });
}

test("acceptance (notice): below the line, the release of that version; Choose oats…, Retry and the docs link stay; no install command and no Copy", async () => {
  const { el, opened, dispose } = await notice(above("0.70.2"));
  try {
    const release = el.querySelector(".cli-release");
    assert.equal(release.textContent, "https://github.com/oats-project/oats/releases/tag/v0.70.2");
    release.click();
    assert.deepEqual(opened, ["https://github.com/oats-project/oats/releases/tag/v0.70.2"]);
    assert.equal(el.querySelector(".cli-cmd"), null);
    assert.equal(el.querySelector(".cli-copy"), null);
    assert.equal(el.querySelector(".cli-install"), null);
    assert.ok(!el.textContent.includes("npm install"), "no install command anywhere on the notice");
    const order = [...el.querySelectorAll("button:not([disabled]), a[href], [tabindex]")].map((n) => n.className);
    assert.deepEqual(order, ["cli-release", "act cli-choose", "act cli-retry", "cli-docs"]);
  } finally { dispose(); }
});

test("acceptance (notice): a refused operation carries the same sentence", async () => {
  const { el, dispose } = await notice(above("0.70.2"));
  try {
    for (const operation of ["POST /api/schedules", "POST /api/instance-lifecycle plan", "POST /api/workspace-sync sync", "an operation no table names"]) {
      assert.equal(cs.cliHeldBack(operation), NOTICE("0.69", "0.70.2"), operation);
    }
    for (const operation of ["POST /api/start", "POST /api/spawn apply", "POST /api/instance-color"]) assert.equal(cs.cliHeldBack(operation), null, operation);
    assert.equal(words(el.querySelector(".cli-notice")), NOTICE("0.69", "0.70.2"));
  } finally { dispose(); }
});

test("acceptance (notice): within the bound, or with no accepted CLI, there is no notice and nothing is held back", async () => {
  for (const payload of [accepted("0.69.25"), accepted("0.60.0"), { ...accepted(null), ok: false, bin: null, source: null }, accepted("0.70.2", { aboveTested: false, testedThrough: "0.69" })]) {
    const { el, dispose } = await notice(payload);
    try {
      assert.equal(el.hidden, true, JSON.stringify(payload));
      assert.equal(el.textContent.trim(), "");
      assert.equal(cs.cliHeldBack("POST /api/schedules"), null);
    } finally { dispose(); }
  }
});

test("acceptance (notice): the notice follows the CLI, appearing and going on a reprobe", async () => {
  const doc = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" }).window.document;
  let answer = accepted("0.69.25");
  const ctx = { api: async () => answer, openExternal() {} };
  await cs.refreshCli(ctx);
  const mounted = cs.aboveTestedCard(doc, ctx);
  try {
    assert.equal(mounted.el.hidden, true);
    answer = above("0.70.2");
    await cs.refreshCli(ctx);
    assert.equal(mounted.el.hidden, false);
    assert.equal(words(mounted.el.querySelector(".cli-notice")), NOTICE("0.69", "0.70.2"));
    answer = accepted("0.69.25");
    await cs.refreshCli(ctx);
    assert.equal(mounted.el.hidden, true);
  } finally { mounted.dispose(); cs.resetCliStateForTests(); }
});

test("acceptance (notice): the card's older-Desktop branch is for a newer desktop API only; an accepted CLI above the bound gets no card", async () => {
  const doc = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://127.0.0.1/" }).window.document;
  const ctx = { api: async () => above("0.70.2"), openExternal() {} };
  await cs.refreshCli(ctx);
  try {
    assert.equal(cs.cliKnownUnavailable(), false, "an accepted CLI is never carded");
    assert.equal(cs.cliAvailable(), true);
    const card = cs.cliCard(doc, ctx);
    assert.doesNotMatch(card.el.textContent, /older than the installed/);
    card.dispose();
  } finally { cs.resetCliStateForTests(); }
});
