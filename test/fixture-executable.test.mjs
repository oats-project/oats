// A test writes an executable only inside its own fixture (oats-project/oats#2042). A home's recorded
// `launch.executable` is the harness its spawn found on PATH, which on a machine with the harness
// installed is that person's own binary: a test that wrote "its" harness there replaced it.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { insideFixture, writeFixtureExecutable } from "./helpers/v2-deployment.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("writeFixtureExecutable writes inside the fixture's base and nowhere else: a path outside it, one reached through a link, and a symbolic or a hard link at the path itself are refused with nothing written", (t) => {
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
  // A second name, inside the fixture, of the file outside (where both are on one filesystem).
  let linked = true;
  try { linkSync(theirs, join(base, "bin", "hard-pi")); } catch (e) { if (e.code !== "EXDEV" && e.code !== "EPERM") throw e; linked = false; }
  if (linked) refused(join(base, "bin", "hard-pi"), /second name/);
  // A directory at the path.
  mkdirSync(join(base, "bin", "a-directory"));
  refused(join(base, "bin", "a-directory"), /not a regular file/);
  // insideFixture answers the same question, for a test's own assertion.
  assert.deepEqual([insideFixture(base, mine), insideFixture(base, theirs), insideFixture(base, join(base, "linked-bin", "pi")), insideFixture(base, join(base, "bin", "linked-pi")), insideFixture(base, base), insideFixture(base, join(base, "nothing-here"))], [true, false, false, false, false, false]);
  // A spelling that climbs out.
  refused(join(base, "bin", "..", "..", "the-persons-bin", "pi"), /not inside the fixture's base/);
  // Not absolute, or a directory that is not there.
  assert.throws(() => writeFixtureExecutable(base, "pi", ""), /absolute/);
  refused(join(base, "missing", "pi"), /cannot be resolved/);
});

test("no test writes a home's recorded launch.executable but through writeFixtureExecutable", () => {
  // A source-level tripwire, for the one shape that went wrong: a synchronous fs write, on one
  // line, whose first argument is a home's recorded `launch.executable` or a name bound to one
  // with const, let or var. It does not see a destructured or computed name, a write through
  // fs/promises, a stream or a command, nor a path found by a lookup on PATH: the rule itself is
  // in docs/implementation.md, and the guard is what refuses a write that gets past this.
  const WRITES = "(?:writeFileSync|appendFileSync|copyFileSync|renameSync|chmodSync|rmSync|unlinkSync|truncateSync|symlinkSync|linkSync)";
  const offenders = [];
  const tui = join(HERE, "..", "packages", "tui", "test");
  const sources = [...readdirSync(HERE).map((n) => join(HERE, n)), ...readdirSync(join(HERE, "helpers")).map((n) => join(HERE, "helpers", n)), ...(existsSync(tui) ? readdirSync(tui).map((n) => join(tui, n)) : [])]
    .filter((file) => file.endsWith(".mjs")).sort();
  for (const file of sources) {
    const name = file.slice(HERE.length + 1);
    if (name === "fixture-executable.test.mjs") continue;
    const source = readFileSync(file, "utf8");
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
