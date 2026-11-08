import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { normalizeMessageIdKey, dedupeByMessageId, withCopies, aggregateConversations } from '../src/utils/mail-dedup.js';
import { unifiedSearchTools } from '../src/tools/unified-search-tools.js';

// F4: optional cross-mailbox dedup and conversation aggregation.
// - Dedup matches exact normalized Message-IDs; copies without a Message-ID
//   are never merged; survivors carry every dropped location.
// - Conversations connect ONLY through Message-ID/In-Reply-To/References
//   (union over normalized ids); same-subject independent mails stay apart.

const base = (overrides: Record<string, unknown>) => ({
  accountId: 'a1', accountName: 'A1', folder: 'INBOX', uid: 1,
  date: new Date('2026-01-01T00:00:00Z'), subject: 'F4',
  ...overrides,
});

describe('F4: dedupeByMessageId', () => {
  it('F4-DEDUP-CROSS-ACCOUNT: same Message-ID in two accounts/folders keeps one with both locations', () => {
    const messages = [
      base({ uid: 10, messageId: '<copy@synth.test>' }),
      base({ accountId: 'a2', accountName: 'A2', folder: 'Archive', uid: 99, messageId: '<Copy@synth.test>' }), // case/brackets differ
    ];
    const { unique, copiesOf } = dedupeByMessageId(messages);
    expect(unique).toHaveLength(1);
    expect(unique[0].uid).toBe(10);
    const merged = withCopies(unique, copiesOf);
    expect((merged[0] as any).copies).toEqual([
      { accountId: 'a2', accountName: 'A2', folder: 'Archive', uid: 99 },
    ]);
  });

  it('F4-DEDUP-NO-ID: messages without a Message-ID are never merged, even with identical subjects', () => {
    const messages = [
      base({ uid: 1, messageId: undefined, subject: 'same subject' }),
      base({ uid: 2, messageId: '', subject: 'same subject' }),
    ];
    const { unique, copiesOf } = dedupeByMessageId(messages);
    expect(unique).toHaveLength(2);
    expect(withCopies(unique, copiesOf).every(m => (m as any).copies === undefined)).toBe(true);
  });

  it('F4-DEDUP-TRIPLE: three copies collapse onto the first with two recorded locations', () => {
    const messages = [
      base({ uid: 1, messageId: '<x@t>' }),
      base({ accountId: 'a2', accountName: 'A2', uid: 2, messageId: '<x@t>' }),
      base({ accountId: 'a3', accountName: 'A3', uid: 3, messageId: '<x@t>' }),
    ];
    const { unique, copiesOf } = dedupeByMessageId(messages);
    expect(unique).toHaveLength(1);
    expect((withCopies(unique, copiesOf)[0] as any).copies).toHaveLength(2);
  });

  it('F4-NORMALIZE: brackets, whitespace and case are not identity', () => {
    expect(normalizeMessageIdKey(' <A@B.test> ')).toBe('a@b.test');
  });
});

