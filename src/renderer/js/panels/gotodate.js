/**
 * ROUND86B (user request) — Go to Date, fixed for REAL broker servers.
 *
 * What was broken on the real server (user report: "خود بخش Go To Date هم
 * درست کار نمیکنه"):
 *   1. The year dropdown only offered the years of the LOADED history — on a
 *      real broker the loaded window is short, so most dates could not even
 *      be selected. The year list now always spans decades.
 *   2. A date outside the loaded history is fetched with bars_req{to}; real
 *      terminals answer the FIRST request for old history with an empty
 *      payload while the terminal downloads the archive (the same cold-sync
 *      case Manager.loadBars already retries). fetchAround did not retry ->
 *      "nothing happened". Every fetch now polls (4 attempts x 1.5s).
 *   3. When the fetch DID land, the view was destroyed within one tick: the
 *      live stream hit the old-tail series -> scheduleStaleReload ->
 *      loadBars snapped the chart back to "now". Historical views now block
 *      live ticks (the same pane.replay guard the Custom Session uses) and a
 *      "Return to live" chip restores the stream on demand. Any natural
 *      reload (TF switch / symbol switch / session) clears the state via a
 *      wrapped Manager.loadBars.
 *   4. NEW: "Start Bar Replay there" — fetches a window FROM the selected
 *      day through the present (multi-chart: every pane gets its own
 *      window) and starts the replay on it, so backtesting + the demo
 *      account (trade/replaytrade.js) work on REAL broker history, not just
 *      the last few loaded days.
 *   5. Custom Session now lives INSIDE this dialog (second tab) per the
 *      user's follow-up ("رو توی بخش Go to Date اجرا نکردی").
 *
 * @module panels/gotodate
 */
import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { App } from '../../../core/state.js';
import { Manager } from '../chart/manager.js';
import { UI } from '../drawing/ui.js';
import { Replay } from './replay.js';
import { SessionRange } from './session.js';
import { DAY } from '../../../core/session-math.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const FETCH_ATTEMPTS = 4;      // empty-payload poll (cold terminal downloads)
const FETCH_DELAY = 1500;      // ms between attempts (same as Manager.loadBars)
const MAX_FETCH_BARS = 25000;  // parity with App.MAX_CHART_BARS / provider cap
const CHUNK_GUARD = 12;        // max backward pages per window

const GoToDate = {};

/* ---------- fetch helpers ---------- */

/* one bars_req with the cold-terminal poll: real MT5 terminals answer the
   first request for not-yet-downloaded history with [] and fill the archive
   in the background — retry before giving up (documented Manager.loadBars
   behaviour, now shared by every Go-to-Date path) */
async function retryBars(symbol, tfId, count, to) {
  for (let a = 0; a < FETCH_ATTEMPTS; a++) {
    const resp = await App.feed.bars(symbol, tfId, count, to);
    const bars = (resp.bars || []).filter((b) => b && isFinite(b.time) && b.time < to);
    if (bars.length) return { bars, digits: resp.digits != null ? resp.digits : null };
    if (a < FETCH_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, FETCH_DELAY));
  }
  return { bars: [], digits: null };
}

/* backward-paged window (fromT .. toT exclusive), at most `cap` bars.
   Asks for the FULL cap in one shot first — real MT5 serves up to 25k bars
   per request and the demo provider regenerates its archive ENDING AT NOW
   on every call, so small per-page counts would starve the second page and
   never reach the requested date. Pages again with bars_req{to=oldest} only
   while the provider keeps returning full pages. Returns
   {bars (sorted, deduped), digits, dry}. */
