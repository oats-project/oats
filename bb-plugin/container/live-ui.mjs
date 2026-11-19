#!/usr/bin/env node
// The app's live checks (A13, A14), run by container/live.sh inside the container once bb-app
// runs, the plugin is installed from the checkout and the fake `oats` prints the fixtures.
//   A13 at 1280x800 and 390x800: the sidebar with the tree, an agent's thread with its header
//       row, the home page (its badge shows 3), and each of the four pages render.
//   A14 with the fake oats removed: bb's threads are listed, the "not found" line shows, and a
//       thread opens.
// Screenshots go to $OUT (kept as CI artefacts). No dependency: it drives the image's Chromium
// over the DevTools protocol with node's own WebSocket.
//
// The fixtures name threads bb does not have (`thr_release`, …). So that the join is real, this
// script makes one bb thread per fixture thread, by title, and has the fake print status.json
// with those threads' real ids: the same rows, joined by the ids bb gave.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT ?? join(homedir(), "out");
const BASE = process.env.BB_URL ?? "http://127.0.0.1:38886";
const CHROMIUM = process.env.CHROMIUM ?? "chromium";
const OATS = join(homedir(), ".local/bin/oats");
const FAKE_CONFIG = join(homedir(), ".local/bin/fake-oats.json");
const FAKE_LOG = join(homedir(), "fake-oats.log");
const VIEWPORTS = [
  { name: "1280x800", width: 1280, height: 800, mobile: false },
  { name: "390x800", width: 390, height: 800, mobile: true },
];
mkdirSync(OUT, { recursive: true });

let failures = 0;
const pass = (what) => console.log(`PASS ${what}`);
const fail = (what, detail = "") => {
  failures += 1;
  console.log(`FAIL ${what}${detail === "" ? "" : `\n     ${String(detail).slice(0, 600)}`}`);
};
const check = (ok, what, detail) => (ok ? pass(what) : fail(what, detail));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- bb and the fake oats

const bb = (...args) => execFileSync("bb", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const bbJson = (...args) => JSON.parse(bb(...args, "--json"));
const listOf = (answer, key) => (Array.isArray(answer) ? answer : (answer[key] ?? answer.items ?? []));
function rpc(method) {
  const input = join(OUT, "ui-input.json");
  writeFileSync(input, "null");
  const answer = bbJson("plugin", "rpc", "call", "oats", method, "--input-file", input);
  return answer.result ?? answer;
}
const fake = (verbs = {}) =>
  writeFileSync(FAKE_CONFIG, JSON.stringify({ fixtures: join(PLUGIN, "test/fixtures"), log: FAKE_LOG, verbs }));

const fixtureThreads = JSON.parse(readFileSync(join(PLUGIN, "test/fixtures/threads.json"), "utf8")).threads;
const fixtureStatus = JSON.parse(readFileSync(join(PLUGIN, "test/fixtures/status.json"), "utf8"));

/** One bb thread per fixture thread, found or made by its title: fixture thread id -> bb's thread. */
function threadsByFixtureId() {
  const project = listOf(bbJson("project", "list"), "projects")[0];
  if (project === undefined) throw new Error("live-ui: bb has no project (live.sh makes one)");
  const root = (project.sources ?? []).find((source) => source.path)?.path;
  const list = () => listOf(bbJson("thread", "list"), "threads");
  let existing = list();
  for (const wanted of fixtureThreads) {
    if (existing.some((thread) => thread.title === wanted.title)) continue;
    // No provider is installed in the container: the thread exists and ends in bb's "error"
    // status, which is all the join and the slots need.
    bb("thread", "spawn", "--project", project.id, "--environment", root, "--provider", "pi", "--model", "mock/echo", "--title", wanted.title, "--prompt", "hello", "--json");
  }
  existing = list();
  const byId = new Map();
  for (const wanted of fixtureThreads) {
    const thread = existing.find((candidate) => candidate.title === wanted.title);
    if (thread === undefined) throw new Error(`live-ui: bb did not keep a thread titled "${wanted.title}"`);
    byId.set(wanted.id, thread);
  }
  return byId;
}

/** status.json as the fake prints it for this run: the same rows, with the bb threads' real ids. */
function statusWithRealIds(threads) {
  const status = structuredClone(fixtureStatus);
  for (const group of status.agents) {
    for (const row of group.instances) {
      const real = row.session ? threads.get(row.session.threadId) : undefined;
      if (real !== undefined) row.session.threadId = real.id;
    }
  }
  return JSON.stringify(status);
}

async function untilSnapshot(matches, seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    try {
      rpc("refresh");
      last = rpc("snapshot");
      if (matches(last)) return last;
    } catch (error) {
      last = { error: String(error) };
    }
    await sleep(1500);
  }
  throw new Error(`live-ui: the snapshot did not settle: ${JSON.stringify(last).slice(0, 400)}`);
}

