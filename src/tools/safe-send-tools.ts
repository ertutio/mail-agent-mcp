import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountManager } from '../services/account-manager.js';
import type { ImapService } from '../services/imap-service.js';
import { SafeSendService, SafeSendPreflightError, type SafeSendExecutionResult, type SafeSendServiceOptions } from '../services/safe-send-service.js';
import type { SmtpService } from '../services/smtp-service.js';
import type { Attachment, EmailAttachment, EmailComposer, EmailContent, ImapAccount } from '../types/index.js';
import { resolveAttachmentInputPath } from '../utils/attachment-root.js';
import {materializeBoundedAttachments,MAX_BODY_CHARS} from '../utils/mail-resource-limits.js';
import { forwardBodies, replyRecipientGroups, normalizeAddressList } from '../utils/mail-compose.js';
import { accountRevision } from '../utils/account-revision.js';

const DOWNLOAD_DIR = process.env.IMAP_DOWNLOAD_DIR || join(homedir(), 'Downloads', 'imap-attachments');
const addressList = z.union([z.string(), z.array(z.string())]);
const attachmentSchema = z.object({
  filename: z.string().describe('Attachment filename shown to the recipient'),
  content: z.string().optional().describe('Base64-encoded attachment content; provide exactly one of content or path'),
  path: z.string().optional().describe('Existing file inside the configured attachment root; materialized before preview'),
  contentType: z.string().optional().describe('Optional MIME content type'),
  contentDisposition: z.enum(['attachment', 'inline']).optional().describe('Attachment disposition; use inline with cid for embedded content'),
  cid: z.string().optional().describe('Optional Content-ID referenced by HTML cid links'),
});
type AttachmentInput = z.infer<typeof attachmentSchema>;

function mergeBcc(defaults: string | string[] | undefined, explicit: string | string[] | undefined): string[] | undefined {
  const merged = [...(normalizeAddressList(defaults, 'defaultBcc') ?? []), ...(normalizeAddressList(explicit, 'bcc') ?? [])];
  return merged.length ? [...new Set(merged)] : undefined;
}

async function materializeAttachments(inputs?: AttachmentInput[]): Promise<EmailAttachment[] | undefined> {
  if (!inputs) return undefined;
  const prepared=inputs.map(input=>{
    if ((input.content === undefined) === (input.path === undefined)) throw new Error('Each attachment must provide exactly one of content or path');
    return {...input,path:input.path?resolveAttachmentInputPath(DOWNLOAD_DIR,input.path):undefined};
  });
  return materializeBoundedAttachments(prepared);
}

interface ForwardReadBinding {
  accountRevision: string;
  uidValidity?: number;
}

async function materializeOriginalAttachments(
  imapService: ImapService,
  accountId: string,
  folder: string,
  uid: number,
  attachments: readonly Attachment[],
  binding: ForwardReadBinding,
): Promise<EmailAttachment[]> {
  // T25: the original-email read and every attachment read bind to one
  // account identity — a revision change since the email was read rejects
  // at the read boundary instead of freezing another message's parts.
  if (imapService.getAccountRevision(accountId) !== binding.accountRevision) {
    throw new Error('Account identity changed while reading the original email; re-run the forward preview');
  }
  // T25 audit H2: fail closed when the mailbox identity cannot be bound -
  // silently skipping the UIDVALIDITY check would defeat the binding.
  if (binding.uidValidity === undefined) {
    throw new Error('Mailbox UIDVALIDITY unavailable; cannot bind the forward reads to the original email; re-run the forward preview');
  }
  // Same-name attachments disambiguate by occurrence order — the k-th
  // entry keyed by contentId/filename must fetch the k-th match, not
  // silently the first (the forward used to attach one file twice).
  const seen = new Map<string, number>();
  return Promise.all(attachments.map(async (attachment) => {
    const key = attachment.contentId ?? attachment.filename;
    const partIndex = seen.get(key) ?? 0;
    seen.set(key, partIndex + 1);
    const downloaded = await imapService.getAttachmentContent(
      accountId,
      folder,
      uid,
      key,
      binding.uidValidity,
      partIndex,
      binding.accountRevision,
    );
    return {
      filename: downloaded.filename,
      content: Buffer.from(downloaded.content),
      contentType: downloaded.contentType,
      contentDisposition: attachment.contentId ? 'inline' : 'attachment',
      cid: attachment.contentId,
    };
  }));
}

const DEFAULT_SENT_COPY_TIMEOUT_MS = 10_000;

