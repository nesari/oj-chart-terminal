/**
 * ROUND86C — renderer paging regression against the REAL shipped code.
 *
 * Imports panels/gotodate.js + panels/session.js with the import lines
 * stripped and stubs injected, then exercises fetchWindow / retryBars /
 * loadBaseBars against a mock provider that mimics demo.py's
 * _slice_history semantics (bars strictly before `to`, newest-last,
 * optional cold-terminal empty payloads).
 *
 * Pins the ROUND86C right-sizing fix: pages must be sized to the REMAINING
 * WINDOW (window-need + 200 slack), never a blind 25k/20k over-request —
 * the over-request is what made the real terminal sync ~52 days of M1
 * archive for a 1-day view and fed the "Request timeout: bars_req" freeze.
 *
 * Run: node tests/unit/test_round86c_paging.mjs
 */
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  (cond ? pass++ : fail++);
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '  — ' + extra));
};

/* ---------- module loader: strip imports, inject stubs, export hooks ---------- */
async function loadModule(relPath, stubs, hookExpr) {
  const src = readFileSync(join(ROOT, relPath), 'utf8')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  const tmp = join(ROOT, 'scripts', '.tmp_round86c_' + relPath.replace(/[/.]/g, '_') + '.mjs');
  writeFileSync(tmp, stubs + '\n' + src + '\n' + hookExpr + '\n');
  try {
    return await import(pathToFileURL(tmp).href);
  } finally {
    try { unlinkSync(tmp); } catch (e) {}
  }
}

/* ---------- mock provider (demo.py _slice_history semantics) ---------- */
function mockFeed(archiveFor, { coldCalls = 0 } = {}) {
  const calls = [];
  let coldLeft = coldCalls;
  return {
    calls,
    async bars(symbol, tf, count, to) {
      calls.push({ symbol, tf, count, to });
      const arch = archiveFor(symbol, tf) || [];
      let out = to != null ? arch.filter((b) => b.time < to) : arch.slice();
      out = out.slice(-count);
      if (coldLeft > 0) { coldLeft--; return { bars: [], digits: 5 }; }
      return { bars: out, digits: 5 };
    },
  };
}

const m1 = (t) => ({ time: t, open: 1, high: 1.1, low: 0.9, close: 1, volume: 10 });
function buildM1(fromT, toT) {
  const out = [];
  for (let t = fromT; t < toT; t += 60) out.push(m1(t));
  return out;
}

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
const App = { feed: null };   // handle into each module's own stub (via __hook.App)
/* gotodate.js IMPORTS SessionRange; session.js DEFINES it — two stub sets */
const STUBS = `
const App = { tfById: {
  M1: { id: 'M1', sec: 60, label: 'M1' }, M5: { id: 'M5', sec: 300, label: 'M5' },
  M15: { id: 'M15', sec: 900, label: 'M15' }, H1: { id: 'H1', sec: 3600, label: 'H1' },
  MN1: { id: 'MN1', sec: 2592000, label: 'MN1' },
}, feed: null, COUNT_FOR: {} };
const U = { el: () => ({}), lsGet: () => null, lsSet: () => {}, clear: () => {}, timeToLogical: () => 0 };
const icon = () => '';
const Manager = {};
const UI = { toast: () => {} };
const Replay = { isActive: () => false, startAt: () => true, stop: () => {}, cursor: () => 0, jumpTo: () => true };
const SessionRange = { isActive: () => false, clear: () => {}, pickBase: () => ({ id: 'M1', sec: 60 }) };
const DAY = 86400;
const stitchBars = () => [];
const insertDayGaps = (bars) => ({ bars, gaps: 0 });
`;
const STUBS_SS = STUBS.replace("const SessionRange = { isActive: () => false, clear: () => {}, pickBase: () => ({ id: 'M1', sec: 60 }) };\n", '');

/* ================= gotodate.js — fetchWindow / retryBars ================= */
const gd = await loadModule(
  'src/renderer/js/panels/gotodate.js', STUBS,
  'export const __hook = { fetchWindow, retryBars, FETCH_ATTEMPTS, MAX_FETCH_BARS, CHUNK_GUARD, App };');

