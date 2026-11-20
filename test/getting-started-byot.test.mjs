// The getting-started skill's own-server (BYOT) branch (#1774, #1775): a new workspace on the
// person's own aweb server gets the team `<workspace>:ND`, created by `oats aweb setup --create`,
// and aw at oats.aweb's published `tested` version, read from aw-compat.json at the catalog's exact
// oats.aweb ref. Hosted keeps the latest aw. On a private AWID registry (#1966) the registry is
// recorded first with `oats aweb setup --registry RG` (awebai/oats-aweb#284), never by
// AWID_REGISTRY_URL. The literals the skill reads are checked here against
// the oats.aweb mirror (mirrors/oats-aweb, a copy of the pinned tag), so they can't drift from
// what the provider prints.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareVersions, parseVersion } from "../mirrors/oats-aweb/lib/aw-floor.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const skill = read("skills/oats-getting-started/SKILL.md");
const flat = skill.replace(/\s+/g, " ");
const catalog = JSON.parse(read("package-catalog.json"));
const provider = read("mirrors/oats-aweb/bin/oats-aweb.mjs");
const section = (from, to) => {
  const start = skill.indexOf(from);
  assert.ok(start !== -1, `missing: ${from}`);
  const end = skill.indexOf(to, start);
  assert.ok(end !== -1, `missing after ${from}: ${to}`);
  return skill.slice(start, end);
};
const step4 = section("## 4. Install OATS Desktop", "## 5. ");
const ownServer = section("   - **Their own aweb server (step 1), in place of the signup.**", "\n3. **Existing workspace");

