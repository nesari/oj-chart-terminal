#!/usr/bin/env node
/**
 * Is the update channel reachable? (ROUND292)
 *
 * The app's auto-update reads a GitHub release feed (`latest.yml`). That feed
 * is served by GitHub's release CDN — which answers 404 to an ANONYMOUS client
 * when the repository is private. `electron-updater` has no credentials, so a
 * shipped build can only self-update once the feed is publicly readable.
 *
 * Today the repository is private and will be made public later. Rather than
 * leave that as a note in a document, this gate answers the question directly:
 * "if a user ran the shipped app right now, would the update channel work?"
 *
 * It checks, against the network, with NO token:
 *   1. the repository API is anonymously visible (the privacy switch);
 *   2. the latest release's feed is anonymously readable and parses;
 *   3. the asset the feed points at is anonymously reachable.
 *
 * Exit 0 = auto-update will work for a shipped build right now.
 * Exit 1 = it will not (prints exactly which of the three is blocking).
 *
 * Usage:
 *   node scripts/checks/check-channel.mjs                 # latest release
 *   node scripts/checks/check-channel.mjs --tag v1.9.222
 *   node scripts/checks/check-channel.mjs --json
 */
import https from 'node:https';

const OWNER = 'nesari';
const REPO = 'oj-chart-terminal';

function get(url, redirects = 0) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'ojchart-channel-probe', Accept: '*/*' },
      timeout: 20000,
    }, (r) => {
      /* follow a redirect: release downloads go through a CDN hop */
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 5) {
        r.resume();
        resolve(get(new URL(r.headers.location, url).href, redirects + 1));
        return;
      }
      let body = '';
      r.on('data', (d) => { body += d; });
      r.on('end', () => resolve({ status: r.statusCode, body }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

const argv = process.argv.slice(2);
const tagArg = argv.indexOf('--tag');
const explicitTag = tagArg >= 0 ? argv[tagArg + 1] : null;
const asJson = argv.includes('--json');

const report = { repo: `${OWNER}/${REPO}`, checks: [], ok: false, tag: null };
const add = (ok, name, detail) => {
  report.checks.push({ ok, name, detail });
  if (!asJson) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

/* 1. is the repository itself anonymously visible? */
const repoRes = await get(`https://api.github.com/repos/${OWNER}/${REPO}`);
const repoVisible = repoRes.status === 200;
add(repoVisible, 'the repository is publicly readable',
  repoVisible ? 'anonymous API call succeeded' : `HTTP ${repoRes.status || 'no response'} (private repo?)`);

/* 2. find the release to inspect */
let tag = explicitTag;
if (!tag) {
  const latest = await get(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`);
  if (latest.status === 200) {
    try { tag = JSON.parse(latest.body).tag_name; } catch (e) { tag = null; }
  }
  if (tag) add(true, 'the latest release is anonymously resolvable', tag);
  else add(false, 'the latest release is anonymously resolvable',
    `HTTP ${latest.status || 'no response'}`);
}
report.tag = tag || explicitTag;

/* 3. the feed + the asset it names, both anonymously */
if (report.tag) {
  const feedUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${report.tag}/latest.yml`;
  const feed = await get(feedUrl);
  const feedOk = feed.status === 200 && /^version:/m.test(feed.body);
  add(feedOk, 'the update feed is anonymously readable',
    feedOk ? `${feed.body.split(/\r?\n/).find((l) => l.startsWith('version:'))}` : `HTTP ${feed.status || 'no response'}`);

  if (feedOk) {
    const url = (/url:\s*(\S+)/.exec(feed.body) || [])[1];
    if (url) {
      const assetUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${report.tag}/${url}`;
      const head = await get(assetUrl);
      add(head.status === 200, 'the installer named by the feed is anonymously downloadable',
        head.status === 200 ? url : `HTTP ${head.status || 'no response'} for ${url}`);
    }
  }
}

report.ok = report.checks.every((c) => c.ok);
if (asJson) {
  /* machine-readable mode: the JSON must be the ONLY thing on stdout, so a
     caller can parse it directly. The human lines above are suppressed in
     that mode. */
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

if (report.ok) {
  console.log('\n[channel] auto-update WILL work for a shipped build right now.');
  process.exit(0);
}
console.log('\n[channel] auto-update will NOT work yet. Blocking:');
for (const c of report.checks.filter((x) => !x.ok)) console.log('  - ' + c.name + ' (' + c.detail + ')');
console.log('\nThe app is not broken: it shows "update channel unavailable" and offers the');
console.log('release page. Everything starts working the moment the feed is public.');
process.exit(1);
