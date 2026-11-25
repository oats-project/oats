import assert from "node:assert/strict";
import test from "node:test";
import { loadSqlite } from "../lib/node-sqlite.mjs";

test("missing node:sqlite names the turn record's Node requirement and preserves the cause", () => {
  const cause = Object.assign(new Error("No such built-in module: node:sqlite"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
  assert.throws(() => loadSqlite((name) => {
    assert.equal(name, "node:sqlite");
    throw cause;
  }), (error) => {
    assert.equal(error.message, `the turn record needs node:sqlite: use Node 22.13+ on 22.x, 23.4+ on 23.x, or a newer major (this is Node ${process.versions.node})`);
    assert.equal(error.cause, cause);
    return true;
  });
});
