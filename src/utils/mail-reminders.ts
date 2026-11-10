import { aggregateConversations, dedupeByMessageId, withCopies, normalizeMessageIdKey, type Conversation } from './mail-dedup.js';

/**
 * F5: unanswered-reply reminders over a fetched message set.
 *
 * Rule (explicit): a conversation needs a reminder when
 *  1. the user SENT at least one message in it (from one of the configured
 *     account identities),
 *  2. the newest own message is older than the user-set threshold, and
 *  3. no message from ANYONE ELSE arrived after that newest own message.
 *
 * Identity handling: "own" is the union of every configured account's
 * email/user address (lowercased) — a reply landing in a different mailbox
 * still counts. Duplicate copies of the same sent message across accounts
 * are deduplicated by Message-ID first (missing Message-IDs never merge).
 * A follow-up the user sent themselves restarts the waiting clock; their
 * own messages never answer their own thread.
 */

export interface ReminderMessage {
  messageId?: string;
  inReplyTo?: string;
  references?: string | string[];
  from?: string;
  fromAddresses?: string[];
  date?: unknown;
  subject?: string;
  accountId: string;
  accountName: string;
  folder: string;
  uid: number;
}

export interface UnansweredReminder {
  subject: string;
  /** ISO time of the newest own message still awaiting a reply. */
  lastSentAt: string;
  /** Whole days elapsed since lastSentAt (floor). */
  waitingDays: number;
  /** Where the user's own outbound copies live (deduplicated). */
  sentFrom: Array<{ accountId: string; accountName: string; folder: string; uid: number }>;
}

const ownAddressSet = (identities: string[]): Set<string> =>
  new Set(identities.map(id => id.trim().toLowerCase()).filter(Boolean));

function senderAddresses(message: ReminderMessage): string[] {
  if (Array.isArray(message.fromAddresses) && message.fromAddresses.length) {
    return message.fromAddresses.map(a => String(a).trim().toLowerCase());
  }
  const from = message.from ?? '';
  // Display-name decoys and multi-address text: take every <addr> token.
  const tokens = from.match(/<([^>]+)>/g)?.map(t => t.slice(1, -1).trim().toLowerCase()) ?? [];
  if (tokens.length) return tokens;
  return from.split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
}

function ownMessagesIn(conversation: Conversation<ReminderMessage>, own: Set<string>): ReminderMessage[] {
  return conversation.messages.filter((message: ReminderMessage) => senderAddresses(message).some(addr => own.has(addr)));
}

export function findUnansweredReminders(
  messages: ReminderMessage[],
  identities: string[],
  thresholdDays: number,
  now: Date = new Date(),
): UnansweredReminder[] {
  if (!(thresholdDays > 0)) throw new Error('Reminder threshold must be a positive number of days');
  const own = ownAddressSet(identities);
  // Duplicate copies of the same outbound message collapse before grouping.
  const { unique, copiesOf } = dedupeByMessageId(messages);
  const merged = withCopies(unique, copiesOf);
  const conversations = aggregateConversations(merged);

  const reminders: UnansweredReminder[] = [];
  for (const conversation of conversations) {
    const sent = ownMessagesIn(conversation, own);
    if (!sent.length) continue;
    const times = sent.map(message => {
      const value = new Date(message.date as unknown as string).getTime();
      return Number.isFinite(value) ? value : 0;
    });
    const lastSentTime = Math.max(...times);
    const lastSent = sent[times.indexOf(lastSentTime)];
    // Someone else answering AFTER the newest own message closes the thread.
    const answered = conversation.messages.some((message: ReminderMessage) => {
      if (senderAddresses(message).some(addr => own.has(addr))) return false;
      const value = new Date(message.date as unknown as string).getTime();
      return Number.isFinite(value) && value > lastSentTime;
    });
    if (answered) continue;
    const waitingMs = now.getTime() - lastSentTime;
    const waitingDays = Math.floor(waitingMs / 86_400_000);
    if (waitingDays < thresholdDays) continue;
    reminders.push({
      subject: conversation.subject,
      lastSentAt: new Date(lastSentTime).toISOString(),
      waitingDays,
      // Every outbound location: the surviving copy plus its deduplicated
      // duplicates, so the user sees all folders/accounts holding their mail.
      sentFrom: sent.flatMap(message => [
        { accountId: message.accountId, accountName: message.accountName, folder: message.folder, uid: message.uid },
        ...((message as { copies?: Array<{ accountId: string; accountName: string; folder: string; uid: number }> }).copies ?? []),
      ]),
    });
  }
  // Longest wait first — the reminder list reads as an actionable queue.
  reminders.sort((a, b) => b.waitingDays - a.waitingDays || a.subject.localeCompare(b.subject));
  return reminders;
}

/** Normalized conversation roots (diagnostics/tests helper). */
export function conversationRoots(messages: ReminderMessage[]): string[] {
  return aggregateConversations(messages)
    .map((conversation: { rootMessageId?: string }) => conversation.rootMessageId ?? '')
    .filter(Boolean)
    .map((id: string) => normalizeMessageIdKey(id));
}
