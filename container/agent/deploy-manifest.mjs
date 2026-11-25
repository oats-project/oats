/** Build-time inventory. No registry metadata substitutes for installed versions. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const installedCommands = {
  agent: { oats: ["oats", "version", "--json"], aw: ["aw", "version"], claude: ["claude", "--version"] },
  egress: { coredns: ["coredns", "-version"], nginx: ["nginx", "-v"] },
};

export function installedVersions(image) {
  assert.ok(Object.hasOwn(installedCommands, image), "image must be agent or egress");
  return Object.fromEntries(Object.entries(installedCommands[image]).map(([name, [command, ...args]]) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, `installed ${name} version command must succeed`);
    const version = name === "oats" ? JSON.parse(result.stdout).version
      : `${result.stdout}\n${result.stderr}`.match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/)?.[0];
    assert.match(version ?? "", /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/, `installed ${name} version is invalid`);
    return [name, version];
  }));
}

export function deployFiles(directory, prefix = "") {
  const files = {};
  for (const name of readdirSync(directory).sort()) {
    if (!prefix && name === "manifest.json") continue;
    const path = join(directory, name), relative = prefix + name, stat = lstatSync(path);
    if (stat.isDirectory()) Object.assign(files, deployFiles(path, relative + "/"));
    else {
      assert.ok(stat.isFile(), `deploy input must be a regular file: ${relative}`);
      files[relative] = `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    }
  }
  return files;
}

export function writeDeployManifest({ directory, image, source, installed }) {
  assert.match(source ?? "", /^[a-f0-9]{40}$/, "TEAM_IMAGE_SOURCE_SHA must be a full source commit SHA (no fallback)");
  assert.ok(Object.hasOwn(installedCommands, image), "image must be agent or egress");
  assert.deepEqual(Object.keys(installed).sort(), Object.keys(installedCommands[image]).sort(), "installed version inventory differs");
  for (const version of Object.values(installed)) assert.match(version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/);
  const manifest = { schema: 1, image, source, files: deployFiles(directory), installed };
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [image, directory, source] = process.argv.slice(2);
  // Refuse the source argument before attempting any installed CLI command.
  assert.match(source ?? "", /^[a-f0-9]{40}$/, "TEAM_IMAGE_SOURCE_SHA must be a full source commit SHA (no fallback)");
  writeDeployManifest({ directory, image, source, installed: installedVersions(image) });
}
