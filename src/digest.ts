import type { Digest, SlackMessage } from "./types";

function timestamp(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,6})?$/.test(value)) return;
  const [seconds, fraction = ""] = value.split(".");
  return BigInt(seconds) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

/**
 * Build the weekly digest for one Slack channel.
 *
 * The interval includes weekStart and excludes weekStart + 7 days.
 * Rank up to three threads by weekly replies, then newest parent first.
 * Surface top-level human questions oldest first when reply_count is explicitly
 * zero OR no replies are observed anywhere in the export. Missing counts alone
 * do not override observed replies. Invalid records are ignored where unusable;
 * invalid arguments throw. Input messages are never modified.
 */
export function buildDigest(messages: SlackMessage[], weekStart: Date): Digest {
  if (!Array.isArray(messages)) throw new TypeError("messages must be an array");
  if (!(weekStart instanceof Date) || !Number.isFinite(weekStart.getTime())) {
    throw new TypeError("weekStart must be a valid Date");
  }
  const start = BigInt(weekStart.getTime()) * 1_000n;
  const end = start + 7n * 86_400n * 1_000_000n;
  const inWeek = (time: bigint) => time >= start && time < end;
  const parents: { message: SlackMessage; time: bigint }[] = [];
  const seen = new Set<string>();
  const observedReplies = new Set<string>();
  const weeklyReplies = new Map<string, number>();

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.thread_ts !== undefined && timestamp(message.thread_ts) === undefined) continue;
    const time = timestamp(message.ts);
    const isReply = message.thread_ts !== undefined && message.thread_ts !== message.ts;
    if (!isReply && (time === undefined || typeof message.text !== "string")) continue;
    if (time !== undefined) {
      if (seen.has(message.ts)) continue;
      seen.add(message.ts);
    }

    if (isReply) {
      const thread = message.thread_ts!;
      // Even an undated or textless reply establishes a response overall.
      observedReplies.add(thread);
      if (time !== undefined && inWeek(time)) {
        weeklyReplies.set(thread, (weeklyReplies.get(thread) ?? 0) + 1);
      }
    } else if (time !== undefined && message.subtype !== "channel_join") {
      parents.push({ message, time });
    }
  }

  const topThreads = parents
    .map(({ message, time }) => ({ message, time, count: weeklyReplies.get(message.ts) ?? 0 }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count || Number(b.time - a.time))
    .slice(0, 3)
    .map(({ message, count }) => ({
      thread_ts: message.ts,
      text: message.text,
      repliesThisWeek: count,
    }));
  const unanswered = parents
    .filter(({ message, time }) =>
      inWeek(time) && message.subtype !== "bot_message" &&
      typeof message.user === "string" && message.user.trim().length > 0 &&
      message.text.includes("?") &&
      (message.reply_count === 0 || !observedReplies.has(message.ts)),
    )
    .sort((a, b) => Number(a.time - b.time))
    .map(({ message }) => ({ ts: message.ts, user: message.user, text: message.text }));

  return { topThreads, unanswered };
}
