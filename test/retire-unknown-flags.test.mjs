// `oats retire` refuses a flag it does not define, and an argument after the instance, before anything
// happens: a mistyped protective flag (`--keep-dirs` for `--keep-dir`) must not remove the home.
//
// This file pins:
//   - `oats retire <instance> --keep-dirs` is E_BAD_ARGS naming the flag and printing the usage, in text
//     and under --json (one failure envelope, `details.flag`), and the home is as it was;
//   - the refusal comes before `--plan` answers and before `--server` sends anything;
//   - an argument after the instance is refused the same way (`details.argument`);
//   - no instance is E_USAGE with the usage line, as one envelope under --json and the usage on stderr
//     without it; an unknown flag without an instance stays E_BAD_ARGS;
//   - `--keep-dir` keeps the home, and every flag retire defines is read: a value flag's value is its
//     value (spaced or `--flag=value`), never an argument.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v2Deployment } from "./helpers/v2-deployment.mjs";

const USAGE = "usage: oats retire <instance> [--plan] [--plan-revision <rev> --idempotency-key <key>] [--home <path>] [--dir <d>] [--server <id>] [--self] [--discard-worktree] [--keep-dir] [--force] [--json]";
const KEPT = "notes the instance wrote\n";

function deployment(t) {
  const fx = v2Deployment({ t, souls: { dev: { soul: { work: "directory" } } } });
  const homeOf = (name) => join(fx.root, "dev", "instances", name);
  /** Every file under `dir`, with its bytes. */
  const tree = (dir, under = "") => readdirSync(join(dir, under), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? tree(dir, join(under, e.name)) : [[join(under, e.name), e.isFile() ? readFileSync(join(dir, under, e.name), "base64") : "(not a file)"]]));
  return {
    fx, homeOf,
    /** A spawned instance `name` with a file of its own in its home → what its home holds. */
    spawn: async (name) => {
      const hostPath = process.env.PATH;
      process.env.PATH = fx.env.PATH;
      try { assert.equal((await fx.inEnv(() => fx.spawn("dev", { name }))).home, homeOf(name)); } finally { process.env.PATH = hostPath; }
      writeFileSync(join(homeOf(name), "NOTES.md"), KEPT);
      return tree(homeOf(name));
    },
    /** The home of `name` is there, and holds what it held at `before`. */
    untouched: (name, before, what) => {
      assert.equal(existsSync(homeOf(name)), true, `${what}: the home is still there`);
      assert.equal(readFileSync(join(homeOf(name), "NOTES.md"), "utf8"), KEPT, `${what}: its notes are as they were`);
      assert.deepEqual(tree(homeOf(name)), before, `${what}: the home holds what it held`);
    },
    /** The one failure envelope of a `--json` run. */
    refusal: (r) => {
      assert.equal(r.status, 1, r.stdout + r.stderr);
      const lines = r.stdout.trim().split("\n");
      assert.equal(lines.length, 1, `one envelope on stdout: ${r.stdout}`);
      const envelope = JSON.parse(lines[0]);
      assert.equal(envelope.schemaVersion, 1);
      assert.equal(envelope.ok, false);
      return envelope.error;
    },
  };
}

