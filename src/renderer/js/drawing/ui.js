/**
 * Left toolbar (TV look), favorites floating bar, drawing context bar
 *
 * @module drawing/ui
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { App } from '../../../core/state.js';
import { TZ } from '../../../core/timezone.js';
import { Theme } from '../core/theme.js';
import { Settings } from '../chart/settings.js';
import { DrawSettings } from './settings.js';
import { CTX_LAYOUT, TOOLS } from './tools.js';
import { Manager } from '../chart/manager.js';
import { Toolbar } from '../chart/toolbar.js';
import { Alerts } from '../panels/alerts.js';
import { ObjectTree } from '../panels/objects.js';

const UI = {};

  /* Round 23 regroup (user request):
     - 'lines'  = trend-line tools + anchored lines + Info Line in ONE list
     - 'shapes' = rectangles/shapes + Text/annotations in ONE list
     - 'gannelliott' = Gann + Elliott in ONE flyout with TWO labelled sections
     Everything else is untouched. */
  const GROUPS = [
    { id: 'cursor', base: 'cross', tools: ['cross', 'arrowcur', 'dot'] },
    /* ROUND 52 (user request): the trend-line flyout now mirrors the
       TradingView reference screenshot EXACTLY — three labelled sections
       LINES / CHANNELS / PITCHFORKS in TV order with the missing tools
       added (Trend Angle, Regression Trend, Flat Top/Bottom, Disjoint
       Channel + the four Pitchforks). Nothing was removed: our existing
       Arrow stays at the end of the LINES section. The pitchforks also
       remain in the Gann & Fibonacci flyout (shared tool ids, favorites
       and settings untouched). */
    { id: 'lines', base: 'trend', sections: [
      { title: 'Lines', tools: ['trend', 'ray', 'infoline', 'extended', 'trendangle', 'hline', 'hray', 'vline', 'crossline', 'arrow'] },
      { title: 'Channels', tools: ['parallel', 'regression', 'flattop', 'disjoint'] },
      { title: 'Pitchforks', tools: ['pitchfork', 'pitchfork_s', 'pitchfork_ms', 'pitchfork_i'] },
    ] },
    /* ROUND 58 (user request): the fibs flyout now mirrors the TradingView
       reference screenshot EXACTLY — two labelled sections FIBONACCI / GANN
       in exact TV order with the missing tools added (Fib Time Zone, Fib
       Speed Resistance Fan, Trend-Based Fib Time, Fib Spiral, Fib Speed
       Resistance Arcs, Fib Wedge, Pitchfan). Nothing was removed: the four
       Pitchforks keep their own third section at the bottom, and the Gann
       tools also remain in the Gann & Elliott flyout (shared tool ids,
       favorites and settings untouched). */
    { id: 'fibs', base: 'fib', sections: [
      { title: 'Fibonacci', tools: ['fib', 'fibext', 'fibchannel', 'fibtz', 'fibspeedfan', 'fibttime', 'fibcircles', 'fibspiral', 'fibarcs', 'fibwedge', 'pitchfan'] },
      { title: 'Gann', tools: ['gannbox', 'gannsquaref', 'gannsquare', 'gannfan'] },
      { title: 'Pitchforks', tools: ['pitchfork', 'pitchfork_s', 'pitchfork_ms', 'pitchfork_i'] },
    ] },
    /* ROUND 61 (user request): this flyout now mirrors the TradingView
       reference screenshot EXACTLY — three labelled sections CHART PATTERNS
       / ELLIOTT WAVES / CYCLES in exact TV order. Nothing lost: the four
       Gann tools live on unchanged in the fibs flyout's GANN section, and
       every pattern/Elliott engine keeps its id, template and settings.
       Cycles are three NEW researched tools (Cyclic lines, Time cycles,
       Sine line) implemented in tools2.js like TV. */
    { id: 'gannelliott', base: 'patwaves', sections: [
      { title: 'Chart Patterns', tools: ['xabcd', 'cypher', 'hs', 'abcd', 'trianglepat', 'threedrives'] },
      { title: 'Elliott Waves', tools: ['elliott_i', 'elliott_c', 'elliott_t', 'elliott_wxy', 'elliott_wxyxz'] },
      { title: 'Cycles', tools: ['cycliclines', 'timecycles', 'sineline'] },
    ] },
    /* ROUND 62 (user request): this flyout now mirrors the TradingView
       reference screenshot EXACTLY — three labelled sections FORECASTING /
       VOLUME-BASED / MEASURERS in exact TV order, TV-style icons. Nothing
       lost: Regression Trend keeps its place in the lines flyout's CHANNELS
       section (shared tool id, r52), and the volume-profile engine id stays
       the same (display name now matches TV). Seven tools are NEW researched
       implementations in tools2.js (Position forecast, Bars pattern, Ghost
       feed, Sector, Anchored VWAP, Anchored volume profile + the three
       Measurers). */
    { id: 'forecast', base: 'forecastg', sections: [
      { title: 'Forecasting', tools: ['positionl', 'positions', 'posforecast', 'barspattern', 'ghostfeed', 'sector'] },
      { title: 'Volume-based', tools: ['avwap', 'volprofile', 'avolprofile'] },
      { title: 'Measurers', tools: ['pricerange', 'daterange', 'datepricerange'] },
    ] },
    /* ROUND 69 (user request + reference screenshots 007/008): this flyout
       now mirrors the TradingView reference screenshot EXACTLY — three
       labelled sections BRUSHES / ARROWS / SHAPES in exact TV order with
       the missing tools added (Arrow marker, Rotated rectangle, Path,
       Circle, Polyline, Arc, Curve, Double curve — all researched and
       implemented in tools2.js like TV) and the toolbar glyph switched to
       TV's brush. NOTHING was deleted: Text/Note/Callout, the left/right
       Arrow marks and Flag Mark keep their engines, renderers, settings
       and Object-Tree entries (existing drawings still render) — they only
       step out of THIS menu, which now lists TV's items only. The Arrow
       (line with head) is shared with the lines flyout like the
       Pitchforks (shared tool id, favorites and settings untouched). */
    { id: 'shapes', base: 'brush', sections: [
      { title: 'Brushes', tools: ['brush', 'highlighter'] },
      { title: 'Arrows', tools: ['arrowmarker', 'arrow', 'arrowmarku', 'arrowmarkd'] },
      { title: 'Shapes', tools: ['rect', 'rotrect', 'path', 'circle', 'ellipse', 'polyline', 'triangle', 'arc', 'curve', 'dblcurve'] },
      /* ROUND246 (TV parity): Text/Note/Callout + the one-click marks were
         engine-complete but unreachable from any menu (dead since r69) — TV
         lists its annotations next to the shapes. Ids/settings/favorites
         untouched, so stored drawings and stars keep working. */
      { title: 'Annotations', tools: ['text', 'note', 'callout', 'flagmark', 'arrowmarkl', 'arrowmarkr'] },
    ] },
    /* ROUND248 (TV parity): the 8th category — Icons (emoji). One
       single-click tool; the glyph grid lives in its Style tab. Placed
       before measure/zoom (TV order) so the bottom-overflow rule keeps it
       reachable longest. */
    { id: 'icons', base: 'emoji', tools: ['emoji'] },
    { id: 'measure', tools: ['measure'] },
    { id: 'zoom', tools: ['zoomin'] },
  ];
  const UTILS = ['magnet', 'stay', 'lock', 'eye', 'trash'];
  UI.GROUPS = GROUPS;
  /* ROUND 61: flyout toolbar buttons whose base glyph is not a TOOLS id
     still need a proper tooltip (TV: hovering the icon says the group) */
  const GROUP_TITLE = {
    gannelliott: 'Chart patterns, Elliott waves & cycles',
    forecast: 'Forecasting and Measurement Tools',
    icons: 'Icons — emojis on the chart',
  };
  /* ROUND 69: TV shows the keyboard shortcut right-aligned on the flyout
     row (gray, before the favorite star) — Rectangle = Alt + Shift + R,
     wired for real in app.js' global key handler. */
  const FLY_HINTS = { rect: 'Alt + Shift + R' };

  const groupState = {}; // groupId -> current tool id shown on button
  const toolsOf = (g) => g.tools || (g.sections || []).flatMap((s) => s.tools);
  UI.toolsOf = toolsOf;
  GROUPS.forEach((g) => { groupState[g.id] = g.base || toolsOf(g)[0]; });

  let flyout = null;

  /* ---------- ROUND84: magnet submenu (Off / Weak / Medium / Strong) ----------
     The magnet used to CYCLE its four strengths on every click (round 80);
     per the user request it now opens a TV-style submenu like every other
     left-toolbar flyout, with the active mode checked. Selection persists to
     mt5_magnet_mode (same key the engine reads: App.magnetMode; Alt still
     bypasses while held). */
  const MAGNET_MODES = [
    { id: 'off', name: 'Magnet Off', desc: 'Free cursor — no snapping' },
    { id: 'weak', name: 'Weak Magnet', desc: 'Snaps to OHLC within a few pixels' },
    { id: 'medium', name: 'Medium Magnet', desc: 'Snaps to OHLC within a wider radius' },
    { id: 'strong', name: 'Strong Magnet', desc: 'Always snaps to the nearest OHLC' },
  ];
  const MAGNET_TOAST = {
    off: 'Magnet OFF',
    weak: 'Weak Magnet — snaps to OHLC within a few pixels (hold Alt to bypass)',
    medium: 'Medium Magnet — snaps to OHLC within a wider radius (hold Alt to bypass)',
    strong: 'Strong Magnet — always snaps to the nearest OHLC (hold Alt to bypass)',
  };
  /* visible activation state of the magnet button (scoped to the magnet —
     the shared .lt-btn.on used by lock/eye stays untouched) */
  function applyMagnetBtn(b) {
    const on = !!App.magnetMode && App.magnetMode !== 'off';
    b.classList.toggle('on', on);
    b.classList.toggle('magnet-on', on);
  }
  function setMagnetMode(mode, b) {
    App.magnetMode = mode;
    U.lsSet('mt5_magnet_mode', mode);
    applyMagnetBtn(b);
    toast(MAGNET_TOAST[mode] || 'Magnet OFF');
  }
  function openMagnetMenu(btn) {
    const r = btn.getBoundingClientRect();
    Toolbar.popupAt(r.right + 6, r.top, (p) => {
      U.el('div', 'pu-title', p).textContent = 'MAGNET MODE';
      for (const m of MAGNET_MODES) {
        const cur = (App.magnetMode || 'off') === m.id;
        const it = U.el('button', 'pu-item' + (cur ? ' hl' : ''), p);
        it.title = m.desc;
        it.innerHTML = `<span class="ic">${m.id === 'off' ? icon('x') : icon('magnet')}</span>` +
          `<span>${m.name}</span>` +
          (cur ? `<span class="pu-star faved" title="Active">${icon('checkOn')}</span>` : '');
        it.addEventListener('click', () => {
          Toolbar.closePopup();
          setMagnetMode(m.id, btn);
        });
      }
      U.el('div', 'pu-hint', p).textContent = 'Hold Alt to bypass the magnet while drawing';
    });
  }

  /* ---------- left toolbar ---------- */
  UI.buildLeftToolbar = function () {
    const bar = document.getElementById('left-toolbar');
    U.clear(bar);
    /* minimize toggle (custom, round 19): collapses the whole bar; a slim
       expand tab at the left edge of the charts area restores it */
    const minBtn = U.el('button', 'lt-btn lt-min', bar);
    minBtn.innerHTML = icon('chevL');
    minBtn.title = 'Minimize drawing toolbar';
    minBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    minBtn.addEventListener('click', (e) => { e.stopPropagation(); UI.setLtCollapsed(true); });
    /* scrollable groups box — its overflow is handled by the chevron below */
    const groupsBox = U.el('div', 'lt-groups', bar);
    for (const g of GROUPS) {
      if (g.id === 'zoom') U.el('div', 'lt-sep', groupsBox);
      const b = U.el('button', 'lt-btn', groupsBox);
      b.dataset.group = g.id;
      b.innerHTML = icon(groupState[g.id]);
      if (toolsOf(g).length > 1) {
        const c = U.el('span', 'chev', b);
      }
      b.title = TOOLS[groupState[g.id]] ? TOOLS[groupState[g.id]].name : (GROUP_TITLE[g.id] || '');
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (flyout) { closeFlyout(); return; }
        if (toolsOf(g).length === 1) { activateTool(toolsOf(g)[0]); return; }
        openFlyout(b, g);
      });
      g._btn = b;
    }
    /* overflow chevron (small window heights): lists hidden tool groups */
    const ovf = U.el('button', 'lt-btn lt-ovf hidden', bar);
    ovf.innerHTML = icon('chevD');
    ovf.title = 'More tools';
    ovf.addEventListener('mousedown', (e) => e.stopPropagation());
    ovf.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = ovf.getBoundingClientRect();
      Toolbar.popupAt(r.right + 6, r.top, (p) => {
        U.el('div', 'pu-title', p).textContent = 'MORE TOOLS';
        groupsBox.querySelectorAll('.lt-btn.tb-ovf-item').forEach((b) => {
          const gid = b.dataset.group;
          const g = GROUPS.find((x) => x.id === gid);
          if (!g) return;
          const tid = groupState[gid];
          const def = TOOLS[tid] || { name: gid, icon: 'x' };
          const it = U.el('button', 'pu-item', p);
          it.innerHTML = `<span class="ic">${icon(def.icon || 'x')}</span><span>${def.name}</span>`;
          it.addEventListener('click', () => { Toolbar.closePopup(); activateTool(tid); });
        });
      });
    });
    U.el('div', 'lt-spacer', bar);
    U.el('div', 'lt-sep', bar);
    for (const id of UTILS) {
      const b = U.el('button', 'lt-btn', bar);
      b.dataset.util = id;
      b.innerHTML = icon(id === 'lock' ? 'lock' : id === 'eye' ? 'eye' : id === 'trash' ? 'trash' : id === 'stay' ? 'stay' : 'magnet');
      b.title = { magnet: 'Magnet Mode — snap drawings & the crosshair to OHLC (click: pick Off / Weak / Medium / Strong, hold Alt to bypass)', stay: 'Stay in drawing mode — keep drawing with the same tool after each drawing (TV)', lock: 'Lock all drawings', eye: 'Hide all drawings', trash: 'Remove all drawings' }[id];
      if (id === 'stay' && App.stayDraw) b.classList.add('on');
      b.addEventListener('mousedown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (id === 'magnet') {
          /* ROUND84 (user request): opens the mode SUBMENU instead of the old
             click-cycle. Weak/medium snap within a pixel radius, strong
             always locks to the nearest OHLC of the hovered bar; the magnet
             also drives the CROSSHAIR while aiming (engine.move), so the
             user sees the snap before committing the drawing point. */
          openMagnetMenu(b);
        } else if (id === 'lock') {
          App.lockAll = !App.lockAll;
          b.innerHTML = icon(App.lockAll ? 'unlock' : 'lock');
          b.classList.toggle('on', App.lockAll);
        } else if (id === 'stay') {
          /* ROUND251 (TV parity): repeat-draw lock — the ONLY way tools go
             sticky (one-shot is the TV default). */
          App.stayDraw = !App.stayDraw;
          U.lsSet('mt5_stay_draw', App.stayDraw);
          b.classList.toggle('on', App.stayDraw);
        } else if (id === 'eye') {
          App.hideAll = !App.hideAll;
          b.innerHTML = icon(App.hideAll ? 'eyeoff' : 'eye');
          b.classList.toggle('on', App.hideAll);
        } else if (id === 'trash') {
          if (App.activePane) {
            App.drawings.removeAll(App.activePane.symbol);
            App.selection = null;
            UI.onSelectionChanged();
            toast('All drawings removed for ' + App.activePane.symbol);
          }
        }
      });
      if (id === 'magnet') applyMagnetBtn(b);
      if (id === 'trash') {
        // star toggle for favorites floating bar — LAST item on the toolbar
        const sep = U.el('div', 'lt-sep', bar);
        sep.style.margin = '2px 0';
      }
    }
    // favorites bar toggle — the last button on the left toolbar
    const starBtn = U.el('button', 'lt-btn', bar);
    starBtn.id = 'favbar-toggle';
    starBtn.innerHTML = icon('star');
    starBtn.title = 'Toggle favorites toolbar on chart';
    starBtn.classList.toggle('on', App.favBarVisible);
    starBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      App.favBarVisible = !App.favBarVisible;
      U.lsSet('mt5_favbar_visible', App.favBarVisible);
      starBtn.classList.toggle('on', App.favBarVisible);
      UI.renderFavFloat();
    });

    /* slim restore tab (lives on the charts area, only while collapsed) */
    const area = document.getElementById('charts-area');
    let expand = document.getElementById('lt-expand');
    if (!expand) {
      expand = U.el('button', 'lt-expand hidden', area);
      expand.id = 'lt-expand';
    }
    expand.innerHTML = icon('chevR');
    expand.title = 'Restore drawing toolbar';
    expand.addEventListener('mousedown', (e) => e.stopPropagation());
    expand.addEventListener('click', (e) => { e.stopPropagation(); UI.setLtCollapsed(false); });

    UI.setLtCollapsed(U.lsGet('mt5_lt_collapsed', false));
    UI.layoutLeftbar();
    /* PERF FIX: was firing on every raw 'resize' event (can be dozens per
       second while the user drags the window edge), competing with the
       chart's own RAF render loop for the frame. rafThrottle coalesces
       that storm to at most one layoutLeftbar() per animation frame while
       keeping it live during the drag (unlike a trailing debounce, which
       would freeze the toolbar until the drag stops). */
    const layoutLeftbarRaf = U.rafThrottle(() => { try { UI.layoutLeftbar(); } catch (e) {} });
    new ResizeObserver(layoutLeftbarRaf).observe(document.getElementById('left-toolbar'));
    window.addEventListener('resize', layoutLeftbarRaf);
  };

  /* minimize / restore the left drawing toolbar (custom feature) */
  UI.setLtCollapsed = function (v) {
    const bar = document.getElementById('left-toolbar');
    const expand = document.getElementById('lt-expand');
    if (!bar) return;
    bar.classList.toggle('collapsed', !!v);
    if (expand) expand.classList.toggle('hidden', !v);
    U.lsSet('mt5_lt_collapsed', !!v);
    if (flyout) closeFlyout();
  };

  /* vertical overflow: tool groups that no longer fit the window height are
     hidden from the bottom of the groups box and listed by the chevron */
  UI.layoutLeftbar = function () {
    const bar = document.getElementById('left-toolbar');
    const box = bar && bar.querySelector('.lt-groups');
    const ovf = bar && bar.querySelector('.lt-ovf');
    if (!box || !ovf || bar.classList.contains('collapsed')) return;
    box.querySelectorAll('.tb-ovf-item').forEach((el) => el.classList.remove('tb-ovf-item'));
    const units = Array.from(box.querySelectorAll('.lt-btn[data-group], .lt-sep'));
    const fits = () => box.scrollHeight <= box.clientHeight + 1;
    let guard = 60;
    while (!fits() && guard-- > 0) {
      let el = null;
      for (let i = units.length - 1; i >= 0; i--) {
        const u = units[i];
        if (u.classList.contains('tb-ovf-item') || u.classList.contains('lt-sep')) continue;
        el = u; break;
      }
      if (!el) break;
      el.classList.add('tb-ovf-item');
    }
    const any = box.querySelector('.lt-btn.tb-ovf-item');
    ovf.classList.toggle('hidden', !any);
  };

  function openFlyout(btn, group) {
    closeFlyout();
    const fl = U.el('div', 'lt-flyout', document.body);
    flyout = fl; // assign FIRST so the flyout can always be closed, even if a tile fails
    const r = btn.getBoundingClientRect();
    fl.style.left = r.right + 6 + 'px';
    fl.style.top = r.top + 'px';
    /* one list of tools, or a sectioned list (Gann / Elliott, round 23) */
    const sections = group.sections || [{ tools: group.tools }];
    for (const sec of sections) {
      if (sec.title) U.el('div', 'lt-flysec', fl).textContent = sec.title;
      for (const tid of sec.tools || []) {
        const def = TOOLS[tid];
        if (!def) continue;
        /* TV-style list rows: icon + tool NAME + favorite star (round 19);
           ROUND 69: + right-aligned shortcut hint (TV, e.g. Rectangle) */
        const tile = U.el('button', 'lt-tile', fl);
        tile.innerHTML = `<span class="tile-ic">${icon(def.icon || 'x')}</span>` +
          `<span class="tile-name">${def.name}</span>`;
        tile.title = def.name;
        if (FLY_HINTS[tid]) U.el('span', 'tile-hint', tile).textContent = FLY_HINTS[tid];
        if (App.tool === tid) tile.classList.add('armed');
        const star = U.el('button', 'tile-star' + (App.toolFavorites.includes(tid) ? ' faved' : ''), tile);
        star.innerHTML = icon(App.toolFavorites.includes(tid) ? 'star' : 'starOutline');
        star.title = 'Favorite';
        star.addEventListener('mousedown', (e) => e.stopPropagation());
        star.addEventListener('click', (e) => {
          e.stopPropagation();
          UI.toggleToolFav(tid);
          star.classList.toggle('faved', App.toolFavorites.includes(tid));
          star.innerHTML = icon(App.toolFavorites.includes(tid) ? 'star' : 'starOutline');
        });
        tile.addEventListener('click', (e) => {
          if (e.target.closest('.tile-star')) return;
          activateTool(tid, group);
          closeFlyout();
        });
      }
    }
    flyout = fl;
    /* BUG-005: ONE viewport-fitting rule for every tool-group flyout — clamp
       to the window (12px safety), flip up when more room sits above, and
       scroll INSIDE the flyout (overflow-y on the flyout itself). Recomputed
       on every open; a window resize while open closes it (same rule as the
       layout picker, BUG-010). */
    U.fitPopup(fl, r.top, r.bottom, { topSafe: 44 });
    fl._onResize = () => closeFlyout();
    window.addEventListener('resize', fl._onResize);
    /* ROUND103 LEAK FIX: the outside-click handler used to unregister itself
       ONLY on the outside-click path. Every flyout closed any other way
       (window resize, picking a tool, Escape, opening another group) left a
       permanent document-level mousedown listener behind — and because the
       handler tests `flyout &&`, the orphans stayed silent while still
       running on every click of the session. closeFlyout() owns the teardown
       now, so there is exactly one registration per open. */
    setTimeout(() => {
      if (!fl || fl !== flyout) return;          // already closed in this tick
      const off = (e) => { if (flyout && !flyout.contains(e.target)) closeFlyout(); };
      fl._off = off;
      document.addEventListener('mousedown', off);
    }, 0);
  }

  function closeFlyout() {
    if (!flyout) return;
    if (flyout._onResize) window.removeEventListener('resize', flyout._onResize);
    if (flyout._off) document.removeEventListener('mousedown', flyout._off);
    flyout.remove();
    flyout = null;
  }
  UI.closeFlyout = closeFlyout;

  function activateTool(tid, srcGroup) {
    App.tool = tid;
    App.selection = null;
    UI.onSelectionChanged();
    // update group button icon — ROUND 52: only the group the tool was
    // picked FROM follows the selection (a pitchfork chosen in the trend
    // flyout must not repaint the Gann&Fib button, and vice versa)
    for (const g of GROUPS) {
      if (srcGroup && g.id !== srcGroup.id) continue;
      if (toolsOf(g).includes(tid)) {
        groupState[g.id] = tid;
        if (g._btn) {
          g._btn.innerHTML = icon((TOOLS[tid] && TOOLS[tid].icon) || tid);
          if (toolsOf(g).length > 1) g._btn.innerHTML += '<span class="chev"></span>';
          g._btn.title = TOOLS[tid] ? TOOLS[tid].name : '';
        }
      }
    }
    /* ROUND39 (TV parity): apply the tool's pointer IMMEDIATELY on every
       pane — previously the old cursor (e.g. crosshair) lingered until the
       first mouse move after switching to a cursor tool like Arrow */
    try {
      const def = TOOLS[tid];
      const bareCursor = !!(def && def.cursorTool && !def.crosshair);
      for (const pane of App.panes) {
        if (!pane.engine) continue;
        pane.engine.canvas.style.cursor =
          (def && def.cursorTool) ? (def.cursor ? def.cursor() : 'default') : 'crosshair';
        /* TV: leaving a cursor tool (or entering one) drops the painted
           crosshair at once — the old state lingered until the next move */
        pane.engine._cross = { on: false, x: -1, y: -1 };
        try { pane.engine._updateCrossBubble && pane.engine._updateCrossBubble(pane.engine.view()); } catch (e) {}
        /* and the NATIVE horzLine follows the mouse inside the lib — hide it
           for bare cursor tools (Arrow/Dot), restore otherwise */
        try {
          pane.chart.applyOptions({ crosshair: { horzLine: { visible: !bareCursor && (!Settings || Settings.conf.crosshair !== false) } } });
        } catch (e) {}
      }
    } catch (e) {}
    UI.refreshArmed();
  }
  UI.activateTool = activateTool;

  UI.refreshArmed = function () {
    document.querySelectorAll('#left-toolbar .lt-btn[data-group]').forEach((b) => {
      b.classList.toggle('armed', !!App.tool && groupState[b.dataset.group] === App.tool);
    });
  };

  UI.toggleToolFav = function (tid) {
    const i = App.toolFavorites.indexOf(tid);
    if (i >= 0) App.toolFavorites.splice(i, 1); else App.toolFavorites.push(tid);
    U.lsSet('mt5_tool_favs', App.toolFavorites);
    UI.renderFavFloat();
  };

  UI.onToolDone = function () {
    UI.refreshArmed();
  };

  /* ---------- floating favorites bar (TV: favorite drawing tools toolbar) ---------- */
  let _favDragMoved = false; // suppress the click after a reorder drag
  UI.renderFavFloat = function () {
    const bar = document.getElementById('fav-float');
    if (!bar) return;
    if (!App.favBarVisible) { bar.classList.add('hidden'); return; }
    U.clear(bar);
    /* [1] grip — the ONLY place to grab the bar for moving (round 23, like
       the rectangle bar's grip): a six-dot handle at the left end */
    const grip = U.el('button', 'ff-grip', bar);
    grip.innerHTML = icon('gripdot');
    grip.title = 'Drag to move the favorites bar';
    /* NOTE: no stopPropagation here — the bar-level makeDraggable listener
       below must receive the mousedown to move the bar (round 23) */
    if (!App.toolFavorites.length) {
      const s = U.el('span', 'ff-empty', bar);
      s.textContent = 'Star drawing tools to pin them here';
    }
    for (const tid of App.toolFavorites) {
      const def = TOOLS[tid];
      if (!def) continue;
      const b = U.el('button', 'ff-btn', bar);
      b.dataset.tid = tid;
      b.innerHTML = icon(def.icon || 'x');
      b.title = def.name;
      if (App.tool === tid) b.classList.add('armed');
      b.addEventListener('click', () => {
        if (_favDragMoved) { _favDragMoved = false; return; } // this click was a drag
        activateTool(tid);
        UI.renderFavFloat();
      });
    }
    const x = U.el('button', 'ff-close', bar);
    x.innerHTML = icon('x');
    x.title = 'Hide';
    x.addEventListener('click', () => {
      App.favBarVisible = false;
      U.lsSet('mt5_favbar_visible', false);
      UI.renderFavFloat();
      const t = document.getElementById('favbar-toggle');
      if (t) t.classList.remove('on');
    });
    bar.classList.remove('hidden');
    // restore position
    const area = document.getElementById('charts-area');
    const pos = App.favBarPos;
    if (pos && pos.x != null) {
      bar.style.left = U.clamp(pos.x, 4, Math.max(4, area.clientWidth - 60)) + 'px';
      bar.style.top = U.clamp(pos.y, 4, Math.max(4, area.clientHeight - 50)) + 'px';
      bar.style.right = 'auto';
      bar.style.bottom = 'auto';
    } else {
      bar.style.left = '14px';
      bar.style.top = '14px';
    }
    makeDraggable(bar);
    enableFavReorder(bar);
  };

  function makeDraggable(bar) {
    if (bar._dragBound) return;
    bar._dragBound = true;
    bar.addEventListener('mousedown', (e) => {
      /* round 23: the bar moves ONLY from its grip handle, so the user always
         knows where to grab it (the tool buttons drag-reorder instead) */
      if (!e.target.closest('.ff-grip')) return;
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const area = document.getElementById('charts-area').getBoundingClientRect();
      const br = bar.getBoundingClientRect();
      const ox = e.clientX - br.left, oy = e.clientY - br.top;
      const move = (ev) => {
        const nx = U.clamp(ev.clientX - area.left - ox, 2, area.width - 40);
        const ny = U.clamp(ev.clientY - area.top - oy, 2, area.height - 44);
        bar.style.left = nx + 'px';
        bar.style.top = ny + 'px';
        bar.style.right = 'auto';
        bar.style.bottom = 'auto';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        const ar = document.getElementById('charts-area').getBoundingClientRect();
        const r = bar.getBoundingClientRect();
        App.favBarPos = { x: r.left - ar.left, y: r.top - ar.top };
        U.lsSet('mt5_favbar_pos', App.favBarPos);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  /* round 23: drag a tool ONTO another tool to reorder the bar (from 2 tools
     up — with a single tool there is nothing to reorder). The live DOM is
     reordered during the drag and the order persists on drop. */
  function enableFavReorder(bar) {
    if (bar._reorderBound) return;
    bar._reorderBound = true;
    bar.addEventListener('mousedown', (e) => {
      const btn = e.target.closest('.ff-btn');
      if (!btn || e.button !== 0) return;
      const startX = e.clientX, startY = e.clientY;
      let moved = false;
      const mv = (ev) => {
        if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 5) return;
        moved = true;
        btn.classList.add('ff-drag');
        const siblings = Array.from(bar.querySelectorAll('.ff-btn')).filter((b) => b !== btn);
        for (const s of siblings) {
          const r = s.getBoundingClientRect();
          if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
            const before = ev.clientX < r.left + r.width / 2;
            if (before) bar.insertBefore(btn, s);
            else bar.insertBefore(s, btn);
            break;
          }
        }
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        btn.classList.remove('ff-drag');
        if (!moved) return;
        _favDragMoved = true; // the trailing click must not re-activate the tool
        const order = Array.from(bar.querySelectorAll('.ff-btn')).map((b) => b.dataset.tid).filter(Boolean);
        if (order.length >= 2 && order.join() !== App.toolFavorites.join()) {
          App.toolFavorites.length = 0;
          for (const t of order) App.toolFavorites.push(t);
          U.lsSet('mt5_tool_favs', App.toolFavorites);
          UI.renderFavFloat();
        }
        setTimeout(() => { _favDragMoved = false; }, 0);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }

  /* ---------- selection context toolbar (TV floating bar, round 21) ----------
     Left → right, exactly like the TV rectangle bar:
     [grip] [templates] [border ▾] [background ▾] [text ▾] [width ▾]
     [style ▾] [gear] [alert] [lock] [trash] [⋯] */

  /* small SVG line preview for the width/style buttons */
  function linePreview(st, color, width, w) {
    const DASH = { solid: '', dashed: '6 4', dotted: '2 4', largedashed: '10 6' };
    const dd = DASH[st] || '';
    return `<svg width="${w || 30}" height="12"><line x1="1" y1="6" x2="${(w || 30) - 1}" y2="6" stroke="${color}" stroke-width="${width}" ${dd ? `stroke-dasharray="${dd}"` : ''} stroke-linecap="round"/></svg>`;
  }

  /* icon button with a colour underline (TV stroke/background/text swatches) */
  function ctIconSwatch(bar, ic, title, color, onPick, opacity, onOpacity) {
    const b = U.el('button', 'ct-btn ct-ic', bar);
    b.innerHTML = `<span class="ct-ic-wrap">${icon(ic)}<i class="ct-cline"></i></span>`;
    b.querySelector('.ct-cline').style.background = U.toHex(color); // CSP: CSSOM, not style="" attr
    b.title = title;
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = b.getBoundingClientRect();
      Toolbar.colorPickerAt(r.left, r.bottom + 4, color, (c) => {
        onPick(c);
        const line = b.querySelector('.ct-cline');
        if (line) line.style.background = U.toHex(c);
      }, { opacity, onOpacity });
    });
    return b;
  }

  /* popup menu row with an optional leading preview / check */
  function puRow(p, html, fn, cls) {
    const it = U.el('button', 'pu-item' + (cls ? ' ' + cls : ''), p);
    it.innerHTML = html;
    it.addEventListener('click', () => { Toolbar.closePopup(); fn(); });
    return it;
  }

  UI.onSelectionChanged = function () {
    if (ObjectTree.refresh) ObjectTree.refresh();
    const bar = document.getElementById('ctx-toolbar');
    App.selBarPos = null; // the bar re-anchors above the drawing (TV)
    if (!App.selection || !TOOLS[App.selection.d.type]) { bar.classList.add('hidden'); return; }
    const pane = App.selection.pane;
    const d = App.selection.d;
    const save = () => App.drawings.save();
    const layout = (CTX_LAYOUT && CTX_LAYOUT[d.type]) || ['stroke', 'width', 'style', 'settings', 'lock', 'delete', 'dots'];
    U.clear(bar);

    /* [1] grip — drag the bar anywhere on the chart (TV) */
    const grip = U.el('button', 'ct-btn ct-grip', bar);
    grip.innerHTML = icon('gripdot');
    grip.title = 'Drag to move the toolbar';
    grip.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const area = document.getElementById('charts-area').getBoundingClientRect();
      const br = bar.getBoundingClientRect();
      const ox = e.clientX - br.left, oy = e.clientY - br.top;
      const mv = (ev) => {
        App.selBarPos = {
          x: U.clamp(ev.clientX - area.left - ox, 2, Math.max(2, area.width - br.width - 2)),
          y: U.clamp(ev.clientY - area.top - oy, 2, Math.max(2, area.height - br.height - 2)),
        };
        bar.style.left = App.selBarPos.x + 'px';
        bar.style.top = App.selBarPos.y + 'px';
      };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });

    /* [2] templates (per-tool saved presets, TV) */
    const tpls = App.toolTemplates.list(d.type);
    const tbtn = U.el('button', 'ct-btn', bar);
    tbtn.innerHTML = icon('tpl');
    tbtn.title = 'Templates' + (tpls.length ? ` (${tpls.length})` : '');
    tbtn.addEventListener('mousedown', (e) => e.stopPropagation());
    tbtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = tbtn.getBoundingClientRect();
      Toolbar.popupAt(r.left, r.bottom + 4, (p) => {
        const apply = (opts) => {
          const keepText = d.opts.text;
          for (const k of Object.keys(d.opts)) if (k !== 'vis') delete d.opts[k];
          Object.assign(d.opts, JSON.parse(JSON.stringify(opts || {})));
          d.opts.text = keepText; // templates never carry annotation text (r20)
          save();
          UI.onSelectionChanged();
        };
        puRow(p, '<span>Default</span>', () => apply(App.drawings.factoryOpts(d.type)));
        for (const t of App.toolTemplates.list(d.type)) {
          const it = U.el('button', 'pu-item ds-tpl-item', p);
          it.innerHTML = `<span>${t.name}</span>`;
          const tr = U.el('button', 'pu-star ds-tpl-trash', it);
          tr.innerHTML = icon('trash');
          tr.title = 'Delete template';
          tr.addEventListener('mousedown', (ev) => ev.stopPropagation());
          tr.addEventListener('click', (ev) => {
            ev.stopPropagation();
            App.toolTemplates.remove(d.type, t.name);
            Toolbar.closePopup();
          });
          it.addEventListener('click', (ev) => {
            if (ev.target.closest('.ds-tpl-trash')) return;
            Toolbar.closePopup();
            apply(t.opts);
          });
        }
        U.el('div', 'pu-sep', p);
        puRow(p, '<span>Save As…</span>', () => {
          if (DrawSettings) DrawSettings.saveTemplateDialog(d.type, d.opts, TOOLS[d.type].name);
        });
      });
    });

    /* tool-specific items */
    for (const item of layout) {
      if (item === 'stroke') {
        ctIconSwatch(bar, 'pencil', 'Border color and opacity', d.opts.color || '#2962ff',
          (c) => { d.opts.color = c; save(); },
          typeof d.opts.borderOpacity === 'number' ? d.opts.borderOpacity : 1,
          (v) => { d.opts.borderOpacity = v; save(); });
      } else if (item === 'bg') {
        ctIconSwatch(bar, 'fill', 'Background color and opacity', d.opts.fillColor || d.opts.color || '#2962ff',
          (c) => { d.opts.fill = true; d.opts.fillColor = c; save(); },
          typeof d.opts.fillOpacity === 'number' ? d.opts.fillOpacity : 0.15,
          (v) => { d.opts.fill = true; d.opts.fillOpacity = v; save(); });
      } else if (item === 'textc') {
        ctIconSwatch(bar, 'text', 'Text color and opacity', d.opts.textColor || '#d1d4dc',
          (c) => { d.opts.textColor = c; save(); },
          typeof d.opts.textOpacity === 'number' ? d.opts.textOpacity : 1,
          (v) => { d.opts.textOpacity = v; save(); });
      } else if (item === 'width') {
        const b = U.el('button', 'ct-btn ct-tx', bar);
        b.innerHTML = `${linePreview('solid', U.toHex(d.opts.color || '#2962ff'), Math.min(3, d.opts.width || 2), 16)}<span>${d.opts.width || 2}px</span>`;
        b.title = 'Line width';
        b.addEventListener('mousedown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const r = b.getBoundingClientRect();
          Toolbar.popupAt(r.left, r.bottom + 4, (p) => {
            for (const w of [1, 2, 3, 4]) {
              const it = U.el('button', 'pu-item' + (d.opts.width === w ? ' hl' : ''), p);
              it.innerHTML = `<span class="ic">${linePreview('solid', Theme.th('text', '#d1d4dc'), w, 30)}</span><span>${w}px</span>`;
              it.addEventListener('click', () => { Toolbar.closePopup(); d.opts.width = w; save(); UI.onSelectionChanged(); });
            }
          });
        });
      } else if (item === 'style') {
        const b = U.el('button', 'ct-btn ct-tx', bar);
        b.innerHTML = linePreview(d.opts.style || 'solid', U.toHex(d.opts.color || '#2962ff'), Math.min(3, d.opts.width || 2), 22);
        b.title = 'Line style: ' + (d.opts.style || 'solid');
        b.addEventListener('mousedown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const r = b.getBoundingClientRect();
          Toolbar.popupAt(r.left, r.bottom + 4, (p) => {
            for (const [s, label] of [['solid', 'Line'], ['dashed', 'Dash line'], ['dotted', 'Dotted line']]) {
              const it = U.el('button', 'pu-item' + ((d.opts.style || 'solid') === s ? ' hl' : ''), p);
              it.innerHTML = `<span class="ic">${linePreview(s, Theme.th('text', '#d1d4dc'), 2, 30)}</span><span>${label}</span>`;
              it.addEventListener('click', () => { Toolbar.closePopup(); d.opts.style = s; save(); UI.onSelectionChanged(); });
            }
          });
        });
      } else if (item === 'fontSize') {
        const b = U.el('button', 'ct-btn ct-tx', bar);
        b.textContent = (d.opts.fontSize || 14) + 'px';
        b.title = 'Font size';
        b.addEventListener('click', () => {
          const sizes = [12, 14, 16, 18, 20, 24, 30];
          const i = sizes.indexOf(d.opts.fontSize);
          d.opts.fontSize = sizes[(i + 1) % sizes.length];
          save();
          UI.onSelectionChanged();
        });
      } else if (item === 'settings') {
        const b = U.el('button', 'ct-btn', bar);
        b.innerHTML = icon('gear');
        b.title = 'Settings';
        b.addEventListener('click', () => {
          if (DrawSettings) DrawSettings.open(App.selection.pane, d);
        });
      } else if (item === 'alert') {
        const b = U.el('button', 'ct-btn' + (d.alert && d.alert.active ? ' on' : ''), bar);
        b.innerHTML = icon('bell');
        b.title = d.alert ? 'Edit alert on this drawing' : 'Add alert on this drawing';
        b.addEventListener('click', () => {
          if (Alerts && Alerts.openDrawingDialog) Alerts.openDrawingDialog(App.selection.pane, d);
        });
      } else if (item === 'lock') {
        const b = U.el('button', 'ct-btn', bar);
        b.innerHTML = icon(d.locked ? 'lock' : 'unlock');
        b.title = d.locked ? 'Unlock drawing' : 'Lock drawing';
        b.classList.toggle('on', !!d.locked);
        b.addEventListener('click', () => {
          d.locked = !d.locked;
          save();
          UI.onSelectionChanged();
        });
      } else if (item === 'delete') {
        const b = U.el('button', 'ct-btn', bar);
        b.innerHTML = icon('trash');
        b.title = 'Delete';
        b.classList.add('danger');
        b.addEventListener('click', () => {
          if (App.undo) App.undo.remove(App.selection.pane, d);
          else App.drawings.remove(App.selection.pane.symbol, d.id);
          App.selection = null;
          UI.onSelectionChanged();
        });
      } else if (item === 'dots') {
        const b = U.el('button', 'ct-btn', bar);
        b.innerHTML = icon('dots');
        b.title = 'More';
        b.addEventListener('mousedown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const r = b.getBoundingClientRect();
          Toolbar.popupAt(r.left, r.bottom + 4, (p) => {
            U.el('div', 'pu-title', p).textContent = 'VISUAL ORDER';
            puRow(p, '<span>Bring to front</span>', () => { App.drawings.moveToFront(pane.symbol, d.id); });
            puRow(p, '<span>Send to back</span>', () => { App.drawings.moveToBack(pane.symbol, d.id); });
            U.el('div', 'pu-sep', p);
            U.el('div', 'pu-title', p).textContent = 'VISIBILITY ON INTERVALS';
            if (!d.opts.vis && DrawSettings) d.opts.vis = DrawSettings.defaultVis();
            const visKeys = [['ticks', 'Ticks'], ['sec', 'Seconds'], ['min', 'Minutes'], ['hours', 'Hours'], ['days', 'Days'], ['weeks', 'Weeks'], ['months', 'Months'], ['ranges', 'Ranges']];
            for (const [key, label] of visKeys) {
              const on = DrawSettings ? DrawSettings.visGroupOn(d, key) : true;
              const it = U.el('button', 'pu-item', p);
              it.innerHTML = `<span class="ic">${icon(on ? 'checkOn' : 'checkOff')}</span><span>${label}</span>`;
              it.addEventListener('click', () => {
                if (!d.opts.vis[key]) d.opts.vis[key] = { on: true };
                d.opts.vis[key].on = d.opts.vis[key].on === false;
                save();
                UI.toast(`${TOOLS[d.type].name} is ${d.opts.vis[key].on === false ? 'hidden' : 'visible'} on ${label.toLowerCase()}`);
              });
            }
            U.el('div', 'pu-sep', p);
            puRow(p, `<span class="ic">${icon('clone')}</span><span>Clone</span>`, () => {
              const copy = U.deepCopy(d);
              delete copy.id;
              copy.points = copy.points.map((pt) => ({ t: pt.t + 6 * 60, p: pt.p }));
              copy.opts = Object.assign({}, copy.opts);
              App.drawings.add(pane.symbol, copy);
              App.selection = { pane, d: copy };
              UI.onSelectionChanged();
            });
            puRow(p, `<span class="ic">${icon('copy')}</span><span>Copy</span>`, () => {
              const copy = U.deepCopy(d);
              delete copy.id;
              copy.points = copy.points.map((pt) => ({ t: pt.t, p: pt.p }));
              copy.opts = Object.assign({}, copy.opts);
              App.drawings.add(pane.symbol, copy);
              App.selection = { pane, d: copy };
              UI.onSelectionChanged();
            });
            puRow(p, `<span class="ic">${icon('eyeoff')}</span><span>Hide</span>`, () => {
              d.hidden = true;
              save();
              App.selection = null;
              UI.onSelectionChanged();
              UI.toast('Hidden — unhide it from the Object Tree (eye icon)');
            });
          });
        });
      }
    }
    bar.classList.remove('hidden');
  };

  /* reposition context bar every frame (respects a user-dragged position) */
  UI.tickFrame = function () {
    const bar = document.getElementById('ctx-toolbar');
    if (bar.classList.contains('hidden') || !App.selection) return;
    if (App.selBarPos) return; // the user parked the bar — TV keeps it there
    const pane = App.selection.pane;
    if (!App.panes.includes(pane)) { bar.classList.add('hidden'); return; }
    const d = App.selection.d;
    const eng = pane.engine;
    try {
      const v = eng.view();
      const def = TOOLS[d.type];
      const hs = def.handles ? def.handles(v, d) : [];
      if (!hs.length) { bar.classList.add('hidden'); return; }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      hs.forEach((p) => { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); });
      const area = document.getElementById('charts-area');
      const rootR = pane.root.getBoundingClientRect();
      const areaR = area.getBoundingClientRect();
      const barW = bar.offsetWidth || 260, barH = bar.offsetHeight || 34;
      let left = rootR.left - areaR.left + (minX + maxX) / 2 - barW / 2;
      let top;
      const aboveY = rootR.top - areaR.top + minY - barH - 10;
      if (aboveY > 44) top = aboveY;
      else top = rootR.top - areaR.top + maxY + 10;
      left = U.clamp(left, areaR.left >= 0 ? 4 : 4, Math.max(4, area.clientWidth - barW - 4));
      top = U.clamp(top, 2, Math.max(2, area.clientHeight - barH - 4));
      bar.style.left = left + 'px';
      bar.style.top = top + 'px';
      bar.style.right = 'auto';
    } catch (e) {}
  };

  /* ---------- chart right-click menu (TV) ---------- */
  UI.openChartMenu = function (x, y, info) {
    if (typeof Toolbar === 'undefined' || !Toolbar.popupAt) return;
    Toolbar.popupAt(x, y, (p) => {
      const mk = (label, ic, fn) => {
        const it = U.el('button', 'pu-item', p);
        it.innerHTML = `<span class="ic">${icon(ic)}</span><span>${label}</span>`;
        it.addEventListener('click', () => { Toolbar.closePopup(); fn(); });
      };
      /* ROUND39: alert actions anchored to the right-clicked chart position —
         price from the cursor Y, time from the cursor X (bar), plus one-click
         management when the click sits on an existing alert mark */
      if (info && info.pane) {
        try {
          const pane = info.pane;
          const digits = pane.digits != null ? pane.digits : 5;
          const fmtP = (v) => Number(v).toFixed(digits);
          const near = Alerts.alertAt ? Alerts.alertAt(pane, info.x, info.y) : null;
          if (near) {
            mk('Manage alert\u2026', 'bell', () => Alerts.openManageDialog(near, pane));
            U.el('div', 'pu-sep', p);
          }
          if (info.price != null) {
            mk(`Add alert at ${fmtP(info.price)}\u2026`, 'bell', () => Toolbar.openAlertDialog(pane.symbol, info.price));
          }
          if (isFinite(info.t) && pane.barTimes && pane.barTimes.length) {
            const tp = TZ.parts(App.tz, info.t);
            mk(`Add time alert at ${tp.hour}:${tp.minute}\u2026`, 'clock', () => Alerts.openTimeDialog(pane, info.t));
          }
          if ((info.price != null) || (isFinite(info.t) && near == null)) U.el('div', 'pu-sep', p);
        } catch (e) {}
      }
      /* ROUND98 (user request): MT5-style chart trade history — persisted
         on/off flip (trade/history.js owns the flag), markers re-apply
         immediately on toggle */
      if (Manager.tradeHistoryOn) {
        U.el('div', 'pu-sep', p);
        mk((Manager.tradeHistoryOn() ? 'Hide' : 'Show') + ' trade history', 'positions', () => {
          if (Manager.tradeHistoryToggle) Manager.tradeHistoryToggle();
        });
      }
      mk('Object tree&hellip;', 'tree', () => { if (typeof ObjectTree !== 'undefined') ObjectTree.open(); });
      mk('Save layout&hellip;', 'save', () => { Toolbar.openSaveLayoutDialog(); });
      mk('Reset chart', 'fit', () => {
        for (const pane of App.panes) {
          try {
            pane.chart.timeScale().resetTimeScale();
            const dm = (Manager.defaultPriceMargins)
              ? Manager.defaultPriceMargins() : { top: 0.2, bottom: 0.15 };
            pane.chart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: dm });
          } catch (e) {}
        }
      });
      U.el('div', 'pu-sep', p);
      mk('Settings&hellip;', 'gear', () => { if (typeof Settings !== 'undefined') Settings.open(); });
    });
  };

  /* ---------- ROUND49 (TV): the (+) menu locked to the price highlight ----------
     Same five actions as TV's price-axis (+): alert at price, buy limit,
     sell stop, generic order ticket, horizontal line at price. */
  UI.openPriceAddMenu = function (pane, price, anchor) {
    if (typeof Toolbar === 'undefined' || !Toolbar.popupAt) return;
    const r = anchor.getBoundingClientRect();
    const digits = pane.digits != null ? pane.digits : 5;
    const fmtP = (v2) => Number(v2).toFixed(digits);
    const sym = pane.symbol;
    const P = fmtP(price);
    Toolbar.popupAt(r.left, r.bottom + 6, (p) => {
      const mk = (label, ic, fn) => {
        const it = U.el('button', 'pu-item', p);
        it.innerHTML = `<span class="ic">${icon(ic)}</span><span>${label}</span>`;
        it.addEventListener('click', () => { Toolbar.closePopup(); fn(); });
      };
      mk(`Add alert on ${sym} at ${P}`, 'bell', () => {
        if (Toolbar.openAlertDialog) Toolbar.openAlertDialog(sym, price);
      });
      U.el('div', 'pu-sep', p);
      mk(`Buy 1 ${sym} @ ${P} limit`, 'dblUp', () => {
        if (Toolbar.openOrderTicket) Toolbar.openOrderTicket(pane, price, { side: 'buy', type: 'limit' });
      });
      mk(`Sell 1 ${sym} @ ${P} stop`, 'dblDn', () => {
        if (Toolbar.openOrderTicket) Toolbar.openOrderTicket(pane, price, { side: 'sell', type: 'stop' });
      });
      mk(`Add order on ${sym} at ${P}\u2026`, 'orderDoc', () => {
        if (Toolbar.openOrderTicket) Toolbar.openOrderTicket(pane, price, {});
      });
      U.el('div', 'pu-sep', p);
      mk(`Draw horizontal line at ${P}`, 'hline', () => {
        try {
          const t = pane.barTimes && pane.barTimes.length
            ? pane.barTimes[pane.barTimes.length - 1]
            : Math.floor(Date.now() / 1000);
          const d = { type: 'hline', points: [{ t, p: price }], opts: App.drawings.defaultOpts('hline') };
          App.drawings.add(pane.symbol, d);
          App.drawings.save();
          if (App.undo) App.undo.push({ kind: 'add', symbol: pane.symbol, d });
          toast(`Horizontal line at ${P}`);
        } catch (e) {}
      });
    });
  };

  /* ---------- active pane ---------- */
  UI.setActivePane = function (pane) {
    if (Manager) Manager.setActive(pane);
  };

  /* ---------- toast ----------
     opts.actionLabel / opts.onAction: adds a click-through action button
     (e.g. "Undo") next to the close button. An actioned toast gets a
     longer auto-hide window (6s instead of 2.6s) so there's real time to
     react to a destructive change, and hiding is cancelled once the
     action fires so the confirmation ("Removed" -> "Restored") is legible. */
  function toast(msg, cls, opts) {
    opts = opts || {};
    const box = document.getElementById('toasts');
    const t = U.el('div', 'toast' + (cls ? ' ' + cls : ''), box);
    const S = Settings ? Settings.conf : {};
    const auto = S.toastAutoHide !== false;
    const actionBtn = opts.actionLabel
      ? `<button class="toast-action">${U.esc(opts.actionLabel)}</button>` : '';
    t.innerHTML = `<div class="t-body">${msg}</div>${actionBtn}<button class="toast-x" title="Close">${icon('x')}</button>`;
    const x = t.querySelector('.toast-x');
    x.addEventListener('click', () => t.remove());
    let hideTimers = [];
    const clearHide = () => { hideTimers.forEach(clearTimeout); hideTimers = []; };
    if (opts.actionLabel && opts.onAction) {
      t.querySelector('.toast-action').addEventListener('click', () => {
        clearHide();
        opts.onAction();
        t.remove();
      });
    }
    if (auto) {
      const hideAt = opts.actionLabel ? 6000 : 2600;
      const removeAt = opts.actionLabel ? 6400 : 3000;
      hideTimers.push(setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, hideAt));
      hideTimers.push(setTimeout(() => t.remove(), removeAt));
    } else {
      t.classList.add('sticky');
    }
    /* keep the toast box bounded */
    while (box.children.length > 6) box.firstChild.remove();
  }
  UI.toast = toast;

export { UI };
