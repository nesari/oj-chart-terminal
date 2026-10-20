const { app, BrowserWindow, Menu, Notification, ipcMain, dialog, clipboard, nativeImage, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const net = require('node:net'); // Node TCP client — Electron's net module has no connect()

const PORT = 8777;
let mainWindow = null;
let providerProc = null;
let providerIdent = null; // identity of the RUNNING provider {mode, login, server}
let provErrTail = ''; // last meaningful stderr line — the REAL python error

/* ===== round 28: main-process file logger (JSONL + rotation) =====
 * Every renderer log batch and every main-process event lands in
 * userData/logs/app-YYYY-MM-DD.log. Files rotate at ~2 MB and logs older
 * than 7 days are pruned on boot. Structured enough to diff, small enough
 * to attach to a bug report. */
const LOG_DIR = () => path.join(app.getPath('userData'), 'logs');
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP_FILES = 20;
const LOG_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
let logStream = null;
let logFileCur = null;

function mlog(obj) {
  try {
    const dir = LOG_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    let file = path.join(dir, 'app-' + day + '.log');
    if (logFileCur !== file) { // date rolled (or first write)
      if (logStream) { try { logStream.end(); } catch (e) {} logStream = null; }
      logFileCur = file;
    }
    // rotate when the active file grew past the cap
    try {
      const st = fs.statSync(file);
      if (st.size > LOG_MAX_BYTES) {
        let n = 1;
        while (fs.existsSync(path.join(dir, 'app-' + day + '-' + n + '.log')) && n < 99) n++;
        file = path.join(dir, 'app-' + day + '-' + n + '.log');
        logFileCur = file;
        if (logStream) { try { logStream.end(); } catch (e) {} logStream = null; }
      }
    } catch (e) {} // stat fails -> file does not exist yet
    if (!logStream) logStream = fs.createWriteStream(file, { flags: 'a' });
    logStream.write(JSON.stringify(obj) + '\n');
  } catch (e) { /* logging must never crash the main process */ }
}

function mlogEvent(lvl, cat, msg, ctx) {
  mlog({ t: Date.now(), proc: 'main', lvl, cat, msg: String(msg).slice(0, 2000), ctx: ctx || undefined });
}

function pruneLogs() {
  try {
    const dir = LOG_DIR();
    const files = fs.readdirSync(dir).filter((f) => /^app-\d{4}-\d{2}-\d{2}.*\.log$/.test(f)).sort();
    const now = Date.now();
    for (const f of files) {
      const d = Date.parse(f.slice(4, 14) + 'T00:00:00Z');
      if (isFinite(d) && now - d > LOG_MAX_AGE_MS) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) {} }
    }
    while (files.length > LOG_KEEP_FILES) { try { fs.unlinkSync(path.join(dir, files.shift())); } catch (e) { break; } }
  } catch (e) {}
}

/* ===== round 28: IPC payload validation (security layer) =====
 * Every channel validates shape, type and SIZE before acting. Oversized or
 * malformed payloads are rejected with a security log event (IPC_BAD_PAYLOAD). */
function vStr(v, max) {
  if (typeof v !== 'string') return null;
  // strip control chars (except newline/indent-free), cap length
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return s.length > max ? s.slice(0, max) : s;
}
function badPayload(channel, detail) {
  mlogEvent('error', 'security', '[IPC_BAD_PAYLOAD] rejected on ' + channel, { detail: String(detail).slice(0, 300) });
}

function validStartProvider(p) {
  if (p == null || typeof p !== 'object' || Array.isArray(p)) { badPayload('start-provider', 'not object'); return null; }
  const out = {
    mode: p.mode === 'mt5' ? 'mt5' : 'demo',
    force: !!p.force,
    login: vStr(String(p.login == null ? '' : p.login), 32) || '',
    password: vStr(String(p.password == null ? '' : p.password), 128) || '',
    server: vStr(String(p.server == null ? '' : p.server), 128) || '',
    path: vStr(String(p.path == null ? '' : p.path), 512) || '',
  };
  if (out.mode === 'mt5' && !/^[\w .@\-]{1,32}$/.test(out.login)) { badPayload('start-provider', 'bad login'); return null; }
  return out;
}

/* ROUND123: a chart-tab record that rides the undock / dockback IPC payloads.
 * The renderer owns tab state; main only SANITIZES + ROUTES it. Shape mirrors
 * tabs.js validRec ({ id, layout, panes:[{ symbol, tf, style, indicators?,
 * pineScripts? }] }); nested indicator/pine payloads are the user's own data
 * echoed back to their own renderer, so they pass through size-capped and
 * type-checked only, with one overall JSON budget. */
