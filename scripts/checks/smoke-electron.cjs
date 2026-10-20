/**
 * Electron smoke harness (driven by scripts/checks/smoke-boot.mjs).
 *
 * Loads the renderer URL in a hidden BrowserWindow, logs in to the demo
 * provider, and asserts the shell really booted:
 *   #app visible, #login-screen hidden, at least one <canvas>, zero console
 *   errors, zero failed HTTP requests.
 *
 * Prints one machine-readable line (`SMOKE_RESULT={...}`) and exits
 * 0 = pass, 1 = assertion failure, 2 = harness/boot failure.
 */
'use strict';
const fs = require('fs');
const { app, BrowserWindow, session } = require('electron');

app.disableHardwareAcceleration();

const TARGET = process.env.SMOKE_URL;
const SHOT = process.env.SMOKE_OUT;
const errors = [];
const failedRequests = [];

function emit(result) {
  console.log('SMOKE_RESULT=' + JSON.stringify(result));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function readState(win) {
  return JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
    appVisible: !!document.getElementById('app') && !document.getElementById('app').classList.contains('hidden'),
    loginHidden: !!document.getElementById('login-screen') && document.getElementById('login-screen').classList.contains('hidden'),
    canvases: document.querySelectorAll('canvas').length,
    bars: (window.__app && window.__app.App && window.__app.App.panes[0] && window.__app.App.panes[0].bars)
      ? window.__app.App.panes[0].bars.length : 0,
    connLabel: (document.getElementById('conn-label') || {}).textContent || ''
  })`));
}

app.whenReady().then(async () => {
  let win = null;
  try {
    if (!TARGET) throw new Error('SMOKE_URL is not set');

    session.defaultSession.webRequest.onCompleted((d) => {
      if (d.statusCode >= 400) failedRequests.push({ url: d.url, status: d.statusCode });
    });

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
    await sleep(1500);

    const clicked = await win.webContents.executeJavaScript(`(() => {
      const demo = document.getElementById('card-demo');
      const connect = document.getElementById('login-connect');
      if (!demo || !connect) return false;
      demo.click();
      connect.click();
      return true;
    })()`);
    if (!clicked) errors.push('login controls (#card-demo / #login-connect) not found');

    let state = { appVisible: false, loginHidden: false, canvases: 0, bars: 0 };
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await sleep(500);
      try {
        state = await readState(win);
      } catch (e) {
        /* navigation/renderer not ready yet */
      }
      if (state.appVisible && state.loginHidden && state.canvases > 0 && state.bars > 0) break;
    }
    await sleep(1500);
    try { state = await readState(win); } catch (e) { /* keep last state */ }

    if (SHOT) {
      try {
        const png = await win.webContents.capturePage();
        fs.writeFileSync(SHOT, png.toPNG());
      } catch (e) {
        errors.push('screenshot failed: ' + (e.message || e));
      }
    }

    const ok = state.appVisible && state.loginHidden && state.canvases > 0 && state.bars > 0 &&
      errors.length === 0 && failedRequests.length === 0;
    emit({ ok, ...state, errors, failedRequests });
    app.exit(ok ? 0 : 1);
  } catch (err) {
    emit({ ok: false, error: String((err && err.stack) || err), errors, failedRequests });
    app.exit(2);
  }
});
