// This repository as a workspace member: the kernel's member discovery
// (lib/workspace.mjs#discoverRepo), run over this checkout's tracked tree, lists
// only the repository's own capabilities: its two private ones and its copy of the
// engineering template (capabilities/TEMPLATE-RELEASE). The package mirrors live
// under mirrors/ and are offered by their packages; a mirror under capabilities/
// would be listed a second time, as a latest-state member capability of
// github.com/awebai/oats ("member and publisher never collapse", docs/workspaces.md).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { oatsError } from "../lib/errors.mjs";
import { parseRepoRef } from "../lib/remote.mjs";
import { discoverRepo } from "../lib/workspace.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The remote interface discovery reads (observeRemote, readRemoteFile, listRemoteTree)
 *  over this checkout's tracked files: the tree a commit of this branch would carry. */
function checkoutRemote() {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  const files = new Set(tracked);
  const commit = "0".repeat(40);
  return {
    parseRepoRef,
    async observeRemote(ref) {
      const { key, url } = parseRepoRef(ref);
      return { key, url, commit, ref: "refs/heads/main", observedAt: "2026-09-29T00:00:00.000Z" };
    },
    async readRemoteFile(ref, at, path) {
      if (!files.has(path)) throw oatsError("E_REMOTE_PATH_MISSING", `${path} is not tracked in this checkout`, { path });
      const bytes = readFileSync(join(ROOT, path));
      return { bytes, size: bytes.length };
    },
    async listRemoteTree(ref, at, dir, { depth = 2 } = {}) {
      const rows = new Map();
      for (const path of tracked) {
        if (!path.startsWith(`${dir}/`)) continue;
        const parts = path.slice(dir.length + 1).split("/");
        for (let i = 1; i <= Math.min(parts.length, depth); i++) {
          const rel = parts.slice(0, i).join("/");
          if (!rows.has(rel)) rows.set(rel, i === parts.length ? { path: rel, type: "blob" } : { path: rel, type: "tree" });
        }
      }
      return [...rows.values()].sort((a, b) => compare(a.path, b.path));
    },
  };
}

// The copy of the engineering template is public (no `private`): souls in other members
// compose it `from: github.com/awebai/oats`, as the template's ADAPTING.md says.
const TEMPLATE_COPY = ["oats.code-review", "oats.developer", "oats.dispatcher", "oats.engineering-expert", "oats.landing-rules", "oats.maintainer"];

test("member discovery over this repository lists its two private member capabilities and its six-capability copy of the engineering template; every package mirror comes from its package", async () => {
  const d = await discoverRepo("git:github.com/awebai/oats", { remote: checkoutRemote() });
  assert.equal(d.key, "github.com/awebai/oats");
  assert.deepEqual(d.problems, []);
  assert.deepEqual(d.capabilities.map((c) => ({ name: c.name, path: c.path, private: c.private })),
    [{ name: "oats.code-review", path: "capabilities/oats-code-review", private: false },
     { name: "oats.desktop-ui", path: "capabilities/oats-desktop-ui", private: true },
     { name: "oats.developer", path: "capabilities/oats-developer", private: false },
     { name: "oats.dispatcher", path: "capabilities/oats-dispatcher", private: false },
     { name: "oats.engineering-expert", path: "capabilities/oats-engineering-expert", private: false },
     { name: "oats.landing-rules", path: "capabilities/oats-landing-rules", private: false },
     { name: "oats.maintainer", path: "capabilities/oats-maintainer", private: false },
     { name: "oats.workspace-experts", path: "capabilities/oats-workspace-experts", private: true }],
    "a package mirror under capabilities/ is discovered as a member capability of this repository");
  assert.ok(!d.capabilities.some((c) => c.path.startsWith("mirrors/")), "no capability under mirrors/ is discovered as a member");
  // What the repository publishes is reported, never enumerated as member capabilities.
  assert.equal(d.publishes?.package, "oats.framework");

  // Each mirrored capability is offered by a package this workspace declares, and by nothing else.
  const catalog = JSON.parse(readFileSync(join(ROOT, "package-catalog.json"), "utf8"));
  const declared = YAML.parse(readFileSync(join(ROOT, "oats-workspace.yaml"), "utf8")).packages;
  const mirrors = execFileSync("git", ["ls-files", "--", "mirrors/*/oats.json"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  assert.equal(mirrors.length, 14, `the fourteen official package mirrors, saw ${mirrors.join(", ")}`);
  for (const file of mirrors) {
    const id = JSON.parse(readFileSync(join(ROOT, file), "utf8")).capability;
    const alias = catalog.capabilities[id];
    const pkg = typeof alias === "string" ? alias : catalog.packages[id] ? id : null;
    assert.ok(pkg && Object.hasOwn(declared, pkg), `${file}: ${id} is supplied by a package oats-workspace.yaml declares (catalog says ${pkg})`);
    // A mirrored id is a member capability only as the template copy's own folder, never the mirror.
    const members = d.capabilities.filter((c) => c.name === id).map((c) => c.path);
    assert.deepEqual(members, TEMPLATE_COPY.includes(id) ? [`capabilities/oats-${id.slice("oats.".length)}`] : [], `${id}: the member capabilities of that name`);
  }
});
