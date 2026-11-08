/**
 * Shared attachment part identity for original-email materialization (B1).
 *
 * The forward chain locates each original attachment by a key of
 * `contentId ?? filename`. ImapService.getAttachmentContent matches candidate
 * parts with the same filename-OR-CID rule, and the caller counts the
 * occurrence position of each entry under that identical rule, so the k-th
 * entry for a key fetches the k-th match — including same-name pairs where
 * one part carries a Content-ID, or a filename equal to another part's CID.
 */
export function normalizeAttachmentKey(value: string): string {
  return value.replace(/^<|>$/g, '');
}

export function attachmentMatchesKey(
  attachment: { filename?: string; contentId?: string },
  key: string,
): boolean {
  return (attachment.filename || 'unknown') === key
    || normalizeAttachmentKey(attachment.contentId ?? '') === normalizeAttachmentKey(key);
}
