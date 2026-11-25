// Sandboxed preloads cannot require local files. Inline the terminal facade;
// Electron supplies the sole external module and the sandbox's Buffer shim.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(HERE, "preload.cjs")],
  bundle: true,
  platform: "browser",
  format: "cjs",
  external: ["electron"],
  outfile: join(HERE, "generated", "preload.cjs"),
  logLevel: "warning",
});
console.log("preload: generated/preload.cjs bundled");
