/**
 * Pine instance manager — panel concern.
 *
 * Moved verbatim out of chart/pine-ui.js in F4.3 (no logic changes).
 *
 * @module chart/pine-ui/panel
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
import { buildIntrabars, compiledFor, ensureLowerBars, ensureM1Cache, htfSpec, lowerCacheFresh, lowerRunFor, patchLowerForming, refreshLastIntrabar, resolveDeclTf, rtMap, runBarsFor, state } from './data.js';
import { applyInstanceStyle, effServerOffSec, fetchXSym, hookXSymTicks, loadDefaultStyle, refreshXSymTicks, scanXSymPairs, tfIdForSec } from './inputs.js';
import { PineUI, framePane } from './runtime.js';
import { _tickAt, _tickEvery } from './shared.js';
import { openSettingsDialog } from './templates.js';

/* ------------------------------ instance lifecycle -------------------- */

/**
 * One full (re)build of a script instance: compile -> runtime -> adapter ->
 * history run. Async because of the M1 fetch; safe to call repeatedly.
 */
async function rebuild(pane, inst, opts) {
  opts = opts || {};
  const script = PineScriptsStore.get(inst.scriptId);
  const map = rtMap(pane);
  const prev = map.get(inst.id);
  if (!script) {
    if (prev && prev.adapter) prev.adapter.detach();
    map.delete(inst.id);
    renderRows(pane);
    return;
  }
  const c = compiledFor(script);
  /* ROUND226 (TV parity): declaration timeframe= defaults the run TF.
     Resolved here (before st/htf/env.tfSec all derive from htfSpec). */
  try {
    inst._declTimeframe = (c.ok && c.meta && c.meta.timeframe) ? resolveDeclTf(pane, c.meta.timeframe) : '';
    if (c.ok && c.meta && c.meta.timeframe && !inst._declTimeframe && Log) {
      Log.debug('pine', 'forward-compat: ' + (script.name || 'script') +
        ' timeframe="' + c.meta.timeframe + '" not resolvable — chart TF',
        { script: script.name || '' });
    }
  } catch (e) { try { inst._declTimeframe = ''; } catch (e2) {} }
  /* ROUND222 (forward-compat observability): newer declaration params are
     accepted-and-ignored by declMeta (meta.ignoredParams) — one debug line
     names them so the exported log shows exactly what ran degraded
     (notably timeframe=, which runs on chart TF until R226). */
  try {
    if (c.ok && c.meta && c.meta.ignoredParams && c.meta.ignoredParams.length) {
      Log.debug('pine', 'forward-compat: ' + (script.name || 'script') +
        ' ignored declaration params [' + c.meta.ignoredParams.join(', ') + ']',
        { script: script.name || '' });
    }
    /* ROUND236 (TV parity, observability only): explicit dynamic_requests=false
       with request.* calls in local scope runs LENIENTLY here (R226 machinery)
       while TV rejects it at compile — one debug line names the count so the
       exported log shows the deviation instead of hiding it. */
    if (c.ok && c.meta && c.meta.dynamicRequests === false && (c.meta.localRequests || 0) > 0) {
      Log.debug('pine', 'dynamic_requests=false: ' + (script.name || 'script') +
        ' runs ' + c.meta.localRequests + ' local-scope request.* call(s) leniently (TV rejects)',
        { script: script.name || '' });
    }
  } catch (e) {}
  if (!c.ok) {
    if (prev && prev.adapter) prev.adapter.detach();
    map.set(inst.id, { adapter: null, rt: null, status: 'error', errors: c.errors,
      errorLine: c.errors.length ? c.errors[0].line : 0, script, scriptId: inst.scriptId });
    /* ROUND221 (user report: legend ⚠ with no findable error text): compile
       failures used to live only in st.errors, invisible to the Diagnostics
       log — the user was asked for an "errors column" that had nothing in
       it. Every error transition now lands in Log (cat 'pine') with the
       script name + first message + line, so the Diagnostics ERR filter
       finds it and the exported log carries it. */
    try {
      const f = c.errors[0] || {};
      Log.error('pine', 'compile failed: ' + (script.name || script.scriptId || 'script') +
        ': ' + (f.message || 'unknown error'),
        { script: script.name || String(script.scriptId || ''), line: f.line || 0, code: f.code || '' });
    } catch (e) {}
    renderRows(pane);
    return;
  }
  // fresh adapter + runtime every rebuild (inputs/script/pane may have changed)
  if (prev && prev.adapter) prev.adapter.detach();
  /* ROUND143: Defaults menu "Save as default" — a fresh instance with no
     explicit style inherits the saved one (explicit per-instance style wins) */
  if (!inst.style) {
    const dd = loadDefaultStyle(inst.scriptId);
    if (dd) inst.style = dd;
  }
  const adapter = new PineRenderAdapter(pane, inst);
  /* ROUND77 (BUG-76-B): running/pendingRerun serialize the lifecycle — see runFull */
  const st = { adapter, rt: null, status: 'loading', errors: [], errorLine: 0, script, scriptId: inst.scriptId,
    running: false, pendingRerun: false,
    /* ROUND80: the TF this runtime was built for — a TF switch must REBUILD
       (fresh globals + correct env.tfSec), never re-run the old runtime */
    tf: pane.tf,
    /* ROUND262: env.symbol/env.mintick are baked into the runtime at
       construction (syminfo.ticker, request.security defaults, tick math).
       Switching the chart's symbol must rebuild for the same reason a TF
       switch does; a same-length history used to hit the "fresh" fast path
       and keep running with the PREVIOUS symbol in env.symbol. */
    symbol: pane.symbol,
    /* ROUND144: the indicator timeframe this runtime was built for */
    htf: (htfSpec(pane, inst, script.source) || {}).id || '' };
  map.set(inst.id, st);
  renderRows(pane);
  if (!pane.bars.length) return; // data arrives later via Manager.recomputePine
  // input defs: dry-collect once so the settings dialog can open before data
  if (!st.inputDefs || !st.inputDefs.length) {
    const ci = c.collectInputs({
      tfSec: (App.tfById[pane.tf] || {}).sec || 60, symbol: pane.symbol,
      mintick: 0.00001, serverOffSec: effServerOffSec(inst),
    });
    if (ci.ok) st.inputDefs = ci.inputs;
  }
  const rt = c.createInstance({
    tfSec: (htfSpec(pane, inst, script.source) || {}).sec || (App.tfById[pane.tf] || {}).sec || 60,
    symbol: pane.symbol,
    mintick: 0.00001,
    serverOffSec: effServerOffSec(inst),
    inputValues: inst.inputs || {},
    /* ROUND175: dialog Properties (capital / order size / pyramiding /
       commission / slippage) override the static strategy() literals. */
    strategyProps: inst.strategyProps || null,
    slippageTicks: (inst.strategyProps && +inst.strategyProps.slippage_ticks > 0)
      ? +inst.strategyProps.slippage_ticks : 0,
    /* ROUND156: the declaration's max_bars_back finally reaches the runtime
       (it used to be parsed, clamped, then dropped — every script ran 5000) */
    maxBarsBack: (c.meta && c.meta.maxBarsBack) || undefined,
    /* ROUND216 (TV parity): live chart theme colors for chart.fg_color /
       chart.bg_color. fg comes from the rendered chart's own textColor;
       bg falls back to the theme factory default (the chart surface is
       transparent over CSS). No Theme import — avoids a manager-cycle. */
    chartFg: (() => { try { return pane.chart ? pane.chart.options().layout.textColor : null; } catch (e) { return null; } })(),
    chartBg: (typeof document !== 'undefined' && document.body && document.body.classList.contains('theme-light')) ? '#ffffff' : '#0f0f0f',
  });
  st.rt = rt;
  adapter.attach(rt);
  /* ROUND168 (phase 1a: cross-symbol history): prefetch literal
     request.security("SYM","TF",...) pairs so the engine branch finds
     env.symBars['SYM|sec'] (§12). Parallel, best-effort, skipped when the
     script only references the chart symbol.
     ROUND170 (phase 1c): subscribe for live ticks + missing-pair retry. */
  const spanSec = pane.bars.length > 1
    ? Math.max(60, pane.bars[pane.bars.length - 1].time - pane.bars[0].time) : 86400;
  const wantFor = (sec) => Math.max(100, Math.min(5000, Math.ceil(spanSec / sec) + 50));
  try {
    const pairs = scanXSymPairs(script.source, pane.symbol, pane.tf);
    /* ROUND210 probe: which cross-symbol pairs the static scan saw (ticker
       handles included) — the E2E pins prefetch without timing tricks. */
    st.lastXSymPairs = pairs.map(([s, t, sec]) => s + '|' + sec);
    if (pairs.length && pane.bars.length) {
      hookXSymTicks();
      const got = {};
      await Promise.all(pairs.map(async ([symBare, tfId, sec]) => {
        try { await App.feed.subscribe(symBare); } catch (e) {}
        const bl = await fetchXSym(symBare, tfId, wantFor(sec));
        if (bl) got[symBare + '|' + sec] = bl;
      }));
      if (Object.keys(got).length) rt.env.symBars = got;
    }
  } catch (e) {}
  rt.env.symBars = rt.env.symBars || null; // explicit null beats undefined for the engine branch
  refreshXSymTicks(rt);
  st.rt.missingSymBars = [];
  await runFull(pane, inst);
  /* ROUND226 (dynamic requests): fixpoint data fetch. Static prefetch
     covers literal pairs; series-driven symbols/TFs (input.symbol values,
     loop and local-scope calls, library runtimes — env is SHARED, so libs
     see fetched bars too) surface only at runtime. Throw-mode aborts at the
     first miss; then ONE NA-provisional discovery pass collects the FULL
     missing set at once (own + library runtimes, deduped); fetch all; final
     clean pass. Every full pass resets state (R87), so the provisional pass
     pollutes nothing. Cap 4 rounds; unfetchable pairs keep the loud error
     (R221 observability). */
  const clearMisses = () => {
    try {
      if (st.rt) st.rt.missingSymBars = [];
      if (st.rt && st.rt.libs) for (const [, lib] of st.rt.libs) { if (lib && lib.rt) lib.rt.missingSymBars = []; }
    } catch (e) {}
  };
  const collectMisses = () => {
    const out = [], seen = new Set();
    const grab = (rt) => {
      try {
        for (const m of (rt && rt.missingSymBars) || []) {
          if (!m || !m.sym || !m.sec) continue;
          const k = m.sym + '|' + m.sec;
          if (seen.has(k)) continue;
          seen.add(k);
          const have = st.rt && st.rt.env && st.rt.env.symBars && st.rt.env.symBars[k];
          if (have && have.length) continue;
          out.push({ sym: m.sym, sec: m.sec });
        }
      } catch (e) {}
    };
    grab(st.rt);
    try { if (st.rt && st.rt.libs) for (const [, lib] of st.rt.libs) { if (lib && lib.rt) grab(lib.rt); } } catch (e) {}
    return out;
  };
  for (let round = 0; round < 4; round++) {
    const miss = collectMisses();
    const isMissingErr = st.status === 'error' && st.errors.some((e) => /no history for/.test(e.message || ''));
    if (!isMissingErr || !miss.length) break;
    /* discovery: NA-provisional full pass learns every dynamic pair at once
       (single-pair throw-abort would need a round per pair). */
    st.rt.env.collectMissing = true;
    clearMisses();
    await runFull(pane, inst);
    st.rt.env.collectMissing = false;
    const miss2 = collectMisses();
    let fetched = false;
    for (const m of miss2) {
      const tfId = tfIdForSec(m.sec);
      if (!tfId) continue;
      try { await App.feed.subscribe(m.sym); } catch (e) {}
      const bl = await fetchXSym(m.sym, tfId, wantFor(m.sec));
      if (bl) {
        st.rt.env.symBars = st.rt.env.symBars || {};
        st.rt.env.symBars[m.sym + '|' + m.sec] = bl;
        fetched = true;
        /* ROUND226 observability: which dynamic pairs the fixpoint fed. */
        try { if (Log) Log.debug('pine', 'dynamic fetch: ' + m.sym + '|' + m.sec + ' (' + bl.length + ' bars)', { script: (script && script.name) || '' }); } catch (e) {}
      }
    }
    hookXSymTicks();
    refreshXSymTicks(st.rt);
    clearMisses();
    /* unfetched: re-run throw-mode once so the loud error (not a silent
       NA-provisional ok) is what stands. */
    await runFull(pane, inst);
    if (!fetched) break;
  }
}