function validDockRec(r) {
  if (r == null || typeof r !== 'object' || Array.isArray(r)) return null;
  try { if (JSON.stringify(r).length > 131072) { badPayload('tabs', 'rec too large'); return null; } } catch (e) { return null; }
  const id = vStr(String(r.id == null ? '' : r.id), 64) || '';
  if (!/^([\w-]+)$/.test(id)) { badPayload('tabs', 'bad rec id'); return null; }
  const layout = vStr(String(r.layout == null ? '1' : r.layout), 16) || '1';
  if (!Array.isArray(r.panes) || !r.panes.length || r.panes.length > 16) { badPayload('tabs', 'bad panes'); return null; }
  const panes = [];
  for (const pn of r.panes.slice(0, 16)) {
    if (pn == null || typeof pn !== 'object') { badPayload('tabs', 'bad pane'); return null; }
    const symbol = vStr(String(pn.symbol == null ? '' : pn.symbol), 64) || '';
    if (!symbol) { badPayload('tabs', 'bad pane symbol'); return null; }
    const out = {
      symbol,
      tf: vStr(String(pn.tf == null ? 'M1' : pn.tf), 8) || 'M1',
      style: vStr(String(pn.style == null ? 'candles' : pn.style), 16) || 'candles',
    };
    if (Array.isArray(pn.indicators) && pn.indicators.length) out.indicators = pn.indicators.slice(0, 32);
    if (Array.isArray(pn.pineScripts) && pn.pineScripts.length) out.pineScripts = pn.pineScripts.slice(0, 16);
    panes.push(out);
  }
  return { id, layout, panes };
}

function validAccounts(d) {
  if (d == null || typeof d !== 'object' || Array.isArray(d)) { badPayload('accounts-save', 'not object'); return null; }
  const out = { last: vStr(String(d.last == null ? '' : d.last), 64) || '', accounts: [] };
  if (!Array.isArray(d.accounts) || d.accounts.length > 12) { badPayload('accounts-save', 'accounts array'); return null; }
  for (const a of d.accounts) {
    if (a == null || typeof a !== 'object') { badPayload('accounts-save', 'account item'); return null; }
    out.accounts.push({
      id: vStr(String(a.id == null ? '' : a.id), 64) || '',
      mode: a.mode === 'mt5' ? 'mt5' : 'demo',
      login: vStr(String(a.login == null ? '' : a.login), 32) || '',
      server: vStr(String(a.server == null ? '' : a.server), 128) || '',
      path: vStr(String(a.path == null ? '' : a.path), 512) || '',
      label: vStr(String(a.label == null ? '' : a.label), 64) || '',
      ts: Number(a.ts) || 0,
      pw: vStr(String(a.pw == null ? '' : a.pw), 128) || '',
    });
  }
  return out;
}

function validLogBatch(entries) {
  if (!Array.isArray(entries) || entries.length > 500) { badPayload('log-batch', 'bad batch'); return null; }
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const lvl = ['debug', 'info', 'warn', 'error'].includes(e.lvl) ? e.lvl : 'info';
    const msg = vStr(String(e.msg == null ? '' : e.msg), 2000) || '';
    let ctx = e.ctx;
    if (ctx != null) {
      try { const j = JSON.stringify(ctx); if (j.length > 8000) ctx = { truncated: j.slice(0, 8000) }; } catch (er) { ctx = null; }
    }
    out.push({ t: Number(e.t) || Date.now(), seq: Number(e.seq) || 0, proc: 'renderer', lvl, cat: vStr(String(e.cat == null ? 'app' : e.cat), 24) || 'app', msg, ctx: ctx || undefined, session: vStr(String(e.session == null ? '' : e.session), 40) || undefined });
  }
  return out;
}

