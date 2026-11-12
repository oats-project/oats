// lib/repo-moves.mjs and what compares through it: the two spellings of a moved repository are one
// repository wherever two keys meet (docs/workspaces.md "Moved repositories"), and nothing is rewritten.
// An in-memory remote (REAL parseRepoRef, both spellings reach the moved repo, as GitHub's redirect does) and
// real Git repositories under a temp dir; no network.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { oatsError } from "../lib/errors.mjs";
import { parseRepoRef } from "../lib/remote.mjs";
import { currentRepoKey, sameRepo } from "../lib/repo-moves.mjs";
import { discoverWorkspace, memberRowByKey, standaloneRepo } from "../lib/workspace.mjs";
import { memberRef } from "../lib/resolve.mjs";
import { findSoulEntry, homeSoulMatches, soulNameMatches } from "../lib/instance-resolution.mjs";
import { memberCloneOf, verifyMemberClone } from "../lib/member-clone.mjs";
import { driftOf, soulDriftOf } from "../lib/drift.mjs";
import { sameSource } from "../lib/packages.mjs";
import { selectCapabilityRow } from "../lib/capability-show.mjs";
import { OATS_PACKAGE_NAME } from "../lib/version.mjs";
import { kernelLookup, PI_BRIDGE, planCliUpdate } from "../lib/pi-bridge.mjs";
import { sameRepo as clientSameRepo } from "../packages/client/repo-moves.mjs";
import { capabilityGroup, composes } from "../packages/client/capability-rows.mjs";
import { sameSelector } from "../packages/client/capability-show-contract.mjs";
import { observeIdentities } from "../packages/client/remote-identity-memory.mjs";
import { repositoryIdentity } from "../scripts/check-okf-mirror.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const OLD = "github.com/awebai/oats", NEW = "github.com/oats-project/oats";
const OLD_OKF = "github.com/awebai/oats-okf", NEW_OKF = "github.com/oats-project/oats-okf";
const OID = (seed) => seed.repeat(40).slice(0, 40);
const SOUL = { schemaVersion: 2, name: "keeper", description: "keeps", work: "directory", capabilities: {} };

/** repos: { <current key>: { commit, files } }. Either spelling of a moved repo reaches it, and each
 *  observation answers the key of the ref it was asked, as lib/remote.mjs does. */
function fakeRemote(repos) {
  const repoOf = (ref) => {
    const parsed = parseRepoRef(ref), repo = repos[currentRepoKey(parsed.key)];
    if (!repo) { const e = oatsError("E_REMOTE_UNREADABLE", `cannot read ${parsed.url}`); e.details = { url: parsed.url, reason: "not-found" }; throw e; }
    return { parsed, repo };
  };
  const encode = (value) => Buffer.from(typeof value === "string" ? value : YAML.stringify(value));
  return {
    parseRepoRef,
    async observeRemote(ref) { const { parsed, repo } = repoOf(ref); return { key: parsed.key, url: parsed.url, commit: repo.commit, ref: "refs/heads/main", observedAt: "2026-10-30T10:00:00.000Z" }; },
    async readRemoteFile(ref, commit, path) {
      const { repo } = repoOf(ref);
      if (!Object.hasOwn(repo.files, path)) { const e = oatsError("E_REMOTE_PATH_MISSING", `${path} is not in ${ref}`); e.details = { path }; throw e; }
      const bytes = encode(repo.files[path]);
      return { bytes, size: bytes.length };
    },
    async listRemoteTree(ref, commit, dir) {
      const { repo } = repoOf(ref);
      return Object.keys(repo.files).filter((p) => p.startsWith(`${dir}/`)).map((p) => ({ path: p.slice(dir.length + 1), type: "blob", size: 1 }));
    },
  };
}
/** A workspace hosted at the moved `oats`, with the moved `oats-okf` and `plain` as members. */
function workspace({ listed = OLD_OKF, backlink = OLD, plainBacklink = OLD, plainOwn = true } = {}) {
  const repos = {
    [NEW]: { commit: OID("a"), files: { "oats-workspace.yaml": { schemaVersion: 2, name: "oats", members: [`git:${listed}`, "git:github.com/example/plain"] } } },
    [NEW_OKF]: { commit: OID("b"), files: { "oats-membership.yaml": { schemaVersion: 2, workspace: `git:${backlink}` }, "souls/keeper/soul.yaml": SOUL } },
    "github.com/example/plain": { commit: OID("c"), files: plainOwn ? { "oats-membership.yaml": { schemaVersion: 2, workspace: `git:${plainBacklink}` } } : {} },
  };
  return fakeRemote(repos);
}