// ---- a small DevTools-protocol driver

async function launchBrowser() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const child = spawn(
    CHROMIUM,
    ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${join(OUT, ".chromium")}`, "about:blank"],
    { stdio: "ignore" },
  );
  let version;
  for (let attempt = 0; attempt < 100 && version === undefined; attempt++) {
    await sleep(200);
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      // not listening yet
    }
  }
  if (version === undefined) throw new Error(`live-ui: ${CHROMIUM} did not open its debugging port`);
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("live-ui: no DevTools connection")), { once: true });
  });
  let nextId = 0;
  const waiting = new Map();
  const errors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const entry = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) entry?.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry?.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? "exception");
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject, method });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  /** A page in a browser context of its own, at one viewport. */
  async function page(viewport) {
    const { browserContextId } = await send("Target.createBrowserContext");
    const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const cdp = (method, params) => send(method, params, sessionId);
    await cdp("Page.enable");
    await cdp("Runtime.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
    if (viewport.mobile) await cdp("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    };
    const until = async (expression, seconds = 30) => {
      const deadline = Date.now() + seconds * 1000;
      for (;;) {
        let value;
        try {
          value = await evaluate(expression);
        } catch {
          value = undefined; // the page is navigating
        }
        if (value) return value;
        if (Date.now() > deadline) return undefined;
        await sleep(250);
      }
    };
    return {
      evaluate,
      until,
      goto: async (path) => {
        await cdp("Page.navigate", { url: BASE + path });
        await until("document.readyState === 'complete'", 30);
      },
      shot: async (name) => {
        const { data } = await cdp("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
        console.log(`     screenshot ${name}.png`);
      },
      close: () => send("Target.disposeBrowserContext", { browserContextId }),
    };
  }
  return {
    page,
    errors,
    close: async () => {
      socket.close();
      child.kill("SIGTERM");
    },
  };
}

// ---- what the page is asked

const visible = (selector) =>
  `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth; })()`;
const testId = (id) => `[data-testid="${id}"]`;
const texts = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.innerText.replace(/\\s+/g, " ").trim())`;
const textOf = (selector) => `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "").replace(/\\s+/g, " ").trim()`;

/** At phone width the thread list is in bb's drawer: open it with bb's own toggle. */
async function showSidebar(page, viewport) {
  if (await page.until(visible(testId("oats-sidebar")), viewport.mobile ? 4 : 30)) return true;
  if (!viewport.mobile) return false;
  await page.evaluate(
    `(() => { const b = [...document.querySelectorAll("button")].find((b) => /sidebar|menu|navigation/i.test(b.getAttribute("aria-label") ?? "") && b.getBoundingClientRect().width > 0); b?.click(); return b?.getAttribute("aria-label") ?? null; })()`,
  );
  return Boolean(await page.until(visible(testId("oats-sidebar")), 15));
}

