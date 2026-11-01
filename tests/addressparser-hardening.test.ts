import { describe, expect, it } from 'vitest';
import { mailboxAddresses } from '../src/utils/mail-compose.js';

// T33: the three nodemailer addressparser advisories fixed in 10.3.1
// (GHSA-8c8m-p3m8-cjg8 nested comment, GHSA-m943-m63m-w62w ';' in quoted
// string/comment ends an address group, GHSA-85x2-q946-cp5h '>' in a quoted
// local part ends an angle-addr). mailboxAddresses is the production entry
// over nodemailer's addressparser, so the fixed semantics are pinned through
// it: display text and comment fragments must never become recipients.
describe('T33: addressparser hardening (nodemailer 10.3.1)', () => {
  it('does not release nested-comment text as a recipient (GHSA-8c8m-p3m8-cjg8)', () => {
    const parsed = mailboxAddresses('a@synth.test, (outer (nested) tail text) b@synth.test');
    expect(parsed).toEqual(['a@synth.test', 'b@synth.test']);
  });

  it('does not end an address group at a semicolon inside a quoted string (GHSA-m943-m63m-w62w)', () => {
    // One recipient whose quoted local part keeps the ';' — never a split
    // into multiple recipients with display text becoming an address.
    const parsed = mailboxAddresses('"a;b"@synth.test');
    expect(parsed).toEqual(['"a;b"@synth.test']);
  });

  it('does not end an angle-addr at a ">" inside a quoted local part (GHSA-85x2-q946-cp5h)', () => {
    // One recipient whose quoted local part keeps the '>' — the angle-addr
    // must not end early and deliver to a domain the header does not name.
    const parsed = mailboxAddresses('"a>b"@synth.test');
    expect(parsed).toEqual(['"a>b"@synth.test']);
  });
});