describe('F4: aggregateConversations', () => {
  it('F4-CONV-MULTI-LEVEL: root, reply and reply-to-reply connect across accounts', () => {
    const messages = [
      base({ uid: 1, messageId: '<root@t>', subject: 'Root', date: new Date('2026-01-01T00:00:00Z') }),
      base({ accountId: 'a2', accountName: 'A2', uid: 2, messageId: '<re1@t>', inReplyTo: '<root@t>', subject: 'Re: Root', date: new Date('2026-01-02T00:00:00Z') }),
      base({ accountId: 'a3', accountName: 'A3', uid: 3, messageId: '<re2@t>', references: '<root@t> <re1@t>', subject: 'Re: Root', date: new Date('2026-01-03T00:00:00Z') }),
    ];
    const conversations = aggregateConversations(messages);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].rootMessageId).toBe('root@t');
    expect(conversations[0].messages.map(m => m.uid)).toEqual([3, 2, 1]); // newest first
    expect(conversations[0].subject).toBe('Re: Root');
  });

  it('F4-CONV-SAME-SUBJECT-INDEPENDENT: identical subjects without headers stay separate', () => {
    const messages = [
      base({ uid: 1, messageId: '<a@t>', subject: 'Quarterly report' }),
      base({ accountId: 'a2', accountName: 'A2', uid: 2, messageId: '<b@t>', subject: 'Quarterly report' }),
    ];
    const conversations = aggregateConversations(messages);
    expect(conversations).toHaveLength(2);
  });

  it('F4-CONV-NO-HEADERS: messages without any identifier are single-message conversations', () => {
    const messages = [
      base({ uid: 1, messageId: undefined, subject: 'no id 1' }),
      base({ accountId: 'a2', accountName: 'A2', uid: 2, messageId: undefined, subject: 'no id 2' }),
      base({ uid: 3, inReplyTo: '<missing-parent@t>', subject: 'orphan reply' }),
    ];
    const conversations = aggregateConversations(messages);
    expect(conversations).toHaveLength(3);
  });

  it('F4-CONV-REFERENCE-BRIDGE: a reply found before its root still joins the same conversation', () => {
    const messages = [
      base({ uid: 1, messageId: '<child@t>', inReplyTo: '<parent@t>', date: new Date('2026-01-02T00:00:00Z') }),
      base({ accountId: 'a2', accountName: 'A2', uid: 2, messageId: '<parent@t>', date: new Date('2026-01-01T00:00:00Z') }),
    ];
    const conversations = aggregateConversations(messages);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].messages).toHaveLength(2);
  });
});

// Tool-level: flags are opt-in, the flat shape is unchanged without them,
// and the continuation filterKey is identical for flag-free searches so old
// cursors stay valid.
const accounts = [
  { id: 'a1', name: 'A1', host: 'imap.a.synth.test' },
  { id: 'a2', name: 'A2', host: 'imap.b.synth.test' },
];
const filterKeyFor = (args: Record<string, unknown>) => createHash('sha256').update(JSON.stringify({
  criteria: {}, limit: 50, searchAllFolders: true, folder: 'INBOX', includeTrash: false, includeSpam: false, includeDrafts: false,
  ...(args.dedupe ? { dedupe: true } : {}), ...(args.groupByConversation ? { conversationGroup: true } : {}),
})).digest('hex');

function setupTool() {
  let handler: any;
  const manager = {
    getAllAccounts: () => accounts,
    resolveAccountId: (_id: string | undefined, name: string | undefined) => accounts.find(a => a.name === name)!.id,
  };
  const pages = new Map<string, number>();
  const imap = {
    listFolders: vi.fn(async () => [{ name: 'INBOX', delimiter: '/', attributes: [] }]),
    searchEmailPage: vi.fn(async (id: string) => {
      const page = (pages.get(id) ?? 0) + 1;
      pages.set(id, page);
      return {
        messages: page === 1 ? [id === 'a1'
          ? { uid: 1, date: new Date('2026-01-01T02:00:00Z'), subject: 'F4', from: 's@t', to: [], messageId: '<copy@t>', flags: [], customKeywords: [] }
          : { uid: 2, date: new Date('2026-01-01T01:00:00Z'), subject: 'F4', from: 's@t', to: [], messageId: '<copy@t>', flags: [], customKeywords: [] }] : [],
        matched: page === 1 ? 1 : 0,
        // Continue after page 1 so the response carries cursors whose
        // filterKey encodes the flag combination; the folder hits the page
        // cap and stays pending with the advanced position.
        nextCursor: { beforeUid: Math.max(0, 10 - page), uidValidity: 123 },
      };
    }),
  };
  unifiedSearchTools({ registerTool: (_n: string, _s: any, h: any) => { handler = h; } } as any, imap as any, manager as any);
  return { handler, imap };
}

