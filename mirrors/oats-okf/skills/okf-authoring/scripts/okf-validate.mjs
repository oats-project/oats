#!/usr/bin/env node
/**
 * okf-validate.mjs — OKF v0.1 bundle validator (no dependencies).
 *
 * Usage: node okf-validate.mjs <bundle-dir> [--strict] [--json]
 *
 * Conformance (errors): frontmatter parses; non-empty `type` on concepts;
 * reserved files (index.md, log.md) carry no `type`.
 * Producer lints (--strict, warnings): broken intra-bundle links (log.md exempt),
 * links missing .md, concepts unreachable from any index.md, missing title/description.
 * Subject layout (okf-base.json lists the reserved nodes claims, subjects and
 * verdicts; see okf-reindex.mjs), errors: a malformed flow list; a claim whose
 * `about` is missing, empty or names a subject with no file; a subject file
 * off subjects/<kind>/<slug>.md or whose type does not match its kind; a
 * Verdict outside verdicts/ or a malformed verdict; a claim under claims/
 * without `id`; a duplicate id. Lints (--strict): an old-node claim without
 * `id`; a generated index that differs from okf-reindex.mjs's output.
 * Exit: 0 conformant, 1 errors (or warnings with --strict and OKF_STRICT_EXIT), 2 usage.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, posix } from "node:path";
import { parseFrontmatter, bridged, subjectOfPath, place, KINDS, VERDICTS, SUBJECT_REF, titleHash, staleViews, textKey, assertSafeTree } from "./okf-reindex.mjs";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const asJson = args.includes("--json");
const dir = args.find((a) => !a.startsWith("--"));
if (!dir || !existsSync(dir)) { console.error("usage: okf-validate.mjs <bundle-dir> [--strict] [--json]"); process.exit(2); }
const root = resolve(dir);

const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".md")) files.push(p);
  }
})(root);

const errors = [], warnings = [];
let subjectLayout = false;
try { subjectLayout = bridged(root); } catch (e) { if (!["E_PATH", "E_TOO_LARGE"].includes(e.code)) throw e; errors.push(e.message); report(0); }
// A base with the subject layout is read only as plain directories and regular
// single-link files (as the regenerator writes it): a link, a FIFO or a
// hardlink is refused before any file is opened, never followed or read.
if (subjectLayout) try { assertSafeTree(root); } catch (e) { if (e.code !== "E_PATH") throw e; errors.push(e.message); report(0); }
const rel = (p) => relative(root, p).split("\\").join("/");
const isReserved = (p) => ["index.md", "log.md"].includes(posix.basename(rel(p)));

const concepts = new Map(); // rel path -> { meta, body }
for (const f of files) {
  const r = rel(f);
  const text = readFileSync(f, "utf8");
  const fm = parseFrontmatter(text);
  if (isReserved(f)) {
    if (fm.present && fm.parsed && fm.meta.type) errors.push(`${r}: reserved file must not carry a 'type'`);
    if (fm.present && fm.parsed && posix.basename(r) === "index.md" && r !== "index.md") {
      const keys = Object.keys(fm.meta);
      if (keys.some((k) => k !== "okf_version")) warnings.push(`${r}: only the bundle-root index.md may carry frontmatter`);
    }
    concepts.set(r, { reserved: true, body: fm.parsed ? fm.body : text });
    continue;
  }
  if (!fm.present) { errors.push(`${r}: missing YAML frontmatter`); continue; }
  if (!fm.parsed) { errors.push(`${r}: unparseable YAML frontmatter`); continue; }
  if (!fm.meta.type || (subjectLayout && Array.isArray(fm.meta.type) && !fm.meta.type.length)) errors.push(`${r}: missing or empty required field 'type'`);
  if (subjectLayout) {
    for (const key of fm.listErrors) errors.push(`${r}: malformed flow list in '${key}' (flat [a, "b"] items only)`);
    if (fm.meta.type && typeof fm.meta.type !== "string") errors.push(`${r}: 'type' must be a non-empty scalar, not a list`);
    for (const key of ["title", "description"]) if (strict && Array.isArray(fm.meta[key])) warnings.push(`${r}: '${key}' must be a scalar, not a list`);
  }
  if (strict) {
    if (!fm.meta.title) warnings.push(`${r}: missing recommended field 'title'`);
    if (!fm.meta.description) warnings.push(`${r}: missing recommended field 'description'`);
  }
  concepts.set(r, { meta: fm.meta, body: fm.body });
}

if (subjectLayout) {
  // The subject layout's semantic checks (okf.json v2 subjects, `about:` edges, verdicts).
  const list = (v) => Array.isArray(v) ? v : null;
  const subjects = new Set(), ids = new Map();
  for (const [r, c] of concepts) if (!c.reserved && subjectOfPath(r)) subjects.add(subjectOfPath(r).ref);
  const legacy = new Map();
  for (const [r, c] of concepts) {
    if (c.reserved || !c.meta) continue;
    const m = c.meta, where = place(r), type = typeof m.type === "string" ? m.type : "";
    if (type === "Verdict" && where !== "verdicts") errors.push(`${r}: a Verdict lives only under verdicts/`);
    if (where === "subjects") {
      const s = subjectOfPath(r);
      if (!s) { errors.push(`${r}: not a subject file: subjects hold only subjects/<${Object.keys(KINDS).join("|")}>/<slug>.md`); continue; }
      if (!SUBJECT_REF.test(s.ref)) errors.push(`${r}: a subject slug is lowercase letters, digits, '.', '_' and '-'`);
      if (type !== KINDS[s.kind]) errors.push(`${r}: a subject in subjects/${s.kind}/ has type ${KINDS[s.kind]}, not ${JSON.stringify(m.type)}`);
      for (const key of ["in-workstreams", "depends-on", "legacy-nodes"]) if (m[key] !== undefined && !list(m[key])) errors.push(`${r}: '${key}' must be a flow list`);
      for (const ref of list(m["in-workstreams"]) ?? []) if (!ref.startsWith("workstream/") || !subjects.has(ref)) errors.push(`${r}: in-workstreams names ${JSON.stringify(ref)}, not a workstream subject of this base`);
      for (const ref of list(m["depends-on"]) ?? []) if (!ref.startsWith("system/") || !subjects.has(ref)) errors.push(`${r}: depends-on names ${JSON.stringify(ref)}, not a system subject of this base`);
      for (const node of list(m["legacy-nodes"]) ?? []) {
        const key = textKey(String(node));
        if (legacy.has(key)) errors.push(`${r}: legacy node ${JSON.stringify(node)} is already absorbed by ${legacy.get(key)}`);
        else legacy.set(key, r);
      }
      continue;
    }
    if (where === "verdicts") {
      const id = /^verdicts\/([a-z0-9][a-z0-9._-]*)\.md$/.exec(r)?.[1];
      if (!id) errors.push(`${r}: a verdict is verdicts/<id>.md, named by the claim id it rules on`);
      if (type !== "Verdict") errors.push(`${r}: only Verdict files live under verdicts/`);
      else {
        if (!VERDICTS.includes(m.verdict)) errors.push(`${r}: verdict must be one of ${VERDICTS.join(", ")}`);
        for (const key of ["claim-type", "claim-title"]) if (!m[key] || typeof m[key] !== "string") errors.push(`${r}: missing '${key}'`);
        if (m["title-hash"] !== titleHash(m["claim-type"], m["claim-title"])) errors.push(`${r}: title-hash must be ${titleHash(m["claim-type"], m["claim-title"])} (sha256 of <claim-type>|<normalized claim-title>, 16 hex)`);
        if (["duplicate", "superseded"].includes(m.verdict) && (typeof m.canonical !== "string" || !m.canonical)) errors.push(`${r}: a ${m.verdict} verdict names the canonical claim id (one scalar id)`);
      }
      continue;
    }
    // A claim or document: in claims/ or an old node.
    const about = list(m.about);
    if (!about || !about.length) errors.push(`${r}: 'about' must list one or more subjects, as [<kind>/<slug>, ...]`);
    else for (const ref of about) if (!SUBJECT_REF.test(ref) || !subjects.has(ref)) errors.push(`${r}: about names ${JSON.stringify(ref)}, which has no subject file subjects/${ref}.md`);
    if (!m.id) { if (r.startsWith("claims/")) errors.push(`${r}: missing 'id' (stamped by the maintainer at acceptance)`); else if (strict) warnings.push(`${r}: missing 'id' (stamped by the maintainer at acceptance)`); }
    else if (typeof m.id !== "string") errors.push(`${r}: 'id' must be a scalar`);
    else if (ids.has(textKey(m.id))) errors.push(`${r}: id ${m.id} is also ${ids.get(textKey(m.id))}`);
    else ids.set(textKey(m.id), r);
  }
  if (strict) {
    try {
      const metas = new Map([...concepts].filter(([, c]) => !c.reserved).map(([r, c]) => [r, c.meta]));
      for (const s of staleViews(root, metas)) warnings.push(`${s.path}: generated index is ${s.status}; run okf-reindex.mjs`);
    } catch (e) { errors.push(`generated indexes: ${e.message}`); }
  }
}

if (strict) {
  // Link checks (log.md bodies exempt) + reachability from index files.
  const reachable = new Set();
  const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
  const resolveLink = (fromRel, target) => {
    if (/^[a-z]+:\/\//i.test(target) || target.startsWith("mailto:")) return null; // external
    const clean = target.split("#")[0];
    if (!clean) return null;
    const abs = clean.startsWith("/")
      ? posix.normalize(clean.slice(1))
      : posix.normalize(posix.join(posix.dirname(fromRel), clean));
    return abs;
  };
  for (const [r, c] of concepts) {
    const body = c.body ?? "";
    const fromLog = posix.basename(r) === "log.md";
    for (const m of body.matchAll(linkRe)) {
      const t = resolveLink(r, m[1]);
      if (t === null) continue;
      const isDir = t.endsWith("/") || concepts.has(posix.join(t, "index.md")) || existsSync(join(root, t)) && statSync(join(root, t)).isDirectory?.();
      if (posix.basename(r) === "index.md" || !fromLog) {
        if (!t.endsWith(".md") && !isDir) { if (!fromLog) warnings.push(`${r}: link missing .md extension: ${m[1]}`); continue; }
      }
      if (fromLog) continue; // history exempt from broken-link lint
      if (t.endsWith(".md") && !concepts.has(t)) warnings.push(`${r}: broken link: ${m[1]}`);
      if (posix.basename(r) === "index.md" && t.endsWith(".md") && concepts.has(t)) reachable.add(t);
      if (posix.basename(r) === "index.md" && isDir) reachable.add(posix.join(t.replace(/\/$/, ""), "index.md"));
    }
  }
  // Reachability: walk index closure (an index that lists a subdir makes that subdir's index reachable).
  for (const [r, c] of concepts) {
    if (c.reserved || reachable.has(r)) continue;
    // root-level concepts listed in root index handled above; report the rest
    const anyIndex = [...concepts.keys()].some((k) => posix.basename(k) === "index.md");
    if (anyIndex) warnings.push(`${r}: unreachable from any index.md`);
  }
}

report([...concepts.values()].filter((c) => !c.reserved).length);
/** Print the findings and exit (also early, before any file is read, when
 *  the base metadata or a subject-layout tree is refused). */
function report(conceptCount) {
  if (asJson) {
    console.log(JSON.stringify({ bundle: root, layout: subjectLayout ? "subjects" : "plain", concepts: conceptCount, errors, warnings, conformant: errors.length === 0 }, null, 2));
  } else {
    console.log(`OKF validate — ${root}`);
    console.log(`  ${conceptCount} concept(s), ${errors.length} error(s), ${warnings.length} warning(s)`);
    for (const e of errors) console.log(`  ERROR ${e}`);
    for (const w of warnings) console.log(`  warn  ${w}`);
    console.log(errors.length === 0 ? (strict && warnings.length ? "PASS (with lints)" : "PASS — conformant") : "FAIL — nonconformant");
  }
  process.exit(errors.length > 0 ? 1 : strict && warnings.length > 0 && process.env.OKF_STRICT_EXIT ? 1 : 0);
}
