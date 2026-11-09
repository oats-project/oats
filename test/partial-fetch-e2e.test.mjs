// Fetch only what the kernel reads (awebai/oats#384), through the real CLI: a workspace member and a package,
// each carrying large files nothing reads beside large files a module ships, served with partial fetches
// (as GitHub serves them) or without (a default git). Sync, discovery, spawn preview and spawn must succeed
// either way; with partial fetches the cache never receives the files nothing reads, and without them each
// repository is reported once. A git older than PARTIAL_FETCH_GIT (#389) says so on one line instead, naming no
// repository. The package puts its capability and soul in directories no convention names.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { v2Deployment, git } from "./helpers/v2-deployment.mjs";
import { parseRepoRef, SMALL_BLOB_LIMIT } from "../lib/remote.mjs";
import { PARTIAL_GIT, olderGitNotice } from "./helpers/partial-git.mjs";

/** What a git older than PARTIAL_FETCH_GIT gives (#389), which never tries a partial fetch: one warning per command
 *  that starts caches, however many. In the scenario only `sync` starts any (both repositories' caches); the later
 *  commands find them recorded full and say nothing. So the scenario prints it exactly once. */
const OLDER_GIT_WARNINGS = [`oats: warning: ${olderGitNotice()}`];
const warningsOf = (stderr) => stderr.split("\n").filter((l) => l.startsWith("oats: warning")).sort();

