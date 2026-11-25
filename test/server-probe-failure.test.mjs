// A host's version refusal must survive both routing and server-connect probes.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { checkRemote, connectServer } from "../lib/servers.mjs";
import { fixtureBase } from "./helpers/host-fixture.mjs";

const failure = {
  schemaVersion: 1, ok: false,
  error: {
    code: "E_NODE_UNSUPPORTED",
    message: "oats needs Node.js 22 or later; this is Node.js 20.19.0",
    details: { found: "20.19.0", minimum: "22" },
  },
};
const target = { sshHost: "fixture-host", workspace: "/srv/workspace", oatsPath: "oats", path: "/fixture/bin" };

function isolatedHome(t) {
  const previous = process.env.OATS_HOME_DIR;
  const home = fixtureBase("opf-"); // Leave room for SSH's expanded control socket path.
  process.env.OATS_HOME_DIR = home;
  t.after(() => {
    if (previous === undefined) delete process.env.OATS_HOME_DIR;
    else process.env.OATS_HOME_DIR = previous;
    rmSync(home, { recursive: true, force: true });
  });
}

function rejectedProbe() {
  throw Object.assign(new Error("remote exited 1"), { status: 1, stdout: JSON.stringify(failure), stderr: "" });
}

test("routing version probe relays the host's failure code, message and details", (t) => {
  isolatedHome(t);
  const commands = [];
  const execFileSync = (_bin, argv) => {
    commands.push(argv.at(-1));
    return rejectedProbe();
  };
  assert.throws(() => checkRemote(target, { execFileSync }), (error) => {
    assert.equal(error.code, failure.error.code);
    assert.equal(error.message, failure.error.message);
    assert.deepEqual(error.details, failure.error.details);
    return true;
  });
  assert.equal(commands.length, 1);
  assert.match(commands[0], / version --json$/);
});

test("server connect relays a refused version probe before installation or later steps", (t) => {
  isolatedHome(t);
  const commands = [];
  const execFileSync = (_bin, argv) => {
    const command = argv.at(-1);
    commands.push(command);
    if (command.endsWith(" true")) return "";
    assert.match(command, / version --json$/);
    return rejectedProbe();
  };
  assert.throws(() => connectServer({
    id: "fixture", ...target, workspaceRef: "git:github.com/acme/workspace",
    dir: target.workspace, localVersion: "0.69.0", installOats: true,
  }, { execFileSync }), (error) => {
    assert.equal(error.code, failure.error.code);
    assert.equal(error.message, failure.error.message);
    const { steps, ...details } = error.details;
    assert.deepEqual(details, failure.error.details);
    assert.deepEqual(steps.map(({ step, status }) => [step, status]), [["ssh", "ok"], ["oats", "failed"]]);
    assert.equal(steps[1].code, failure.error.code);
    assert.deepEqual(steps[1].details, failure.error.details);
    return true;
  });
  assert.equal(commands.length, 2, "the SSH check and version probe alone; no npm install or workspace command");
});
