/** Read-only package-upgrade state shared by the upgrade act and session starts.
 * Kept independent of core.mjs so checking a receipt never loads the lifecycle act. */
import { lstatSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { oatsError } from "./errors.mjs";
import { shellWord } from "./shell-word.mjs";
import { driftOf } from "./materialize.mjs";
import { parseStrictJson } from "./canonical-json.mjs";
import { readPortableBytes } from "./bounded-read.mjs";
import { canonicalHomePath } from "./real-path.mjs";

export const UPGRADE_RECEIPT_NAME_RE = /^upgrade-receipt\.[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\.json$/;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const uncertainReceipt = (home, path) => Object.assign(oatsError("E_UPGRADE_PARTIAL", `cannot safely read package-upgrade receipt state at ${path}; cannot prove a session launch is safe. Inspect the receipt and retry its recorded upgrade command, or respawn the instance; nothing was stopped or started`), { details: { home, receipt: path } });

/** Read receipt state without following directory or receipt symlinks. A corrupt record cannot
 * prove that provider adoption finished, so every reader refuses before lifecycle effects. */
export function readUpgradeReceipts(home) {
  const directory = join(home, ".oats");
  let before;
  try { before = lstatSync(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw uncertainReceipt(home, directory); }
  if (!before.isDirectory()) throw uncertainReceipt(home, directory);
  let names;
  try { names = readdirSync(directory); }
  catch { throw uncertainReceipt(home, directory); }
  const rows = [];
  for (const name of names.sort()) {
    if (!UPGRADE_RECEIPT_NAME_RE.test(name)) continue;
    const path = join(directory, name);
    try {
      const receipt = parseStrictJson(readPortableBytes(path));
      const key = name.slice("upgrade-receipt.".length, -".json".length);
      if (!object(receipt) || receipt.action !== "upgrade" || !["partial", "complete"].includes(receipt.status) || receipt.idempotencyKey !== key
        || (receipt.steps !== undefined && !object(receipt.steps))
        || ((receipt.status === "partial" || receipt.steps?.cleaned === false) && (typeof receipt.planRevision !== "string" || !receipt.planRevision.trim()))) throw new Error("invalid upgrade receipt");
      rows.push({ path, receipt });
    } catch { throw uncertainReceipt(home, path); }
  }
  try {
    const after = lstatSync(directory);
    if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) throw new Error("receipt directory changed");
  } catch { throw uncertainReceipt(home, directory); }
  return rows;
}

function retryFor(home, receipt) {
  const instance = typeof receipt.instance === "string" && receipt.instance ? receipt.instance : basename(home);
  return { instance, command: `oats instance upgrade ${shellWord(instance)}${receipt.undo === true ? " --undo" : ""} --plan-revision ${shellWord(receipt.planRevision)} --idempotency-key ${shellWord(receipt.idempotencyKey)}` };
}

/** The command that finishes the upgrade whose regular file is at the home's `.oats-start.lock`,
 * or null when no regular file is there (a start makes nothing at that path). A start never
 * reclaims an upgrade's file, even if its owner died during the initial write. */
export function upgradeMutexRetry(home) {
  const path = join(home, ".oats-start.lock");
  try { if (!lstatSync(path).isFile()) return null; }
  catch { return null; }
  try {
    const owner = parseStrictJson(readPortableBytes(path));
    if (object(owner) && owner.action === "upgrade" && owner.instance === basename(home)
      && typeof owner.home === "string" && canonicalHomePath(owner.home) === canonicalHomePath(home)
      && typeof owner.planRevision === "string" && owner.planRevision.trim()
      && typeof owner.idempotencyKey === "string" && UPGRADE_RECEIPT_NAME_RE.test(`upgrade-receipt.${owner.idempotencyKey}.json`)
      && (owner.undo === undefined || typeof owner.undo === "boolean")) return retryFor(home, owner).command;
  } catch { /* An empty or incomplete write still belongs to the upgrade act. */ }
  return `${retryFor(home, { planRevision: "<original-plan-revision>", idempotencyKey: "<original-idempotency-key>" }).command} (use the original revision and key, and include --undo if originally used)`;
}

/** A provider may already have adopted host state. A partial upgrade must finish forward
 * before any launch hook or harness runs against the home's module copies. */
export function assertNoPartialUpgrade(home) {
  for (const { path, receipt } of readUpgradeReceipts(home)) {
    if (receipt.status !== "partial") continue;
    const { instance, command } = retryFor(home, receipt);
    throw Object.assign(oatsError("E_UPGRADE_PARTIAL", `the package upgrade of ${instance} is partial (${path}); nothing was stopped or started. Retry ${command} to finish it; if it cannot finish, respawn the instance`), {
      details: { home, receipt: path, instance, idempotencyKey: receipt.idempotencyKey },
    });
  }
}

/** Swap and baseline already committed: launch is safe while event/cleanup finalization is retried. */
export function upgradeCleanupWarnings(home) {
  return readUpgradeReceipts(home)
    .filter(({ receipt }) => receipt.status === "complete" && receipt.steps?.cleaned === false)
    .map(({ path, receipt }) => {
      const { instance, command } = retryFor(home, receipt);
      return `the package upgrade of ${instance} is complete, but staging cleanup remains (${path}); retry ${command} to finish cleanup`;
    });
}

/** Only package modules that can move to a different locked commit. Removed packages
 * and member drift remain information for status; neither is offered as an upgrade. */
export function packageUpgradeDrift(meta, { lock } = {}) {
  return driftOf(meta, null, { lock })
    .filter((row) => row.from.kind === "package" && row.status === "moved")
    .map((row) => ({
      capability: row.module,
      recorded: { version: row.recorded.version ?? null, commit: row.recorded.commit ?? null },
      locked: { version: row.current.version ?? null, commit: row.current.commit ?? null },
    }));
}

/** The start's line for package modules an upgrade cannot move: their package is no longer locked, or no
 *  longer provides the capability. An upgrade keeps them; a respawn moves the home onto the lock.
 *  → a warning string, or null when there are none. */
export function packageRespawnWarning(meta, { lock } = {}) {
  const rows = driftOf(meta, null, { lock }).filter((row) => row.from.kind === "package" && row.status === "missing");
  if (!rows.length) return null;
  const why = (row) => row.reason === "capability-absent" ? `package ${row.recorded.package} no longer provides it` : `package ${row.recorded.package} is no longer locked`;
  return `${rows.length} package module(s) cannot move in place (${rows.map((row) => `${row.module}: ${why(row)}`).join("; ")}); an upgrade keeps them as they are, so respawn this instance to move it onto the lock`;
}
