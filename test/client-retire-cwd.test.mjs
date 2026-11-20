// Where a client's stop and retire run from (spec C1; the kernel's retire of a session provider's home refuses
// while any process works in that home, the caller's own included): the CLI child both clients start for a
// lifecycle plan or apply (packages/client/lifecycle-cli.mjs `cliLifecycle`, through instance-lifecycle.mjs) runs
// in the admitted `context`, which for a row of this machine is its deployment's directory
// (instance-admission.mjs `admitInstance`: `workspace.scope`), never the home being retired nor a directory in it.
// A home is always below its deployment (deployment-data.mjs withholds any other row), so the two cannot meet.
//
// It imports packages/client only, so it runs on a root-only checkout with nothing installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deploymentStatusData } from "../packages/client/deployment-data.mjs";
import { rosterRows, panelInstances } from "../packages/client/deployment-panel.mjs";
import { admitInstance } from "../packages/client/instance-admission.mjs";
import { cliLifecycle, lifecycleArgv } from "../packages/client/lifecycle-cli.mjs";

const DEPLOYMENT = "/d";
const CLI = { ok: true, bin: "/opt/oats/bin/oats", features: ["status-liveness"], remote: [] };
const WORKSPACE = { id: DEPLOYMENT, scope: DEPLOYMENT };
const within = (path, dir) => path === dir || path.startsWith(`${dir}/`);
const rowsOf = (instances) => panelInstances(rosterRows(deploymentStatusData({ root: `${DEPLOYMENT}/agents`, agents: [{ name: "dev", dir: `${DEPLOYMENT}/agents/dev`, instances }] }, DEPLOYMENT), CLI), []);
const kernelRow = (name, extra = {}) => ({ instance: name, home: `${DEPLOYMENT}/agents/dev/instances/${name}`, running: true, ...extra });
const KEY = "0123456789abcdef0123456789abcdef", REVISION = "a".repeat(24);

test("a stop's or a retire's plan and apply run in the row's deployment directory, never in the home or below it: a tmux row and a session provider's alike", async () => {
  const rows = rowsOf([kernelRow("dev-t", { tmux: { session: "oats", window: "dev-t", socket: "/s" } }), kernelRow("dev-bb", { backend: "bb", tmux: null, session: { provider: "oats.bb", threadId: "thr_x" } })]);
  for (const row of rows) {
    const admitted = admitInstance({ instance: row.instance, agent: row.agent, agentsRoot: row.agentsRoot }, { workspace: WORKSPACE, instances: rows, cli: CLI, operation: "lifecycle-plans" });
    assert.equal(admitted.context, DEPLOYMENT, row.instance);
    assert.equal(admitted.target.home, row.home);
    assert.equal(within(admitted.context, admitted.target.home), false, `${row.instance}: the directory the CLI runs in is not the home, nor inside it`);
    assert.equal(within(admitted.target.home, admitted.context), true, `${row.instance}: the home is below it`);
    for (const operation of ["stop", "retire"]) for (const phase of ["plan", "apply"]) {
      const options = { operation, phase, instance: admitted.target.instance, home: admitted.target.home, context: admitted.context, choices: operation === "stop" ? { recursive: true } : { discardWorktree: false },
        ...(phase === "apply" ? { revision: REVISION, key: KEY } : {}) };
      const argv = lifecycleArgv(options);
      assert.ok(argv, `${operation} ${phase}: an argv`);
      assert.deepEqual(argv.slice(argv.indexOf("--home"), argv.indexOf("--home") + 4), ["--home", row.home, "--dir", DEPLOYMENT]);
      let ran = null;
      await cliLifecycle(CLI.bin, options, { exec: (bin, args, opts, done) => { ran = { bin, args, opts }; done(null, JSON.stringify({ schemaVersion: 1, ok: false, error: { code: "E_TEST" } })); } });
      assert.equal(ran.opts.cwd, DEPLOYMENT, `${operation} ${phase} of ${row.instance} runs in the deployment's directory`);
      assert.equal(within(ran.opts.cwd, row.home), false);
    }
  }
});

test("a row whose home is not below its soul's directory in the deployment never reaches a client, so no deployment directory can be inside a home", () => {
  const status = { root: `${DEPLOYMENT}/agents`, agents: [{ name: "dev", dir: `${DEPLOYMENT}/agents/dev`, instances: [
    { instance: "d", home: DEPLOYMENT, running: true }, { instance: "up", home: "/", running: true }, kernelRow("dev-a")] }] };
  const data = deploymentStatusData(status, DEPLOYMENT);
  assert.deepEqual(data.agents[0].instances.map((row) => row.instance), ["dev-a"]);
  assert.deepEqual(data.withheld.map((row) => [row.instance, row.reason]), [["d", "home-outside-soul"], ["up", "home-outside-soul"]]);
});