test("the table: exactly the seven moved repositories, each old key to its new key; a stayer and anything else come back as they went in", () => {
  for (const name of ["oats", "oats-okf", "oats-engineering", "oats-cloning", "oats-authoring", "oats-omarchy", "oats-knowledge"]) {
    assert.equal(currentRepoKey(`github.com/awebai/${name}`), `github.com/oats-project/${name}`);
    assert.equal(currentRepoKey(`github.com/oats-project/${name}`), `github.com/oats-project/${name}`, "a new key is current");
  }
  for (const stayer of ["oats-aweb", "oats-apps", "oats-machine", "oats-jira", "oats-linear", "aweb", "aw", "claude-plugins"]) {
    assert.equal(currentRepoKey(`github.com/awebai/${stayer}`), `github.com/awebai/${stayer}`);
  }
  for (const other of ["__proto__", "constructor", "toString", "github.com/AwebAI/oats", "local//tmp/oats", "", null, undefined]) assert.equal(currentRepoKey(other), other);
});

test("the kernel's table and the clients' are the same bytes: they may not import each other, so this test keeps them one", () => {
  assert.equal(readFileSync(join(REPO, "packages", "client", "repo-moves.mjs"), "utf8"), readFileSync(join(REPO, "lib", "repo-moves.mjs"), "utf8"));
  assert.equal(clientSameRepo(OLD, NEW), true);
});

test("the clients compare a moved repository by either spelling, and keep a key as it came", () => {
  const row = { name: "cap", kind: "member", repoKey: NEW_OKF };
  assert.equal(composes({ name: "cap", kind: "member", repoKey: OLD_OKF }, row), true);
  assert.equal(composes({ name: "cap", kind: "member", repoKey: "github.com/acme/oats-okf" }, row), false);
  const group = capabilityGroup(row, new Map(), OLD_OKF);
  assert.deepEqual([group.rank, group.note], [0, "member repo · host"], "the host under the other spelling is still the host");
  assert.equal(capabilityGroup({ ...row, repoKey: "github.com/acme/a" }, new Map(), OLD_OKF).rank, 1);
  assert.equal(sameSelector({ name: "cap", kind: "member", repoKey: OLD_OKF }, row), true);
  assert.equal(sameSelector({ name: "cap", kind: "member", repoKey: "github.com/acme/a" }, row), false);
});

test("a host that changed its workspace string has not moved to another workspace; one that changed repository has", () => {
  const workspace = (key) => ({ key, ref: `git:${key}`, keyFrom: "workspace", standalone: false, defaultTeam: { label: "oats", team: "oats:aweb.ai" }, teams: { oats: "oats:aweb.ai" }, teamsFrom: "observed" });
  const group = (key) => ({ id: "devbox:abc", server: "devbox", label: "devbox", target: { workspace: "/srv/oats" }, probe: { ok: true }, workspace: workspace(key) });
  const at = "2026-10-30T10:00:00.000Z";
  const held = observeIdentities({ memory: new Map(), notes: new Map() }, [group(OLD)], at);
  assert.equal(held.memory.size, 1);
  assert.equal(observeIdentities(held, [group(NEW)], at).notes.size, 0);
  assert.equal(observeIdentities(held, [group("github.com/acme/oats")], at).notes.size, 1);
});

test("the mirror check knows the okf repository by either owner, in the transports it knows, and by nothing else", () => {
  const canonical = "https://github.com/awebai/oats-okf.git";
  for (const owner of ["awebai", "oats-project"]) {
    for (const url of [`https://github.com/${owner}/oats-okf.git`, `https://github.com/${owner}/oats-okf`, `git@github.com:${owner}/oats-okf.git`, `git@github.com:${owner}/oats-okf`, `ssh://git@github.com/${owner}/oats-okf.git`, `ssh://git@github.com/${owner}/oats-okf`]) {
      assert.equal(repositoryIdentity(url), canonical, url);
    }
  }
  for (const url of ["https://github.com/acme/oats-okf.git", "https://github.com/oats-project/oats.git", "http://github.com/oats-project/oats-okf.git", "git@github.com/oats-project/oats-okf.git", "/tmp/oats-okf.git"]) assert.equal(repositoryIdentity(url), url);
});