async function fetchWindow(symbol, tfId, fromT, toT, cap) {
  /* ROUND86C: right-size every page to the REMAINING window. The first page
     used to ask for the full 25k cap no matter how small the window — the
     real provider then derives a copy window of TF_SEC*count*3 (~52 days of
     M1 for a 1-day view), and on a cold terminal THAT archive sync is the
     multi-second block behind the user's "Request timeout: bars_req".
     Paging still fills the window (page again only while full). */
  const tfObj = App.tfById[tfId];
  const tfSec = (tfObj && tfObj.sec > 0) ? tfObj.sec : 60;
  let collected = [], digits = null, to = toT, dry = false;
  for (let g = 0; g < CHUNK_GUARD && collected.length < cap; g++) {
    const need = Math.ceil(Math.max(1, to - fromT) / tfSec) + 200;
    const want = Math.max(50, Math.min(cap, MAX_FETCH_BARS - collected.length, need));
    const r = await retryBars(symbol, tfId, want, to);
    if (r.digits != null) digits = r.digits;
    if (!r.bars.length) { dry = dry || g > 0; break; }   // first page already retried inside retryBars
    /* ROUND86C: the page's OLDEST bar. The old code read bars[len-1] but the
       providers return ASCENDING time — that was the NEWEST bar, so every
       backward page slid by ONE bar instead of jumping to the window start:
       12 guard pages x page-size bars were fetched (on a real broker with a
       deep archive that is hundreds of thousands of bars serialized on the
       provider -> the user's "Request timeout: bars_req"). Math.min keeps it
       correct even if a provider ever answered descending. */
    const oldest = Math.min(r.bars[0].time, r.bars[r.bars.length - 1].time);
    collected = r.bars.concat(collected.filter((b) => b.time >= oldest));
    if (collected.length >= MAX_FETCH_BARS) { collected = collected.slice(-MAX_FETCH_BARS); break; }
    if (oldest <= fromT) break;
    if (r.bars.length < want) { dry = true; break; }     // provider ran dry mid-range
    to = oldest;
  }
  const map = new Map();
  for (const b of collected) map.set(b.time, b);
  const bars = Array.from(map.values())
    .sort((a, b) => a.time - b.time)
    .filter((b) => b.time >= fromT && b.time < toT);
  return { bars: bars.slice(-cap), digits, dry };
}

/* ---------- historical view (ticks blocked) ---------- */

function historicalPane(pane, bars, digits) {
  if (digits != null) pane.digits = digits;
  try {
    Manager.setPaneData(pane, bars);
  } catch (e) {
    bars = Manager.sanitizeBars(bars, pane.symbol, pane.tf);
    Manager.setPaneData(pane, bars);
  }
  /* BUG-007 invariant: pane.bars only after the series accepted */
  pane.bars = bars;
  pane.barTimes = bars.map((b) => b.time);
  pane._shown = bars.length;
  pane._olderDone = true;      // a historical view is finite by design
  pane._renkoSize = null;
  pane.pz = { active: false, center: 0, span: 0, at: 0 };
  try {
    const sid = pane._scaleId || 'right';
    pane.chart.priceScale(sid).applyOptions({ autoScale: true });
  } catch (e) {}
  /* block the live stream: a tick would fold into the old tail and trigger
     the stale-reload snap-back to "now" (the ROUND86B root-cause fix) */
  if (!Replay.isActive()) pane.replay = {};
  pane._gdView = true;
  Manager.recomputeIndicators(pane);
  Manager.recomputePine(pane);
  Manager.applyPriceLines(pane);
  Manager.updateOlderPill(pane);
  Manager.updateLegend(pane, null);
}

function clearPaneView(pane) {
  if (!pane || !pane._gdView) return;
  pane._gdView = false;
  if (!Replay.isActive() && !SessionRange.isActive()) pane.replay = null;
  updateChip();
}

function anyGdView() {
  return App.panes.some((p) => p._gdView);
}

/* floating "Return to live" chip over the charts while a historical view
   from Go to Date is on screen */
function updateChip() {
  let chip = document.getElementById('gd-live-chip');
  if (!anyGdView()) { if (chip) chip.classList.add('hidden'); return; }
  if (!chip) {
    chip = U.el('div', 'gd-chip hidden', document.getElementById('charts-area'));
    chip.id = 'gd-live-chip';
    chip.innerHTML = '<span class="gd-chip-dot"></span><span id="gd-chip-txt"></span>' +
      '<button class="gd-chip-btn" id="gd-chip-back">Return to live</button>';
    chip.querySelector('#gd-chip-back').addEventListener('click', backToLive);
  }
  const t = App.panes.reduce((acc, p) => (p._gdView && p.barTimes && p.barTimes.length) ? Math.max(acc, p.barTimes[p.barTimes.length - 1]) : acc, 0);
  const txt = chip.querySelector('#gd-chip-txt');
  if (txt) txt.textContent = t ? 'Historical view — ' + new Date(t * 1000).toISOString().slice(0, 10) : 'Historical view';
  chip.classList.remove('hidden');
}

