import { randomUUID } from 'node:crypto';
import type { EmailAttachment, EmailComposer, EmailDeliveryReceipt } from '../types/index.js';
import {MAX_BODY_CHARS,MAX_ATTACHMENT_COUNT} from '../utils/mail-resource-limits.js';
import { composerRecipients, deliveryReceipt, normalizeAddressList } from '../utils/mail-compose.js';

export type SafeSendState = 'pending' | 'sending' | 'sent' | 'partial' | 'rejected' | 'ambiguous' | 'expired';

export interface SafeSendInput {
  accountId: string;
  accountRevision?: string;
  composer: EmailComposer;
}

export interface SafeSendPayload {
  readonly accountId: string;
  readonly accountRevision?: string;
  readonly composer: Readonly<EmailComposer>;
}

export interface SafeSendWarning {
  readonly code: 'sent_copy_timeout' | 'sent_copy_failed' | 'sent_copy_unknown';
  readonly message: string;
}

export interface SafeSendExecutionResult {
  readonly receipt?: EmailDeliveryReceipt;
  readonly warnings?: readonly SafeSendWarning[];
  readonly secondary?: Promise<SafeSendExecutionResult>;
}

export type SafeSendExecutor = (
  payload: SafeSendPayload,
) => SafeSendExecutionResult | void | Promise<SafeSendExecutionResult | void>;

export interface SafeSendPreview {
  readonly draftId: string;
  readonly expiresAt: number;
  readonly summary: {
    readonly accountId: string;
    readonly from: string;
    readonly to: readonly string[];
    readonly cc: readonly string[];
    readonly bccCount: number;
    readonly subject: string;
    readonly attachmentNames: readonly string[];
  };
}

export interface SafeSendConfirmation {
  status: 'sent' | 'already_sent' | 'partial' | 'rejected' | 'ambiguous';
  receipt: EmailDeliveryReceipt;
  warnings?: readonly SafeSendWarning[];
  alreadyConfirmed?: boolean;
}

/** Only raised when submission definitely has not begun. */
export class SafeSendPreflightError extends Error {}

export interface SafeSendServiceOptions {
  maxPendingDrafts?: number;
  maxRetainedAttachmentBytes?: number;
  executor: SafeSendExecutor;
  ttlMs?: number;
  clock?: () => number;
  id?: () => string;
}

interface DraftEntry {
  state: SafeSendState;
  expiresAt: number;
  payload?: SafeSendPayload;
  inFlight?: Promise<SafeSendConfirmation>;
  outcome?: SafeSendConfirmation;
}

function copyList(value: string | string[] | undefined): string | string[] | undefined {
  return Array.isArray(value) ? Object.freeze([...value]) as unknown as string[] : value;
}

function summaryList(value: string | string[] | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  return Object.freeze(Array.isArray(value) ? [...value] : [value]);
}

function copyAttachment(attachment: EmailAttachment): EmailAttachment {
  if (attachment.path !== undefined) {
    throw new Error('Safe-send attachment path must be materialized to Buffer content before preview');
  }
  const content = Buffer.isBuffer(attachment.content)
    ? Buffer.from(attachment.content)
    : attachment.content;
  return Object.freeze({
    filename: attachment.filename,
    content,
    contentType: attachment.contentType,
    contentDisposition: attachment.contentDisposition,
    cid: attachment.cid,
  });
}

function freezeComposer(composer: Readonly<EmailComposer>): Readonly<EmailComposer> {
  const attachments = composer.attachments
    ? Object.freeze(composer.attachments.map(copyAttachment)) as unknown as EmailAttachment[]
    : undefined;
  return Object.freeze({
    from: composer.from,
    to: copyList(normalizeAddressList(composer.to, 'to'))!,
    cc: copyList(normalizeAddressList(composer.cc, 'cc')),
    bcc: copyList(normalizeAddressList(composer.bcc, 'bcc')),
    subject: composer.subject,
    text: composer.text,
    html: composer.html,
    attachments,
    replyTo: composer.replyTo,
    inReplyTo: composer.inReplyTo,
    references: copyList(composer.references),
  });
}

