import test from "node:test";
import assert from "node:assert/strict";
import { nodeVersionFailure } from "../lib/node-version.mjs";

test("Node below 22 gets the complete early dispatch failure envelope", () => {
  for (const found of ["18.19.0", "20.19.0"]) {
    assert.deepEqual(nodeVersionFailure(found), {
      schemaVersion: 1, ok: false,
      error: {
        code: "E_NODE_UNSUPPORTED",
        message: `oats needs Node.js 22 or later; this is Node.js ${found}`,
        details: { found, minimum: "22" },
      },
    });
  }
});

test("Node 22 and later pass the startup check", () => {
  for (const found of ["22.0.0", "22.12.0", "24.0.0", "24.12.0"]) {
    assert.equal(nodeVersionFailure(found), null, found);
  }
});
