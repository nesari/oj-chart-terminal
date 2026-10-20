/**
 * ROUND86 (user request) — Custom Session mode ("stitched hours").
 *
 * The user picks a daily hour window (e.g. 03:00–05:00) and a date range;
 * the app takes that window from EVERY day in the range and lays the
 * resulting candles side by side on every chart, with a small visual gap
 * between consecutive day regions. All timeframes keep working (the
 * windowed data re-aggregates per timeframe) and multi-chart keeps working
 * (every pane stitches its own symbol).
 *
 * Data model per pane:
 *   - pane.bars      = COMPACT stitched candles (real bars only) — the
 *     array every consumer (legend, indicators, DataWindow, replay slicing)
 *     reads; it behaves exactly like normal history.
 *   - the SERIES additionally receives tiny whitespace rows ({time} only)
 *     between day segments so the day regions separate visually. Indicators
 *     are computed from the compact bars (no NaN poisoning).
 *   - pane.replay = {} blocks live ticks (same guard Manager.onTick uses):
 *     a stitched historical view must never fold a live tick into a past
 *     bar.
 *
 * Integration points (all guarded, zero behavior change when inactive):
 *   - App.sessionHook.active() — checked by Manager.loadBars / loadOlder /
 *     panels/replay.js.
 *   - Manager.loadBars reroutes to loadPane() while active, which covers
 *     TF switches, symbol switches, layout changes and reconnects for free.
 *   - Base (M1/M5/…) history is fetched once per symbol per range and
 *     cached; timeframe switches rebuild from the cache without refetching.
 *
 * Works identically on broker data and on the demo-server data — the mode
 * only consumes whatever bars the current provider serves.
 *
 * @module panels/session
 */
import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { App } from '../../../core/state.js';
import { Manager } from '../chart/manager.js';
import { UI } from '../drawing/ui.js';
import { Replay } from './replay.js';
import { DAY, stitchBars, insertDayGaps, windowSec } from '../../../core/session-math.js';
import { TZ } from '../../../core/timezone.js';

const K_CFG = 'mt5_rp_session';
const GAP_BARS = 3;          // whitespace slots between day regions
const CHUNK = 20000;         // bars per provider request (providers cap at 25k)
const MAX_TOTAL = 300000;    // hard cap of cached base bars per symbol
const CHUNK_ATTEMPTS = 3;    // empty-payload poll (cold terminal downloads)
const CHUNK_DELAY = 1200;    // ms between attempts
const BASES = [              // base-history resolution ladder (finest first)
  { id: 'M1', sec: 60 }, { id: 'M5', sec: 300 },
  { id: 'M15', sec: 900 }, { id: 'H1', sec: 3600 },
];

const S = {
  on: false,
  cfg: null,        // {hFrom, hTo, mFrom, mTo, dFrom, dTo} — day numbers = CHART-TZ days (round 88), minutes added round 87
  cache: {},        // symbol -> {base, bars, dFrom, dTo, tz, srv} | {promise}
  lastGaps: 0,      // ROUND86 e2e: whitespace rows inserted by the last stitch
  shiftFn: null,    // round 88: wall = stamp + shift(stamp) — built lazily per App.tz + serverOff
  shiftKey: '',     // tz|srv the shiftFn was built for
};

/* 04:30-style label for toasts + the dialog info line */
function hhmm(h, m) { return String(h).padStart(2, '0') + ':' + String(m == null ? 0 : m).padStart(2, '0'); }

const SessionRange = {};

SessionRange.isActive = function () { return S.on; };
SessionRange.cfg = function () { return S.cfg; };

/* ---------- ROUND88: the chart-timezone shift ----------
   The user enters the window in the timezone they selected FOR THE CHART
   ("کاربر بر اساس تایم زونی که انتخاب کرده برای چارتش ... وارد میکنه") and
   the axis labels display stamps through that same zone — so the window
   must select bars by their WALL time in App.tz, not by the raw broker
   stamps. wall = stamp − serverOff + zoneOffset(tz) ⇒ shift = zone − srv.
   'broker' (stamps ARE the wall) and a missing feed offset keep the exact
   round-86/87 behaviour. Rebuilt whenever tz / broker offset changes. */
