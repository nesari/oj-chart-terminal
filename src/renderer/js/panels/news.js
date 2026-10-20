/**
 * Economic News (right-rail panel + chart marks)
 *
 * Provider calendar (Feed.news) -> tickable Impact/Currency filters ->
 * vertical flag marks on the chart through App.overlayMarkPainters (drawn by
 * the engine's per-frame render pass, so pan/zoom/ticks never leave stale
 * marks). Master switch + per-category checkboxes persist in localStorage.
 *
 * @module panels/news
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { App } from '../../../core/state.js';
import { TZ } from '../../../core/timezone.js';
import { axisTimeTag } from '../drawing/tools.js';

const IMPACTS = [['high', 'High'], ['med', 'Medium'], ['low', 'Low']];
const CCYS = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF', 'CNY'];
const IMP_COL = { high: '#f23645', med: '#f7c948', low: '#787b86' };
/* ROUND66 (user request): personalised day range — show on the chart ONLY the
   news of the period the user picks (tomorrow / today / the current week /
   last week), so a busy calendar never clutters the chart. Single-select,
   'all' by default. Applies to the chart lines/pills AND the panel list
   (both render from News.visible). */
const DAYS = [['all', 'All'], ['today', 'Today'], ['tomorrow', 'Tomorrow'],
  ['thisweek', 'This week'], ['lastweek', 'Last week']];
const MONTH_IDX = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

const News = {
  cfg: null,
  items: [],
  loaded: false,
};

/* ROUND 62 (user request): first-open defaults are ALL OFF — the chart must
   be clean the first time the user opens it; each filter is opt-in. A saved
   cfg (user who deliberately ticked things) still wins over these defaults.
   ROUND68: `hover` (tag-hover title tooltip) DEFAULTS ON — the user asked
   for the hover summary itself; the panel switch turns it off.
   ROUND131 (user request): `lines` — the vertical dashed per-event lines
   have their OWN switch (default ON, they are the primary chart visual);
   and the master `on` switch now governs ONLY the chart painting — the
   calendar list below always renders (the two were wrongly coupled). */
const DEF_CFG = { on: false, lines: true, hilite: false, hover: true, day: 'all',
  impact: { high: true, med: true, low: true },
  ccy: {} };
CCYS.forEach((c) => { DEF_CFG.ccy[c] = true; });

function save() { U.lsSet('mt5_news_cfg', News.cfg); }

/* ---------- filtering ---------- */
/* ROUND66: local (chart-timezone) day serial — derived from the SAME
   TZ.partsUtc funnel the day headers render with, so the selector's
   "today / this week" and the list's day groups can never disagree.
   Monday-based week index: (serial + 3) / 7 — the epoch (Thu) keeps the
   days before it in week 0, every Monday starts a new week. */
function daySerial(utcSec) {
  const p = TZ.partsUtc(App.tz, utcSec);
  return Math.floor(Date.UTC(+p.year || 1970,
    MONTH_IDX[p.monthShort] != null ? MONTH_IDX[p.monthShort] : 0,
    +p.day || 1) / 86400000);
}
function inDayRange(utcSec, range) {
  if (!range || range === 'all') return true;
  const s = daySerial(utcSec);
  const n = daySerial(Math.floor(Date.now() / 1000));
  if (range === 'today') return s === n;
  if (range === 'tomorrow') return s === n + 1;
  const wk = (x) => Math.floor((x + 3) / 7);
  if (range === 'thisweek') return wk(s) === wk(n);
  if (range === 'lastweek') return wk(s) === wk(n) - 1;
  return true;
}
News.visible = function () {
  /* ROUND131: the LIST is decoupled from the master chart switch — visibility
     here means "matches the active filters", nothing else. The chart painter
     (paintNews) applies cfg.on on top of this for the CHART visuals only. */
  if (!News.cfg || !News.loaded) return [];
  const day = News.cfg.day || 'all';
  return News.items.filter((e) =>
    News.cfg.impact[e.impact] !== false && News.cfg.ccy[e.currency] !== false &&
    inDayRange(e.time, day));
};

