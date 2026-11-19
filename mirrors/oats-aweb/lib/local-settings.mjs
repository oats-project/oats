// Host-only provider settings in oats-local.yaml. Scalars and map entries use
// the same block lookup, shape checks and scalar replacement rules. Unsupported
// YAML refuses with the exact line to add by hand before any native effect.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ENTRY_NOUN = { roots: "root", residents: "resident", health: "health setting" };
export const yamlQuote = value => JSON.stringify(String(value));
const yamlScalar = value => typeof value === "boolean" ? String(value) : yamlQuote(value);

function localLines(start) {
  const file = join(start, "oats-local.yaml");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : ["schemaVersion: 2", "workspace: local"];
  while (lines.at(-1) === "") lines.pop();
  return {file, lines};
}
function blockEnd(lines, start, indent) {
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() && !lines[i].trimStart().startsWith("#") && !lines[i].startsWith(" ".repeat(indent + 1))) return i;
  }
  return lines.length;
}
function findBlockHeader(lines, start, end, indent, names) {
  const pad = " ".repeat(indent);
  let found = -1;
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#") || !line.startsWith(pad) || line.startsWith(pad + " ")) continue;
    const trimmed = line.slice(indent).trimEnd();
    for (const name of names) {
      if (!trimmed.startsWith(name) || !/^[ \t]*:/.test(trimmed.slice(name.length))) continue;
      if (found !== -1 || trimmed !== `${name}:`) return {unsupported:i, line};
      found = i;
      break;
    }
  }
  return found;
}
function ensureYamlBlock(lines, parentStart, parentEnd, indent, header) {
  const row = `${" ".repeat(indent)}${header}:`;
  for (let i = parentStart + 1; i < parentEnd; i++) if (lines[i].trimEnd() === row) return i;
  lines.splice(parentEnd, 0, row);
  return parentEnd;
}
function childIndent(lines, start, end, expected, refuse) {
  const indents = lines.slice(start + 1, end).filter(row => row.trim() && !row.trimStart().startsWith("#")).map(row => /^ */.exec(row)[0].length);
  if (indents.length && Math.min(...indents) !== expected) refuse("unsupported block indentation");
}
function awebBlock(lines, refuse) {
  if (lines.some(row => /^\s*\t/.test(row))) refuse("tabs are unsupported");
  const content = lines.filter(row => row.trim() && !row.trimStart().startsWith("#"));
  for (let i = 0; i < content.length; i++) {
    // YAML document markers are at column zero; indented text may belong
    // to a wrapped quoted scalar handled by the shared entry parser.
    const marker = /^(---|\.\.\.)(?:\s+#.*)?$/.exec(content[i].trimEnd());
    if (marker && (i !== 0 || marker[1] !== "---")) {
      refuse("multiple YAML documents or explicit document ends are unsupported");
    }
  }
  let settings = findBlockHeader(lines, 0, lines.length, 0, ["settings", '"settings"', "'settings'"]);
  if (typeof settings === "object") refuse(`line ${settings.unsupported + 1} is not a block-style settings: mapping`);
  if (settings < 0) { lines.push("settings:"); settings = lines.length - 1; }
  const settingsEnd = blockEnd(lines, settings, 0);
  childIndent(lines, settings, settingsEnd, 2, refuse);
  let aweb = findBlockHeader(lines, settings + 1, settingsEnd, 2, ["oats.aweb", '"oats.aweb"', "'oats.aweb'"]);
  if (typeof aweb === "object") refuse(`line ${aweb.unsupported + 1} is not a block-style oats.aweb: mapping`);
  if (aweb < 0) aweb = ensureYamlBlock(lines, settings, settingsEnd, 2, "oats.aweb");
  const end = blockEnd(lines, aweb, 2);
  childIndent(lines, aweb, end, 4, refuse);
  return {start:aweb, end};
}

/** Shared scalar editor, including the kernel serializer's wrapped quotes. */
function replaceScalarEntry(lines, block, blockEndIndex, indent, entryKey, row, noun, refuse) {
  const pad = " ".repeat(indent), key = yamlQuote(entryKey);
  // The public kernel serializer may wrap a scalar value and may choose a
  // plain or single-quoted key. Replace the entire scalar entry,
  // not just its first line, so a tokenless resume remains valid YAML.
  const keys = [key, entryKey, "'" + entryKey + "'"];
  // Identify the key/delimiter before examining the value. Empty or unsupported
  // tails must refuse, not disappear from duplicate detection.
  const matches = lines.flatMap((line, index) => {
    if (index <= block || index >= blockEndIndex || !line.startsWith(pad) || line.startsWith(pad + " ")) return [];
    const entry = line.slice(indent);
    for (const candidate of keys) {
      if (!entry.startsWith(candidate)) continue;
      const delimiter = /^[ \t]*:(.*)$/.exec(entry.slice(candidate.length));
      if (delimiter) {
        if (!entry.slice(candidate.length).startsWith(":")) refuse(`unsupported ${noun} delimiter`);
        return [{ index, tail: delimiter[1] }];
      }
    }
    return [];
  });
  if (matches.length > 1) refuse(`duplicate ${noun} key`);
  if (matches.length) {
    const { index: existing, tail } = matches[0];
    if (tail && !/^[ \t]/.test(tail)) refuse(`unsupported ${noun} delimiter`);
    const scalar = tail.trimStart();
    let end = existing + 1, comment = "";
    if (scalar.startsWith('"') || scalar.startsWith("'")) {
      const quote = scalar[0];
      let closed = false, escaped = false;
      for (let i = existing; i < blockEndIndex && !closed; i++) {
        if (i > existing && (!lines[i].startsWith(pad + " ") || !lines[i].trim() || lines[i].trimStart().startsWith("#"))) break;
        const part = i === existing ? scalar.slice(1) : lines[i].trimStart();
        for (let j = 0; j < part.length; j++) {
          const char = part[j];
          if (quote === '"' && escaped) { escaped = false; continue; }
          if (quote === '"' && char === "\\") { escaped = true; continue; }
          if (char !== quote) continue;
          if (quote === "'" && part[j + 1] === "'") { j++; continue; }
          const tail = part.slice(j + 1).trim();
          if (tail && !tail.startsWith("#")) refuse(`ambiguous ${noun} scalar`);
          comment = tail; closed = true; end = i + 1; break;
        }
        // A YAML backslash at end of line escapes the line break, not the
        // first character on the next line.
        escaped = false;
      }
      if (!closed) refuse(`unterminated or unsupported ${noun} scalar`);
    } else {
      if (!scalar || scalar.startsWith("#") || scalar === "null" || scalar === "~" || /^[|>&*!{[]/.test(scalar)) refuse(`unsupported ${noun} scalar`);
      comment = scalar.match(/\s+(#.*)$/)?.[1] || "";
    }
    // Never consume another setting, nested mapping or comment as a scalar.
    if (end < blockEndIndex && lines[end].trim() && !lines[end].trimStart().startsWith("#") && lines[end].startsWith(pad + " ")) {
      refuse(`ambiguous ${noun} continuation`);
    }
    lines.splice(existing, end - existing, row + (comment ? " " + comment : ""));
  } else lines.splice(blockEndIndex, 0, row);
}

/** Build a scalar update before any native effect, without writing the file. */
export function awebScalarText(key, value, {start = process.env.OATS_WORKSPACE || process.cwd()} = {}) {
  const {file, lines} = localLines(start);
  const refuse = detail => { throw new Error(`${file}: cannot safely update settings.oats.aweb.${key} automatically (${detail}); add ${key}: ${yamlQuote(value)} by hand under block-style settings.oats.aweb`); };
  const block = awebBlock(lines, refuse);
  replaceScalarEntry(lines, block.start, block.end, 4, key, `    ${key}: ${yamlQuote(value)}`, "setting", refuse);
  return {file, text:lines.join("\n") + "\n"};
}
export function recordAwebScalar(key, value, options) {
  const {file, text} = awebScalarText(key, value, options);
  atomicWrite(file, text);
}
function awebSettingText(map, entryKey, entryValue, {start = process.env.OATS_WORKSPACE || process.cwd()} = {}) {
  const {file, lines} = localLines(start);
  const refuse = detail => { throw new Error(`${file}: cannot safely update settings.oats.aweb.${map} automatically (${detail}); add this line by hand under block-style settings.oats.aweb.${map}: ${yamlQuote(entryKey)}: ${yamlScalar(entryValue)}`); };
  const aweb = awebBlock(lines, refuse);
  let block = findBlockHeader(lines, aweb.start + 1, aweb.end, 4, [map]);
  if (typeof block === "object") refuse(`line ${block.unsupported + 1} is not a block-style ${map}: mapping`);
  if (block < 0) block = ensureYamlBlock(lines, aweb.start, aweb.end, 4, map);
  const end = blockEnd(lines, block, 4);
  childIndent(lines, block, end, 6, refuse);
  replaceScalarEntry(lines, block, end, 6, entryKey, `      ${yamlQuote(entryKey)}: ${yamlScalar(entryValue)}`, ENTRY_NOUN[map], refuse);
  return {file, text:lines.join("\n") + "\n"};
}
/** The same editor preflights map updates without writing or invoking aw. */
export function assertAwebSettingRecordable(map, key, value, options) {
  awebSettingText(map, key, value, options);
}
export function recordAwebSetting(map, key, value, options) {
  const {file, text} = awebSettingText(map, key, value, options);
  atomicWrite(file, text);
}

export function atomicWrite(file, text, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basenameForTemp(file)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, file);
}
function basenameForTemp(file) { return file.split(/[\\/]/).pop() || "oats-local.yaml"; }