function shiftKeyNow() {
  /* ROUND89: the TZ only — the provider's live offset estimate NO LONGER
     participates. The cached base is RAW STAMPS (offset-independent), so a
     re-measured broker offset must re-STITCH from the same cache instantly,
     never refetch (the old srv-in-the-key design made every weekend
     re-measurement drop the cache and race the axis into a mismatched
     state — the user's "the displayed region is wrong"). */
  return App.tz || '';
}
function buildShift() {
  const tz = App.tz;
  if (!tz || tz === 'broker') return null;
  /* two-pass: measure the zone offset at the stamp, then refine at the
     wall instant — the one funnel every axis label already runs through.
     ROUND89: serverOff is read LIVE inside the closure (not captured), so
     a re-measured broker offset takes effect on the very next stitch
     without rebuilding the cached per-tz shift function. */
  return (t) => {
    const srv = (App.feed && App.feed.serverOff) || 0;
    let sh = TZ.zoneOffsetMinutes(tz, new Date(t * 1000)) * 60 - srv;
    sh = TZ.zoneOffsetMinutes(tz, new Date((t + sh) * 1000)) * 60 - srv;
    return sh;
  };
}
SessionRange.shift = function () {
  if (!S.on) return null;
  const k = shiftKeyNow();
  if (S.shiftKey !== k || !S.shiftFn) { S.shiftFn = buildShift(); S.shiftKey = k; }
  return S.shiftFn;
};

/* ---------- base history per symbol ---------- */

function pickBase(days) {
  for (const b of BASES) {
    if (days * DAY / b.sec <= 120000) return b;   // ≈ 83 days on M1 …
  }
  return BASES[BASES.length - 1];
}

/* one chunked page with the cold-terminal poll: real MT5 terminals answer
   the FIRST request for not-yet-downloaded old history with an empty
   payload while the archive downloads in the background — the same case
   Manager.loadBars retries for the live chart. Without this poll the whole
   Custom Session came up empty on real brokers (ROUND86B user report). */
async function fetchChunk(symbol, baseId, count, to) {
  for (let a = 0; a < CHUNK_ATTEMPTS; a++) {
    const resp = await App.feed.bars(symbol, baseId, count, to);
    const fresh = (resp.bars || []).filter((b) => b && isFinite(b.time) && b.time < to);
    if (fresh.length) return fresh;
    if (a < CHUNK_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, CHUNK_DELAY));
  }
  return [];
}

/* one full backward-paged base load at `base` */
async function loadBaseBars(symbol, base, fromT, toT) {
  let collected = [];
  let to = toT;
  let dry = false;
  for (let guard = 0; guard < 8; guard++) {
    /* ROUND86C: page sized to the REMAINING window (the old fixed 20k made
       the real terminal sync far more archive than the stitched session
       needs — same cold-sync block as the Go-to-Date timeout fix) */
    const need = Math.ceil(Math.max(1, to - fromT) / base.sec) + 200;
    const want = Math.max(50, Math.min(CHUNK, need));
    const fresh = await fetchChunk(symbol, base.id, want, to);
    if (!fresh.length) { dry = dry || guard > 0; break; }
    /* ROUND86C: OLDEST bar of the page — the old bars[len-1] read the NEWEST
       (providers answer ascending), so backward pages slid one bar at a time
       and 8 guard pages of 20k bars were burned per base load (see the same
       fix in gotodate.fetchWindow). */
    const oldest = Math.min(fresh[0].time, fresh[fresh.length - 1].time);
    collected = fresh.concat(collected.filter((b) => b.time >= oldest));
    if (collected.length > MAX_TOTAL) {
      collected = collected.slice(-MAX_TOTAL);
      break;
    }
    if (oldest <= fromT) break;
    if (fresh.length < want) { dry = true; break; }   // provider ran dry
    to = oldest;
  }
  const map = new Map();
  for (const b of collected) map.set(b.time, b);
  const bars = Array.from(map.values())
    .sort((a, b) => a.time - b.time)
    .filter((b) => b.time >= fromT && b.time < toT);
  return { bars, dry };
}

