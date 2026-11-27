import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDeployManifest } from "../../container/agent/deploy-manifest.mjs";

export const egressSource = fileURLToPath(new URL("../../container/agent/", import.meta.url));
export const deploySourceCommit = "b".repeat(40);

/** An extracted egress deploy copy, staged from the Dockerfile's own deploy
 * COPY lines with a source-bound manifest, as the image builds it. The path
 * is canonical: each CLI guard compares argv[1] with its module URL. */
export function stageEgressDeploy(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "oats-split-deploy-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const line of readFileSync(join(egressSource, "egress/Dockerfile"), "utf8").split("\n")) {
    if (!line.startsWith("COPY --chmod=") || !line.includes("/opt/oats/deploy/")) continue;
    const tokens = line.split(/\s+/), destination = tokens.at(-1).slice("/opt/oats/deploy/".length);
    for (const name of tokens.slice(2, -1)) {
      const target = join(directory, destination + name.split("/").at(-1));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(egressSource, name), target);
    }
  }
  writeDeployManifest({ directory, image: "egress", source: deploySourceCommit, installed: { coredns: "1.15.0", nginx: "1.22.1" } });
  return directory;
}
