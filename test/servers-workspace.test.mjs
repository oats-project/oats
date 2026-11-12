// Servers per workspace (awebai/oats#517, feature servers-per-workspace): a
// registration records the canonical key of the workspace its host deployment
// realizes (`workspaceKey`), learned from the host's own `status --json`
// answer and never typed; `server list --workspace-ref` lists one workspace's
// servers. The host is this kernel behind the fake ssh (helpers/fake-ssh.mjs).

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fakeBin } from "./helpers/fake-ssh.mjs";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { validateServer } from "../lib/servers.mjs";

const CLI = resolve(new URL("../bin/oats.mjs", import.meta.url).pathname);

function setup() {
  const base = mkdtempSync("/tmp/oats-sw-"); // short: the control socket path must fit in 104 bytes
  const { bin, tools } = fakeBin(base);
  const fx = v2Deployment();
  const env = { ...process.env, PATH: bin, OATS_HOME_DIR: join(base, "oats-home"), HOME: join(base, "home") };
  mkdirSync(env.HOME, { recursive: true }); mkdirSync(env.OATS_HOME_DIR, { recursive: true });
  for (const k of Object.keys(env)) if (/^(OATS_INSTANCE|OATS_HOME$|PI_AGENT)/.test(k)) delete env[k];
  const oats = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd: env.HOME });
    return { ...r, json: () => JSON.parse(r.stdout.trim()) };
  };
  const serversFile = join(env.OATS_HOME_DIR, "servers.json");
  const cleanup = () => { fx.cleanup(); rmSync(base, { recursive: true, force: true }); };
  return { base, bin, tools, fx, env, oats, serversFile, cleanup };
}

test("validateServer: workspaceKey is an optional canonical key string", () => {
  assert.ok(validateServer("w", { sshHost: "h", workspace: "/w", workspaceKey: "github.com/example/app" }));
  assert.ok(validateServer("w", { sshHost: "h", workspace: "/w", workspaceKey: "local//tmp/ws.git" }));
  for (const bad of [42, "", "github.com/a b", "x\ny", null]) {
    assert.throws(() => validateServer("w", { sshHost: "h", workspace: "/w", workspaceKey: bad }), /workspaceKey/, JSON.stringify(bad));
  }
});