/* the stamp window the CURRENT shift needs for the cfg range (used both to
   size the fetch and to validate a cached base — ROUND89) */
function neededWindow(cfg) {
  const w = windowSec(cfg.hFrom, cfg.hTo, cfg.mFrom, cfg.mTo);
  const shiftFn = SessionRange.shift();
  let fromT = cfg.dFrom * DAY + w.sFrom;
  let toT = (cfg.dTo + 1) * DAY + w.sTo;   // exclusive upper bound
  if (shiftFn) {
    const shA = shiftFn(cfg.dFrom * DAY), shB = shiftFn((cfg.dTo + 1) * DAY);
    fromT = Math.floor(Math.min(fromT - shA, fromT - shB)) - 10800;
    toT = Math.ceil(Math.max(toT - shA, toT - shB)) + 10800;
  }
  return { fromT, toT, shiftFn };
}

async function ensureBase(symbol) {
  const cfg = S.cfg;
  const tzKey = shiftKeyNow();
  const c = S.cache[symbol];
  /* round 88: the cached base is bound to the chart tz too — a timezone
     switch moves the whole window to different stamps.
     ROUND89: the tz-only key alone is NOT enough — a RE-MEASURED broker
     offset (the real provider re-estimates it; the weekend estimator used
     to drift it wildly) moves the needed stamp window too. A cache hit is
     only valid while the cached stamps COVER the current shift's window;
     otherwise fall through and refetch (once — the new base replaces the
     slot), so the stitch never runs on an uncovered range. */
  if (c && c.dFrom === cfg.dFrom && c.dTo === cfg.dTo && c.tzKey === tzKey && c.bars && c.bars.length) {
    const need = neededWindow(cfg);
    /* ROUND94 (weekend/holiday hang): coverage is judged against the window
       we REQUESTED (c.reqFrom/reqTo), not against the first/last BAR we got.
       The old test demanded a bar at/after toT-1 and at/before fromT — but a
       range ending today/on a Sat-Sun-holiday (or starting on one) can NEVER
       have such a bar, so every TF switch / symbol switch / offset re-measure
       dropped the cache and re-ran the whole M1->H1 ladder fetch: the pane
       sat on a refetch loop while the market was closed. */
    if (c.reqFrom != null && c.reqTo != null) {
      if (c.reqFrom <= need.fromT && c.reqTo >= need.toT) return c;
    } else if (c.bars[0].time <= need.fromT && c.bars[c.bars.length - 1].time >= need.toT - 1) return c;
    // stale coverage: drop and refetch below (keeps the promise slot intact)
  }
  if (c && c.promise) return c.promise;
  const days = cfg.dTo - cfg.dFrom + 1;
  /* cfg days are CHART-TZ days (the date inputs follow the axis); the base
     fetch must cover the stamps those wall-days map to. shift = zone − srv,
     stamp = wall − shift ⇒ widen the stamp window by the shift at both
     edges (±3h margin absorbs DST drift and ordinary offset re-measures;
     bigger moves are caught by the coverage check above and refetched). */
  const { fromT, toT, shiftFn } = neededWindow(cfg);
  const promise = (async () => {
    /* ROUND86B: base AVAILABILITY ladder — brokers archive coarse timeframes
       much deeper than fine ones; when the budget-picked base has NOTHING in
       the requested range (or the terminal could not sync it at all), fall
       back to the next coarser base instead of giving up. */
    const startIdx = Math.max(0, BASES.indexOf(pickBase(days)));
    let res = null;
    for (let li = startIdx; li < BASES.length; li++) {
      const r = await loadBaseBars(symbol, BASES[li], fromT, toT);
      if (r.bars.length) { res = Object.assign({ base: BASES[li].id }, r); break; }
      res = Object.assign({ base: BASES[li].id }, r);   // remember the last (empty) attempt
    }
    if (!res) res = { base: BASES[BASES.length - 1].id, bars: [], dry: false };
    res.dFrom = cfg.dFrom; res.dTo = cfg.dTo; res.tzKey = tzKey;
    res.reqFrom = fromT; res.reqTo = toT;   // ROUND94: the window this base was fetched for
    /* coverage report: brokers archive fine timeframes only so deep — when
       the range starts earlier than the archive, say so instead of silently
       showing fewer days (the ROUND86B "no explanation" complaint) */
    if (res.bars.length) {
      const firstDay = Math.floor((res.bars[0].time + (shiftFn ? shiftFn(res.bars[0].time) : 0)) / DAY);
      if (firstDay > cfg.dFrom) {
        const covered = new Set(res.bars.map((b) => Math.floor((b.time + (shiftFn ? shiftFn(b.time) : 0)) / DAY))).size;
        warnOnce('cov-' + symbol + '-' + cfg.dFrom + '-' + res.base,
          'Custom Session: ' + symbol + ' ' + res.base + ' archive starts ' +
          new Date(firstDay * DAY * 1000).toISOString().slice(0, 10) +
          ' — showing ' + covered + ' of ' + days + ' day(s)');
      }
      if (startIdx < BASES.indexOf(pickBase(days)) ||
          (res.base !== pickBase(days).id && res.bars.length)) {
        warnOnce('ladder-' + symbol + '-' + cfg.dFrom,
          'Custom Session: ' + pickBase(days).id + ' had no history for ' + symbol +
          ' — base ' + res.base + ' used instead');
      }
    }
    S.cache[symbol] = res;
    return res;
  })();
  S.cache[symbol] = { dFrom: cfg.dFrom, dTo: cfg.dTo, promise };
  return promise;
}