{
  console.log('gotodate.fetchWindow — right-sized paging (ROUND86C)');
  /* 1. one-day M1 window: first page MUST be window-need (1640), not 25k */
  const fromT = NOW - DAY, toT = NOW;
  let feed = mockFeed((s, tf) => (tf === 'M1' ? buildM1(NOW - 40 * DAY, NOW) : []));
  gd.__hook.App.feed = feed;
  const r1 = await gd.__hook.fetchWindow('EURUSD', 'M1', fromT, toT, gd.__hook.MAX_FETCH_BARS);
  check('1-day M1 window fully filled', r1.bars.length === 1440, 'got ' + r1.bars.length);
  check('first page right-sized to 1640 (was 25000 blind)',
        feed.calls[0].count === 1640, 'got ' + feed.calls[0].count);
  check('single page suffices (no paging)', feed.calls.length === 1, 'calls ' + feed.calls.length);
  check('all bars inside the window', r1.bars.every((b) => b.time >= fromT && b.time < toT));

  /* 2. 30-day M1 window (> 25k cap): fills to the cap, then stops */
  feed = mockFeed((s, tf) => (tf === 'M1' ? buildM1(NOW - 40 * DAY, NOW) : []));
  gd.__hook.App.feed = feed;
  const r2 = await gd.__hook.fetchWindow('EURUSD', 'M1', NOW - 30 * DAY, NOW, gd.__hook.MAX_FETCH_BARS);
  check('30-day window fills to the 25k cap',
        r2.bars.length === gd.__hook.MAX_FETCH_BARS, 'got ' + r2.bars.length);
  check('cap reached in ONE page (no redundant sliding pages)',
        feed.calls.length === 1, 'calls ' + feed.calls.length);

  /* 2b. window larger than the cap: the NEWEST cap bars are kept (so the
         "View that date" center stays near the selected day) — and it is
         ONE page, never the old 12-page 1-bar slide */
  feed = mockFeed((s, tf) => (tf === 'M1' ? buildM1(NOW - 40 * DAY, NOW) : []));
  gd.__hook.App.feed = feed;
  const r2b = await gd.__hook.fetchWindow('EURUSD', 'M1', NOW - 30 * DAY, NOW, 5000);
  check('over-cap window: single page (sliding-pages bug pinned)',
        feed.calls.length === 1, 'calls ' + feed.calls.length);
  check('over-cap window: newest cap bars kept',
        r2b.bars.length === 5000 && r2b.bars[r2b.bars.length - 1].time === NOW - 60,
        'got ' + r2b.bars.length + ' last ' + (r2b.bars[r2b.bars.length - 1] || {}).time);

  /* 3. cold terminal: first 2 answers empty, then data (retryBars polls) */
  feed = mockFeed((s, tf) => (tf === 'M1' ? buildM1(NOW - 40 * DAY, NOW) : []), { coldCalls: 2 });
  gd.__hook.App.feed = feed;
  const r3 = await gd.__hook.fetchWindow('EURUSD', 'M1', NOW - DAY, NOW, gd.__hook.MAX_FETCH_BARS);
  check('cold-terminal empty payloads polled through', r3.bars.length === 1440,
        'got ' + r3.bars.length + ' after ' + feed.calls.length + ' calls');

  /* 4. archive dries mid-window: returns what exists, no hang */
  feed = mockFeed((s, tf) => (tf === 'M1' ? buildM1(NOW - 3 * DAY, NOW) : []));
  gd.__hook.App.feed = feed;
  const r4 = await gd.__hook.fetchWindow('EURUSD', 'M1', NOW - 30 * DAY, NOW, gd.__hook.MAX_FETCH_BARS);
  check('dry archive: returns the 3 available days', r4.bars.length === 4320,
        'got ' + r4.bars.length);
  check('dry archive: stops paging (<= 3 pages)', feed.calls.length <= 3, 'calls ' + feed.calls.length);

  /* 5. MN1 (the overflow TF family): tiny page counts, single page */
  feed = mockFeed((s, tf) => {
    if (tf !== 'MN1') return [];
    const out = [];
    for (let t = NOW - 20 * 2592000; t < NOW; t += 2592000) out.push({ time: t, open: 1, high: 2, low: 0.5, close: 1.2, volume: 1 });
    return out;
  });
  gd.__hook.App.feed = feed;
  const r5 = await gd.__hook.fetchWindow('XAUUSD', 'MN1', NOW - 2 * 365 * DAY, NOW, gd.__hook.MAX_FETCH_BARS);
  check('MN1 2-year window: right-sized request (225 = 25 months + slack, was 25000)',
        feed.calls[0].count === 225, 'got ' + feed.calls[0].count);
  check('MN1 window bars returned', r5.bars.length === 20, 'got ' + r5.bars.length);
}

/* ================= session.js — loadBaseBars (Custom Session) ================= */
const ss = await loadModule(
  'src/renderer/js/panels/session.js', STUBS_SS,
  'export const __hook = { loadBaseBars, CHUNK, MAX_TOTAL, App };');

{
  console.log('session.loadBaseBars — right-sized paging (ROUND86C)');
  /* the user's screenshot case: 2 day(s) x 3h window on base M1 —
     window aligned fully in the PAST (the current day is partial) */
  let feed = mockFeed((s, tf) => (tf === 'M1' ? buildM1(NOW - 40 * DAY, NOW) : []));
  ss.__hook.App.feed = feed;
  const fromT = (Math.floor(NOW / DAY) - 3) * DAY, toT = (Math.floor(NOW / DAY) - 1) * DAY;
  const r1 = await ss.__hook.loadBaseBars('EURUSD', { id: 'M1', sec: 60 }, fromT, toT);
  check('2-day base window fully filled', r1.bars.length === 2880, 'got ' + r1.bars.length);
  check('first page right-sized to 3080 (was 20000 blind)',
        feed.calls[0].count === 3080, 'got ' + feed.calls[0].count);

  /* long range: the 8-page guard is the effective stop for a 120-day M1
     base load (8 x 20000 = 160k bars, all DISTINCT after the oldest fix) */
  feed = mockFeed((s, tf) => (tf === 'M1' ? buildM1(NOW - 400 * DAY, NOW) : []));
  ss.__hook.App.feed = feed;
  const r2 = await ss.__hook.loadBaseBars('EURUSD', { id: 'M1', sec: 60 }, NOW - 120 * DAY, NOW);
  check('120-day window: 8 guard pages consumed',
        feed.calls.length === 8, 'calls ' + feed.calls.length);
  check('120-day window: 160k DISTINCT bars collected',
        r2.bars.length === 160000, 'got ' + r2.bars.length);
  check('page 2 full-sized (remaining window still huge)',
        feed.calls[1].count === ss.__hook.CHUNK, 'got ' + (feed.calls[1] || {}).count);

  /* cold terminal on the Custom Session path too */
  feed = mockFeed((s, tf) => (tf === 'M1' ? buildM1(NOW - 40 * DAY, NOW) : []), { coldCalls: 2 });
  ss.__hook.App.feed = feed;
  const r3 = await ss.__hook.loadBaseBars('EURUSD', { id: 'M1', sec: 60 }, fromT, toT);
  check('cold-terminal poll fills the base window', r3.bars.length === 2880,
        'got ' + r3.bars.length);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
