/**
 * Pine scripts store (round 74)
 *
 * Persistence for the user's .pine scripts through the ENV.storage seam
 * (core/env.js) — unlimited scripts, TV-editor-like management, plus the
 * shipped sample templates. Format:
 *   mt5_pine_scripts = { v: 1, scripts: [{ id, name, source, createdAt, updatedAt }] }
 *
 * @module panels/pine-scripts-store
 */

import { U } from '../core/util.js';
import { libTitleOf, matchCandidate } from '../../../core/pine/library.js';
/* ROUND241 (TV parity): strategy-vs-indicator identity for the Indicators
   dialog — isStrategySource is the single source of truth next to the
   compiler's declMeta (first body statement opens strategy(). */
import { isStrategySource } from '../../../core/pine/compile.js';
import { Log } from '../../../core/logger.js';

const KEY = 'mt5_pine_scripts';

/* ROUND133: the user's REAL TradingView indicators ship as files under
   assets/pine-samples/ and are lazily fetched on first seed — SMC is ~50KB,
   inlining it here would bloat the main bundle. If a fetch fails (file://
   edge cases) the template is skipped, never breaks the store. */
const TV_SAMPLES = [
  { name: 'Smart Money Concepts [LuxAlgo]', file: 'sample-SmartMoneyConcepts.pine' },
  { name: 'Squeeze Momentum [LazyBear]', file: 'sample-SqueezeMomentum.pine' },
  { name: 'Supertrend', file: 'sample-Supertrend.pine' },
  { name: 'CM MacD Ult MTF', file: 'sample-CM_MacD_Ult_MTF.pine' },
  { name: 'Squeeze Momentum v6', file: 'sqzmom-v6.pine' },
];

async function fetchSampleSource(file) {
  try {
    const res = await fetch('assets/pine-samples/' + file);
    if (!res.ok) return null;
    const txt = await res.text();
    // v2/v4 legacy scripts often lack a //@version header — accept any
    // non-empty Pine-looking file (plots/statements), not just version tags
    return txt && txt.length > 40 ? txt : null;
  } catch (e) { return null; }
}

const SAMPLES = [
  {
    name: 'EMA (sample)',
    source: `//@version=6
indicator("EMA (sample)", overlay=true)
len = input.int(21, "Length", minval=1)
src = input.source(close, "Source")
e = ta.ema(src, len)
plot(e, title="EMA", color=color.new(color.orange, 0), linewidth=2)
`,
  },
  {
    name: 'RSI (sample)',
    source: `//@version=6
indicator("RSI (sample)", overlay=false)
len = input.int(14, "Length", minval=1)
r = ta.rsi(close, len)
plot(r, title="RSI", color=color.new(#7e57c2, 0), linewidth=2)
hline(70, "OB", linestyle=hline.style_dashed)
hline(30, "OS", linestyle=hline.style_dashed)
`,
  },
  {
    name: 'MACD (sample)',
    source: `//@version=6
indicator("MACD (sample)", overlay=false)
[macdLine, signalLine, histLine] = ta.macd(close, 12, 26, 9)
plot(macdLine, title="MACD", color=color.new(color.blue, 0), linewidth=2)
plot(signalLine, title="Signal", color=color.new(color.orange, 0), linewidth=2)
plot(histLine, title="Hist", style=plot.style_histogram, linewidth=4)
hline(0, "Zero", linestyle=hline.style_dotted)
`,
  },
  {
    name: 'Bollinger + fill (sample)',
    source: `//@version=6
indicator("Bollinger (sample)", overlay=true)
length = input.int(20, "Length", minval=1)
mult = input.float(2.0, "StdDev", minval=0.1, maxval=10)
basis = ta.sma(close, length)
dev = mult * ta.stdev(close, length)
pU = plot(basis + dev, title="Upper", color=color.new(color.blue, 0))
pL = plot(basis - dev, title="Lower", color=color.new(color.blue, 0))
fill(pU, pL, color=color.new(color.blue, 92))
plot(basis, title="Basis", color=color.new(color.orange, 0), linewidth=2)
`,
  },
];

function load() {
  const data = U.lsGet(KEY, null);
  if (data && data.v === 1 && Array.isArray(data.scripts)) return data;
  const seeded = { v: 1, scripts: SAMPLES.map((s, i) => ({
    id: 'tpl' + (i + 1), name: s.name, source: s.source,
    createdAt: Date.now(), updatedAt: Date.now(), template: true,
  })) };
  U.lsSet(KEY, seeded);
  return seeded;
}