/* ---------- series building (with whitespace gap rows) ---------- */

/* gap rows are {time}-only — recognise them by their single key */
function buildSeriesData(style, compact, withGaps) {
  const mapped = Manager.seriesDataFor(style, compact);
  const out = [];
  let i = 0;
  for (const r of withGaps) {
    if (Object.keys(r).length === 1) out.push({ time: r.time });
    else out.push(mapped[i++]);
  }
  return out;
}

function setSeriesWithGaps(pane, compact) {
  const style = pane.style || 'candles';
  if (style === 'renko') { Manager.setPaneData(pane, compact); pane._sessWithGapTimes = null; pane._sessGapIdx = null; return; }
  const { bars: withGaps, gaps } = insertDayGaps(compact, GAP_BARS, SessionRange.shift());
  S.lastGaps = gaps;   // e2e-visible: series.data() silently drops whitespace rows
  /* ROUND87: the gap-INCLUSIVE time axis the series was fed — the render
     adapter's _xOf needs it because LWC's logical coordinate frame counts
     the whitespace rows; using the COMPACT barTimes shifted every
     xloc.bar_time drawing LEFT by ~2-3 bars per day boundary */
  pane._sessWithGapTimes = withGaps.map((r) => r.time);
  /* ROUND90: parallel GAP FLAGS for the engine's time axis — 1 marks a
     whitespace slot, so Engine._updateTaxExt can segment the axis into the
     user's selected day regions (labels/grid ONLY inside them) and _xOf/
     _tOf can map time↔pixel in LWC's real (gap-counting) logical frame */
  const gapIdx = new Uint8Array(withGaps.length);
  for (let i = 0; i < withGaps.length; i++) {
    if (Object.keys(withGaps[i]).length === 1) gapIdx[i] = 1;
  }
  pane._sessGapIdx = gapIdx;
  /* ROUND145: gated write (session gap rows are legal whitespace; a poisoned
     compact bar would otherwise surface only as a vendor stack) */
  const sdRows = buildSeriesData(style, compact, withGaps);
  if (Manager.seriesWriteOk) Manager.seriesWriteOk(pane, 'session-setData', sdRows);
  try { pane.series.setData(sdRows); } catch (e) {}
  pane.barTimes = compact.map((b) => b.time);
  if (style === 'linemarkers' && pane.series.setMarkers) {
    try {
      /* ROUND98: merge the trade-history markers (Manager.tradeHistoryMarkers)
         with the session circles — same one-merge-point rule as setPaneData.
         ROUND184: strategy trade markers join the merge as well. */
      const base = compact.map((b) => ({ time: b.time, position: 'inBar', shape: 'circle', color: '#2962ff', size: 1 }));
      const hist = (Manager.tradeHistoryMarkers ? Manager.tradeHistoryMarkers(pane) : []);
      const strat = (Manager.strategyMarkers ? Manager.strategyMarkers(pane) : []);
      pane.series.setMarkers(base.concat(hist, strat));
    } catch (e) {}
  }
  if (style === 'baseline') {
    pane.baseVal = compact.length ? compact[0].close : 0;
    try { pane.series.applyOptions({ baseValue: pane.baseVal }); } catch (e) {}
  }
  if (style === 'heikin') {
    const hd = Manager.seriesDataFor('heikin', compact);
    pane._haLast = hd.length ? { open: hd[hd.length - 1].open, close: hd[hd.length - 1].close } : null;
  }
}

