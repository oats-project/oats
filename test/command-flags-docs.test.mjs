// The flags each state-changing command defines (lib/command-flags.mjs) are the ones its reference lists
// (docs/desktop-cli-api.md "The flags a command defines"), and the ones its usage line names.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMMAND_FLAGS } from "../lib/command-flags.mjs";

const PAGE = readFileSync(new URL("../docs/desktop-cli-api.md", import.meta.url), "utf8");
const SECTION = PAGE.slice(PAGE.indexOf("### The flags a command defines"), PAGE.indexOf("### Dispatch errors"));
const cells = (cell) => (cell === "none" ? [] : [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]));

test("the reference's table lists every declared command with exactly its arguments and flags", () => {
  const rows = SECTION.split("\n").filter((l) => l.startsWith("| `oats ")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  assert.deepEqual(rows.map((r) => cells(r[0])[0]), COMMAND_FLAGS.map((c) => `oats ${c.command}`), "one row per command, in the declaration's order");
  for (const [row, c] of rows.map((r, i) => [r, COMMAND_FLAGS[i]])) {
    assert.deepEqual(cells(row[1]), c.operands.map((o) => `<${o}>`), `${c.command}: arguments`);
    assert.deepEqual(cells(row[2]), c.values, `${c.command}: flags that take a value`);
    assert.deepEqual(cells(row[3]), c.switches, `${c.command}: switches`);
    assert.deepEqual(cells(row[4]), Object.keys(c.refused ?? {}), `${c.command}: refused in their own words`);
  }
});

test("each usage line names its command and only flags the command defines", () => {
  for (const c of COMMAND_FLAGS) {
    assert.ok(c.usage.startsWith(`usage: oats ${c.command}`), c.usage);
    const named = [...c.usage.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]);
    assert.deepEqual(named.filter((f) => !c.values.includes(f) && !c.switches.includes(f)), [], `${c.command}: ${c.usage}`);
    assert.ok(c.switches.includes("--json"), `${c.command} reads --json`);
  }
});