function hintFor(line) {
  if (/No module named ['\"]?websockets/i.test(line)) return 'Run in CMD: python -m pip install websockets';
  if (/No module named ['\"]?MetaTrader5/i.test(line) || /MetaTrader5 python package missing/i.test(line)) return 'Run in CMD: python -m pip install MetaTrader5';
  if (/No module named/i.test(line)) {
    const m = line.match(/No module named ['\"]?([A-Za-z0-9_.]+)/i);
    return m ? ('Run in CMD: python -m pip install ' + m[1]) : 'Run in CMD: python -m pip install websockets MetaTrader5';
  }
  if (/pip/i.test(line) && /install/i.test(line)) return '';
  /* AUDIT FIX: code -6 / "Authorization failed" from mt5.initialize() is
     what the terminal reports both for bad credentials AND for a broken
     connection to the broker's server (including a plain internet outage on
     the user's machine) — the SDK does not distinguish the two. The old
     generic hint ("check login/password/server") was misleading during a
     network drop, since the credentials are usually fine and the terminal
     is mid-reconnect on its own (see provider/mt5.py watch_loop). Point at
     the network/terminal-status check first; only suggest re-checking
     credentials as the fallback if that isn't it. */
  if (/\(-6,|Authorization failed/i.test(line)) return 'Check your internet connection and that the MT5 terminal is running and shows it is connected to its server (bottom-right of the terminal). If it is connected and this persists, double-check the login / password / server name.';
  if (/initialize failed|login failed/i.test(line)) return 'Check login / password / server name, or open the MT5 terminal once so it memorizes this server';
  if (/PORT_IN_USE|address already in use/i.test(line)) return 'Restart the app (an old provider is still holding the port)';
  if (/DLL load failed|WinError 126/i.test(line)) return 'Reinstall the MT5 terminal (64-bit) and Python 64-bit';
  if (/bad option|syntax ?error|invalid syntax/i.test(line)) return 'Python 3.8+ (64-bit) is required';
  return '';
}

function noteStderr(chunk) {
  // keep the last non-boilerplate stderr line (traceback frames excluded)
  for (const raw of String(chunk).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Traceback \(most recent call last\):/i.test(line)) continue;
    if (/^File ['\"]/.test(line)) continue;
    if (/connected:|listening on ws:/i.test(line)) continue; // success lines — never an error tail
    if (/^[~^\s]*\^+[~^\s]*$/.test(line)) continue;
    if (/^\s{2,}[^\s]/.test(raw) && !/[Ee]rror|missing|failed|Exception/.test(line)) continue; // frame lines like '    func()'
    provErrTail = line;
  }
}

function portOpen(port, timeout = 400) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (ok) => { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(ok); } };
    let s;
    try { s = net.connect({ port, host: '127.0.0.1' }); }
    catch (e) { resolve(false); return; }
    s.setTimeout(timeout, () => fin(false));
    s.on('connect', () => fin(true));
    s.on('error', () => fin(false));
  });
}

async function waitPort(port, attempts) {
  for (let i = 0; i < attempts; i++) {
    if (await portOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function pyExe() { return process.platform === 'win32' ? 'python' : 'python3'; }

function providerLog(msg) {
  mlogEvent(/missing|failed|[Ee]rror|No module|Traceback|exited/i.test(msg) ? 'error' : 'info', 'provider', msg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('provider-log', String(msg).slice(0, 600)); } catch (e) {}
  }
}

function stopProvider() {
  if (providerProc) {
    try { providerProc.kill(); } catch (e) {}
    providerProc = null;
  }
  providerIdent = null;
}

/* AUDIT FIX (security/hygiene): raw python stderr can contain absolute
   filesystem paths (site-packages location, the user's Windows profile
   folder, etc). Those are harmless locally but there is no reason to hand
   them to the renderer verbatim, so local Windows/Unix user-profile paths
   are collapsed to a placeholder before the string ever leaves main.js. */
function scrubPath(line) {
  return String(line)
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, 'C:\\Users\\<user>')
    .replace(/\/(home|Users)\/[^/\s]+/g, '/$1/<user>');
}

function providerErrText(code) {
  const err = scrubPath(provErrTail || '');
  const hint = hintFor(err);
  return (err ? 'Provider error: ' + err : 'Provider exited with code ' + code) + (hint ? ' — ' + hint : '');
}

async function startProvider(payload) {
  try {
    // account identity of the provider being requested — a running provider
    // may only be REUSED when it serves the SAME account/mode, otherwise a
    // stale provider of account A would silently feed account B's charts
    const want = {
      mode: (payload && payload.mode) === 'mt5' ? 'mt5' : 'demo',
      login: String((payload && payload.login) || ''),
      server: String((payload && payload.server) || ''),
    };
    if (!payload.force && await portOpen(PORT)) {
      if (providerIdent && providerIdent.mode === want.mode &&
          providerIdent.login === want.login && providerIdent.server === want.server) {
        return { ok: true, reused: true };
      }
      payload.force = true; // different account or unknown identity -> restart
    }
    stopProvider();
    if (payload.force) {
      // account switch: let the old provider release 8777 before respawn
      for (let i = 0; i < 40; i++) { if (!(await portOpen(PORT))) break; await new Promise((r) => setTimeout(r, 150)); }
    }
    const mode = want.mode;
    const script = path.join(__dirname, 'provider', mode === 'mt5' ? 'mt5.py' : 'demo.py');
    const args = [script];
    if (mode === 'mt5') {
      args.push('--login', String((payload && payload.login) || ''));
      /* ROUND104 (security): the password is NOT pushed onto argv. A running
         process' command line is world-readable on every desktop OS (ps,
         Task Manager's "Command line" column, WMI), so the broker credential
         used to be visible to any other local process for the whole session.
         It travels in the child's environment block instead, which is
         owner-only, and the provider pops it on read. */
      args.push('--server', String((payload && payload.server) || ''));
      if (payload.path) args.push('--path', String(payload.path));
    }
    // refresh rate (tick_loop poll interval) — persisted client-side and
    // passed at spawn so a provider restart doesn't silently reset it to
    // the 0.2s default. NOT network ping; see provider_common.py comment.
    if (payload && payload.tickInterval) {
      args.push('--tick-interval', String(payload.tickInterval));
    }
    const exe = pyExe();
    provErrTail = '';
    let spawnFail = null;
    let exitedCode = null;
    try {
      const childEnv = Object.assign({}, process.env);
      if (mode === 'mt5') childEnv.OJCHART_MT5_PASSWORD = String((payload && payload.password) || '');
      providerProc = spawn(exe, args, { cwd: __dirname, windowsHide: true, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return { ok: false, error: 'Python not found (' + exe + '). Install Python 3.8+ and make sure it is in PATH.' };
    }
    providerProc.on('error', (e) => { spawnFail = e.message; providerLog('Provider spawn error: ' + e.message); });
    providerProc.stderr.on('data', (d) => { noteStderr(d); providerLog(scrubPath(String(d).split('\n')[0].slice(0, 140))); });
    providerProc.stdout.on('data', (d) => {
      const s = String(d);
      noteStderr(s); // provider prints connect/package errors on stdout too
      const line = s.split('\n')[0].slice(0, 140);
      if (/missing|failed|[Ee]rror|No module|Traceback/.test(line)) providerLog(scrubPath(line));
    });
    providerProc.on('exit', (code) => {
      exitedCode = (code === null ? 0 : code);
      if (exitedCode !== 0) providerLog(providerErrText(exitedCode));
    });
    // fail fast: if the provider process dies while we wait for the port,
    // report the REAL python error immediately instead of a generic timeout
    const up = await Promise.race([
      waitPort(PORT, 140).then((ok) => (ok ? 'up' : 'timeout')), // ~20s
      new Promise((res) => {
        const iv = setInterval(() => { if (exitedCode !== null || spawnFail) { clearInterval(iv); res('exit'); } }, 120);
        setTimeout(() => clearInterval(iv), 21000);
      })
    ]);
    if (up !== 'up') {
      if (spawnFail) return { ok: false, error: 'Python not found (' + exe + '): ' + spawnFail };
      if (exitedCode !== null && exitedCode !== 0) return { ok: false, error: providerErrText(exitedCode) };
      return { ok: false, error: 'Data provider did not start. Check that Python is installed and run: pip install websockets' + (mode === 'mt5' ? ' MetaTrader5' : '') };
    }
    providerIdent = want; // remember which account this provider serves
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 920,
    /* ROUND39: user request — allow much narrower windows. Below the old
       1180px floor the top bar already scrolls via its TV chevrons
       (Toolbar.layoutTopbar), the left toolbar collapses overflow groups
       into its chevron list, and the right rail scrolls vertically. */
    minWidth: 720,
    minHeight: 680,
    /* ROUND125 (user request): TradingView-Desktop for Windows has NO native
       title bar — the tab strip IS the topmost bar and carries the window
       buttons at its right end (plus a drag surface over its empty area).
       frame:false removes the OS chrome; the integrated controls + drag
       regions are built in the renderer (tab strip / login bar). */
    frame: false,
    backgroundColor: '#131722',
    show: false,
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true, // round 28: preload only uses the electron allowlist subset
      spellcheck: false
    }
  });
  Menu.setApplicationMenu(null);
  secureWindow(mainWindow);
  const mode = process.argv.includes('--mode=mt5') ? 'mode=mt5' : 'mode=demo';
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'), { search: mode });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* round 28 security posture — shared by the main window and every detached
   (solo) window opened by tabs:undock (ROUND122); behaviour for the main
   window is byte-identical to the previous inline version */
function secureWindow(win) {
  /* ROUND101 (user report): setApplicationMenu(null) also strips Electron's
     DEFAULT "Toggle Developer Tools" accelerator (normally wired through the
     View menu) — so Ctrl+Shift+I/F12 silently did nothing. Wire it back by
     hand, independent of any menu, so DevTools can always be opened. */
  /* AUDIT FIX (security): F12 / Ctrl+Shift+I now only opens DevTools in a
     dev build. Production builds are marked by app.isPackaged (electron-builder
     sets this automatically once the app ships as a real installer); an
     unpackaged run (npm start / run-*.bat during development) still gets
     the shortcut. This removes an easy DevTools entry point for end users
     of the shipped product while keeping it for developers. */
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (app.isPackaged) return; // production: DevTools shortcut disabled
    const isToggleCombo =
      input.key === 'F12' ||
      (input.control && input.shift && (input.key === 'I' || input.key === 'i'));
    if (isToggleCombo) {
      win.webContents.toggleDevTools();
    }
  });
  /* round 28: no window may be opened from the renderer (popups, window.open,
     injected links) — everything stays inside the single app window */
  win.webContents.setWindowOpenHandler(() => {
    mlogEvent('warning', 'security', 'window.open blocked by security policy');
    return { action: 'deny' };
  });
  /* ROUND125: frameless shell — the integrated maximize button must flip
     between the maximize and restore glyphs, so every transition is pushed
     to the owning renderer (one channel, boolean payload). */
  const sendMaxState = () => { try { win.webContents.send('win:max-state', !!win.isMaximized()); } catch (e) {} };
  win.on('maximize', sendMaxState);
  win.on('unmaximize', sendMaxState);
  win.webContents.on('will-navigate', (ev, url) => {
    if (!url.startsWith('file:')) { // renderer must never wander to remote pages
      ev.preventDefault();
      mlogEvent('warning', 'security', 'navigation blocked', { url: String(url).slice(0, 200) });
    }
  });
}

ipcMain.handle('start-provider', (e, payload) => {
  const v = validStartProvider(payload);
  if (!v) return { ok: false, error: 'Invalid provider request' };
  mlogEvent('info', 'ipc', 'start-provider', { mode: v.mode, login: v.mode === 'mt5' ? v.login : undefined, server: v.server || undefined }); // NEVER log the password
  return startProvider(v);
});
ipcMain.on('stop-provider', () => { mlogEvent('info', 'ipc', 'stop-provider'); stopProvider(); });

/* ===== ROUND122 channels: chart-tab undock / dock-back (Chrome-style) =====
 * The renderer owns all tab state; main only opens / routes windows.
 *   tabs:undock        host -> open a detached window (#solo=<id>)
 *   tabs:claim         solo  -> claim the tab record main holds for it
 *                      (ROUND123: deterministic handoff — the previous
 *                      localStorage relay never crossed two LIVE renderers)
 *   tabs:dockback      solo -> ask the host window to absorb a tab
 *   tabs:dock-ack      host -> confirm absorption back to that solo window
 *   provider-identity  solo -> the RUNNING provider identity (never restarts
 *                      it from a detached window — see login.js soloAutoLogin)
 */
const soloWins = new Map();      // soloId -> BrowserWindow
const pendingSolo = new Map();   // soloId -> tab record waiting for tabs:claim

/* ROUND123: the window dock-requests are routed to. mainWindow first — but a
   solo that promoted itself to the main window (host closed, dock-back with
   no host) is a legitimate strip owner too, so fall back to any live window
   whose URL is not a solo one. */
function tabsHostWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try { if (String(w.webContents.getURL() || '').indexOf('solo=') < 0) return w; } catch (e) {}
  }
  return null;
}

ipcMain.handle('provider-identity', () => {
  return providerIdent ? Object.assign({}, providerIdent) : null;
});

ipcMain.handle('tabs:undock', (e, p) => {
  const soloId = vStr(String((p && p.soloId) == null ? '' : p.soloId), 40) || '';
  const mode = p && p.mode === 'mt5' ? 'mt5' : 'demo';
  if (!/^([\w-]+)$/.test(soloId)) { badPayload('tabs:undock', 'bad soloId'); return { ok: false, error: 'invalid payload' }; }
  if (soloWins.has(soloId)) return { ok: false, error: 'already undocked' };
  /* ROUND123: keep the handed-over tab record in memory — the new window
     claims it through tabs:claim the moment it boots (no localStorage race) */
  const rec = validDockRec(p ? p.rec : null);
  if (rec) pendingSolo.set(soloId, rec);
  const src = BrowserWindow.fromWebContents(e.sender);
  const b = (src && !src.isDestroyed()) ? src.getBounds() : { x: 60, y: 40, width: 1600, height: 920 };
  /* cascade from the source window — never trust renderer-supplied geometry */
  const n = soloWins.size;
  const w = Math.max(720, Math.round((b.width || 1600) * 0.75));
  const h = Math.max(680, Math.round((b.height || 920) * 0.75));
  let win;
  try {
    win = new BrowserWindow({
      width: w,
      height: h,
      x: (typeof b.x === 'number' ? b.x : 60) + 40 * (n + 1),
      y: (typeof b.y === 'number' ? b.y : 40) + 40 * (n + 1),
      minWidth: 720,
      minHeight: 680,
      /* ROUND125: detached windows wear the same TV-Desktop shell — no OS
         chrome, the tab strip carries the window buttons (and the drag
         surface) exactly like the host window. */
      frame: false,
      backgroundColor: '#131722',
      show: false,
      icon: APP_ICON,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
  } catch (err) {
    pendingSolo.delete(soloId);
    mlogEvent('error', 'ipc', 'tabs:undock create failed: ' + String(err && err.message || err));
    return { ok: false, error: 'create failed' };
  }
  secureWindow(win);
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'),
    { search: 'mode=' + mode, hash: 'solo=' + soloId });
  win.once('ready-to-show', () => win.show());
  soloWins.set(soloId, win);
  win.on('closed', () => { soloWins.delete(soloId); pendingSolo.delete(soloId); });
  mlogEvent('info', 'ipc', 'tabs:undock', { soloId, mode, claimed: !!rec });
  return { ok: true };
});

/* ROUND123: the detached window's FIRST call after boot — hand over the tab
 * record main has been holding since tabs:undock (single-shot; the entry is
 * consumed either way so a stale id can never claim twice). */
ipcMain.handle('tabs:claim', (e, p) => {
  const soloId = vStr(String((p && p.soloId) == null ? '' : p.soloId), 40) || '';
  if (!/^([\w-]+)$/.test(soloId)) return { ok: false };
  const rec = pendingSolo.get(soloId) || null;
  pendingSolo.delete(soloId);
  if (!rec) return { ok: false };
  mlogEvent('info', 'ipc', 'tabs:claim', { soloId });
  return { ok: true, rec };
});

ipcMain.handle('tabs:dockback', (e, p) => {
  const soloId = vStr(String((p && p.soloId) == null ? '' : p.soloId), 40) || '';
  if (!/^([\w-]+)$/.test(soloId)) { badPayload('tabs:dockback', 'bad soloId'); return { ok: false, error: 'invalid payload' }; }
  /* ROUND123: the tab record rides the request itself (validated, capped) —
     the host renderer no longer needs to read a localStorage key written by
     another LIVE renderer (that never propagated reliably in Electron and
     was the reason dock-back silently did nothing) */
  const rec = validDockRec(p ? p.rec : null);
  if (!rec) { badPayload('tabs:dockback', 'missing rec'); return { ok: false, error: 'invalid payload' }; }
  const host = tabsHostWindow();
  if (!host) {
    pendingSolo.delete(soloId);
    mlogEvent('info', 'ipc', 'tabs:dockback -> no host window', { soloId });
    return { ok: false, error: 'no-host' }; // the solo will promote itself
  }
  host.webContents.send('tabs:dock-request', { soloId, rec });
  mlogEvent('info', 'ipc', 'tabs:dockback', { soloId });
  return { ok: true };
});

ipcMain.handle('tabs:dock-ack', (e, p) => {
  const soloId = vStr(String((p && p.soloId) == null ? '' : p.soloId), 40) || '';
  if (!/^([\w-]+)$/.test(soloId)) { badPayload('tabs:dock-ack', 'bad soloId'); return { ok: false, error: 'invalid payload' }; }
  const win = soloWins.get(soloId);
  if (win && !win.isDestroyed()) {
    win.webContents.send('tabs:dock-ack', { soloId, ids: Array.isArray(p.ids) ? p.ids.slice(0, 24).map((x) => vStr(String(x == null ? '' : x), 64) || '') : [] });
  }
  return { ok: true };
});

/* ===== ROUND125 channels: frameless window controls (TV-Desktop shell) =====
 * The OS title bar is gone (frame:false on every window), so the integrated
 * min / max / close buttons live in the renderer — inside the tab strip of
 * BOTH the host and detached (solo) windows, and on the login screen. Every
 * channel therefore acts on the SENDER's window, never a global one.
 *   win:minimize  -> minimize the calling window
 *   win:maximize  -> toggle maximize/restore (the TV "fullscreen" button)
 *   win:close     -> close the calling window (last window quits the app)
 *   win:is-max    -> one-shot state read for the boot-time glyph
 * ('win:max-state' is the push channel wired in secureWindow above.) */
ipcMain.on('win:minimize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w.minimize();
});
ipcMain.on('win:maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return;
  try { if (w.isMaximized()) w.unmaximize(); else w.maximize(); } catch (err) {}
});
ipcMain.on('win:close', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w.close();
});
ipcMain.handle('win:is-max', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  try { return { ok: true, max: !!(w && !w.isDestroyed() && w.isMaximized()) }; }
  catch (err) { return { ok: true, max: false }; }
});