/* ---------- fetching ---------- */
News.load = async function () {
  try {
    const items = await App.feed.news();
    News.items = Array.isArray(items) ? items : [];
    News.loaded = true;
    renderList();
    renderCount();
  } catch (e) {
    /* provider without the news hook (old backend): stay silent, show empty */
    News.loaded = News.loaded || false;
    renderList();
    renderCount();
  }
};

/* ---------- chart marks painter ----------
   ROUND 64 (user report — the r63 contract could still paint wrong lines):
   the OLD wire contract pre-shifted the stamps ONCE at the PROVIDER with the
   offset captured at FETCH time, and the renderer then displayed them as
   chart stamps ("broker offset already baked in"). That bakes TWO independent
   clocks into one line: the provider's estimate at fetch moment (0 on a
   fresh boot before the first measurement, or a stale persisted value after
   a weekend restart) and the client's live feed.serverOff. The moment those
   disagree — fresh boot, offset re-measured, broker DST change, server
   switch — every news line sat exactly the difference away from the bar
   where the release actually happened, no matter the chart timezone.
   NEW contract (user's funnel, one clock): the wire carries TRUE UTC
   (provider no longer shifts — provider_common 'news' handler, r64); HERE,
   at render time, the broker offset is calculated/applied exactly ONCE
   through the SAME live feed.serverOff the axis, crosshair and clock use:
     x position / locate : ev.time + serverOff  -> the server-label bar the
                           release really happened on
     chip / panel clocks : TZ.partsUtc (utc + serverOff -> true UTC -> the
                           user's selected chart timezone)
   A late-measured offset now heals the LINES, the chips and the panel live
   (News re-renders on onBrokerOff). */
function evChart(ev) {
  const off = (App.feed && App.feed.serverOff) || 0;
  return ev.time + off;
}

function paintNews(pane, v, ctx) {
  pane._newsChips = null; pane._newsTip = null; /* rebuilt (or dropped) EVERY frame */
  if (!News.cfg || !News.cfg.on || !News.loaded) return;
  const evs = News.visible();
  if (!evs.length) return;
  const lanes = v._markLanes || (v._markLanes = []);
  const placed = [];
  for (const ev of evs) {
    const x = v.xOf(evChart(ev));
    if (x < -60 || x > v.pw + 60) continue;
    /* ROUND131: the vertical dashed lines have their OWN switch — the chips,
       axis pills and hover titles stay under the master "Show on chart" */
    if (News.cfg.lines !== false) {
      ctx.save();
      ctx.strokeStyle = IMP_COL[ev.impact] || IMP_COL.low;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, v.ph);
      ctx.stroke();
      ctx.restore();
    }
    placed.push({ ev, x });
  }
  /* ROUND66 (user request): the news TIME highlight on the time-axis bar —
     opt-in via the panel switch ("Axis bar highlight"), painted into the SAME
     always-above DOM layer the drawn vertical lines use (.tax-tags above the
     .tax-ext numbers), impact-coloured, showing the SAME clock as the chip
     (TZ.partsUtc — the one true-UTC funnel). Cleared + rebuilt by the engine
     every frame, so pan/zoom/filters never leave a stale pill. */
  if (News.cfg.hilite) {
    const t66 = App.tz;
    /* ROUND67 (user): several events can share one minute — the TIME goes on
       the axis bar exactly ONCE for that minute (highest impact wins the
       colour); the per-event currencies stay in the tags above the chart.
       Dedupe key = the chart time through the SAME one-clock funnel. */
    const RANK = { high: 0, med: 1, low: 2 };
    const best = new Map();
    for (const { ev } of placed) {
      const k = evChart(ev);
      const cur = best.get(k);
      if (!cur || (RANK[ev.impact] ?? 2) < (RANK[cur.impact] ?? 2)) best.set(k, ev);
    }
    for (const ev of best.values()) {
      const x = v.xOf(evChart(ev));
      const p66 = TZ.partsUtc(t66, ev.time);
      /* ROUND68: noClamp — the pill follows its OWN minute; panned off the
         display it disappears instead of sticking to the edge. */
      axisTimeTag(v, x, `${p66.hour}:${p66.minute}`, IMP_COL[ev.impact] || IMP_COL.low,
        'news-pill' + (ev.impact === 'med' ? ' med' : ''), true);
    }
  }
  /* chips last so they sit above every line */
  ctx.save();
  ctx.setLineDash([]);
  ctx.textBaseline = 'middle';
  /* ROUND67 (user): the tag above the chart carries the CURRENCY only —
     the time lives on the time-axis bar (once per minute, see above), so
     the same minute never paints twice on the chart. */
  const chips = []; /* ROUND68: hit rects for the hover tooltip (per pane) */
  for (const { ev, x } of placed) {
    const label = ev.currency;
    ctx.font = '600 9.5px "Segoe UI", Arial, sans-serif';
    const w = ctx.measureText(label).width + 12;
    let lane = 0;
    while (lane < 4 && lanes.some((b) => b.lane === lane && x < b.x1 + 6 && x + w > b.x0 - 6)) lane++;
    if (lane >= 4) continue; // too dense — line only
    const y = 4 + lane * 15;
    lanes.push({ lane, x0: x, x1: x + w });
    chips.push({ x0: x, y0: y, x1: x + w, y1: y + 13, w, ev });
    const col = IMP_COL[ev.impact] || IMP_COL.low;
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = col;
    ctx.beginPath();
    (ctx.roundRect ? ctx.roundRect(x, y, w, 13, 3) : ctx.rect(x, y, w, 13));
    ctx.fill();
    ctx.fillStyle = ev.impact === 'med' ? '#1c2030' : '#ffffff';
    ctx.fillText(label, x + 6, y + 7);
  }
  ctx.restore();
  pane._newsChips = chips;
  /* ROUND68 (user request): hovering a currency tag shows the news TITLE
     ("Core CPI") as a summary. Canvas-drawn (theme-aware -> dark AND light,
     and it reaches the app's own snapshots like every chart layer), hit-
     tested against the tag rects EVERY frame, so it follows the pointer
     and vanishes the moment the pointer leaves the tag or the pane.
     Multi-chart: the hover position is pane-scoped (pane._newsHover). */
  if (News.cfg.hover && pane._newsHover && chips.length) {
    const m = pane._newsHover;
    const hit = chips.find((c) => m.x >= c.x0 && m.x <= c.x1 && m.y >= c.y0 && m.y <= c.y1);
    if (hit) pane._newsTip = drawTip(ctx, v, hit, hit.ev);
  }
}

