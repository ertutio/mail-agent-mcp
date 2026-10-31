import nodemailer, { type Transporter, type SendMailOptions } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { ImapAccount, EmailComposer, SmtpConfig, EmailDeliveryReceipt } from '../types/index.js';
import { assertCredentialsResolved } from '../utils/env-credentials.js';
import { AccountAuthResolver, buildSmtpAuth } from '../credentials/account-auth.js';
import { resolveMailProxy } from '../utils/mail-proxy.js';
import {materializeBoundedAttachments,MAX_BODY_CHARS} from '../utils/mail-resource-limits.js';
import { composerRecipients, mailboxAddresses, deliveryReceipt, normalizeAddressList } from '../utils/mail-compose.js';
import { SafeSendPreflightError } from './safe-send-service.js';

/**
 * Per-recipient acceptance contract for a submitted message (T21 / MAIL-10).
 * sent is true only when every reported recipient was accepted; transports
 * without recipient data leave sent undefined with unknownRecipients set.
 * Nothing here claims final delivery — only SMTP-level acceptance.
 */
export interface SmtpSendResult {
  messageId: string;
  receipt: EmailDeliveryReceipt;
  rawMessage?: Buffer;
  /** true only when every reported recipient was accepted. */
  sent?: boolean;
  accepted?: string[];
  rejected?: string[];
  /** Present when the transport reported no per-recipient data. */
  unknownRecipients?: string;
  /** Human-readable outcome for partial/full rejection. */
  message?: string;
}

export class SmtpService {
  private transporters: Map<string, Set<Transporter>> = new Map();

  constructor(private readonly authResolver: AccountAuthResolver = new AccountAuthResolver()) {}

  async createTransporter(account: ImapAccount): Promise<Transporter> {
    // Resolve on each attempt: an account ID or non-secret revision cannot
    // prove a same-target secret or OAuth token is still current.
    // See ImapService.connect: name the missing variable instead of letting the
    // provider reject a blank credential with a generic auth error.
    if (!account.auth) assertCredentialsResolved(account, 'smtp');

    const smtpConfig = account.smtp || this.getDefaultSmtpConfig(account);
    const { secure, requireTLS } = this.resolveTlsMode(smtpConfig.port, smtpConfig.secure);
    const proxy = resolveMailProxy(process.env, smtpConfig.host, account.auth?.provider);

    const transporterOptions = {
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure,
      requireTLS,
      auth: buildSmtpAuth(await this.authResolver.resolve(account, 'smtp')),
      tls: smtpConfig.tls,
      ...(proxy ? { proxy } : {}),
    };

    const transporter = nodemailer.createTransport(transporterOptions);
    
    // Verify connection
    try { await transporter.verify(); }
    catch (error) { transporter.close(); throw error; }
    const active = this.transporters.get(account.id) ?? new Set<Transporter>();
    active.add(transporter);
    this.transporters.set(account.id, active);
    return transporter;
  }

  // Port 465 is implicit TLS (SMTPS); 587/25 are submission ports that upgrade via STARTTLS.
  // A stored `secure: true` on port 587 is almost always a UI mistake — normalize it.
  private resolveTlsMode(port: number, secure: boolean): { secure: boolean; requireTLS: boolean } {
    if (port === 465) return { secure: true, requireTLS: false };
    if (port === 587 || port === 25) return { secure: false, requireTLS: true };
    return { secure, requireTLS: !secure };
  }

  private getDefaultSmtpConfig(account: ImapAccount): SmtpConfig {
    // Common SMTP configurations based on IMAP settings
    const commonProviders: { [key: string]: SmtpConfig } = {
      'imap.gmail.com': {
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
      },
      'outlook.office365.com': {
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
      },
      'imap-mail.outlook.com': {
        host: 'smtp-mail.outlook.com',
        port: 587,
        secure: false,
      },
      'imap.mail.yahoo.com': {
        host: 'smtp.mail.yahoo.com',
        port: 587,
        secure: false,
      },
      'imap.aol.com': {
        host: 'smtp.aol.com',
        port: 587,
        secure: false,
      },
      'imap.fastmail.com': {
        host: 'smtp.fastmail.com',
        port: 587,
        secure: false,
      },
      'imap.zoho.com': {
        host: 'smtp.zoho.com',
        port: 465,
        secure: true,
      },
      'imappro.zoho.com': {
        host: 'smtppro.zoho.com',
        port: 465,
        secure: true,
      },
    };

    const providerConfig = commonProviders[account.host];
    if (providerConfig) {
      return providerConfig;
    }

    // Default: submission port 587 with STARTTLS (RFC 8314 recommended).
    // Guess SMTP host: rewrite imap.* to smtp.* if present, otherwise reuse the IMAP host.
    const smtpHost = account.host.startsWith('imap.') || account.host.startsWith('imap-')
      ? account.host.replace(/^imap[.-]/, (m) => m === 'imap.' ? 'smtp.' : 'smtp-')
      : account.host;
    return {
      host: smtpHost,
      port: 587,
      secure: false,
    };
  }

  // Last line of defense against an address list that was serialized into a
  // string somewhere between the caller and here (see utils/array-input.ts).
  // nodemailer would otherwise fold the literal brackets into the first and
  // last address and every recipient bounces, so recover the array instead.
  private static addresses(
    value: string | string[] | undefined,
    field: string
  ): string | string[] | undefined {
    return normalizeAddressList(value, field);
  }