test("sameRepo: the two spellings match either way round, and nothing else does", () => {
  assert.equal(sameRepo(OLD, NEW), true);
  assert.equal(sameRepo(NEW, OLD), true);
  assert.equal(sameRepo(OLD, OLD), true);
  assert.equal(sameRepo("github.com/acme/a", "github.com/acme/a"), true);
  assert.equal(sameRepo(OLD, NEW_OKF), false);
  assert.equal(sameRepo("github.com/acme/oats", NEW), false, "the same name in another organisation is another repository");
  assert.equal(sameRepo("github.com/awebai/aweb", "github.com/oats-project/aweb"), false, "a stayer has no second spelling");
  assert.equal(sameRepo(null, undefined), false);
  assert.equal(sameRepo(undefined, NEW), false);
});

test("inert: parseRepoRef keeps the spelling it was given, so `key` and the url of a ref are never canonicalised", () => {
  assert.deepEqual([parseRepoRef(`git:${OLD}`).key, parseRepoRef("https://github.com/awebai/oats.git").key], [OLD, OLD]);
  assert.equal(parseRepoRef(`git:${OLD}`).url, "https://github.com/awebai/oats.git");
});

test("every mix of the spellings of host, member list and backlink confirms the member and emits each key as written", async () => {
  for (const host of [OLD, NEW]) for (const listed of [OLD_OKF, NEW_OKF]) for (const backlink of [OLD, NEW]) {
    const d = await discoverWorkspace(`git:${host}`, { remote: workspace({ listed, backlink }) });
    const row = d.members.find((m) => m.ref === `git:${listed}`);
    assert.equal(row.confirmed, true, `${host} ${listed} ${backlink}: ${row.detail}`);
    assert.equal(d.key, host, "the workspace key stays as the ref spelled it");
    assert.equal(row.key, listed, "the member key stays as the workspace spelled it");
    assert.equal(row.souls[0].repoKey, listed);
  }
});

test("a backlink to another workspace is still backlink-elsewhere", async () => {
  const d = await discoverWorkspace(`git:${NEW}`, { remote: workspace({ backlink: "github.com/acme/oats" }) });
  const row = d.members.find((m) => m.key === OLD_OKF);
  assert.deepEqual([row.confirmed, row.reason], [false, "backlink-elsewhere"]);
});

test("inert: with no moved key in play, keys, member rows and lookups are as they were", async () => {
  const repos = {
    "github.com/acme/agents": { commit: OID("a"), files: { "oats-workspace.yaml": { schemaVersion: 2, name: "acme", members: ["git:github.com/acme/agents"] }, "oats-membership.yaml": { schemaVersion: 2, workspace: "git:github.com/acme/agents" }, "souls/keeper/soul.yaml": SOUL } },
  };
  const d = await discoverWorkspace("git:github.com/acme/agents", { remote: fakeRemote(repos) });
  assert.equal(d.key, "github.com/acme/agents");
  assert.deepEqual(d.members.map((m) => [m.key, m.ref, m.confirmed]), [["github.com/acme/agents", "git:github.com/acme/agents", true]]);
  assert.equal(findSoulEntry(d, "keeper").repoKey, "github.com/acme/agents");
  assert.equal(memberRowByKey(d.members, "github.com/acme/agents"), d.members[0]);
  assert.equal(memberRowByKey(d.members, "github.com/acme/other"), null);
  assert.equal(memberRef(d, parseRepoRefRemote, "github.com/acme/other"), "git:github.com/acme/other");
});
const parseRepoRefRemote = { parseRepoRef };

test("memberRowByKey and memberRef find a moved member under either spelling; the ref stays as the workspace wrote it", () => {
  const members = [{ key: NEW_OKF, marker: "okf" }];
  assert.equal(memberRowByKey(members, OLD_OKF), members[0]);
  assert.equal(memberRowByKey(members, NEW_OKF), members[0]);
  assert.equal(memberRowByKey([{ key: OLD_OKF }], NEW_OKF).key, OLD_OKF);
  const ref = "git@github.com:oats-project/oats-okf.git";
  assert.equal(memberRef({ workspace: { members: [ref] } }, parseRepoRefRemote, OLD_OKF), ref);
  assert.equal(memberRef({ workspace: { members: ["https://github.com/awebai/oats-okf.git"] } }, parseRepoRefRemote, NEW_OKF), "https://github.com/awebai/oats-okf.git");
});