/* ROUND68: tag-hover tooltip — colours follow the active theme (body.theme-light,
   the same class Theme.apply toggles), so both modes render correctly. */
function tipColors() {
  const light = document.body.classList.contains('theme-light');
  return light
    ? { bg: '#ffffff', fg: '#131722', bd: '#c9cdd6', sh: 'rgba(0,0,0,0.14)' }
    : { bg: '#2a2e39', fg: '#d1d4dc', bd: '#434651', sh: 'rgba(0,0,0,0.5)' };
}
function drawTip(ctx, v, c, ev) {
  const col = tipColors();
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = '600 10px "Segoe UI", Arial, sans-serif';
  let txt = String(ev.name || ev.currency || '');
  const MAX = 240;
  if (ctx.measureText(txt).width > MAX) {
    while (txt.length > 4 && ctx.measureText(txt + '…').width > MAX) txt = txt.slice(0, -1);
    txt += '…';
  }
  const tw = ctx.measureText(txt).width;
  const w = tw + 14, h = 17;
  let tx = Math.min(Math.max(c.x0 + c.w / 2 - w / 2, 2), Math.max(2, v.pw - w - 2));
  let ty = c.y0 - h - 3;
  if (ty < 2) ty = c.y1 + 4;
  ctx.globalAlpha = 1;
  ctx.shadowColor = col.sh; ctx.shadowBlur = 6; ctx.shadowOffsetY = 2;
  ctx.fillStyle = col.bg;
  ctx.beginPath();
  (ctx.roundRect ? ctx.roundRect(tx, ty, w, h, 4) : ctx.rect(tx, ty, w, h));
  ctx.fill();
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.lineWidth = 1; ctx.strokeStyle = col.bd;
  ctx.stroke();
  ctx.fillStyle = col.fg;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(txt, tx + 7, ty + h / 2 + 0.5);
  ctx.restore();
  return { text: txt, bg: col.bg, fg: col.fg };
}