function backToLive() {
  if (Replay.isActive()) Replay.stop();
  if (SessionRange.isActive()) SessionRange.clear();
  for (const pane of App.panes.slice()) {
    if (!pane._gdView) continue;
    pane._gdView = false;
    pane.replay = null;
    try { Manager.loadBars(pane); } catch (e) {}
  }
  updateChip();
  UI.toast('Back to the live chart', 'ok');
}

/* ---------- normal-chart jump: window ending at the selected day ---------- */

function centerOn(pane, logical) {
  const ts = pane.chart.timeScale();
  const cur = ts.getVisibleLogicalRange();
  const span = cur ? (cur.to - cur.from) : 160;
  ts.setVisibleLogicalRange({ from: logical - span / 2, to: logical + span / 2 });
}

async function jumpViewPane(pane, t) {
  if (!App.feed || !App.feed.connected) {
    UI.toast('Go to Date: not connected', 'warn');
    return;
  }
  const tf = App.tfById[pane.tf];
  const to = t + DAY;                    // end of the selected day (exclusive)
  const seq = (pane._seq = (pane._seq || 0) + 1);
  pane.loading = true;
  try {
    let bars = [], digits = null;
    if (tf.custom) {
      /* custom interval: fetch a fine native base and aggregate */
      const base = pickCustomBase(tf);
      const ratio = Math.max(1, Math.round(tf.sec / base.sec));
      const r = await retryBars(pane.symbol, base.id, Math.min((App.COUNT_FOR[base.id] || 1500) * ratio, 25000), to);
      if (seq !== pane._seq) return;
      digits = r.digits;
      bars = aggregateBy(r.bars, tf);
    } else {
      const depth = Math.max(App.COUNT_FOR[pane.tf] || 1500, 1500);
      const r = await fetchWindow(pane.symbol, pane.tf, to - depth * tf.sec, to, MAX_FETCH_BARS);
      if (seq !== pane._seq) return;
      digits = r.digits;
      bars = r.bars;
    }
    bars = Manager.sanitizeBars(bars, pane.symbol, pane.tf).filter((b) => b.time < to);
    if (!bars.length) {
      UI.toast('Go to Date: no ' + (tf.label || pane.tf) + ' history found at ' +
        new Date(t * 1000).toISOString().slice(0, 10) +
        ' — the broker archive may not reach that far (try a higher timeframe or a nearer date)', 'warn');
      return;
    }
    historicalPane(pane, bars, digits);
    updateChip();
    const l = U.timeToLogical(pane.barTimes, t);
    setTimeout(() => {
      try {
        if (isFinite(l)) centerOn(pane, l);
        else pane.chart.timeScale().fitContent();
      } catch (e) {}
    }, 0);
  } catch (e) {
    UI.toast('Go to Date failed: ' + (e && e.message || e), 'err');
  } finally {
    if (seq === pane._seq) pane.loading = false;
  }
}

function jumpPane(pane, t) {
  const times = pane.barTimes || [];
  if (!times.length) { jumpViewPane(pane, t); return; }
  if (t >= times[0] && t <= times[times.length - 1]) {
    try {
      const l = U.timeToLogical(times, t);
      if (isFinite(l)) centerOn(pane, l);
    } catch (e) {}
  } else {
    jumpViewPane(pane, t);
  }
}

/* ---------- replay-from-date (multi-chart) ---------- */

/* start Bar Replay AT the selected day: fetch a window FROM that day
   through the present on every pane, then anchor the replay cursor there */