const ok = (r, what) => { assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`); const j = r.json(); assert.equal(j.ok, true, `${what}: ${r.stdout}`); return j.result; };
/** `n` bytes that do not compress, the same for the same seed. */
function noise(n, seed) {
  const out = Buffer.alloc(n);
  let h = createHash("sha256").update(seed).digest();
  for (let i = 0; i < n; i += 32) { h = createHash("sha256").update(h).digest(); h.copy(out, i); }
  return out;
}
const LARGE = SMALL_BLOB_LIMIT * 4;
const serve = (bare, partial) => {
  git(bare, "config", "uploadpack.allowFilter", String(partial));
  git(bare, "config", "uploadpack.allowAnySHA1InWant", String(partial));
};

/** A package repo whose manifest points at directories no convention names. */
function packageRepo(base) {
  const bare = join(base, "pkg.git"), seed = join(base, "pkg-seed");
  git(base, "init", "-q", "--bare", bare);
  git(base, "clone", "-q", bare, seed);
  const write = (rel, body) => { mkdirSync(dirname(join(seed, rel)), { recursive: true }); writeFileSync(join(seed, rel), body); };
  write("oats-package/oats-package.json", JSON.stringify({ package: "acme.pkg", version: "1.0.0", description: "fixture package", compatibility: { oats: ">=0.24.0" },
    capabilities: ["tooling/deep/acme-tool"], souls: ["people/keeper"] }, null, 2) + "\n");
  write("oats-package/tooling/deep/acme-tool/oats.json", JSON.stringify({ capability: "acme-tool", version: "1.0.0", description: "tool", compatibility: { oats: ">=0.24.0" }, skills: ["skills"] }, null, 2) + "\n");
  write("oats-package/tooling/deep/acme-tool/skills/tool-skill/SKILL.md", "---\nname: tool-skill\ndescription: tool\n---\n\nuse the tool\n");
  write("oats-package/tooling/deep/acme-tool/data/weights.bin", noise(LARGE, "pkg-weights"));
  write("oats-package/people/keeper/soul.yaml", "schemaVersion: 2\nname: keeper\ndescription: keeper package soul.\nwork: directory\ncapabilities:\n  acme-tool:\n    from: here\n");
  write("oats-package/people/keeper/AGENTS.md", "# keeper\n");
  write("media/video-1.bin", noise(LARGE, "pkg-video-1"));
  write("media/video-2.bin", noise(LARGE, "pkg-video-2"));
  git(seed, "add", "-A"); git(seed, "commit", "-qm", "release 1.0.0"); git(seed, "tag", "v1.0.0");
  git(seed, "push", "-q", "origin", "HEAD:main", "v1.0.0");
  const url = pathToFileURL(bare).href;
  return { bare, seed, ref: `git:${url}`, url, blob: (p) => git(seed, "rev-parse", `HEAD:${p}`) };
}

function fixture({ partial }) {
  const fx = v2Deployment({
    name: "acme",
    souls: { dev: { soul: { capabilities: { tools: { from: "here" } } } } },
    capabilities: { tools: { manifest: { skills: ["skills"] }, files: {
      "skills/use-tools/SKILL.md": "---\nname: use-tools\ndescription: tools\n---\n\nuse them\n",
      "data/model.bin": { text: noise(LARGE, "member-model") },
    } } },
    files: { "assets/huge-1.bin": { text: noise(LARGE, "member-huge-1") }, "assets/huge-2.bin": { text: noise(LARGE, "member-huge-2") } },
  });
  const pkg = packageRepo(fx.base);
  // The workspace now declares the package (a commit on the member, as an operator would make it).
  const wsFile = join(fx.member, "oats-workspace.yaml");
  fx.commit({ "oats-workspace.yaml": readFileSync(wsFile, "utf8") + `packages:\n  acme.pkg: "${pkg.ref}@v1.0.0"\n` }, "declare acme.pkg");
  serve(fx.repo, partial);
  serve(pkg.bare, partial);
  const cacheOf = (refText) => join(fx.env.OATS_REMOTE_CACHE, createHash("sha256").update(parseRepoRef(refText).key).digest("hex"));
  const memberCache = cacheOf(fx.ref), pkgCache = cacheOf(pkg.url);
  /** Whether the cache holds each blob (never fetching one to find out). */
  const holds = (cache, oids) => execFileSync("git", ["-C", cache, "cat-file", "--batch-check"], { input: oids.map((o) => `${o}\n`).join(""), env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } })
    .toString("utf8").trim().split("\n").map((line) => !line.endsWith(" missing"));
  const memberBlob = (p) => git(fx.member, "rev-parse", `HEAD:${p}`);
  return { fx, pkg, memberCache, pkgCache, holds, memberBlob };
}

/** Every command the scenario runs, in order, through the real CLI; → their stderr, joined. */
function runScenario({ fx }) {
  const stderr = [];
  const run = (args, what) => { const r = fx.cli(args); stderr.push(r.stderr); return ok(r, what); };
  run(["sync", "--json"], "sync");
  const souls = run(["souls", "--json"], "souls").souls;
  assert.deepEqual(souls.map((s) => s.name).sort(), ["dev", "keeper"]);
  run(["spawn", "dev", "--preview", "--json"], "spawn preview");
  const dev = run(["spawn", "dev", "--no-launch", "--json"], "spawn dev");
  const keeper = run(["spawn", "acme.pkg/keeper", "--no-launch", "--json"], "spawn keeper");
  // The modules shipped their large files, byte for byte.
  assert.ok(readFileSync(join(dev.home, ".oats", "modules", "tools", "data", "model.bin")).equals(noise(LARGE, "member-model")));
  assert.ok(readFileSync(join(keeper.home, ".oats", "modules", "acme-tool", "data", "weights.bin")).equals(noise(LARGE, "pkg-weights")));
  assert.match(readFileSync(join(keeper.home, "AGENTS.md"), "utf8"), /# keeper/);
  return stderr.join("");
}

test("served with partial fetches: everything works, and the cache never receives the files nothing reads (an older git: whole trees, one warning for the command that starts the caches)", (t) => {
  const s = fixture({ partial: true }); t.after(s.fx.cleanup);
  const stderr = runScenario(s);
  if (PARTIAL_GIT) assert.equal(stderr.includes("oats: warning"), false, stderr);
  else assert.deepEqual(warningsOf(stderr), OLDER_GIT_WARNINGS);
  // An older git (#389) receives every file: the fallback is the assertion there.
  const kept = PARTIAL_GIT ? [false, false, true] : [true, true, true];
  assert.deepEqual(s.holds(s.memberCache, ["assets/huge-1.bin", "assets/huge-2.bin", "capabilities/tools/data/model.bin"].map(s.memberBlob)), kept);
  assert.deepEqual(s.holds(s.pkgCache, ["media/video-1.bin", "media/video-2.bin", "oats-package/tooling/deep/acme-tool/data/weights.bin"].map(s.pkg.blob)), kept);
  for (const cache of [s.memberCache, s.pkgCache]) assert.equal(git(cache, "config", "--get", "oats.fetch"), PARTIAL_GIT ? "partial" : "full");
});

test("served without partial fetches: everything works on whole trees, and each repository is reported once (an older git: one warning for the command that starts the caches)", (t) => {
  const s = fixture({ partial: false }); t.after(s.fx.cleanup);
  const stderr = runScenario(s);
  // An older git (#389) never asks the server, so its one line stands in for the server's, one per repository.
  const served = (url) => `oats: warning: ${url} does not serve partial fetches; OATS fetches whole trees from it`;
  assert.deepEqual(warningsOf(stderr), PARTIAL_GIT ? [served(parseRepoRef(s.fx.ref).url), served(parseRepoRef(s.pkg.url).url)].sort() : OLDER_GIT_WARNINGS);
  assert.deepEqual(s.holds(s.memberCache, ["assets/huge-1.bin"].map(s.memberBlob)), [true], "the whole tree came");
  for (const cache of [s.memberCache, s.pkgCache]) assert.equal(git(cache, "config", "--get", "oats.fetch"), "full");
});