/* click a row -> centre every main pane on the event time (TV "go to") */
News.locate = function (ev) {
  const target = evChart(ev); /* true UTC + live broker offset -> the real bar (ROUND 64) */
  for (const pane of App.panes) {
    try {
      const l = U.timeToLogical(pane.barTimes, target);
      if (!isFinite(l)) continue;
      const ts = pane.chart.timeScale();
      const cur = ts.getVisibleLogicalRange();
      const span = cur ? (cur.to - cur.from) : 160;
      ts.setVisibleLogicalRange({ from: l - span / 2, to: l + span / 2 });
    } catch (e) {}
  }
};

/* ---------- panel ---------- */
function chipRow(host, entries, get, set) {
  U.clear(host);
  for (const [key, label] of entries) {
    const lb = U.el('label', 'nf-chip' + (get(key) ? ' on' : ''), host);
    const cb = U.el('input', '', lb);
    cb.type = 'checkbox';
    cb.checked = !!get(key);
    U.el('span', '', lb).textContent = label;
    cb.addEventListener('change', () => { set(key, cb.checked); save(); refresh(); });
  }
}

function renderFilters() {
  if (!News.cfg) return;
  const on = document.getElementById('news-on');
  if (on && on.checked !== !!News.cfg.on) on.checked = !!News.cfg.on;
  /* ROUND131: the vertical dashed lines switch + the master-off dim state */
  const lin = document.getElementById('news-lines');
  if (lin && lin.checked !== (News.cfg.lines !== false)) lin.checked = News.cfg.lines !== false;
  const master = document.querySelector('.news-master');
  if (master) master.classList.toggle('news-off', !News.cfg.on);
  /* ROUND66: the axis-bar highlight switch + the day-range chips */
  const hil = document.getElementById('news-hilite');
  if (hil && hil.checked !== !!News.cfg.hilite) hil.checked = !!News.cfg.hilite;
  /* ROUND68: the tag-hover title switch (default ON) */
  const hov = document.getElementById('news-hover');
  if (hov && hov.checked !== !!News.cfg.hover) hov.checked = !!News.cfg.hover;
  renderDays();
  chipRow(document.getElementById('news-impacts'), IMPACTS,
    (k) => News.cfg.impact[k] !== false, (k, val) => { News.cfg.impact[k] = val; });
  chipRow(document.getElementById('news-ccys'), CCYS.map((c) => [c, c]),
    (k) => News.cfg.ccy[k] !== false, (k, val) => { News.cfg.ccy[k] = val; });
}

/* ROUND66: single-select day-range chips (All / Today / Tomorrow /
   This week / Last week) — the personalised chart de-cluttering the user
   asked for; picking a range immediately refilters the list AND the chart
   marks (both render from News.visible). */
function renderDays() {
  const host = document.getElementById('news-days');
  if (!host) return;
  U.clear(host);
  const cur = News.cfg.day || 'all';
  for (const [key, label] of DAYS) {
    const b = U.el('button', 'day-chip' + (cur === key ? ' on' : ''), host);
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => {
      if (News.cfg.day === key) return;
      News.cfg.day = key;
      save();
      refresh();
    });
  }
}

function renderCount() {
  const el = document.getElementById('news-count');
  if (!el) return;
  const shown = News.visible().length;
  el.textContent = News.loaded ? `${shown} of ${News.items.length} events` : 'loading calendar…';
}

/* ROUND 64: panel clocks/days share the ONE true-UTC funnel (TZ.partsUtc —
   utc + serverOff -> chart stamp -> true UTC -> selected zone), the same
   live-offset pipeline as the axis, the crosshair and the flag chips; the
   wire carries TRUE UTC, so the broker offset is applied exactly once, at
   render time, no matter when the list was fetched. */
function fmtClock(sec) {
  const p = TZ.partsUtc(App.tz, sec);
  return `${p.hour}:${p.minute}`;
}
function dayKey(sec) {
  const p = TZ.partsUtc(App.tz, sec);
  return `${p.dow} ${p.day} ${p.monthShort}`;
}
function todayKey() {
  /* "now" as true UTC — the same base the wire stamps use */
  return dayKey(Math.floor(Date.now() / 1000));
}