describe('F4: unified search flags', () => {
  it('F4-TOOL-DEDUP: dedupe keeps one copy with the other location attached', async () => {
    const { handler } = setupTool();
    const result = JSON.parse((await handler({ dedupe: true, limit: 50 })).content[0].text);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].accountId).toBe('a1');
    expect(result.messages[0].copies).toEqual([{ accountId: 'a2', accountName: 'A2', folder: 'INBOX', uid: 2 }]);
    expect(result.conversations).toBeUndefined();
  });

  it('F4-TOOL-CONVERSATIONS: conversation aggregation groups the copies and keeps the flat list', async () => {
    const { handler } = setupTool();
    const result = JSON.parse((await handler({ dedupe: false, groupByConversation: true, limit: 50 })).content[0].text);
    expect(result.messages).toHaveLength(2); // flat list untouched without dedupe
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0].rootMessageId).toBe('copy@t');
    expect(result.conversations[0].messages).toHaveLength(2);
  });

  it('F4-TOOL-OFF: without the flags the output shape and filterKey are unchanged', async () => {
    const { handler } = setupTool();
    const result = JSON.parse((await handler({ limit: 50 })).content[0].text);
    expect(result.messages).toHaveLength(2);
    expect(result.conversations).toBeUndefined();
    expect(result.cursors.every((c: any) => c.filterKey === filterKeyFor({}))).toBe(true);
  });

  it('F4-TOOL-FILTERKEY: the flags join the continuation filter key', async () => {
    const { handler } = setupTool();
    const result = JSON.parse((await handler({ dedupe: true, groupByConversation: true, limit: 50 })).content[0].text);
    expect(result.cursors.every((c: any) => c.filterKey === filterKeyFor({ dedupe: true, groupByConversation: true }))).toBe(true);
    // And a flag-free cursor cannot continue a flagged search (different key).
    expect(result.cursors[0].filterKey).not.toBe(filterKeyFor({}));
  });
});

// F4 review: the REAL read chain must deliver the threading identifiers.
// searchEmailPage previously dropped in-reply-to/references, so a genuine
// root+reply mailbox still aggregated into two conversations. These tests
// drive the real ImapService over a mocked imapflow connection and assert
// through the unified handler.
import { ImapService } from '../src/services/imap-service.js';

interface F4Msg {
  uid: number;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  subject: string;
  date: string;
}

const f4Imap = (pageUids: number[][], byUid: Map<number, F4Msg>) => {
  const svc = new ImapService();
  const queue = [...pageUids];
  const client = {
    mailbox: { uidValidity: 111n, uidNext: 1000 },
    list: vi.fn(async () => [{ path: 'INBOX', delimiter: '/', flags: [] }]),
    getMailboxLock: async () => ({ release: () => {} }),
    status: vi.fn(async () => ({ uidValidity: 111n, uidNext: 1000 })),
    search: vi.fn(async () => (queue.length > 1 ? queue.shift()! : queue[0]!)),
    fetch: vi.fn((uids: number[]) => {
      const items = uids.map(uid => {
        const m = byUid.get(uid)!;
        const headers = m.references ? `References: ${m.references}\r\n` : '';
        return {
          uid,
          envelope: { messageId: m.messageId, inReplyTo: m.inReplyTo, subject: m.subject, date: m.date },
          flags: new Set<string>(),
          internalDate: m.date,
          headers,
        };
      });
      return { [Symbol.asyncIterator]: () => {
        let i = 0;
        return { next: async () => (i < items.length ? { done: false as const, value: items[i++] } : { done: true as const, value: undefined }) };
      } };
    }),
  };
  vi.spyOn(svc as any, 'ensureConnected').mockResolvedValue(client);
  return { svc, client };
};
const f4Runner = (svc: ImapService, accounts: Array<{ id: string; name: string; host: string }>) => {
  let handler: any;
  unifiedSearchTools({ registerTool: (_n: string, _s: any, h: any) => { handler = h; } } as any, svc as any, {
    getAllAccounts: () => accounts,
    resolveAccountId: (_id: any, name?: string) => accounts.find(a => a.name === name)!.id,
  } as any);
  return async (args: any) => JSON.parse((await handler(args)).content[0].text);
};

