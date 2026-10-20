/**
 * Diagnostics panel (round 28)
 *
 * Diagnostics — right-panel tab that turns the logger into a usable
 * bug-fixing tool:
 * - live log view with level / category / text filters
 * - expandable sanitized context per entry
 * - session stats (counts, uptime, sink status)
 * - one-click Export (file log via Electron, or browser download)
 * - Self-test: verifies logger, error system, scrubbing, storage, IPC echo
 * and feed state — the first thing to run when something looks broken.
 * Rendering is append-only and DOM-capped; hidden tabs cost ~nothing.
 *
 * @module panels/diagnostics
 */

import { U } from '../core/util.js';
import { Log } from '../../../core/logger.js';
import { AppErr } from '../../../core/errors.js';
import { icon } from '../ui/icons.js';
import { App } from '../../../core/state.js';
import { UI } from '../drawing/ui.js';
import { Manager } from '../chart/manager.js';
import { PineUI } from '../chart/pine-ui.js';

const DOM_CAP = 600;
  let viewPaused = false;
  let unsub = null;
  let statsTimer = null;
  let minLevels = { debug: true, info: true, warn: true, error: true };
  let search = '';
  let cat = '';
  let lastRenderedSeq = 0;

  /* ---------- helpers ---------- */
  const $ = (id) => document.getElementById(id);
  function timeLabel(t) {
    const d = new Date(t);
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }
  function visible(e) {
    if (!minLevels[e.lvl]) return false;
    if (cat && e.cat !== cat) return false;
    if (search) {
      const hay = (e.msg + ' ' + (e.ctx ? JSON.stringify(e.ctx) : '')).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }

  /* ---------- rendering ---------- */
  function makeRow(e) {
    const row = document.createElement('div');
    row.className = 'dg-row dg-' + e.lvl + (e.ctx !== undefined ? ' has-ctx' : '');
    row.dataset.seq = e.seq;
    row.innerHTML =
      '<span class="dg-t">' + timeLabel(e.t) + '</span>' +
      '<span class="dg-l">' + e.lvl.toUpperCase() + '</span>' +
      '<span class="dg-c">' + e.cat + '</span>' +
      '<span class="dg-m"></span>';
    row.querySelector('.dg-m').textContent = e.msg;
    if (e.ctx !== undefined) {
      const pre = document.createElement('pre');
      pre.className = 'dg-ctx hidden';
      let txt;
      try { txt = JSON.stringify(e.ctx, null, 2); } catch (er) { txt = String(e.ctx); }
      pre.textContent = txt.length > 4000 ? txt.slice(0, 4000) + ' …' : txt;
      row.addEventListener('click', () => pre.classList.toggle('hidden'));
      row.appendChild(pre);
    }
    return row;
  }

  function append(e) {
    const list = $('dg-list');
    if (!list) return;
    list.appendChild(makeRow(e));
    while (list.children.length > DOM_CAP) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
    lastRenderedSeq = e.seq;
  }

  function rerender() {
    const list = $('dg-list');
    if (!list) return;
    list.innerHTML = '';
    const ent = Log.entries({}).filter(visible).slice(-DOM_CAP);
    const frag = document.createDocumentFragment();
    for (const e of ent) frag.appendChild(makeRow(e));
    list.appendChild(frag);
    list.scrollTop = list.scrollHeight;
    lastRenderedSeq = ent.length ? ent[ent.length - 1].seq : lastRenderedSeq;
  }

  function refreshCatOptions() {
    const sel = $('dg-cat');
    if (!sel) return;
    const cur = sel.value;
    const cats = Object.keys(Log.stats().cats).sort();
    sel.innerHTML = '<option value="">all categories</option>' + cats.map((c) => '<option value="' + c + '">' + c + ' (' + Log.stats().cats[c] + ')</option>').join('');
    sel.value = cats.includes(cur) ? cur : '';
  }

  function renderStats() {
    const el = $('dg-stats');
    if (!el) return;
    const s = Log.stats();
    el.innerHTML =
      '<span class="dg-st" title="Session id">' + s.sessionId.slice(-6) + '</span>' +
      '<span class="dg-st" title="Uptime">' + Math.round(s.uptimeMs / 1000) + 's</span>' +
      '<span class="dg-st" title="Entries in memory">' + s.inRing + '/' + s.total + '</span>' +
      '<span class="dg-st dg-c-err" title="Errors">' + s.counts.error + ' err</span>' +
      '<span class="dg-st dg-c-warn" title="Warnings">' + s.counts.warn + ' warn</span>' +
      '<span class="dg-st ' + (s.ipc ? 'dg-ok' : 'dg-dim') + '" title="File log sink (Electron)">file ' + (s.ipc ? 'on' : 'off') + '</span>';
  }

  /* ---------- round 29: data health + symbol probe ----------
     The "axis stuck at another price universe while the watchlist is right"
     report class needs ONE glanceable answer: does the loaded HISTORY end at
     the price the LIVE tick is in? Every chart pane renders as a row
     (bars count, history last close, live tick, tick age) and a disagreement
     paints the row red. The probe button re-requests the ACTIVE pane's last
     history bars and prints them next to the fresh tick — the decisive
     on-machine evidence of whether the terminal/broker history is wrong. */
  function dataHealth() {
    const el = $('dg-data');
    if (!el) return;
    const panes = (App && App.panes) || [];
    if (!panes.length) { el.innerHTML = ''; return; }
    const nowS = Date.now() / 1000 + ((App && App.feed && App.feed.serverOff) || 0);
    const rows = panes.map((p) => {
      const d = p.digits || 5;
      const lc = p.bars && p.bars.length ? p.bars[p.bars.length - 1].close : null;
      const px = Manager ? Manager.tickPx[p.symbol] : null;
      const pxAt = Manager ? Manager.lastTickAt[p.symbol] : 0;
      const age = pxAt ? Math.max(0, Math.round(nowS - pxAt)) : null;
      const point = U.pointSize(d);
      const bad = lc != null && isFinite(lc) && px != null && isFinite(px) &&
        Math.abs(lc - px) > Math.max(point * 50, Math.abs(px) * 0.005);
      const f = (v) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(d));
      return '<div class="dg-drow' + (bad ? ' bad' : '') + '">' +
        '<b>' + p.symbol + '</b><i>' + p.tf + '</i>' +
        '<span title="history bars on the chart">' + (p.bars ? p.bars.length : 0) + ' bars</span>' +
        '<span title="history last close">hist ' + f(lc) + '</span>' +
        '<span title="live tick price">live ' + f(px) + '</span>' +
        '<span title="tick age in seconds">' + (age == null ? 'no tick' : age + 's') + '</span>' +
        (bad ? '<em>HISTORY≠LIVE</em>' : '') +
        '</div>';
    });
    el.innerHTML = '<div class="dg-dhead">Data health — history vs live tick</div>' + rows.join('');
  }

  async function probeSymbol() {
    const pane = App && App.activePane;
    if (!pane || !App.feed || !App.feed.connected) {
      if (UI && UI.toast) UI.toast('Probe needs a connected feed and an active chart', 'err');
      return;
    }
    const sym = pane.symbol, tf = pane.tf;
    try {
      const t0 = performance.now();
      const r = await App.feed.bars(sym, tf, 3);
      const ms = Math.round(performance.now() - t0);
      const dg = r.digits != null ? r.digits : 5;
      /* the msg is capped at 2000 chars in the logger and the provider floors
         requests at 50 bars — print only the LAST closes that matter */
      const closes = (r.bars || []).map((b) => Number(b.close).toFixed(dg)).slice(-5);
      const px = Manager ? Manager.tickPx[sym] : null;
      const pxAt = Manager ? Manager.lastTickAt[sym] : 0;
      const nowS = Date.now() / 1000 + (App.feed.serverOff || 0);
      const age = pxAt ? Math.max(0, Math.round(nowS - pxAt)) : null;
      const bad = px != null && r.bars && r.bars.length &&
        Math.abs(r.bars[r.bars.length - 1].close - px) > Math.max(U.pointSize(dg) * 50, Math.abs(px) * 0.005);
      const msg = 'probe ' + sym + ' ' + tf + ': digits=' + dg +
        ', last closes=[' + closes.join(', ') + ']' +
        ', live=' + (px != null ? Number(px).toFixed(dg) : '—') +
        ' (age ' + (age == null ? '—' : age + 's') + ')' +
        (bad ? ' — HISTORY\u2260LIVE: the history source serves another price universe' : '');
      Log.info('probe', msg, { symbol: sym, tf, digits: dg, closes, live: px, bars: (r.bars || []).length, ms });
      append({ seq: ++lastRenderedSeq + 1000, t: Date.now(), lvl: bad ? 'error' : 'info', cat: 'probe', msg });
      if (UI && UI.toast) UI.toast(bad ? 'Probe: history \u2260 live — broker history looks wrong' : 'Probe ok — history matches live', bad ? 'err' : 'ok');
    } catch (e) {
      Log.fromError(e, 'probe', { symbol: sym, tf });
      if (UI && UI.toast) UI.toast('Probe failed — see log', 'err');
    }
  }

  /* ---------- export ---------- */
  async function exportLog() {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const name = 'mt5-diagnostics-' + Log.sessionId.slice(-6) + '-' + stamp;
    try {
      if (window.electronAPI && window.electronAPI.logsExport) {
        const r = await window.electronAPI.logsExport(Log.exportText(), Log.exportJson(), name);
        if (r && r.ok) {
          Log.info('panel', 'diagnostics exported', { path: r.path });
          if (UI && UI.toast) UI.toast('Log exported: ' + (r.path || ''), 'ok');
          return r;
        }
        if (r && r.canceled) return r;
        throw new Error((r && r.error) || 'export failed');
      }
      /* browser fallback: plain download */
      const blob = new Blob([Log.exportText()], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name + '.log';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      Log.info('panel', 'diagnostics exported (browser download)');
      return { ok: true, browser: true };
    } catch (e) {
      Log.fromError(e, 'panel', { where: 'exportLog' });
      if (UI && UI.toast) UI.toast('Export failed — see Diagnostics', 'err');
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  /* ---------- self-test ---------- */
  async function selftest() {
    const t0 = performance.now();
    const results = [];
    const run = async (name, fn) => {
      const s = performance.now();
      try {
        const r = await fn();
        results.push({ name, status: r === false ? 'fail' : (r == null ? 'skip' : 'pass'), detail: typeof r === 'string' ? r : '', ms: +(performance.now() - s).toFixed(1) });
      } catch (e) {
        results.push({ name, status: 'fail', detail: String(e && e.message || e), ms: +(performance.now() - s).toFixed(1) });
      }
    };

    await run('logger ring write/read', () => {
      const tag = 'st-' + Date.now().toString(36);
      Log.debug('selftest', 'probe ' + tag);
      return Log.entries({ search: tag }).length === 1 ? true : 'entry not found';
    });
    await run('error catalog + wrap', () => {
      const e = AppErr.wrap(new Error('probe'), 'FEED_TIMEOUT');
      return (e instanceof AppErr.AppError && e.code === 'FEED_TIMEOUT' && AppErr.codes().length > 10) ? true : 'bad AppError';
    });
    await run('context scrubbing', () => {
      const tag = 'scrub-' + Date.now().toString(36);
      Log.info('selftest', 'scrub probe ' + tag, { password: 'TOPSECRET', nested: { token: 'x' }, ok: 1 });
      const ent = Log.entries({ search: tag })[0];
      return (ent && ent.ctx && ent.ctx.password === '•••redacted•••' && ent.ctx.nested.token === '•••redacted•••' && ent.ctx.ok === 1) ? true : 'not redacted';
    });
    await run('open catalog (register)', () => {
      const ok = AppErr.register('SELFTEST_PROBE', { userMessage: 'probe', category: 'system' });
      return (ok === true && AppErr.register('SELFTEST_PROBE', {}) === false) ? true : 'register broken';
    });
    await run('localStorage', () => {
      const k = 'mt5_st_probe';
      U.lsSet(k, { v: 1 });
      const ok = U.lsGet(k, null) && U.lsGet(k, null).v === 1;
      localStorage.removeItem(k);
      return ok ? true : 'ls broken';
    });
    await run('IPC echo (main process)', async () => {
      if (!(window.electronAPI && window.electronAPI.diagPing)) return null; // skip in browser
      const t = Date.now();
      const r = await window.electronAPI.diagPing();
      return (r && r.ok) ? ('rtt ' + (Date.now() - t) + 'ms') : 'no pong';
    });
    await run('feed state', () => {
      const f = App && App.feed;
      if (!f) return 'no feed instance';
      return f.connected ? true : 'not connected (expected before login)';
    });
    await run('log export payload', () => (Log.exportText().length > 100 && Log.exportJson().length > 100) ? true : 'export too small');

    const pass = results.filter((r) => r.status === 'pass').length;
    const fail = results.filter((r) => r.status === 'fail').length;
    const skip = results.filter((r) => r.status === 'skip').length;
    const ms = +(performance.now() - t0).toFixed(1);
    const summary = 'selftest: ' + pass + ' pass, ' + skip + ' skip, ' + fail + ' fail (' + ms + 'ms)';
    Log.info('selftest', summary, { results });

    /* render summary + each check as pseudo-entries in the view */
    const list = $('dg-list');
    if (list) {
      append({ seq: ++lastRenderedSeq + 1000, t: Date.now(), lvl: fail ? 'error' : 'info', cat: 'selftest', msg: summary });
      for (const r of results) append({ seq: ++lastRenderedSeq + 1000, t: Date.now(), lvl: r.status === 'fail' ? 'error' : (r.status === 'skip' ? 'debug' : 'info'), cat: 'selftest', msg: r.name + ' — ' + r.status + (r.detail ? ' (' + r.detail + ')' : '') + ' [' + r.ms + 'ms]' });
    }
    if (UI && UI.toast) UI.toast(summary, fail ? 'err' : 'ok');
    return { pass, fail, skip, results, ms };
  }

  /* ---------- init ---------- */
  function init() {
    const list = $('dg-list');
    if (!list) return;

    /* level toggles */
    document.querySelectorAll('#dg-levels .dg-lvl').forEach((b) => {
      b.addEventListener('click', () => {
        const lv = b.dataset.lvl;
        minLevels[lv] = !minLevels[lv];
        b.classList.toggle('active', minLevels[lv]);
        rerender();
      });
    });
    $('dg-cat').addEventListener('change', (e) => { cat = e.target.value; rerender(); });
    let searchTo = null;
    $('dg-search').addEventListener('input', (e) => {
      clearTimeout(searchTo);
      searchTo = setTimeout(() => { search = e.target.value.trim().toLowerCase(); rerender(); }, 200);
    });

    /* buttons */
    $('dg-clear').addEventListener('click', () => { $('dg-list').innerHTML = ''; });
    $('dg-export').addEventListener('click', exportLog);
    $('dg-selftest').addEventListener('click', () => { selftest(); });
    $('dg-probe').addEventListener('click', () => { probeSymbol(); });
    $('dg-pause').addEventListener('click', () => {
      viewPaused = !viewPaused;
      $('dg-pause').classList.toggle('active', viewPaused);
      Log.info('panel', 'live view ' + (viewPaused ? 'paused' : 'resumed'));
    });

    /* live subscription — renders only while the tab is visible */
    unsub = Log.onEntry((e) => {
      const tab = $('tab-diagnostics');
      if (!tab || tab.classList.contains('hidden') || viewPaused) return;
      if (visible(e)) append(e);
    });

    /* refresh stats + data health + categories while visible */
    statsTimer = setInterval(() => {
      const tab = $('tab-diagnostics');
      if (!tab || tab.classList.contains('hidden')) return;
      renderStats();
      dataHealth();
    }, 2000);

    /* icon chips */
    if (icon) {
      $('dg-clear').innerHTML = icon('trash');
      $('dg-export').innerHTML = icon('cloudDl');
      $('dg-selftest').innerHTML = icon('checkOn');
      $('dg-probe').innerHTML = icon('search');
      $('dg-pause').innerHTML = icon('pause');
    }

    renderStats();
    dataHealth();
    rerender();
    Log.info('panel', 'diagnostics panel ready');
  }

  /** called by app.js when the tab is shown — refresh view + cats */
  function onShow() {
    refreshCatOptions();
    renderStats();
    dataHealth();
    rerender();
    renderPineLogs();
  }

  /* ROUND193: Pine Logs viewer — per-script log.info/warning/error entries
     rendered with the same row classes as core entries (no new CSS paint
     except the section shell). Refreshed on show (append-live would fight
     the forming-bar dedupe rhythm; the data stays put). */
  function renderPineLogs() {
    const list = $('dg-pine-list');
    const count = $('dg-pine-count');
    if (!list) return;
    list.innerHTML = '';
    let rows = [];
    try { rows = (PineUI.pineLogs && PineUI.pineLogs(200)) || []; } catch (e) { rows = []; }
    if (count) count.textContent = rows.length ? String(rows.length) : '';
    const frag = document.createDocumentFragment();
    for (const l of rows) {
      const lvl = l.level === 'warning' ? 'warn' : (l.level === 'error' ? 'error' : 'info');
      frag.appendChild(makeRow({
        t: l.t != null ? l.t * 1000 : Date.now(),
        lvl,
        cat: 'pine:' + l.script,
        msg: l.msg,
      }));
    }
    if (!rows.length) {
      const e = document.createElement('div');
      e.className = 'tst-empty';
      e.textContent = 'No Pine Logs yet — log.info/warning/error() in a script will appear here.';
      frag.appendChild(e);
    }
    list.appendChild(frag);
  }

const Diagnostics = { init, onShow, selftest, exportLog };
export { Diagnostics };
