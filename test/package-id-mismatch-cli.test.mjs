// A package is locked under its own id (oats-project/oats#1759): `oats sync` and `oats sync --plan`
// refuse a `packages:` key whose pinned oats-package.json names another package id, with
// E_PACKAGE_INTEGRITY why:"package-id" and a fix that names the manifest's id, before the lock is
// written — no lock is created, and an existing lock keeps its bytes.
//
// Real git: one bare member repo (the v2Deployment helper) plus bare package repos with tags.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { v2Deployment } from "./helpers/v2-deployment.mjs";
import { packageRepo } from "./helpers/package-repo.mjs";

const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); const j = r.json(); assert.equal(j.ok, true, `${what}: ${r.stdout}`); return j.result; };
const fails = (r, code, what) => {
  assert.notEqual(r.status, 0, `${what}: exits non-zero: ${r.stdout}${r.stderr}`);
  const j = r.json(); assert.equal(j.ok, false, `${what}: ${r.stdout}${r.stderr}`); assert.equal(j.error.code, code, `${what}: ${r.stdout}`);
  return j.error;
};

const KEY = "acme.tools", NAMED = "acme.tools-renamed";

/** A deployment pinning `packages` (id → package repo, at v1.0.0); every repo is cleaned up with it. */
function fixture(packages) {
  const fx = v2Deployment({ name: "acme", souls: { dev: {} }, workspace: { packages: pins(packages) } });
  const cleanup = fx.cleanup;
  fx.cleanup = () => { cleanup(); for (const pkg of Object.values(packages)) pkg.cleanup(); };
  fx.lockFile = join(fx.dep, "oats-lock.json");
  return fx;
}
const pins = (packages) => Object.fromEntries(Object.entries(packages).map(([id, pkg]) => [id, `${pkg.ref}@v1.0.0`]));
/** A package repo keyed `KEY` in packages: whose manifest names `NAMED`. */
const mismatched = () => packageRepo({ id: KEY, manifest: { package: NAMED } });

function assertPackageIdRefusal(e, value) {
  assert.equal(e.details.why, "package-id", JSON.stringify(e));
  assert.equal(e.details.id, KEY);
  assert.equal(e.details.manifestPackage, NAMED);
  assert.match(e.details.commit, /^[0-9a-f]{40}$/);
  assert.equal(e.details.value, value);
  assert.ok(e.message.startsWith(`packages.${KEY}: ${value} resolves to ${e.details.commit.slice(0, 12)}, whose oats-package.json names package "${NAMED}", not "${KEY}"`), e.message);
  assert.ok(e.message.includes(`declare ${NAMED}: ${value} in packages: in place of ${KEY}`), e.message);
  assert.ok(e.message.includes(`or pin a version of ${KEY} whose manifest names ${KEY}`), e.message);
  assert.ok(e.message.includes("run `oats sync`"), e.message);
}

test("sync refuses a git: pin whose manifest names another package id (E_PACKAGE_INTEGRITY why:package-id) and creates no lock", (t) => {
  const pkg = mismatched();
  const fx = fixture({ [KEY]: pkg }); t.after(fx.cleanup);
  const e = fails(fx.cli(["sync", "--json"]), "E_PACKAGE_INTEGRITY", "sync of a mismatched package id");
  assertPackageIdRefusal(e, `${pkg.ref}@v1.0.0`);
  assert.equal(e.details.commit, pkg.commit1, "the commit the pin resolved to");
  assert.equal(existsSync(fx.lockFile), false, "no lock is written");
});

test("sync refusing a mismatched package id leaves an existing lock byte-identical", (t) => {
  const good = packageRepo({ id: "acme.pkg" });
  const bad = mismatched();
  const fx = fixture({ "acme.pkg": good }); t.after(() => bad.cleanup());
  t.after(fx.cleanup);
  ok(fx.cli(["sync", "--json"]), "sync of a matching package");
  const before = readFileSync(fx.lockFile);
  assert.ok(JSON.parse(before).packages["acme.pkg"], "the matching package is locked");

  const ws = YAML.parse(readFileSync(join(fx.member, "oats-workspace.yaml"), "utf8"));
  ws.packages[KEY] = `${bad.ref}@v1.0.0`;
  fx.commit({ "oats-workspace.yaml": { yaml: ws } }, "pin a mismatched package");

  const e = fails(fx.cli(["sync", "--json"]), "E_PACKAGE_INTEGRITY", "sync after adding a mismatched package");
  assertPackageIdRefusal(e, `${bad.ref}@v1.0.0`);
  assert.ok(readFileSync(fx.lockFile).equals(before), "the lock's bytes are unchanged");
});

test("sync --plan refuses a mismatched package id the same way and writes nothing", (t) => {
  const pkg = mismatched();
  const fx = fixture({ [KEY]: pkg }); t.after(fx.cleanup);
  const listing = () => readdirSync(fx.dep, { recursive: true }).filter((p) => !String(p).split(/[\\/]/).includes(".git")).sort();
  const before = listing();
  const e = fails(fx.cli(["sync", "--plan", "--json"]), "E_PACKAGE_INTEGRITY", "sync --plan of a mismatched package id");
  assertPackageIdRefusal(e, `${pkg.ref}@v1.0.0`);
  assert.equal(existsSync(fx.lockFile), false, "no lock is written");
  assert.deepEqual(listing(), before, "the plan writes nothing in the deployment");
});

test("control: a package whose manifest names its packages: key syncs and is locked under it", (t) => {
  const pkg = packageRepo({ id: KEY });
  const fx = fixture({ [KEY]: pkg }); t.after(fx.cleanup);
  ok(fx.cli(["sync", "--plan", "--json"]), "sync --plan of a matching package");
  ok(fx.cli(["sync", "--json"]), "sync of a matching package");
  const entry = JSON.parse(readFileSync(fx.lockFile, "utf8")).packages[KEY];
  assert.equal(entry.commit, pkg.commit1);
  assert.deepEqual(entry.capabilities, ["acme-tool"]);
});