test("oats retire <instance> --keep-dirs is refused as an unknown flag, with the usage, and the home is as it was", async (t) => {
  const d = deployment(t);
  const before = await d.spawn("dev-typo");
  const r = d.fx.cli(["retire", "dev-typo", "--keep-dirs"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, `oats: oats retire: unknown flag --keep-dirs\n${USAGE}\n`);
  d.untouched("dev-typo", before, "--keep-dirs");
});

test("under --json the unknown flag is one E_BAD_ARGS envelope naming it, and the home is as it was", async (t) => {
  const d = deployment(t);
  const before = await d.spawn("dev-json");
  for (const argv of [["retire", "dev-json", "--keep-dirs", "--json"], ["retire", "dev-json", "--json", "--force", "--keep-dirs"]]) {
    const error = d.refusal(d.fx.cli(argv));
    assert.deepEqual(error, { code: "E_BAD_ARGS", message: `oats retire: unknown flag --keep-dirs\n${USAGE}`, details: { flag: "--keep-dirs" } }, argv.join(" "));
    d.untouched("dev-json", before, argv.join(" "));
  }
});

test("an unknown flag is refused before --plan answers and before --server sends anything", async (t) => {
  const d = deployment(t);
  const before = await d.spawn("dev-early");
  const text = d.fx.cli(["retire", "dev-early", "--plan", "--keep-dirs"]);
  assert.equal(text.status, 1, text.stdout + text.stderr);
  assert.equal(text.stdout, "", "no plan is printed");
  assert.equal(text.stderr, `oats: oats retire: unknown flag --keep-dirs\n${USAGE}\n`);
  const planned = d.refusal(d.fx.cli(["retire", "dev-early", "--plan", "--keep-dirs", "--json"]));
  assert.deepEqual(planned, { code: "E_BAD_ARGS", message: `oats retire: unknown flag --keep-dirs\n${USAGE}`, details: { flag: "--keep-dirs" } });
  // No server is registered as `nosuch`: a retire that got as far as its route answers E_SERVER_UNKNOWN.
  assert.equal(d.refusal(d.fx.cli(["retire", "dev-early", "--server", "nosuch", "--json"])).code, "E_SERVER_UNKNOWN", "fixture premise: --server is a flag of retire, and reaches the route");
  const routed = d.refusal(d.fx.cli(["retire", "dev-early", "--server", "nosuch", "--keep-dirs", "--json"]));
  assert.deepEqual(routed, { code: "E_BAD_ARGS", message: `oats retire: unknown flag --keep-dirs\n${USAGE}`, details: { flag: "--keep-dirs" } });
  d.untouched("dev-early", before, "--plan and --server");
});

test("an argument after the instance is refused, and neither home is touched", async (t) => {
  const d = deployment(t);
  const first = await d.spawn("dev-one");
  const second = await d.spawn("dev-two");
  const message = `oats retire: unexpected argument "dev-two" after the instance "dev-one": retire takes one instance\n${USAGE}`;
  const text = d.fx.cli(["retire", "dev-one", "dev-two"]);
  assert.equal(text.status, 1, text.stdout + text.stderr);
  assert.equal(text.stderr, `oats: ${message}\n`);
  assert.deepEqual(d.refusal(d.fx.cli(["retire", "dev-one", "--force", "dev-two", "--json"])), { code: "E_BAD_ARGS", message, details: { argument: "dev-two" } });
  d.untouched("dev-one", first, "the instance");
  d.untouched("dev-two", second, "the argument");
});

test("no instance is E_USAGE with the usage line: one envelope under --json, the usage on stderr without it", (t) => {
  const d = deployment(t);
  for (const argv of [["retire", "--json"], ["retire", "--plan", "--json"], ["retire", "--force", "--json"]]) {
    const r = d.fx.cli(argv);
    assert.equal(r.stderr, "", `${argv.join(" ")}: nothing on stderr`);
    assert.deepEqual(d.refusal(r), { code: "E_USAGE", message: USAGE }, argv.join(" "));
  }
  const text = d.fx.cli(["retire"]);
  assert.equal(text.status, 1, text.stdout + text.stderr);
  assert.equal(text.stdout, "");
  assert.equal(text.stderr, `oats: ${USAGE}\n`);
  // An unknown flag is refused as one before the missing instance is.
  assert.deepEqual(d.refusal(d.fx.cli(["retire", "--keep-dirs", "--json"])), { code: "E_BAD_ARGS", message: `oats retire: unknown flag --keep-dirs\n${USAGE}`, details: { flag: "--keep-dirs" } });
});

test("--keep-dir keeps the home; --home, --dir, --discard-worktree, --force and --json are read with it", async (t) => {
  const d = deployment(t);
  await d.spawn("dev-kept");
  const r = d.fx.cli(["retire", "dev-kept", "--home", d.homeOf("dev-kept"), "--dir", d.fx.dep, "--discard-worktree", "--keep-dir", "--force", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const receipt = JSON.parse(r.stdout);
  assert.equal(receipt.retired, "dev-kept");
  assert.equal(receipt.removedDir, false);
  assert.equal(existsSync(d.homeOf("dev-kept")), true, "the home is kept");
  assert.equal(readFileSync(join(d.homeOf("dev-kept"), "NOTES.md"), "utf8"), KEPT);
});

test("--plan, --plan-revision and --idempotency-key are read, with --home and --dir spaced or as --flag=value; --self is read", async (t) => {
  const d = deployment(t);
  const before = await d.spawn("dev-guarded");
  const home = d.homeOf("dev-guarded");
  const plan = (...at) => { const p = d.fx.cli(["retire", "dev-guarded", "--plan", "--json", ...at]); assert.equal(p.status, 0, p.stdout + p.stderr); return p.json().result; };
  const spaced = plan("--home", home, "--dir", d.fx.dep);
  assert.equal(spaced.home, home);
  assert.equal(plan(`--home=${home}`, `--dir=${d.fx.dep}`).planRevision, spaced.planRevision, "the inline forms name the same home");
  const text = d.fx.cli(["retire", "dev-guarded", "--plan"]);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(text.stdout, new RegExp(`^retire dev-guarded — plan ${spaced.planRevision}\n`));
  // --self is read: this process is not the instance, and retire says so.
  const self = d.fx.cli(["retire", "dev-guarded", "--self"]);
  assert.equal(self.status, 1, self.stdout + self.stderr);
  assert.equal(self.stderr, 'oats: --self given but "dev-guarded" is not the calling instance\n');
  d.untouched("dev-guarded", before, "--plan and --self");
  const applied = d.fx.cli(["retire", "dev-guarded", "--plan-revision", spaced.planRevision, "--idempotency-key", "key-1", `--home=${home}`, "--dir", d.fx.dep, "--json"]);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  const receipt = JSON.parse(applied.stdout);
  assert.equal(receipt.retired, "dev-guarded");
  assert.equal(receipt.idempotencyKey, "key-1");
  assert.equal(existsSync(home), false, "the guarded retire removed the home");
});