async function runFull(pane, inst) {
  const st = state(pane, inst.id);
  if (!st || !st.rt) return;
  if (!pane.bars.length) return;
  /* ROUND77 (BUG-76-B): the per-tick hook used to re-enter the runtime while
     the initial chunked history pass was still yielding to the event loop —
     updateForming()/runAll() then executed the LAST bar against HALF-BUILT
     var state (786 Zones: zones not yet accumulated) and the polluted
     pre-forming snapshot outlived the real pass. The initial pass now owns
     the runtime exclusively; concurrent runFull calls re-queue once. */
  if (st.running) { st.pendingRerun = true; return; }
  st.running = true;
  /* ROUND160 (user report: adding SMC wiped every OTHER indicator until it
     finished, and its own lines visibly "grew" across the chart): the chunked
     pass yields to the event loop, and each 400-bar chunk changes barIndex +
     store.version — i.e. the paint key — so the manager loop repainted the
     PARTIAL output every chunk; the generational clear in that partial paint
     wiped the siblings whose keys hadn't changed, and their key-skip left
     them erased until the next tick. While a full pass is in flight, panes
     skip every non-forced paint; completion ends with one forced full-set
     repaint (see finally). */
  pane._pineRunning = (pane._pineRunning || 0) + 1;
  try {
    let intrabars = null;
    const needsLowerTf = st.script && st.script.source.indexOf('request.security_lower_tf') >= 0;
    /* ROUND192: strategies with use_bar_magnifier ride the same M1 cache
       (fills evaluate sub-bar ranges; uncovered bars fall back). */
    const stratPropsNow = (inst && inst.strategyProps) || null;
    const needsMagnifier = !!(st.rt && st.rt.meta && st.rt.meta.isStrategy &&
      (((st.rt.meta.strategy || {}).use_bar_magnifier === true) ||
        (stratPropsNow && stratPropsNow.use_bar_magnifier === true)));
    if (needsLowerTf || needsMagnifier) {
      const cache = await ensureM1Cache(pane, !pane._pineM1);
      if (cache && cache.bars) intrabars = buildIntrabars(pane, cache.bars);
    }
    st.rt.env.intrabars = intrabars;
    const t0 = performance.now();
    /* ROUND144: MTF — run over HTF buckets, then map visuals to chart bars.
       ROUND146: lower-TF runs over fetched lower history (async). */
    const specAll = htfSpec(pane, inst, st.script && st.script.source);
    let rb;
    if (specAll && specAll.dir === 'ltf') {
      const cache = await ensureLowerBars(pane, specAll.id);
      const lr = cache ? lowerRunFor(pane, specAll.id) : null;
      if (!lr) {
        st.status = 'error';
        st.errors = [{ code: 'MTF', message: 'lower-TF history unavailable for ' + specAll.id, line: 0 }];
        st.errorLine = 0;
        try { Log.error('pine', 'runtime error: ' + ((st.script && st.script.name) || 'script') + ': lower-TF history unavailable for ' + specAll.id, { script: (st.script && st.script.name) || '', line: 0, code: 'MTF' }); } catch (e) {}
        return;
      }
      patchLowerForming(pane, specAll.id);
      rb = { spec: specAll, bars: lr.bars, map: lr.map };
    } else {
      rb = runBarsFor(pane, inst, st.script && st.script.source);
    }
    try {
      /* ROUND221 (gate traceability for the "growth left-to-right on Add"
         report): one debug line per full pass with the in-flight gate state,
         so the exported log proves the R160 gate engaged and shows exactly
         when the single forced repaint fired. Debug level — no user noise. */
      try { Log.debug('pine', 'full pass start: ' + ((st.script && st.script.name) || 'script') + ' over ' + (rb.bars ? rb.bars.length : 0) + ' bars', { script: (st.script && st.script.name) || '' }); } catch (e) {}
      // chunked full pass: heavy scripts (786 Zones) yield to the event loop
      await st.rt.runChunked(rb.bars, 400);
      st.status = 'ok';
      st.errors = [];
      /* ROUND143+144b: style overrides mutate the RUN-frame output, so they
         must land BEFORE the chart-frame view is derived (not after). */
      applyInstanceStyle(st.rt, inst.style);
      st.rt.viewOut = rb.map ? remapOut(st.rt.out, rb.map, pane.bars.length) : null;
    } catch (e) {
      st.status = 'error';
      st.errors = [{ code: e.code || 'RE', message: e.message || String(e), line: e.line || 0 }];
      st.errorLine = e.line || 0;
      try {
        Log.error('pine', 'runtime error: ' + ((st.script && st.script.name) || 'script') + ': ' +
          (e.message || String(e)) + ' (line ' + (e.line || 0) + ')',
          { script: (st.script && st.script.name) || '', line: e.line || 0, code: e.code || 'RE', bars: st.lastRunBars || null });
      } catch (le) {}
    }
    /* ROUND78 perf: honest per-run timing — surfaces in the legend tooltip
       and Diagnostics (PineUI.debug) so the optimization work is measurable */
    st.lastRunMs = Math.round(performance.now() - t0);
    st.lastRunBars = pane.bars.length;
    st.lastRunAt = Date.now();
    /* ROUND163 (user report: "extra SMC lines that look higher-timeframe"):
       one census line per successful full pass — alive/added/GC'd drawings +
       line-span histogram + longest lines + top labels — so the next user log
       traces exact line origins (stale-swing re-cross vs anything else).
       Ticks use updateForming (not runFull), so this never spams per tick. */
    if (st.status === 'ok' && st.rt && st.rt.store) {
      try {
        const dc = drawingCensus(st.rt.store, (st.rt.env && st.rt.env.tfSec) || 60);
        if (dc.line + dc.box + dc.label > 0 && Log) {
          Log.info('pine', 'drawing census', {
            sym: pane.symbol, tf: pane.tf, script: (st.script && st.script.name) || '',
            bars: st.lastRunBars, ms: st.lastRunMs, alive: [dc.line, dc.box, dc.label],
            adds: [dc.adds.line, dc.adds.box, dc.adds.label], gced: dc.gced,
            lineBars: dc.lineBars, longest: dc.longest, labelTop: dc.labelTop,
          });
        }
      } catch (e) {}
    }
    /* ROUND 74 (BUG): the series/hlines could not exist before this first
       pass (plotsOrder was empty at attach) — build them now, then feed */
    if (st.status === 'ok' && st.adapter) st.adapter.syncStructure();
    st.adapter.refillAll();
  } finally {
    st.running = false;
    renderRows(pane);
    pane._pineRunning = Math.max(0, (pane._pineRunning || 0) - 1);
    /* ROUND184: a finished pass may have closed/opened strategy trades —
       repaint the chart trade markers (closed trades only, so ticks which
       use updateForming never need this). */
    try { if (Manager.applyPaneMarkers) Manager.applyPaneMarkers(pane); } catch (e) {}
    if (st.pendingRerun) { st.pendingRerun = false; runFull(pane, inst); }
    /* ROUND160: completion ends with one forced full-set repaint — without
       it the siblings (key-skipped through the whole run) would stay erased
       until the next tick, and the newcomer would show nothing on a quiet chart.
       Fires only when no other pass is still in flight (overlapping loads
       must not paint each other's partials). */
    else if ((pane._pineRunning || 0) === 0) { try { framePane(pane, true); } catch (e) {} }
  }
}

