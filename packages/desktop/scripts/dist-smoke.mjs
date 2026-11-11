#!/usr/bin/env node
// OATS Desktop — installed-artifact smoke (CI: `npm run dist:smoke`).
//
// Proves the PACKAGED app (not the source tree) is runnable on this
// platform/arch:
//   1. inventory: dist/ contains exactly the expected oats-desktop-*
//      distributables for this platform (DMG+ZIP on mac, AppImage+DEB on
//      linux) and they are non-trivially sized; and the packaged shared
//      home (client/, beside app.asar) holds exactly the module files the
//      repository's packages/client has;
//   2. (macOS, unconditional) the packaged .app bundle passes strict deep
//      code-signature verification — a complete ad-hoc bundle signature;
//      rejects the v0.18.2 partial/absent-signature class;
//   2. (Linux, unconditional) every ELF file the DEB and the AppImage carry
//      (the AppImage's runtime and libraries, and ELF entries of app.asar,
//      included) needs no newer glibc, GLIBCXX or CXXABI than
//      scripts/linux-floor.json, the floor docs/desktop.md states;
//   3. node-pty (the native module) loads INSIDE the packaged app's
//      Electron ABI (ELECTRON_RUN_AS_NODE against the packaged
//      resources), catching ABI-mismatch and lost spawn-helper exec bits;
//   4. headless, as Node under the packaged executable: the bundled backend
//      (app.asar/server/oats-web.mjs) started through main's own spawn spec
//      answers GET /api/cli and exits when its stdin closes (#698's
//      lifeline), and the liveness collector (client/liveness-main.mjs,
//      beside app.asar) answers [] to [] — their whole import graphs, from
//      the asar and the shared home (packages/client, which the builder
//      places beside the asar as client/). Then (4b) every module main
//      imports, loaded from where main names it. No GUI, and on Linux not
//      the AppImage's launcher or runtime;
//   5. the packaged app bundle launches and its renderer reaches the shell
//      (CDP probe), which also proves main spawned the bundled server and it
//      answered — i.e. no source-checkout dependency. Linux also launches the
//      AppImage with real CLI-created running and stopped rows, first and then
//      into each running app: running rows open a terminal without keyboard
//      focus or input, stopped rows only select, and viewers are reaped.
//
// CI runs phases 1–4 on every installer leg: both installer workflows
// (build-installers.yml and release.yml's desktop-build) set
// OATS_SMOKE_SKIP_LAUNCH=1 with OATS_SMOKE_BUILD_VERIFY=1, which skips phase 5
// (it needs a display). Phase 5 runs only on a run without
// OATS_SMOKE_SKIP_LAUNCH, where a display is available: both workflows run the
// smoke a second time that way on the Linux leg, under xvfb-run. No macOS leg
// runs it (the workflows say why).
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLaunchFixtureSource } from "../test/helpers/launch-fixture.mjs";
import { createReaper } from "./proc-reaper.mjs";
import { runAbiProbe, runBackendProbe, runMainImportsProbe, sharedHomeInventory } from "./smoke-probes.mjs";
import { verifyAppSignature } from "./codesign-verify.mjs";
import { checkLinuxFloor } from "./linux-floor.mjs";
import { WATCHDOG_MS, PHASE_BUDGET_MS, boundedTail, readDevToolsPort, awaitClose } from "./launch-probe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const DIST = join(PKG, "dist");
const fail = (msg) => { console.error(`dist:smoke FAIL — ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`dist:smoke ok — ${msg}`);

// ---- leak-proofing (hard requirement after a local process-swarm incident) --
// The reaper (scripts/proc-reaper.mjs, unit-tested) owns the contract:
// detached process groups, GROUP RETENTION until explicit reaping (leader
// exit never drops a group — descendants can outlive it), async-only child
// execution (runTracked only; synchronous child execution is banned — it blocks
// signal handlers and the watchdog, and its timeout kills only the
// immediate PID). reapAll is installed on EVERY exit path — fail() calls
// process.exit() which skips finally-blocks — plus a wall-clock watchdog.
const reaper = createReaper({ spawn });
const { spawnTracked, reapGroup, reapAll, runTracked } = reaper;
process.on("exit", reapAll);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { reapAll(); process.exit(1); });
process.on("uncaughtException", (e) => { console.error(`dist:smoke FAIL — uncaught: ${e.message}`); reapAll(); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(`dist:smoke FAIL — unhandled: ${e?.message || e}`); reapAll(); process.exit(1); });
const watchdog = setTimeout(() => { console.error(`dist:smoke FAIL — watchdog: exceeded ${WATCHDOG_MS / 1000}s (derived from phase budgets)`); reapAll(); process.exit(1); }, WATCHDOG_MS);
watchdog.unref?.();

// ---- 1. artifact inventory -------------------------------------------------
if (!existsSync(DIST)) fail(`no dist/ — run npm run dist first`);
const files = readdirSync(DIST).filter((f) => f.startsWith("oats-desktop-"));
const need = process.platform === "darwin" ? ["dmg", "zip"] : ["AppImage", "deb"];
const artifacts = {};
for (const ext of need) {
  const hit = files.find((f) => f.endsWith(`.${ext}`));
  if (!hit) fail(`missing .${ext} in dist/ (have: ${files.join(", ") || "none"})`);
  artifacts[ext] = join(DIST, hit);
  const size = statSync(join(DIST, hit)).size;
  if (size < 50 * 1024 * 1024 * 0.5) fail(`${hit} is implausibly small (${size} bytes)`);
  ok(`${hit} present (${(size / 1024 / 1024).toFixed(0)} MB)`);
}

// ---- locate the unpacked packaged app ---------------------------------------
// electron-builder leaves the unpacked build in dist/<platform>-unpacked (or
// mac{,-arm64}/): smoke against THAT — it is byte-identical app content to
// the installers without needing a mount/install step in CI.
function unpackedAppPath() {
  if (process.platform === "darwin") {
    for (const d of readdirSync(DIST)) {
      const app = join(DIST, d, "OATS Desktop.app");
      if (d.startsWith("mac") && existsSync(app)) {
        return { app, exe: join(app, "Contents", "MacOS", "OATS Desktop"), resources: join(app, "Contents", "Resources") };
      }
    }
  } else {
    const d = join(DIST, "linux-unpacked");
    if (existsSync(d)) return { exe: join(d, "oats-desktop"), resources: join(d, "resources") };
  }
  return null;
}
const app = unpackedAppPath();
if (!app) fail("no unpacked app found in dist/");
if (!existsSync(app.exe)) fail(`packaged executable missing: ${app.exe}`);

// ---- 1 (continued). the shared home, beside app.asar ------------------------
// The app imports packages/client by a relative path, and the builder places
// that directory beside app.asar as client/ (electron-builder.config.cjs:
// extraResources). A module the package lacks is a module the app cannot
// load; a file the repository's directory does not have is not ours.
{
  const r = sharedHomeInventory(join(app.resources, "client"), join(PKG, "..", "client"), { readdirSync, existsSync });
  if (!r.ok) fail(r.detail);
  ok(r.detail);
}

// ---- 2. macOS bundle signature: strict deep codesign (MANDATORY on darwin) --
// The packaged .app must carry a COMPLETE valid ad-hoc bundle signature —
// every nested helper/framework signed, resources sealed. v0.18.2 shipped
// with only the linker-generated partial ad-hoc signature (arm64) / no
// signature (x64) and Gatekeeper reported the app as damaged. This phase
// runs UNCONDITIONALLY on darwin: no env flag (OATS_SMOKE_SKIP_LAUNCH,
// OATS_SMOKE_BUILD_VERIFY, or anything else) can skip it — the launch-skip
// guards below apply only to the GUI launch phase.
if (process.platform === "darwin") {
  const r = await verifyAppSignature(reaper, app.app, { existsSync });
  if (!r.ok) fail(r.detail);
  ok(r.detail);
}

// ---- 2. Linux: the glibc floor (MANDATORY on linux) --------------------------
// What the installers need of a system follows the system that built them: a
// native module built on a newer runner, or a newer node-pty or Electron, can
// raise it with nobody deciding it (#1050). docs/desktop.md states the floor
// and scripts/linux-floor.json holds the same value; this reads the version
// needs of every ELF file in the two shipped artifacts themselves (the
// AppImage carries its runtime and libraries beside the app directory) and
// fails on any above it, naming the file and the version. Like the codesign
// phase on darwin, no OATS_SMOKE_* flag skips it (scripts/linux-floor.mjs).
if (process.platform === "linux") {
  const r = await checkLinuxFloor(reaper, { deb: artifacts.deb, appImage: artifacts.AppImage }, { timeout: PHASE_BUDGET_MS.linuxFloor });
  for (const line of r.lines || []) ok(line);
  if (!r.ok) fail(r.detail);
  ok(r.detail);
}

// ---- 3. node-pty loads under the packaged Electron ABI ----------------------
// Load node-pty the way the APP does: createRequire from inside app.asar.
// Electron's fs reads the asar transparently and node-pty's own
// app.asar → app.asar.unpacked replacement finds the native module and the
// spawn-helper. (Loading from the unpacked path directly is WRONG: the
// replace() then produces app.asar.unpacked.unpacked and posix_spawnp
// fails with ENOENT — exactly the class of bug this smoke exists to catch.)
{
  const unpacked = join(app.resources, "app.asar.unpacked", "node_modules", "node-pty");
  if (!existsSync(unpacked)) fail("node-pty not asar-unpacked in the package");
  // spawn-helper must be executable (lesson: npm can drop the exec bit)
  const helpers = [];
  const collect = (d) => { if (existsSync(d)) for (const e of readdirSync(d)) { const h = join(d, e, "spawn-helper"); if (existsSync(h)) helpers.push(h); } };
  collect(join(unpacked, "prebuilds"));
  const buildHelper = join(unpacked, "build", "Release", "spawn-helper");
  if (existsSync(buildHelper)) helpers.push(buildHelper);
  for (const h of helpers) {
    const mode = statSync(h).mode & 0o111;
    if (!mode) fail(`spawn-helper not executable in the package: ${h}`);
  }
  // Probe via the extracted runner (scripts/smoke-probes.mjs): the runner
  // CONTRACTUALLY requires the reaper's runTracked — async, detached,
  // group-tracked; reintroducing synchronous execution fails its tests.
  const r = await runAbiProbe(reaper, app.exe, join(app.resources, "app.asar", "main.mjs"), {
    timeout: PHASE_BUDGET_MS.abiProbe,
    targetArch: process.env.OATS_SMOKE_TARGET_ARCH || process.arch,
  });
  if (!r.ok) fail(r.detail);
  ok(r.detail);
}

// ---- 4. the backend and its collector, headless, from the package -----------
// The packaged executable runs as Node (ELECTRON_RUN_AS_NODE, through Rosetta
// on the macOS x64 cross-build, as phase 3) against the asar's server entries:
// the backend started exactly as main starts it (serverSpawnSpec), with no CLI
// discoverable, then its stdin closed as when main ends; then the collector the
// backend starts (oats-web.mjs: LIVENESS), which is in the shared home beside the
// asar, where the backend's own ../../client/ leads. The runner
// (scripts/smoke-probes.mjs) goes through the reaper only and reaps every
// process on every path.
{
  const server = join(app.resources, "app.asar", "server");
  const r = await runBackendProbe(reaper, app.exe, {
    bin: join(server, "oats-web.mjs"), collector: join(app.resources, "client", "liveness-main.mjs"),
    readyMs: PHASE_BUDGET_MS.backendReady, exitMs: PHASE_BUDGET_MS.backendExit, collectorMs: PHASE_BUDGET_MS.collector,
    targetArch: process.env.OATS_SMOKE_TARGET_ARCH || process.arch,
  });
  if (!r.ok) fail(r.detail);
  for (const line of r.lines) ok(line);
}

// ---- 4b. what main loads, from app.asar's top level -------------------------
// The backend and the collector above reach the shared home from
// app.asar/server (../../client/). Main reaches it from the asar's top level
// (../client/) and cannot run without a display, so every module it imports
// by a relative path is loaded as Node under the packaged executable, from
// where main names it, with the names main takes from it. The list is read
// from the packaged main.mjs. Only main.mjs's own body, which needs electron,
// is left to phase 5.
{
  const r = await runMainImportsProbe(reaper, app.exe, join(app.resources, "app.asar", "main.mjs"), {
    timeout: PHASE_BUDGET_MS.mainImports, targetArch: process.env.OATS_SMOKE_TARGET_ARCH || process.arch,
  });
  if (!r.ok) fail(r.detail);
  ok(r.detail);
}

// ---- 5. packaged app launches and the renderer reaches the shell ------------
// (CI runs this phase on the Linux leg only, in a second run of the smoke
// under xvfb-run: see the header. On operator machines skip it — the soul's
// no-GUI-launches policy; OATS_SMOKE_SKIP_LAUNCH=1 skips this.) The page
// imports the shared home from app.asar/renderer (../../client/), over file://
// under its CSP: a module graph with one file that does not load does not run
// at all, so `SHELL_OK` is also the proof that the window loads it.
if (process.env.OATS_SMOKE_SKIP_LAUNCH === "1") {
  // The guard (review ee04a44-r2) stops a RELEASE CI run from silently
  // degrading the smoke by skipping the launch. But the packaged GUI launch
  // is unreliable in CI (no interactive windowserver for an app without Developer ID trust on
  // mac runners → DevToolsActivePort never written), and the meaningful
  // installer evidence is BUILD + inventory + node-pty ABI + the headless
  // backend and collector (phase 4). A dedicated
  // build-verify CI (build-installers.yml) opts out explicitly with
  // OATS_SMOKE_BUILD_VERIFY=1; only an UNMARKED skip under GITHUB_ACTIONS is
  // rejected (the accidental-release-degradation case the guard exists for).
  if (process.env.GITHUB_ACTIONS === "true" && process.env.OATS_SMOKE_BUILD_VERIFY !== "1")
    fail("OATS_SMOKE_SKIP_LAUNCH must not be set in a release CI run — set OATS_SMOKE_BUILD_VERIFY=1 for the build-only installer workflow");
  ok("launch phase (5) skipped (OATS_SMOKE_SKIP_LAUNCH=1) — build + inventory + node-pty ABI + headless backend and collector + main's imports verified; the GUI launch needs a display and was not run");
} else {
  // Readiness probing (review ee04a44 + r2). The port is obtained race-free
  // and IDENTITY-BOUND: launch with --remote-debugging-port=0 and read the
  // DevToolsActivePort file Chromium writes into --user-data-dir — the port
  // is definitionally OUR child's, so no stale/foreign listener can be
  // mistaken for the app (no check-then-use free-port race). The backend
  // port is app-selected: main.mjs's ensureServer runs its own freePort
  // from OATS_DESKTOP_PORT, so a random start value cannot collide fatally.
  // stdio is captured (bounded rolling tail) and drained on 'close' before
  // any crash tail is reported; each startup has one bounded readiness wait.
  // The picker and AppImage use separate profiles; the repeated AppImage launch
  // deliberately uses the running app's profile.
  async function probeWindow({ instance = false } = {}) {
    const running = instance === "running";
    const root = mkdtempSync(join(tmpdir(), "oats-desktop-smoke-"));
    const userData = join(root, "profile");
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(OATS_|AWEB_)/.test(key) || ["TMUX", "TMUX_PANE", "WAYLAND_DISPLAY", "ELECTRON_RUN_AS_NODE", "APPIMAGE", "APPDIR"].includes(key)) delete env[key];
    }
    Object.assign(env, { HOME: join(root, "home"), OATS_HOME_DIR: join(root, "oats"),
      TMUX_TMPDIR: join(root, "tmux"), TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`, OATS_DESKTOP_PORT: String(10000 + Math.floor(Math.random() * 1500)) });
    for (const dir of [userData, env.HOME, env.OATS_HOME_DIR, env.TMUX_TMPDIR, env.TMPDIR]) mkdirSync(dir, { recursive: true });
    const deployment = join(root, "deployment");
    let tmuxServer = null, fixtureRow = null, inputReceipt = null, sourceBefore = null, launchError = null;
    const fixtureHome = join(deployment, "agents", "smoke", "instances", "smoke-probe");
    const tmuxArgs = () => fixtureRow?.tmux?.socket ? ["-u", "-S", fixtureRow.tmux.socket] : ["-u", "-L", "oats"];
    async function tmuxRead(args) {
      const result = await runTracked("tmux", [...tmuxArgs(), ...args], { env, timeout: 5000 });
      if (result.timedOut || result.code !== 0) throw new Error(`fixture tmux read failed: ${boundedTail(result.stderr, result.stdout)}`);
      return result.stdout.trimEnd();
    }
    function sourceTarget() {
      const endpoint = fixtureRow?.tmux;
      if (!endpoint || ![endpoint.session, endpoint.window].every(value => typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value))
        || typeof endpoint.socket !== "string" || !endpoint.socket.startsWith(env.TMUX_TMPDIR + "/")) throw new Error("fixture recorded an invalid or foreign tmux endpoint");
      return `=${endpoint.session}:=${endpoint.window}.0`;
    }
    async function sourceState() {
      const target = sourceTarget();
      return {
        identity: await tmuxRead(["display-message", "-p", "-t", target, "#{socket_path}|#{window_id}|#{pane_id}|#{pane_pid}"]),
        output: await tmuxRead(["capture-pane", "-p", "-J", "-t", target, "-S", "-"]),
        input: readFileSync(inputReceipt, "utf8"),
      };
    }
    async function unchangedSource(label) {
      if (!running) return;
      const after = await sourceState();
      console.log(`dist:smoke ${label} source: ${JSON.stringify(after)}`);
      if (JSON.stringify(after) !== JSON.stringify(sourceBefore)) throw new Error(`${label} changed the fixture pane or delivered input`);
    }
    try {
      if (instance) {
        // Real member and instance creation stay on the CLI path; only test source is authored by the helper.
        const fixtureDeadline = Date.now() + PHASE_BUDGET_MS.launchFixture;
        const fixtureTimeout = () => Math.max(1, fixtureDeadline - Date.now());
        const source = await createLaunchFixtureSource(root, { env, runTracked, timeout: fixtureTimeout });
        const { ref, bin } = source; inputReceipt = source.inputReceipt;
        env.PATH = `${bin}:${env.PATH}`;
        env.OATS_DESKTOP_OATS_BIN = join(PKG, "..", "..", "bin", "oats.mjs");
        const onboard = await runTracked(process.execPath, [env.OATS_DESKTOP_OATS_BIN, "onboard", deployment,
          "--workspace", ref, "--json"], { cwd: env.HOME, env, timeout: fixtureTimeout() });
        let admitted; try { admitted = JSON.parse(onboard.stdout); } catch { /* reported below */ }
        if (onboard.timedOut || onboard.code !== 0 || admitted?.ok !== true || admitted.result?.onboardApi !== 2
          || admitted.result?.dir !== deployment) throw new Error(`launch fixture onboard failed: ${boundedTail(onboard.stderr, onboard.stdout)}`);
        if (running) {
          // Foreground server ownership makes the reaper effective even on a setup error or watchdog.
          // -D also disables exit-empty; every client resolves this private TMUX_TMPDIR's oats socket.
          tmuxServer = spawnTracked("tmux", ["-D", "-L", "oats", "-f", "/dev/null"], { env, stdio: "ignore" });
          const readyBy = Math.min(fixtureDeadline, Date.now() + 5000);
          let ready = false;
          while (Date.now() < readyBy && !ready) {
            const check = await runTracked("tmux", ["-u", "-L", "oats", "list-sessions"], { env, timeout: 1000 });
            ready = !check.timedOut && (check.code === 0 || /no sessions/.test(check.stderr));
            if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!ready) throw new Error("private fixture tmux server did not become ready");
        }
        const spawn = await runTracked(process.execPath, [env.OATS_DESKTOP_OATS_BIN, "spawn", "smoke", "--dir", deployment,
          "--name", "smoke-probe", "--work", "directory", "--harness", "claude", "--launch-config", "none", "--model", "@native-default",
          ...(running ? [] : ["--no-launch"]), "--task", "Packaged launch terminal probe.", "--json"], { cwd: deployment, env, timeout: fixtureTimeout() });
        let created; try { created = JSON.parse(spawn.stdout); } catch { /* reported below */ }
        if (spawn.timedOut || spawn.code !== 0 || created?.ok !== true || created.result?.instance !== "smoke-probe"
          || created.result?.launched !== running) throw new Error(`launch fixture spawn failed: ${boundedTail(spawn.stderr, spawn.stdout)}`);
        for (const verb of [["status"], ["workspace", "status"]]) {
          let r;
          do {
            r = await runTracked(process.execPath, [env.OATS_DESKTOP_OATS_BIN, ...verb, "--dir", deployment, "--json"],
              { cwd: deployment, env, timeout: fixtureTimeout() });
            if (!running || verb.length !== 1 || r.timedOut || r.code !== 0) break;
            let rows; try { rows = JSON.parse(r.stdout).agents?.flatMap(agent => agent.instances ?? []); } catch { break; }
            if (rows?.find(row => row.instance === "smoke-probe")?.running === true) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          } while (Date.now() < fixtureDeadline);
          let answer; try { answer = JSON.parse(r.stdout); } catch { /* reported below */ }
          // status predates the envelope; workspace status uses the v1 result envelope.
          const workspace = answer?.ok === true ? answer.result : null;
          const rows = Array.isArray(answer?.agents) ? answer.agents.flatMap(agent => agent.instances ?? []) : [];
          const row = rows.find(row => row.instance === "smoke-probe");
          const valid = verb.length === 1
            ? answer?.workspace?.reachable === true && rows.length === 1 && row?.agent === "smoke"
              && row.home === join(deployment, "agents", "smoke", "instances", "smoke-probe")
              && row.launched === running && row.running === running
            : workspace?.workspaceStatusApi === 1 && workspace.workspace?.name === "smoke"
              && workspace.workspace?.local === join(deployment, "oats-local.yaml") && workspace.problems?.length === 0;
          if (r.timedOut || r.code !== 0 || !valid) throw new Error(`launch fixture CLI ${verb.join(" ")} failed: ${boundedTail(r.stderr, r.stdout)}`);
          if (row) fixtureRow = row;
        }
        if (running) {
          while ((!existsSync(inputReceipt) || !String(await tmuxRead(["capture-pane", "-p", "-J", "-t", sourceTarget(), "-S", "-"])).includes("OATS_SMOKE_READY")) && Date.now() < fixtureDeadline)
            await new Promise(resolve => setTimeout(resolve, 100));
          sourceBefore = await sourceState();
          if (!sourceBefore.output.includes("OATS_SMOKE_READY") || sourceBefore.input !== "") throw new Error("inert fixture harness was not ready without input");
          console.log(`dist:smoke source baseline: ${JSON.stringify(sourceBefore)}`);
        }
        ok(`real kernel fixture lists smoke-probe, ${running ? "running on its private tmux server" : "never launched and not running"}`);
        // CI need not provide FUSE. This still runs the shipped AppImage runtime and AppRun launcher.
        // The runtime caches both launches under the AppImage digest in TMPDIR. A secondary
        // runtime must not remove that tree when its handoff process exits: the primary still
        // loads from it. Our private TMPDIR is removed after both process groups have been reaped.
        env.NO_CLEANUP = "1";
        const runtime = await runTracked(artifacts.AppImage, ["--appimage-version"], { cwd: env.HOME, env, timeout: fixtureTimeout() });
        if (runtime.timedOut || runtime.code !== 0) throw new Error(`AppImage runtime version failed: ${runtime.stderr}`);
        ok(`AppImage runtime: ${String(runtime.stdout + runtime.stderr).trim()}`);
        // This runtime handles the extraction environment before --appimage-* arguments.
        env.APPIMAGE_EXTRACT_AND_RUN = "1";
      }
      const args = [`--remote-debugging-port=0`, `--user-data-dir=${userData}`,
        "--no-sandbox", "--disable-gpu", "--ozone-platform=x11", "--dir", instance ? deployment : userData];
      if (instance) args.push("--instance", "smoke-probe");
      // Slice G resource-containment baseline: capture the `oatsdesk-*` tmux
      // viewer count before launch and assert it is RESTORED after the app is
      // reaped — on BOTH the success and the forced-failure/timeout paths.
      // Proves the app's shutdown + orphan sweep leave no viewer residue.
      // (async count — the smoke bans synchronous child execution.)
      async function oatsdeskViewerCount() {
        const r = await runTracked("tmux", [...tmuxArgs(), "list-sessions", "-F", "#{session_name}"], { env, timeout: 5000 });
        if (r.timedOut || (running && r.code !== 0)) return null;
        return String(r.stdout).split("\n").filter((s) => s.startsWith("oatsdesk-")).length;
      }
      const viewerBaseline = await oatsdeskViewerCount(); // 0 when tmux is absent/no-server (ENOENT/nonzero → empty stdout → 0); null only on a tmux timeout
      if (running && viewerBaseline === null) throw new Error("fixture viewer baseline could not be read");
      const child = spawnTracked(instance ? artifacts.AppImage : app.exe, args,
        { cwd: env.HOME, stdio: ["ignore", "pipe", "pipe"], env });
      let childLog = "", childExit = null, startupLog = "", stdoutPending = "";
      child.stdout?.on("data", (d) => {
        childLog = boundedTail(childLog, d);
        stdoutPending += String(d);
        const lines = stdoutPending.split("\n"); stdoutPending = boundedTail("", lines.pop());
        for (const line of lines) if (line.startsWith("oats-desktop: launch --instance")) startupLog = boundedTail(startupLog, line + "\n");
      });
      child.stderr?.on("data", (d) => { childLog = boundedTail(childLog, d); });
      child.on("exit", (code, sig) => { childExit = { code, sig }; });
      // drainTail: return the current bounded output tail. Only wait for a
      // final flush when the child has ALREADY EXITED (a live child's tail is
      // already current, and awaiting its 'close' would block until the
      // watchdog — review 7bdaf1e-r2 finding 2). awaitClose is total-bounded
      // regardless, so even the exited path cannot hang.
      const drainTail = async () => { if (childExit !== null) await awaitClose(child, { drainMs: 2000 }); return childLog.slice(-1500); };
      try {
        // ONE shared launchReady deadline across the port wait AND the /json
        // poll (review 7bdaf1e-r2 finding 1: spending launchReady twice made
        // worst-case success 240s > the 180s watchdog — the premature-kill this
        // commit exists to prevent). /json answers ~immediately after
        // DevToolsActivePort is written, so sharing the budget is ample.
        const launchReadyMs = instance ? PHASE_BUDGET_MS.instanceLaunchReady : PHASE_BUDGET_MS.launchReady;
        const launchDeadline = Date.now() + launchReadyMs;
        const portRes = await readDevToolsPort(userData, { join, existsSync, readFileSync, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }, {
          timeoutMs: Math.max(0, launchDeadline - Date.now()), pollMs: 250, childExited: () => childExit !== null,
        });
        if (portRes.error) throw new Error(`${portRes.error} (app alive=${!childExit}); output tail:\n${await drainTail()}`);
        const port = portRes.port;
        let targets = null, lastDiag = 0;
        while (!targets && Date.now() < launchDeadline) {
          if (childExit) throw new Error(`packaged app exited during startup (code=${childExit.code} sig=${childExit.sig}); output tail:\n${await drainTail()}`);
          await new Promise((r) => setTimeout(r, 500));
          try {
            const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) });
            const list = await res.json();
            targets = list.find((t) => t.type === "page" && /index\.html/.test(t.url || ""));
          } catch { /* not up yet */ }
          if (!targets && Date.now() - lastDiag > 10_000) {
            lastDiag = Date.now();
            console.log(`dist:smoke … waiting for CDP (${Math.round((launchDeadline - Date.now()) / 1000)}s budget left; app alive=${!childExit})`);
          }
        }
        if (!targets) throw new Error(`packaged app never exposed its renderer over CDP within ${launchReadyMs / 1000}s (app alive=${!childExit}); output tail:\n${await drainTail()}`);
        // Evaluate in the page: the shell booted if the nav rail rendered.
        const ws = new WebSocket(targets.webSocketDebuggerUrl);
        const result = await new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error("CDP evaluate timeout")), instance ? PHASE_BUDGET_MS.instanceCdpEvaluate : PHASE_BUDGET_MS.cdpEvaluate);
          ws.onopen = () => ws.send(JSON.stringify({
            id: 1, method: "Runtime.evaluate",
            params: {
              expression: `new Promise((ok) => {
                const probe = () => {
                  const nav = document.querySelectorAll("#nav .nav-item").length;
                  if (nav > 0) ok("SHELL_OK nav=" + nav);
                  else setTimeout(probe, 500);
                }; probe();
                setTimeout(() => ok("SHELL_TIMEOUT html=" + document.body.innerHTML.slice(0, 200)), 15000);
              })`,
              awaitPromise: true, returnByValue: true,
            },
          }));
          ws.onmessage = (m) => {
            const d = JSON.parse(m.data);
            if (d.id === 1) { clearTimeout(to); resolve(d.result?.result?.value || ""); }
          };
          ws.onerror = (e) => { clearTimeout(to); reject(new Error(`CDP socket error`)); };
        });
        ws.close();
        if (!String(result).startsWith("SHELL_OK")) throw new Error(`renderer did not reach the shell: ${result}`);
        if (instance) {
          const expected = `oats-desktop: launch --instance smoke-probe: selecting it in ${deployment}`;
          // did-finish-load sends the request; allow its stdout pipe to drain after the shell appears.
          while (!startupLog && !childExit && Date.now() < launchDeadline) await new Promise((r) => setTimeout(r, 100));
          console.log(startupLog.trim() || "dist:smoke launch disposition missing");
          // Sample beyond the pending bound. Native key input is sent as soon as the running
          // terminal is visible, without a focus command; its raw-input harness must receive none.
          async function observeRenderer(label) {
            const socket = new WebSocket(targets.webSocketDebuggerUrl);
            const budget = label === "first" ? PHASE_BUDGET_MS.instanceObservation : PHASE_BUDGET_MS.repeatedObservation;
            const deadline = Date.now() + budget;
            const waiting = new Map(); let serial = 0;
            const command = (method, params) => new Promise((resolve, reject) => {
              const id = ++serial;
              const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP ${label} ${method} timeout`)); }, Math.max(1, deadline - Date.now()));
              waiting.set(id, { resolve, reject, timer });
              socket.send(JSON.stringify({ id, method, params }));
            });
            try {
              await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`CDP ${label} socket-open timeout`)), 5000);
                socket.onopen = () => { clearTimeout(timer); resolve(); };
                socket.onerror = () => { clearTimeout(timer); reject(new Error(`CDP ${label} socket error`)); };
              });
              socket.onerror = () => {
                for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error(`CDP ${label} socket error`)); }
                waiting.clear();
              };
              socket.onmessage = message => {
                const reply = JSON.parse(message.data), pending = waiting.get(reply.id);
                if (!pending) return;
                waiting.delete(reply.id); clearTimeout(pending.timer);
                if (reply.error || reply.result?.exceptionDetails) pending.reject(new Error(`CDP observation failed: ${JSON.stringify(reply)}`));
                else pending.resolve(reply.result?.result?.value);
              };
              if (running) {
                const ready = await command("Runtime.evaluate", { expression: `new Promise(resolve => {
                  const by = Date.now() + 35000;
                  function check() {
                    const active = document.querySelector('.tab-pane.active:not([hidden]) .term-wrap');
                    if (active && active.querySelector('textarea')) resolve({ ready: true, terminalFocused: !!document.activeElement?.closest?.('.term-wrap') });
                    else if (Date.now() >= by) resolve({ ready: false });
                    else setTimeout(check, 100);
                  } check();
                })`, awaitPromise: true, returnByValue: true });
                if (!ready?.ready || ready.terminalFocused) throw new Error(`${label} launch terminal was absent or took keyboard focus: ${JSON.stringify(ready)}`);
                const attachDeadline = Date.now() + 15000;
                let viewers;
                do {
                  viewers = await oatsdeskViewerCount();
                  if (viewers !== null && viewers > viewerBaseline) break;
                  await new Promise(resolve => setTimeout(resolve, 100));
                } while (Date.now() < attachDeadline);
                if (viewers !== viewerBaseline + 1) throw new Error(`${label} terminal must reuse exactly one viewer on the fixture socket (got ${viewers}, baseline ${viewerBaseline})`);
                await command("Input.dispatchKeyEvent", { type: "keyDown", key: "q", code: "KeyQ", windowsVirtualKeyCode: 81, text: "q" });
                await command("Input.dispatchKeyEvent", { type: "keyUp", key: "q", code: "KeyQ", windowsVirtualKeyCode: 81 });
              }
              const observation = await command("Runtime.evaluate", {
                expression: `new Promise(resolve => {
                  const samples = [], started = Date.now(); let previous = null;
                  function capture() {
                    const state = {
                      focusedRow: document.activeElement?.closest?.('.ctx-inst')?.dataset.treeInstance ?? null,
                      activeInstance: document.querySelector('.ctx-inst.active')?.dataset.treeInstance ?? null,
                      terminalFocused: !!document.activeElement?.closest?.('.term-wrap'),
                      terminalFocusesSinceFirst: window.__oatsSmokeTerminalFocuses ?? 0,
                      terminalTabs: [...document.querySelectorAll('.tab-trigger')].map(el => el.getAttribute('aria-label')),
                      activeTerminal: !!document.querySelector('.tab-pane.active:not([hidden]) .term-wrap'),
                      terminals: document.querySelectorAll('.term-wrap').length,
                      dialogs: [...document.querySelectorAll('[role="dialog"]')].filter(el => el.getClientRects().length).length,
                      mainNavigation: document.querySelector('#nav .nav-item.active')?.textContent?.trim() ?? null,
                      notices: [...document.querySelectorAll('.app-toast-text')].map(el => el.textContent),
                    };
                    const encoded = JSON.stringify(state);
                    if (encoded !== previous) { samples.push({ ms: Date.now() - started, ...state }); previous = encoded; }
                    if (Date.now() - started >= 35000) resolve({ samples, observedForMs: Date.now() - started });
                    else setTimeout(capture, 250);
                  } capture();
                })`, awaitPromise: true, returnByValue: true,
              });
              console.log(`dist:smoke renderer launch ${instance} ${label}: ${JSON.stringify(observation)}`);
              await unchangedSource(`${label} launch and unfocused key`);
              if (running && label === "first") {
                // A repeated launch must visibly reactivate the retained tab; leaving it active would let a no-op pass.
                // This synthetic navigation is setup, not operator input, and records even transient input focus.
                const between = await command("Runtime.evaluate", {
                  expression: `new Promise(resolve => {
                    window.__oatsSmokeTerminalFocuses = 0;
                    document.addEventListener('focusin', event => {
                      if (event.target?.closest?.('.term-wrap')) window.__oatsSmokeTerminalFocuses++;
                    }, true);
                    document.querySelector('#nav .nav-item[data-view="spawn"]')?.click();
                    setTimeout(() => resolve({
                      mainNavigation: document.querySelector('#nav .nav-item.active')?.textContent?.trim() ?? null,
                      activeTerminal: !!document.querySelector('.tab-pane.active:not([hidden]) .term-wrap'),
                      terminals: document.querySelectorAll('.term-wrap').length,
                    }), 0);
                  })`, awaitPromise: true, returnByValue: true,
                });
                console.log(`dist:smoke before repeated running launch: ${JSON.stringify(between)}`);
                if (between?.mainNavigation !== "Workspace overview" || between.activeTerminal || between.terminals !== 1)
                  throw new Error("could not leave the retained terminal before the repeated launch");
              }
              return observation;
            } finally {
              for (const { timer } of waiting.values()) clearTimeout(timer);
              socket.close();
            }
          }
          const first = await observeRenderer("first");
          const repeated = await runTracked(artifacts.AppImage, args, { cwd: env.HOME, env, timeout: PHASE_BUDGET_MS.repeatedLaunch });
          if (repeated.timedOut || repeated.code !== 0) throw new Error(`second AppImage launch failed: ${boundedTail(repeated.stderr, repeated.stdout)}`);
          const repeatedDeadline = Date.now() + 5000;
          while (startupLog.trim().split("\n").length < 2 && !childExit && Date.now() < repeatedDeadline)
            await new Promise(resolve => setTimeout(resolve, 100));
          const second = await observeRenderer("second");
          const extraction = readdirSync(env.TMPDIR).filter(name => name.startsWith("appimage_extracted_"));
          if (extraction.length !== 1 || !existsSync(join(env.TMPDIR, extraction[0], "AppRun")))
            throw new Error("AppImage extraction did not survive the repeated launch");
          ok("private AppImage extraction retained through the repeated launch");
          const lines = startupLog.trim().split("\n");
          console.log(`dist:smoke launch dispositions: ${JSON.stringify(lines)}`);
          if (lines.length !== 2 || lines.some(line => line !== expected)) throw new Error(`AppImage launch disposition: ${startupLog.trim() || "missing"}; output tail:\n${await drainTail()}`);
          const expectedRow = join(deployment, "agents", "smoke", "instances", "smoke-probe");
          for (const [label, observation] of [["first", first], ["second", second]]) {
            if (observation.samples.at(-1)?.focusedRow !== expectedRow) throw new Error(`${label} launch did not keep the fixture's roster row focused`);
            if (!observation.observedForMs || observation.observedForMs < 35000) throw new Error(`${label} observation ended before the pending bound`);
            if (observation.samples.some(sample => sample.terminalFocused || sample.terminalFocusesSinceFirst || sample.dialogs || sample.notices.length)) throw new Error(`${label} launch took terminal focus, showed a dialog or a notice`);
            if (running) {
              if (observation.samples.some(sample => sample.activeInstance !== expectedRow || !sample.activeTerminal || sample.terminals !== 1
                || sample.terminalTabs.length !== 1 || sample.terminalTabs[0] !== "smoke-probe" || sample.mainNavigation !== null))
                throw new Error(`${label} running launch did not show the exact fixture terminal in the main area`);
            } else if (observation.samples.some(sample => sample.mainNavigation !== "Workspace overview" || sample.terminals || sample.terminalTabs.length)) {
              throw new Error(`${label} stopped launch left Workspace overview or opened a tab`);
            }
          }
        }
        ok(`packaged ${instance ? "AppImage instance request" : "empty-dir picker"} launched; ${result}`);
      } catch (e) {
        launchError = e;
      } finally {
        // Let main's existing signal/quit path dispose its viewers before the mandatory group reaper.
        // SIGKILL alone leaves crashed-owner viewers for the next app's orphan sweep.
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already exited */ }
        await awaitClose(child, { drainMs: 5000 });
        reapGroup(child);
        await awaitClose(child);
        // Baseline restoration assertion — runs on success AND failure (the
        // catch above converted every launch failure to a caught error so this
        // finally always executes; no fail()/process.exit skips it).
        if (viewerBaseline !== null) {
          let restored = false;
          for (let i = 0; i < 10 && !restored; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const now = await oatsdeskViewerCount();
            if (now !== null && now <= viewerBaseline) restored = true;
          }
          if (!restored) {
            const error = new Error(`tmux viewer baseline not restored after ${launchError ? "forced failure" : "success"} (baseline ${viewerBaseline}, still elevated)`);
            console.error(`dist:smoke cleanup FAIL — ${error.message}`); // retain this diagnostic even if an earlier launch error wins
            throw error;
          }
          ok(`tmux viewer baseline restored (${viewerBaseline}) after ${launchError ? "forced failure" : "success"}`);
        }
      }
    } catch (error) {
      launchError ||= error;
    } finally {
      if (running && existsSync(join(fixtureHome, "instance.json"))) {
        try {
          const plan = await runTracked(process.execPath, [env.OATS_DESKTOP_OATS_BIN, "instance", "stop", "smoke-probe", "--home", fixtureHome,
            "--dir", deployment, "--plan", "--json"], { cwd: env.HOME, env, timeout: 10000 });
          const answer = JSON.parse(plan.stdout);
          if (plan.timedOut || plan.code !== 0 || !answer.ok || !answer.result?.planRevision) throw new Error("fixture stop plan failed");
          const stopped = await runTracked(process.execPath, [env.OATS_DESKTOP_OATS_BIN, "instance", "stop", "smoke-probe", "--home", fixtureHome,
            "--dir", deployment, "--apply", "--plan-revision", answer.result.planRevision, "--idempotency-key", "smoke-cleanup", "--json"],
          { cwd: env.HOME, env, timeout: 10000 });
          if (stopped.timedOut || stopped.code !== 0 || JSON.parse(stopped.stdout)?.result?.ok !== true) throw new Error("fixture stop apply failed");
        } catch (error) { launchError ||= error; }
      }
      if (tmuxServer) { reapGroup(tmuxServer); await awaitClose(tmuxServer); }
      rmSync(root, { recursive: true, force: true });
    }
    if (launchError) fail(launchError.message);
  }
  await probeWindow(); // preserve the empty-dir picker path
  if (process.platform === "linux") {
    await probeWindow({ instance: "stopped" });
    await probeWindow({ instance: "running" });
  }
}

reapAll();
clearTimeout(watchdog);
console.log("dist:smoke PASS");