/* re-apply the CURRENT pane.bars (compact) to the series with gap rows —
   called by panels/replay.js after its slice setData so the day gaps stay
   visible while Bar Replay runs on top of the session mode */
function applySeries(pane) {
  if (!S.on || !pane || !pane.series || !pane.bars || !pane.bars.length) return;
  const style = pane.style || 'candles';
  if (style === 'renko') return;   // renko path drew bricks without gaps
  try { setSeriesWithGaps(pane, pane.bars); } catch (e) {}
}

/* ---------- per-pane apply ---------- */

function applyPane(pane, compact) {
  pane.replay = {};            // block live ticks: a stitched view is historical
  pane._olderDone = true;      // the stitched history is finite by design
  let ok = true;
  try { setSeriesWithGaps(pane, compact); } catch (e) { ok = false; }
  if (!ok) { try { Manager.setPaneData(pane, compact); } catch (e) {} }
  /* BUG-007 invariant: pane.bars only AFTER the series accepted the data */
  pane.bars = compact;
  pane.barTimes = compact.map((b) => b.time);
  pane._shown = compact.length;
  Manager.recomputeIndicators(pane);
  Manager.recomputePine(pane);
  Manager.applyPriceLines(pane);
}

function sessionEmpty(pane) {
  pane.replay = {};
  pane._olderDone = true;
  pane.bars = []; pane.barTimes = [];
  try { pane.series.setData([]); } catch (e) {}
  pane._shown = 0;
  pane.nodataEl.classList.remove('hidden');
  Manager.recomputeIndicators(pane);
  Manager.updateLegend(pane, null);
}

const _warned = {};
function warnOnce(key, msg) {
  if (_warned[key]) return;
  _warned[key] = true;
  UI.toast(msg, 'warn');
}

