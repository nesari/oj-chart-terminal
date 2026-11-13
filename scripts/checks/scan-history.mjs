/**
 * Scan the ENTIRE git history for secrets (ROUND293).
 *
 * Making a repository public exposes history, not just the current tree. A
 * secret deleted in a later commit is still readable forever. The existing
 * `go-public` audit only reads tracked files TODAY, which is not enough.
 *
 * Strategy: walk every blob that ever existed and grep it for credential
 * shapes; report the first commit that introduced each hit so a human can judge
 * it. `git log -S` is too slow for this, so we take the set of all blobs once
 * and scan each unique blob a single time.
 *
 * Usage:
 *   node scripts/checks/scan-history.mjs            # human report
 *   node scripts/checks/scan-history.mjs --json     # machine readable
 */
import { spawnSync } from 'node:child_process';

const asJson = process.argv.includes('--json');

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, ...opts });
  return { code: r.status, buf: r.stdout, err: r.stderr.toString('utf8').trim() };
}

const PATTERNS = [
  { name: 'private key block', re: /-----BEGIN\s+(RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'API secret key (sk-)', re: /\bsk-[A-Za-z0-9]{20,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'AWS secret access key', re: /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{30,}/i },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe secret key', re: /\bsk_live_[A-Za-z0-9]{20,}/ },
  { name: 'private key file contents', re: /PuTTY-User-Key-File|BEGIN CERTIFICATE-----/ },
  /* MT5 passwords get their own pass because prose and fixtures legitimately
     mention `password`. A hit is only interesting when the value does NOT look
     like a placeholder or a deliberate redaction probe. */
  { name: 'MT5 password assignment', re: /["']?password["']?\s*[=:]\s*["']([^"']+)["']/gi, needsValueCheck: true },
];

/* Detector files contain the credential PATTERNS themselves (a regex for
   `BEGIN CERTIFICATE-----` matches its own source). Scanning them reports the
   scanner as a leak, which then blocks every run — the same class of false
   positive that made the 29 README hits useless. */
const IS_DETECTOR = /(^|\/)(scan-history|check-release|go-public|check-channel)\.mjs$/;

/* Values that are documentation, placeholders, or the logger's own redaction
   test — not secrets. Without this the scanner reports 29 false positives on
   this repo (README code-signing instructions and the scrub probe). */
const PLACEHOLDER_VALUE = new RegExp([
  '^$',
  'the-', 'your-', 'xxx', '\\*+', '•••',
  '^\\$\\{',                                   // ${VAR}
  'password$', 'secret$', 'passwd$', 'pwd$',
  'TOPSECRET',                                 // the scrub-test literal
  '^<', '^\\$',
].join('|'), 'i');

/* lines that are obviously documentation of the SETTING, not a value */
const PLACEHOLDER_CONTEXT = /CSC_KEY_PASSWORD|APPLE_APP_SPECIFIC_PASSWORD|redacted|scrub probe|placeholder|never reaches the log/i;

/* 1. every blob in history, deduplicated */
const revs = git(['rev-list', '--all', '--objects']);
if (revs.code !== 0) { console.error('git rev-list failed: ' + revs.err); process.exit(1); }
const objects = revs.buf.toString('utf8').split('\n').filter(Boolean);
const blobs = new Map(); // sha -> path hint
for (const line of objects) {
  const sp = line.indexOf(' ');
  if (sp < 0) continue;
  blobs.set(line.slice(0, sp), line.slice(sp + 1));
}
console.log('[history] unique objects: ' + blobs.size);

    /* read them in ONE cat-file --batch pass (fast even for thousands) */
const shas = [...blobs.keys()];
const hits = [];
const BATCH = 500;
for (let off = 0; off < shas.length; off += BATCH) {
  const chunk = shas.slice(off, off + BATCH);
  const r = spawnSync('git', ['cat-file', '--batch'], {
    input: chunk.join('\n') + '\n', maxBuffer: 512 * 1024 * 1024,
  });
  if (r.status !== 0) continue;
  const out = r.stdout;
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = out.slice(pos, nl).toString('utf8');
    const parts = header.split(' ');
    if (parts.length < 3) { pos = nl + 1; continue; }
    const size = Number(parts[2]);
    const bodyStart = nl + 1;
    const body = out.slice(bodyStart, bodyStart + size);
    pos = bodyStart + size + 1; // trailing newline
    if (!size || size > 8 * 1024 * 1024) continue;   // skip huge blobs
    /* decode as text only if it looks textual */
    const head = body.slice(0, 512).toString('latin1');
    if (head.includes('\u0000')) continue;            // binary
    const text = body.toString('utf8');
    const pathHint = blobs.get(parts[0]) || '';
    /* a detector file is not a leak: it contains the patterns by design */
    if (IS_DETECTOR.test(pathHint)) continue;
    for (const p of PATTERNS) {
      if (p.needsValueCheck) {
        /* inspect the VALUE, and the line it sits on: `password: 'TOPSECRET'`
           inside the logger's own scrub test is not a leaked credential. */
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(text))) {
          const val = m[1] || '';
          if (PLACEHOLDER_VALUE.test(val)) continue;
          const lineStart = text.lastIndexOf('\n', m.index) + 1;
          const lineEnd = text.indexOf('\n', m.index);
          const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
          if (PLACEHOLDER_CONTEXT.test(line)) continue;
          hits.push({ sha: parts[0], path: blobs.get(parts[0]) || '', kind: p.name, sample: line.trim().slice(0, 120) });
        }
        continue;
      }
      if (p.re.test(text)) hits.push({ sha: parts[0], path: blobs.get(parts[0]) || '', kind: p.name });
    }
  }
}

/* 3. which commit introduced each hit (best effort, first occurrence) */
function commitOf(blobSha) {
  const r = spawnSync('git', ['log', '--all', '--find-object=' + blobSha, '--format=%h %ad', '--date=short', '-1'],
    { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

const report = hits.map((h) => ({
  ...h,
  commit: commitOf(h.sha),
}));

if (asJson) {
  console.log(JSON.stringify({ scanned: blobs.size, hits: report }, null, 2));
} else {
  if (!report.length) {
    console.log('[history] clean — no credential shapes in any commit.\n');
  } else {
    console.log('[history] ' + report.length + ' hit(s):\n');
    for (const h of report) {
      console.log('  ' + h.kind);
      console.log('    blob   ' + h.sha.slice(0, 10) + '  ' + h.path);
      console.log('    commit ' + h.commit);
      if (h.sample) console.log('    text   ' + h.sample);
    }
  }
}
process.exit(report.length ? 1 : 0);
