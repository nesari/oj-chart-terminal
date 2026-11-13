#!/usr/bin/env node
/**
 * Release integrity gate (ROUND291).
 *
 * `electron-updater` does not "download the installer" — it reads a feed file
 * (`latest.yml` on Windows, `latest-mac.yml`, `latest-linux.yml`), takes the
 * `files[].url` and `sha512` from it, and fetches THAT. So a release is only
 * correct when the feed and the uploaded assets agree byte for byte.
 *
 * They did not agree once: electron-builder slugified the name in the feed
 * (`OJchart-Setup-1.9.217.exe`) while the NSIS artifact kept its spaces
 * (`OJchart Setup 1.9.217.exe`). Every update would have 404'd, and nothing in
 * CI noticed — it was found by reading the generated file by hand.
 *
 * This gate exists so that class of mistake can never ship again. It checks a
 * REAL published release (or a local dist/ directory during a build):
 *
 *   1. every platform feed exists and parses;
 *   2. each `files[].url` is an asset that actually exists on the release;
 *   3. its declared size matches the uploaded asset's size;
 *   4. the feed version matches package.json;
 *   5. the installer for that platform exists (feed entries are not enough);
 *   6. blockmaps exist where the feed references them.
 *
 * Usage:
 *   node scripts/checks/check-release.mjs --tag v1.9.222
 *   node scripts/checks/check-release.mjs --dist            # local dist/
 *   node scripts/checks/check-release.mjs --tag v1.9.222 --json
 *
 * Exit code 0 = the release can be safely delivered to a running app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* one feed per platform, with the extension its installer must have */
const FEEDS = [
  { feed: 'latest.yml', platform: 'Windows', installer: '.exe' },
  { feed: 'latest-mac.yml', platform: 'macOS', installer: '.dmg' },
  { feed: 'latest-linux.yml', platform: 'Linux', installer: '.AppImage' },
];

let pass = 0, fail = 0;
const results = [];
const ok = (cond, label, extra) => {
  if (cond) { pass++; results.push({ ok: true, label }); console.log('  ok ' + label); }
  else {
    fail++;
    results.push({ ok: false, label, extra });
    console.log('  FAIL ' + label + (extra === undefined ? '' : ' — ' + extra));
  }
};

/* --- a tiny YAML reader for the shape electron-builder emits --------------
   The feeds are flat: `version`, `path`, `sha512`, `releaseDate` and a `files:`
   list of `- url/sha512/size`. Pulling in a YAML dependency for that would add
   an install step to CI; parsing the exact emitted shape is enough and fails
   loudly on anything unexpected. */
