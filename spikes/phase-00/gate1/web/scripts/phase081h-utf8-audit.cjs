const { readdirSync, readFileSync, writeFileSync, statSync } = require('node:fs');
const { join, extname, resolve } = require('node:path');
const { TextDecoder } = require('node:util');

const root = process.env.NOTEOS_PHASE081H_AUDIT_ROOT ?? resolve(__dirname, '../../../../../artifacts/review/noteOS-Phase08.1-H-Host-Isolation-review');
const output = process.env.NOTEOS_PHASE081H_AUDIT_OUTPUT ?? join(root, 'evidence/utf8-audit.json');
const binary = new Set(['.png', '.tar', '.zip', '.pdf', '.jpg', '.jpeg']);
const patterns = [
  ['private-key PEM header', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['Tailscale auth key', /tskey-[A-Za-z0-9_-]{20,}/g],
  ['synthetic/session token value', /(?:__Secure-noteos_sync|noteos_sync_local)=([A-Za-z0-9_-]{43})/g],
];
const decoder = new TextDecoder('utf-8', { fatal: true });
const checked = [], failures = [], matches = [];
function visit(folder) {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name), info = statSync(path);
    if (info.isDirectory()) { visit(path); continue; }
    if (binary.has(extname(path).toLowerCase())) continue;
    try {
      const text = decoder.decode(readFileSync(path)); checked.push(path.slice(root.length + 1));
      for (const [label, pattern] of patterns) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) matches.push({ file: path.slice(root.length + 1), pattern: label, valueRedacted: true });
      }
    } catch { failures.push(path.slice(root.length + 1)); }
  }
}
visit(root);
const report = { status: failures.length === 0 && matches.length === 0 ? 'PASS' : 'FAIL', textFilesStrictUtf8: checked.length, utf8Failures: failures, credentialMatches: matches, patterns: patterns.map(([label]) => label), binaryFilesSkipped: [...binary] };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(`${report.status}: ${checked.length} text files strict UTF-8; ${failures.length} decoding failures; ${matches.length} credential-pattern matches.\n`);
if (report.status !== 'PASS') process.exitCode = 1;
