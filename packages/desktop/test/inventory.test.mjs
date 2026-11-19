// Artifact inventory — dormant-surface absence proof (desktop-dist contract).
//
// Desktop 0.18 deletes the dormant Diff and Jira surfaces entirely: modules,
// routes, helpers, tests, styles, imports, and harness entries. This suite
// pins the ABSENCE so a stray revert or cherry-pick cannot silently reship
// them. Markdown's /api/file stays (contract keeps it), and the framework's
// separate oats.jira capability is out of scope here.
//
// The second half (below the absence proof) is the shipped module graph: every
// file the builder ships is read, never imported, and each path it reaches must
// be in the package at the place the source expects it. That is what lets a
// shipped module import the shared home (packages/client) by a plain relative
// path without a copy or install step that could go stale.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import builder from "../electron-builder.config.cjs";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(PKG, p), "utf8");

test("inventory: main's sibling module imports are included in the packaged app", () => {
  // Top-level modules are individually allowlisted; server/ and renderer/
  // use directory globs. Derive this inventory from the real entry point
  // so extracting another helper cannot leave a source-only working app.
  const siblings = [...read("main.mjs").matchAll(/\bfrom\s+["']\.\/([^/"']+)["']/g)].map((m) => m[1]);
  assert.ok(siblings.length > 0, "entry-point sibling imports found");
  for (const module of siblings) {
    assert.ok(existsSync(join(PKG, module)), `${module}: source exists`);
    assert.ok(builder.files.includes(module), `${module}: must be included in packaged files`);
  }
});

test("inventory: dormant view modules are gone", () => {
  assert.ok(!existsSync(join(PKG, "renderer", "views", "diff.mjs")), "diff.mjs must not ship");
  assert.ok(!existsSync(join(PKG, "renderer", "views", "jira.mjs")), "jira.mjs must not ship");
});

test("inventory: server exposes no /api/diff or /api/jira route or helpers", () => {
  const src = read("server/oats-web.mjs");
  assert.ok(!/api\/diff|api\/jira/i.test(src), "no diff/jira API routes");
  assert.ok(!/\bjiraPanel\b|\bacliJson\b|\bparseRoster\b/.test(src), "no jira helpers");
  assert.ok(!/\bdiffData\b|\bparseDiffStats\b|\bsynthUntracked\b/.test(src), "no diff helpers");
  // the instance-addressed route family must not match diff/jira
  const fam = src.match(/\/api\\\/\(([a-z|]+)\)/);
  assert.ok(fam, "instance route family present");
  assert.ok(!fam[1].split("|").includes("diff") && !fam[1].split("|").includes("jira"),
    `route family must exclude diff/jira (got ${fam[1]})`);
  // /api/file (markdown) is contractually kept
  assert.ok(src.includes("/api/file"), "/api/file stays for Markdown");
});

test("inventory: renderer ships no diff/jira imports, tabs, or styles", () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(join(PKG, d), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "vendor") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|cjs|html|css)$/.test(e.name)) files.push(p);
    }
  };
  walk("renderer");
  // The renderer modules that moved to the shared home (packages/client) are still loaded by the page.
  walk("../client");
  files.push("api-url.mjs", "preload.cjs", "main.mjs", "server-compat.mjs");
  for (const f of files) {
    const src = read(f);
    assert.ok(!/views\/(diff|jira)\.mjs/.test(src), `${f}: imports a deleted view`);
    assert.ok(!/data-view="(diff|jira)"/.test(src), `${f}: dormant tab entry`);
    assert.ok(!/\/api\/(diff|jira)\b/.test(src), `${f}: references a deleted API route`);
    assert.ok(!/\.jkey\b|table\.jt\b/.test(src), `${f}: dormant jira styles`);
  }
});

