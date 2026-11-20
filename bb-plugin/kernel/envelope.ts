// From what one `oats … --json` process did to a typed answer. `oats` prints one JSON object on
// stdout: an envelope `{schemaVersion, ok, result | error}`, or for a few verbs the document itself
// (`oats status --json`, a first guarded `oats retire`): docs/desktop-cli-api.md "The envelope".
import { z } from "zod";
import { codes, err, ok, type Result } from "./result.js";
import type { RunOutcome } from "./run.js";

const failure = z.looseObject({
  ok: z.literal(false),
  error: z.looseObject({ code: z.string().min(1), message: z.string() }),
});
const success = z.looseObject({ schemaVersion: z.number(), ok: z.literal(true), result: z.unknown() });

const firstLines = (text: string, lines = 3): string =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .slice(0, lines)
    .join("\n");

/**
 * The JSON document a finished process answered: an envelope's `result`, or the bare document.
 * `failedDocument` is for a verb that prints its document and exits nonzero to say that the act is
 * incomplete (a retire whose cleanup stayed incomplete): a document it recognises is then answered
 * for the verb's parser to judge, instead of "exited 1". Any other nonzero exit stays a failure.
 */
export type AnswerOptions = { failedDocument?: (document: unknown) => boolean };
export function answerOf(outcome: RunOutcome, bin: string, options: AnswerOptions = {}): Result<unknown> {
  switch (outcome.kind) {
    case "spawn-error":
      return outcome.code === "ENOENT" || outcome.code === "EACCES" || outcome.code === "ENOTDIR"
        ? err(codes.notFound, `\`${bin}\` could not be run (${outcome.code}): ${outcome.message}`)
        : err(codes.failed, `\`${bin}\` could not be started: ${outcome.message}`);
    case "timeout":
      return err(codes.timeout, `\`oats\` did not answer within ${Math.round(outcome.timeoutMs / 1000)} s and was stopped`);
    case "aborted":
      return err(codes.aborted, "the call was cancelled and `oats` was stopped");
    case "overflow":
      return err(codes.tooLarge, `\`oats\` printed more than ${outcome.limit} bytes`);
    case "exit":
      break;
  }
  let document: unknown;
  try {
    document = JSON.parse(outcome.stdout);
  } catch {
    // Not JSON: say what `oats` said instead, below.
    document = undefined;
  }
  if (document === undefined) {
    const said = firstLines(outcome.stderr) || firstLines(outcome.stdout, 1);
    if (outcome.code === 0) return err(codes.notJson, `\`oats\` did not answer JSON${said ? `: ${said}` : ""}`);
    const how = outcome.signal ? `was ended by ${outcome.signal}` : `exited ${outcome.code}`;
    return err(codes.failed, `\`oats\` ${how}${said ? `: ${said}` : ""}`);
  }
  const refused = failure.safeParse(document);
  if (refused.success) return err(refused.data.error.code, refused.data.error.message);
  const enveloped = success.safeParse(document);
  const answered = enveloped.success ? enveloped.data.result : document;
  if (outcome.code !== 0 && !(outcome.signal === null && options.failedDocument?.(answered) === true)) {
    const how = outcome.signal ? `was ended by ${outcome.signal}` : `exited ${outcome.code}`;
    return err(codes.failed, `\`oats\` ${how}${firstLines(outcome.stderr) ? `: ${firstLines(outcome.stderr)}` : ""}`);
  }
  return ok(answered);
}

/** Reads `document` with `schema`; a document of another shape is a typed error naming the first fault. */
export function shaped<Schema extends z.ZodType>(schema: Schema, document: unknown, what: string): Result<z.output<Schema>> {
  const parsed = schema.safeParse(document);
  if (parsed.success) return ok(parsed.data);
  const issue = parsed.error.issues[0];
  const at = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  return err(codes.badAnswer, `\`${what}\` answered a document the plugin cannot read${at}: ${issue?.message ?? "unknown shape"}`);
}
