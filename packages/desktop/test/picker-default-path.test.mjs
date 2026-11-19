// Native picker starting directories (awebai/oats#460): the pure decision
// main.mjs passes as showOpenDialog's defaultPath.
import test from "node:test";
import assert from "node:assert/strict";
import { pickerDefaultPath, workspacePickerCandidates, cliPickerCandidates, parseLastWorkspaceParent, lastWorkspaceParentState } from "../picker-default-path.mjs";

const HOME = "/Users/alex";
const existing = (...dirs) => (dir) => dirs.includes(dir);

test("workspace picker opens in the remembered parent of the last added or opened workspace", () => {
  // main.mjs writes lastWorkspaceParentState on every successful add or open
  // and reads it back on the next pick, including after a relaunch.
  const last = parseLastWorkspaceParent(lastWorkspaceParentState("/Users/alex/Agents/team-b"));
  assert.equal(last, "/Users/alex/Agents");
  const candidates = workspacePickerCandidates({ last, open: ["/Users/alex/work/team-a"] });
  assert.equal(candidates[0], "/Users/alex/Agents");
  assert.equal(pickerDefaultPath({ candidates, exists: existing("/Users/alex/Agents", "/Users/alex/work"), home: HOME }),
    "/Users/alex/Agents");
});

test("a newer open beats an older add: the remembered parent outranks the open set", () => {
  // Add /prior/team-a, relaunch with --dir /new/team-b (or re-pick an already
  // open workspace): the restored open set is startup-first, so only the
  // remembered parent knows which is newest.
  const candidates = workspacePickerCandidates({
    last: parseLastWorkspaceParent(lastWorkspaceParentState("/prior/team-a")),
    open: ["/new/team-b", "/prior/team-a"],
  });
  assert.equal(pickerDefaultPath({ candidates, exists: () => true, home: HOME }), "/prior");
});

test("without a remembered parent, the open set's parents, each once (recents are never read, #1390)", () => {
  assert.deepEqual(workspacePickerCandidates({ open: ["/c/ws", "/a/ws", "/c/other"] }), ["/c", "/a"]);
  assert.deepEqual(workspacePickerCandidates({ recents: ["/a/ws"], open: [] }), [], "a recents argument is not read");
});

test("malformed remembered state is ignored", () => {
  for (const raw of ["", "not json", "null", "[]", "{}", '{"parent":"relative"}', '{"parent":7}']) {
    assert.equal(parseLastWorkspaceParent(raw), null, raw);
  }
});

test("a remembered directory that no longer exists falls through to the next candidate", () => {
  const candidates = workspacePickerCandidates({ last: "/Volumes/gone", open: ["/Users/alex/work/team-a"] });
  assert.equal(pickerDefaultPath({ candidates, exists: existing("/Users/alex/work"), home: HOME }), "/Users/alex/work");
  const throwing = (dir) => { if (dir === "/Volumes/gone") throw new Error("EACCES"); return dir === "/Users/alex/work"; };
  assert.equal(pickerDefaultPath({ candidates, exists: throwing, home: HOME }), "/Users/alex/work");
});

test("no history opens the home directory", () => {
  const candidates = workspacePickerCandidates({ open: [] });
  assert.deepEqual(candidates, []);
  assert.equal(pickerDefaultPath({ candidates, exists: () => true, home: HOME }), HOME);
  assert.equal(pickerDefaultPath({ candidates: ["/Users/alex/gone"], exists: () => false, home: HOME }), HOME);
});

test("never returns ~/Downloads, the location the OS would otherwise reuse", () => {
  const all = () => true;
  assert.notEqual(pickerDefaultPath({ candidates: [], exists: all, home: HOME }), `${HOME}/Downloads`);
  const fromRecent = workspacePickerCandidates({ open: [`${HOME}/Downloads/team`] });
  assert.equal(pickerDefaultPath({ candidates: fromRecent, exists: all, home: HOME }), HOME);
  assert.equal(pickerDefaultPath({ candidates: [`${HOME}/Downloads`, "/srv"], exists: all, home: HOME }), "/srv");
});

test("relative, empty and non-string candidates are ignored", () => {
  assert.equal(pickerDefaultPath({ candidates: [null, undefined, "", "relative/dir", 7], exists: () => true, home: HOME }), HOME);
  assert.deepEqual(workspacePickerCandidates({ open: ["relative", null, 42] }), []);
});

test("CLI picker opens in the chosen CLI's directory, then the resolved one's, else home", () => {
  const both = cliPickerCandidates({ chosen: "/opt/homebrew/bin/oats", resolved: "/Users/alex/.npm-global/bin/oats" });
  assert.deepEqual(both, ["/opt/homebrew/bin", "/Users/alex/.npm-global/bin"]);
  assert.equal(pickerDefaultPath({ candidates: both, exists: () => true, home: HOME }), "/opt/homebrew/bin");
  assert.equal(pickerDefaultPath({ candidates: both, exists: existing("/Users/alex/.npm-global/bin"), home: HOME }),
    "/Users/alex/.npm-global/bin");
  const resolvedOnly = cliPickerCandidates({ chosen: null, resolved: "/usr/local/bin/oats" });
  assert.equal(pickerDefaultPath({ candidates: resolvedOnly, exists: () => true, home: HOME }), "/usr/local/bin");
  assert.equal(pickerDefaultPath({ candidates: cliPickerCandidates({}), exists: () => true, home: HOME }), HOME);
  assert.deepEqual(cliPickerCandidates({ chosen: "/usr/local/bin/oats", resolved: "/usr/local/bin/oats" }), ["/usr/local/bin"]);
});