function freezePayload(input: SafeSendInput | SafeSendPayload): SafeSendPayload {
  return Object.freeze({ accountId: input.accountId, accountRevision: input.accountRevision, composer: freezeComposer(input.composer) });
}

function zeroizeAttachments(payload: SafeSendPayload): void {
  for (const attachment of payload.composer.attachments ?? []) {
    if (Buffer.isBuffer(attachment.content)) attachment.content.fill(0);
  }
}

export class SafeSendService {
  private readonly executor: SafeSendExecutor;
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly id: () => string;
  private readonly drafts = new Map<string, DraftEntry>();
  private readonly maxPendingDrafts:number;
  private readonly maxRetainedAttachmentBytes:number;
  private cleanupTimer?:ReturnType<typeof setTimeout>;

  constructor(options: SafeSendServiceOptions) {
    if (!Number.isFinite(options.ttlMs ?? 300_000) || (options.ttlMs ?? 300_000) <= 0) {
      throw new Error('Safe-send TTL must be a positive finite number');
    }
    this.executor = options.executor;
    this.ttlMs = options.ttlMs ?? 300_000;
    this.clock = options.clock ?? Date.now;
    this.id = options.id ?? randomUUID;
    this.maxPendingDrafts=options.maxPendingDrafts??100;
    this.maxRetainedAttachmentBytes=options.maxRetainedAttachmentBytes??50*1024*1024;
    if(!Number.isInteger(this.maxPendingDrafts)||this.maxPendingDrafts<1||!Number.isSafeInteger(this.maxRetainedAttachmentBytes)||this.maxRetainedAttachmentBytes<1) throw new Error('Invalid preview capacity');
  }

  preview(input: SafeSendInput): SafeSendPreview {
    if((input.composer.text?.length??0)>MAX_BODY_CHARS||(input.composer.html?.length??0)>MAX_BODY_CHARS||(input.composer.attachments?.length??0)>MAX_ATTACHMENT_COUNT) throw new Error('Message preview processing limit exceeded');
    this.expireDrafts();
    const active=[...this.drafts.values()].filter(entry=>entry.payload);
    const bytes=(composer:Readonly<EmailComposer>)=>(composer.attachments??[]).reduce((sum,a)=>sum+(Buffer.isBuffer(a.content)?a.content.length:Buffer.byteLength(a.content??'')),0);
    if(active.length>=this.maxPendingDrafts||active.reduce((sum,e)=>sum+bytes(e.payload!.composer),0)+bytes(input.composer)>this.maxRetainedAttachmentBytes) throw new Error('Pending preview capacity limit exceeded');
    // Terminal IDs retain deduplication briefly, with a hard bound on metadata.
    if(this.drafts.size>=this.maxPendingDrafts+1000) {
      for(const [id,entry] of this.drafts) {if(!entry.payload){this.drafts.delete(id);break;}}
    }
    const draftId = this.id();
    if (!draftId || this.drafts.has(draftId)) throw new Error('Safe-send draft id collision');
    const payload = freezePayload(input);
    const expiresAt = this.clock() + this.ttlMs;
    this.drafts.set(draftId, { state: 'pending', expiresAt, payload });
    this.scheduleCleanup();
    const summary = Object.freeze({
      accountId: payload.accountId,
      from: payload.composer.from,
      to: summaryList(payload.composer.to),
      cc: summaryList(payload.composer.cc),
      bccCount: summaryList(payload.composer.bcc).length,
      subject: payload.composer.subject,
      attachmentNames: Object.freeze((payload.composer.attachments ?? []).map((a) => a.filename)),
    });
    return Object.freeze({ draftId, expiresAt, summary });
  }

  getState(draftId: string): SafeSendState {
    const entry = this.getDraft(draftId);
    this.expireIfNeeded(draftId, entry);
    return entry.state;
  }

  expireDrafts(): number {
    let expired = 0;
    for (const [draftId, entry] of this.drafts) {
      if (this.expireIfNeeded(draftId, entry)) expired += 1;
      else if(!entry.payload&&entry.expiresAt<=this.clock()) this.drafts.delete(draftId);
    }
    return expired;
  }

