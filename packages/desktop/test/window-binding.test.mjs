// One Desktop window per workspace (#481): a window's workspace is its renderer URL's hash,
// `#ws=<encodeURIComponent(id)>`, and every trust check accepts exactly the renderer file with no
// hash or with that one canonical hash. Anything else, including a query, is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validWorkspaceId, WORKSPACE_ID_MAX } from "../renderer/workspace-id.mjs";
import { workspaceHash, hashWorkspace, frameWorkspace, trustedRendererUrl } from "../renderer/window-binding.mjs";

const RENDERER = "file:///Applications/OATS%20Desktop.app/Contents/Resources/app/renderer/index.html";
const IDS = ["/Users/alex/Agents/oats", "ws:0123456789abcdef0123", "remote:devbox:/home/alex/agents", "a b&c=d#e?f%g", "ünï/çødé"];

test("workspace ids: the validId rule (non-empty, bounded, no C0 or DEL controls)", () => {
  for (const id of IDS) assert.equal(validWorkspaceId(id), true, id);
  assert.equal(validWorkspaceId("x".repeat(WORKSPACE_ID_MAX)), true);
  for (const bad of ["", "x".repeat(WORKSPACE_ID_MAX + 1), "a\nb", "a\x00b", "a\x7fb", "a\x1fb", null, undefined, 7, {}, ["/x"]]) {
    assert.equal(validWorkspaceId(bad), false, JSON.stringify(bad));
  }
});

test("the hash round-trips every valid id, canonically encoded", () => {
  for (const id of IDS) {
    const hash = workspaceHash(id);
    assert.equal(hash, `#ws=${encodeURIComponent(id)}`);
    assert.deepEqual(hashWorkspace(hash), { ok: true, workspace: id });
  }
  assert.throws(() => workspaceHash(""), /workspace id/);
  assert.throws(() => workspaceHash("a\nb"), /workspace id/);
});

test("no hash is an unbound window; any other hash is refused", () => {
  assert.deepEqual(hashWorkspace(""), { ok: true, workspace: null });
  for (const bad of ["#", "#other", "#ws=", "#ws", "#WS=%2Fx", "#ws=%2Fx&y=1", "#ws=%2Fx#y", "#ws=%E0%A4%A", "#ws=%0A",
    "#ws=/x", "#ws=%2fx", `#ws=${encodeURIComponent("x".repeat(WORKSPACE_ID_MAX + 1))}`, " #ws=%2Fx", null, undefined]) {
    assert.deepEqual(hashWorkspace(bad), { ok: false }, String(bad));
  }
});

test("frame trust: the renderer file exactly, with no hash or a valid #ws=, is accepted", () => {
  assert.equal(frameWorkspace(RENDERER, RENDERER), null);
  assert.equal(frameWorkspace(`${RENDERER}${workspaceHash(IDS[0])}`, RENDERER), IDS[0]);
  assert.equal(trustedRendererUrl(RENDERER, RENDERER), true);
  assert.equal(trustedRendererUrl(`${RENDERER}${workspaceHash(IDS[1])}`, RENDERER), true);
});

test("frame trust: an invalid #ws=, another hash, a query or another path are each refused", () => {
  const refused = [
    `${RENDERER}#ws=%0A`, `${RENDERER}#ws=`, `${RENDERER}#other`, `${RENDERER}#`,
    `${RENDERER}?ws=%2Fx`, `${RENDERER}?ws=%2Fx#ws=%2Fx`, `${RENDERER}?`,
    RENDERER.replace("index.html", "other.html"), `${RENDERER}x`, `${RENDERER}/`, `${RENDERER}#ws=%2Fx&ws=%2Fy`,
    "https://attacker.example/renderer/index.html", "", null, undefined, 42,
  ];
  for (const url of refused) {
    assert.equal(frameWorkspace(url, RENDERER), undefined, String(url));
    assert.equal(trustedRendererUrl(url, RENDERER), false, String(url));
  }
});

test("source pin: renderer modules share the one workspace-id rule", () => {
  for (const file of ["../renderer/deployment-tabs.mjs", "../renderer/spawn-deployment-field.mjs", "../renderer/window-binding.mjs"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /from ['"]\.\/workspace-id\.mjs['"]/, file);
    assert.doesNotMatch(source, /const validId = v =>/, `${file} keeps no private copy of the rule`);
  }
});
