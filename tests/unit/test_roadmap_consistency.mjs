/**
 * test_roadmap_consistency.mjs — the roadmap may not lie.
 *
 * `docs/ROADMAP-PANELS.md` is the execution plan every new chat picks a phase
 * from, so a wrong number in it is not a typo, it is a wrong instruction: it
 * sends the next agent to "add the 8th right-panel tab" when there are 9, or to
 * "build the equity curve" when ROUND176 already did. This suite pins every
 * count the document states against the code that defines it.
 *
 * Rule that made this necessary (docs §1.1): the code is the reference, the
 * document follows. When code and document disagree, this suite fails and the
 * document is corrected in the same commit.
 *
 * What is pinned:
 *   A. right-panel tab count            (ROADMAP §2, P0-05)
 *   B. drawing tools + menu groups      (ROADMAP §2 row 2, P0-02)
 *   C. strategy-tester metric rows      (ROADMAP §2 row 9, P5)
 *   D. unit/MT5/E2E gate sizes          (ROADMAP §1.4 header)
 *   E. phase budget arithmetic          (ROADMAP §3 milestone totals)
 *   F. gate map — every phase suite is registered in the E2E gate
 *   G. port hygiene — new suites use the documented free ranges
 *   H. roadmap document hygiene (no P14 typo, links resolve, R304 cross-link)
 *
 * Run: node tests/unit/test_roadmap_consistency.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { readSource } from './source-utils.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = fs.readFileSync(path.join(ROOT, 'docs/ROADMAP-PANELS.md'), 'utf8');

/* Persian digits -> ASCII, so a count written in either script compares equal.
   The document is written in Persian and therefore uses ۰-۹; every regex below
   would silently match nothing without this. ٫ (Persian decimal) becomes '.'
   and ٬ (Persian thousands) disappears, so "۱٫۵ روز" parses as 1.5. */
const FA = '۰۱۲۳۴۵۶۷۸۹';
function normalize(s) {
  return String(s)
    .replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)))
    .replace(/٫/g, '.')
    .replace(/٬/g, '');
}
const ROADMAP = normalize(RAW);

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

function num(s) {
  return Number(normalize(s));
}

