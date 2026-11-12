// Launch preferences (feature launch-preference, kernel main with #290): the kernel's own test helper
// (test/helpers/v2-deployment.mjs) builds a real deployment with every `from` layer:
//   dev      soul.yaml launch {claude, claude-opus-5-5}      -> from soul
//   reviewer soul.yaml launch {codex}, local souls.launch pi  -> from local
//   plain    no launch                                        -> from host
// Captures souls, inspect --soul, preview (and --harness, a flag), a spawn and inspect --home; then a
// changed local preference (readiness launch-changed, launchCurrent); then codex uninstalled
// (E_HARNESS_UNAVAILABLE as a report problem and as a preview refusal); then the reverse drift (a local
// preference removed: host, at null); then, in a second deployment of the same helper, default-team-changed
// (spawn, then `oats teams default` moves the deployment's default). PATH is hermetic: the
// helper's inert harness stubs + node + /usr/bin:/bin (no host harness leaks in).
//
// The committed capture is from the kernel at main 69d76a91 (`oats version` 0.29.4, the tree with #290, whose
// launch preferences shipped in 0.30). Every kernel text in it (a refusal's message, a problem's fix) is that
// kernel's wording. The fixtures are not refreshed when a later kernel rewords a text: to the Desktop a
// fixture's text is any text, and a test that passed only with today's words would be parsing them. The
// kernel's present answers are read live by the root tests (test/desktop-*-kernel.test.mjs).
// Usage: OUT=out-launch CAPTURE_COMMIT=<oid> node capture-launch.mjs <kernel-tree>
import { mkdirSync, writeFileSync, rmSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [REPO] = process.argv.slice(2);
if (!REPO?.startsWith("/")) throw new Error("kernel tree required");
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, process.env.OUT || "out-launch"); rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const { v2Deployment } = await import(pathToFileURL(join(REPO, "test/helpers/v2-deployment.mjs")).href);
const YAML = (await import(pathToFileURL(join(REPO, "node_modules/yaml/dist/index.js")).href)).default;
const commit = process.env.CAPTURE_COMMIT || "unknown";

const fx = v2Deployment({ name: "acme",
  souls: { dev: { soul: { launch: { harness: "claude", model: "claude-opus-5-5" } } }, reviewer: { soul: { launch: { harness: "codex" } } }, plain: {} },
  local: { souls: { launch: { reviewer: { harness: "pi" } } } } });
const stubs = join(fx.base, "runtime-stub");
const PATH = `${stubs}:${dirname(process.execPath)}:/usr/bin:/bin`;
const redact = s => (s || "").split(fx.base).join("<base>").split(REPO).join("<oats>");
const prov = [];
function run(name, args, { expect = 0 } = {}) {
  const r = fx.cli(args, { env: { PATH } });
  prov.push({ name, argv: ["oats", ...args].map(redact), exit: r.status, commit });
  const ok = expect === "any" || (expect === null ? r.status !== 0 : r.status === expect);
  console.log(`${ok ? "ok  " : "FAIL"} ${name} exit=${r.status}`);
  writeFileSync(join(OUT, `${name}.json`), redact(r.stdout));
  if (!ok) console.log(redact(r.stdout).slice(0, 1500), redact(r.stderr).slice(0, 600));
  return r;
}
const localFile = join(fx.dep, "oats-local.yaml");
const setLocalLaunch = launch => { const l = YAML.parse(readFileSync(localFile, "utf8")); l.souls = { ...(l.souls || {}), launch }; writeFileSync(localFile, YAML.stringify(l, { lineWidth: 0 })); };
try {
  const d = ["--dir", fx.dep, "--json"];
  run("version", ["version", "--json"]);
  run("sync", ["sync", "--json"]);
  run("souls", ["souls", ...d]);
  run("inspect-soul-dev", ["inspect", "--dir", fx.dep, "--soul", "dev", "--agents-root", fx.root, "--json"]);
  run("inspect-soul-reviewer", ["inspect", "--dir", fx.dep, "--soul", "reviewer", "--agents-root", fx.root, "--json"]);
  const spawn = extra => ["spawn", "dev", "--dir", fx.dep, "--agents-root", fx.root, "--purpose", "q", ...extra];
  const preview = run("preview-dev", [...spawn([]), "--preview", "--json"]);
  run("preview-dev-flag", [...spawn(["--harness", "pi"]), "--preview", "--json"]);
  const decision = JSON.parse(preview.stdout).result.decision.revision;
  const applied = run("apply-dev", [...spawn(["--expect-decision", decision, "--idempotency-key", "c".repeat(64), "--no-launch"]), "--json"]);
  const home = JSON.parse(applied.stdout).result.home;
  run("inspect-home", ["inspect", "--home", home, "--json"]);
  // The machine now prefers codex for dev: the home's recorded claude launch drifts.
  setLocalLaunch({ reviewer: { harness: "pi" }, dev: { harness: "codex" } });
  run("inspect-home-drift", ["inspect", "--home", home, "--json"]);
  run("readiness-home-drift", ["readiness", "--home", home, "--soul", "dev", "--agents-root", fx.root, "--policy", "--json"], { expect: "any" });
  run("status", ["status", "--dir", fx.dep, "--json"]);
  // codex is uninstalled on this machine: a report lists the problem; a preview refuses.
  unlinkSync(join(stubs, "codex"));
  run("souls-unavailable", ["souls", ...d]);
  run("preview-dev-unavailable", [...spawn([]), "--preview", "--json"], { expect: null });
  // The reverse drift (#292): a home spawned from a LOCAL preference, which is then removed:
  // the current launch is the host default (`from: "host"`, `at: null`). After the uninstall; claude stays.
  setLocalLaunch({ reviewer: { harness: "pi" }, dev: { harness: "codex" }, plain: { harness: "claude" } });
  const spawnPlain = extra => ["spawn", "plain", "--dir", fx.dep, "--agents-root", fx.root, "--purpose", "q", ...extra];
  const plainPreview = run("preview-plain-local", [...spawnPlain([]), "--preview", "--json"]);
  const plainApplied = run("apply-plain", [...spawnPlain(["--expect-decision", JSON.parse(plainPreview.stdout).result.decision.revision, "--idempotency-key", "d".repeat(64), "--no-launch"]), "--json"]);
  const plainHome = JSON.parse(plainApplied.stdout).result.home;
  setLocalLaunch({ reviewer: { harness: "pi" }, dev: { harness: "codex" } });
  run("inspect-home-reverse-drift", ["inspect", "--home", plainHome, "--json"]);
  run("readiness-home-reverse-drift", ["readiness", "--home", plainHome, "--soul", "plain", "--agents-root", fx.root, "--policy", "--json"], { expect: "any" });
} finally { fx.cleanup(); }
// default-team-changed (lib/instance-inspect.mjs teamItems): a second deployment of the same helper with
// team model v2 (shared teams in oats-workspace.yaml, a local default): spawn, then `oats teams default`
// moves the deployment's default. The home's readiness then carries recorded/current as DefaultTeam objects.
const tx = v2Deployment({ name: "acme", souls: { dev: {} },
  local: { teams: { mine: { team: "mine:me.aweb.ai" } }, defaultTeam: "mine" },
  workspace: { teams: { oats: { team: "oats:oats.aweb.ai", description: "The OATS project" }, night: { description: "Night shift (not created yet)" } } } });