/** tick hook: forming-bar rollback + re-run, throttled per pane */
function onTickPane(pane) {
  const map = rtMap(pane);
  if (!map.size) return;
  const now = Date.now();
  const last = _tickAt.get(pane) || 0;
  if (now - last < _tickEvery) return;
  _tickAt.set(pane, now);
  const bars = pane.bars;
  if (!bars.length) return;
  const needsAnyM1 = Array.from(map.values()).some((st) => st.rt && st.rt.env.intrabars);
  for (const [instId, st] of map) {
    if (!st.rt || st.status === 'error') continue;
    refreshXSymTicks(st.rt); // ROUND170/phase-1c: foreign-symbol live ticks into the forming aggregate
    /* ROUND77 (BUG-76-B): never re-enter a runtime whose initial chunked
       history pass is still in flight (half-built var state + polluted
       snapshot -> dead drawing objects -> nothing on the chart) */
    if (st.running) continue;
    /* ROUND144: MTF instances tick in the HTF frame (lengths, push and
       forming all run on buckets; visuals remap to chart bars after).
       ROUND146: lower-TF instances tick on the cached lower window (patched
       forming bar, no fetch); a missing/stale cache refreshes in the
       background while this tick is skipped (never paint a wrong frame). */
    const irec0 = (pane.pineScripts || []).find((x) => x.id === instId);
    const specAll = htfSpec(pane, irec0, st.script && st.script.source);
    let rb;
    if (specAll && specAll.dir === 'ltf') {
      patchLowerForming(pane, specAll.id);
      const lr = lowerCacheFresh(pane, specAll.id) ? lowerRunFor(pane, specAll.id) : null;
      if (!lr) {
        ensureLowerBars(pane, specAll.id).then((c) => {
          if (c) { try { runFull(pane, { id: instId }); } catch (e) {} }
        }).catch(() => {});
        continue;
      }
      rb = { spec: specAll, bars: lr.bars, map: lr.map };
    } else {
      rb = runBarsFor(pane, irec0, st.script && st.script.source);
    }
    const eb = rb.bars;
    try {
      if (st.rt.env.intrabars) refreshLastIntrabar(pane, st.rt.env.intrabars, (pane._pineM1 || {}).bars);
      if (eb.length > (st.rt.totalBars || 0)) {
        // a new bar arrived since the last run
        if (eb.length - 1 === (st.rt.totalBars || 0)) {
          st.rt.pushNewBar(eb);
        } else {
          /* ROUND77 (BUG-76-C): a multi-bar gap used to run a FULL SYNCHRONOUS
             runAll() on the main thread — for heavy scripts (786 Zones) on a
             deep history that froze the renderer for tens of seconds and, when
             pages of older bars kept arriving, chained run-after-run until the
             tab crashed. Route it through the chunked runFull() instead: the
             same honest full pass, but yielding to the event loop every 400
             bars, with the BUG-76-B running-guard serializing re-entry. */
          runFull(pane, { id: instId });
        }
      } else {
        st.rt.updateForming(eb);
      }
      /* ROUND143+144b: style first (run frame), then derive the view —
         the tick feed below must see styled values. */
      const irec = (pane.pineScripts || []).find((x) => x.id === instId);
      applyInstanceStyle(st.rt, irec && irec.style);
      st.rt.viewOut = rb.map ? remapOut(st.rt.out, rb.map, bars.length) : null;
      st.status = 'ok';
    } catch (e) {
      st.status = 'error';
      st.errors = [{ code: e.code || 'RE', message: e.message || String(e), line: e.line || 0 }];
      try {
        Log.error('pine', 'tick error: ' + ((st.script && st.script.name) || 'script') + ': ' +
          (e.message || String(e)) + ' (line ' + (e.line || 0) + ')',
          { script: (st.script && st.script.name) || '', line: e.line || 0, code: e.code || 'RE' });
      } catch (le) {}
    }
  }
  if (needsAnyM1 && pane._pineM1 && Date.now() - pane._pineM1.at > 30000) ensureM1Cache(pane, true);
  // tick path: incremental last-bar series update only (never full setData)
  for (const [, st] of map) if (st.adapter && st.status === 'ok') st.adapter.updateLast();
}