/* ---------- A. right-panel tabs ---------- */
{
  const html = readSource('src/renderer/index.html');
  const tabs = [...html.matchAll(/class="rt-btn"\s+data-tab="([^"]+)"/g)].map((m) => m[1]);
  ok(tabs.length === 9, 'the app has 9 right-panel tabs', `found ${tabs.length}: ${tabs.join(',')}`);

  /* every tab must have a panel module or an inline body — a tab that opens
     nothing is the "empty state" bug P0-05 exists to prevent */
  ok(new Set(tabs).size === tabs.length, 'no duplicate tab id');

  const m = /همهٔ \*{0,2}(\d+)\*{0,2} تب راست/.exec(ROADMAP);
  ok(!!m, 'the roadmap states a right-panel tab count');
  ok(m && num(m[1]) === tabs.length,
    'the roadmap tab count matches the app',
    m ? `roadmap says ${m[1]}, app has ${tabs.length}` : '');

  const listM = /\(`([^`]+)`\)/.exec(ROADMAP.slice(ROADMAP.indexOf('دو عددی که باید حفظ'), ROADMAP.indexOf('دو عددی که باید حفظ') + 400));
  ok(!!listM, 'the roadmap lists the tabs by name');
  if (listM) {
    const named = listM[1].split(',').map((s) => s.trim()).filter(Boolean);
    ok(named.length === tabs.length, 'the listed tab names count matches', `${named.length} names`);
    ok(named.every((n) => tabs.includes(n)), 'every listed tab exists in the app',
      named.filter((n) => !tabs.includes(n)).join(','));
  }
}

/* ---------- B. drawing tools + menu groups ---------- */
{
  const ui = readSource('src/renderer/js/drawing/ui.js');
  const groupsSrc = /const GROUPS = \[([\s\S]*?)\n  \];/.exec(ui);
  ok(!!groupsSrc, 'the drawing toolbar declares GROUPS');
  const groupCount = groupsSrc ? (groupsSrc[1].match(/\{ id: '/g) || []).length : 0;

  /* Registered tools: TOOLS.x = {...} plus helper registrations whose first
     argument is the tool id (forkTool('pitchfork', ...), polyTool('hs', ...)). */
  const dir = path.join(ROOT, 'src/renderer/js/drawing');
  const walk = (d) => fs.readdirSync(d).flatMap((f) => {
    const p = path.join(d, f);
    return fs.statSync(p).isDirectory() ? walk(p) : (f.endsWith('.js') ? [p] : []);
  });
  const ids = new Set();
  for (const p of walk(dir)) {
    const s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    for (const m of s.matchAll(/TOOLS\.([A-Za-z0-9_]+)\s*=/g)) ids.add(m[1]);
    for (const m of s.matchAll(/TOOLS\[\s*['"]([A-Za-z0-9_]+)['"]\s*\]\s*=/g)) ids.add(m[1]);
    for (const m of s.matchAll(/^\s*(?:const\s+)?([A-Za-z0-9_]+)\(\s*'([a-z][a-z0-9_]{1,})'\s*,/gm)) {
      if (/tool|pattern|wave|arrow|mark|fork|position|freehand|poly|shape/i.test(m[1])) ids.add(m[2]);
    }
  }

  /* Every id the menus reference must be registered — a menu row that arms
     nothing is a dead button the toolbar audit cannot see (it only clicks the
     base tool of each group). */
  const refs = new Set();
  for (const m of (groupsSrc ? groupsSrc[1] : '').matchAll(/tools:\s*\[([^\]]*)\]/g)) {
    for (const t of m[1].matchAll(/'([A-Za-z0-9_]+)'/g)) refs.add(t[1]);
  }
  ok(refs.size > 0, 'the flyouts reference tool ids');
  const missing = [...refs].filter((x) => !ids.has(x));
  ok(missing.length === 0, 'every tool named in a flyout is registered', missing.join(','));

  const unused = [...ids].filter((x) => !refs.has(x));
  ok(unused.length === 0, 'every registered tool is reachable from a flyout', unused.join(','));

  const toolM = /\*{0,2}(\d+)\*{0,2} ابزار در \*{0,2}(\d+)\*{0,2} گروه/.exec(ROADMAP);
  ok(!!toolM, 'the roadmap states a tool and group count (P0-02)');
  if (toolM) {
    ok(num(toolM[1]) === ids.size, 'the roadmap tool count matches the registry',
      `roadmap ${toolM[1]}, registry ${ids.size}`);
    ok(num(toolM[2]) === groupCount, 'the roadmap group count matches GROUPS',
      `roadmap ${toolM[2]}, GROUPS ${groupCount}`);
  }
}

/* ---------- C. strategy-tester metric rows ---------- */
{
  const tester = readSource('src/renderer/js/panels/tester.js');
  const rows = [...tester.matchAll(/^\s+\['([a-z0-9]+)',\s*'[A-Z]/gm)];
  /* 27 = the All/Long/Short table (ROUND194). Pinned because P5 restructures it
     and a silent row loss is invisible in the UI until a user counts. */
  ok(rows.length === 27, 'the tester renders 27 metric rows', `found ${rows.length}`);
  const mm = /\*{0,2}(\d+)\*{0,2} (?:ردیف )?متریک/.exec(ROADMAP);
  ok(!!mm, 'the roadmap states the metric count');
  ok(mm && num(mm[1]) === rows.length, 'the roadmap metric count matches tester.js',
    mm ? `roadmap ${mm[1]}, tester ${rows.length}` : '');
}

/* ---------- D. gate sizes ---------- */
{
  const unitDir = path.join(ROOT, 'tests/unit');
  const unitSuites = fs.readdirSync(unitDir)
    .filter((f) => f.endsWith('.mjs') && f !== 'source-utils.mjs');
  const head = ROADMAP.slice(0, ROADMAP.indexOf('## ۱'));
  const u = /verify (\d+)\/(\d+)/.exec(head);
  ok(!!u, 'the roadmap header states the unit gate size');
  ok(u && num(u[1]) === unitSuites.length && num(u[2]) === unitSuites.length,
    'the roadmap unit count matches tests/unit',
    u ? `roadmap ${u[1]}/${u[2]}, dir ${unitSuites.length}` : '');

  /* This suite is part of the count it asserts, so it must be IN the dir. */
  ok(unitSuites.includes('test_roadmap_consistency.mjs'),
    'the consistency suite itself is counted by the gate');

  const mt5 = fs.readdirSync(path.join(ROOT, 'tests/provider')).filter((f) => /^test_.*\.py$/.test(f));
  const mt5Tests = mt5.reduce((n, f) => n + (fs.readFileSync(path.join(ROOT, 'tests/provider', f), 'utf8').match(/def test_/g) || []).length, 0);
  /* Roadmap hard-codes "mt5 (۲۰ تست)" — Persian 20. */
  const mt = /mt5 \((\d+) تست\)/.exec(ROADMAP);
  ok(!!mt, 'the roadmap states the MT5 test count');
  ok(mt && num(mt[1]) === mt5Tests, 'the roadmap MT5 count matches tests/provider',
    mt ? `roadmap ${mt[1]}, provider ${mt5Tests}` : '');

  const gate = readSource('scripts/checks/e2e-gate.mjs');
  const curated = /const CURATED = \[([\s\S]*?)\n\];/.exec(gate);
  const curatedCount = curated ? (curated[1].match(/^\s*'[^']+\.py',/gm) || []).length : 0;
  const e = /check:e2e\s*→\s*(\d+)\/(\d+)/.exec(ROADMAP);
  ok(!!e, 'the roadmap states the curated E2E size');
  ok(e && num(e[1]) === curatedCount && num(e[2]) === curatedCount,
    'the roadmap E2E count matches CURATED',
    e ? `roadmap ${e[1]}/${e[2]}, gate ${curatedCount}` : '');
}

/* ---------- E. phase budget arithmetic ---------- */
{
  /* Phase rows look like `| ۵ | تستر استراتژی | ۷ | **A: ...** |`. */
  const rowRe = /^\| ([^|]+?) \| [^|]+ \| (\d+(?:\.\d+)?) \|/gm;
  const days = [];
  for (const m of ROADMAP.matchAll(rowRe)) {
    const d = num(m[2]);
    if (Number.isFinite(d) && d > 0 && m[1].trim() !== 'فاز') days.push({ phase: m[1].trim(), d });
  }
  ok(days.length === 17, 'all 17 phase rows declare a day budget', `found ${days.length}`);

  const sum = (n) => days.slice(0, n).reduce((a, x) => a + x.d, 0);
  /* A = through phase 5, B = through phase 10, C = through phase 12, D = all */
  const A = sum(6), B = sum(11), C = sum(16), D = sum(days.length);

  const total = days.reduce((a, x) => a + x.d, 0);
  for (const [label, value] of [['A', A], ['B', B], ['C', C], ['D', D]]) {
    ok(Number.isInteger(value), `milestone ${label} is a whole number of days`, String(value));
  }
  const stated = /A = (\d+) · B = (\d+) · C = (\d+) · D = (\d+)/.exec(ROADMAP);
  ok(!!stated, 'the roadmap states the four milestone totals');
  if (stated) {
    ok(num(stated[1]) === A && num(stated[2]) === B && num(stated[3]) === C && num(stated[4]) === D,
      'the milestone totals equal the sum of their phase rows',
      `stated ${stated.slice(1, 5).join('/')} vs computed ${[A, B, C, D].join('/')}`);
  }
  /* The "N نفر-روز ≈ M ماه" sentence must use the same D. */
  const sent = /(\d+) نفر-روز/.exec(ROADMAP);
  ok(sent && num(sent[1]) === D, 'the headline day total equals the phase sum',
    sent ? `headline ${sent[1]}, sum ${D} (total ${total})` : '');
}

/* ---------- F. gate map ---------- */
{
  const gate = readSource('scripts/checks/e2e-gate.mjs');
  const panelBlock = /const PANEL_SUITES = \[([\s\S]*?)\n\];/.exec(gate);
  ok(!!panelBlock, 'the E2E gate declares PANEL_SUITES');
  const registered = panelBlock
    ? [...panelBlock[1].matchAll(/'([^']+\.py)'/g)].map((m) => m[1])
    : [];

  /* Every suite the roadmap's gate map promises must be in PANEL_SUITES,
     otherwise it will be "runnable but never run" (ROADMAP §5). */
  const mapM = /## 5\) نگاشت گیت‌ها([\s\S]*?)\n## /.exec(ROADMAP);
  ok(!!mapM, 'the roadmap has a gate map section');
  if (mapM) {
    const promised = [...mapM[1].matchAll(/`(e2e_round\d+[a-z_]*\.py)`/g)].map((m) => m[1]);
    const notRegistered = promised.filter((f) => !registered.includes(f));
    ok(notRegistered.length === 0, 'every E2E suite in the gate map is registered',
      notRegistered.join(','));
    ok(promised.length > 0, 'the gate map promises suites');
  }

  /* `--panels` must exist or the registered suites run nowhere. */
  ok(/--panels/.test(gate), 'the gate has a --panels selector');
  ok(/check:e2e:panels/.test(readSource('package.json')),
    'package.json exposes check:e2e:panels');
  ok(/check:e2e:panels/.test(readSource('.github/workflows/ci.yml')),
    'CI runs check:e2e:panels in its own step');

  /* ROUND305: ci.yml skips docs-only pushes, so this suite -- which compares
     documents to code -- would never run on a documentation change. A separate
     workflow closes that hole; if it is deleted the hole silently reopens. */
  const docsWf = '.github/workflows/docs-consistency.yml';
  ok(fs.existsSync(path.join(ROOT, docsWf)), 'a docs-only workflow exists', docsWf);
  if (fs.existsSync(path.join(ROOT, docsWf))) {
    const wf = readSource(docsWf);
    ok(/docs\/\*\*/.test(wf), 'it triggers on docs/**');
    ok(/test_roadmap_consistency\.mjs/.test(wf), 'it runs this suite');
    ok(/test_release_script\.mjs/.test(wf), 'it runs the release-script suite');
    /* it must stay cheap: no install, no browser. Comments are stripped first —
       the file's own documentation says "no Playwright, no npm install", which
       is a description, not a step. */
    const wfCode = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    ok(!/npm install/.test(wfCode), 'it does not install dependencies');
    ok(!/playwright|electron-builder|npm run dist/i.test(wfCode),
      'it does not boot a browser or a build');
  }
  /* and ci.yml must not have grown a job that can never run */
  const ci = readSource('.github/workflows/ci.yml');
  ok(!/docs:-pre-v-all-prose/.test(ci), 'ci.yml has no impossible docs job');
}

/* ---------- G. port hygiene ---------- */
{
  /* The roadmap §1.3 documents the free ranges; every suite that is NEW (i.e.
     named in PANEL_SUITES) must use a unique pair inside them, because those
     are the suites that will be sharded first. */
  const roadmapRange = /HTTP (\d+)[–-](\d+)\D{1,8}WS (\d+)[–-](\d+)/.exec(ROADMAP);
  ok(!!roadmapRange, 'the roadmap documents the free port ranges');
  if (roadmapRange) {
    const [hLo, hHi, wLo, wHi] = roadmapRange.slice(1).map(Number);
    ok(hLo < hHi && wLo < wHi, 'the documented ranges are well formed', roadmapRange[0]);

    const gate = readSource('scripts/checks/e2e-gate.mjs');
    const panelBlock = /const PANEL_SUITES = \[([\s\S]*?)\n\];/.exec(gate);
    const panels = panelBlock ? [...panelBlock[1].matchAll(/'([^']+\.py)'/g)].map((m) => m[1]) : [];
    const dir = path.join(ROOT, 'tests/archive/e2e');
    const problems = [];
    const seen = new Set();
    for (const f of panels) {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) continue; /* pending phase */
      const s = fs.readFileSync(p, 'utf8');
      const pair = /PORT_HTTP\s*,\s*PORT_WS\s*=\s*(\d+)\s*,\s*(\d+)/.exec(s);
      if (!pair) { problems.push(`${f}: no PORT_HTTP/PORT_WS pair`); continue; }
      const [h, w] = [Number(pair[1]), Number(pair[2])];
      if (h < hLo || h > hHi) problems.push(`${f}: HTTP ${h} outside ${hLo}-${hHi}`);
      if (w < wLo || w > wHi) problems.push(`${f}: WS ${w} outside ${wLo}-${wHi}`);
      const key = `${h}/${w}`;
      if (seen.has(key)) problems.push(`${f}: pair ${key} already used by another panel suite`);
      seen.add(key);
    }
    ok(problems.length === 0, 'every written panel suite uses a unique documented port pair',
      problems.join(' | '));
  }
}

/* ---------- H. document hygiene ---------- */
{
  /* A phase-13 task numbered P14 is how the last draft lost a reader. */
  ok(!/P14-\d/.test(ROADMAP), 'no phase-13 task is mis-numbered P14');
  ok(/P13-01/.test(ROADMAP) && /P13-03/.test(ROADMAP), 'phase 13 tasks are numbered P13-*');

  /* Every relative markdown link in the doc must resolve, or the next chat
     follows a 404 instead of the audit. */
  const links = [...ROADMAP.matchAll(/\]\(([^)#]+?)(?:#[^)]*)?\)/g)]
    .map((m) => m[1])
    .filter((l) => !/^https?:/i.test(l) && !l.startsWith('#'));
  const broken = links.filter((l) => !fs.existsSync(path.join(ROOT, 'docs', l)));
  ok(broken.length === 0, 'every internal link in the roadmap resolves', broken.join(','));

  /* The two living documents must know about each other: the roadmap says which
     audit supplied its gaps, and the handoff points at the roadmap. */
  ok(/TV-PARITY-AUDIT-R304\.md/.test(ROADMAP),
    'the roadmap cross-links the R304 parity audit');
  const handoff = readSource('docs/HANDOFF-CURRENT.md');
  ok(/ROADMAP-PANELS\.md/.test(handoff), 'the handoff links the roadmap');

  /* docs/README.md is the index of living documents; an unlisted plan is a plan
     nobody finds. */
  const readme = readSource('docs/README.md');
  ok(/ROADMAP-PANELS\.md/.test(readme), 'docs/README.md lists the roadmap');
  ok(/TV-PARITY-AUDIT-R304\.md/.test(readme), 'docs/README.md lists the R304 audit');

  /* §1.1 rule the whole suite enforces — keep it stated, it is the licence to
     prefer code over document. */
  ok(/کد مرجع است/.test(ROADMAP), 'the "code is the reference" rule is written down');
}

/* ---------- I. version drift between the three sources of truth ---------- */
{
  /* docs/HANDOFF-CURRENT.md §4.1 says "the version lives in three places" and
     release.mjs updates all three. Both were true, but the handoff's own header
     still said 1.9.233 while package.json said 1.9.234 — a stale handoff is how
     the next chat starts from the wrong baseline. */
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const logger = readSource('src/core/logger.js');
  const appVer = /const APP_VERSION = '([^']+)';/.exec(logger);
  ok(!!appVer, 'src/core/logger.js declares APP_VERSION');
  ok(appVer && appVer[1] === pkg,
    'APP_VERSION equals package.json',
    appVer ? `logger ${appVer[1]}, package ${pkg}` : '');

  const index = readSource('CHANGELOG.md');
  const idxVer = /Current version: \*\*([0-9.]+)\*\*/.exec(index);
  ok(!!idxVer, 'CHANGELOG.md declares the current version');
  ok(idxVer && idxVer[1] === pkg,
    'the CHANGELOG index version equals package.json',
    idxVer ? `index ${idxVer[1]}, package ${pkg}` : '');

  /* The changelog for the current minor line must contain an entry for the
     running version, or a release shipped without notes. */
  const line = pkg.split('.').slice(0, 2).join('.');
  const clPath = `changelog/v${line}.md`;
  const cl = fs.existsSync(path.join(ROOT, clPath)) ? readSource(clPath) : '';
  ok(new RegExp(`^## ${pkg.replace(/\./g, '\\.')} `, 'm').test(cl),
    `the ${line}.x changelog has an entry for ${pkg}`);

  /* The handoff header is the first thing a new chat reads. */
  const handoffHeader = /نسخه: \*\*([0-9.]+)\*\*/.exec(readSource('docs/HANDOFF-CURRENT.md'));
  ok(!!handoffHeader, 'the handoff header states the version');
  ok(handoffHeader && handoffHeader[1] === pkg,
    'the handoff header version equals package.json',
    handoffHeader ? `handoff ${handoffHeader[1]}, package ${pkg}` : '');

  /* The roadmap header pins the unit-gate size; it must be the CURRENT number,
     not the one from the chat that wrote the doc. */
  const head = ROADMAP.slice(0, ROADMAP.indexOf('## 1'));
  const u = /verify (\d+)\/(\d+)/.exec(head);
  const unitSuites = fs.readdirSync(path.join(ROOT, 'tests/unit'))
    .filter((f) => f.endsWith('.mjs') && f !== 'source-utils.mjs').length;
  ok(u && num(u[1]) === unitSuites,
    'the roadmap header tracks the current unit-gate size',
    u ? `roadmap ${u[1]}, dir ${unitSuites}` : '');
}