try {
  const TPATH = `${join(tx.base, "runtime-stub")}:${dirname(process.execPath)}:/usr/bin:/bin`;
  const tredact = s => (s || "").split(tx.base).join("<base>").split(REPO).join("<oats>");
  const trun = (name, args, { expect = 0 } = {}) => {
    const r = tx.cli(args, { env: { PATH: TPATH } });
    prov.push({ name, argv: ["oats", ...args].map(tredact), exit: r.status, commit });
    const ok = expect === "any" || r.status === expect;
    console.log(`${ok ? "ok  " : "FAIL"} ${name} exit=${r.status}`);
    writeFileSync(join(OUT, `${name}.json`), tredact(r.stdout));
    if (!ok) console.log(tredact(r.stdout).slice(0, 1500), tredact(r.stderr).slice(0, 600));
    return r;
  };
  const spawnDev = extra => ["spawn", "dev", "--dir", tx.dep, "--agents-root", tx.root, "--purpose", "q", ...extra];
  const p = trun("preview-dev-teams", [...spawnDev([]), "--preview", "--json"]);
  const a = trun("apply-dev-teams", [...spawnDev(["--expect-decision", JSON.parse(p.stdout).result.decision.revision, "--idempotency-key", "e".repeat(64), "--no-launch"]), "--json"]);
  const teamHome = JSON.parse(a.stdout).result.home;
  trun("teams-default-oats", ["teams", "default", "oats", "--dir", tx.dep, "--json"]);
  trun("inspect-home-default-team-changed", ["inspect", "--home", teamHome, "--json"]);
  trun("readiness-home-default-team-changed", ["readiness", "--home", teamHome, "--soul", "dev", "--agents-root", tx.root, "--policy", "--json"], { expect: "any" });
} finally { tx.cleanup(); }
writeFileSync(join(OUT, "provenance.json"), JSON.stringify({ capturedBy: "oats-desktop-engineer, extended by ux-designer: launch preferences on the real kernel (0.30, feature launch-preference)",
  kernelTree: `oats main @${commit} (kernel #290 merged)`, fixture: "the kernel's test/helpers/v2-deployment.mjs: souls dev (soul claude/claude-opus-5-5), reviewer (soul codex, local pi), plain (host); later local dev codex; later codex uninstalled; later plain spawned from local claude, then that preference removed (reverse drift); a second deployment with team model v2 (local default mine, shared oats/night): dev spawned, then `oats teams default oats` (default-team-changed); hermetic PATH (inert stubs)",
  script: "capture-launch.mjs", documents: prov }, null, 2) + "\n");