/* ===== round 28 channels: log batch / export / selftest ping ===== */
ipcMain.on('log-batch', (e, entries) => {
  const v = validLogBatch(entries);
  if (!v) return;
  for (const en of v) mlog(en);
});
ipcMain.handle('diag-ping', () => { mlogEvent('debug', 'diagnostics', 'diag-ping'); return { ok: true, t: Date.now() }; });
ipcMain.handle('logs-export', async (e, text, json, fileName) => {
  try {
    if (typeof text !== 'string' || text.length > 20 * 1024 * 1024) return { ok: false, error: 'invalid log payload' };
    if (json != null && (typeof json !== 'string' || json.length > 20 * 1024 * 1024)) return { ok: false, error: 'invalid json payload' };
    const win = BrowserWindow.fromWebContents(e.sender);
    const safeName = (vStr(String(fileName || ''), 80) || 'mt5-diagnostics').replace(/[\\/:*?"<>|]/g, '-');
    const r = await dialog.showSaveDialog(win, {
      defaultPath: safeName + '.log',
      filters: [
        { name: 'Log file', extensions: ['log', 'txt'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    const asJson = /\.json$/i.test(r.filePath);
    const payload = asJson ? (json != null ? json : text) : text;
    fs.writeFileSync(r.filePath, payload, 'utf8');
    mlogEvent('info', 'diagnostics', 'log exported', { path: r.filePath.slice(0, 300), json: asJson });
    return { ok: true, path: r.filePath };
  } catch (err) {
    mlogEvent('error', 'diagnostics', 'log export failed: ' + String(err && err.message || err));
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* ===== saved accounts (encrypted at rest via safeStorage/DPAPI) ===== */
function accountsFile() { return path.join(app.getPath('userData'), 'mt5-accounts.json'); }

function loadAccounts() {
  let data = { accounts: [], last: '' };
  try { data = JSON.parse(fs.readFileSync(accountsFile(), 'utf8')); } catch (e) {}
  const enc = safeStorage.isEncryptionAvailable();
  for (const a of (data.accounts || [])) {
    if (a.pw) {
      try { a.pw = enc ? safeStorage.decryptString(Buffer.from(a.pw, 'base64')) : ''; }
      catch (e) { a.pw = ''; } // unreadable blob (different OS user) -> drop
    } else a.pw = '';
  }
  return { accounts: data.accounts || [], last: data.last || '' };
}

function saveAccounts(data) {
  const enc = safeStorage.isEncryptionAvailable();
  const out = { last: String(data.last || ''), accounts: [] };
  for (const a of (data.accounts || []).slice(0, 12)) {
    const o = { id: String(a.id || ''), mode: a.mode === 'mt5' ? 'mt5' : 'demo',
                login: String(a.login || ''), server: String(a.server || ''),
                path: String(a.path || ''), label: String(a.label || ''), ts: a.ts || 0, pw: '' };
    if (a.pw && enc) {
      try { o.pw = safeStorage.encryptString(String(a.pw)).toString('base64'); } catch (e) {} // never store plaintext
    }
    out.accounts.push(o);
  }
  fs.writeFileSync(accountsFile(), JSON.stringify(out));
}

ipcMain.handle('accounts-load', () => loadAccounts());
ipcMain.handle('accounts-save', (e, data) => { const v = validAccounts(data); if (!v) return { ok: false, error: 'invalid accounts payload' }; try { saveAccounts(v); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; } });
/* ROUND51 (user request): a default alert icon rides every toast — Windows
   renders it as the image next to the toast text (appLogoOverride slot). */
const ALERT_ICON = path.join(__dirname, 'assets', 'alert-icon.png');

/* ROUND127 (user request — taskbar icon): the app icon on the Windows
   taskbar must be the user's built OJ logo, not the electron.exe default.
   Two things were working against it: the window icon was a single
   282x267 NON-SQUARE PNG (several Windows builds cannot map that onto the
   16/24/32px taskbar sizes and silently fall back to the exe icon), and
   the App User Model ID pointed at a string with no installed shortcut.
   Fix: a proper multi-size assets/app.ico (built once by
   scripts/make_app_icon.py from the SAME logo artwork) + the documented
   unpackaged-app AUMID (process.execPath) on Windows. */
const APP_ICON_ICO = path.join(__dirname, 'assets', 'app.ico');
const APP_ICON = (process.platform === 'win32' && fs.existsSync(APP_ICON_ICO))
  ? APP_ICON_ICO
  : path.join(__dirname, 'src', 'renderer', 'assets', 'logo.png');
ipcMain.on('notify', (e, p) => {
  try {
    const t = vStr(String((p && p.title) == null ? '' : p.title), 120);
    const b = vStr(String((p && p.body) == null ? '' : p.body), 500);
    if (Notification.isSupported()) new Notification({ title: t || 'OJ Chart', body: b || '', icon: ALERT_ICON, silent: false }).show();
  } catch (err) {}
});

/* chart snapshot: save the PNG behind a data URL with a Save-As dialog */
ipcMain.handle('save-data-url', async (e, dataUrl, fileName) => {
  try {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      return { ok: false, error: 'invalid image data' };
    }
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, {
      defaultPath: fileName || 'chart.png',
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* text file save dialog (Save Layout menu: Download chart data… -> CSV) */
ipcMain.handle('save-text-file', async (e, content, fileName) => {
  try {
    if (typeof content !== 'string') return { ok: false, error: 'invalid content' };
    if (content.length > 50 * 1024 * 1024) return { ok: false, error: 'content too large' }; // ROUND126: parity with logs-export
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showSaveDialog(win, {
      defaultPath: fileName || 'chart-data.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, content, 'utf8');
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* chart snapshot: put the PNG on the clipboard */
ipcMain.handle('copy-image', (e, dataUrl) => {
  try {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      return { ok: false, error: 'invalid image data' };
    }
    clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* ===== ROUND126 (security): renderer permission hardening =====
   The app drives OS notifications through its own IPC channel and never
   uses web permissions (geolocation, media, webauthn, ...), so every
   permission request/check from any renderer is DENIED — a compromised
   renderer gains nothing by asking. Registered once on the default session
   (all app windows use it); denying checks keeps APIs like navigator
   Permissions.query consistent for our own UI (it reports denied for every
   permission, no app code reads it). */
function hardenPermissions(session) {
  try {
    session.setPermissionRequestHandler((wc, permission, cb) => {
      mlogEvent('warning', 'security', 'permission request denied', { permission: String(permission).slice(0, 60) });
      cb(false);
    });
    /* Returning true ALLOWS the permission (electron.d.ts) — so deny everything.
       If a permission is ever needed, build an explicit allow-list instead. */
    session.setPermissionCheckHandler(() => false);
  } catch (e) {}
}

/* ===== ROUND126 (security): global webContents safety net =====
   secureWindow covers every window WE create; this hook also covers any
   webContents that could ever be created by another path (future code,
   stray <webview>, ...) so window.open and remote navigation stay dead
   app-wide — pure defense in depth, no behaviour change for our windows
   (they already deny both through secureWindow). */
app.on('web-contents-created', (event, wc) => {
  try {
    wc.setWindowOpenHandler(() => {
      mlogEvent('warning', 'security', 'window.open blocked by global policy');
      return { action: 'deny' };
    });
    wc.on('will-navigate', (ev, url) => {
      if (!String(url).startsWith('file:')) {
        ev.preventDefault();
        mlogEvent('warning', 'security', 'navigation blocked (global)', { url: String(url).slice(0, 200) });
      }
    });
  } catch (e) {}
});

app.whenReady().then(() => {
  /* ROUND51 (user request): brand the OS notifications — the Windows toast
     header used to read "electron.app.Electron" (the dev AUMID); a fixed
     App User Model ID makes it read "OJChart Notification" instead.
     ROUND127 (taskbar icon): on Windows the unpackaged-app AUMID must be
     the executable path (the Electron-documented dev-mode call) so the
     shell groups the window under an identity whose icon IS the window's
     own (assets/app.ico) instead of falling back to the electron.exe
     default logo. The toast keeps its bell image via the explicit
     ALERT_ICON above. */
  try { app.setName('OJChart Notification'); } catch (e) {}
  try { app.setAppUserModelId(process.platform === 'win32' ? process.execPath : 'OJChart Notification'); } catch (e) {}
  hardenPermissions(require('electron').session.defaultSession); // ROUND126
  pruneLogs();
  mlogEvent('info', 'app', 'main boot', { version: '1.9.212', electron: process.versions.electron, node: process.versions.node, platform: process.platform });
  createWindow();
});
app.on('window-all-closed', () => { stopProvider(); app.quit(); });
app.on('before-quit', () => { mlogEvent('info', 'app', 'app quit'); stopProvider(); try { if (logStream) { logStream.end(); logStream = null; } } catch (e) {} });

/* round 28: main-process crash net — uncaught exceptions land in the log
   file instead of dying silently */
process.on('uncaughtException', (err) => {
  try { mlogEvent('error', 'error', 'main uncaughtException: ' + (err && err.message || err), { stack: err && err.stack ? String(err.stack).slice(0, 2000) : undefined }); } catch (e) {}
});
process.on('unhandledRejection', (reason) => {
  try { mlogEvent('error', 'error', 'main unhandledRejection: ' + String(reason && reason.message || reason)); } catch (e) {}
});