/* ------------------------------ public API ---------------------------- */

function recomputePine(pane) {
  if (!pane || !pane.chart) return;
  const list = pane.pineScripts || [];
  const seen = new Set();
  for (const inst of list) {
    seen.add(inst.id);
    const st = state(pane, inst.id);
    if (!st || st.scriptId !== inst.scriptId) {
      rebuild(pane, inst);
    } else if (!pane.bars.length) {
      // data gone (symbol switch): drop the runtime until bars return
      st.adapter.detach();
      rtMap(pane).delete(inst.id);
    } else {
      /* ROUND80: a TF switch used to re-run the SAME runtime over the new
         history — `var`/series state from the previous TF leaked into the
         new pass (TV re-executes from scratch per interval) and env.tfSec
         stayed stale. A TF change now rebuilds the instance (compile is
         cached, so this is cheap); only a same-TF history reload re-runs. */
      if (st.tf !== pane.tf) { rebuild(pane, inst); }
      /* ROUND262: same rule for a SYMBOL switch — the runtime cached the old
         env.symbol (syminfo.*, request.security's default ticker, tick math)
         and a same-bar-count reload could even take the "fresh" skip below. */
      else if (st.symbol !== pane.symbol) { rebuild(pane, inst); }
      /* ROUND144: an Indicator-Timeframe edit must rebuild too (fresh
         HTF-frame globals + env.tfSec) — same rule as a chart TF switch */
      else if (((htfSpec(pane, inst, st.script && st.script.source) || {}).id || '') !== (st.htf || '')) { rebuild(pane, inst); }
      else {
        /* ROUND78 perf: rebuild()/add()/the settings-Ok path ALREADY ran a
           full pass a moment ago; recomputePine fires right after on the SAME
           data and used to repeat the entire history run back-to-back (2x the
           heavy work per add/Ok). Skip when the state is fresh and the bar
           count is unchanged — a genuine history reload changes the length. */
        const fresh = st.lastRunAt && st.lastRunBars === pane.bars.length && Date.now() - st.lastRunAt < 1500;
        if (!fresh) runFull(pane, inst); // history reloaded
      }
    }
  }
  for (const instId of Array.from(rtMap(pane).keys())) {
    if (!seen.has(instId)) {
      const st = rtMap(pane).get(instId);
      if (st && st.adapter) st.adapter.detach();
      rtMap(pane).delete(instId);
    }
  }
  renderRows(pane);
}

