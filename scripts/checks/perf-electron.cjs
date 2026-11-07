/**
 * Electron performance harness (driven by scripts/checks/perf-profile.mjs).
 *
 * Boots the real renderer against the demo provider, then replays synthetic
 * OHLC datasets straight into the chart's public path
 * (`Manager.setPaneData` + `engine.render`) and reports wall-clock timings for
 * each stage. Nothing here changes app behaviour: it is a measurement rig, not
 * a gate.
 *
 * Prints one machine-readable line (`PERF_RESULT={...}`) and exits
 * 0 = measured, 2 = harness/boot failure.
 */
'use strict';
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

const TARGET = process.env.PERF_URL;
const SIZES = (process.env.PERF_SIZES || '5000,20000,50000')
  .split(',')
  .map((s) => Number(String(s).trim()))
  .filter((n) => Number.isFinite(n) && n >= 100);

const errors = [];
const startedAt = Date.now();

function emit(result) {
  console.log('PERF_RESULT=' + JSON.stringify(result));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function bootState(win) {
  return JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
    appVisible: !!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden'),
    loginHidden: !!document.getElementById('login-screen') && document.getElementById('login-screen').classList.contains('hidden'),
    bars: (window.__app && window.__app.App && window.__app.App.panes[0] && window.__app.App.panes[0].bars)
      ? window.__app.App.panes[0].bars.length : 0,
    series: !!(window.__app && window.__app.App && window.__app.App.panes[0] && window.__app.App.panes[0].series)
  })`));
}

function measureScript(sizes) {
  return `(async () => {
    const A = window.__app;
    const pane = A.App.panes[0];
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const BASE = Date.UTC(2024, 0, 1) / 1000;
    const makeBars = (n) => {
      const bars = new Array(n);
      let p = 20000;
      for (let i = 0; i < n; i++) {
        const o = p;
        const drift = Math.sin(i / 37) * Math.cos(i / 11) * 40 + ((i % 7) - 3) * 3;
        const c = Math.max(1, o + drift);
        const hi = Math.max(o, c) + Math.abs(Math.sin(i)) * 25;
        const lo = Math.min(o, c) - Math.abs(Math.cos(i)) * 25;
        bars[i] = {
          time: BASE + i * 60,
          open: +o.toFixed(4), high: +hi.toFixed(4), low: +lo.toFixed(4), close: +c.toFixed(4),
        };
        p = c;
      }
      return bars;
    };
    const prevStyle = pane.style;
    pane.style = 'candles';
    const rows = [];
    for (const n of ${JSON.stringify(sizes)}) {
      const bars = makeBars(n);
      let t = performance.now();
      pane.bars = bars;
      A.Manager.setPaneData(pane, bars);
      const seriesWriteMs = performance.now() - t;
      t = performance.now();
      try { pane.chart.timeScale().fitContent(); } catch (e) {}
      const fitMs = performance.now() - t;
      t = performance.now();
      /* takeScreenshot forces lightweight-charts to paint the whole chart
         synchronously — a real full repaint, not a vsync wait. */
      try { pane.chart.takeScreenshot(); } catch (e) {}
      const chartPaintMs = performance.now() - t;
      t = performance.now();
      try { pane.engine.render(); } catch (e) {}
      const overlayMs = performance.now() - t;
      t = performance.now();
      try { A.Manager.recomputeIndicators(pane); } catch (e) {}
      const indicatorsMs = performance.now() - t;
      rows.push({
        bars: n,
        seriesWriteMs: +seriesWriteMs.toFixed(1),
        fitMs: +fitMs.toFixed(1),
        chartPaintMs: +chartPaintMs.toFixed(1),
        overlayMs: +overlayMs.toFixed(1),
        indicatorsMs: +indicatorsMs.toFixed(1),
      });
    }
    /* Pan benchmark: 20 logical-range moves, one rendered frame each. */
    const PAN_STEPS = 20;
    const ts = pane.chart.timeScale();
    const total = pane.barTimes ? pane.barTimes.length : 0;
    const width = 150;
    let t = performance.now();
    for (let i = 0; i < PAN_STEPS; i++) {
      const from = Math.max(0, total - width - (PAN_STEPS - i) * 8);
      try { ts.setVisibleLogicalRange({ from, to: from + width }); } catch (e) {}
      await frame();
    }
    const panFrameMs = (performance.now() - t) / PAN_STEPS;
    const heapMB = performance.memory
      ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
    pane.style = prevStyle;
    const cv = pane.engine && pane.engine.canvas;
    return {
      rows,
      panFrameMs: +panFrameMs.toFixed(2),
      heapMB,
      dpr: window.devicePixelRatio || 1,
      canvas: cv ? [cv.clientWidth, cv.clientHeight] : null,
      visibility: document.visibilityState,
    };
  })()`;
}

app.whenReady().then(async () => {
  let win = null;
  try {
    if (!TARGET) throw new Error('PERF_URL is not set');
    win = new BrowserWindow({
      width: 1600,
      height: 900,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true },
    });
    win.webContents.on('console-message', (event, level, message) => {
      if (level >= 3) errors.push(String(message).slice(0, 300));
    });
    win.webContents.on('did-fail-load', (event, code, desc, url, isMainFrame) => {
      if (isMainFrame) errors.push('did-fail-load ' + code + ' ' + desc + ' ' + url);
    });

    await win.loadURL(TARGET);
    await sleep(1000);
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const demo = document.getElementById('card-demo');
      const connect = document.getElementById('login-connect');
      if (!demo || !connect) return false;
      demo.click();
      connect.click();
      return true;
    })()`);
    if (!clicked) throw new Error('login controls (#card-demo / #login-connect) not found');

    const deadline = Date.now() + 30000;
    let state = { appVisible: false, loginHidden: false, bars: 0, series: false };
    while (Date.now() < deadline) {
      await sleep(250);
      try { state = await bootState(win); } catch (e) { /* not ready */ }
      if (state.appVisible && state.loginHidden && state.bars > 0 && state.series) break;
    }
    if (!(state.appVisible && state.series)) {
      throw new Error('chart did not boot: ' + JSON.stringify(state));
    }
    const bootMs = Date.now() - startedAt;

    const measured = await win.webContents.executeJavaScript(measureScript(SIZES));
    emit({ ok: true, bootMs, sizes: SIZES, ...measured, errors });
    app.exit(0);
  } catch (err) {
    emit({ ok: false, error: String((err && err.stack) || err), errors });
    app.exit(2);
  }
});