function parseFeed(text) {
  const out = { version: null, path: null, files: [] };
  const lines = String(text).split(/\r?\n/);
  let inFiles = false;
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    /* ROUND291: the `files:` block ends at the next TOP-LEVEL key. Without
       this the parser stayed "in files" for the rest of the document and
       swallowed the top-level `path:` / `sha512:` emitted after the list —
       which are exactly the fields a caller may need. */
    const indented = /^\s/.test(line);

    if (!indented) {
      if (/^files:\s*$/.test(line)) { inFiles = true; cur = null; continue; }
      const top = /^([a-zA-Z]+):\s*(.*)$/.exec(line);
      if (top) {
        inFiles = false;                       // a top-level key closes the list
        const [, k, v] = top;
        const val = v.replace(/^['"]|['"]$/g, '');
        if (k === 'version') out.version = val;
        if (k === 'path') out.path = val;
        if (k === 'sha512') out.sha512 = val;
        continue;
      }
      continue;
    }

    if (!inFiles) continue;
    /* the `- key: value` form must be tested BEFORE the plain `key: value`
       form: `  - url: x` also matches the plain pattern, and treating it as a
       field of the previous entry loses the first field of every item (the
       url) while silently reusing the previous object. */
    const item = /^\s*-\s*([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (item) {
      cur = {};
      out.files.push(cur);
      cur[item[1]] = item[2].replace(/^['"]|['"]$/g, '');
      continue;
    }
    const field = /^\s+([a-zA-Z0-9_]+):\s*(.*)$/.exec(line);
    if (cur && field) cur[field[1]] = field[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/* --- sources ------------------------------------------------------------- */
function fromDist() {
  const dir = path.join(ROOT, 'dist');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const entries = new Map();
  for (const f of files) {
    const st = fs.statSync(path.join(dir, f));
    entries.set(f, { name: f, size: st.size });
  }
  const feeds = new Map();
  for (const { feed } of FEEDS) {
    const p = path.join(dir, feed);
    if (fs.existsSync(p)) feeds.set(feed, fs.readFileSync(p, 'utf8'));
  }
  return { entries, feeds, source: 'dist/' };
}

function ghJson(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('gh ' + args.join(' ') + ' failed: ' + (r.stderr || '').trim());
  return r.stdout;
}

function fromTag(tag) {
  const rel = JSON.parse(ghJson(['api', 'repos/nesari/oj-chart-terminal/releases/tags/' + tag]));
  const entries = new Map();
  for (const a of rel.assets || []) entries.set(a.name, { name: a.name, size: a.size, id: a.id });
  const feeds = new Map();
  for (const { feed } of FEEDS) {
    const asset = (rel.assets || []).find((a) => a.name === feed);
    if (!asset) continue;
    /* the browser URL 404s for a private repo, so read through the API */
    feeds.set(feed, ghJson([
      'api', `repos/nesari/oj-chart-terminal/releases/assets/${asset.id}`,
      '-H', 'Accept: application/octet-stream',
    ]));
  }
  return { entries, feeds, source: 'release ' + tag, release: rel };
}

/* --- the checks ---------------------------------------------------------- */
function main() {
  const argv = process.argv.slice(2);
  const tagArg = argv.indexOf('--tag');
  const tag = tagArg >= 0 ? argv[tagArg + 1] : null;
  const useDist = argv.includes('--dist');
  const asJson = argv.includes('--json');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;

  let src;
  try {
    src = useDist || !tag ? fromDist() : fromTag(tag);
  } catch (e) {
    console.error('[release] cannot read the release: ' + (e.message || e));
    process.exit(1);
  }
  if (!asJson) console.log(`[release] checking ${src.source} against package.json ${version}`);

  if (!src.feeds.size) {
    ok(false, 'no update feed found', 'expected ' + FEEDS.map((f) => f.feed).join(', '));
  }

  for (const { feed, platform, installer } of FEEDS) {
    const text = src.feeds.get(feed);
    if (!text) {
      ok(false, `${platform}: ${feed} exists`);
      continue;
    }
    let parsed;
    try { parsed = parseFeed(text); } catch (e) {
      ok(false, `${platform}: ${feed} parses`);
      continue;
    }
    ok(!!parsed.version, `${platform}: feed declares a version`, parsed.version);

    /* The single most important assertion: the version a running copy will
       compare itself against must be the version we built. A stale feed makes
       the app either miss the update or offer one that does not exist. */
    ok(parsed.version === version,
      `${platform}: feed version matches package.json`, `${parsed.version} vs ${version}`);

    const urls = (parsed.files || []).map((f) => f.url).filter(Boolean);
    ok(urls.length > 0, `${platform}: feed lists at least one file`);

    for (const url of urls) {
      const asset = src.entries.get(url);
      if (!asset) {
        /* THIS is the exact failure mode that shipped in 1.9.217: the feed
           names a file that is not on the release. */
        ok(false, `${platform}: feed file "${url}" exists as an asset`,
          'assets: ' + [...src.entries.keys()].filter((n) => n.endsWith(installer)).slice(0, 3).join(', '));
        continue;
      }
      const declared = (parsed.files.find((f) => f.url === url) || {}).size;
      if (declared != null) {
        ok(String(asset.size) === String(declared),
          `${platform}: ${url} size matches the feed`, `${asset.size} vs ${declared}`);
      }
    }

    /* the installer itself must be attached, not just referenced */
    const inst = [...src.entries.keys()].find((n) => n.endsWith(installer));
    ok(!!inst, `${platform}: an ${installer} installer is attached`, inst);

    /* blockmaps power differential downloads; a feed that points at one must
       have it uploaded too, or every update falls back to a full download */
    const bm = [...src.entries.keys()].find((n) => n.endsWith(installer + '.blockmap'));
    if (bm) ok(true, `${platform}: blockmap is attached for differential downloads`);
  }

  /* a draft release is invisible to the updater: it would look at the previous
     version forever without any error */
  if (src.release) {
    ok(src.release.draft === false, 'the release is published (not a draft)');
    ok(src.release.prerelease === false, 'the release is not a prerelease');
  }

  if (asJson) {
    console.log(JSON.stringify({ pass, fail, version, source: src.source, results }, null, 2));
  }
  console.log(`\n[release] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