  private scheduleCleanup():void {
    if(this.cleanupTimer) clearTimeout(this.cleanupTimer);
    const times=[...this.drafts.values()].filter(e=>e.state!=='sending').map(e=>e.expiresAt);
    if(!times.length) return;
    this.cleanupTimer=setTimeout(()=>{this.cleanupTimer=undefined;this.expireDrafts();this.scheduleCleanup();},Math.max(1,Math.min(...times)-this.clock()));
    this.cleanupTimer.unref?.();
  }

  async confirm(draftId: string, confirmed: boolean): Promise<SafeSendConfirmation> {
    if (confirmed !== true) throw new Error('Safe-send confirmation requires confirmed === true');
    const entry = this.getDraft(draftId);
    this.expireIfNeeded(draftId, entry);
    if (entry.state === 'expired') throw new Error('Safe-send draft has expired');
    if (entry.inFlight) {
      await entry.inFlight;
    }
    if (entry.outcome) return { ...entry.outcome, status: entry.outcome.status === 'sent' ? 'already_sent' : entry.outcome.status, alreadyConfirmed: true };
    if (entry.state !== 'pending') throw new Error('Safe-send outcome is unavailable; retry is blocked');

    entry.state = 'sending';
    if (!entry.payload) throw new Error('Safe-send invariant violation: missing draft payload');
    const executionPayload = freezePayload(entry.payload);
    const operation = (async (): Promise<SafeSendConfirmation> => {
      let executionResult: SafeSendExecutionResult | void;
      try {
        executionResult = await this.executor(executionPayload);
      } catch (error) {
        if (error instanceof SafeSendPreflightError) {
          entry.state = 'pending';
          entry.inFlight = undefined;
          zeroizeAttachments(executionPayload);
          throw new SafeSendPreflightError('Account changed or SMTP preparation failed; create a new preview before sending');
        }
        // Provider errors may contain credentials or message content. Preserve
        // only the conservative acceptance outcome, never the raw cause.
        executionResult = undefined;
      }

      const expected = composerRecipients(executionPayload.composer);
      const receipt = deliveryReceipt(expected, executionResult?.receipt?.accepted, executionResult?.receipt?.rejected, executionResult?.receipt?.unknown);
      const status = receipt.unknown.length || !expected.length ? 'ambiguous'
        : receipt.rejected.length ? (receipt.accepted.length ? 'partial' : 'rejected') : 'sent';
      entry.outcome = { status, receipt };
      this.finish(draftId, entry, status);
      zeroizeAttachments(executionPayload);

      let warnings = executionResult?.warnings;
      try {
        const secondaryResult = await executionResult?.secondary;
        if (secondaryResult?.warnings?.length) {
          warnings = [...(warnings ?? []), ...secondaryResult.warnings];
        }
      } catch {
        warnings = [{
          code: 'sent_copy_failed',
          message: 'Saving a Sent-folder copy failed',
        }];
      }
      entry.outcome = warnings?.length ? { status, receipt, warnings } : { status, receipt };
      return entry.outcome;
    })();
    entry.inFlight = operation;
    try { return await operation; }
    finally { if (entry.inFlight === operation) entry.inFlight = undefined; }
  }

  private getDraft(draftId: string): DraftEntry {
    const entry = this.drafts.get(draftId);
    if (!entry) throw new Error('Unknown or tampered safe-send draft id');
    return entry;
  }

  private expireIfNeeded(draftId: string, entry: DraftEntry): boolean {
    if (entry.state !== 'pending' || this.clock() < entry.expiresAt) return false;
    this.finish(draftId, entry, 'expired');
    return true;
  }

  private finish(
    draftId: string,
    entry: DraftEntry,
    state: Extract<SafeSendState, 'sent' | 'partial' | 'rejected' | 'ambiguous' | 'expired'>,
  ): void {
    if (entry.payload) zeroizeAttachments(entry.payload);
    entry.state = state;
    entry.payload = undefined;
    entry.expiresAt = this.clock()+this.ttlMs;
    this.drafts.set(draftId, entry);
    this.scheduleCleanup();
  }
}
