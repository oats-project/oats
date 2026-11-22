import test from "node:test";
import assert from "node:assert/strict";
import { sameDirectory } from "../lib/directory-identity.mjs";

const recorded = { dev: 16777233, ino: 1227913745 };
const born = { ...recorded, birthtimeNs: "1792080083113723159" };
const remounted = { dev: 16777229, ino: 1227913745, birthtimeNs: "1792080083113723159" };

test("the same dev and ino are the same directory on every platform", () => {
  for (const platform of ["darwin", "linux"]) {
    assert.equal(sameDirectory(recorded, { ...recorded, birthtimeNs: "5" }, platform), true);
    assert.equal(sameDirectory(born, { ...recorded, birthtimeNs: "5" }, platform), true);
  }
});

test("another inode is another directory on every platform, whatever else matches", () => {
  for (const platform of ["darwin", "linux"]) {
    assert.equal(sameDirectory(born, { ...born, ino: recorded.ino + 1 }, platform), false);
    assert.equal(sameDirectory(born, { ...remounted, ino: recorded.ino + 1 }, platform), false);
  }
});

test("darwin: a volume remounted with a new dev keeps its directories, by inode and birth time", () => {
  assert.equal(sameDirectory(born, remounted, "darwin"), true);
  assert.equal(sameDirectory(born, { ...remounted, birthtimeNs: "1792080083113723160" }, "darwin"), false);
});

test("darwin: a record without a birth time, or with \"0\", is judged by inode alone", () => {
  assert.equal(sameDirectory(recorded, remounted, "darwin"), true);
  assert.equal(sameDirectory({ ...recorded, birthtimeNs: "0" }, remounted, "darwin"), true);
  assert.equal(sameDirectory(recorded, { dev: remounted.dev, ino: remounted.ino }, "darwin"), true);
});

test("linux: a changed dev is the same directory only when a recorded birth time matches (#1266)", () => {
  // The btrfs reproduction: a subvolume's dev 55 before a reboot and 52 after, inode and birth time unchanged.
  const spawned = { dev: 55, ino: 65547191, birthtimeNs: "1795366674123456789" };
  const rebooted = { dev: 52, ino: 65547191, birthtimeNs: "1795366674123456789" };
  for (const platform of ["linux", "freebsd"]) {
    assert.equal(sameDirectory(spawned, rebooted, platform), true);
    assert.equal(sameDirectory(born, remounted, platform), true);
    assert.equal(sameDirectory(spawned, { ...rebooted, birthtimeNs: "1795366674123456790" }, platform), false);
    assert.equal(sameDirectory(spawned, { dev: rebooted.dev, ino: rebooted.ino }, platform), false);
    assert.equal(sameDirectory(spawned, { ...rebooted, ino: spawned.ino + 1 }, platform), false);
  }
});

test("linux: a record without a birth time, or with \"0\", needs dev and ino both to match", () => {
  for (const platform of ["linux", "freebsd"]) {
    assert.equal(sameDirectory(recorded, remounted, platform), false);
    assert.equal(sameDirectory({ ...recorded, birthtimeNs: "0" }, { ...remounted, birthtimeNs: "0" }, platform), false);
    assert.equal(sameDirectory({ ...recorded, birthtimeNs: null }, { ...remounted, birthtimeNs: null }, platform), false);
    assert.equal(sameDirectory(recorded, { ...recorded, birthtimeNs: "0" }, platform), true);
  }
});

test("a missing record or reading is never the same directory", () => {
  for (const platform of ["darwin", "linux"]) {
    assert.equal(sameDirectory(undefined, remounted, platform), false);
    assert.equal(sameDirectory(born, undefined, platform), false);
  }
});
