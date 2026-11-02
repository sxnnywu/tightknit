import type { Digest, SlackMessage } from "./types";

// Convert a Slack timestamp to microseconds, or return undefined if it is invalid.
function timestamp(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,6})?$/.test(value)) return;
  const [seconds, fraction = ""] = value.split(".");
  return BigInt(seconds) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

/**
 * Return the week's busiest threads and unanswered questions for one channel.
 *
 * The week includes weekStart and ends just before the same time seven days later.
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
      // Record replies from all dates, including those with invalid timestamps.
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