const f4Accounts = [
  { id: 'a1', name: 'A1', host: 'imap.a.synth.test' },
  { id: 'a2', name: 'A2', host: 'imap.b.synth.test' },
];

describe('F4 review: real read chain carries threading headers into aggregation', () => {
  it('F4-REAL-CHAIN-REPLIES: a genuine root+reply mailbox aggregates into ONE conversation', async () => {
    const root: F4Msg = { uid: 3, messageId: '<root@t>', subject: 'Root', date: '2026-01-01T00:00:00Z' };
    const reply: F4Msg = { uid: 9, messageId: '<re@t>', inReplyTo: '<root@t>', references: '<root@t>', subject: 'Re: Root', date: '2026-01-02T00:00:00Z' };
    const { svc } = f4Imap([[9, 3]], new Map([[9, reply], [3, root]]));
    const run = f4Runner(svc, [f4Accounts[0]!]);
    const result = await run({ groupByConversation: true, limit: 50 });
    expect(result.conversations).toHaveLength(1);
    expect((result.conversations as any[])[0].rootMessageId).toBe('root@t');
    expect((result.conversations as any[])[0].messages).toHaveLength(2);
  });

  it('F4-REAL-CHAIN-NEWEST-FIRST-ROOT: the newest reply is not mislabeled as the root', async () => {
    const root: F4Msg = { uid: 3, messageId: '<root@t>', subject: 'Root', date: '2026-01-01T00:00:00Z' };
    const reply: F4Msg = { uid: 9, messageId: '<re@t>', inReplyTo: '<root@t>', subject: 'Re: Root', date: '2026-01-05T00:00:00Z' };
    // Newest-first page order: the reply arrives before the root.
    const { svc } = f4Imap([[9, 3]], new Map([[9, reply], [3, root]]));
    const run = f4Runner(svc, [f4Accounts[0]!]);
    const result = await run({ groupByConversation: true, limit: 50 });
    expect((result.conversations as any[])[0].rootMessageId).toBe('root@t');
  });

  it('F4-REAL-CHAIN-REFERENCES-ONLY: a References-only reply still connects without In-Reply-To', async () => {
    const root: F4Msg = { uid: 3, messageId: '<root@t>', subject: 'Root', date: '2026-01-01T00:00:00Z' };
    const reply: F4Msg = { uid: 9, messageId: '<re@t>', references: '<root@t>', subject: 'Re: Root', date: '2026-01-03T00:00:00Z' };
    const { svc } = f4Imap([[9, 3]], new Map([[9, reply], [3, root]]));
    const run = f4Runner(svc, [f4Accounts[0]!]);
    const result = await run({ groupByConversation: true, limit: 50 });
    expect(result.conversations).toHaveLength(1);
    expect((result.conversations as any[])[0].messages).toHaveLength(2);
  });

  it('F4-REAL-CHAIN-CROSS-ACCOUNT: a reply landing in another mailbox stays in one conversation', async () => {
    const root: F4Msg = { uid: 3, messageId: '<root@t>', subject: 'Root', date: '2026-01-01T00:00:00Z' };
    const reply: F4Msg = { uid: 41, messageId: '<re@t>', inReplyTo: '<root@t>', subject: 'Re: Root', date: '2026-01-02T00:00:00Z' };
    // Two accounts are queried concurrently: account pages are independent.
    let a1Done = false;
    const { svc } = f4Imap([[3], [41]], new Map([[3, root], [41, reply]]));
    const clientSpy = vi.spyOn(svc as any, 'ensureConnected');
    const run = f4Runner(svc, f4Accounts);
    const result = await run({ groupByConversation: true, limit: 50 });
    // listFolders + searchEmailPage per account.
    expect(clientSpy).toHaveBeenCalledTimes(4);
    void a1Done;
    expect(result.conversations).toHaveLength(1);
    expect((result.conversations as any[])[0].messages).toHaveLength(2);
  });
});
