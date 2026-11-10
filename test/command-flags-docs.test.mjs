// The flags each state-changing command defines (lib/command-flags.mjs) are the ones its reference lists
// (docs/desktop-cli-api.md "The flags a command defines"), with its optional arguments, the flags of more
// than one word and the answers it gives in its own words, and the ones its usage line names.
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
    // An argument the command may go without is in brackets (`required`).
    assert.deepEqual(cells(row[1]), c.operands.map((o, i) => (i < c.required ? `<${o}>` : `[<${o}>]`)), `${c.command}: arguments`);
    assert.deepEqual(cells(row[2]), c.values, `${c.command}: flags that take a value`);
    // A value flag of more than one word says how many (`arity`), beside its name.
    for (const [flag, words] of Object.entries(c.arity)) assert.ok(row[2].includes(`\`${flag}\` (${words} words)`), `${c.command}: ${flag} takes ${words} words`);
    assert.equal((row[2].match(/\(\d+ words\)/g) ?? []).length, Object.keys(c.arity).length, `${c.command}: only a flag of more than one word says so`);
    assert.deepEqual(cells(row[3]), c.switches, `${c.command}: switches`);
    assert.deepEqual(cells(row[4]), Object.keys(c.refused ?? {}), `${c.command}: refused in their own words`);
    // A row that answers in its own words (`unknown`, `extra`) says which.
    assert.equal(row[5], [c.unknown && "an unknown flag", c.extra && "an argument after the last"].filter(Boolean).join(", ") || "none", `${c.command}: its own answers`);
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