/* ---------- J. the phase count is not a slogan ---------- */
{
  /* Three documents say "13 phases" (the roadmap, the handoff, the roadmap's
     own §1 intro). When phase 14 is added, all three must be updated in the same
     commit — this is the check that notices. */
  const budgetRows = [...ROADMAP.matchAll(/^\| (\d+(?:[^|]*?)) \| [^|]+ \| \d+(?:\.\d+)? \|/gm)]
    .map((m) => m[1].trim())
    .filter((p) => p !== 'فاز');
  /* Sub-phases are 12الف..12د: they belong to phase 12, not four new phases. */
  const phases = new Set(budgetRows.map((p) => String(p).replace(/[الفبجد]+$/, '')));
  /* `\b` is useless between a digit and a Persian letter (both are non-ASCII
     word chars in this sense), so the boundary is written as "digit, space,
     then فاز" and the terminator is the next non-word character. */
  const declared = /(\d+)\s+فاز(?![ا-ی])/.exec(ROADMAP);
  ok(!!declared, 'the roadmap declares its phase count in prose');
  ok(declared && num(declared[1]) === phases.size,
    'the declared phase count equals the distinct budget rows',
    declared ? `declared ${declared[1]}, rows ${phases.size} (${[...phases].join(',')})` : '');

  const handoff = normalize(readSource('docs/HANDOFF-CURRENT.md')).replace(/\n/g, ' ');
  const h = /(\d+)\s+فاز(?![ا-ی])/.exec(handoff);
  ok(h && num(h[1]) === phases.size,
    'the handoff states the same phase count',
    h ? `handoff ${h[1]}, roadmap ${phases.size}` : 'no count in the handoff');

  ok(phases.size >= 13, 'no phase row has been lost', [...phases].join(','));
}

console.log(`\nROADMAP consistency: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