test("a home recorded under the other spelling reads current, not missing, and keeps the key it recorded", () => {
  const members = [{ key: NEW_OKF, commit: OID("b"), confirmed: true, souls: [{ name: "keeper" }], capabilities: [{ name: "cap", manifest: { version: "1.0.0" } }] }];
  const home = { agent: "keeper", workspace: { soul: { repoKey: OLD_OKF, commit: OID("b") } }, modules: { cap: { from: { kind: "member", repoKey: OLD_OKF, commit: OID("b") }, commit: OID("b") } } };
  const soul = soulDriftOf(home, { members });
  assert.deepEqual([soul.status, soul.repoKey], ["current", OLD_OKF]);
  const [module] = driftOf(home, { members });
  assert.deepEqual([module.status, module.recorded.repoKey, module.from.repoKey], ["current", OLD_OKF, OLD_OKF]);
  assert.equal(soulDriftOf({ ...home, workspace: { soul: { repoKey: OLD_OKF, commit: OID("9") } } }, { members }).status, "moved");
});

test("a soul or a capability named by the full key answers to either spelling", () => {
  assert.equal(soulNameMatches(`${OLD_OKF}/keeper`, { name: "keeper", repoKey: NEW_OKF }), true);
  assert.equal(soulNameMatches(`${NEW_OKF}/keeper`, { name: "keeper", repoKey: OLD_OKF }), true);
  assert.equal(soulNameMatches("github.com/acme/oats-okf/keeper", { name: "keeper", repoKey: NEW_OKF }), false);
  const external = { external: [{ source: `git:${OLD_OKF}@main`, soul: { name: "keeper", repoKey: OLD_OKF } }] };
  assert.equal(findSoulEntry(external, `${NEW_OKF}/keeper`).repoKey, OLD_OKF, "an external soul by the other spelling");
  assert.equal(findSoulEntry(external, `${OLD_OKF}/keeper`).repoKey, OLD_OKF);
  const rows = [{ name: "cap", kind: "member", repoKey: NEW_OKF }];
  assert.equal(selectCapabilityRow(rows, "cap", { member: OLD_OKF }), rows[0]);
});

test("the standalone view of a moved member takes its own souls, and a from: under the other spelling is its own", () => {
  const definition = { capabilities: { own: { from: NEW_OKF } } };
  const repo = { key: OLD_OKF, commit: OID("b"), souls: [{ name: "keeper", repoKey: OLD_OKF, path: "souls/keeper", definition }], capabilities: [{ name: "own", repoKey: OLD_OKF, manifest: {} }] };
  const view = standaloneRepo(`git:${NEW_OKF}`, OID("b"), repo, { remote: fakeRemote({}) });
  assert.equal(view.key, NEW_OKF);
  assert.deepEqual(view.members[0].souls[0].capabilities.own, { from: "here" });
  assert.deepEqual(view.problems, []);
});

test("a git: lock source is one source under either spelling at one ref; a catalog source and another ref are not", () => {
  assert.equal(sameSource(`git:${OLD_OKF}@v1.0.0`, `git:${NEW_OKF}@v1.0.0`), true);
  assert.equal(sameSource(`git:${OLD_OKF}@v1.0.0`, `git:${NEW_OKF}@v1.0.1`), false);
  assert.equal(sameSource(`git:${OLD_OKF}@v1.0.0`, "git:github.com/acme/oats-okf@v1.0.0"), false);
  assert.equal(sameSource("catalog:oats.okf", "catalog:oats.okf"), true);
  assert.equal(sameSource("catalog:oats.okf", "catalog:oats.other"), false);
});