async function loadPane(pane) {
  if (!pane || !S.on || !S.cfg) return;
  const tf = App.tfById[pane.tf];
  if (!tf) return;
  if (tf.sec < 60) {
    warnOnce('sec', 'Custom Session works on 1-minute timeframes and above');
    return;
  }
  const tfId = pane.tf;
  const seq = (pane._seq = (pane._seq || 0) + 1);
  let base = null;
  try { base = await ensureBase(pane.symbol); } catch (e) {
    warnOnce('fetch', 'Custom Session: history request failed — ' + (e && e.message || e));
    return;
  }
  if (!S.on || seq !== pane._seq || pane.tf !== tfId) return;   // stale
  if (!base || !base.bars || !base.bars.length) {
    warnOnce('empty-' + pane.symbol, 'Custom Session: no base history for ' + pane.symbol + ' in that range');
    sessionEmpty(pane);
    return;
  }
  const compact = stitchBars(base.bars, tf.sec, S.cfg.hFrom, S.cfg.hTo, S.cfg.mFrom, S.cfg.mTo, SessionRange.shift(), S.cfg.dFrom, S.cfg.dTo);
  if (!S.on || seq !== pane._seq || pane.tf !== tfId) return;   // stale
  if (!compact.length) { sessionEmpty(pane); return; }
  pane.nodataEl.classList.add('hidden');
  applyPane(pane, compact);
  setTimeout(() => {
    try {
      const n = pane.barTimes.length;
      if (n > 150) pane.chart.timeScale().setVisibleLogicalRange({ from: n - 150, to: n + 10 });
      else pane.chart.timeScale().fitContent();
    } catch (e) {}
  }, 0);
  Manager.updateLegend(pane, null);
}

function blockTicks() {
  for (const pane of App.panes) if (!pane.replay) pane.replay = {};
}

/* ---------- public API ---------- */

SessionRange.apply = function (cfg) {
  if (!App.feed || !App.feed.connected) { UI.toast('Custom Session: not connected', 'warn'); return; }
  cfg = cfg || {};
  /* round 87: minutes join the hours (cfg.mFrom/mTo, undefined -> 0 so the
     round-86 persisted configs behave exactly as before). The window is
     validated in SECONDS — 00:00–00:30 is a legitimate narrow window. */
  const hFrom = Math.max(0, Math.min(23, cfg.hFrom | 0));
  const hTo = Math.max(0, Math.min(24, cfg.hTo | 0));
  const mFrom = Math.max(0, Math.min(59, (cfg.mFrom == null ? 0 : cfg.mFrom) | 0));
  const mTo = Math.max(0, Math.min(59, (cfg.mTo == null ? 0 : cfg.mTo) | 0));
  const w = windowSec(hFrom, hTo, mFrom, mTo);
  if (!(w.sTo > w.sFrom)) { UI.toast('Custom Session: the end time must be after the start time', 'warn'); return; }
  const dFrom = cfg.dFrom | 0, dTo = cfg.dTo | 0;
  if (!(dTo >= dFrom)) { UI.toast('Custom Session: the end date must be after the start date', 'warn'); return; }
  if (dTo - dFrom > 400) { UI.toast('Custom Session: range too long (max ~400 days)', 'warn'); return; }
  const norm = { hFrom, hTo, mFrom, mTo, dFrom, dTo };
  S.cfg = norm;
  try { U.lsSet(K_CFG, norm); } catch (e) {}
  if (Replay.isActive()) Replay.stop();     // replay re-anchors on the stitched bars
  S.on = true;
  const btn = document.getElementById('session-btn');
  if (btn) btn.classList.add('active');
  const days = dTo - dFrom + 1;
  UI.toast('Custom Session ON — ' + hhmm(hFrom, mFrom) + '–' + hhmm(hTo, mTo) +
    ' × ' + days + ' day(s), gap ' + GAP_BARS + ' bars…', 'ok');
  (async () => {
    const syms = Array.from(new Set(App.panes.map((p) => p.symbol)));
    for (const sym of syms) {
      try { await ensureBase(sym); } catch (e) {}
      if (!S.on) return;   // cleared while loading
    }
    for (const pane of App.panes.slice()) {
      try { loadPane(pane); } catch (e) {}
      if (!S.on) return;
    }
  })();
};

SessionRange.clear = function () {
  if (!S.on) return;
  S.on = false;
  if (Replay.isActive()) Replay.stop();
  for (const pane of App.panes) { pane.replay = null; pane._olderDone = false; pane._sessWithGapTimes = null; pane._sessGapIdx = null; }
  for (const pane of App.panes) { try { Manager.loadBars(pane); } catch (e) {} }
  const btn = document.getElementById('session-btn');
  if (btn) btn.classList.remove('active');
  UI.toast('Custom Session off — live history restored', 'ok');
};