async function jumpReplayFrom(t) {
  const nowT = Math.floor(Date.now() / 1000) + DAY;
  if (t >= nowT - DAY) { UI.toast('Go to Date: that date is not in the past', 'warn'); return; }
  const driver = App.activePane || App.panes[0];
  if (!driver) return;
  /* ROUND265: re-anchoring while a replay session is ALREADY running would
     read the CUT arrays (the session swaps pane.bars for the slice up to the
     cursor). Stop first so every pane is back on its full history before we
     pick the index / fetch the new window. */
  if (Replay.isActive()) Replay.stop();
  if (SessionRange.isActive()) {
    /* stitched Custom Session data is finite by design — anchor the replay
       inside it instead of fetching (composes with the demo account too) */
    const idx = firstIndexAtOrAfter(driver.bars || [], t);
    if (idx < 0 || !Replay.startAt(driver, idx)) { UI.toast('Go to Date: that date is outside the stitched session data', 'warn'); return; }
    UI.toast('Replay started at ' + new Date(t * 1000).toISOString().slice(0, 10) + ' (Custom Session data)', 'ok');
    return;
  }
  if (!App.feed || !App.feed.connected) { UI.toast('Go to Date: not connected', 'warn'); return; }
  const tf = App.tfById[driver.tf];
  UI.toast('Go to Date: loading history from ' + new Date(t * 1000).toISOString().slice(0, 10) + '…', 'ok');
  const seq = (driver._seq = (driver._seq || 0) + 1);
  driver.loading = true;
  let first = null, digits = null;
  try {
    const r = await fetchWindow(driver.symbol, driver.tf, t, nowT, MAX_FETCH_BARS);
    if (seq !== driver._seq) return;
    if (!r.bars.length) {
      UI.toast('Go to Date: no ' + (tf.label || driver.tf) + ' history found from that date — the broker archive may not reach that far (try a higher timeframe or a nearer date)', 'warn');
      return;
    }
    first = r.bars[0].time;
    if (first > t + tf.sec) {
      UI.toast('Go to Date: ' + driver.symbol + ' ' + (App.tfById[driver.tf].label || driver.tf) +
        ' archive starts ' + new Date(first * 1000).toISOString().slice(0, 10) + ' — replay anchored there', 'warn');
    }
    historicalPane(driver, Manager.sanitizeBars(r.bars, driver.symbol, driver.tf), r.digits);
  } catch (e) {
    UI.toast('Go to Date failed: ' + (e && e.message || e), 'err');
    return;
  } finally {
    if (seq === driver._seq) driver.loading = false;
  }
  /* multi-chart: every pane gets its own window from the same day so the
     whole layout replays in sync (user requirement: multi-chart support) */
  for (const pane of App.panes) {
    if (pane === driver) continue;
    try {
      const pseq = (pane._seq = (pane._seq || 0) + 1);
      pane.loading = true;
      const r = await fetchWindow(pane.symbol, pane.tf, t, nowT, MAX_FETCH_BARS);
      if (pseq !== pane._seq) continue;
      if (r.bars.length) historicalPane(pane, Manager.sanitizeBars(r.bars, pane.symbol, pane.tf), r.digits);
    } catch (e) {} finally { pane.loading = false; }
  }
  updateChip();
  Replay.startAt(driver, 1);
  try { window.__app && window.__app.RightPanel && window.__app.RightPanel.showTab('replaytrade'); } catch (e) {}
  UI.toast('Replay started ' + new Date(first * 1000).toISOString().slice(0, 10) +
    ' → present · ' + (App.panes.length > 1 ? App.panes.length + ' charts synced · ' : '') +
    'demo account: right rail → Replay Trading', 'ok');
}

function firstIndexAtOrAfter(bars, t) {
  let lo = 0, hi = bars.length - 1, idx = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (bars[m].time >= t) { idx = m; hi = m - 1; } else lo = m + 1;
  }
  return idx;
}

/* ---------- dialog (two tabs: Go to date | Custom Session) ---------- */

function pad2(n) { return String(n).padStart(2, '0'); }