interface SafeSendToolOptions extends Pick<SafeSendServiceOptions, 'clock' | 'id' | 'ttlMs'> {
  sentCopyTimeoutMs?: number;
}

async function saveSentBestEffort(
  imapService: ImapService,
  accountId: string,
  account: ImapAccount,
  rawMessage: Buffer | string | undefined,
  timeoutMs: number,
  expectedAccountRevision: string,
): Promise<SafeSendExecutionResult> {
  if (!rawMessage || account.saveToSent === false) return {};

  try {
    const result = await imapService.appendToSentFolder(
      accountId,
      rawMessage,
      account.sentFolder,
      timeoutMs,
      expectedAccountRevision,
    );
    if (result.saved) return {};
    if (result.outcomeUnknown) {
      return { warnings: [{
        code: 'sent_copy_unknown',
        message: 'Sent-folder copy outcome is unknown; it may have been saved. Check the Sent folder before retrying the copy',
      }] };
    }
    const timedOut = result.errorCategory === 'timeout';
    return {
      warnings: [{
        code: timedOut ? 'sent_copy_timeout' : 'sent_copy_failed',
        message: timedOut
          ? 'Saving a Sent-folder copy timed out'
          : 'Saving a Sent-folder copy failed',
      }],
    };
  } catch {
    return {
      warnings: [{
        code: 'sent_copy_failed',
        message: 'Saving a Sent-folder copy failed',
      }],
    };
  }
}
function previewResponse(preview: ReturnType<SafeSendService['preview']>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(preview, null, 2) }] };
}