async function a13(browser, viewport, threads) {
  const at = `A13 ${viewport.name}`;
  const page = await browser.page(viewport);
  try {
    // the sidebar with the tree
    await page.goto("/");
    check(await showSidebar(page, viewport), `${at} the thread list is the OATS sidebar`);
    await page.until(visible(testId("oats-tree")), 30);
    const rows = await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(testId("oats-agent-row"))})].map((e) => e.getAttribute("data-sidebar-thread-id"))`);
    const expected = fixtureThreads.filter((thread) => thread.id !== "thr_plain").map((thread) => threads.get(thread.id).id);
    check(rows.length === 7 && expected.every((id) => rows.includes(id)), `${at} the tree draws the 7 bb agents, joined by bb's own thread ids`, JSON.stringify(rows));
    const child = `${testId("oats-agent-row")}[data-sidebar-thread-id="${threads.get("thr_mockups").id}"]`;
    check(await page.evaluate(`document.querySelector(${JSON.stringify(child)})?.className.includes("pl-6") === true`), `${at} a child is indented under its parent`);
    check((await page.evaluate(textOf(testId("oats-workspace-line")))).includes("8 agents"), `${at} the workspace line`, await page.evaluate(textOf(testId("oats-workspace-line"))));
    check((await page.evaluate(textOf(testId("oats-needs-line")))) === "3 need you", `${at} "3 need you"`, await page.evaluate(textOf(testId("oats-needs-line"))));
    const others = await page.evaluate(texts(testId("oats-other-row")));
    check(others.some((text) => text.includes("Plain bb thread")), `${at} the thread that is no agent is under Other threads`, JSON.stringify(others));
    await page.shot(`a13-${viewport.name}-sidebar`);

    // the home's badge, in bb's navigation (the rail on desktop, the drawer on a phone)
    const badge = await page.until(
      `[...document.querySelectorAll("[aria-label], [title]")].some((e) => /3 agents need you/.test((e.getAttribute("aria-label") ?? "") + (e.getAttribute("title") ?? "")))`,
      15,
    );
    check(Boolean(badge), `${at} the home's navigation entry carries the badge "3 agents need you"`);

    // an agent's thread with its header row
    const mockups = threads.get("thr_mockups");
    await page.goto(`/projects/${mockups.projectId}/threads/${mockups.id}`);
    check(Boolean(await page.until(visible(testId("oats-identity-row")), 30)), `${at} an agent's thread shows the identity row`);
    const chips = await page.evaluate(textOf(testId("oats-identity-row")));
    check(
      ["oats-desktop-developer", "desktop-mockups-developer", "✓ desktop-mockups-developer", "parent · redesign-ui-lead", "home · …/instances/desktop-mockups-developer", "OATS"].every((chip) => chips.includes(chip)),
      `${at} the row's chips: soul, instance, alias, parent, home, OATS`,
      chips,
    );
    const rowHeight = await page.evaluate(`document.querySelector(${JSON.stringify(testId("oats-identity-row"))}).getBoundingClientRect().height`);
    check(rowHeight < 50, `${at} the row is one line (${Math.round(rowHeight)} px)`);
    await page.shot(`a13-${viewport.name}-thread`);

    // a thread that is no agent has no row
    const plain = threads.get("thr_plain");
    await page.goto(`/projects/${plain.projectId}/threads/${plain.id}`);
    await sleep(3000);
    check(!(await page.evaluate(visible(testId("oats-identity-row")))), `${at} a thread that is no agent has no identity row`);

    // the home page
    await page.goto("/plugins/oats/home");
    check(Boolean(await page.until(visible(testId("oats-needs-card")), 30)), `${at} the home page renders`);
    const sections = await page.evaluate(`["needs", "working", "finished"].map((s) => document.querySelector('[data-testid="oats-home-' + s + '"] h2')?.innerText.replace(/\\s+/g, " ").trim())`);
    check(/^needs you 3$/i.test(sections[0] ?? "") && /^working 2$/i.test(sections[1] ?? ""), `${at} the home's counts: Needs you 3, Working 2`, JSON.stringify(sections));
    await page.shot(`a13-${viewport.name}-home`);

    // the four pages
    const pages = [
      ["souls", "oats-soul-row", "Souls"],
      ["capabilities", "oats-capability-row", "Capabilities"],
      ["teams", "oats-team-row", "Teams"],
      ["machines", "oats-machine-row", "Machines"],
    ];
    for (const [path, row, title] of pages) {
      await page.goto(`/plugins/oats/${path}`);
      const drawn = await page.until(visible(testId(row)), 30);
      const n = await page.evaluate(`document.querySelectorAll(${JSON.stringify(testId(row))}).length`);
      check(Boolean(drawn) && n > 0, `${at} ${title} renders (${n} rows)`);
      await page.shot(`a13-${viewport.name}-${path}`);
    }
    // a soul's own page: at phone width the detail replaces the list
    await page.goto("/plugins/oats/souls/oats-developer");
    check(Boolean(await page.until(visible(testId("oats-soul-detail")), 30)), `${at} a soul's page renders, with the spawn form`, await page.evaluate(textOf(testId("oats-souls-page"))));
    check((await page.evaluate(visible(testId("oats-soul-row")))) === !viewport.mobile, `${at} ${viewport.mobile ? "the list gives way to the soul, with Back" : "the list stays beside the soul"}`);
    await page.shot(`a13-${viewport.name}-soul`);
  } finally {
    await page.close();
  }
}