function add(pane, scriptId, inputs) {
  if (!pane || !scriptId) return null;
  pane.pineScripts = pane.pineScripts || [];
  const inst = { id: Date.now() + Math.floor(Math.random() * 999), scriptId, inputs: inputs || {}, visible: true };
  pane.pineScripts.push(inst);
  Manager.persistPanes();
  rebuild(pane, inst);
  return inst;
}

function remove(pane, instId) {
  pane.pineScripts = (pane.pineScripts || []).filter((i) => i.id !== instId);
  const st = state(pane, instId);
  if (st && st.adapter) st.adapter.detach();
  rtMap(pane).delete(instId);
  Manager.persistPanes();
  renderRows(pane);
  /* ROUND184: dropping a strategy drops its chart markers with it. */
  try { if (Manager.applyPaneMarkers) Manager.applyPaneMarkers(pane); } catch (e) {}
}

function toggleVisible(pane, instId) {
  const inst = (pane.pineScripts || []).find((i) => i.id === instId);
  if (!inst) return;
  inst.visible = inst.visible === false;
  const st = state(pane, instId);
  /* ROUND140: one funnel (adapter.setVisible) — native series, hlines,
     canvases and legend; the old inline loop left hlines + legend behind
     and rebuilds (TF switch) never re-applied the eye at all */
  if (st && st.adapter) st.adapter.setVisible(inst.visible !== false);
  Manager.persistPanes();
  renderRows(pane);
}

