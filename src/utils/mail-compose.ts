import addressparser from 'nodemailer/lib/addressparser/index.js';
import type { EmailContent, EmailDeliveryReceipt, ImapAccount } from '../types/index.js';
import { htmlToMarkdown } from '../services/html-to-markdown.js';
import { parseSerializedArray } from './array-input.js';

/** Recover supported serialized lists before a draft's recipient fields freeze. */
export function normalizeAddressList(value: string | readonly string[] | undefined, field: string): string[] | undefined {
  const recovered = parseSerializedArray(value, field);
  if (recovered === undefined) return undefined;
  const values = Array.isArray(recovered) ? recovered : [recovered];
  if (!values.every((item): item is string => typeof item === 'string')) {
    throw new Error(`${field} must contain only address strings`);
  }
  return [...values];
}

/** Parse complete address lists, including quoted commas and address groups. */
export function mailboxAddresses(value: string | readonly string[] | undefined): string[] {
  const values = value === undefined ? [] : typeof value === 'string' ? [value] : value;
  return values.flatMap(item => addressparser(item, { flatten: true })
    .map(address => address.address?.trim())
    .filter((address): address is string => !!address));
}

export function composerRecipients(composer: { to: string | string[]; cc?: string | string[]; bcc?: string | string[] }): string[] {
  return uniqueSmtpAddresses([...[composer.to].flat(), ...[composer.cc ?? []].flat(), ...[composer.bcc ?? []].flat()]);
}

/** SMTP localparts may be case-sensitive; only the domain is case-insensitive. */
function smtpAddressKey(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? address : address.slice(0, at + 1) + address.slice(at + 1).toLowerCase();
}

function uniqueSmtpAddresses(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return mailboxAddresses(values).filter(address => {
    const key = smtpAddressKey(address);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Missing or contradictory reports remain unknown; only expected recipients count. */
export function deliveryReceipt(expected: readonly string[], accepted?: readonly string[], rejected?: readonly string[], unknown?: readonly string[]): EmailDeliveryReceipt {
  const yes = new Set(mailboxAddresses(accepted).map(smtpAddressKey));
  const no = new Set(mailboxAddresses(rejected).map(smtpAddressKey));
  const uncertain = new Set(mailboxAddresses(unknown).map(smtpAddressKey));
  const receipt: EmailDeliveryReceipt = { accepted: [], rejected: [], unknown: [] };
  for (const address of uniqueSmtpAddresses(expected)) {
    const key = smtpAddressKey(address);
    if (yes.has(key) && !no.has(key) && !uncertain.has(key)) receipt.accepted.push(address);
    else if (no.has(key) && !yes.has(key) && !uncertain.has(key)) receipt.rejected.push(address);
    else receipt.unknown.push(address);
  }
  return receipt;
}

export function replyRecipients(original: EmailContent, account: ImapAccount, replyAll: boolean): string[] {
  const groups = replyRecipientGroups(original, account, replyAll);
  return [...groups.to, ...groups.cc];
}

export function replyRecipientGroups(original: EmailContent, account: ImapAccount, replyAll: boolean): { to: string[]; cc: string[] } {
  const header = original.headers?.['reply-to'];
  const headerReplyTo = typeof header === 'string' ? [header] : Array.isArray(header) ? header : [];
  const primary = original.replyTo?.length ? original.replyTo : headerReplyTo.length ? headerReplyTo : original.fromAddresses?.length ? original.fromAddresses : [original.from];
  const seen = new Set(replyAll ? mailboxAddresses([account.email || account.user, account.user]).map(smtpAddressKey) : []);
  const take = (values: string[]) => mailboxAddresses(values).filter(address => {
    const key = smtpAddressKey(address);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { to: take(replyAll ? [...primary, ...original.to] : primary), cc: replyAll ? take(original.cc ?? []) : [] };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function forwardBodies(original: EmailContent, note: string): { text: string; html?: string } {
  const header = `\n\n---------- Forwarded message ----------\nFrom: ${original.from}\nDate: ${original.date.toLocaleString()}\nSubject: ${original.subject}\nTo: ${original.to.join(', ')}\n\n`;
  const text = original.textContent || htmlToMarkdown(original.htmlContent);
  const preamble = note + header;
  return {
    text: preamble + text,
    html: original.htmlContent ? `<div style="white-space:pre-wrap">${escapeHtml(preamble)}</div>${original.htmlContent}` : undefined,
  };
}