test("a soul named <org>/<repo>/<soul> answers to either spelling at either key, and nothing widens for a key not in the table", () => {
  for (const repoKey of [OLD_OKF, NEW_OKF]) {
    for (const name of ["awebai/oats-okf/keeper", "oats-project/oats-okf/keeper", "oats-okf/keeper"]) {
      assert.equal(soulNameMatches(name, { name: "keeper", repoKey }), true, `${name} at ${repoKey}`);
      assert.equal(homeSoulMatches(name, { agent: "keeper", workspace: { soul: { repoKey } } }), true, `${name}, a home at ${repoKey}`);
    }
    assert.equal(soulNameMatches("acme/oats-okf/keeper", { name: "keeper", repoKey }), false);
    assert.equal(soulNameMatches("oats-project/oats/keeper", { name: "keeper", repoKey }), false);
    assert.equal(soulNameMatches("awebai/oats-okf/other", { name: "keeper", repoKey }), false);
  }
  const stayer = "github.com/awebai/aweb";
  assert.equal(soulNameMatches("awebai/aweb/keeper", { name: "keeper", repoKey: stayer }), true);
  assert.equal(soulNameMatches("oats-project/aweb/keeper", { name: "keeper", repoKey: stayer }), false);
  assert.equal(soulNameMatches("awebai/oats-okf/keeper", { name: "keeper", repoKey: "gitlab.com/awebai/oats-okf" }), true, "a suffix, as before");
  assert.equal(soulNameMatches("oats-project/oats-okf/keeper", { name: "keeper", repoKey: "gitlab.com/awebai/oats-okf" }), false);
});

test("E_SOUL_UNKNOWN names the unconfirmed members, their reasons and details and what to do; it keeps its details and adds one", async () => {
  const d = await discoverWorkspace(`git:${NEW}`, { remote: workspace({ backlink: "github.com/acme/oats", plainOwn: false }) });
  const e = (() => { try { findSoulEntry(d, "ghost"); } catch (x) { return x; } })();
  assert.equal(e.code, "E_SOUL_UNKNOWN");
  assert.deepEqual(Object.keys(e.details), ["name", "members", "packages", "unconfirmed"]);
  assert.deepEqual(e.details.members, []);
  assert.deepEqual(e.details.unconfirmed.map((m) => [m.key, m.reason]), [[OLD_OKF, "backlink-elsewhere"], ["github.com/example/plain", "no-backlink"]]);
  assert.ok(e.details.unconfirmed.every((m) => m.detail));
  assert.match(e.message, /^no soul "ghost" among the confirmed members/);
  assert.match(e.message, /2 members are not confirmed/);
  for (const m of e.details.unconfirmed) { assert.ok(e.message.includes(m.key), m.key); assert.ok(e.message.includes(m.detail), m.detail); }
  assert.ok(e.message.includes("for backlink-elsewhere: correct the `workspace:` line of oats-local.yaml, or of that repository's oats-membership.yaml"), e.message);
  assert.equal(e.message.includes("npm install"), false, e.message);
  assert.ok(e.message.includes("oats-membership.yaml"), e.message);
});

test("inert: E_SOUL_UNKNOWN with every member confirmed is the message and the details it was; a standalone view's own row is not a member it could not confirm", () => {
  const e = (d) => { try { findSoulEntry(d, "ghost"); } catch (x) { return x; } };
  const confirmed = e({ members: [{ key: "github.com/acme/a", confirmed: true, souls: [] }], packageSouls: [] });
  assert.equal(confirmed.message, 'no soul "ghost" among the confirmed members, external souls or package souls of this workspace');
  assert.deepEqual(confirmed.details, { name: "ghost", members: ["github.com/acme/a"], packages: [] });
  const standalone = e({ standalone: true, key: "github.com/acme/a", members: [{ key: "github.com/acme/a", confirmed: false, reason: "cannot-read", souls: [] }], packageSouls: [] });
  assert.equal(Object.hasOwn(standalone.details, "unconfirmed"), false);
});

