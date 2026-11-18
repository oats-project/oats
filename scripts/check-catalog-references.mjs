// Current package recommendations stay tied to package-catalog.json. Dated
// design records, release notes and upgrade history intentionally retain old
// versions; version floors are compatibility requirements, not release pins.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseConfigData } from "../lib/config-data.mjs";

export function checkCatalogReferences(root) {
  const catalog = JSON.parse(readFileSync(join(root, "package-catalog.json"), "utf8")).packages;
  const versionRef = id => catalog[id].ref.split("/").at(-1);
  const workspace = parseConfigData(readFileSync(join(root, "oats-workspace.yaml"), "utf8")).value;
  let examples = 0;
  for (const [id, value] of Object.entries(workspace.packages ?? {})) {
    const pin = catalog[id];
    assert.ok(pin, `workspace package missing from official catalog: ${id}`);
    assert.ok(value === versionRef(id) || value.endsWith(`@${pin.ref}`), `oats-workspace.yaml: ${id} pin differs from catalog`);
    examples++;
  }
  const files = [];
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !["design", "release-notes", "acceptance-runs"].includes(entry.name)) walk(join(dir, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "upgrading.md") files.push(join(dir, entry.name));
    }
  }
  for (const dir of ["docs", "skills", "oats-package"]) walk(join(root, dir));
  for (const file of files) {
    // JSON response examples describe recorded deployments, not recommended pins.
    const text = readFileSync(file, "utf8").replace(/```json[^\n]*\n[\s\S]*?```/g, "");
    // Package map examples and explicit package-add recommendations.
    for (const match of text.matchAll(/\b(oats\.[a-z][a-z0-9.-]*)(?::\s*|\s+)(v\d+\.\d+\.\d+)\b/g)) {
      const [, id, ref] = match;
      if (!catalog[id]) continue;
      assert.equal(ref, versionRef(id), `${file}: ${id} recommended pin differs from catalog`); examples++;
    }
    // The authoritative catalog table uses the complete ref (framework has a
    // tag prefix), rather than a bare workspace version.
    for (const [, id, ref] of text.matchAll(/^\| `(oats\.[^`]+)` \| `([^`]+)`/gm)) {
      if (!catalog[id]) continue;
      assert.equal(ref, catalog[id].ref, `${file}: ${id} release row differs from catalog`); examples++;
    }
    const guide = /operator guide for \*\*(oats\.okf) (\d+\.\d+\.\d+)\*\*/.exec(text);
    if (guide) { assert.equal(`v${guide[2]}`, versionRef(guide[1]), `${file}: operator guide version differs from catalog`); examples++; }
  }
  return { examples, files: files.length };
}