/* ROUND131 (user request): the calendar renders as a clean GRID — every row
   carries the event's Forecast / Previous / Actual values in fixed, aligned
   columns under one sticky caption row, so the economic numbers scan like a
   professional calendar table instead of the old cramped one-liner.
   The shared grid template lives in CSS (.nl-head / .n-row). */
function nlHead(host) {
  const h = U.el('div', 'nl-head', host);
  h.innerHTML = '<span>Time</span><span></span><span>Event</span>' +
    '<span class="nl-r">Fcst</span><span class="nl-r">Prev</span><span class="nl-r">Act</span>';
  return h;
}
function renderList() {
  const box = document.getElementById('news-list');
  if (!box) return;
  U.clear(box);
  if (!News.loaded) {
    box.innerHTML = '<div class="news-empty">Loading calendar…</div>';
    return;
  }
  const evs = News.visible();
  if (!evs.length) {
    box.innerHTML = '<div class="news-empty">No events match the active filters.</div>';
    return;
  }
  nlHead(box);
  const today = todayKey();
  let lastDay = null;
  for (const ev of evs) {
    const dk = dayKey(ev.time);
    if (dk !== lastDay) {
      lastDay = dk;
      const h = U.el('div', 'n-day', box);
      h.textContent = (dk === today ? 'Today · ' : '') + dk;
    }
    const row = U.el('button', 'n-row', box);
    const impLvl = IMP_COL[ev.impact] ? ev.impact : 'low'; // whitelisted key only
    const bars = { high: 3, med: 2, low: 1 }[ev.impact] || 1;
    /* SECURITY: ev.* comes from the provider's calendar feed (provider/*.py),
       not from a hardcoded literal — any field derived from it must be
       HTML-escaped before it lands in innerHTML, or a malformed/compromised
       feed payload can inject markup that executes in the renderer.
       fmtClock()/imp/bars are internal values, not feed strings, so they
       stay as-is. */
    const hasActual = ev.actual !== '' && ev.actual != null;
    row.innerHTML =
      `<span class="n-time">${fmtClock(ev.time)}</span>` +
      `<span class="n-imp n-imp-${impLvl}" title="${U.esc(ev.impact)} impact">${[1, 2, 3].map((i) =>
        `<i class="${i <= bars ? 'n-imp-bar-on' : 'n-imp-bar-off'}"></i>`).join('')}</span>` +
      `<span class="n-main">` +
        `<span class="n-name" title="${U.esc(ev.name)}">${U.esc(ev.name)}</span>` +
        `<span class="n-ccy">${U.esc(ev.currency)}</span>` +
      `</span>` +
      `<span class="n-val n-f" title="Forecast">${ev.forecast ? U.esc(ev.forecast) : '—'}</span>` +
      `<span class="n-val n-p" title="Previous">${ev.previous ? U.esc(ev.previous) : '—'}</span>` +
      `<span class="n-val n-a ${hasActual ? 'n-a-have' : ''}" title="Actual">${hasActual ? U.esc(ev.actual) : '—'}</span>`;
    row.addEventListener('click', () => News.locate(ev));
  }
}

function refresh() { renderFilters(); renderList(); renderCount(); }

News.setAll = function (group, val) {
  if (!News.cfg) return;
  for (const k of Object.keys(News.cfg[group])) News.cfg[group][k] = val;
  save();
  refresh();
};