async function a14(browser, viewport, threads) {
  const at = `A14 ${viewport.name}`;
  const page = await browser.page(viewport);
  try {
    await page.goto("/");
    check(await showSidebar(page, viewport), `${at} the thread list is still drawn`);
    const line = await page.until(`(() => { const t = ${textOf(testId("oats-status-line"))}; return /not found/i.test(t) ? t : ""; })()`, 30);
    check(Boolean(line), `${at} the "not found" line shows: ${line ?? ""}`, await page.evaluate(textOf(testId("oats-sidebar"))));
    const listed = await page.evaluate(`[...document.querySelectorAll(${JSON.stringify(testId("oats-other-row"))})].map((e) => e.getAttribute("data-sidebar-thread-id"))`);
    check([...threads.values()].every((thread) => listed.includes(thread.id)), `${at} bb's threads are all listed (${listed.length})`, JSON.stringify(listed));
    check(!(await page.evaluate(visible(testId("oats-tree")))), `${at} no tree is drawn from a stale answer`);
    await page.shot(`a14-${viewport.name}-sidebar`);

    const target = threads.get("thr_redesign");
    await page.evaluate(`document.querySelector('${testId("oats-other-row")}[data-sidebar-thread-id="${target.id}"]').click()`);
    const opened = await page.until(`location.pathname.endsWith("/threads/${target.id}")`, 15);
    check(Boolean(opened), `${at} a thread opens from the list`, await page.evaluate("location.pathname"));
    await sleep(2500);
    check(!(await page.evaluate(visible(testId("oats-identity-row")))), `${at} the open thread has no OATS row while OATS cannot be read`);
    await page.shot(`a14-${viewport.name}-thread`);
  } finally {
    await page.close();
  }
}

// ---- the run

const threads = threadsByFixtureId();
fake({ status: { stdout: statusWithRealIds(threads) } });
await untilSnapshot((snapshot) => snapshot.ok === true && snapshot.agents.some((agent) => agent.threadId === threads.get("thr_release").id));

const browser = await launchBrowser();
try {
  for (const viewport of VIEWPORTS) await a13(browser, viewport, threads);

  // A14: the fake oats is removed for the length of the check, then put back.
  renameSync(OATS, `${OATS}.away`);
  try {
    await untilSnapshot((snapshot) => snapshot.ok === false && snapshot.code === "OATS_NOT_FOUND");
    for (const viewport of VIEWPORTS) await a14(browser, viewport, threads);
  } finally {
    if (existsSync(`${OATS}.away`)) renameSync(`${OATS}.away`, OATS);
  }
  check(browser.errors.length === 0, "no uncaught exception in the page", browser.errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
  fake(); // the fixtures as they are, for the checks that follow in live.sh
  try {
    rpc("refresh");
  } catch {
    // the next check reads for itself
  }
}

if (failures > 0) {
  console.log(`live-ui: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("live-ui: all checks passed");
