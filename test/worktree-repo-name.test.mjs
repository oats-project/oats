// `oats worktree add --repo <X>` where X is not a repository key (oats-project/oats#1781): a member's
// name (`oats`), `<org>/<name>` or `name.git` parses as no repository reference, so it can match no
// remote, and the refusal never tells the operator to repoint the clone at a URL built from it. When
// the clone at X's convention path has a remote of that name, the refusal names the key to pass.
// Against a real scratch deployment (the worktree-event fixture pattern): the member clone is
// <deployment>/ws, its origin the bare <base>/remotes/ws.git, so the member key is local/<…>/ws.git.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

function deployment(t) {
  const fx = v2Deployment({ souls: { dev: { soul: { work: "checkout" } } }, t });
  // No system or global git config, no prompt, no credential helper (as worktree-event.test.mjs).
  Object.assign(fx.env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "",
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "" });
  const hostPath = process.env.PATH; process.env.PATH = fx.env.PATH; t.after(() => { process.env.PATH = hostPath; });
  return fx;
}
const gitIn = (fx, cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: fx.env, stdio: ["ignore", "pipe", "pipe"] }).trim();
/** `oats worktree add … --repo <repo> --json` from the home, as an agent runs it. */
const addWith = (fx, home, repo, more = []) => fx.cli(["worktree", "add", "--purpose", "n", "--branch", "agents/n", "--base", "main", "--repo", repo, "--json", ...more], { cwd: home, env: { OATS_INSTANCE_HOME: home } });

function assertNamesTheKey(fx, r, label) {
  assert.notEqual(r.status, 0, label);
  const { error } = r.json();
  assert.equal(error.code, "E_CLONE_MISMATCH", `${label}: ${error.message}`);
  assert.doesNotMatch(error.message, /set-url/, label);
  assert.doesNotMatch(error.message, /remote add/, label);
  assert.ok(error.message.includes(`--repo ${fx.key}`), `${label}: ${error.message}`);
  for (const k of ["path", "expected", "found", "via"]) assert.ok(Object.hasOwn(error.details ?? {}, k), `${label}: details.${k}`);
}

test("1. --repo <member name>, a clone of the member at its convention path: E_CLONE_MISMATCH names --repo <member key>, no Git remedy (and with --preview)", async (t) => {
  const fx = deployment(t);
  const { home } = await fx.spawn("dev", { instance: "dev-a", work: "checkout" });
  assertNamesTheKey(fx, addWith(fx, home, "ws"), "add");
  assertNamesTheKey(fx, addWith(fx, home, "ws", ["--preview"]), "preview");
});

test("2. --repo <org>/<name> (the key's last two segments): the same refusal", async (t) => {
  const fx = deployment(t);
  const { home } = await fx.spawn("dev", { instance: "dev-b", work: "checkout" });
  const lastTwo = fx.key.split("/").slice(-2).join("/");
  assertNamesTheKey(fx, addWith(fx, home, lastTwo), "add");
  assertNamesTheKey(fx, addWith(fx, home, lastTwo, ["--preview"]), "preview");
});

test("3. --repo no-such-name, nothing at its convention path: E_CLONE_MISSING, no clones: hint, no Git remedy", async (t) => {
  const fx = deployment(t);
  const { home } = await fx.spawn("dev", { instance: "dev-c", work: "checkout" });
  const r = addWith(fx, home, "no-such-name");
  assert.notEqual(r.status, 0);
  const { error } = r.json();
  assert.equal(error.code, "E_CLONE_MISSING", error.message);
  assert.doesNotMatch(error.message, /clones: \{ no-such-name/);
  assert.doesNotMatch(error.message, /set-url/);
});

test("4. --repo <name> whose convention-path clone names an unrelated repository: E_CLONE_MISMATCH, no key suggested, no Git remedy", async (t) => {
  const fx = deployment(t);
  const { home } = await fx.spawn("dev", { instance: "dev-d", work: "checkout" });
  const other = join(fx.dep, "other"); mkdirSync(other); gitIn(fx, other, "init", "-q");
  const unrelated = "github.com/acme/unrelated";
  gitIn(fx, other, "remote", "add", "origin", `https://${unrelated}.git`);
  const r = addWith(fx, home, "other");
  assert.notEqual(r.status, 0);
  const { error } = r.json();
  assert.equal(error.code, "E_CLONE_MISMATCH", error.message);
  assert.ok(!error.message.includes(`--repo ${unrelated}`), error.message);
  assert.doesNotMatch(error.message, /set-url/);
});

test("--repo <name>.git, a clone with several remotes (one the member, one another repository, one that does not parse): names only the member's key", async (t) => {
  const fx = deployment(t);
  const { home } = await fx.spawn("dev", { instance: "dev-e", work: "checkout" });
  gitIn(fx, fx.member, "remote", "add", "fork", "https://github.com/acme/elsewhere.git");
  gitIn(fx, fx.member, "remote", "add", "odd", "ws.git");
  const r = addWith(fx, home, "ws.git");
  assertNamesTheKey(fx, r, "add");
  const { message } = r.json().error;
  assert.ok(!message.includes("--repo github.com/acme/elsewhere"), message);
  assert.ok(!message.includes("--repo ?/"), message);
  assert.ok(message.includes(`--repo ${fx.member}`), `the clone's path is the other spelling: ${message}`);
});

test("--repo agents: the convention path is <deployment>/agents-repo, and its remote's key is the one named", async (t) => {
  const fx = deployment(t);
  const { home } = await fx.spawn("dev", { instance: "dev-f", work: "checkout" });
  const clone = join(fx.dep, "agents-repo"); mkdirSync(clone); gitIn(fx, clone, "init", "-q");
  gitIn(fx, clone, "remote", "add", "origin", "https://github.com/acme/agents.git");
  const { error } = addWith(fx, home, "agents").json();
  assert.equal(error.code, "E_CLONE_MISMATCH", error.message);
  assert.ok(error.message.includes("--repo github.com/acme/agents"), error.message);
  assert.equal(error.details.path, clone);
  assert.doesNotMatch(error.message, /set-url|remote add/);
});

test("out of scope: a well-formed key that is no member's clone keeps today's Git remedy", async (t) => {
  const fx = deployment(t);
  const { home } = await fx.spawn("dev", { instance: "dev-g", work: "checkout" });
  const { error } = addWith(fx, home, "github.com/acme/ws").json();
  assert.equal(error.code, "E_CLONE_MISMATCH", error.message);
  assert.ok(error.message.includes(`git -C ${fx.member} remote set-url origin https://github.com/acme/ws.git`), error.message);
  assert.deepEqual(error.details, { path: fx.member, expected: "github.com/acme/ws", found: [fx.key], via: "convention path" });
});