test("a clone with a remote of either spelling is the moved member's clone, by clones: or by verification; E_CLONE_MISMATCH gives the Git command, which works", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-repo-moves-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const repo = (name, ...urls) => {
    const dir = join(base, name);
    mkdirSync(dir);
    execFileSync("git", ["init", "-q", dir]);
    urls.forEach((url, i) => git(dir, "remote", "add", i === 0 ? "origin" : `r${i}`, url));
    return dir;
  };
  const old = repo("old", `https://${OLD_OKF}.git`), fresh = repo("fresh", `git@github.com:oats-project/oats-okf.git`);
  assert.equal(verifyMemberClone(old, NEW_OKF), old);
  assert.equal(verifyMemberClone(fresh, OLD_OKF), fresh);
  assert.equal(memberCloneOf(base, { clones: { [OLD_OKF]: old } }, NEW_OKF).path, old);
  assert.equal(memberCloneOf(base, { clones: { [`https://${NEW_OKF}.git`]: fresh } }, OLD_OKF).path, fresh);

  const mismatch = (path) => { try { verifyMemberClone(path, NEW_OKF); } catch (x) { return x; } };
  const wrong = repo("wrong", "https://github.com/acme/elsewhere.git");
  let e = mismatch(wrong);
  assert.equal(e.code, "E_CLONE_MISMATCH");
  assert.deepEqual(e.details, { path: wrong, expected: NEW_OKF, found: ["github.com/acme/elsewhere"], via: null });
  const url = `https://${NEW_OKF}.git`;
  assert.ok(e.message.includes(`if this is a clone of it, run: git -C ${wrong} remote set-url origin ${url}`), e.message);
  assert.match(e.message, /second remote/);
  execFileSync("sh", ["-c", `git -C ${wrong} remote set-url origin ${url}`]);
  assert.equal(verifyMemberClone(wrong, NEW_OKF), wrong, "the remedy passes");

  const second = repo("second", "https://github.com/acme/elsewhere.git");
  git(second, "remote", "add", "moved", url);
  assert.equal(verifyMemberClone(second, NEW_OKF), second, "a second remote passes, as the message says");

  const bare = repo("no-remote");
  e = mismatch(bare);
  assert.ok(e.message.includes(`if this is a clone of it, run: git -C ${bare} remote add origin ${url}`), e.message);
  const noOrigin = repo("no-origin");
  git(noOrigin, "remote", "add", "upstream", "https://github.com/acme/elsewhere.git");
  assert.ok(mismatch(noOrigin).message.includes(`git -C ${noOrigin} remote add origin ${url}`));

  const plainDir = join(base, "not-a-repo");
  mkdirSync(plainDir);
  assert.doesNotMatch(mismatch(plainDir).message, /git -C/, "no Git command helps what is not a repository");
});

test("the kernel's npm name is package.json's; oats version keeps the probe's name and adds the real one", () => {
  const name = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).name;
  assert.equal(OATS_PACKAGE_NAME, name);
  assert.equal(PI_BRIDGE, "@awebai/oats-pi");
  const doc = JSON.parse(spawnSync(process.execPath, [join(REPO, "bin", "oats.mjs"), "version", "--json"], { encoding: "utf8" }).stdout);
  assert.deepEqual([doc.name, doc.package], ["@awebai/oats", name]);
});

test("the same code published under the other name reports that name, updates itself under it and keeps the probe's name", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "oats-repo-moves-name-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const dir of ["bin", "lib", join("packages", "record", "lib")]) cpSync(join(REPO, dir), join(base, dir), { recursive: true });
  cpSync(join(REPO, "package-catalog.json"), join(base, "package-catalog.json"));
  symlinkSync(join(REPO, "node_modules"), join(base, "node_modules"));
  const manifest = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  writeFileSync(join(base, "package.json"), JSON.stringify({ ...manifest, name: "@oats-project/oats" }));
  const run = (...args) => spawnSync(process.execPath, [join(base, "bin", "oats.mjs"), ...args], { encoding: "utf8" });
  const doc = JSON.parse(run("version", "--json").stdout);
  assert.deepEqual([doc.name, doc.package], ["@awebai/oats", "@oats-project/oats"]);
  assert.match(run("version").stdout, /^@oats-project\/oats /);
  const bridge = await import(join(base, "lib", "pi-bridge.mjs"));
  assert.equal(bridge.PI_BRIDGE, "@oats-project/oats-pi");
  assert.deepEqual(bridge.kernelLookup(), ["npm", "view", "@oats-project/oats", "version"]);
  assert.deepEqual(bridge.planCliUpdate("0.1.0", "0.2.0").step.argv, ["npm", "install", "-g", "@oats-project/oats@0.2.0"]);
  assert.deepEqual(kernelLookup(), ["npm", "view", "@awebai/oats", "version"], "this copy stays on its own name");
  assert.deepEqual(planCliUpdate("0.1.0", "0.2.0").step.argv, ["npm", "install", "-g", "@awebai/oats@0.2.0"]);
});
