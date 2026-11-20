// The team verbs' writes to oats-local.yaml (lib/teams-verbs.mjs): surgical (comments and styles kept on
// everything the edit does not change) and from the file as it is NOW (never the command's snapshot).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { selfIdentity } from "../lib/worktree-hooks.mjs";
import YAML from "yaml";
import { teamsAdd, teamsDefault, teamsRemove } from "../lib/teams-verbs.mjs";

const HEAD = "schemaVersion: 2\nworkspace: git:github.com/acme/agents\n";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const WORKSPACE = { schemaVersion: 2, name: "acme", teams: { oats: { team: "oats:oats.aweb.ai" } }, localTeams: true };
function fixture(t, text, workspace = WORKSPACE) {
  const dir = mkdtempSync(join(tmpdir(), "oats-teams-verbs-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const localPath = join(dir, "oats-local.yaml");
  writeFileSync(localPath, HEAD + text);
  const ctx = () => ({ deployment: dir, localPath, local: YAML.parse(readFileSync(localPath, "utf8")), workspace, workspaceKey: "github.com/acme/agents" });
  return { localPath, ctx, text: () => readFileSync(localPath, "utf8") };
}

test("an edit touches only what changes: inline comments on sibling entries survive", (t) => {
  const fx = fixture(t, [
    "teams:",
    "  mine: { team: \"mine:me.aweb.ai\" }   # my own team",
    "  spare:",
    "    team: spare:me.aweb.ai            # the spare id",
    "    description: Spare                # keep me",
    "  gone: { team: \"gone:me.aweb.ai\" }   # removed below",
    "defaultTeam: mine                     # the default",
    "souls:",
    "  disabled: [old]                     # not a team key",
    "",
  ].join("\n"));
  teamsAdd(fx.ctx(), "third", { team: "third:me.aweb.ai" });
  teamsRemove(fx.ctx(), "gone");
  teamsDefault(fx.ctx(), "spare");
  const out = fx.text();
  for (const c of ["# my own team", "# the spare id", "# keep me", "# not a team key"]) assert.ok(out.includes(c), `${c} kept:\n${out}`);
  assert.equal(out.includes("# removed below"), false, "the removed entry's own comment goes with it");
  assert.deepEqual(YAML.parse(out), { schemaVersion: 2, workspace: "git:github.com/acme/agents",
    teams: { mine: { team: "mine:me.aweb.ai" }, spare: { team: "spare:me.aweb.ai", description: "Spare" }, third: { team: "third:me.aweb.ai" } },
    defaultTeam: "spare", souls: { disabled: ["old"] } });
  // (The YAML library normalises the spacing before an inline comment; the comment and the flow map stay.)
  assert.ok(out.startsWith(HEAD + "teams:\n  mine: { team: \"mine:me.aweb.ai\" } # my own team\n"), out);
});

test("a long line elsewhere in the file is not re-wrapped: a plain value past 80 columns comes back byte for byte", (t) => {
  const long = `    PROMPT: ${"a value well past eighty columns ".repeat(4)}that a folding writer would wrap onto a second line`;
  const rest = ["settings:", "  acme.tool:", long, "clones:", "  github.com/acme/platform: /srv/checkouts/platform # where the clone is", ""].join("\n");
  const fx = fixture(t, `teams:\n  mine: { team: "mine:me.aweb.ai" }\ndefaultTeam: mine\n${rest}`);
  assert.ok(long.length > 160);
  teamsAdd(fx.ctx(), "third", { team: "third:me.aweb.ai" });
  assert.equal(fx.text(), `${HEAD}teams:\n  mine: { team: "mine:me.aweb.ai" }\n  third:\n    team: third:me.aweb.ai\ndefaultTeam: mine\n${rest}`);
  teamsDefault(fx.ctx(), "third");
  teamsRemove(fx.ctx(), "mine");
  assert.equal(fx.text(), `${HEAD}teams:\n  third:\n    team: third:me.aweb.ai\ndefaultTeam: third\n${rest}`, "the same after default and remove");
});

test("a verb works from the file as it is NOW: a stale snapshot never drops another write, and its refusals see the current file", (t) => {
  const fx = fixture(t, "teams:\n  mine: { team: \"mine:me.aweb.ai\" }\ndefaultTeam: mine\n");
  const stale = fx.ctx();
  // Another verb writes after this command read the file.
  teamsAdd(fx.ctx(), "other", { team: "other:me.aweb.ai" });
  teamsAdd(stale, "third", { team: "third:me.aweb.ai" });
  assert.deepEqual(Object.keys(YAML.parse(fx.text()).teams), ["mine", "other", "third"], "both writes are kept");
  // The stale snapshot's default is mine: removing `other`, now the default, is still judged on the current file.
  teamsDefault(fx.ctx(), "other");
  assert.throws(() => teamsRemove(stale, "other"), (e) => e.code === "E_TEAM_IN_USE" && e.details.usedBy.includes("defaultTeam"));
  assert.throws(() => teamsAdd(stale, "other", { team: "x:y" }), (e) => e.code === "E_TEAM_EXISTS" && e.details.from === "local");
  teamsDefault(stale, "mine");
  assert.equal(YAML.parse(fx.text()).defaultTeam, "mine");
});

test("where the workspace does not allow local teams, add and default are refused (local-teams-closed, nothing written); remove is allowed", (t) => {
  const FIX = "either (a) add `localTeams: true` to oats-workspace.yaml, or (b) commit the teams and defaultTeam in oats-workspace.yaml, then remove them from oats-local.yaml";
  for (const workspace of [{ ...WORKSPACE, localTeams: false }, { schemaVersion: 2, name: "acme", teams: WORKSPACE.teams }]) {
    const fx = fixture(t, "teams:\n  mine: { team: \"mine:me.aweb.ai\" }\n  spare: { team: \"spare:me.aweb.ai\" }\n", workspace);
    const before = fx.text();
    assert.throws(() => teamsAdd(fx.ctx(), "third", { team: "third:me.aweb.ai" }), (e) => {
      assert.deepEqual([e.code, e.details], ["E_WORKSPACE_SCHEMA", { reason: "local-teams-closed", path: "oats-local.yaml", keys: ["teams"] }]);
      assert.equal(e.message, `oats teams add writes teams in oats-local.yaml, but oats-workspace.yaml does not allow local teams (localTeams: true): ${FIX}`);
      return true;
    });
    assert.throws(() => teamsDefault(fx.ctx(), "oats"), (e) => e.code === "E_WORKSPACE_SCHEMA" && e.details.reason === "local-teams-closed" && e.details.keys[0] === "defaultTeam");
    assert.equal(fx.text(), before, "nothing was written");
    // Removing local teams moves the file toward what the workspace allows (fix b's last step).
    assert.equal(teamsRemove(fx.ctx(), "mine").changed, true);
    assert.equal(teamsRemove(fx.ctx(), "spare").changed, true);
    assert.equal(YAML.parse(fx.text()).teams, undefined);
  }
  // The standalone view (no workspace file) has no workspace rules.
  const fx = fixture(t, "", null);
  assert.equal(teamsAdd(fx.ctx(), "mine", { team: "mine:me.aweb.ai" }).changed, true);
});

/* ── conditional default (--if-absent / --expect) and mapping-only add (--no-default), awebai/oats#771 ── */

const MINE = "teams:\n  mine: { team: \"mine:me.aweb.ai\" }\n  spare: { team: \"spare:me.aweb.ai\" }\n";
const WS_DEFAULT = { ...WORKSPACE, defaultTeam: "oats" };
const mismatch = (expected, observed) => (e) => {
  assert.deepEqual([e.code, e.details], ["E_TEAM_DEFAULT_MISMATCH", { expected, observed }]);
  return true;
};

test("default --if-absent sets the default only where there is no effective default", (t) => {
  const fx = fixture(t, MINE);
  const r = teamsDefault(fx.ctx(), "spare", { ifAbsent: true });
  assert.equal(r.changed, true);
  assert.equal(YAML.parse(fx.text()).defaultTeam, "spare");
});

test("default --if-absent over an established local default refuses, naming it and its source, and writes nothing", (t) => {
  const fx = fixture(t, `${MINE}defaultTeam: mine\n`);
  const before = fx.text();
  assert.throws(() => teamsDefault(fx.ctx(), "spare", { ifAbsent: true }), (e) => {
    mismatch({ absent: true }, { label: "mine", team: "mine:me.aweb.ai", from: "deployment" })(e);
    assert.match(e.message, /\bmine\b/); assert.match(e.message, /deployment/); assert.match(e.message, /nothing was written/);
    return true;
  });
  assert.equal(fx.text(), before, "byte-identical");
});

test("an inherited workspace default: --if-absent refuses (from workspace); --expect <its label> sets the local default", (t) => {
  const fx = fixture(t, MINE, WS_DEFAULT);
  const before = fx.text();
  assert.throws(() => teamsDefault(fx.ctx(), "mine", { ifAbsent: true }), (e) => {
    mismatch({ absent: true }, { label: "oats", team: "oats:oats.aweb.ai", from: "workspace" })(e);
    assert.match(e.message, /\boats\b/); assert.match(e.message, /workspace/);
    return true;
  });
  assert.equal(fx.text(), before);
  assert.equal(teamsDefault(fx.ctx(), "mine", { expect: "oats" }).changed, true);
  assert.equal(YAML.parse(fx.text()).defaultTeam, "mine");
});

test("default --expect: a mismatch (or no default at all) refuses and writes nothing; a match already in place is changed: false", (t) => {
  const fx = fixture(t, `${MINE}defaultTeam: mine\n`);
  const before = fx.text();
  assert.throws(() => teamsDefault(fx.ctx(), "spare", { expect: "oats" }), mismatch({ label: "oats" }, { label: "mine", team: "mine:me.aweb.ai", from: "deployment" }));
  assert.equal(fx.text(), before);
  assert.equal(teamsDefault(fx.ctx(), "mine", { expect: "mine" }).changed, false);
  assert.equal(fx.text(), before);
  const none = fixture(t, MINE);
  const noneBefore = none.text();
  assert.throws(() => teamsDefault(none.ctx(), "mine", { expect: "mine" }), mismatch({ label: "mine" }, null));
  assert.equal(none.text(), noneBefore);
});

test("default: --if-absent and --expect together are E_BAD_ARGS", (t) => {
  const fx = fixture(t, MINE);
  const before = fx.text();
  assert.throws(() => teamsDefault(fx.ctx(), "mine", { ifAbsent: true, expect: "mine" }), (e) => e.code === "E_BAD_ARGS");
  assert.equal(fx.text(), before);
});

test("the existing refusals run before the precondition: local-teams-closed, then E_TEAM_UNKNOWN", (t) => {
  const closed = fixture(t, "", { ...WS_DEFAULT, localTeams: false });
  const before = closed.text();
  assert.throws(() => teamsDefault(closed.ctx(), "oats", { ifAbsent: true }), (e) => e.code === "E_WORKSPACE_SCHEMA" && e.details.reason === "local-teams-closed");
  assert.throws(() => teamsDefault(closed.ctx(), "oats", { expect: "nope" }), (e) => e.code === "E_WORKSPACE_SCHEMA" && e.details.reason === "local-teams-closed");
  assert.equal(closed.text(), before);
  const fx = fixture(t, `${MINE}defaultTeam: mine\n`);
  assert.throws(() => teamsDefault(fx.ctx(), "ghost", { ifAbsent: true }), (e) => e.code === "E_TEAM_UNKNOWN");
});

test("the precondition is judged on the file as it is NOW, never the command's snapshot", (t) => {
  const fx = fixture(t, MINE);
  const stale = fx.ctx();
  teamsDefault(fx.ctx(), "mine");
  assert.throws(() => teamsDefault(stale, "spare", { ifAbsent: true }), mismatch({ absent: true }, { label: "mine", team: "mine:me.aweb.ai", from: "deployment" }));
  assert.equal(YAML.parse(fx.text()).defaultTeam, "mine");
});

test("add --no-default writes the mapping and never the default; an exact repeat (local or shared) is reuse; another id is E_TEAM_EXISTS with observed", (t) => {
  const fx = fixture(t, "");
  const r = teamsAdd(fx.ctx(), "mine", { team: "mine:me.aweb.ai", noDefault: true });
  assert.deepEqual([r.changed, r.reused], [true, undefined]);
  assert.deepEqual(YAML.parse(fx.text()).teams, { mine: { team: "mine:me.aweb.ai" } });
  assert.equal(YAML.parse(fx.text()).defaultTeam, undefined, "no default written even where none is in effect");
  const before = fx.text();
  for (const [label, team] of [["mine", "mine:me.aweb.ai"], ["oats", "oats:oats.aweb.ai"]]) {
    const again = teamsAdd(fx.ctx(), label, { team, noDefault: true });
    assert.deepEqual([again.changed, again.reused], [false, true], `${label}: reuse`);
  }
  assert.equal(fx.text(), before);
  assert.throws(() => teamsAdd(fx.ctx(), "mine", { team: "other:me.aweb.ai", noDefault: true }), (e) => {
    assert.deepEqual([e.code, e.details], ["E_TEAM_EXISTS", { label: "mine", from: "local", observed: { label: "mine", team: "mine:me.aweb.ai", from: "local" } }]);
    return true;
  });
  assert.throws(() => teamsAdd(fx.ctx(), "oats", { team: "other:x.aweb.ai", noDefault: true }), (e) => e.code === "E_TEAM_EXISTS" && same(e.details.observed, { label: "oats", team: "oats:oats.aweb.ai", from: "shared" }));
  assert.equal(fx.text(), before);
});

test("plain add and default are unchanged: the first add becomes the default, even over a workspace default; an exact duplicate is E_TEAM_EXISTS", (t) => {
  const fx = fixture(t, "", WS_DEFAULT);
  assert.equal(teamsAdd(fx.ctx(), "mine", { team: "mine:me.aweb.ai" }).changed, true);
  assert.equal(YAML.parse(fx.text()).defaultTeam, "mine");
  assert.throws(() => teamsAdd(fx.ctx(), "mine", { team: "mine:me.aweb.ai" }), (e) => e.code === "E_TEAM_EXISTS");
  assert.throws(() => teamsAdd(fx.ctx(), "oats", { team: "oats:oats.aweb.ai" }), (e) => e.code === "E_TEAM_EXISTS");
  teamsAdd(fx.ctx(), "spare", { team: "spare:me.aweb.ai" });
  assert.equal(teamsDefault(fx.ctx(), "spare").changed, true);
  assert.equal(YAML.parse(fx.text()).defaultTeam, "spare");
});

test("every mutation runs under <deployment>/.agents/locks/local.lock: one held elsewhere is E_LOCAL_BUSY, nothing written, the lock left alone", (t) => {
  const fx = fixture(t, MINE);
  const lock = join(fx.ctx().deployment, ".agents", "locks", "local.lock");
  mkdirSync(dirname(lock), { recursive: true });
  const held = JSON.stringify({ ...selfIdentity(), nonce: "a".repeat(32), at: new Date().toISOString(), what: "a test" }) + "\n";
  writeFileSync(lock, held);
  const before = fx.text();
  assert.throws(() => teamsDefault(fx.ctx(), "mine", { ifAbsent: true }), (e) => {
    assert.equal(e.code, "E_LOCAL_BUSY");
    assert.ok(e.message.includes(lock), e.message);
    assert.match(e.message, /nothing was (written|changed)/);
    return true;
  });
  assert.equal(fx.text(), before);
  assert.equal(readFileSync(lock, "utf8"), held, "the holder's lock is not touched");
  rmSync(lock);
  assert.equal(teamsRemove(fx.ctx(), "spare").changed, true);
  assert.equal(existsSync(lock), false, "released after the write");
});