test("server add records the host's workspace key; an unanswering host is registered without one, and says so", () => {
  const s = setup();
  try {
    let r = s.oats(["server", "add", "build", "--ssh", "build-host", "--workspace", s.fx.dep, "--oats", CLI, "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.json().result.workspaceKey, s.fx.key, "the key the host's status --json reports");
    assert.deepEqual(JSON.parse(readFileSync(s.serversFile, "utf8")).servers.build, { sshHost: "build-host", workspace: s.fx.dep, oatsPath: CLI, workspaceKey: s.fx.key });

    // No deployment at the registered path: the host answers no key. Written, without it.
    r = s.oats(["server", "add", "bare", "--ssh", "bare-host", "--workspace", join(s.base, "nothing-here"), "--oats", CLI, "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.json().result.workspaceKey, null);
    assert.match(r.json().result.warnings.join("\n"), /workspace key unknown/);
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(s.serversFile, "utf8")).servers.bare, "workspaceKey"), false);

    // Text mode says so too.
    r = s.oats(["server", "add", "bare", "--ssh", "bare-host", "--workspace", join(s.base, "nothing-here"), "--oats", CLI, "--replace"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /workspace key unknown/);
  } finally { s.cleanup(); }
});

test("server check backfills an absent key, and refuses a host reporting another key without rewriting the registration", () => {
  const s = setup();
  try {
    writeFileSync(s.serversFile, JSON.stringify({ servers: { build: { sshHost: "build-host", workspace: s.fx.dep, oatsPath: CLI } } }, null, 2) + "\n");
    let r = s.oats(["server", "check", "build", "--json"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(r.json().result.workspaceKey, s.fx.key);
    assert.equal(JSON.parse(readFileSync(s.serversFile, "utf8")).servers.build.workspaceKey, s.fx.key, "backfilled");

    // A recorded key the host contradicts: refused, the file untouched byte for byte.
    const recorded = { servers: { build: { sshHost: "build-host", workspace: s.fx.dep, oatsPath: CLI, workspaceKey: "github.com/acme/other" } } };
    writeFileSync(s.serversFile, JSON.stringify(recorded, null, 2) + "\n");
    const before = readFileSync(s.serversFile, "utf8");
    r = s.oats(["server", "check", "build", "--json"]);
    assert.notEqual(r.status, 0);
    const e = r.json().error;
    assert.equal(e.code, "E_SERVER_WORKSPACE_MISMATCH");
    assert.deepEqual(e.details, { recorded: "github.com/acme/other", reported: s.fx.key });
    assert.match(e.message, /server add build --replace/);
    assert.equal(readFileSync(s.serversFile, "utf8"), before, "the registration is not rewritten");
  } finally { s.cleanup(); }
});

test("server list carries workspaceKey per row; --workspace-ref filters by canonical key and reports unknownWorkspace", () => {
  const s = setup();
  try {
    writeFileSync(s.serversFile, JSON.stringify({ servers: {
      mine: { sshHost: "h1", workspace: "/w1", workspaceKey: s.fx.key },
      other: { sshHost: "h2", workspace: "/w2", workspaceKey: "github.com/acme/other" },
      unknown: { sshHost: "h3", workspace: "/w3" },
    } }, null, 2) + "\n");
    let r = s.oats(["server", "list", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const rows = Object.fromEntries(r.json().result.servers.map((row) => [row.id, row]));
    assert.equal(rows.mine.workspaceKey, s.fx.key);
    assert.equal(rows.other.workspaceKey, "github.com/acme/other");
    assert.equal(rows.unknown.workspaceKey, null, "null when unknown");
    assert.equal(Object.hasOwn(r.json().result, "unknownWorkspace"), false, "only with --workspace-ref");

    // Any spelling of the ref resolves to its canonical key (here the file URL and the bare path).
    for (const ref of [s.fx.ref, s.fx.repo]) {
      r = s.oats(["server", "list", "--workspace-ref", ref, "--json"]);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.deepEqual(r.json().result.servers.map((row) => row.id), ["mine"], ref);
      assert.deepEqual(r.json().result.unknownWorkspace, ["unknown"]);
    }
    r = s.oats(["server", "list", "--workspace-ref", "not a ref", "--json"]);
    assert.equal(r.json().error.code, "E_REPO_REF");
    r = s.oats(["server", "list", "--workspace-ref", "--json"]);
    assert.equal(r.json().error.code, "E_BAD_ARGS");
  } finally { s.cleanup(); }
});

/** An ssh whose host answers `status --json` with a workspace key at once, except for a command naming
 *  `held`: that one waits (after touching `waiting`) until `gate` exists. */
function gatedSsh(bin, { held, waiting, gate, key }) {
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
const fs = require("node:fs");
const cmd = process.argv.at(-1);
const answer = () => console.log(JSON.stringify({ schemaVersion: 1, ok: true, result: { agents: [], workspace: { key: ${JSON.stringify(key)} } } }));
if (cmd.includes(${JSON.stringify(held)})) {
  fs.writeFileSync(${JSON.stringify(waiting)}, "");
  const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(t); answer(); } }, 10);
} else answer();
`);
  chmodSync(join(bin, "ssh"), 0o755);
}
async function whileHeld(s, held, args, during) {
  const waiting = join(s.base, `waiting-${held.replace(/\W/g, "")}`), gate = join(s.base, `gate-${held.replace(/\W/g, "")}`);
  gatedSsh(s.bin, { held, waiting, gate, key: "github.com/acme/ws" });
  const child = spawn(process.execPath, [CLI, ...args], { env: s.env, cwd: s.env.HOME, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (b) => { out += b; });
  const done = new Promise((res) => child.on("close", res));
  const deadline = Date.now() + 20000;
  while (!existsSync(waiting)) { if (Date.now() > deadline) throw new Error(`${args.join(" ")} never reached its probe`); await new Promise((r) => setTimeout(r, 10)); }
  during();
  writeFileSync(gate, "");
  const status = await done;
  return { status, json: () => JSON.parse(out.trim()) };
}

test("learning a workspace key never loses or resurrects a registration written while the host was being asked", async () => {
  const s = setup();
  try {
    const registry = () => JSON.parse(readFileSync(s.serversFile, "utf8")).servers;
    // server add a, held at its probe, while b is added: both stay, a gets its key.
    let r = await whileHeld(s, "/srv/a", ["server", "add", "a", "--ssh", "host", "--workspace", "/srv/a", "--json"], () => {
      assert.equal(s.oats(["server", "add", "b", "--ssh", "host", "--workspace", "/srv/b", "--json"]).status, 0);
    });
    assert.equal(r.status, 0);
    assert.deepEqual(registry(), { a: { sshHost: "host", workspace: "/srv/a", workspaceKey: "github.com/acme/ws" }, b: { sshHost: "host", workspace: "/srv/b", workspaceKey: "github.com/acme/ws" } });

    // server add c, held, while c is removed: not resurrected, and said so.
    r = await whileHeld(s, "/srv/c", ["server", "add", "c", "--ssh", "host", "--workspace", "/srv/c", "--json"], () => {
      assert.equal(s.oats(["server", "remove", "c", "--json"]).status, 0);
    });
    assert.equal(r.status, 0);
    assert.equal(Object.hasOwn(registry(), "c"), false, "a removed registration stays removed");
    assert.equal(r.json().result.workspaceKey, null);
    assert.match(r.json().result.warnings.join("\n"), /changed while the host was asked/);

    // server check a (no key yet), held, while a is re-pointed: the key is never written onto the new target.
    writeFileSync(s.serversFile, JSON.stringify({ servers: { ...registry(), a: { sshHost: "host", workspace: "/srv/a" } } }, null, 2) + "\n");
    r = await whileHeld(s, "/srv/a", ["server", "check", "a", "--json"], () => {
      assert.equal(s.oats(["server", "add", "a", "--ssh", "host", "--workspace", "/srv/elsewhere", "--replace", "--json"]).status, 0);
    });
    assert.deepEqual(registry().a, { sshHost: "host", workspace: "/srv/elsewhere", workspaceKey: "github.com/acme/ws" }, "the replacement's own key, from its own add");
    assert.deepEqual(Object.keys(registry()).sort(), ["a", "b"]);
  } finally { s.cleanup(); }
});
