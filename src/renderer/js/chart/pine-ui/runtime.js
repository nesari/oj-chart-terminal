/**
 * Pine instance manager — runtime concern.
 *
 * Moved verbatim out of chart/pine-ui.js in F4.3 (no logic changes).
 *
 * @module chart/pine-ui/runtime
 */
import { U } from '../../core/util.js';
import { icon } from '../../ui/icons.js';
import { App } from '../../../../core/state.js';
import { Log } from '../../../../core/logger.js';
import { Manager } from '../manager.js';
import { compile } from '../../../../core/pine/compile.js';
import { toColor } from '../../../../core/pine/types.js';
import { drawingCensus } from '../../../../core/pine/stdlib/objects.js';
import { brokerStats, downsample, tradeMarkers } from '../../../../core/pine/stdlib/strategy.js';
import { buildHtfBars, remapOut, lowerWindowForChart } from '../../../../core/pine/mtf.js';
import { tfSeconds } from '../../../../core/pine/stdlib/request.js';
import { PineRenderAdapter } from '../pine-render-adapter.js';
import { PineScriptsStore } from '../../panels/pine-scripts-store.js';
import { LWC, RT } from './shared.js';
import { add, onTickPane, rebuild, recomputePine, remove, runFull, toggleVisible, updateRowValues } from './panel.js';
import { ensureM1Cache, state } from './data.js';
import { openSettingsDialog } from './templates.js';

/* ------------------------------ pane teardown ------------------------- */

function dropPane(pane) {
  const map = RT.get(pane);
  if (map) {
    for (const [, st] of map) { try { if (st.adapter) st.adapter.detach(); } catch (e) {} }
    RT.delete(pane);
  }
}

/** per-frame canvas repaint hook (manager loop) */
function framePane(pane, force) {
  const map = RT.get(pane);
  if (!map || !map.size) return;
  /* ROUND141: one generation per full paint cycle — the first painter of
     each shared canvas clears it, siblings overpaint (see adapter). */
  pane._pineGen = (pane._pineGen || 0) + 1;
  for (const [, st] of map) { try { if (st.adapter && st.rt) st.adapter.frame(force); } catch (e) {} }
}

/* ROUND140 (user report: lines still float on VERTICAL drags): a vertical
   pan/zoom changes only the price scale — no time-range event fires, so the
   ROUND139 settle never runs and the overlay paints from the persistent
   loop BEFORE LWC's redraw (stale y) for the whole gesture. The manager
   loop calls this while a gesture is active; each adapter's coalesced
   post-LWC paint then converges it the same frame. */
function settlePane(pane) {
  const map = RT.get(pane);
  if (!map || !map.size) return;
  for (const [, st] of map) { try { if (st.adapter && st.rt) st.adapter._settlePaint(); } catch (e) {} }
}

function updateHover(pane, hoverTime) { updateRowValues(pane, hoverTime); }

/* ROUND80 (perf on TF switch): the lower-TF (M1) fetch used to START only
   after the new timeframe's own history had fully arrived (runFull awaits
   ensureM1Cache before the first bar runs) — two serial network round-trips
   per switch. The manager now fires this at the START of loadBars so both
   fetches overlap; the runFull-time call then hits a warm cache. */
async function prefetchM1(pane) {
  if (!pane || !pane.pineScripts || !pane.pineScripts.length) return;
  const needs = pane.pineScripts.some((i) => {
    const sc = PineScriptsStore.get(i.scriptId);
    return !!(sc && sc.source && (sc.source.indexOf('request.security_lower_tf') >= 0 ||
      /* ROUND192: warm the M1 cache early for magnifier strategies too. */
      sc.source.indexOf('use_bar_magnifier') >= 0));
  });
  if (needs) await ensureM1Cache(pane, false);
}