function applyVisibility(pane, inst) {
  const st = state(pane, inst.id);
  if (!st) return;
  const on = inst.visible !== false;
  for (const { s } of st.adapter.series) { try { s.applyOptions({ visible: on }); } catch (e) { Log.debug('pine', 'series visibility apply failed', e) } }
}

/* ------------------------------ legend rows --------------------------- */

function ensureRows(pane) {
  if (!pane._pineRows) pane._pineRows = U.el('div', 'ind-rows', pane.legend);
  return pane._pineRows;
}

function renderRows(pane) {
  U.clear(ensureRows(pane));
  for (const inst of pane.pineScripts || []) {
    const st = state(pane, inst.id);
    /* ROUND 74 (TV parity): a non-overlay script's row lives INSIDE its
       sub-pane header (like every built-in separate indicator since
       round 32); overlay rows stay in the chart's top legend. Same
       sub._rows wrapper + no-sub-yet fallback as indicators-ui. */
    let box = ensureRows(pane);
    if (st && st.adapter && st.adapter.sub) {
      const sub = st.adapter.sub;
      if (!sub._rows) sub._rows = U.el('div', 'ind-rows', sub.legend);
      U.clear(sub._rows);
      box = sub._rows;
    }
    const row = U.el('div', 'ind-row' + (inst.visible === false ? ' hidden-inst' : ''), box);
    row.dataset.pine = String(inst.id);
    const title = U.el('span', 'ind-title', row);
    const dotCls = (st && st.rt && st.status === 'ok') ? 'dot-ok' : (st && st.status === 'error') ? 'dot-error' : 'dot-idle';
    const label = st && st.rt ? st.rt.meta.title : (st && st.script ? st.script.name : 'Pine Script');
    title.innerHTML = `<i class="${dotCls}"></i>${U.esc(label)}` +
      (st && st.status === 'error' ? ' <span class="u-err-color">⚠</span>' : '');
    /* ROUND175: strategy instances carry a STRATEGY tag so they are never
       mistaken for plain indicators (user request — visible in the legend,
       the settings title and the tester picker). */
    try {
      const isStrat = !!(st && st.rt && st.rt.meta && st.rt.meta.isStrategy);
      if (isStrat) {
        const tag = U.el('span', 'pine-strat-tag', title);
        tag.textContent = 'STRATEGY';
        tag.title = 'Pine strategy (backtested) — not an indicator';
      }
    } catch (e) {}
    /* ROUND78 perf: expose the measured full-pass time on the row tooltip */
    if (st && st.status === 'error' && st.errors && st.errors.length) {
      /* ROUND221: the ⚠ row carries the actual error text in its tooltip
         (title property — no innerHTML), so the user can read/copy it
         without opening anything; the same text is in Diagnostics (cat
         'pine', ERR filter) via the Log.error on every error transition. */
      const fe = st.errors[0] || {};
      row.title = label + ' — ERROR: ' + (fe.message || 'unknown error') +
        (fe.line ? ' (line ' + fe.line + ')' : '') + ' — see Diagnostics (ERR filter, pine category)';
    } else if (st && st.lastRunMs != null) {
      row.title = `${label} — full pass ${st.lastRunMs}ms over ${st.lastRunBars} bars` +
        (st.rt ? ` — memo hits ${st.rt._memoHits || 0}` : '');
    }
    const vals = U.el('span', 'ind-vals', row);
    const btns = U.el('span', 'ind-btns', row);
    const eye = U.el('button', 'ind-btn', btns);
    eye.innerHTML = icon(inst.visible === false ? 'eyeoff' : 'eye');
    eye.title = 'Show / Hide';
    eye.addEventListener('click', (e) => { e.stopPropagation(); toggleVisible(pane, inst.id); });
    const gear = U.el('button', 'ind-btn', btns);
    gear.innerHTML = icon('gear');
    gear.title = 'Settings';
    gear.addEventListener('click', (e) => { e.stopPropagation(); openSettingsDialog(pane, inst); });
    const del = U.el('button', 'ind-btn ind-del', btns);
    del.innerHTML = icon('x');
    del.title = 'Remove';
    del.addEventListener('click', (e) => { e.stopPropagation(); remove(pane, inst.id); });
    row.addEventListener('click', () => openSettingsDialog(pane, inst));
    if (st && st.adapter) st.adapter.legEl = vals;
  }
  updateRowValues(pane, null);
}

function updateRowValues(pane, hoverTime) {
  for (const inst of pane.pineScripts || []) {
    const st = state(pane, inst.id);
    if (st && st.adapter) st.adapter.updateLegendValues(hoverTime);
  }
}

export { rebuild, runFull, onTickPane, recomputePine, add, remove, toggleVisible, applyVisibility, ensureRows, renderRows, updateRowValues };