export function safeSendTools(server: McpServer, imapService: ImapService, accountManager: AccountManager, smtpService: SmtpService, options: SafeSendToolOptions = {}): void {
  const sentCopyTimeoutMs = options.sentCopyTimeoutMs ?? DEFAULT_SENT_COPY_TIMEOUT_MS;
  if (!Number.isFinite(sentCopyTimeoutMs) || sentCopyTimeoutMs <= 0) {
    throw new Error('Sent-copy timeout must be a positive finite number');
  }
  const safeSend = new SafeSendService({ ...options, executor: async ({ accountId, accountRevision: previewRevision, composer }) => {
    const account = await accountManager.getAccount(accountId);
    if (!account || !previewRevision || accountRevision(account) !== previewRevision) {
      throw new SafeSendPreflightError('Account changed; create a new preview before sending');
    }
    const checkRevision = async () => {
      const current = await accountManager.getAccount(accountId);
      if (!current || !previewRevision || accountRevision(current) !== previewRevision) {
        throw new SafeSendPreflightError('Account changed; create a new preview before sending');
      }
    };
    await checkRevision();
    const result = await smtpService.sendEmail(accountId, account, composer as EmailComposer, checkRevision);
    return {
      receipt: result.receipt,
      secondary: result.receipt?.rejected.length && !result.receipt.accepted.length && !result.receipt.unknown.length
        ? undefined : saveSentBestEffort(imapService, accountId, account, result.rawMessage, sentCopyTimeoutMs, previewRevision),
    };
  } });

  server.registerTool('imap_preview_send_email', {
    description: 'Preview and freeze a new email without sending it. Confirm the returned draftId with imap_confirm_send.',
    inputSchema: {
      accountId: z.string().optional().describe('Account ID to send from; optional when accountName is supplied or only one account exists'),
      accountName: z.string().optional().describe('Account name alternative to accountId'),
      to: addressList.describe('Recipient address or addresses to freeze in the preview'),
      subject: z.string().describe('Email subject to freeze in the preview'),
      text: z.string().optional().describe('Optional plain-text body'),
      html: z.string().optional().describe('Optional HTML body'),
      body: z.string().optional().describe('Backward-compatible alias for text'),
      cc: addressList.optional().describe('Optional CC recipients'),
      bcc: addressList.optional().describe('Optional BCC recipients merged with account defaults'),
      replyTo: z.string().optional().describe('Optional Reply-To address'),
      attachments: z.array(attachmentSchema).optional().describe('Attachments to materialize and freeze before confirmation'),
    },
  }, async ({ accountId: rawAccountId, accountName, to, subject, text, html, body, cc, bcc, replyTo, attachments }) => {
    const accountId = accountManager.resolveAccountId(rawAccountId, accountName);
    const account = await accountManager.getAccount(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    const revision = accountRevision(account);
    const composer: EmailComposer = { from: account.email || account.user, to, subject, text: text ?? body, html, cc, bcc: mergeBcc(account.defaultBcc, bcc), replyTo, attachments: await materializeAttachments(attachments) };
    return previewResponse(safeSend.preview({ accountId, accountRevision: revision, composer }));
  });

  server.registerTool('imap_preview_reply_to_email', {
    description: 'Preview and freeze a threaded reply without sending it. Confirm the returned draftId with imap_confirm_send.',
    inputSchema: {
      accountId: z.string().optional().describe('Account ID containing the original email'),
      accountName: z.string().optional().describe('Account name alternative to accountId'),
      folder: z.string().default('INBOX').describe('Folder containing the original email'),
      uid: z.coerce.number().describe('UID of the original email'),
      text: z.string().optional().describe('Optional plain-text reply body'),
      html: z.string().optional().describe('Optional HTML reply body'),
      body: z.string().optional().describe('Backward-compatible alias for text'),
      replyAll: z.boolean().default(false).describe('Include original recipients except the sending account'),
      bcc: addressList.optional().describe('Optional BCC recipients merged with account defaults'),
      attachments: z.array(attachmentSchema).optional().describe('New reply attachments to materialize and freeze'),
    },
  }, async ({ accountId: rawAccountId, accountName, folder, uid, text, html, body, replyAll, bcc, attachments }) => {
    const accountId = accountManager.resolveAccountId(rawAccountId, accountName);
    const account = await accountManager.getAccount(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    const revision = accountRevision(account);
    const originalEmail = await imapService.getEmailContent(accountId, folder, uid, { bodyFormat: 'text' });
    const recipients = replyRecipientGroups(originalEmail, account, replyAll);
    const composer: EmailComposer = {
      from: account.email || account.user,
      to: recipients.to,
      ...(recipients.cc.length ? { cc: recipients.cc } : {}),
      subject: originalEmail.subject.startsWith('Re: ') ? originalEmail.subject : `Re: ${originalEmail.subject}`,
      text: text ?? body,
      html,
      bcc: mergeBcc(account.defaultBcc, bcc),
      inReplyTo: originalEmail.messageId,
      references: originalEmail.messageId,
      attachments: await materializeAttachments(attachments),
    };
    return previewResponse(safeSend.preview({ accountId, accountRevision: revision, composer }));
  });

  server.registerTool('imap_preview_forward_email', {
    description: 'Preview and freeze a forward without sending it. Confirm the returned draftId with imap_confirm_send.',
    inputSchema: {
      accountId: z.string().optional().describe('Account ID containing the original email'),
      accountName: z.string().optional().describe('Account name alternative to accountId'),
      folder: z.string().default('INBOX').describe('Folder containing the original email'),
      uid: z.coerce.number().describe('UID of the original email'),
      to: addressList.describe('Forward recipient address or addresses'),
      text: z.string().optional().describe('Optional text placed before the forwarded message'),
      body: z.string().optional().describe('Backward-compatible alias for text'),
      bcc: addressList.optional().describe('Optional BCC recipients merged with account defaults'),
      includeAttachments: z.boolean().default(true).describe('Materialize and freeze original attachments in the preview'),
    },
  }, async ({ accountId: rawAccountId, accountName, folder, uid, to, text, body, bcc, includeAttachments }) => {
    const accountId = accountManager.resolveAccountId(rawAccountId, accountName);
    const account = await accountManager.getAccount(accountId);
    if (!account) throw new Error(`Account ${accountId} not found`);
    const revision = accountRevision(account);
    const originalEmail = await imapService.getEmailContent(accountId, folder, uid, { bodyFormat: 'html' });
    const composer: EmailComposer = {
      from: account.email || account.user,
      to,
      subject: originalEmail.subject.startsWith('Fwd: ') ? originalEmail.subject : `Fwd: ${originalEmail.subject}`,
      ...forwardBodies(originalEmail, text ?? body ?? ''),
      bcc: mergeBcc(account.defaultBcc, bcc),
      references: originalEmail.messageId,
      attachments: includeAttachments
        ? await materializeOriginalAttachments(imapService, accountId, folder, uid, originalEmail.attachments, {
            accountRevision: revision,
            uidValidity: originalEmail.uidValidity,
          })
        : undefined,
    };
    return previewResponse(safeSend.preview({ accountId, accountRevision: revision, composer }));
  });

  server.registerTool('imap_confirm_send', {
    description: 'Send a previously frozen safe-send draft exactly once.',
    inputSchema: {
      draftId: z.string().describe('Opaque draft identifier returned by a safe-send preview tool'),
      confirmed: z.literal(true).describe('Explicit confirmation; only the literal value true is accepted'),
    },
  }, async ({ draftId, confirmed }) => {
    const result = await safeSend.confirm(draftId, confirmed);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });
}