// ── The shipped module graph, and the shared home (packages/client) ──────────
// Nothing below imports an app file or needs anything installed: sources are
// read as text. A path is PKG-relative with `/`, so a file of the shared home
// is `../client/x.mjs`, as the app directory names it.
//
// What a static reader sees: `import … from`, `export … from`, `import "x"`,
// `import("literal")`, `require("literal")`, `new URL("literal", import.meta.url)`
// and `join(HERE, "literal", …)` where HERE is the module's own directory; in a
// shipped HTML page, every `src=`, every `<link href=` and the import map's values.
// What it does not see is pinned by name in the last test, with what covers it.

const HOME = "../client";
const posix = (p) => p.split(sep).join("/");
const exists = (p) => existsSync(join(PKG, p));
const deps = Object.keys(JSON.parse(read("package.json")).dependencies);
/** Build products that no checkout holds until `npm ci` (postinstall: build-vendor.mjs). They ship by their pattern; nothing reads them here. */
const GENERATED = new Set(["renderer/vendor/highlight.mjs"]);

/** A glob as electron-builder's patterns use it here: `**`, `*`, `?` and literals. Anything else fails rather than be guessed. */
function globRegExp(glob) {
  assert.ok(!/[[\]{}()+@|]/.test(glob), `${glob}: a glob form this reader does not implement`);
  const body = glob.replace(/\*\*\/|\*\*|\*|\?|[.^$\\]/g, (t) => t === "**/" ? "(?:.*/)?" : t === "**" ? ".*" : t === "*" ? "[^/]*" : t === "?" ? "[^/]" : `\\${t}`);
  return new RegExp(`^${body}$`);
}
/** app-builder-lib's filter (minimatchAll): patterns in order, a `!` one only un-matches, a later one can match again; a pattern without magic also names a directory's contents. */
function matcher(patterns) {
  const parsed = patterns.flatMap((raw) => {
    const negate = raw.startsWith("!"), glob = negate ? raw.slice(1) : raw;
    const own = { negate, re: globRegExp(glob) };
    return negate || /[*?]/.test(glob) ? [own] : [own, { negate, re: globRegExp(`${glob}/**/*`) }];
  });
  return (path) => {
    let match = false;
    for (const { negate, re } of parsed) if (match === negate) match = negate ? !re.test(path) : re.test(path);
    return match;
  };
}
/** Every file under a PKG-relative directory, PKG-relative. */
function filesUnder(dir, skip = []) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(join(PKG, d), { withFileTypes: true })) {
      const p = d === "" ? e.name : `${d}/${e.name}`;
      if (skip.includes(p)) continue;
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(dir);
  return out;
}

const shippedBy = matcher(builder.files);
const shipped = new Set(filesUnder("", ["node_modules", "dist"]).filter(shippedBy));
/**
 * The directories the builder places outside the asar. The app is <resources>/app.asar and an
 * extraResources entry lands at <resources>/<to>, so from the app directory it is `../<to>`: it is
 * at the SAME RELATIVE POSITION as in the repository exactly when that equals `from`.
 */
const placed = (builder.extraResources ?? []).map((entry) => {
  const from = posix(normalize(entry.from)), to = posix(normalize(entry.to));
  return { from, to, same: posix(join("..", to)) === from, ships: matcher(entry.filter ?? ["**/*"]) };
});

