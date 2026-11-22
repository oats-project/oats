// The two text facts of a roster row (packages/client/roster-row-facts.mjs), shared by the Desktop's sidebar and,
// later, the Terminal UI's: line 1 the display name, line 2 `<soul>`, with ` · <machine>` for another machine's row (the
// Desktop UI rework, slice 1; slice 3d: this machine's name only where it says something, as the prototype has it).
import test from "node:test";
import assert from "node:assert/strict";
import { rosterRowFacts, rowMachine } from "../packages/client/roster-row-facts.mjs";
import { clientTerms } from "../packages/client/client-terms.mjs";

const TERMS = clientTerms({ name: "Client", self: "this client", selfInitial: "This client", update: "the client", thisMachine: "Here" });

test("slice1 shared row facts", () => {
  // A running local row: its soul alone (slice 3d); the machine is still given, and that it is this one.
  assert.deepEqual(rosterRowFacts({ instance: "desktop-mockups", agent: "oats-desktop-developer", running: true, repoName: "oats", harness: "claude" }, TERMS),
    { name: "Desktop mockups", detail: "oats-desktop-developer", soul: "oats-desktop-developer", machine: "Here", local: true });
  // A remote row: its server's label, whatever its state (a machine that didn't answer keeps both lines).
  assert.deepEqual(rosterRowFacts({ instance: "release-0-68", agent: "reviewer", server: "srv-1", repoName: "build-host", running: null, serverUnreached: true }, TERMS),
    { name: "Release 0 68", detail: "reviewer · build-host", soul: "reviewer", machine: "build-host", local: false });
  // A row with no soul known: the machine alone.
  assert.deepEqual(rosterRowFacts({ instance: "forgotten-one", running: false }, TERMS),
    { name: "Forgotten one", detail: "Here", soul: null, machine: "Here", local: true });
});

test("the machine: a tagged deployment's machine; else a server's label, else its id; else this machine", () => {
  assert.equal(rowMachine({ server: "srv-2" }, TERMS), "srv-2");
  const deployments = [{ id: "/a", machine: null, local: true }, { id: "ssh://b", machine: "build-host", local: false }];
  assert.equal(rowMachine({ deployment: { id: "ssh://b" } }, TERMS, { deployments }), "build-host");
  assert.equal(rowMachine({ deployment: { id: "/a" } }, TERMS, { deployments }), "Here");
  assert.equal(rowMachine({ deployment: { id: "/gone" } }, TERMS, { deployments }), "Here");
  // A view's remote row carries `server` and its repository in `repoName`: its deployment's machine comes first.
  assert.equal(rowMachine({ deployment: { id: "ssh://b" }, server: "b-id", repoName: "web" }, TERMS, { deployments }), "build-host");
  assert.equal(rowMachine({ deployment: { id: "/gone" }, server: "b-id", repoName: "label" }, TERMS, { deployments }), "label", "untagged: the server's label");
  assert.equal(rowMachine({}, TERMS), "Here");
  // This machine's own name, when the caller knows it (the kernel's host.name): a local row, and a row of this
  // machine's own deployment whatever label it carries; a remote row keeps its own; an unusable name falls back.
  assert.equal(rowMachine({}, TERMS, { here: "falcon" }), "falcon");
  assert.equal(rowMachine({ deployment: { id: "/a" } }, TERMS, { deployments: [{ id: "/a", machine: "Here", local: true }], here: "falcon" }), "falcon");
  assert.equal(rowMachine({ deployment: { id: "ssh://b" } }, TERMS, { deployments, here: "falcon" }), "build-host");
  assert.equal(rowMachine({ server: "srv-2" }, TERMS, { here: "falcon" }), "srv-2");
  assert.equal(rowMachine({}, TERMS, { here: "" }), "Here"); assert.equal(rowMachine({}, TERMS, { here: "a\u0000b" }), "Here");
  assert.equal(rosterRowFacts({ instance: "x", agent: "s" }, TERMS, { here: "falcon" }).detail, "s", "this machine's row: its soul alone");
  assert.equal(rosterRowFacts({ instance: "x", agent: "s", deployment: { id: "ssh://b" } }, TERMS, { deployments, here: "falcon" }).detail, "s · build-host");
});

test("only display lines: a withheld or multi-line soul or label never reaches the row", () => {
  assert.equal(rosterRowFacts({ instance: "x", agent: "token=abcdef" }, TERMS).detail, "Here");
  assert.equal(rosterRowFacts({ instance: "x", agent: "two\nlines" }, TERMS).soul, "two lines");
  assert.equal(rosterRowFacts({ instance: "x", agent: 7 }, TERMS).soul, null);
  // A name that is all dashes keeps the name as reported; no name is the empty string.
  assert.equal(rosterRowFacts({ instance: "--", agent: "s" }, TERMS).name, "--");
  assert.equal(rosterRowFacts({}, TERMS).name, "");
});

test("terms are required: the client's own, never a default", () => {
  assert.throws(() => rosterRowFacts({ instance: "x" }, { thisMachine: "Here" }), /rosterRowFacts: terms must be/);
});
