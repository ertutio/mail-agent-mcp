const fs = require('fs');
const LF = '\n';
let d = fs.readFileSync('src/services/smtp-service.ts', 'binary');

// The mojibake em-dash in the old comment (double-encoded UTF-8) is matched
// by its hex bytes, not by a literal.
const mojibake = Buffer.from('c3a2c280c294', 'hex').toString('binary');
const oldLines = [
  "    // T20: close stale transporters when the account identity changed " + mojibake,
  "    // they hold old auth and connections that no longer match the record.",
  "    const storedRev = this.transporterRevisions.get(account.id);",
  "    const currentRev = accountRevision(account);",
  "    if (storedRev !== undefined && storedRev !== currentRev) {",
  "      const stale = this.transporters.get(account.id);",
  "      if (stale) {",
  "        for (const t of stale) { try { t.close(); } catch { /* already gone */ } }",
  "        this.transporters.delete(account.id);",
  "      }",
  "    }",
  "    this.transporterRevisions.set(account.id, currentRev);",
  "",
];
const old = oldLines.join(LF);
if (!d.includes(old)) throw new Error('T20 stale-close anchor missing');

const replacement = [
  "    // T20: every send owns and releases its own transporter. A revision",
  "    // change never closes another in-flight attempt's transport - the",
  "    // attempt's post-verify re-check below is what stops stale auth.",
  "    const startRev = accountRevision(account);",
  "    this.transporterRevisions.set(account.id, startRev);",
  "",
].join(LF);
d = d.replace(old, replacement);

// Post-verify identity re-check before registration.
const regAnchor = [
  "    // Verify connection",
  "    try { await transporter.verify(); }",
  "    catch (error) { transporter.close(); throw error; }",
  "    const active = this.transporters.get(account.id) ?? new Set<Transporter>();",
].join(LF);
if (!d.includes(regAnchor)) throw new Error('verify anchor missing');
const regReplacement = [
  "    // Verify connection",
  "    try { await transporter.verify(); }",
  "    catch (error) { transporter.close(); throw error; }",
  "",
  "    // T20: the auth resolution and verify awaited above - re-verify the",
  "    // identity before registering. A newer attempt recorded a different",
  "    // revision in the meantime, so this attempt is stale: it must not join",
  "    // the newer attempt's set or proceed to submit with old auth.",
  "    if (this.transporterRevisions.get(account.id) !== startRev) {",
  "      transporter.close();",
  "      throw new SafeSendPreflightError('SMTP account changed while preparing the send; create a new preview before sending');",
  "    }",
  "    const active = this.transporters.get(account.id) ?? new Set<Transporter>();",
].join(LF);
d = d.replace(regAnchor, regReplacement);

fs.writeFileSync('src/services/smtp-service.ts', d, 'binary');
console.log('smtp-service patched');
