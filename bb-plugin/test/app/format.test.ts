// The helpers the slots print with, and the pure reading of bb's pending interactions.
import { describe, expect, test } from "vitest";
import { REALTIME_CHANGED, instanceName } from "../../contract";
import { INSTANCE_NAME, age, clean, count, homeTail, needsYouLabel } from "../../app/format";
import { question } from "../../app/interactions";

describe("format", () => {
  test("the form's name rule is the contract's", () => {
    for (const name of ["a", "dev-1", "0abc", "a".repeat(63), "", "-a", "A", "a b", "a/b", "a_b", "a".repeat(64), "é"]) {
      expect(INSTANCE_NAME.test(name), name).toBe(instanceName.safeParse(name).success);
    }
  });
  test("the channel the app listens on is the contract's", () => {
    expect(REALTIME_CHANGED).toBe("oats/changed");
  });
  test("clean drops control characters and bidi overrides, and keeps newlines, tabs and markup as text", () => {
    expect(clean("a\u001b[31mred\u0007\u0000b")).toBe("a[31mredb");
    expect(clean("line 1\n\tline 2")).toBe("line 1\n\tline 2");
    expect(clean("\u202egnp.exe\u2066x\u2069")).toBe("gnp.exex");
    expect(clean("<b>bold</b> & é 日本")).toBe("<b>bold</b> & é 日本");
  });
  test("homeTail keeps the last two segments", () => {
    expect(homeTail("/abs/deployment/agents/oats-developer/instances/dev-a")).toBe("…/instances/dev-a");
    expect(homeTail("/home/dev-a")).toBe("/home/dev-a");
    expect(homeTail("/a/b/c/")).toBe("…/b/c");
  });
  test("age is the largest whole unit; unreadable instants give null", () => {
    const now = Date.parse("2026-11-19T12:30:00.000Z");
    expect(age("2026-11-19T12:29:40.000Z", now)).toBe("just now");
    expect(age("2026-11-19T12:22:00.000Z", now)).toBe("8 min ago");
    expect(age("2026-11-19T09:30:00.000Z", now)).toBe("3 h ago");
    expect(age("2026-11-16T12:30:00.000Z", now)).toBe("3 d ago");
    expect(age("2026-11-19T13:00:00.000Z", now)).toBe("just now"); // a clock ahead of ours
    expect(age("yesterday-ish", now)).toBeNull();
    expect(age(null, now)).toBeNull();
  });
  test("counts and the needs-you label agree in number", () => {
    expect([count(0, "agent"), count(1, "agent"), count(2, "agent")]).toEqual(["0 agents", "1 agent", "2 agents"]);
    expect(count(1, "child", "children")).toBe("1 child");
    expect([needsYouLabel(0), needsYouLabel(1), needsYouLabel(3)]).toEqual(["nothing needs you", "1 agent needs you", "3 agents need you"]);
  });
});

describe("question(): bb's pending interactions as the home draws them", () => {
  const pi = (data: object, status = "pending") => ({ id: "p1", status, payload: { kind: "provider-pi/extension-ui", title: "Confirm", data } });
  test("pi's confirm: the full title, Yes and No as booleans", () => {
    expect(question([pi({ method: "confirm", fullTitle: "Force-push?" })])).toEqual({
      interactionId: "p1",
      title: "Force-push?",
      choices: [
        { label: "Yes", value: true },
        { label: "No", value: false },
      ],
    });
  });
  test("pi's select: one choice per option, answered with the option itself", () => {
    expect(question([pi({ method: "select", options: ["depth 6", "depth 7"] })])!.choices).toEqual([
      { label: "depth 6", value: "depth 6" },
      { label: "depth 7", value: "depth 7" },
    ]);
  });
  test("pi's input and editor, and a select with odd options, give no choices", () => {
    expect(question([pi({ method: "input" })])!.choices).toEqual([]);
    expect(question([pi({ method: "editor" })])!.choices).toEqual([]);
    expect(question([pi({ method: "select", options: [1, 2] })])!.choices).toEqual([]);
    expect(question([pi({ method: "select" })])!.choices).toEqual([]);
  });
  test("the provider's approval and question kinds, and a plugin's form: a title, no choices", () => {
    expect(question([{ id: "a", status: "pending", payload: { kind: "approval", reason: "Run rm?" } }])).toEqual({ interactionId: "a", title: "Run rm?", choices: [] });
    expect(question([{ id: "q", status: "pending", payload: { kind: "user_question", questions: [{ prompt: "Which palette?" }] } }])).toEqual({
      interactionId: "q",
      title: "Which palette?",
      choices: [],
    });
    expect(question([{ id: "f", status: "pending", payload: { kind: "plugin", title: "Spike question", data: {} } }])).toEqual({
      interactionId: "f",
      title: "Spike question",
      choices: [],
    });
    expect(question([{ id: "n", status: "pending", payload: { kind: "approval", reason: null } }])!.title).toBeNull();
  });
  test("only an interaction still pending counts; the first one wins", () => {
    expect(question([])).toBeNull();
    expect(question([pi({ method: "confirm" }, "resolved"), pi({ method: "confirm" }, "resolving")])).toBeNull();
    expect(question([pi({ method: "confirm" }, "resolved"), { id: "p2", status: "pending", payload: { kind: "plugin", title: "Second" } }])!.interactionId).toBe("p2");
  });
});