GoToDate.openDialog = function (tab) {
  const layer = document.getElementById('popup-layer');
  if (!layer) return;
  layer.classList.remove('hidden');
  U.clear(layer);
  const back = U.el('div', 'dialog-backdrop', layer);
  const dlg = U.el('div', 'dialog rtt-dlg gd-dlg', back);

  /* loaded data range across every pane (replay bars included) — shown as a
     HINT only; the pickers always span decades so any date is selectable */
  let lo = Infinity, hi = -Infinity;
  for (const pane of App.panes) {
    const src = (Replay.isActive() && pane._allBars && pane._allBars.length) ? pane._allBars : pane.barTimes;
    if (!src || !src.length) continue;
    if (src[0] < lo) lo = src[0];
    if (src[src.length - 1] > hi) hi = src[src.length - 1];
  }
  if (!isFinite(lo)) { lo = Math.floor(Date.now() / 1000) - DAY * 30; hi = Math.floor(Date.now() / 1000); }

  const nowD = new Date();
  const nowY = nowD.getUTCFullYear();
  const yLo = Math.min(new Date(lo * 1000).getUTCFullYear(), nowY - 25);
  const yHi = Math.max(new Date(hi * 1000).getUTCFullYear(), nowY + 1);
  const ref = Replay.isActive() ? Replay.cursor() : hi;
  const refD = new Date(ref * 1000);
  const cur = { y: refD.getUTCFullYear(), m: refD.getUTCMonth() + 1, d: refD.getUTCDate() };

  let ys = '';
  for (let y = yLo; y <= yHi; y++) ys += '<option value="' + y + '">' + y + '</option>';
  let ms = '';
  MONTHS.forEach((m, i) => { ms += '<option value="' + (i + 1) + '">' + m + '</option>'; });

  /* --- Custom Session pane (lives INSIDE Go to Date per the user request) --- */
  let def = null;
  try { def = U.lsGet('mt5_rp_session', null); } catch (e) {}
  let dTo = 0;
  for (const pane of App.panes) {
    const t = pane.barTimes && pane.barTimes.length ? pane.barTimes[pane.barTimes.length - 1] : 0;
    if (t > dTo) dTo = t;
  }
  if (!(dTo > 0)) dTo = Math.floor(Date.now() / 1000);
  const dToDay = Math.floor(dTo / DAY);
  const csCfg = {
    hFrom: def && isFinite(def.hFrom) ? def.hFrom : 3,
    hTo: def && isFinite(def.hTo) ? def.hTo : 5,
    mFrom: def && isFinite(def.mFrom) ? def.mFrom : 0,
    mTo: def && isFinite(def.mTo) ? def.mTo : 0,
    dFrom: def && isFinite(def.dFrom) ? def.dFrom : dToDay - 9,
    dTo: def && isFinite(def.dTo) ? def.dTo : dToDay,
  };
  let hours = '';
  for (let h = 0; h <= 24; h++) hours += '<option value="' + h + '">' + pad2(h) + '</option>';
  /* round 87: minute pickers — the user asked to select minutes as well as
     hours ("الان فقط ساعت رو میشه مشخص کرد . میخوام دقیقه رو هم بشه مشخص کرد") */
  let minutes = '';
  for (let m = 0; m <= 59; m++) minutes += '<option value="' + m + '">' + pad2(m) + '</option>';

  dlg.innerHTML = '<h3>Go to Date<button class="mini-btn dlg-x" title="Close">&#10005;</button></h3>' +
    '<div class="gd-tabs">' +
    '<button class="gd-tab on" id="gd-tab-date">Go to date</button>' +
    '<button class="gd-tab" id="gd-tab-cs">Custom Session</button></div>' +

    /* ---- tab 1: the date jump ---- */
    '<div id="gd-pane-date">' +
    '<div class="dlg-hint">Jumps every chart — or the Bar Replay cursor — to the selected day. Loaded data: ' +
    new Date(lo * 1000).toISOString().slice(0, 10) + ' → ' + new Date(hi * 1000).toISOString().slice(0, 10) +
    '. Dates outside it are fetched from the provider.</div>' +
    '<div class="dlg-row gd-row3"><label>Year<select id="gd-y">' + ys + '</select></label>' +
    '<label>Month<select id="gd-m">' + ms + '</select></label>' +
    '<label>Day<select id="gd-d"></select></label></div>' +
    '<div class="dlg-row gd-modes">' +
    '<label class="gd-mode"><input type="radio" name="gd-mode" value="view" checked>View that date</label>' +
    '<label class="gd-mode"><input type="radio" name="gd-mode" value="replay">Start Bar Replay there</label></div>' +
    '<div class="dlg-hint" id="gd-mode-info"></div>' +
    '<div class="dlg-actions"><button class="dlg-btn dlg-ghost" id="gd-cancel">Cancel</button>' +
    '<button class="dlg-btn dlg-primary" id="gd-go">Go</button></div>' +
    '</div>' +

    /* ---- tab 2: Custom Session (stitched hours) ---- */
    '<div id="gd-pane-cs" class="hidden">' +
    '<div class="dlg-hint">Takes the selected hour:minute window from every day in the range and lays the candles side by side (a small gap separates the day regions). Dates follow the chart time axis.</div>' +
    '<div class="dlg-row"><label>From (hour:minute)<span class="gd-hm"><select id="cs-hfrom">' + hours + '</select><span class="gd-hm-sep">:</span>' +
    '<select id="cs-mfrom">' + minutes + '</select></span></label>' +
    '<label>To (hour:minute, exclusive)<span class="gd-hm"><select id="cs-hto">' + hours + '</select><span class="gd-hm-sep">:</span>' +
    '<select id="cs-mto">' + minutes + '</select></span></label></div>' +
    '<div class="dlg-row"><label>From date<input type="date" id="cs-dfrom"></label>' +
    '<label>To date<input type="date" id="cs-dto"></label></div>' +
    '<div class="dlg-hint" id="cs-info"></div>' +
    '<div class="dlg-actions">' +
    (SessionRange.isActive() ? '<button class="dlg-btn dlg-ghost" id="cs-clear">Turn off</button>' : '') +
    '<button class="dlg-btn dlg-ghost" id="cs-cancel">Cancel</button>' +
    '<button class="dlg-btn dlg-primary" id="cs-apply">Apply</button></div>' +
    '</div>';

  /* ---- tab switching ---- */
  const paneDate = dlg.querySelector('#gd-pane-date');
  const paneCs = dlg.querySelector('#gd-pane-cs');
  const tabDate = dlg.querySelector('#gd-tab-date');
  const tabCs = dlg.querySelector('#gd-tab-cs');
  const showTab = (which) => {
    const date = which !== 'cs';
    paneDate.classList.toggle('hidden', !date);
    paneCs.classList.toggle('hidden', date);
    tabDate.classList.toggle('on', date);
    tabCs.classList.toggle('on', !date);
  };
  tabDate.addEventListener('click', () => showTab('date'));
  tabCs.addEventListener('click', () => showTab('cs'));
  showTab(tab === 'cs' ? 'cs' : 'date');

  /* ---- date pane logic ---- */
  const selY = dlg.querySelector('#gd-y');
  const selM = dlg.querySelector('#gd-m');
  const selD = dlg.querySelector('#gd-d');
  selY.value = String(Math.min(Math.max(cur.y, yLo), yHi));
  selM.value = String(cur.m);
  const fillDays = () => {
    const y = parseInt(selY.value, 10) || cur.y;
    const m = parseInt(selM.value, 10) || cur.m;
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let opts = '';
    for (let d = 1; d <= dim; d++) opts += '<option value="' + d + '">' + pad2(d) + '</option>';
    selD.innerHTML = opts;
    selD.value = String(Math.min(cur.d, dim));
  };
  fillDays();
  selY.addEventListener('change', fillDays);
  selM.addEventListener('change', fillDays);

  const modeInfo = dlg.querySelector('#gd-mode-info');
  const updModeInfo = () => {
    const mode = (dlg.querySelector('input[name="gd-mode"]:checked') || {}).value || 'view';
    const pane = App.activePane || App.panes[0];
    const tf = pane ? App.tfById[pane.tf] : null;
    if (mode === 'replay' && tf) {
      const capDays = Math.max(1, Math.floor(MAX_FETCH_BARS * tf.sec / DAY));
      modeInfo.textContent = 'Loads history FROM that day to the present on every chart and starts the replay there (~' +
        capDays + ' days max on ' + (tf.label || pane.tf) + '; higher timeframes reach further). The demo account (right rail → Replay Trading) trades on it.';
    } else {
      modeInfo.textContent = '';
    }
  };
  Array.from(dlg.querySelectorAll('input[name="gd-mode"]')).forEach((r) => r.addEventListener('change', updModeInfo));
  updModeInfo();

  const close = () => { layer.classList.add('hidden'); U.clear(layer); };
  dlg.querySelector('.dlg-x').addEventListener('click', close);
  [dlg.querySelector('#gd-cancel'), dlg.querySelector('#cs-cancel')].forEach((b) => {
    if (b) b.addEventListener('click', close);
  });
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  [selY, selM, selD].forEach((el) => el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') dlg.querySelector('#gd-go').click();
    if (e.key === 'Escape') close();
  }));
  dlg.querySelector('#gd-go').addEventListener('click', () => {
    const y = parseInt(selY.value, 10), m = parseInt(selM.value, 10), d = parseInt(selD.value, 10);
    if (!(y > 0 && m > 0 && d > 0)) return;
    const t = Math.floor(Date.UTC(y, m - 1, d) / 1000);   // 00:00 of that day (chart axis frame)
    const mode = (dlg.querySelector('input[name="gd-mode"]:checked') || {}).value || 'view';
    close();
    if (mode === 'replay') GoToDate.jumpReplayFrom(t);
    else GoToDate.jump(t);
  });
  setTimeout(() => { try { selY.focus(); } catch (e) {} }, 40);

  /* ---- Custom Session pane logic (same fields as the former dialog) ---- */
  const hFrom = dlg.querySelector('#cs-hfrom');
  const hTo = dlg.querySelector('#cs-hto');
  const mFrom = dlg.querySelector('#cs-mfrom');
  const mTo = dlg.querySelector('#cs-mto');
  const dFrom = dlg.querySelector('#cs-dfrom');
  const dTo2 = dlg.querySelector('#cs-dto');
  const info = dlg.querySelector('#cs-info');
  hFrom.value = String(csCfg.hFrom);
  hTo.value = String(csCfg.hTo);
  mFrom.value = String(csCfg.mFrom);
  mTo.value = String(csCfg.mTo);
  dFrom.value = ymdInput(csCfg.dFrom);
  dTo2.value = ymdInput(csCfg.dTo);
  const readInfo = () => {
    /* getTime() is MILLISECONDS — /1000 first, then the DAY (seconds) divisor.
       The ROUND86 dialog divided ms by the second-based DAY directly, so every
       apply computed a ~1000x-too-long range and was ALWAYS rejected with
       "range too long" — the dialog path could never apply (ROUND86B fix). */
    const df = Math.floor(new Date(dFrom.value + 'T00:00:00Z').getTime() / 1000 / DAY);
    const dt = Math.floor(new Date(dTo2.value + 'T00:00:00Z').getTime() / 1000 / DAY);
    const days = dt - df + 1;
    if (!(days > 0)) { info.textContent = 'Invalid range'; return null; }
    const sFrom = (parseInt(hFrom.value, 10) || 0) * 3600 + (parseInt(mFrom.value, 10) || 0) * 60;
    const sTo = Math.min(86400, (parseInt(hTo.value, 10) || 0) * 3600 + (parseInt(mTo.value, 10) || 0) * 60);
    if (!(sTo > sFrom)) { info.textContent = 'The end time must be after the start time'; return null; }
    const p2 = (v) => String(v).padStart(2, '0');
    const winMin = Math.round((sTo - sFrom) / 60);
    const winLbl = Math.floor(winMin / 60) + 'h ' + p2(winMin % 60) + 'm';
    const fromLbl = p2(Math.floor(sFrom / 3600)) + ':' + p2(Math.floor(sFrom % 3600 / 60));
    const toLbl = p2(Math.floor(sTo / 3600)) + ':' + p2(Math.floor(sTo % 3600 / 60));
    const b = SessionRange.pickBase(days);
    /* ROUND88: the window + dates are interpreted in the CHART's timezone —
       say which zone that is right on the info line */
    const tzLbl = !App.tz || App.tz === 'broker' ? 'broker time' : App.tz.replace(/_/g, ' ');
    info.textContent = days + ' day(s) × ' + fromLbl + '–' + toLbl + ' (' + winLbl + ') window · ' + tzLbl +
      ' · base ' + b.id +
      ' · ≈' + Math.round(days * DAY / b.sec).toLocaleString('en') + ' base bars';
    return { hFrom: parseInt(hFrom.value, 10) || 0, hTo: parseInt(hTo.value, 10) || 0,
      mFrom: parseInt(mFrom.value, 10) || 0, mTo: parseInt(mTo.value, 10) || 0, dFrom: df, dTo: dt };
  };
  [hFrom, hTo, mFrom, mTo, dFrom, dTo2].forEach((el) => el.addEventListener('change', () => readInfo()));
  [hFrom, hTo, mFrom, mTo, dFrom, dTo2].forEach((el) => el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') dlg.querySelector('#cs-apply').click();
    if (e.key === 'Escape') close();
  }));
  readInfo();
  const clearBtn = dlg.querySelector('#cs-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => { SessionRange.clear(); close(); });
  dlg.querySelector('#cs-apply').addEventListener('click', () => {
    const c = readInfo();
    if (!c) return;
    SessionRange.apply(c);
    close();
  });
};

