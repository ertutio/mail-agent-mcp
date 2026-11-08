/**
 * F4: optional cross-mailbox deduplication and conversation aggregation for
 * search results.
 *
 * Dedup rule (explicit): messages are the SAME copy when their normalized
 * RFC822 Message-IDs are equal (angle brackets stripped, lowercased). The
 * first occurrence in the caller's order survives; every dropped copy is
 * recorded on the survivor under `copies` with its original account, folder
 * and UID. Messages WITHOUT a Message-ID are never merged — an absent or
 * unusable identity keeps every physical copy independent.
 *
 * Conversation rule (explicit): messages join the same conversation when
 * their Message-ID / In-Reply-To / References identifiers connect them
 * (union over normalized IDs). Same-subject mails WITHOUT threading headers
 * stay independent — the subject never merges anything. Messages lacking
 * all thread identifiers form single-message conversations.
 */

export interface LocatedCopy {
  accountId: string;
  accountName: string;
  folder: string;
  uid: number;
}

/** Structural input: any search-result message carrying these fields. */
export interface DedupableMessage {
  messageId?: string;
  inReplyTo?: string;
  references?: string | string[];
  date?: unknown;
  subject?: unknown;
  accountId: string;
  accountName: string;
  folder: string;
  uid: number;
}

export type Deduplicated<T extends DedupableMessage> = T & { copies?: LocatedCopy[] };

export function normalizeMessageIdKey(value: string | undefined | null): string {
  if (!value) return '';
  return value.trim().replace(/^<+/, '').replace(/>+$/, '').trim().toLowerCase();
}

function referenceKeys(message: DedupableMessage): string[] {
  const refs = message.references === undefined
    ? []
    : Array.isArray(message.references) ? message.references : String(message.references).split(/\s+/);
  return [message.inReplyTo, ...refs]
    .map(id => normalizeMessageIdKey(id as string))
    .filter(Boolean);
}

export interface DedupResult<T extends DedupableMessage> {
  /** First occurrences in caller order. */
  unique: T[];
  /** Dropped copies, keyed by the surviving message's index in `unique`. */
  copiesOf: Map<number, LocatedCopy[]>;
}

export function dedupeByMessageId<T extends DedupableMessage>(messages: T[]): DedupResult<T> {
  const seen = new Map<string, number>();
  const copiesOf = new Map<number, LocatedCopy[]>();
  const unique: T[] = [];
  for (const message of messages) {
    const key = normalizeMessageIdKey(message.messageId);
    if (!key) {
      // No reliable identity: every physical copy stays.
      unique.push(message);
      continue;
    }
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, unique.length);
      unique.push(message);
      continue;
    }
    const copies = copiesOf.get(first) ?? [];
    copies.push({ accountId: message.accountId, accountName: message.accountName, folder: message.folder, uid: message.uid });
    copiesOf.set(first, copies);
  }
  return { unique, copiesOf };
}

/** Attach the dropped-copy locations to the surviving messages. */
export function withCopies<T extends DedupableMessage>(messages: T[], copiesOf: Map<number, LocatedCopy[]>): Deduplicated<T>[] {
  return messages.map((message, index) => {
    const copies = copiesOf.get(index);
    return copies ? { ...message, copies } : message;
  });
}

export interface Conversation<T extends DedupableMessage> {
  /** Normalized Message-ID of the thread root when it is part of the result. */
  rootMessageId?: string;
  /** Subject of the newest member (headers are untrusted data). */
  subject: string;
  /** Members newest-first. */
  messages: Deduplicated<T>[];
}

const timeOf = (message: DedupableMessage): number => {
  const value = new Date(message.date as unknown as string).getTime();
  return Number.isFinite(value) ? value : 0;
};

export function aggregateConversations<T extends DedupableMessage>(messages: T[]): Conversation<T>[] {
  // Union-find over normalized identifiers: each message unions its own
  // Message-ID with every In-Reply-To/References identifier, so multi-level
  // replies connect through shared references without subject matching.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const root = parent.get(id);
    if (root === undefined || root === id) {
      parent.set(id, id);
      return id;
    }
    const resolved = find(root);
    parent.set(id, resolved);
    return resolved;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const messageIdOf = new Map<number, string>(); // message index -> its own id ('' when absent)
  for (const [index, message] of messages.entries()) {
    const own = normalizeMessageIdKey(message.messageId);
    messageIdOf.set(index, own);
    const refs = referenceKeys(message);
    if (own) find(own);
    for (const ref of refs) {
      find(ref);
      if (own) union(own, ref);
    }
  }

  const groups = new Map<string, number[]>();
  for (const [index, message] of messages.entries()) {
    const own = messageIdOf.get(index)!;
    const refs = referenceKeys(message).map(id => find(id));
    // A message without any identifier is its own conversation; it must not
    // attach to another group by subject or timing.
    const rootKey = own || refs[0];
    const groupKey = rootKey ? find(rootKey) : `solo:${index}`;
    const group = groups.get(groupKey) ?? [];
    group.push(index);
    groups.set(groupKey, group);
  }

  const conversations: Conversation<T>[] = [];
  for (const group of groups.values()) {
    const members = group
      .map(index => messages[index]!)
      .sort((a, b) => timeOf(b) - timeOf(a));
    // F4 (review): the root is determined by header relations — the member
    // that no other member replies to (earliest when several). Taking the
    // first input message mislabeled the newest reply as the root under the
    // newest-first input order.
    const memberIds = new Set(group.map(index => messageIdOf.get(index)!).filter(Boolean));
    const candidates = members.filter(member => {
      const own = normalizeMessageIdKey(member.messageId);
      return !referenceKeys(member).some(id => memberIds.has(id) && id !== own);
    });
    const earliest = candidates.length
      ? [...candidates].sort((a, b) => timeOf(a) - timeOf(b))[0]!
      : undefined;
    const rootId = earliest ? normalizeMessageIdKey(earliest.messageId) : '';
    const subject = typeof members[0]!.subject === 'string' ? members[0]!.subject as string : '';
    conversations.push({
      ...(rootId ? { rootMessageId: rootId } : {}),
      subject,
      messages: members,
    });
  }
  // Newest conversation first (by its newest member).
  conversations.sort((a, b) => timeOf(b.messages[0]!) - timeOf(a.messages[0]!));
  return conversations;
}
