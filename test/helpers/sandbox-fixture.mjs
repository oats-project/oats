// The sandboxes fixture: one workspace-model deployment (test/helpers/v2-deployment.mjs) whose workspace
// declares sandbox `ingest` for team `ingest-team`, places soul `ingester` in it (its default team), keeps
// soul `dev` on the host, and composes the fake sandbox provider (test/helpers/fake-sandbox-provider.mjs).
// Its oats-local.yaml lists `ingest` and gives its credential, unless the test says otherwise.
import { mkdirSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { join } from "node:path";
import { v2Deployment } from "./v2-deployment.mjs";
import { fakeSandboxCapabilities, fakeSandboxState } from "./fake-sandbox-provider.mjs";

export const TEAM_ID = "ingest:example.org";

/** opts: { workspace (merged over the sandbox workspace), local (replaces the default local keys
 *  when given), souls, capabilities (added), t } → fx with `sandbox` (the fake's state), `cliS(args, env)`
 *  (the CLI with the fake's env) and `credential` (the credential file's path). */
export function sandboxDeployment({ workspace = {}, local, souls = { dev: {}, ingester: {} }, capabilities = {}, t } = {}) {
  const { teams = {}, souls: soulTeams = {}, sandboxes, defaults = {}, ...rest } = workspace;
  const fx = v2Deployment({ t, souls, capabilities: { ...fakeSandboxCapabilities(), ...capabilities }, local: {} });
  // A workspace default names the member by its repo key, which exists only once the fixture does.
  fx.workspace = (over = {}) => ({
    schemaVersion: 2, name: "fixture", members: [fx.ref],
    teams: { global: { description: "Fixture team" }, "ingest-team": { team: TEAM_ID }, ...teams },
    souls: { "ws/ingester": { default: "ingest-team" }, ...soulTeams },
    sandboxes: sandboxes ?? { ingest: { team: "ingest-team", egress: ["model"], credentials: ["sources-read"] } },
    defaults: { knowledge: "none", messaging: "none", tasks: "none", ...defaults, capabilities: { "fixture.sandbox": { from: fx.key }, ...(defaults.capabilities || {}) } },
    ...rest, ...over,
  });
  fx.commitWorkspace = (doc) => fx.commit({ "oats-workspace.yaml": { yaml: doc } }, "the sandboxes workspace");
  fx.commitWorkspace(fx.workspace());
  const credDir = join(fx.base, "creds");
  mkdirSync(credDir, { recursive: true });
  const credential = join(credDir, "sources-read");
  writeFileSync(credential, "token\n", { mode: 0o600 });
  fx.credential = credential;
  fx.sandbox = fakeSandboxState(join(fx.base, "fake-sandbox"));
  fx.writeLocal = (keys) => writeFileSync(join(fx.dep, "oats-local.yaml"), YAML.stringify({ schemaVersion: 2, workspace: fx.ref, ...keys }, { lineWidth: 0 }));
  fx.cliS = (args, env = {}) => fx.cli(args, { env: { ...fx.sandbox.env, ...env } });
  fx.writeLocal(local ?? { host: { name: "cloud-1" }, sandboxes: ["ingest"], credentials: { "sources-read": { fromFile: credential } } });
  return fx;
}