/** The specifiers and literal paths a source asks for, relative ones and bare ones alike. */
function requestsOf(path, source) {
  if (path.endsWith(".html")) {
    const map = /<script\b[^>]*\btype=["']importmap["'][^>]*>([\s\S]*?)<\/script>/.exec(source);
    return [
      ...[...source.matchAll(/<[a-z]+\b[^>]*?\ssrc=["']([^"']+)["']/g), ...source.matchAll(/<link\b[^>]*?\shref=["']([^"']+)["']/g)].map((m) => m[1]),
      ...(map ? Object.values(JSON.parse(map[1]).imports ?? {}) : []),
    ];
  }
  // A static import or re-export starts a statement, which is not always the start of its line: it may follow a
  // `;`, a block's `}` or a comment's end on the same line.
  const found = [
    /(?:^|[;}]|\*\/)\s*(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']/gm,
    /(?:^|[;}]|\*\/)\s*import\s*["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bnew URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
  ].flatMap((re) => [...source.matchAll(re)].map((m) => m[1]));
  // join(HERE, "a", "b.mjs"): a file named from the module's own directory.
  if (/^const HERE = dirname\(fileURLToPath\(import\.meta\.url\)\);$/m.test(source)) {
    for (const [, list] of source.matchAll(/\bjoin\(HERE((?:,\s*["'][^"']+["'])+)\)/g)) {
      const parts = [...list.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
      if (/\.[a-z]+$/.test(parts.at(-1))) found.push(`./${parts.join("/")}`);
    }
  }
  return found;
}
/** A module loaded by a path that is not one string literal. `require()` with nothing in it is prose in a comment. */
const COMPUTED_LOAD = /\bimport\s*\(\s*(?!["'])|\brequire\s*\(\s*(?!["')])/;
const isRelative = (spec) => spec.startsWith("./") || spec.startsWith("../");
const isModule = (path) => /\.(mjs|cjs|js)$/.test(path);
const readable = (path) => (isModule(path) || path.endsWith(".html")) && !GENERATED.has(path);

/**
 * From every shipped file, follow what it reaches. Returns the files read and every problem found.
 * A relative path must be: in a production dependency's directory under node_modules (the builder
 * ships those; not followed), or a shipped file, or a file of a placed directory at the same
 * relative position whose filter ships it.
 */
function shippedGraph() {
  const problems = [], seen = new Set(), queue = [...shipped].filter(readable);
  while (queue.length) {
    const from = queue.pop();
    if (seen.has(from)) continue;
    seen.add(from);
    for (const spec of requestsOf(from, read(from)).filter(isRelative)) {
      const target = posix(normalize(join(dirname(from), spec)));
      const say = (what) => problems.push(`${from}: "${spec}" ${what}`);
      if (target.startsWith("node_modules/")) {
        const name = target.split("/").slice(1, target.startsWith("node_modules/@") ? 3 : 2).join("/");
        if (!deps.includes(name)) say(`is in ${name}, which is not a production dependency: the package does not carry it`);
        continue;
      }
      if (!target.startsWith("../")) {
        if (!shippedBy(target)) say(`is ${target}, which the builder's files do not ship`);
        else if (!GENERATED.has(target) && !exists(target)) say(`is ${target}, which does not exist`);
        else if (readable(target)) queue.push(target);
        continue;
      }
      const refused = outsideApp(target);
      if (refused) say(refused);
      else if (!exists(target)) say(`is ${target}, which does not exist`);
      else if (readable(target)) queue.push(target);
    }
  }
  return { problems, seen };
}
/** Why the package does not have a path that leaves the app directory where the source expects it, or null when it does. */
function outsideApp(target) {
  const dir = placed.find((entry) => target.startsWith(`${entry.from}/`));
  if (!dir) return `is ${target}, outside the app directory, and no extraResources entry places its directory in the package`;
  if (!dir.same) return `is ${target}, but the package has that directory at ../${dir.to}: not where this path leads`;
  if (!dir.ships(target.slice(dir.from.length + 1))) return `is ${target}, which the filter of extraResources "${dir.from}" does not ship`;
  return null;
}

test("inventory: the builder's patterns ship the app and not its tests or tools", () => {
  // The reader of the patterns is this file's own: check it against what the comments in the config promise.
  for (const path of ["main.mjs", "preload.cjs", "package.json", "server/oats-web.mjs", "renderer/index.html", "renderer/views/common.mjs", "renderer/vendor/highlight.mjs"])
    assert.ok(shippedBy(path), `${path} ships`);
  for (const path of ["renderer/harness.html", "renderer/harness-server.mjs", "test/inventory.test.mjs", "build-vendor.mjs", "electron-builder.config.cjs", "scripts/dist-smoke.mjs", "assets/brand/oats-logo.png", "README.md", "renderer/.DS_Store", "renderer/x.test.mjs"])
    assert.ok(!shippedBy(path), `${path} does not ship`);
  for (const path of GENERATED) assert.ok(shippedBy(path), `${path}: a build product, shipped by its pattern`);
});

test("inventory: every path a shipped file reaches is in the package, at the same relative position as in the repository", () => {
  const { problems, seen } = shippedGraph();
  assert.deepEqual(problems, []);
  // Not vacuous: the three places that load the shared home were read (main, the backend, the page).
  for (const start of ["main.mjs", "server/oats-web.mjs", "renderer/index.html", "renderer/shell.mjs"]) assert.ok(seen.has(start), `${start} was read`);
  assert.ok(seen.has(`${HOME}/liveness-main.mjs`), "the collector's entry, which the backend starts by path");
  // What the app does not reach of the shared home still ships (the filter takes the whole directory);
  // what it reaches is most of it, and every one of those was read above as a file that exists.
  const reached = [...seen].filter((path) => path.startsWith(`${HOME}/`));
  assert.ok(reached.length > 30, `shipped files reach the shared home (${reached.length} of its modules)`);
});

test("inventory: the session resume sweep ships whole: main's wiring, the trigger, the runner, its exec and the reader", () => {
  // main.mjs wires the trigger (session-resume-launch.mjs, ../client/session-resume-trigger.mjs), whose default run
  // is the runner (./session-resume-cli.mjs) and default read the reader (./session-resume.mjs); the runner's
  // default exec is ./file-output-exec.mjs. A packaged app missing one would fail at main's start, which no
  // window would show.
  const { problems, seen } = shippedGraph();
  assert.deepEqual(problems, []);
  for (const path of ["session-resume-launch.mjs", `${HOME}/session-resume-trigger.mjs`, `${HOME}/session-resume-cli.mjs`, `${HOME}/session-resume.mjs`, `${HOME}/file-output-exec.mjs`])
    assert.ok(seen.has(path), `${path} is reached from the shipped files`);
  assert.ok(requestsOf("main.mjs", read("main.mjs")).includes("./session-resume-launch.mjs"), "main imports its wiring");
  assert.ok(requestsOf("main.mjs", read("main.mjs")).includes("../client/session-resume-trigger.mjs"), "main imports the trigger from the shared home");
  for (const name of ["session-resume-cli.mjs", "session-resume.mjs"])
    assert.ok(requestsOf(`${HOME}/session-resume-trigger.mjs`, read(`${HOME}/session-resume-trigger.mjs`)).includes(`./${name}`), `the trigger imports ${name}`);
  assert.ok(requestsOf(`${HOME}/session-resume-cli.mjs`, read(`${HOME}/session-resume-cli.mjs`)).includes("./file-output-exec.mjs"), "the runner's default exec");
});

test("inventory: the reader of the graph refuses a path the package would not have", () => {
  // The rule the graph applies to a path that leaves the app directory, on paths the tree does not have.
  assert.equal(outsideApp("../client/cli-adapter.mjs"), null);
  assert.match(outsideApp("../client/notes.md"), /which the filter of extraResources "\.\.\/client" does not ship$/, "the shared home ships its modules only");
  assert.match(outsideApp("../pi/extension/index.ts"), /no extraResources entry places its directory/, "a sibling package the builder does not place");
  assert.match(outsideApp("../../lib/core.mjs"), /no extraResources entry places its directory/, "the kernel is never in the package");
  assert.equal(shippedBy("cli-adapter.mjs"), false, "a module that moved to the shared home is no longer listed at the app's top level");
});

test("inventory: the shared home is packages/client, and the package has it beside app.asar as client/", () => {
  assert.ok(exists(`${HOME}/liveness-main.mjs`), "packages/client holds the shared modules");
  assert.deepEqual(builder.extraResources, [{ from: HOME, to: "client", filter: ["**/*.mjs"] }],
    "one directory is placed outside the asar: the shared home, under the name it has in the repository, modules only");
  assert.equal(placed[0].same, true, "<resources>/client is ../client from <resources>/app.asar, as packages/client is from packages/desktop");
  // An extraFiles entry lands beside the executable, not beside the asar, and a relocated app directory moves `..`.
  assert.equal(builder.extraFiles, undefined);
  assert.equal(builder.directories.app, undefined);
});

test("inventory: the shared home holds .mjs modules and nothing else, flat", () => {
  // Two artifacts ship this directory: the Desktop takes its `**/*.mjs`, and the kernel tarball
  // will list the directory whole. A file only one of them would carry, or a subdirectory, makes
  // them disagree: no test, fixture, script, manifest or note goes here.
  const entries = readdirSync(join(PKG, HOME), { withFileTypes: true });
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.ok(entry.isFile(), `${HOME}/${entry.name}: the shared home is flat and holds regular files only`);
    assert.ok(entry.name.endsWith(".mjs"), `${HOME}/${entry.name}: not a .mjs module`);
    assert.ok(!/\.test\.mjs$/.test(entry.name), `${HOME}/${entry.name}: a test does not go in the shared home`);
    assert.ok(placed[0].ships(entry.name), `${HOME}/${entry.name}: a module the builder's filter does not ship`);
  }
});

test("inventory: the shared home imports Node builtins and its own files, and nothing else", () => {
  const problems = [];
  for (const path of filesUnder(HOME)) {
    const source = read(path);
    for (const spec of requestsOf(path, source)) {
      if (spec.startsWith("node:")) continue;
      const target = isRelative(spec) ? posix(normalize(join(dirname(path), spec))) : null;
      if (target === null) problems.push(`${path}: imports "${spec}", which is not a Node builtin (node:…) or a file of the shared home`);
      else if (!target.startsWith(`${HOME}/`)) problems.push(`${path}: "${spec}" leaves the shared home (${target})`);
      else if (!exists(target)) problems.push(`${path}: "${spec}" is ${target}, which does not exist`);
    }
    if (COMPUTED_LOAD.test(source)) problems.push(`${path}: loads a module by a computed path`);
    // Electron as a module or as a runtime: the names its variables carry in the environment (ELECTRON_RUN_AS_NODE) are data, not a dependency.
    if (/["']electron(?:\/[^"']*)?["']|\bprocess\.versions\.electron\b|\bprocess\.resourcesPath\b|\bprocess\.type\b|\bgetAppPath\b/.test(source)) problems.push(`${path}: names Electron`);
  }
  assert.deepEqual(problems, []);
});

/**
 * What the window's page loads: from the page itself, every script and module it names, and every
 * view (shell.mjs and shell-nav.mjs load renderer/views/*.mjs by a computed path). Returns the files
 * read and the problems: a Node builtin, or a bare specifier the page's import map does not name.
 */
function pageGraph(readFile = read, has = exists, views = filesUnder("renderer/views").filter(isModule)) {
  const page = "renderer/index.html", html = readFile(page);
  const map = /<script\b[^>]*\btype=["']importmap["'][^>]*>([\s\S]*?)<\/script>/.exec(html);
  const mapped = map ? JSON.parse(map[1]).imports ?? {} : {};
  const problems = [], seen = new Set(), queue = [page, ...views];
  while (queue.length) {
    const from = queue.pop();
    if (seen.has(from)) continue;
    seen.add(from);
    for (const spec of requestsOf(from, readFile(from))) {
      // A page names its files relative to itself, with or without `./`.
      const relative = from.endsWith(".html") || isRelative(spec);
      if (!relative) {
        if (spec.startsWith("node:")) problems.push(`${from}: imports "${spec}", a Node builtin: the page is a browser page and cannot load it`);
        else if (!Object.hasOwn(mapped, spec)) problems.push(`${from}: imports "${spec}", which the page's import map does not name`);
        continue;
      }
      const target = posix(normalize(join(dirname(from), spec)));
      if (!target.startsWith("node_modules/") && readable(target) && has(target)) queue.push(target);
    }
  }
  return { problems, seen };
}

test("inventory: the page reaches no module that imports a Node builtin", () => {
  // The window runs with nodeIntegration off and its import map names three browser modules, so a
  // `node:` import anywhere in what the page loads stops the page at load. The shared home holds both
  // kinds of module: the ones a page loads, and the ones (the kernel callers, deployment-panel.mjs) that
  // only main, the backend and a terminal client load. Nothing else in this file tells them apart.
  const { problems, seen } = pageGraph();
  assert.deepEqual(problems, []);
  // Not vacuous: the page's entry, a view, and the shared home through them were read.
  for (const path of ["renderer/index.html", "renderer/shell.mjs", "renderer/views/graph.mjs", `${HOME}/instance-graph.mjs`, `${HOME}/instance-tree.mjs`]) assert.ok(seen.has(path), `${path} was read`);
  // The switcher's words (3a) are the page's too: renderer/workspace-switcher.mjs draws its menu from them.
  assert.ok(seen.has(`${HOME}/workspace-choices.mjs`), "the page loads the switcher's words from the shared home");
  const reached = [...seen].filter((path) => path.startsWith(`${HOME}/`));
  assert.ok(reached.length > 20, `the page reaches the shared home (${reached.length} of its modules)`);
  // The modules of the shared home that import a Node builtin are the ones the page must not reach.
  const builtin = filesUnder(HOME).filter((path) => requestsOf(path, read(path)).some((spec) => spec.startsWith("node:")));
  assert.ok(builtin.includes(`${HOME}/deployment-panel.mjs`) && builtin.includes(`${HOME}/cli-adapter.mjs`), "the shared home has modules for Node only");
  assert.deepEqual(builtin.filter((path) => seen.has(path)), []);
});

test("inventory: the reader of the page's graph refuses a Node builtin, at any depth, and an unmapped bare import", () => {
  const files = {
    "renderer/index.html": '<script type="importmap">{ "imports": { "marked": "../node_modules/marked/lib/marked.esm.js" } }</script>\n<script type="module" src="shell.mjs"></script>',
    "renderer/shell.mjs": 'import { marked } from "marked";\nimport { text } from "../../client/facts.mjs";\nexport const shell = [marked, text];\n',
    "renderer/views/one.mjs": 'import { shell } from "../shell.mjs";\nexport const one = shell;\n',
    "../client/facts.mjs": "export const text = 1;\n",
  };
  const graph = (changes = {}) => { const tree = { ...files, ...changes }; return pageGraph((path) => tree[path], (path) => Object.hasOwn(tree, path), ["renderer/views/one.mjs"]); };
  assert.deepEqual(graph().problems, []);
  assert.deepEqual([...graph().seen].sort(), ["../client/facts.mjs", "renderer/index.html", "renderer/shell.mjs", "renderer/views/one.mjs"]);
  // In the shared module the page imports, which is the case this rule is for; in a view; in the page's entry.
  assert.deepEqual(graph({ "../client/facts.mjs": 'import { dirname } from "node:path";\nexport const text = dirname;\n' }).problems,
    ['../client/facts.mjs: imports "node:path", a Node builtin: the page is a browser page and cannot load it']);
  assert.match(graph({ "renderer/views/one.mjs": 'import { readFileSync } from "node:fs";\nexport const one = readFileSync;\n' }).problems[0], /^renderer\/views\/one\.mjs: imports "node:fs"/);
  assert.match(graph({ "renderer/shell.mjs": 'export const shell = () => import("node:os");\n' }).problems[0], /^renderer\/shell\.mjs: imports "node:os"/);
  // A static import that does not start its line is an import all the same: after a statement, after a block's end,
  // after a comment, and as a re-export. Each is refused where it stands, and the graph is followed through one.
  assert.match(graph({ "renderer/shell.mjs": 'const one = 1; import { readFileSync } from "node:fs";\nexport const shell = [one, readFileSync];\n' }).problems[0], /^renderer\/shell\.mjs: imports "node:fs"/);
  assert.match(graph({ "renderer/shell.mjs": 'function one() {} import "node:os";\nexport const shell = one;\n' }).problems[0], /^renderer\/shell\.mjs: imports "node:os"/);
  assert.match(graph({ "renderer/views/one.mjs": '/* the view */ import { dirname } from "node:path";\nexport const one = dirname;\n' }).problems[0], /^renderer\/views\/one\.mjs: imports "node:path"/);
  assert.match(graph({ "../client/facts.mjs": 'export const text = 1; export { sep } from "node:path";\n' }).problems[0], /^\.\.\/client\/facts\.mjs: imports "node:path"/);
  const midLine = graph({ "renderer/shell.mjs": 'export const shell = 1; import { text } from "../../client/facts.mjs"; import "../../client/more.mjs";\n',
    "../client/more.mjs": 'import { hostname } from "node:os";\nexport const more = hostname;\n' });
  assert.ok(midLine.seen.has("../client/facts.mjs") && midLine.seen.has("../client/more.mjs"), "a module reached only by an import in the middle of a line is read");
  assert.deepEqual(midLine.problems, ['../client/more.mjs: imports "node:os", a Node builtin: the page is a browser page and cannot load it']);
  // A word that only ends in `import`, and a name spelled inside another, is not one.
  assert.deepEqual(graph({ "renderer/shell.mjs": 'const reimport = 1, from = 2; reimport; from; "node:fs";\nexport const shell = [reimport, from];\n' }).problems, []);
  // A builtin without its prefix, or any package the import map does not name, cannot load either.
  assert.deepEqual(graph({ "renderer/shell.mjs": 'import { dirname } from "path";\nexport const shell = dirname;\n' }).problems, ['renderer/shell.mjs: imports "path", which the page\'s import map does not name']);
  // A module of the shared home that the page does not import may import what it likes.
  assert.deepEqual(graph({ "../client/panel.mjs": 'import { dirname } from "node:path";\nexport const panel = dirname;\n' }).problems, []);
});

test("inventory: in the shared home only the collector's entry imports own-environment.mjs", () => {
  // own-environment.mjs changes the environment of whoever imports it (#602). It is the first import
  // of a program's entry (test/cli-environment.test.mjs pins the order); a library that imported it
  // would clean the environment of every client that loads that library.
  const importers = filesUnder(HOME).filter((path) => requestsOf(path, read(path))
    .some((spec) => isRelative(spec) && posix(normalize(join(dirname(path), spec))) === `${HOME}/own-environment.mjs`));
  assert.deepEqual(importers, [`${HOME}/liveness-main.mjs`]);
  // And nothing of the shared home imports the entry, which is a program.
  for (const path of filesUnder(HOME)) assert.ok(!requestsOf(path, read(path)).includes("./liveness-main.mjs"), `${path} imports the collector's entry`);
});

test("inventory: the module loads a static reader cannot follow are these, each covered elsewhere", () => {
  const computed = [...shipped].filter((path) => isModule(path) && !GENERATED.has(path))
    .filter((path) => COMPUTED_LOAD.test(read(path))).sort();
  assert.deepEqual(computed, [
    // import(new URL(`./views/${name}.mjs`, import.meta.url)) and import(`./views/${name}.mjs`): every
    // renderer/views/*.mjs ships by renderer/**/* and is read above as a shipped file. Loaded only in the window
    // (smoke phase 5, which CI runs on the Linux leg).
    "renderer/shell-nav.mjs",
    "renderer/shell.mjs",
    // import(pathToFileURL(join(HERE, …))): the three targets are literal join(HERE, …) paths into the shared
    // home, read above. Loaded by the smoke's phase 4 on every installer leg, with the collector the backend
    // starts by path (LIVENESS).
    "server/oats-web.mjs",
  ]);
  const requests = requestsOf("server/oats-web.mjs", read("server/oats-web.mjs"));
  for (const name of ["cli-locator.mjs", "cli-adapter.mjs", "remote-roster.mjs", "liveness-main.mjs"])
    assert.ok(requests.includes(`./../../client/${name}`), `${name}: a literal path into the shared home`);
  assert.ok(read("scripts/dist-smoke.mjs").includes('collector: join(app.resources, "client", "liveness-main.mjs")'), "the smoke runs the collector from <resources>/client");
});
