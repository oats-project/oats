// The getting-started skill's own-server (BYOT) branch (#1774, #1775): a new workspace on the
// person's own aweb server gets the team `<workspace>:ND`, created by `oats aweb setup --create`,
// and aw at oats.aweb's published `tested` version, read from aw-compat.json at the catalog's exact
// oats.aweb ref. Hosted keeps the latest aw. The literals the skill reads are checked here against
// the oats.aweb mirror (mirrors/oats-aweb, a copy of the pinned tag), so they can't drift from
// what the provider prints.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseVersion } from "../mirrors/oats-aweb/lib/aw-floor.mjs";

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
const semver = (v) => v.replace(/^v/, "").split(".").map(Number);
const atLeast = (v, min) => {
  const a = semver(v), b = semver(min);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

test("step 1 asks hosted or own server, with the three non-secret inputs and the prerequisites", () => {
  assert.ok(flat.includes("**Hosted aweb, or their own aweb server?** The line says \"on aweb's hosted service, unless you run your own aweb server\"; hosted is the default."));
  for (const input of ["the namespace domain `ND` they control", "the server's public address `U`", "whether their server uses the public AWID registry"]) assert.ok(flat.includes(input), input);
  // A private registry stops the branch before anything is written: it needs oats.aweb's --registry setting (awebai/oats-aweb#284).
  assert.ok(flat.includes("When it uses a private registry, the own-server branch stops here, before anything is written: tell the person in one sentence that a private registry needs oats.aweb with `oats aweb setup --registry`, and that this skill stops here."));
  assert.ok(flat.includes("Answers given in the prompt that started you are used without asking."), "the headless path keeps working");
  for (const prerequisite of ["the namespace's controller key on this computer, for this computer account", "the `_awid.ND` DNS record published for that key", "their server reachable at `U`"]) assert.ok(flat.includes(prerequisite), prerequisite);
  assert.ok(flat.includes("Never offer it on a machine found-list, or for an existing workspace"));
  // The yes names the pinned aw, which may replace an installed one.
  assert.ok(flat.includes("on their own aweb server (step 1) `aw` at the version this OATS release was tested with on such a server, in place of any other `aw` installed"));
});

test("step 4 keeps hosted on the latest aw and pins the own server to oats.aweb's tested aw", () => {
  assert.ok(step4.includes("**On hosted aweb** (the default), the latest `aw`:\n\n```bash\nnpm install -g @awebai/aw && aw version\n```"));
  assert.ok(step4.includes('npm install -g "@awebai/aw@<tested>" && aw version && file -L "$(command -v aw)" && uname -m'));
  assert.match(step4, /`aw version`'s first line must be exactly `aw <tested>`, and the `file`\s+line must name this machine's architecture, the one `uname -m` prints/);
  assert.ok(!/allow-scripts|--ignore-scripts|\bnpm pack\b/.test(step4), "no allow-scripts or tarball pre-check (Juan's side, 5853f141)");
  assert.ok(step4.includes(`older than \`${FLOOR}\``), "the floor the reader enforces is named");
  assert.ok(atLeast(catalog.packages["oats.aweb"].ref, FLOOR), "the catalog's oats.aweb is at or above the own-server floor, so this release offers the branch");
});

test("the tested-version reader reads aw-compat.json at the catalog's ref, never main, and refuses what it can't trust", (t) => {
  const readers = [...step4.matchAll(/^node -e '(.+)' "\$\(oats root\)\/package-catalog\.json"$/gm)].map((m) => m[1]).filter((s) => s.includes("aw-compat.json"));
  assert.equal(readers.length, 1, "step 4 carries the reader as one node -e line on the installed catalog");
  const [script] = readers;
  assert.ok(!script.includes("main"), "never reads main");
  assert.ok(script.includes("[1,42,1]"), `the reader's floor is ${FLOOR}`);
  // The provider publishes the file at this path; the mirror is its copy at the pinned tag.
  const compat = JSON.parse(read("mirrors/oats-aweb/aw-compat.json"));
  assert.deepEqual(Object.keys(compat).sort(), ["min", "tested"]);
  assert.match(read("mirrors/oats-aweb/lib/aw-floor.mjs"), /new URL\('\.\.\/aw-compat\.json', import\.meta\.url\)/, "the capability's own aw-compat.json, beside lib/");

  const dir = mkdtempSync(join(tmpdir(), "gs-byot-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, "fetch-stub.mjs");
  writeFileSync(stub, `globalThis.fetch = async (url) => { process.stderr.write("URL " + url + "\\n"); const body = JSON.parse(process.env.STUB_BODY); return { ok: process.env.STUB_STATUS === "200", status: Number(process.env.STUB_STATUS), json: async () => body }; };\n`);
  const run = (entry, { status = "200", body = compat } = {}) => {
    const file = join(dir, `catalog-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify({ ...catalog, packages: { ...catalog.packages, "oats.aweb": { ...catalog.packages["oats.aweb"], ...entry } } }));
    const r = spawnSync(process.execPath, ["--import", pathToFileURL(stub).href, "-e", script, file], { encoding: "utf8", env: { ...process.env, STUB_STATUS: status, STUB_BODY: JSON.stringify(body) } });
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
  assert.ok(skill.indexOf(ownServer) > skill.indexOf("## 9. Messaging on this machine"));
  assert.ok(flat.includes("On their own aweb server there is no signup: take \"Their own aweb server\", the last part of this item, instead."), "the hosted signup is skipped");
  // No ambient registry selector: a non-public AWID_REGISTRY_URL is refused from the oats.aweb release with --registry (registry-setting-required).
  assert.ok(!skill.includes("AWID_REGISTRY_URL"), "the skill never sets AWID_REGISTRY_URL");
  assert.ok(!/`RG`/.test(skill), "no registry input is carried to step 9");

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

test("the hand-over and Never carry the own-server branch", () => {
  assert.ok(flat.includes("or team T on their own aweb server U, namespace ND, aw <tested> (oats.aweb's tested version), its key at <team key path>"));
  assert.ok(flat.includes("- **On their own aweb server:** make or touch the namespace's controller key (`aw id namespace prepare-controller`, `~/.awid`), set or ask for `AWEB_API_KEY`, or write a hosted `default:…aweb.ai` team or `localTeams` into the workspace."));
  assert.ok(flat.includes("or `<workspace>:ND` on their own aweb server, checked against step 9's create."));
});