/* ---------- Custom Session helpers (shared with the session pane) ---------- */

function ymdOfDay(dayNum) {
  const d = new Date(dayNum * DAY * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
function ymdInput(dayNum) {
  const p = ymdOfDay(dayNum);
  return p.y + '-' + pad2(p.m) + '-' + pad2(p.d);
}

/* ---------- public API ---------- */

GoToDate.jump = function (t) {
  t = Math.floor(t);
  if (Replay.isActive()) {
    const ok = Replay.jumpTo(t);
    UI.toast(ok ? 'Replay jumped to ' + new Date(t * 1000).toISOString().slice(0, 10) : 'Replay jump failed',
      ok ? 'ok' : 'warn');
    return;
  }
  let any = false;
  for (const pane of App.panes) {
    try { jumpPane(pane, t); any = true; } catch (e) {}
  }
  if (any) UI.toast('Go to Date: ' + new Date(t * 1000).toISOString().slice(0, 10), 'ok');
};

GoToDate.jumpReplayFrom = function (t) { jumpReplayFrom(Math.floor(t)); };

/* e2e hook */
GoToDate.inGdView = anyGdView;

GoToDate.init = function () {
  const btn = document.getElementById('goto-date-btn');
  if (!btn || btn.dataset.rttWired) return;
  btn.dataset.rttWired = '1';
  btn.innerHTML = icon('calendar');
  btn.title = 'Go to Date — jump the chart (or Bar Replay) to a year / month / day';
  btn.addEventListener('click', () => GoToDate.openDialog());

  /* Custom Session opens INSIDE this dialog now (second tab) — same
     entry point the top-bar clock button uses */
  SessionRange.openDialog = function () { GoToDate.openDialog('cs'); };

  /* any natural reload (TF switch, symbol switch, session apply/clear,
     reconnect, stale heal) leaves the historical-view state */
  const prevLoad = Manager.loadBars;
  Manager.loadBars = function (pane) {
    try { clearPaneView(pane); } catch (e) {}
    return prevLoad.call(Manager, pane);
  };
};

/* ---------- helpers shared with the custom-TF branch ---------- */

function pickCustomBase(tf) {
  const cands = [
    { id: 'M1', sec: 60 }, { id: 'M5', sec: 300 }, { id: 'M15', sec: 900 },
    { id: 'M30', sec: 1800 }, { id: 'H1', sec: 3600 }, { id: 'H4', sec: 14400 },
    { id: 'D1', sec: 86400 },
  ];
  for (const c of cands) {
    if (c.sec < tf.sec && tf.sec % c.sec === 0) return c;
  }
  return cands[0];
}

function aggregateBy(bars, tf) {
  const out = [];
  let cur = null, ct = -1;
  for (const b of bars) {
    if (!b || !isFinite(b.time) || !isFinite(b.open) || !isFinite(b.high) ||
        !isFinite(b.low) || !isFinite(b.close)) continue;
    const a = Manager.bucketStartFor(tf, b.time);
    if (!cur || a !== ct) {
      if (cur) out.push(cur);
      ct = a;
      cur = { time: a, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
    } else {
      if (b.high > cur.high) cur.high = b.high;
      if (b.low < cur.low) cur.low = b.low;
      cur.close = b.close;
      cur.volume += b.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export { GoToDate };
