// A test writes an executable only inside its own fixture (oats-project/oats#2042). A home's recorded
// `launch.executable` is the harness its spawn found on PATH, which on a machine with the harness
// installed is that person's own binary: a test that wrote "its" harness there replaced it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFixtureExecutable } from "./helpers/v2-deployment.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("writeFixtureExecutable writes inside the fixture's base and nowhere else: a path outside it, one reached through a link, and a link at the path itself are refused with nothing written", (t) => {
  const root = mkdtempSync(join(tmpdir(), "oats-fixture-executable-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = join(root, "fixture"), outside = join(root, "the-persons-bin");
  mkdirSync(join(base, "bin"), { recursive: true });
  mkdirSync(outside);
  const theirs = join(outside, "pi"), before = "the person's own harness\n";
  writeFileSync(theirs, before, { mode: 0o755 });
  const refused = (path, why) => {
    assert.throws(() => writeFixtureExecutable(base, path, "#!/bin/sh\nexit 0\n"), (e) => /refusing to write the executable/.test(e.message) && why.test(e.message) && e.message.includes(base), path);
    assert.equal(readFileSync(theirs, "utf8"), before, `${path}: the file outside the fixture is as it was`);
  };
  // Inside: written, executable, and rewritten in place.
  const mine = writeFixtureExecutable(base, join(base, "bin", "pi"), "#!/bin/sh\nexit 0\n");
  assert.equal(statSync(mine).mode & 0o777, 0o755);
  writeFixtureExecutable(base, mine, "#!/bin/sh\nexit 1\n");
  assert.equal(readFileSync(mine, "utf8"), "#!/bin/sh\nexit 1\n");
  // Outside: the path a spawn on this machine's PATH would have recorded.
  refused(theirs, /not inside the fixture's base/);
  refused(join(root, "new-file"), /not inside the fixture's base/);
  assert.equal(existsSync(join(root, "new-file")), false);
  // A directory of the fixture that is a link to the outside.
  symlinkSync(outside, join(base, "linked-bin"));
  refused(join(base, "linked-bin", "pi"), /not inside the fixture's base/);
  // A link at the path itself, to the file outside.
  symlinkSync(theirs, join(base, "bin", "linked-pi"));
  refused(join(base, "bin", "linked-pi"), /is a symbolic link/);
  // A spelling that climbs out.
  refused(join(base, "bin", "..", "..", "the-persons-bin", "pi"), /not inside the fixture's base/);
  // Not absolute, or a directory that is not there.
  assert.throws(() => writeFixtureExecutable(base, "pi", ""), /absolute/);
  refused(join(base, "missing", "pi"), /cannot be resolved/);
});

test("no test writes to a recorded or resolved executable but through writeFixtureExecutable", () => {
  // A source-level tripwire, for the shape that went wrong: an fs write whose first argument is a
  // home's recorded `launch.executable`, or a name bound to one, anywhere in the tests.
  const WRITES = "(?:writeFileSync|appendFileSync|copyFileSync|renameSync|chmodSync|rmSync|unlinkSync|truncateSync|symlinkSync|linkSync)";
  const offenders = [];
  for (const name of readdirSync(HERE).filter((n) => n.endsWith(".mjs")).sort()) {
    if (name === "fixture-executable.test.mjs") continue;
    const source = readFileSync(join(HERE, name), "utf8");
    // Names bound to a recorded executable: `const x = …launch.executable` / `…launch?.executable`.
    const bound = [...source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.launch\??\.executable\b/g)].map((m) => m[1]);
    source.split("\n").forEach((line, i) => {
      const direct = new RegExp(`\\b${WRITES}\\(\\s*[^,)]*\\.launch\\??\\.executable\\b`).test(line);
      const viaName = bound.some((b) => new RegExp(`\\b${WRITES}\\(\\s*${b.replace("$", "\\$")}\\s*[,)]`).test(line));
      if (direct || viaName) offenders.push(`${name}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(offenders, [], "write a harness stand-in with writeFixtureExecutable(fx.base, path, content): it refuses a path outside the fixture");
});
