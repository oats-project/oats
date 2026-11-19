// The helpers the slots print with, and the pure reading of bb's pending interactions.
import { describe, expect, test } from "vitest";
import { age, clean, count, homeTail, needsYouLabel } from "../../app/format";
import { question } from "../../app/interactions";

describe("format", () => {
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
  const respond = (value: boolean | string) => ({ via: "respond", value });
  test("pi's confirm: the full title, Yes and No as booleans, through respond", () => {
    expect(question([pi({ method: "confirm", fullTitle: "Force-push?" })])).toEqual({
      interactionId: "p1",
      title: "Force-push?",
      choices: [
        { label: "Yes", answer: respond(true) },
        { label: "No", answer: respond(false) },
      ],
    });
  });
  test("pi's select: one choice per option, answered with the option itself", () => {
    expect(question([pi({ method: "select", options: ["depth 6", "depth 7"] })])!.choices).toEqual([
      { label: "depth 6", answer: respond("depth 6") },
      { label: "depth 7", answer: respond("depth 7") },
    ]);
  });
  test("pi's input and editor, and a select with odd options, give no choices", () => {
    expect(question([pi({ method: "input" })])!.choices).toEqual([]);
    expect(question([pi({ method: "editor" })])!.choices).toEqual([]);
    expect(question([pi({ method: "select", options: [1, 2] })])!.choices).toEqual([]);
    expect(question([pi({ method: "select" })])!.choices).toEqual([]);
  });
  const approval = (payload: object) => ({ id: "a", status: "pending", payload: { kind: "approval", ...payload } });
  test("an approval: what it is about, Allow (once) and Deny through resolve, only where offered", () => {
    expect(
      question([approval({ reason: "scripted", subject: { kind: "command", command: "rm -rf build" }, availableDecisions: ["allow_once", "allow_for_session", "deny"] })]),
    ).toEqual({
      interactionId: "a",
      title: "Run: rm -rf build",
      choices: [
        { label: "Allow", answer: { via: "resolve", resolution: { decision: "allow_once", grantedPermissions: null } } },
        { label: "Deny", answer: { via: "resolve", resolution: { decision: "deny" } } },
      ],
    });
    expect(question([approval({ reason: "Write notes.md", subject: { kind: "file_change" }, availableDecisions: ["deny"] })])).toEqual({
      interactionId: "a",
      title: "Write notes.md",
      choices: [{ label: "Deny", answer: { via: "resolve", resolution: { decision: "deny" } } }],
    });
    expect(question([approval({ reason: null, subject: { kind: "tool_use", tool: "WebFetch" } })])).toEqual({ interactionId: "a", title: "Use WebFetch", choices: [] });
    expect(question([approval({ reason: null })])!.title).toBeNull();
    expect(question([approval({ reason: null, title: "Approve the plan" })])!.title).toBe("Approve the plan");
  });
  const asks = (questions: object[]) => ({ id: "q", status: "pending", payload: { kind: "user_question", questions } });
  const options = [{ label: "Depth 6", value: "6" }, { value: "7" }];
  test("one question with one answer: a button per option, answered by its value under the question's id", () => {
    expect(question([asks([{ id: "depth", prompt: "Which depth?", multiSelect: false, options }])])).toEqual({
      interactionId: "q",
      title: "Which depth?",
      choices: [
        { label: "Depth 6", answer: { via: "resolve", resolution: { kind: "user_answer", answers: { depth: { selected: ["6"] } } } } },
        { label: "7", answer: { via: "resolve", resolution: { kind: "user_answer", answers: { depth: { selected: ["7"] } } } } },
      ],
    });
  });
  test("several questions, several answers, free text only, or an option with no value: the question and no choices", () => {
    const one = { id: "depth", prompt: "Which depth?", options };
    expect(question([asks([one, { ...one, id: "lr" }])])).toEqual({ interactionId: "q", title: "Which depth?", choices: [] });
    expect(question([asks([{ ...one, multiSelect: true }])])!.choices).toEqual([]);
    expect(question([asks([{ id: "depth", prompt: "Which depth?" }])])!.choices).toEqual([]);
    expect(question([asks([{ ...one, options: [{ label: "no value" }] }])])!.choices).toEqual([]);
    expect(question([asks([{ prompt: "no id", options }])])!.choices).toEqual([]);
    expect(question([asks([])])).toEqual({ interactionId: "q", title: null, choices: [] });
  });
  test("another plugin's form: its title, no choices", () => {
    expect(question([{ id: "f", status: "pending", payload: { kind: "plugin", title: "Spike question", data: {} } }])).toEqual({
      interactionId: "f",
      title: "Spike question",
      choices: [],
    });
  });
  test("only an interaction still pending counts; the first one wins", () => {
    expect(question([])).toBeNull();
    expect(question([pi({ method: "confirm" }, "resolved"), pi({ method: "confirm" }, "resolving")])).toBeNull();
    expect(question([pi({ method: "confirm" }, "resolved"), { id: "p2", status: "pending", payload: { kind: "plugin", title: "Second" } }])!.interactionId).toBe("p2");
  });
});
