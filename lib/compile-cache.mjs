/** Node's compile cache for the CLI (awebai/oats#1630): V8 keeps the code it compiled for the
 *  kernel's modules, so a command does not recompile them all on every run. Kernel-private, not
 *  exported from `./core` and not a contract: `bin/oats.mjs` calls enableCliCompileCache before it
 *  imports the kernel (only dependency-free startup helpers are parsed before), and in-process
 *  consumers never call it (they run in their own processes).
 *
 *  - The cache is `$OATS_HOME_DIR/compile-cache` (`~/.oats/compile-cache`), made 0700 here: Node's
 *    default, `os.tmpdir()/node-compile-cache`, is shared by every user of the computer, and Node
 *    would make the directory 0755. Node keeps one subdirectory per Node version under it; the whole
 *    directory is safe to delete at any time.
 *  - The caller's choice wins, and Node applies it before any of this runs: with NODE_COMPILE_CACHE
 *    (another place) or NODE_DISABLE_COMPILE_CACHE (none) set, nothing is made or written under
 *    OATS_HOME_DIR. There is no OATS variable for it.
 *  - Never in the way: a Node without enableCompileCache (22.0), a directory that cannot be made or
 *    written, any throw, is simply no cache, with nothing printed. NODE_COMPILE_CACHE is never set in
 *    the environment, so hooks and other children inherit only what the caller gave.
 *  Node built-ins only, so that it parses nothing of the kernel. */
import { mkdirSync } from "node:fs";
import module from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export function enableCliCompileCache() {
  // A named import would be a link-time SyntaxError on a Node that lacks it.
  if (typeof module.enableCompileCache !== "function") return;
  // As Node reads them: any NODE_DISABLE_COMPILE_CACHE disables, even "" or "0"; an empty
  // NODE_COMPILE_CACHE is none.
  if (process.env.NODE_COMPILE_CACHE || process.env.NODE_DISABLE_COMPILE_CACHE !== undefined) return;
  try {
    const dir = join(process.env.OATS_HOME_DIR || join(homedir(), ".oats"), "compile-cache");
    // Made here first, also because Node 22 never returns from a directory it cannot make.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The string form: Node 22 takes no options object.
    module.enableCompileCache(dir);
  } catch { /* no cache */ }
}