const PineUI = {
  add, remove, recomputePine, rebuild, onTickPane, dropPane, framePane, settlePane, updateHover,
  toggleVisible, openSettingsDialog, prefetchM1,
  /** diagnostics/tests: read per-pane instance states without touching them */
  debug(pane) {
    const map = RT.get(pane);
    if (!map) return [];
    return Array.from(map.values()).map((st) => ({
      status: st.status,
      errors: st.errors,
      rt: st.rt || null, /* ROUND77 probe: live runtime for diagnostics */
      adapter: st.adapter || null, /* ROUND87 probe: clamp/_xOf/canvas access for the drawing tests */
      inputDefs: st.inputDefs || null, /* ROUND87: settings ids for test overrides */
      boxes: st.rt ? st.rt.store.count('box') : 0,
      lines: st.rt ? st.rt.store.count('line') : 0,
      labels: st.rt ? st.rt.store.count('label') : 0,
      plots: st.rt ? st.rt.out.plots.size : 0,
      bars: st.rt ? st.rt.totalBars : 0,
      /* ROUND78 perf/timezone observability */
      lastRunMs: st.lastRunMs != null ? st.lastRunMs : -1,
      memoHits: st.rt ? (st.rt._memoHits || 0) : 0,
      serverOffSec: st.rt && st.rt.env ? (st.rt.env.serverOffSec || 0) : null,
      intrabars: st.rt && st.rt.env.intrabars ? st.rt.env.intrabars.filter(Boolean).length : 0,
      intrabarBars: st.rt && st.rt.env.intrabars ? st.rt.env.intrabars.reduce((a, b) => a + (b ? b.length : 0), 0) : 0,
      zoneFormed: (function () {
        if (!st.rt) return -1;
        const rec = st.rt.globals.get('zoneFormed');
        return rec && rec.value && rec.value.items ? rec.value.items.filter((v) => v === true).length : -1;
      })(),
      gced: st.rt ? st.rt.store.gced : 0,
      adds: st.rt ? st.rt.store.adds : null,
      xsymPairs: st.lastXSymPairs || null, /* ROUND210 probe: static prefetch pairs */
    }));
  },
  /** snapshot for persistence (Manager.persistPanes) */
  serialize(pane) {
    return (pane.pineScripts || []).map((i) => ({
      scriptId: i.scriptId,
      inputs: (i.inputs && typeof i.inputs === 'object') ? JSON.parse(JSON.stringify(i.inputs)) : {},
      visible: i.visible !== false,
      /* ROUND78 (timezone): per-instance broker-offset override (hours) */
      ...(i.tzOffH != null && i.tzOffH !== '' ? { tzOffH: Number(i.tzOffH) } : {}),
      /* ROUND 74: sub-pane height share (pane splitter drag) persists too */
      ...(Number(i.frac) > 0 ? { frac: Number(i.frac) } : {}),
      /* ROUND143: Style-tab overrides + TF visibility + indicator timeframe */
      ...(i.style && typeof i.style === 'object' && Object.keys(i.style).length ? { style: JSON.parse(JSON.stringify(i.style)) } : {}),
      ...(i.visTF && typeof i.visTF === 'object' && Object.keys(i.visTF).length ? { visTF: Object.assign({}, i.visTF) } : {}),
      ...(i.timeframe ? { timeframe: String(i.timeframe) } : {}),
      /* ROUND263: two per-instance choices were lost across save/reload:
         - an explicit "Chart" timeframe pick (timeframe '' + _tfTouched) must
           keep beating a declaration timeframe="...";
         - strategy Properties (capital/qty/commission/slippage/margins) were
           never serialized at all, so every restart reverted the backtest to
           the declaration literals. */
      ...(i._tfTouched ? { tfTouched: true } : {}),
      ...(i.strategyProps && typeof i.strategyProps === 'object' && Object.keys(i.strategyProps).length
        ? { strategyProps: JSON.parse(JSON.stringify(i.strategyProps)) } : {}),
    }));
  },
  /** restore from a persisted pane record */
  restoreInto(pane, recs) {
    if (!Array.isArray(recs)) return;
    const store = PineScriptsStore;
    pane.pineScripts = recs
      .filter((r) => r && r.scriptId && store.get(r.scriptId))
      .map((r, k) => ({ id: Date.now() + k + Math.floor(Math.random() * 999), scriptId: String(r.scriptId),
        inputs: (r.inputs && typeof r.inputs === 'object') ? r.inputs : {}, visible: r.visible !== false,
        /* ROUND78 (timezone): restored broker-offset override */
        ...(r.tzOffH != null && isFinite(Number(r.tzOffH)) ? { tzOffH: Number(r.tzOffH) } : {}),
        /* ROUND 74: restored sub-pane height share */
        ...(Number(r.frac) > 0 ? { frac: Number(r.frac) } : {}),
        /* ROUND143: restored style overrides + visibility + timeframe */
        ...(r.style && typeof r.style === 'object' ? { style: JSON.parse(JSON.stringify(r.style)) } : {}),
        ...(r.visTF && typeof r.visTF === 'object' ? { visTF: Object.assign({}, r.visTF) } : {}),
        ...(r.timeframe ? { timeframe: String(r.timeframe) } : {}),
        /* ROUND263: restore the explicit Chart pick + strategy Properties
           (see serialize above) */
        ...(r.tfTouched ? { _tfTouched: true } : {}),
        ...(r.strategyProps && typeof r.strategyProps === 'object'
          ? { strategyProps: JSON.parse(JSON.stringify(r.strategyProps)) } : {}),
      }));
  },

  /* ------- test/debug facade (round133 e2e): introspect the RT map ------- */
  debugRtDump() {
    const out = { panes: 0, insts: 0, withRt: 0, boxes: 0, lines: 0, labels: 0, errors: [] };
    for (const [pane, map] of RT) {
      out.panes++;
      for (const [instId, st] of map) {
        out.insts++;
        if (st.rt) {
          out.withRt++;
          try {
            out.boxes += st.rt.store.box.size; out.lines += st.rt.store.line.size;
            out.labels += st.rt.store.label.size;
            if (st.rt.store.errors && st.rt.store.errors.length) out.errors.push(...st.rt.store.errors.slice(0, 3));
          } catch (e) { out.errors.push(String(e).slice(0, 120)); }
        } else if (st.errors && st.errors.length) out.errors.push(...st.errors.slice(0, 3));
      }
    }
    return out;
  },
  /* ROUND173 (phase 2c: Strategy Tester panel): serializable backtest
     report for one instance — stats (brokerStats) + trades with wall times
     + open position. Times come from the pane bars (seconds). */
  strategyReport(pane, instId) {
    const st = state(pane, instId);
    if (!st || !st.rt || !st.rt.broker) return null;
    const b = st.rt.broker;
    const bars = pane.bars || [];
    const t = (i) => (bars[i] && bars[i].time != null ? bars[i].time : null);
    /* ROUND175: header context — backtest span + capital/currency, like the
       TV tester toolbar (date range + capital picker readout). */
    const n = bars.length;
    /* ROUND176: performance series for the tester chart — per-bar equity
       (capital + realized + open, from the broker tape) plus the TV
       buy&hold baseline (capital deployed at the first close). Capped at
       300 points so the panel never ships ten thousand DOM nodes. */
    let perf = null;
    try {
      const cap = b.cfg.capital || 0;
      const c0 = (n && bars[0] && typeof bars[0].close === 'number' && isFinite(bars[0].close)) ? bars[0].close : NaN;
      const eqRows = [], bhRows = [];
      for (let i = 0; i < n; i++) {
        const tm = bars[i] && bars[i].time;
        if (tm == null) continue;
        const e = b.equity ? b.equity[i] : NaN;
        if (typeof e === 'number' && isFinite(e)) eqRows.push({ t: tm, v: e });
        const c = bars[i] && bars[i].close;
        if (isFinite(c0) && c0 !== 0 && typeof c === 'number' && isFinite(c)) {
          bhRows.push({ t: tm, v: cap * c / c0 });
        }
      }
      if (eqRows.length > 1) perf = { capital: cap, equity: downsample(eqRows, 300), buyHold: downsample(bhRows, 300) };
    } catch (e) { perf = null; }
    /* ROUND180: position-sign strip (TV bottom long/short bar) — strided
       sample of the broker qty tape, ≤300 segments. */
    let posBar = null;
    try {
      const qt = (b.qtyTape || []);
      if (n > 1 && qt.length) {
        const stride = Math.max(1, Math.ceil(n / 300));
        const rows = [];
        for (let i = 0; i < n; i += stride) {
          if (bars[i] && bars[i].time != null) {
            const q = qt[i] || 0;
            rows.push({ t: bars[i].time, s: q > 0 ? 1 : q < 0 ? -1 : 0 });
          }
        }
        if (rows.length > 1) posBar = rows;
      }
    } catch (e) { posBar = null; }
    /* ROUND194 (Performance Summary): live open P&L (last close vs avg) and
       max held contracts per side (from the signed qty tape magnitudes). */
    let openProfit = 0, maxLong = 0, maxShort = 0;
    try {
      const qt = (b.qtyTape || []);
      for (const q of qt) {
        if (typeof q !== 'number' || !isFinite(q)) continue;
        if (q > maxLong) maxLong = q;
        if (-q > maxShort) maxShort = -q;
      }
      const last = n ? bars[n - 1] : null;
      const lc = last && last.close;
      if (b.qty !== 0 && typeof lc === 'number' && isFinite(lc)) openProfit = (lc - b.avg) * b.qty;
    } catch (e) { openProfit = 0; }
    return {
      title: (st.rt.meta && st.rt.meta.title) || 'Strategy',
      status: st.status,
      errors: (st.errors || []).slice(0, 1),
      stats: brokerStats(b),
      position: { qty: b.qty, avg: b.avg, open: b.entries.length, pending: (b.pending || []).length },
      openProfit, maxLong, maxShort,
      marginCalls: b.marginCalls || 0, // ROUND213: maintenance count for the summary row
      initialCapital: b.cfg.capital,
      currency: b.cfg.currency || 'USD',
      marginLong: b.cfg.marginLong != null ? b.cfg.marginLong : 100, // ROUND213
      marginShort: b.cfg.marginShort != null ? b.cfg.marginShort : 100, // ROUND213
      marginCalls: b.marginCalls || 0, // ROUND213: live count for the summary row
      barCount: n,
      fromTime: n ? t(0) : null,
      toTime: n ? t(n - 1) : null,
      perf,
      posBar,
      trades: (b.trades || []).map((tr, k) => Object.assign({ n: k + 1 }, tr, {
        entryTime: t(tr.entryBar), exitTime: t(tr.exitBar),
      })),
    };
  },
  /* ROUND173 (phase 2c: Strategy Tester panel): enumerate strategy
     instances across panes for the instance picker. */
  strategyInstances() {
    const out = [];
    for (const [pane, map] of RT) {
      for (const [instId, st] of map) {
        if (st && st.rt && st.rt.meta && st.rt.meta.isStrategy) {
          out.push({ pane, instId, title: st.rt.meta.title || 'Strategy', status: st.status });
        }
      }
    }
    return out;
  },
  /* ROUND184: chart trade markers for every ok strategy on the pane
     (TV entry/exit flags). The dock checkbox flips stratMarksOn; removals
     clean up by construction (dead instances contribute nothing). */
  strategyMarkers(pane) {
    if (!stratMarksOn) return [];
    const out = [];
    try {
      const bars = (pane && pane.bars) || [];
      if (!bars.length) return out;
      const timeOf = (i) => (typeof i === 'number' && bars[i] && bars[i].time != null) ? bars[i].time : null;
      const map = RT.get(pane);
      for (const [, st] of (map || new Map())) {
        if (!st || !st.rt || !st.rt.meta || !st.rt.meta.isStrategy) continue;
        if (st.status !== 'ok' || !st.rt.broker) continue;
        out.push(...tradeMarkers(st.rt.broker.trades || [], timeOf));
      }
    } catch (e) {}
    out.sort((a, b) => a.time - b.time);
    return out;
  },
  setStratMarks(on) { stratMarksOn = on !== false; },
  stratMarksOn() { return stratMarksOn; },
  initMarkers,
  /* ROUND193 (Pine Logs viewer): log.info/warning/error entries from every
     live instance — script title + wall time + level + message, oldest
     first, capped. Feeds the Diagnostics "Pine Logs" section. */
  pineLogs(maxN) {
    const out = [];
    try {
      for (const [pane, map] of RT) {
        const bars = (pane && pane.bars) || [];
        for (const [, st] of map) {
          if (!st || !st.rt || !st.rt.out || !st.rt.out.pineLogs) continue;
          const title = (st.rt.meta && st.rt.meta.title) || (st.script && st.script.name) || 'Pine Script';
          for (const l of st.rt.out.pineLogs) {
            const bt = bars[l.bar] && bars[l.bar].time != null ? bars[l.bar].time : null;
            out.push({ script: title, level: l.level, msg: l.msg, bar: l.bar, t: bt });
          }
        }
      }
    } catch (e) {}
    out.sort((a, b) => (a.t || 0) - (b.t || 0));
    const n = Math.max(1, Math.min(500, Math.floor(maxN) || 200));
    return out.slice(-n);
  },
};

/* ROUND184: strategy trade markers ride the Manager marker funnel
   (trade/dock.js pattern). Registration is LAZY via PineUI.initMarkers()
   (called from Tester.init at boot) — manager.js <-> pine-ui.js form an
   import cycle, so touching Manager at module top-level throws a TDZ
   ReferenceError and the flags silently never showed (user report). */
let stratMarksOn = true;
function initMarkers() {
  try {
    if (Manager) Manager.strategyMarkers = (pane) => PineUI.strategyMarkers(pane);
  } catch (e) { Log.debug('pine', 'marker init failed', e) }
}
export { dropPane, framePane, settlePane, updateHover, prefetchM1, PineUI, stratMarksOn, initMarkers };