  private toMailOptions(account: ImapAccount, email: EmailComposer): SendMailOptions {
    const references = SmtpService.addresses(email.references, 'references');
    return {
      from: email.from || account.email || account.user,
      to: SmtpService.addresses(email.to, 'to'),
      cc: SmtpService.addresses(email.cc, 'cc'),
      bcc: SmtpService.addresses(email.bcc, 'bcc'),
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: email.attachments?.map(att => ({
        filename: att.filename,
        content: att.content,
        path: att.path,
        contentType: att.contentType,
        contentDisposition: att.contentDisposition,
        cid: att.cid,
      })),
      replyTo: email.replyTo,
      inReplyTo: email.inReplyTo,
      references: Array.isArray(references) ? references.join(' ') : references,
    };
  }

  // Build the raw RFC 822 message without sending. Used for drafts and Sent-folder copies.
  async composeRaw(account: ImapAccount, email: EmailComposer): Promise<Buffer> {
    if((email.text?.length??0)>MAX_BODY_CHARS||(email.html?.length??0)>MAX_BODY_CHARS)throw new Error('Message body exceeds the processing limit');
    const attachments=email.attachments?await materializeBoundedAttachments(email.attachments):undefined;
    const compiled = new MailComposer(this.toMailOptions(account, {...email,attachments}));
    return compiled.compile().build();
  }

  async sendEmail(accountId: string, account: ImapAccount, email: EmailComposer, beforeSubmit?: () => Promise<void> | void): Promise<SmtpSendResult> {
    let transporter: Transporter | undefined;
    let submitted = false;
    let rawMessage: Buffer | undefined;
    let messageId = '';
    const expected = composerRecipients({ to: SmtpService.addresses(email.to, 'to')!, cc: SmtpService.addresses(email.cc, 'cc'), bcc: SmtpService.addresses(email.bcc, 'bcc') });
    const result = (receipt: EmailDeliveryReceipt): SmtpSendResult => ({
      messageId, rawMessage, receipt,
      accepted: receipt.accepted, rejected: receipt.rejected,
      sent: receipt.unknown.length ? undefined : receipt.accepted.length === expected.length && expected.length > 0,
      ...(receipt.unknown.length ? { unknownRecipients: 'SMTP acceptance is unknown for some recipients' } : {}),
      ...(receipt.rejected.length ? { message: `${receipt.accepted.length} recipients accepted; ${receipt.rejected.length} rejected by SMTP` } : {}),
    });
    try {
      transporter = await this.createTransporter(account);
      const mailOptions = this.toMailOptions(account, email);

      // T22 / MAIL-03: ONE frozen MIME. The exact bytes composeRaw builds are
      // both what SMTP submits and what the Sent copy appends, so Message-ID
      // and Date cannot drift between the delivered message and its copy.
      // A compose failure fails the whole send — nothing goes out that the
      // Sent folder could not mirror. BCC stays envelope-only: the compiled
      // raw never carries a Bcc header, and the envelope covers to+cc+bcc.
      rawMessage = await this.composeRaw(account, email);
      messageId = rawMessage.toString('utf8').match(/^Message-ID:\s*(.+?)\r?$/im)?.[1] ?? '';
      const envelope = {
        from: mailboxAddresses(typeof mailOptions.from === 'string' ? mailOptions.from : account.email || account.user)[0],
        to: expected,
      };
      await beforeSubmit?.();
      submitted = true;
      const info = await transporter.sendMail({ messageId, envelope, raw: rawMessage });

      // T21 / MAIL-10: surface per-recipient acceptance. SMTP transports
      // report accepted/rejected arrays; transports without recipient data
      // (stream/buffer transports) leave the outcome unknown. Partial or
      // full rejection never claims sent:true, and nothing here claims final
      // delivery — only what the SMTP server accepted this attempt.
      const accepted = Array.isArray((info as any).accepted)
        ? (info as any).accepted.map((v: unknown) => typeof v === 'string' ? v : String((v as { address: string }).address))
        : undefined;
      const rejected = Array.isArray((info as any).rejected)
        ? (info as any).rejected.map((v: unknown) => typeof v === 'string' ? v : String((v as { address: string }).address))
        : undefined;

      return result(deliveryReceipt(expected, accepted, rejected));
    } catch (error) {
      if (!submitted) throw new SafeSendPreflightError('SMTP preparation failed; create a new preview before sending');
      const failure = error as { code?: string; command?: string; rejected?: string[] };
      // Nodemailer explicitly reports all-RCPT rejection with EENVELOPE.
      // All other failures after sendMail may have occurred after acceptance.
      if (failure?.code === 'EENVELOPE' && failure.command === 'RCPT TO' && Array.isArray(failure.rejected)) {
        const receipt = deliveryReceipt(expected, [], failure.rejected);
        if (receipt.rejected.length === expected.length && !receipt.unknown.length) return result(receipt);
      }
      return result(deliveryReceipt(expected));
    } finally {
      if (transporter) this.releaseTransporter(accountId, transporter);
    }
  }

  private releaseTransporter(accountId: string, transporter: Transporter): void {
    try { transporter.close?.(); }
    finally {
      const active = this.transporters.get(accountId);
      active?.delete(transporter);
      if (!active?.size) this.transporters.delete(accountId);
    }
  }

  async verifySmtpConnection(account: ImapAccount): Promise<boolean> {
    let transporter: Transporter | undefined;
    try {
      // createTransporter already verifies the newly resolved credentials.
      transporter = await this.createTransporter(account);
      return true;
    } catch (error) {
      return false;
    } finally {
      if (transporter) this.releaseTransporter(account.id, transporter);
    }
  }

  disconnect(accountId: string): void {
    const transporters = this.transporters.get(accountId);
    if (transporters) {
      for (const transporter of transporters) transporter.close();
      this.transporters.delete(accountId);
    }
  }

  disconnectAll(): void {
    for (const transporters of this.transporters.values()) {
      for (const transporter of transporters) transporter.close();
    }
    this.transporters.clear();
  }
}
