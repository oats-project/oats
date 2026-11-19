// Small pure helpers for what the slots print. No bb or React import.
import type { AgentState } from "../model/types";

/** The word each state is drawn and announced with. */
export const STATE_WORD: Record<AgentState, string> = {
  "needs-you": "needs you",
  working: "working",
  idle: "idle",
  stopped: "stopped",
  error: "error",
  unreachable: "unreachable",
};

/**
 * Text from the kernel, an agent or a person, made safe to print on one or several lines: React
 * already draws it as text, never as markup; this drops the control characters (escape sequences,
 * bells, bidi overrides) that would garble a line or reorder it. Newlines and tabs stay.
 */
export function clean(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** `…/<last two segments>` of a home path; the whole path when it is that short. */
export function homeTail(home: string): string {
  const parts = home.split("/").filter((part) => part !== "");
  if (parts.length <= 2) return home;
  return `…/${parts.slice(-2).join("/")}`;
}

/** How long ago an ISO instant was, in the largest whole unit; null when it cannot be read. */
export function age(since: string | null, now: number): string | null {
  if (since === null) return null;
  const then = Date.parse(since);
  if (Number.isNaN(then)) return null;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** "1 agent", "3 agents". */
export function count(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "nothing needs you", "1 agent needs you", "3 agents need you". */
export function needsYouLabel(n: number): string {
  if (n === 0) return "nothing needs you";
  return n === 1 ? "1 agent needs you" : `${n} agents need you`;
}
