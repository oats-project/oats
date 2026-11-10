// The one way the kernel finds a system tool (lib/system-tools.mjs): from the system directories,
// never from the caller's PATH (awebai/oats#915, condition 2).
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_TOOL_DIRS, systemTool } from "../lib/system-tools.mjs";
import { PS_ENV } from "../lib/worktree-hooks.mjs";

const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-system-tools-")));
test.after(() => rmSync(base, { recursive: true, force: true }));
const tool = (dir, name, mode = 0o755) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n"); chmodSync(join(dir, name), mode); return join(dir, name); };

test("the system directories are /usr/bin and /bin, then /usr/sbin and /sbin", () => {
  assert.deepEqual(SYSTEM_TOOL_DIRS, ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
  assert.ok(Object.isFrozen(SYSTEM_TOOL_DIRS));
});

test("ps runs on the system directories: PS_ENV's PATH is SYSTEM_TOOL_DIRS, one source of them", () => {
  assert.equal(PS_ENV.PATH, SYSTEM_TOOL_DIRS.join(":"));
  assert.ok(Object.isFrozen(PS_ENV));
});

test("systemTool: the first executable file in the system directories, whatever the caller's PATH holds", () => {
  const first = join(base, "sys-a"), second = join(base, "sys-b"), callers = join(base, "callers-bin");
  tool(callers, "systemd-run");
  const saved = process.env.PATH;
  process.env.PATH = `${callers}:${saved}`;
  try {
    assert.deepEqual(systemTool("systemd-run", { dirs: [first, second] }).reason !== undefined, true, "none in the system dirs: the caller's is never used");
    const want = tool(second, "systemd-run");
    assert.deepEqual(systemTool("systemd-run", { dirs: [first, second] }), { file: want });
    // Earlier directories win; a file that is not executable, and a directory, are not tools.
    tool(first, "systemd-run", 0o644);
    assert.deepEqual(systemTool("systemd-run", { dirs: [first, second] }), { file: want });
    mkdirSync(join(first, "tmux"), { recursive: true });
    assert.ok(systemTool("tmux", { dirs: [first] }).reason);
    const preferred = tool(join(base, "sys-c"), "systemd-run");
    assert.deepEqual(systemTool("systemd-run", { dirs: [join(base, "sys-c"), second] }), { file: preferred });
  } finally { process.env.PATH = saved; }
});

test("systemTool's reason names the tool and every directory looked in", () => {
  const r = systemTool("no-such-tool-915", { dirs: [join(base, "x"), join(base, "y")] });
  assert.equal(r.file, undefined);
  assert.match(r.reason, /no-such-tool-915/); assert.ok(r.reason.includes(join(base, "x")) && r.reason.includes(join(base, "y")));
  // A name is a file name, never a path.
  assert.match(systemTool("../bin/sh", { dirs: ["/usr/bin"] }).reason, /not a tool name/);
});

test("systemTool finds a real system tool in the default directories", () => {
  const sh = systemTool("sh");
  assert.ok(sh.file === "/usr/bin/sh" || sh.file === "/bin/sh", JSON.stringify(sh));
});

test("OATS_TEST_SYSTEM_TOOL_DIRS (test only) names the directories, absolute ones only; anything else is no tool", () => {
  const saved = process.env.OATS_TEST_SYSTEM_TOOL_DIRS;
  const dir = join(base, "seam"); const file = tool(dir, "systemd-run");
  try {
    process.env.OATS_TEST_SYSTEM_TOOL_DIRS = `${join(base, "empty")}:${dir}`;
    assert.deepEqual(systemTool("systemd-run"), { file });
    for (const bad of ["relative/bin", `${dir}:bin`, "", `${dir}:`]) {
      process.env.OATS_TEST_SYSTEM_TOOL_DIRS = bad;
      const r = systemTool("systemd-run");
      assert.equal(r.file, undefined, JSON.stringify(bad)); assert.match(r.reason, /OATS_TEST_SYSTEM_TOOL_DIRS/);
    }
    // An explicit `dirs` is the caller's: the seam is read only when none is given.
    process.env.OATS_TEST_SYSTEM_TOOL_DIRS = "relative";
    assert.deepEqual(systemTool("systemd-run", { dirs: [dir] }), { file });
  } finally { if (saved === undefined) delete process.env.OATS_TEST_SYSTEM_TOOL_DIRS; else process.env.OATS_TEST_SYSTEM_TOOL_DIRS = saved; }
});
