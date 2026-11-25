/** CI-only: extract from the exact built IDs, compare with source, run without a checkout. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deployFiles } from "../../container/agent/deploy-manifest.mjs";

export function verifyDeploy(directory, image, source, sourceDir) {
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["schema", "image", "source", "files", "installed"].sort());
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.image, image);
  assert.equal(manifest.source, source);
  assert.deepEqual(manifest.files, deployFiles(directory), "manifest must equal the complete extracted file inventory");
  for (const [name, digest] of Object.entries(manifest.files)) {
    assert.match(name, /^(?:egress\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.equal(digest, `sha256:${createHash("sha256").update(readFileSync(join(sourceDir, name))).digest("hex")}`, `copied source: ${name}`);
  }
  return manifest;
}

export function checkExtractedScripts(directory, image) {
  directory = realpathSync(directory);
  // These paths load the full import closure before refusing, without Docker.
  // accept has no successful --help mode; keep its existing usage-only refusal.
  const env = { HOME: directory, PATH: process.env.PATH };
  if (image === "agent") {
    const result = spawnSync("sh", [join(directory, "accept.sh"), "--help"], { cwd: directory, env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /usage: accept.sh CONTAINER --evidence/);
  } else {
    const plan = join(directory, "schema-validation.json");
    writeFileSync(plan, '{"schema":2}\n');
    try {
      const result = spawnSync(process.execPath, [join(directory, "egress/probe-compose-boundary.mjs"), "--plan", plan], { cwd: directory, env, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /E_EGRESS_PLAN_SCHEMA: this probe reads runtime plan schema 1; found 2;/);
      assert.equal(result.stdout, "");
    } finally { rmSync(plan); }
    for (const [name, diagnostic] of [
      ["preflight-network.mjs", "egress preflight: run preflight without arguments on the Linux Docker engine host\n"],
      ["probe-runtime.mjs", "egress boundary: cannot emit runtime probe (values withheld)\n"],
    ]) {
      const result = spawnSync(process.execPath, [join(directory, "egress", name), "--help"], { cwd: directory, env, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr, diagnostic);
      assert.equal(result.stdout, "");
    }
  }
}

export function verifyDeployPair(agent, egress) {
  assert.equal(agent.image, "agent");
  assert.equal(egress.image, "egress");
  assert.match(agent.source, /^[a-f0-9]{40}$/);
  assert.equal(agent.source, egress.source, "agent and egress must come from the same source commit");
  const shared = Object.keys(agent.files).filter(name => Object.hasOwn(egress.files, name));
  assert.deepEqual(shared.sort(), ["accept.mjs", "compose.agent.yaml", "supervisor.mjs"]);
  for (const name of shared) assert.equal(agent.files[name], egress.files[name], `shared deploy file: ${name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = process.env.TEAM_IMAGE_SOURCE_SHA;
  assert.match(source ?? "", /^[a-f0-9]{40}$/);
  const root = mkdtempSync(join(tmpdir(), "oats-extracted-deploy-"));
  const docker = args => execFileSync("docker", args, { encoding: "utf8", timeout: 60000 }).trim();
  const manifests = {};
  try {
    for (const image of ["agent", "egress"]) {
      const id = docker(["image", "inspect", "--format", "{{.Id}}", process.env[image === "agent" ? "AGENT_IMAGE" : "EGRESS_IMAGE"]]);
      const container = docker(["create", id]);
      const directory = join(root, image);
      try { docker(["cp", `${container}:/opt/oats/deploy`, directory]); }
      finally { docker(["rm", container]); }
      manifests[image] = verifyDeploy(directory, image, source, resolve("container/agent"));
      // Read metadata in the image: docker cp does not preserve container uid.
      const program = `
        import assert from 'node:assert/strict';
        import {lstatSync,readdirSync,readFileSync} from 'node:fs';
        import {join} from 'node:path';
        import {installedVersions} from '/usr/local/lib/oats-deploy-manifest.mjs';
        const root='/opt/oats/deploy';
        function check(path) {
          const s=lstatSync(path);
          assert.equal(s.uid,0,path); assert.equal(s.gid,0,path);
          assert.equal(s.mode & 0o777, s.isDirectory() || path===root+'/accept.sh' ? 0o755 : 0o644,path);
          if(s.isDirectory()) for(const name of readdirSync(path)) check(join(path,name));
          else assert.ok(s.isFile(),path);
        }
        check(root);
        const m=JSON.parse(readFileSync(root+'/manifest.json'));
        assert.deepEqual(m.installed,installedVersions(m.image));
        console.log(JSON.stringify(m));
      `;
      const manifest = docker(["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--entrypoint", "node", id, "--input-type=module", "-e", program]);
      assert.deepEqual(JSON.parse(manifest), manifests[image]);
      checkExtractedScripts(directory, image);
      console.log(`${image}: ${id}; manifest, ownership, installed versions and extracted scripts PASS\n${manifest}`);
    }
    verifyDeployPair(manifests.agent, manifests.egress);
    assert.deepEqual(readdirSync(root).sort(), ["agent", "egress"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