/* exposed for the demo-broker + tests + the merged Go-to-Date dialog */
SessionRange.baseInfo = function (symbol) {
  const c = S.cache[symbol];
  return c && c.bars ? { base: c.base, bars: c.bars.length, dry: !!c.dry } : null;
};
SessionRange.pickBase = function (days) { return pickBase(days); };
/* round 87 — Pine/indicator integration seam (read by pine-ui + the render
   adapter; no import cycles because everything rides on App.sessionHook) */
SessionRange.windowSec = function () {
  return S.on && S.cfg ? windowSec(S.cfg.hFrom, S.cfg.hTo, S.cfg.mFrom, S.cfg.mTo) : null;
};
/* the M1 feed for request.security_lower_tf on session charts: the base
   cache IS full-resolution M1 whenever the ladder picked M1 — far better
   than the live-tail M1 cache for historical ranges. Bars are FULL days;
   pine-ui filters them to the window while slicing intrabars. */
SessionRange.m1Source = function (symbol) {
  const c = S.cache[symbol];
  return (S.on && c && c.bars && c.base === 'M1') ? c.bars : null;
};
/* e2e: whitespace rows inserted by the last setSeriesWithGaps (the vendor
   LWC's series.data() hides whitespace rows, so they cannot be counted there) */
SessionRange.lastGaps = function () { return S.lastGaps; };

/* The Custom Session dialog moved INSIDE the Go to Date dialog (second tab)
   in ROUND86B per the user request ("رو توی بخش Go to Date اجرا نکردی") —
   panels/gotodate.js renders the form and re-assigns SessionRange.openDialog
   in GoToDate.init. The toolbar clock button and this module keep working
   unchanged because they call SessionRange.openDialog() late-bound. */

/* ---------- init ---------- */

SessionRange.init = function () {
  const btn = document.getElementById('session-btn');
  if (btn && !btn.dataset.rttWired) {
    btn.dataset.rttWired = '1';
    btn.innerHTML = icon('clock');
    btn.title = 'Custom Session — stitch a daily hour window across a date range';
    btn.addEventListener('click', () => SessionRange.openDialog());
  }
  /* the hook Manager.loadBars / loadOlder / panels/replay.js consult */
  App.sessionHook = {
    active: () => S.on,
    loadPane: (pane) => { loadPane(pane); },
    applySeries,
    blockTicks,
    /* round 87 — indicator support inside Custom Session: */
    windowSec: () => SessionRange.windowSec(),
    m1Source: (symbol) => SessionRange.m1Source(symbol),
    /* ROUND90 — cfg accessor for the engine's time-axis rebuild key (the
       axis must re-cut when the window/dates change; engine.js must not
       import session.js, so it rides the hook like the rest) */
    cfg: () => SessionRange.cfg(),
    /* round 88 — the chart-tz shift for the window filter + drawing clamp,
       and the tz-switch rebuild (Manager.applyTimezone hook) */
    shift: () => SessionRange.shift(),
    onTzChange: () => {
      if (!S.on || !S.cfg) return;
      S.shiftKey = '';                 // force a rebuild on next shift()
      const syms = Array.from(new Set(App.panes.map((p) => p.symbol)));
      (async () => {
        for (const sym of syms) {
          try { await ensureBase(sym); } catch (e) {}   // cache key changed -> refetch
          if (!S.on) return;
        }
        for (const pane of App.panes.slice()) {
          try { loadPane(pane); } catch (e) {}
          if (!S.on) return;
        }
      })();
    },
  };
  try { const c = U.lsGet(K_CFG, null); if (c && isFinite(c.hFrom)) S.cfg = c; } catch (e) {}
};

export { SessionRange };
