// The start's line for package modules an upgrade cannot move (lib/upgrade-state.mjs packageRespawnWarning):
// for every package, a module whose package is no longer locked, or no longer provides the capability,
// is kept by an upgrade, so the line names it and says to respawn. Pure: hand-built instance.json and lock.
import test from "node:test";
import assert from "node:assert/strict";
import { packageRespawnWarning, packageUpgradeDrift } from "../lib/upgrade-state.mjs";

const OID = (seed) => seed.repeat(40).slice(0, 40);
const A = OID("a"), B = OID("b");
const moduleFrom = (pkg, version, commit) => ({ commit, from: { kind: "package", package: pkg, version, commit, integrity: `sha256-${"0".repeat(64)}` } });
const lockOf = (packages) => ({ lockfileVersion: 3, packages });
const entry = (version, commit, capabilities) => ({ source: "catalog:x", url: "file:///x", path: "oats-package", version, commit, integrity: `sha256-${"1".repeat(64)}`, capabilities });
const tail = "an upgrade keeps them as they are, so respawn this instance to move it onto the lock";

test("packageRespawnWarning: a package gone from the lock, and a capability its package no longer provides, name the respawn", () => {
  const meta = { modules: { a: moduleFrom("acme.gone", "1.0.0", A), b: moduleFrom("acme.kept", "1.0.0", A), c: moduleFrom("acme.kept", "1.0.0", A) } };
  const lock = lockOf({ "acme.kept": entry("1.1.0", B, ["c"]) });
  assert.equal(packageRespawnWarning(meta, { lock }),
    `2 package module(s) cannot move in place (a: package acme.gone is no longer locked; b: package acme.kept no longer provides it); ${tail}`);
  // The one module that can move is still the upgrade's; the others are never offered as one.
  assert.deepEqual(packageUpgradeDrift(meta, { lock }).map((d) => d.capability), ["c"]);
});

test("packageRespawnWarning: null when every package module is current or moves in place, for member modules, and with no lock", () => {
  const meta = { modules: { a: moduleFrom("acme.pkg", "1.0.0", A), m: { commit: A, from: { kind: "member", repoKey: "github.com/acme/agents", commit: A } } } };
  assert.equal(packageRespawnWarning(meta, { lock: lockOf({ "acme.pkg": entry("1.0.0", A, ["a"]) }) }), null, "current");
  assert.equal(packageRespawnWarning(meta, { lock: lockOf({ "acme.pkg": entry("1.1.0", B, ["a"]) }) }), null, "moves in place: the upgrade hint's");
  assert.equal(packageRespawnWarning(meta, { lock: null }), null, "no lock: nothing is known to be missing");
  assert.equal(packageRespawnWarning({ modules: {} }, { lock: lockOf({}) }), null, "no modules");
});
