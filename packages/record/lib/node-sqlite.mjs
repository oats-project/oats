import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Load lazily so commands that do not use the record can still run without SQLite.
export function loadSqlite(loader = require) {
  try { return loader("node:sqlite"); }
  catch (cause) {
    throw new Error(`the turn record needs node:sqlite: use Node 22.13+ on 22.x, 23.4+ on 23.x, or a newer major (this is Node ${process.versions.node})`, { cause });
  }
}