// The own-server branch's oats.aweb floor: the first release whose `setup --create` takes `--name`
// on a fresh deployment and that publishes aw-compat.json, and the one the VM run proved.
const FLOOR = "v1.42.1";
// On a private registry: the first release with `setup --registry` (awebai/oats-aweb#284), the one
// #1962's VM run 2 proved the registry step on (#1966, issuecomment-7017472134).
const PRIVATE_FLOOR = "v1.43.0";
const semver = (v) => v.replace(/^v/, "").split(".").map(Number);
const atLeast = (v, min) => {
  const a = semver(v), b = semver(min);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

test("step 1 asks hosted or own server, with the three non-secret inputs and the prerequisites", () => {
  assert.ok(flat.includes("**Hosted aweb, or their own aweb server?** The line says \"on aweb's hosted service, unless you run your own aweb server\"; hosted is the default."));
  assert.ok(flat.includes("Keep its second half in your own words too: it is how a person with their own server learns this branch exists."), "the own-server option survives a paraphrase of the line");
  for (const input of ["the namespace domain `ND` they control", "the server's public address `U`", "whether their server uses the public AWID registry"]) assert.ok(flat.includes(input), input);
  // A private registry no longer stops the branch (#1966): step 1 takes its origin RG, and the TXT record must name it.
  assert.ok(flat.includes("When it uses a private registry, ask its address too, the registry origin `RG` (`https://…`, the scheme and host only, with no path), also not a secret. Step 9 records it for this deployment."));
  assert.ok(!flat.includes("this skill stops here"), "no private-registry stop");
  assert.ok(flat.includes("On a private registry, that record must name their registry: a key prepared without `--registry RG` gives a record for the public registry, so tell them to check that its value carries `registry=RG`."), "the _awid TXT names the private registry");
  assert.ok(flat.includes("Answers given in the prompt that started you are used without asking."), "the headless path keeps working");
  for (const prerequisite of ["the namespace's controller key on this computer, for this computer account", "the `_awid.ND` DNS record published for that key", "their server reachable at `U`"]) assert.ok(flat.includes(prerequisite), prerequisite);
  assert.ok(flat.includes("Never offer it on a machine found-list, or for an existing workspace"));
  // The yes names the pinned aw, which replaces only a missing or older one (dec-0d099aabf650's open case, settled (b) on #1962).
  assert.ok(flat.includes("on their own aweb server (step 1) `aw` at the version this OATS release was tested with on such a server, when none is installed or the installed one is older (a newer one is kept)"));
  assert.ok(!flat.includes("in place of any other `aw` installed"), "no unqualified replacement");
});

test("step 4 keeps hosted on the latest aw and pins the own server to oats.aweb's tested aw", () => {
  assert.ok(step4.includes("**On hosted aweb** (the default), the latest `aw`:\n\n```bash\nnpm install -g @awebai/aw && aw version\n```"));
  assert.ok(step4.includes('npm install -g "@awebai/aw@<tested>" && aw version && file -L "$(command -v aw)" && uname -m'));
  assert.match(step4, /`aw version`'s first line must be exactly `aw <tested>`, and the `file`\s+line must name this machine's architecture, the one `uname -m` prints/);
  assert.ok(!/allow-scripts|--ignore-scripts|\bnpm pack\b/.test(step4), "no allow-scripts or tarball pre-check (Juan's side, 5853f141)");
  assert.ok(step4.includes(`older than \`${FLOOR}\``), "the floor the reader enforces is named");
  assert.ok(step4.replace(/\s+/g, " ").includes(`on a private registry, older than \`${PRIVATE_FLOOR}\`, the first that records the registry (\`oats aweb setup --registry\`)`), "the private floor is named");
  assert.ok(flat.includes("On a private registry (step 1), add ` private` at the end of the line, after the catalog's path: that branch needs a later `oats.aweb`."));
  assert.ok(atLeast(catalog.packages["oats.aweb"].ref, FLOOR), "the catalog's oats.aweb is at or above the own-server floor, so this release offers the branch");
  assert.ok(atLeast(catalog.packages["oats.aweb"].ref, PRIVATE_FLOOR), "and at or above the private-registry floor, so it offers that branch too");
});

test("the tested-version reader reads aw-compat.json at the catalog's ref, never main, and refuses what it can't trust", (t) => {
  const readers = [...step4.matchAll(/^node -e '(.+)' "\$\(oats root\)\/package-catalog\.json"$/gm)].map((m) => m[1]).filter((s) => s.includes("aw-compat.json"));
  assert.equal(readers.length, 1, "step 4 carries the reader as one node -e line on the installed catalog");
  const [script] = readers;
  assert.ok(!script.includes("main"), "never reads main");
  assert.ok(script.includes("[1,42,1]"), `the reader's floor is ${FLOOR}`);
  assert.ok(script.includes("[1,43,0]"), `the reader's private-registry floor is ${PRIVATE_FLOOR}`);
  // The provider publishes the file at this path; the mirror is its copy at the pinned tag.
  const compat = JSON.parse(read("mirrors/oats-aweb/aw-compat.json"));
  assert.deepEqual(Object.keys(compat).sort(), ["min", "tested"]);
  assert.match(read("mirrors/oats-aweb/lib/aw-floor.mjs"), /new URL\('\.\.\/aw-compat\.json', import\.meta\.url\)/, "the capability's own aw-compat.json, beside lib/");

  const dir = mkdtempSync(join(tmpdir(), "gs-byot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, "fetch-stub.mjs");
  writeFileSync(stub, `globalThis.fetch = async (url) => { process.stderr.write("URL " + url + "\\n"); const body = JSON.parse(process.env.STUB_BODY); return { ok: process.env.STUB_STATUS === "200", status: Number(process.env.STUB_STATUS), json: async () => body }; };\n`);
  const run = (entry, { status = "200", body = compat, args = [] } = {}) => {
    const file = join(dir, `catalog-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify({ ...catalog, packages: { ...catalog.packages, "oats.aweb": { ...catalog.packages["oats.aweb"], ...entry } } }));
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(stub).href, "-e", script, file, ...args], { encoding: "utf8", env: { ...process.env, STUB_STATUS: status, STUB_BODY: JSON.stringify(body) } });
    return { code: r.status, out: r.stdout.trim(), url: (r.stderr.match(/^URL (.+)$/m) || [])[1] };
  };

  const pinned = catalog.packages["oats.aweb"];
  const ok = run({});
  assert.equal(ok.out, `TESTED ${compat.tested}`);
  assert.equal(ok.code, 0);
  const repo = pinned.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  assert.equal(ok.url, `https://raw.githubusercontent.com/${repo}/${pinned.ref}/${pinned.path}/capabilities/oats-aweb/aw-compat.json`, "the exact ref the catalog pins");

  for (const ref of ["v1.42.0", "v1.41.9", "v0.99.0", "fabe460", "main"]) assert.deepEqual([run({ ref }).out, run({ ref }).code], [`TOO_OLD ${ref}`, 1], ref);
  assert.equal(run({ ref: "v1.43.0" }).out, `TESTED ${compat.tested}`, "a newer release passes");
  // The private-registry branch (#1966): ` private` after the catalog raises the floor to v1.43.0; the public floor is unchanged.
  assert.equal(run({ ref: "v1.42.1" }).out, `TESTED ${compat.tested}`, "the public registry keeps v1.42.1");
  for (const ref of ["v1.42.1", "v1.42.9", "v1.41.0", "main"]) assert.deepEqual([run({ ref }, { args: ["private"] }).out, run({ ref }, { args: ["private"] }).code], [`TOO_OLD ${ref}`, 1], `private ${ref}`);
  for (const ref of ["v1.43.0", "v1.43.1", "v1.45.0", "v2.0.0"]) assert.equal(run({ ref }, { args: ["private"] }).out, `TESTED ${compat.tested}`, `private ${ref}`);
  assert.equal(run({}, { args: ["private"] }).out, `TESTED ${compat.tested}`, "the catalog's pin offers the private branch");
  for (const args of [["public"], ["Private"], [""], ["private", "x"]]) assert.deepEqual([run({}, { args }).out, run({}, { args }).code], ["FAILED usage", 1], JSON.stringify(args));
  assert.deepEqual([run({ url: "https://gitlab.com/awebai/oats-aweb.git" }).out, run({ url: "https://gitlab.com/awebai/oats-aweb.git" }).code], ["NOT_GITHUB https://gitlab.com/awebai/oats-aweb.git", 1]);
  assert.match(run({}, { status: "404" }).out, /^FAILED HTTP 404 /, "a catalog older than the file stops the branch");
  assert.match(run({}, { body: { min: "1.36.33", tested: "latest" } }).out, /^FAILED unexpected /, "tested must be an exact version");
  // The reader takes exactly the versions the provider's own parser takes (aw-floor.mjs parseVersion).
  for (const tested of ["1.36.58", "1.36.58-rc.3", "1.36.58-0.a-1", "1.36.58+build.1", "1.36.58-rc.1+b.2", "1.36.58-01", "1.36.58-a..b", "1.36.58-", "01.36.58", "1.36", "1.36.58 ", "1.36.58;x", ["1.36.58"], 1.3658]) {
    const accepted = typeof tested === "string" && parseVersion(tested) !== null;
    assert.equal(run({}, { body: { min: "1.36.33", tested } }).out, accepted ? `TESTED ${tested}` : `FAILED unexpected ${JSON.stringify({ min: "1.36.33", tested })}`, JSON.stringify(tested));
  }
  assert.match(run({}, { body: { min: "1.36.33", tested: "1.36.58", extra: 1 } }).out, /^FAILED unexpected /, "exactly min and tested");
});

test("the installed aw is compared with tested in oats.aweb's own version order: only a missing or older one is replaced", () => {
  const lines = [...step4.matchAll(/^ *node -e '(.+)' "<tested>" "\$\(aw version 2>\/dev\/null \| head -n 1\)"$/gm)].map((m) => m[1]);
  assert.equal(lines.length, 1, "step 4 carries the comparison as one node -e line on <tested> and aw version's first line");
  const [script] = lines;
  const run = (tested, first) => {
    const r = spawnSync(process.execPath, ["-e", script, tested, first], { encoding: "utf8" });
    return { code: r.status, out: r.stdout.trim() };
  };
  // Each outcome has its instruction, and a kept aw is named in the hand-over.
  for (const outcome of ["- **`INSTALL`:** no `aw`, a version it can't read, or one below `<tested>`", "- **`EQUAL <tested>`:** that version is installed already: install nothing.", "- **`NEWER <version>`:** a newer `aw` is installed. Keep it, install nothing, and go on"]) assert.ok(flat.includes(outcome), outcome);
  assert.ok(flat.includes('Keep "aw <version> is newer than the tested <tested>; kept" for the hand-over'));
  assert.ok(flat.includes('namespace ND, registry public | RG (recorded in `settings.oats.aweb.registry`), aw <tested> (oats.aweb\'s tested version) or "aw <version> is newer than the tested <tested>; kept"'), "the hand-over's Messaging line");

  // Agrees with the provider's compareVersions (aw-floor.mjs) on every pair, pre-releases included.
  const versions = ["1.36.33", "1.36.57", "1.36.58-rc.1", "1.36.58-rc.10", "1.36.58-rc.2", "1.36.58-alpha", "1.36.58-1", "1.36.58", "1.36.58+build.7", "1.36.59-rc.3", "1.36.59", "1.37.0", "2.0.0-0"];
  for (const tested of versions) for (const installed of versions) {
    const d = compareVersions(parseVersion(installed), parseVersion(tested));
    const want = d < 0 ? "INSTALL" : d === 0 ? `EQUAL ${installed}` : `NEWER ${installed}`;
    assert.deepEqual(run(tested, `aw ${installed}`), { code: 0, out: want }, `${installed} against ${tested}`);
  }
  // No aw, or a first line it can't read, installs tested; an unreadable tested stops.
  for (const first of ["", "aw", "aw 1.36", "aw v1.36.58", "aw 01.36.58", "aw 1.36.58 extra", "command not found: aw"]) assert.deepEqual(run("1.36.58", first), { code: 0, out: "INSTALL" }, JSON.stringify(first));
  assert.deepEqual(run("latest", "aw 1.36.58"), { code: 1, out: "FAILED tested latest" });
});

test("steps 5 and 7 on the own server: no sign-in, and the team <workspace>:ND is the only team", () => {
  assert.ok(flat.includes("and creates the team on their own aweb server, which has no account to sign in to."), "step 5 is skipped");
  assert.ok(flat.includes("- **On their own aweb server,** the team is `<workspace>:ND` (here `acme:agents.acme.com`)"));
  assert.ok(flat.includes("It is the only team and the default: no `default:…aweb.ai` team anywhere in the file, and no `localTeams`."));
});

test("step 9's own-server form checks the prerequisites read-only, then creates with the provider's own flags", () => {
  // Order: the read-only prerequisite check, then the create; item 5's check-only decides.
  const check = ownServer.indexOf('cd "D" && aw id namespace check-txt --domain ND --json; echo "exit=$?"');
  const create = ownServer.indexOf('cd "D" && AWEB_URL="U" oats aweb setup --soul S --create L --namespace ND --name A\n');
  assert.ok(check !== -1 && create !== -1 && check < create, "check-txt before the create");
  // On a private registry the registry is recorded first (#1966): before item 1's check, which a non-public
  // AWID_REGISTRY_URL already in the environment refuses until the setting exists, and so before check-txt and the create.
  const step9 = section("## 9. Messaging on this machine", "## 10. ");
  const record = step9.indexOf('cd "D" && oats aweb setup --soul S --registry RG\n');
  const item1 = step9.indexOf('cd "D" && oats aweb setup --soul S --check-only --json\n');
  const at = (needle) => step9.indexOf(needle);
  assert.ok(record !== -1 && item1 !== -1 && record < item1, "--registry before item 1's check");
  assert.ok(record < at('cd "D" && aw id namespace check-txt --domain ND --json') && record < at('cd "D" && AWEB_URL="U" oats aweb setup --soul S --create L --namespace ND --name A\n'), "--registry before check-txt and the create");
  assert.equal(skill.split('oats aweb setup --soul S --registry RG').length, 2, "one --registry command");
  assert.ok(flat.includes("**Their own aweb server on a private registry (step 1): record it first,** before item 1, with `RG` written in. Skip this on the public registry and on hosted aweb."));
  assert.ok(flat.includes("oats.aweb refuses a private registry given that way (`registry-setting-required`), item 1's check included, until this setting is recorded."));
  // The provider's check-only reads the registry setting before anything else, and refuses an ambient non-public registry without it.
  assert.match(provider, /const migration = effective \? undefined : registryMigration\(settings\);\n\s*if\(migration\) throw new Error\(migration\);/);
  assert.match(read("mirrors/oats-aweb/lib/registry-setting.mjs"), /if \(Object\.hasOwn\(env, 'AWID_REGISTRY_URL'\) && env\.AWID_REGISTRY_URL !== '' && !publicRegistryLocator\(env\.AWID_REGISTRY_URL\)\) return REGISTRY_MIGRATION;/);
  assert.ok(skill.indexOf(ownServer) > skill.indexOf("## 9. Messaging on this machine"));
  assert.ok(flat.includes("On their own aweb server there is no signup: take \"Their own aweb server\", the last part of this item, instead."), "the hosted signup is skipped");
  // No ambient registry selector: a non-public AWID_REGISTRY_URL is refused from the oats.aweb release with --registry (registry-setting-required).
  assert.ok(!/AWID_REGISTRY_URL=|export AWID_REGISTRY_URL|AWID_REGISTRY_URL="/.test(skill), "the skill never sets AWID_REGISTRY_URL");
  assert.ok(read("mirrors/oats-aweb/lib/registry-setting.mjs").includes("export const REGISTRY_MIGRATION='registry-setting-required: settings.oats.aweb.registry: `oats aweb setup --registry <origin>`;"), "the refusal the skill names");
  assert.ok(read("mirrors/oats-aweb/lib/registry-setting.mjs").includes("export const REGISTRY_SETTING='settings.oats.aweb.registry';"), "the setting the skill names");
  // The --registry act's answers are the provider's.
  assert.ok(provider.includes("usage: oats aweb setup [--registry <origin>]"));
  assert.ok(provider.includes('next:["Restart resident serve: oats aweb resident create <name>", "Restart wake: oats aweb wake install (operator shell)"]'));
  assert.ok(flat.includes("Its `next` lists \"Restart resident serve\" and \"Restart wake\": both are expected and need nothing from you"), "both next steps are expected");
  assert.ok(provider.includes('else console.error(`oats aweb setup: E_SETUP_REGISTRY: ${error.message}`);'));
  assert.ok(flat.includes("An `E_SETUP_REGISTRY` refusal that starts `settings.oats.aweb.registry:` says what is wrong with the address"));
  assert.match(read("mirrors/oats-aweb/lib/registry-setting.mjs"), /const invalid=detail=>\{throw new Error\(`\$\{REGISTRY_SETTING\}: \$\{detail\}`\);\};/, "an address refusal starts with the setting's name");

  // The create's flags and environment are the provider's: no --plan (it needs --username) and no JSON.
  assert.ok(provider.includes("--create <label> [--namespace <domain>] [--name <alias>]"));
  assert.ok(provider.includes('console.error(`oats aweb setup: --label/--plan require --username\\n${usage}`)'), "create has no preview");
  assert.ok(!/--create L --namespace ND --name A --(plan|json)/.test(skill));
  assert.ok(provider.includes("set AWEB_URL to the server's public URL"), "the service comes from AWEB_URL");
  assert.ok(ownServer.includes("There is no preview, and it prints text, not JSON"));

  // Each answer the skill reads is one the provider prints.
  assert.ok(provider.includes("const done = `✓ created ${created.team}, accepted it into ${created.teamRoot}, recorded roots[${created.team}]`;"));
  assert.ok(flat.includes("**Success** prints `✓ created <T>, accepted it into <root>, recorded roots[<T>]`. `<T>` must be step 7's team line, `L:ND`."));
  assert.ok(provider.includes('console.log("  This workspace does not allow local teams; commit the team in oats-workspace.yaml:");'));
  assert.ok(flat.includes("it says the workspace \"does not allow local teams\" and shows `teams:` lines to commit: step 7 committed them already"));
  assert.ok(provider.includes("console.log(`  team key: ${created.teamKeyPath} "));
  assert.ok(flat.includes("The path, never the key, goes in the hand-over."));
  assert.ok(provider.includes("already exists in the registry, and its team key is not on this machine; choose another label"));
  assert.ok(flat.includes("**\"already exists in the registry, and its team key is not on this machine\":** `L:ND` is taken in their namespace, and nothing was created."));
  assert.ok(provider.includes("re-run the same command to resume"));
  assert.ok(flat.includes("**\"re-run the same command to resume\",** or a run that was killed or timed out: run the same line again, unchanged."));
  // The created team id is the label normalized as the workspace name already is, in the lowercased namespace.
  assert.ok(provider.includes("const candidateTeamId = (name) => `${name}:${createNamespace}`;"));
  assert.ok(provider.includes("createNamespace = normalizeAwDomain(args[++i])"));
  assert.match(read("mirrors/oats-aweb/lib/aw-failure-cause.mjs"), /const lower = String\(domain \?\? ""\)\.trim\(\)\.toLowerCase\(\);/);

  // The skill never makes the namespace authority, and never sets a key.
  assert.ok(flat.includes("Never make the key (`aw id namespace prepare-controller`) or touch `~/.awid`."));
  assert.ok(!/^\s*(?:cd "D" && )?aw id namespace prepare-controller/m.test(skill), "no prepare-controller command");
  assert.ok(!ownServer.includes("AWEB_API_KEY"));
  assert.ok(!ownServer.includes("default:"), "no hosted team on the own-server form");
});

test("item 6 on a private registry: a read-only install plan catches a broker that can't carry RG before the person's install", () => {
  const wake = read("mirrors/oats-aweb/lib/wake-service.mjs");
  // The plan runs every refusal the install would, the registry pin included, and changes nothing.
  assert.ok(wake.includes("/** Everything install decides before it changes anything: every refusal, the\n *  unit text and the actions. Runs read-only commands only. */\nasync function prepareInstall(opts, ctx) {"));
  assert.ok(wake.includes('fail("E_WAKE_REGISTRY_CONFLICT",'), "the conflict the plan raises");
  assert.ok(wake.includes('if (!manager) fail("E_WAKE_UNSUPPORTED",'), "no service manager");
  assert.ok(wake.includes("if (opts.plan) return { ok: true, plan: true,"), "a plan writes nothing");
  assert.ok(wake.includes('if (json) print(1, JSON.stringify({ ok: false, ...(opts?.plan ? { plan: true } : {}), error: { code, message } }) + "\\n");'), "the error.code the skill reads");
  // The status the go-on gate reads does not report which registry a running broker serves.
  const status = wake.slice(wake.indexOf("export async function wakeStatus("), wake.indexOf("const lines = (warnings)"));
  assert.ok(status.length > 0 && !/registry/i.test(status), "wake status can't see the pin, so the plan is the check");

  const item6 = section("6. **Codex, or `delivery: session`: the wake broker runs before the spawn.**", "The setup expert does the rest");
  const flat6 = item6.replace(/\s+/g, " ");
  const plan = item6.indexOf('cd "D" && oats aweb wake install --plan --json\n');
  const install = item6.indexOf('cd "D" && oats aweb wake install\n');
  assert.ok(plan !== -1 && install !== -1 && plan < install, "the plan runs before the person's install");
  assert.ok(flat6.includes("**On a private registry (step 1), first check the install yourself,** read-only"));
  assert.ok(flat6.includes("- **`E_WAKE_REGISTRY_CONFLICT`:** this computer account already runs a wake broker for another registry, or for none"));
  assert.ok(flat6.includes("Stop, spawn nothing, and tell the person in plain words; the choice is theirs"), "the conflict goes to the person");
  assert.ok(flat6.includes("Never uninstall the broker or deregister another deployment's homes yourself."));
  // A plain `aw wake run` carries no registry pin: it is the public registry's fallback only.
  assert.ok(flat6.includes("- **`E_WAKE_UNSUPPORTED`** (a container, or a machine with neither launchd nor systemd): there is no service to install, and the plain `aw wake run` below would not carry `RG`. Stop and spawn nothing."));
  assert.ok(flat6.includes("offer a Claude or pi setup expert instead, which its own channel wakes"));
  assert.ok(flat6.includes("on the public registry, the line is `aw wake run`, kept running as a supervised process."));
  // Only a plan that passes lets the private branch go on: any other refusal leaves a running broker that may not carry RG.
  assert.ok(flat6.includes("Only `\"ok\": true` lets you go on to their install below"));
  assert.ok(flat6.includes("- **Any other refusal** (for example a broker started by hand or by another supervisor, `E_WAKE_RUNNING_UNSUPERVISED`, or a service the install didn't write, `E_WAKE_UNIT_CONFLICT`): stop and spawn nothing."));
  assert.ok(flat6.includes("Never stop, uninstall or deregister a broker yourself."));
  assert.ok(!/go on\. Their own install decides/.test(flat6), "a refused plan is never a go-on");
  const prepare = wake.slice(wake.indexOf("async function prepareInstall(opts, ctx) {"), wake.indexOf("if (opts.plan) return { ok: true, plan: true,"));
  for (const code of ["E_WAKE_UNSUPPORTED", "E_WAKE_UNIT_CONFLICT", "E_WAKE_REGISTRY_CONFLICT", "E_WAKE_RUNNING_UNSUPERVISED"]) assert.ok(prepare.includes(code), `the plan refuses ${code} before any change`);
  assert.ok(!/AWID_REGISTRY_URL/.test(item6), "no ambient registry for the broker either");
});

test("the hand-over and Never carry the own-server branch", () => {
  assert.ok(flat.includes("or team T on their own aweb server U, namespace ND, registry public | RG (recorded in `settings.oats.aweb.registry`), aw <tested> (oats.aweb's tested version) or \"aw <version> is newer than the tested <tested>; kept\", its key at <team key path>"));
  assert.ok(flat.includes("- **On their own aweb server:** make or touch the namespace's controller key (`aw id namespace prepare-controller`, `~/.awid`), set or ask for `AWEB_API_KEY`, set `AWID_REGISTRY_URL` (a private registry is recorded by `oats aweb setup --registry` only), or write a hosted `default:…aweb.ai` team or `localTeams` into the workspace."));
  assert.ok(flat.includes("or `<workspace>:ND` on their own aweb server, checked against step 9's create."));
});