/* ROUND133: seed the TV indicator templates (async — the editor opens later;
   a missing/failed fetch just means that sample never appears). Runs at most
   once per install: seeds only if the store has no 'tv' template marker. */
let _tvSeeded = false;
async function ensureTvSamples() {
  if (_tvSeeded) return;
  _tvSeeded = true;
  const data = load();
  /* ROUND147: Supertrend sample dropped its stacked circle markers (label-only
     now) — refresh the once-seeded tv copy on installs that still carry the
     old source, so the fix reaches existing users, not just fresh seeds. */
  const stFile = 'sample-Supertrend.pine';
  const stSrc = await fetchSampleSource(stFile);
  let stale = data.scripts.find((s) => s.tv && /sample-supertrend/i.test(s.id) && s.source && /UpTrend Begins/.test(s.source));
  if (stale && stSrc) {
    stale.source = stSrc;
    stale.updatedAt = Date.now();
    U.lsSet(KEY, data);
  }
  if (data.scripts.some((s) => s.tv)) return; // already seeded (any version)
  for (const s of TV_SAMPLES) {
    const source = await fetchSampleSource(s.file);
    if (!source) continue;
    data.scripts.push({
      id: 'tv_' + s.file.replace(/[^a-z0-9]/gi, '_').toLowerCase(),
      name: s.name, source, createdAt: Date.now(), updatedAt: Date.now(),
      template: true, tv: true,
    });
  }
  U.lsSet(KEY, data);
}
const _tvKick = ensureTvSamples();

/* ROUND195: library() title probe cache (parse-once per script stamp). */
const _libTitles = new Map();
function _libTitleCacheTrim() { return _libTitles.size > 300; }

const Store = {
  all() { return load().scripts; },
  get(id) { return load().scripts.find((s) => s.id === id) || null; },
  /* ROUND241 (TV parity): true when the script's declaration is strategy()
     (dialog STRATEGIES section + STRATEGY row tags). Never throws — an
     unreadable source is simply not a strategy. */
  isStrategy(source) {
    try { return isStrategySource(source); }
    catch (e) { return false; }
  },
  /* ROUND195 (library/import): the local library shelf — saved scripts whose
     source parses as a library() script. Title probes cached per stamp;
     resolution order (exact title → caseless title → script name) lives in
     core/pine/library.js. */
  libraries() {
    const out = [];
    try {
      for (const s of load().scripts) {
        if (!s || !s.source) continue;
        const stamp = s.id + ':' + s.updatedAt;
        let title;
        if (_libTitles.has(stamp)) title = _libTitles.get(stamp);
        else {
          title = libTitleOf(s.source);
          _libTitles.set(stamp, title);
          if (_libTitleCacheTrim()) _libTitles.clear();
        }
        if (title) out.push({ title, name: s.name, id: s.id, source: s.source, stamp });
      }
    } catch (e) { Log.warn('pine', 'library catalog scan failed', e) }
    return out;
  },
  /** resolve `user/lib/version` to a saved library source (compile seam) */
  resolveLibrary(path) {
    const segs = String(path || '').split('/');
    let hit = null;
    try { hit = matchCandidate(segs, Store.libraries()); } catch (e) { hit = null; }
    if (!hit) return null;
    return { source: hit.source, stamp: hit.stamp };
  },
  /** candidate titles for the not-found message (compile seam) */
  listLibraries() {
    try { return Store.libraries().map((l) => ({ title: l.title, name: l.name })); }
    catch (e) { return []; }
  },
  create(name, source) {
    const data = load();
    const rec = { id: 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      name: name || 'Untitled script', source: source || '', createdAt: Date.now(), updatedAt: Date.now() };
    data.scripts.push(rec);
    U.lsSet(KEY, data);
    return rec;
  },
  save(id, patch) {
    const data = load();
    const rec = data.scripts.find((s) => s.id === id);
    if (!rec) return null;
    if (patch.name != null) rec.name = String(patch.name);
    if (patch.source != null) rec.source = String(patch.source);
    rec.updatedAt = Date.now();
    U.lsSet(KEY, data);
    return rec;
  },
  remove(id) {
    const data = load();
    data.scripts = data.scripts.filter((s) => s.id !== id);
    U.lsSet(KEY, data);
  },
  /** unique display name for a new/imported script */
  uniqueName(base) {
    const names = new Set(load().scripts.map((s) => s.name));
    if (!names.has(base)) return base;
    let k = 2;
    while (names.has(base + ' ' + k)) k++;
    return base + ' ' + k;
  },
};

export { Store as PineScriptsStore, SAMPLES as PINE_SAMPLES };