News.init = function () {
  /* deep-merge persisted cfg over defaults (storage may predate a currency);
     ROUND 62: `on` now defaults to FALSE — only an explicit saved true wins.
     ROUND 66: `hilite` (axis-bar highlight) and `day` (day range) join the
     same opt-in defaults; an unknown persisted day falls back to 'all'. */
  const st = U.lsGet('mt5_news_cfg', {}) || {};
  /* ROUND131 one-time migration: profiles saved before the list/chart
     decoupling carried the old opt-in defaults (every impact + currency
     filter explicitly false) — under the new "the list always renders"
     contract that reads as an empty calendar. A stamp gates the one-shot
     heal: untouched slates flip every filter ON; a cfg where the user
     deliberately ticked something keeps its values. */
  if (st.filtersMigrated !== true) {
    const anyOn = (o) => o && Object.values(o).some((v) => v === true);
    const impact = Object.assign({}, { high: false, med: false, low: false }, st.impact || {});
    const ccy0 = {}; CCYS.forEach((c) => { ccy0[c] = false; });
    const ccy = Object.assign(ccy0, st.ccy || {});
    if (!anyOn(impact) && !anyOn(ccy)) {
      st.impact = { high: true, med: true, low: true };
      st.ccy = {}; CCYS.forEach((c) => { st.ccy[c] = true; });
    }
    st.filtersMigrated = true;
    U.lsSet('mt5_news_cfg', st);
  }
  News.cfg = {
    on: st.on === true,
    lines: st.lines !== false, /* ROUND131: default ON — the switch turns it off */
    hilite: st.hilite === true,
    hover: st.hover !== false, /* ROUND68: default ON — the switch turns it off */
    day: DAYS.some((d) => d[0] === st.day) ? st.day : 'all',
    impact: Object.assign({}, DEF_CFG.impact, st.impact || {}),
    ccy: Object.assign({}, DEF_CFG.ccy, st.ccy || {}),
  };
  const on = document.getElementById('news-on');
  on.checked = !!News.cfg.on;
  on.addEventListener('change', () => { News.cfg.on = on.checked; save(); refresh(); });
  /* ROUND131: the vertical dashed news lines — a pure display preference of
     the chart view (the painter repaints every frame, so the lines appear /
     vanish on the next frame) */
  const lin = document.getElementById('news-lines');
  if (lin) {
    lin.checked = News.cfg.lines !== false;
    lin.addEventListener('change', () => { News.cfg.lines = lin.checked; save(); });
  }
  /* ROUND66: the axis-bar highlight is a pure display preference — the chart
     repaints every frame, so the pills appear/vanish on the next frame */
  const hil = document.getElementById('news-hilite');
  if (hil) {
    hil.checked = !!News.cfg.hilite;
    hil.addEventListener('change', () => { News.cfg.hilite = hil.checked; save(); });
  }
  /* ROUND68: the tag-hover title tooltip switch (default ON, persisted) */
  const hov = document.getElementById('news-hover');
  if (hov) {
    hov.checked = !!News.cfg.hover;
    hov.addEventListener('change', () => { News.cfg.hover = hov.checked; save(); });
  }
  const rf = document.getElementById('news-refresh');
  rf.innerHTML = icon('sync');
  rf.addEventListener('click', () => News.load());
  /* right-click a filter group: tick-all / clear-all that group */
  for (const [id, group] of [['news-impacts', 'impact'], ['news-ccys', 'ccy']]) {
    const el = document.getElementById(id);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const all = Object.values(News.cfg[group]).every((v) => v !== false);
      News.setAll(group, !all);
    });
  }
  renderFilters();
  renderList();
  renderCount();
  News.load();
  setInterval(() => { try { News.load(); } catch (e) {} }, 5 * 60 * 1000);
  /* ROUND 64: the broker offset was (re)measured — re-render the list so the
     row clocks/day headers follow the same live offset the chart does */
  if (App.feed) App.feed.onBrokerOff.push(() => { try { refresh(); } catch (e) {} });
  /* chart marks: register the painter consumed by engine.render() */
  App.overlayMarkPainters = App.overlayMarkPainters || [];
  if (!App.overlayMarkPainters.includes(paintNews)) App.overlayMarkPainters.push(paintNews);
  /* ROUND68: ONE document-level pointer tracker maps the cursor into every
     pane's overlay-canvas coordinates (multi-chart: each pane gets its own
     _newsHover; leaving a pane clears it, so the tooltip dies with the
     hover). paintNews hit-tests it against the tag rects every frame. */
  if (!News._hoverBound) {
    News._hoverBound = true;
    document.addEventListener('pointermove', (e) => {
      for (const pane of App.panes || []) {
        let hv = null;
        try {
          const cv = pane.engine && pane.engine.canvas;
          if (cv) {
            const r = cv.getBoundingClientRect();
            if (e.clientX >= r.left && e.clientX <= r.right &&
                e.clientY >= r.top && e.clientY <= r.bottom) {
              hv = { x: e.clientX - r.left, y: e.clientY - r.top };
            }
          }
        } catch (err) {}
        pane._newsHover = hv;
      }
    }, true);
  }
};

export { News };
