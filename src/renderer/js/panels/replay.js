/**
 * Bar Replay — global session, synchronized across ALL charts (TV logic)
 *
 * The driver chart (where replay started) defines the time step. Every chart shows
 * its own bars up to the replay cursor; its forming candle is built from real finer
 * data when available (e.g. 1m replay drives the 1H chart candle-by-candle),
 * otherwise from a smooth O→H/L→L→C intra-bar path.
 *
 * @module panels/replay
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { App } from '../../../core/state.js';
import { Manager } from '../chart/manager.js';
import { UI } from '../drawing/ui.js';

/* ROUND132 (user request): the speed ladder grew in BOTH directions —
   ultra-slow motion under 0.5x for scalping drills, more granularity in
   the familiar range, and the user picks any step directly from the new
   speed MENU (the small chevron next to the speed label) while plain
   clicks on the label still cycle, exactly as before. */
const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 8, 10, 15, 20];

  const S = {
    on: false, driver: null, dsec: 60,
    cursor: 0, startCursor: 0, frac: 0,
    playing: false, speedIdx: 0,
    build: U.lsGet('mt5_replay_build', true),
  };
  let raf = null, lastTs = 0;
  let pickPane = null;      /* ROUND132: pane holding the armed pick overlay */
  let speedMenuEl = null;   /* ROUND132: the open speed-selection popup */

  function speedIdxDefault() {
    const v = U.lsGet('mt5_replay_speed', 1);
    let i = SPEEDS.indexOf(typeof v === 'number' && isFinite(v) ? v : 1);
    if (i < 0) i = SPEEDS.indexOf(1);
    return Math.max(0, i);
  }
  S.speedIdx = speedIdxDefault();

  const Replay = {};

  Replay.isActive = function () { return S.on; };
  Replay.cursor = function () { return S.on ? S.cursor + S.frac * S.dsec : 0; };

  Replay.priceFor = function (pane) {
    if (pane._lastPartialClose != null) return pane._lastPartialClose;
    return pane.bars.length ? pane.bars[pane.bars.length - 1].close : null;
  };

  /* ROUND132 (user request — TV Bar Replay parity): arming the pick now
     turns the CHART itself into the picker. The engine paints the full
     graphic state (see Engine._drawReplayPick): a TV-blue vertical line
     under the cursor, a circled-play badge, the date pill of the bar that
     would become the replay start, and a veil over everything to the
     RIGHT of the line — the exact region a click will cut away. Clicking
     still starts the session; re-clicking the toolbar button or pressing
     Escape aborts the pick (nothing else moves until then). */
  Replay.toggle = function () {
    if (S.on) { Replay.stop(); return; }
    if (pickPane) { Replay.cancelPick(); return; }
    if (!App.activePane) return;
    const target = App.activePane;
    if (!target.bars || target.bars.length < 2) {
      UI.toast('Bar Replay needs at least two loaded bars', 'warn');
      return;
    }
    UI.toast('Bar Replay: click on the chart to set the start point', 'ok');
    pickPane = target;
    target.engine.replayPick = (x, y) => {
      pickPane = null;
      const eng = target.engine;
      const pt = eng.snap(x, y);
      const idx = U.nearestIndex(target.barTimes, pt.t);
      start(target, Math.max(1, Math.min(idx, target.bars.length - 2)));
    };
    document.getElementById('replay-btn').classList.add('active');
  };

  /* ROUND132: abort the armed pick (Escape / toolbar re-click). Returns
     true when a pick was actually armed so the key router can stop. */
  Replay.cancelPick = function () {
    if (!pickPane) return false;
    try { pickPane.engine.replayPick = null; } catch (e) {}
    pickPane = null;
    const btn = document.getElementById('replay-btn');
    if (btn) btn.classList.remove('active');
    try { Manager.markChartActivity(); } catch (e) {}
    return true;
  };

  Replay.pickArmed = function () { return !!pickPane; };

  function start(driver, idx) {
    const anchor = driver.bars[idx];
    if (!anchor) return; // empty/too-short chart: never arm a session with no start bar
    S.on = true;
    S.driver = driver;
    S.dsec = App.tfById[driver.tf].sec;
    S.cursor = anchor.time + S.dsec;   // bars up to anchor are complete
    S.startCursor = S.cursor;
    S.frac = 0;
    S.playing = false;
    S.speedIdx = speedIdxDefault();     // persisted choice, 1x on first run
    for (const p of App.panes) {
      p.replay = {};                    // blocks live ticks
      p._allBars = p.bars;
      p._shown = -1;
      p._lastPartialClose = null;
    }
    renderAll(true);
    buildBar();
    startRaf();
  }

  /* ---------- intra-bar price path (O → L → H → C bullish, O → H → L → C bearish) ---------- */
  function pathPartial(b, p) {
    const bull = b.close >= b.open;
    const pts = bull ? [b.open, b.low, b.high, b.close] : [b.open, b.high, b.low, b.close];
    const L = [Math.abs(pts[1] - pts[0]), Math.abs(pts[2] - pts[1]), Math.abs(pts[3] - pts[2])];
    const tot = L[0] + L[1] + L[2] || 1;
    let d = U.clamp(p, 0, 1) * tot;
    let price = pts[0];
    let hi = b.open, lo = b.open;
    for (let i = 0; i < 3; i++) {
      if (d <= L[i] || i === 2) {
        const f = L[i] ? d / L[i] : 1;
        price = pts[i] + (pts[i + 1] - pts[i]) * f;
        for (let j = 0; j <= i; j++) { if (pts[j] > hi) hi = pts[j]; if (pts[j] < lo) lo = pts[j]; }
        if (price > hi) hi = price;
        if (price < lo) lo = price;
        break;
      }
      d -= L[i];
    }
    return { time: b.time, open: b.open, high: hi, low: lo, close: price };
  }

  /* forming candle for a pane bucket [bs, bs+sec) at replay time `cur` */
  function partialFor(pane, bs, cur) {
    const tf = App.tfById[pane.tf];
    const p = U.clamp((cur - bs) / tf.sec, 0, 1);
    // 1) aggregate real finer data from the driver chart (same symbol, driver finer or equal)
    if (S.driver && pane !== S.driver && pane.symbol === S.driver.symbol && S.dsec <= tf.sec) {
      const dtf = App.tfById[S.driver.tf];
      const all = S.driver._allBars || [];
      let o = null, h = -Infinity, l = Infinity, c = null, vol = 0;
      // completed driver bars inside the bucket
      for (const b of all) {
        if (b.time >= bs && b.time + dtf.sec <= cur) {
          if (o == null) o = b.open;
          if (b.high > h) h = b.high;
          if (b.low < l) l = b.low;
          c = b.close;
          vol += b.volume || 0;
        }
      }
      // driver's own forming bar inside the bucket (cursor mid-bar)
      const bd = Manager.bucketStartFor(dtf, Math.floor(cur));
      if (bd >= bs && cur - bd > 0.0001) {
        const db = findBar(all, bd);
        if (db) {
          const dp = pathPartial(db, (cur - bd) / dtf.sec);
          if (o == null) o = dp.open;
          if (dp.high > h) h = dp.high;
          if (dp.low < l) l = dp.low;
          c = dp.close;
        }
      }
      if (o != null && c != null) {
        return { time: bs, open: o, high: h === -Infinity ? o : h, low: l === Infinity ? o : l, close: c, volume: vol };
      }
      // gap: no driver data in this bucket
      return null;
    }
    // 2) fallback: smooth path through the pane's own bar
    const b = findBar(pane._allBars || [], bs);
    if (!b) return null;
    return pathPartial(b, p);
  }

  function findBar(bars, t) {
    let lo = 0, hi = bars.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (bars[m].time === t) return bars[m];
      if (bars[m].time < t) lo = m + 1; else hi = m - 1;
    }
    return null;
  }

  function updatePartial(pane, partial) {
    if (!partial) return;
    const st = pane.style || 'candles';
    let pt = partial;
    if (st === 'heikin') {
      const prev = pane._haLast || { open: partial.open, close: partial.open };
      const ho = (prev.open + prev.close) / 2;
      const hc = (partial.open + partial.high + partial.low + partial.close) / 4;
      pt = { time: partial.time, open: ho, close: hc, high: Math.max(partial.high, ho, hc), low: Math.min(partial.low, ho, hc) };
    }
    pane._lastPartialClose = pt.close;
    let d;
    if (st === 'line' || st === 'step' || st === 'linemarkers' || st === 'baseline' || st === 'area') {
      d = { time: pt.time, value: pt.close };
    } else {
      d = { time: pt.time, open: pt.open, high: pt.high, low: pt.low, close: pt.close };
    }
    try { pane.series.update(d); } catch (e) {}
  }

  /* ---------- rendering the whole session ---------- */
  function renderAll(force, cur) {
    if (!S.on) return;
    cur = cur != null ? cur : S.cursor;
    for (const pane of App.panes) {
      if (!pane._allBars) continue;
      const tf = App.tfById[pane.tf];
      const all = pane._allBars;
      const cut = cur - tf.sec;   // completed: time <= cut
      let lo = 0, hi = all.length - 1, li = -1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (all[m].time <= cut) { li = m; lo = m + 1; } else hi = m - 1;
      }
      const n = li + 1;
      if (force || n !== pane._shown) {
        pane._shown = n;
        pane.bars = all.slice(0, n);
        Manager.setPaneData(pane, pane.bars);
        Manager.recomputeIndicators(pane); // round 27: indicators follow the replay cut
        /* ROUND86: Custom Session re-inserts the day-gap whitespace rows
           into the series after the slice setData (pane.bars stays compact) */
        if (App.sessionHook && App.sessionHook.active()) { try { App.sessionHook.applySeries(pane); } catch (e) {} }
      }
      if ((pane.style || 'candles') !== 'renko') {
        const bs = Manager.bucketStartFor(tf, Math.floor(cur));
        if (bs > cut && cur - bs >= 0) {
          const partial = partialFor(pane, bs, cur);
          if (partial) updatePartial(pane, partial);
          else pane._lastPartialClose = null;
        }
      }
      if (pane === App.activePane) Manager.updateLegend(pane, null);
    }
    Manager.updateCountdowns();
    updateInfo();
  }

  /* ---------- playback loop ---------- */
  function startRaf() {
    if (raf) return;
    lastTs = 0;
    const tick = (ts) => {
      if (!S.on) { raf = null; return; }
      raf = requestAnimationFrame(tick);
      if (!lastTs) { lastTs = ts; return; }
      const dt = Math.min(200, ts - lastTs);
      lastTs = ts;
      /* ROUND86: the replay demo-broker (trade/replaytrade.js) evaluates on
         every frame — paused included, so the step buttons re-price the
         demo positions/orders immediately */
      if (App.replayTradeHook) { try { App.replayTradeHook.onFrame(); } catch (e) {} }
      if (!S.playing) return;
      const barMs = 1000 / SPEEDS[S.speedIdx];
      S.frac += dt / barMs;
      let stepped = false;
      while (S.frac >= 1) { S.frac -= 1; S.cursor += S.dsec; stepped = true; }
      if (atEnd()) { S.playing = false; renderBar(); renderAll(false); return; }
      if (S.build) renderAll(false, S.cursor + S.frac * S.dsec);
      else if (stepped) renderAll(false, S.cursor);
    };
    raf = requestAnimationFrame(tick);
  }

  function lastDriverTime() {
    const all = S.driver && S.driver._allBars;
    return all && all.length ? all[all.length - 1].time : 0;
  }
  function atEnd() {
    return S.cursor >= lastDriverTime() + S.dsec;
  }

  /* ---------- replay control bar ---------- */
  function buildBar() {
    const bar = document.getElementById('replay-bar');
    U.clear(bar);
    bar.classList.remove('hidden');
    const mk = (id, ic, title, fn) => {
      const b = U.el('button', 'rp-btn', bar);
      b.id = id;
      b.innerHTML = icon(ic);
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    mk('rp-start', 'jumpstart', 'Jump to start', () => {
      if (!S.on) return;
      S.cursor = S.startCursor; S.frac = 0;
      renderAll(true); renderBar();
    });
    mk('rp-back', 'stepback', 'Step back', () => {
      if (!S.on || S.cursor <= S.startCursor) return;
      pause();
      S.cursor = Math.max(S.startCursor, S.cursor - S.dsec); S.frac = 0;
      renderAll(true); renderBar();
    });
    mk('rp-play', 'play', 'Play / Pause', () => {
      if (!S.on) return;
      if (S.playing) pause();
      else { if (atEnd()) { S.cursor = S.startCursor; S.frac = 0; renderAll(true); } S.playing = true; lastTs = 0; }
      renderBar();
    });
    mk('rp-fwd', 'stepfwd', 'Step forward', () => {
      if (!S.on) return;
      pause();
      if (!atEnd()) { S.cursor += S.dsec; S.frac = 0; renderAll(false); }
      renderBar();
    });
    const buildBtn = mk('rp-build', 'candles', 'Build candles smoothly (intra-bar formation)', () => {
      S.build = !S.build;
      U.lsSet('mt5_replay_build', S.build);
      renderAll(true); renderBar();
    });
    buildBtn.classList.toggle('on', S.build);
    /* ROUND132 (user request): the speed control is a SPLIT button now —
       the label keeps the click-to-cycle behaviour, the chevron beside it
       opens a small menu where any speed (0.1x … 20x) can be picked
       directly. Same state, two ways to reach it. */
    const speedWrap = U.el('div', 'rp-speed-wrap', bar);
    const speed = U.el('button', 'rp-speed', speedWrap);
    speed.id = 'rp-speed';
    speed.title = 'Replay speed — click to cycle, chevron for the full list';
    speed.addEventListener('click', () => {
      S.speedIdx = (S.speedIdx + 1) % SPEEDS.length;
      U.lsSet('mt5_replay_speed', SPEEDS[S.speedIdx]);
      lastTs = 0;
      renderBar();
    });
    const speedMenuBtn = U.el('button', 'rp-speed-menu', speedWrap);
    speedMenuBtn.id = 'rp-speed-menu';
    speedMenuBtn.innerHTML = icon('chevdown');
    speedMenuBtn.title = 'Choose replay speed';
    speedMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (speedMenuEl) closeSpeedMenu();
      else openSpeedMenu(speedMenuBtn);
    });
    U.el('span', 'rp-sep', bar);
    const info = U.el('span', 'rp-info', bar);
    info.id = 'rp-info';
    mk('rp-stop', 'x', 'Exit replay', () => Replay.stop());
    renderBar();
  }

  function pause() { S.playing = false; }

  /* ---------- ROUND132: the speed-selection popup ---------- */
  function closeSpeedMenu() {
    if (speedMenuEl) { speedMenuEl.remove(); speedMenuEl = null; }
  }

  function openSpeedMenu(anchor) {
    closeSpeedMenu();
    const r = anchor.getBoundingClientRect();
    const p = U.el('div', 'popup rp-menu', document.body);
    U.el('div', 'rpm-title', p).textContent = 'Replay speed';
    const grid = U.el('div', 'rpm-grid', p);
    SPEEDS.forEach((s, i) => {
      const b = U.el('button', 'rpm-item' + (i === S.speedIdx ? ' on' : ''), grid);
      b.textContent = s + 'x';
      b.title = s < 1 ? 'Slow motion' : (s > 5 ? 'Fast forward' : 'Normal range');
      b.addEventListener('click', () => {
        S.speedIdx = i;
        U.lsSet('mt5_replay_speed', SPEEDS[i]);
        lastTs = 0;
        renderBar();
        closeSpeedMenu();
      });
    });
    document.body.appendChild(p);
    const vw = p.offsetWidth, vh = p.offsetHeight;
    p.style.left = Math.round(U.clamp(r.left + r.width / 2 - vw / 2, 6, window.innerWidth - vw - 6)) + 'px';
    p.style.top = Math.round(Math.max(6, r.top - vh - 8)) + 'px';
    speedMenuEl = p;
    setTimeout(() => {
      const off = (e) => {
        if (speedMenuEl && !speedMenuEl.contains(e.target)) { closeSpeedMenu(); document.removeEventListener('mousedown', off); }
      };
      document.addEventListener('mousedown', off);
    }, 0);
  }

  function renderBar() {
    if (!S.on) return;
    const playBtn = document.getElementById('rp-play');
    if (playBtn) {
      playBtn.innerHTML = icon(S.playing ? 'pause' : 'play');
      playBtn.classList.toggle('on', S.playing);
    }
    const buildBtn = document.getElementById('rp-build');
    if (buildBtn) buildBtn.classList.toggle('on', S.build);
    const speedBtn = document.getElementById('rp-speed');
    if (speedBtn) speedBtn.textContent = SPEEDS[S.speedIdx] + 'x';
    /* keep the popup's active marker in sync while it is open (cycle clicks) */
    if (speedMenuEl) {
      speedMenuEl.querySelectorAll('.rpm-item').forEach((el, i) => el.classList.toggle('on', i === S.speedIdx));
    }
    updateInfo();
  }

  function updateInfo() {
    const info = document.getElementById('rp-info');
    if (!info || !S.on || !S.driver) return;
    const all = S.driver._allBars || [];
    const cut = S.cursor - S.dsec;
    let lo = 0, hi = all.length - 1, li = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (all[m].time <= cut) { li = m; lo = m + 1; } else hi = m - 1;
    }
    const tfLabel = App.tfById[S.driver.tf].label;
    info.textContent =
      `Replay ${Math.max(0, li + 1)}/${all.length} · ${tfLabel} driver · all charts synced` +
      (S.build ? ' · building' : '');
  }

  /* ROUND86 (tests / Go to Date): programmatic start on a pane */
  Replay.startAt = function (pane, idx) {
    if (!pane || !pane.bars || pane.bars.length < 3) return false;
    const i = Math.max(1, Math.min(idx == null ? pane.bars.length - 2 : idx, pane.bars.length - 2));
    start(pane, i);
    return true;
  };

  /* ROUND86 (Go to Date): re-anchor the replay cursor on the first bar at
     or after `t` — works over normal AND Custom Session stitched bars (a
     day without candles simply lands on the next one that has them) */
  Replay.jumpTo = function (t) {
    if (!S.on || !S.driver) return false;
    const all = S.driver._allBars || [];
    if (!all.length) return false;
    let lo = 0, hi = all.length - 1, idx = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (all[m].time >= t) { idx = m; hi = m - 1; } else lo = m + 1;
    }
    const b = idx >= 0 ? all[idx] : all[all.length - 1];
    pause();
    S.cursor = b.time + S.dsec;
    S.startCursor = S.cursor;
    S.frac = 0;
    renderAll(true); renderBar();
    return true;
  };

  Replay.stop = function () {
    if (pickPane) Replay.cancelPick(); // a stop during the armed pick must clear the overlay too
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    closeSpeedMenu();
    S.on = false; S.playing = false;
    for (const p of App.panes) {
      if (p._allBars) {
        p.bars = p._allBars;
        p._allBars = null;
      }
      p.replay = null;
      p._shown = p.bars.length;
      p._lastPartialClose = null;
      try { Manager.setPaneData(p, p.bars); } catch (e) {}
      /* ROUND264: the session recomputed indicators on the CUT history on
         every step (renderAll). Restoring the full bars without recomputing
         left every overlay/sub-pane showing only the replay window until a
         live tick happened to arrive (a quiet symbol stayed wrong forever).
         Recompute both engines on the restored history here. */
      try { Manager.recomputeIndicators(p); } catch (e) {}
      try { Manager.recomputePine(p); } catch (e) {}
    }
    /* ROUND86: after replay ends, keep the Custom Session day-gaps in the
       series AND keep blocking live ticks (the stitched view is historical) */
    if (App.sessionHook && App.sessionHook.active()) {
      for (const p of App.panes) {
        try { App.sessionHook.applySeries(p); } catch (e) {}
        if (!p.replay) p.replay = {};
      }
    }
    S.driver = null;
    document.getElementById('replay-bar').classList.add('hidden');
    document.getElementById('replay-btn').classList.remove('active');
  };

export { Replay };
