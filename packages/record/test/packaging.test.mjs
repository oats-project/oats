import { fixtureEnv } from "./fixture-env.mjs";
// Shippability: the packed tarball must install and run standalone,
// outside the monorepo, with no dependencies and no network.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { processStartToken, thisBoot } from "../lib/process-identity.mjs";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

test("npm pack tarball installs and runs in a clean room", { timeout: 120_000 }, (t) => {
  const room = mkdtempSync(join(tmpdir(), "turn-record-cleanroom-"));
  t.after(() => rmSync(room, { recursive: true, force: true }));

  const tarball = execFileSync("npm", ["pack", "--pack-destination", room, PKG], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop();
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--prefix", room, join(room, tarball)],
    { encoding: "utf8" },
  );

  const bin = join(room, "node_modules", ".bin", "turn-record");
  const run = (args, extraEnv = {}) =>
    spawnSync(bin, args, {
      encoding: "utf8",
      env: { ...fixtureEnv(), HOME: room, TURN_RECORD_ROOT: join(room, "record"), ...extraEnv },
    });

  const help = run([]);
  assert.equal(help.status, 0);
  assert.match(help.stderr, /usage: turn-record/);

  const status = run(["capture", "--status", "--owner", "cleanroom"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /owner: cleanroom/);

  const usage = run(["recall"]);
  assert.equal(usage.status, 2, "recall with no query exits 2 with usage");
  assert.match(usage.stderr, /usage: recall/);

  const dry = run(["setup", "--dry-run", "--owner", "cleanroom"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run: no first capture pass/);
  assert.doesNotMatch(dry.stdout + dry.stderr, /SKIP .*settings\.json/, "no settings corrupted");

  // --- the capture lock, judged as inside an oats install ------------------

  // A lock taken in another boot is its holder's no longer, though its pid (this test's) is alive
  // with the recorded start: the pass reclaims it and runs.
  const captureLock = join(room, "record", ".capture.lock");
  mkdirSync(captureLock, { recursive: true });
  mkdirSync(join(room, ".claude", "projects"), { recursive: true });
  writeFileSync(join(captureLock, "owner.json"), JSON.stringify({ pid: process.pid, nonce: "another-run", startedAt: "2026-10-01T00:00:00.000Z",
    host: hostname(), bootId: `another-boot-than-${thisBoot()}`, processStart: processStartToken(process.pid) }));
  const pass = run(["capture", "--sessions-only", "--owner", "cleanroom"]);
  assert.equal(pass.status, 0, pass.stderr + pass.stdout);
  assert.match(pass.stderr, new RegExp(`capture: reclaimed .*\\.capture\\.lock from pid ${process.pid}, which died`));
  assert.doesNotMatch(pass.stdout + pass.stderr, /another pass holds/);
  assert.equal(existsSync(captureLock), false, "the pass ran and released");

  // --- setup hardening, against an isolated $HOME -------------------------

  const home = join(room, "home");
  const settingsPath = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  // Foreign hooks that must survive untouched — including ones that share
  // substrings with our generated command (an unrelated tool also named
  // capture.mjs also taking --owner, and a comment-like echo).
  const foreignCommands = [
    "echo unrelated",
    "node ~/tools/screenshot/capture.mjs --owner alice --outdir /tmp/shots",
    'echo "reminder: run capture.mjs --owner <name> manually later"',
  ];
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        existing: "stuff",
        hooks: {
          Stop: [{ hooks: foreignCommands.map((command) => ({ type: "command", command })) }],
        },
      },
      null,
      2,
    ) + "\n",
  );
  const setup = (args) => run(["setup", "--no-service", ...args], { HOME: home });

  // Hostile or merely spaced owners are rejected before anything is written.
  for (const bad of ["a b", "x$(touch /tmp/pwn)", "</string><string>evil</string>", "a\nb"]) {
    const r = setup(["--owner", bad, "--dry-run"]);
    assert.equal(r.status, 2, `owner ${JSON.stringify(bad)} must be rejected`);
    assert.match(r.stderr, /invalid --owner/);
  }
  assert.match(readFileSync(settingsPath, "utf8"), /"existing": "stuff"/, "nothing written");

  // Real install merges without clobbering; second run is byte-identical.
  assert.equal(setup(["--owner", "cleanroom"]).status, 0);
  const once = readFileSync(settingsPath, "utf8");
  const installed = JSON.parse(once);
  assert.equal(installed.existing, "stuff");
  assert.deepEqual(
    installed.hooks.Stop[0].hooks.map((h) => h.command),
    foreignCommands,
    "every foreign hook kept verbatim, lookalikes included",
  );
  for (const command of [installed.hooks.Stop[1].hooks[0].command, installed.hooks.SessionEnd[0].hooks[0].command]) {
    assert.match(command, /\/bin\/capture-hook\.mjs'? --owner cleanroom --quiet /, "hooks run the package's hook entry");
    assert.doesNotMatch(command, /--hook/);
  }
  assert.equal(setup(["--owner", "cleanroom"]).status, 0);
  assert.equal(readFileSync(settingsPath, "utf8"), once, "second run is a no-op");

  // A hook from a moved install is updated in place, not duplicated.
  const moved = JSON.parse(once);
  moved.hooks.Stop[1].hooks[0].command = "node /old/install/bin/capture.mjs --owner cleanroom --quiet";
  writeFileSync(settingsPath, JSON.stringify(moved, null, 2) + "\n");
  assert.equal(setup(["--owner", "cleanroom"]).status, 0);
  const migrated = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(migrated.hooks.Stop.length, 2, "no duplicate group");
  assert.doesNotMatch(migrated.hooks.Stop[1].hooks[0].command, /\/old\/install\//);
});
