import { describe, expect, it } from "vitest";
import { buildDigest } from "../src/digest";
import type { SlackMessage } from "../src/types";
import fullExport from "../data/messages.json";

const weekStart = new Date("2026-09-21T00:00:00Z");
const week = 7 * 86_400;
const message = (seconds: number, fields: Partial<SlackMessage> = {}): SlackMessage => ({
  ts: (weekStart.getTime() / 1_000 + seconds).toFixed(6),
  user: "U1", text: "Question?", ...fields,
});
const reply = (seconds: number, parent: SlackMessage, fields: Partial<SlackMessage> = {}) =>
  message(seconds, { thread_ts: parent.ts, ...fields });

describe("weekly digest rules", () => {
  it("ranks old and bot threads by weekly replies, with newer parents breaking ties", () => {
    const old = message(-100, { reply_count: 99 });
    const bot = message(10, { subtype: "bot_message" });
    const low = message(20);
    const newer = message(30);
    const result = buildDigest([
      reply(40, newer), reply(41, old), low, bot, newer,
      reply(42, old, { subtype: "bot_message" }), reply(43, bot),
      reply(44, newer), reply(45, low), reply(46, old), reply(47, bot), old,
    ], weekStart);
    expect(result.topThreads.map(t => [t.thread_ts, t.repliesThisWeek])).toEqual([
      [old.ts, 3], [newer.ts, 2], [bot.ts, 2],
    ]);
  });

  it("includes the exact start and excludes the exact end for replies and questions", () => {
    const parent = message(-100, { text: "Discussion" });
    const questions = [message(week), message(week - 0.000001), message(0), message(-1)];
    expect(buildDigest(questions, weekStart).unanswered.map(q => q.ts))
      .toEqual([questions[2].ts, questions[1].ts]);
    const replies = [-1, 0, week - 0.000001, week].map(s => reply(s, parent));
    expect(buildDigest([parent, ...replies], weekStart).topThreads[0].repliesThisWeek).toBe(2);
  });

  it("surfaces only top-level human question text, oldest first", () => {
    const older = message(1, { text: "Who else is excited?!" });
    const newer = message(2);
    const input = [newer, message(3, { text: "No question mark" }),
      message(4, { subtype: "bot_message" }), message(5, { subtype: "channel_join" }),
      reply(6, older), message(7, { user: "" }), older];
    expect(buildDigest(input, weekStart).unanswered.map(q => q.ts)).toEqual([newer.ts]);
    expect(buildDigest([newer, older], weekStart).unanswered.map(q => q.ts))
      .toEqual([older.ts, newer.ts]);
  });

  it.each([
    [0, true, true], [0, false, true], [1, false, true], [1, true, false],
    [undefined, false, true], [undefined, true, false], [-1, true, false],
  ])("handles reply_count=%s, observed=%s as unanswered=%s", (count, observed, expected) => {
    const parent = message(1, { reply_count: count });
    const input = observed ? [parent, reply(week + 1, parent)] : [parent];
    expect(buildDigest(input, weekStart).unanswered.length).toBe(expected ? 1 : 0);
  });

  it("deduplicates replies and keeps the first valid parent without mutating input", () => {
    const parent = message(1);
    const response = reply(2, parent);
    const input = [parent, response, response, { ...parent, text: "Conflicting duplicate" }];
    const before = structuredClone(input);
    input.forEach(Object.freeze);
    Object.freeze(input);
    expect(buildDigest(input, weekStart).topThreads)
      .toEqual([{ thread_ts: parent.ts, text: parent.text, repliesThisWeek: 1 }]);
    expect(input).toEqual(before);
  });

  it("handles malformed records and missing parents using the fields still available", () => {
    const parent = message(1);
    const input = [null, {}, message(3, { thread_ts: "bad" }),
      message(4, { ts: "bad" }), { ...parent, text: null }, parent,
      reply(5, parent, { ts: "invalid" }), reply(6, message(-10)),
    ] as unknown as SlackMessage[];
    expect(buildDigest(input, weekStart)).toEqual({ topThreads: [], unanswered: [] });
    const textless = { ts: message(7).ts, thread_ts: parent.ts } as SlackMessage;
    expect(buildDigest([parent, textless], weekStart).topThreads[0].repliesThisWeek).toBe(1);
  });

  it.each([null, undefined, {}, "messages"])("rejects non-array input: %s", input => {
    expect(() => buildDigest(input as SlackMessage[], weekStart)).toThrow(TypeError);
  });
  it.each([new Date("invalid"), null, "2026-09-21"])("rejects invalid dates: %s", date => {
    expect(() => buildDigest([], date as Date)).toThrow(TypeError);
  });

  it("ranks the full export by weekly rather than lifetime activity", () => {
    const result = buildDigest(fullExport as SlackMessage[], weekStart);
    expect(result.topThreads.map(t => t.repliesThisWeek)).toEqual([11, 9, 7]);
    expect(result.unanswered.some(q => q.text === "Does the analytics export include DMs?"))
      .toBe(false);
  });
});
