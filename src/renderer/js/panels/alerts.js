/**
 * Price Alerts
 *
 * @module panels/alerts
 */

import { U } from '../core/util.js';
import { Log } from '../../../core/logger.js';
import { icon } from '../ui/icons.js';
import { App } from '../../../core/state.js';
import { priceDigits } from '../../../core/feed.js';
import { TZ } from '../../../core/timezone.js';
import { TOOLS } from '../drawing/tools.js';
import { Manager } from '../chart/manager.js';
import { Toolbar } from '../chart/toolbar.js';
import { UI } from '../drawing/ui.js';
import { Watchlist } from './watchlist.js';
import { ObjectTree } from './objects.js';
import { TradeAlerts } from '../trade/alerts.js';
import { OT_NAME } from '../trade/state.js';
import { PineUI } from '../chart/pine-ui.js'; /* ROUND279: Pine -> Alerts bridge */

let audioCtx = null;

  const Alerts = {
    list: U.lsGet('mt5_alerts', []),
    last: {},
    selected: null, /* ROUND51: id of the alert selected on the chart */
  };

  Alerts.lastPrice = (sym) => Alerts.last[sym] != null ? Alerts.last[sym] : (Watchlist.prices[sym] != null ? Watchlist.prices[sym] : null);

  /* ================= ROUND73: alert notification sounds =================
     The panel had ONE hardcoded beep. Now a persisted settings block lives
     in the Alerts panel itself (right panel):
       - master ON/OFF  (mute the alert sound)
       - 6 selectable sounds (WebAudio-synthesized, no new assets)
       - Repeat: 1 / 2 / 3 / 5 times, or Loop until stopped (with a ~10 min
         safety cap so a forgotten loop cannot run forever)
     A "Stop sound" button appears while a repeat chain is running. Toasts
     and the OS notification stay on — the master switch mutes audio only. */

  Alerts.cfg = U.lsGet('mt5_alert_cfg', { enabled: true, sound: 'beep', loop: 1 });
  function saveCfg() { U.lsSet('mt5_alert_cfg', Alerts.cfg); }

  /* per-play length (ms) -> the gap between repeats of the SAME sound */
  const SND_LEN = { beep: 650, double: 450, chime: 700, alarm: 900, bell: 850, urgent: 600 };
  const SND_LABELS = { beep: 'Beep', double: 'Double beep', chime: 'Chime', alarm: 'Alarm', bell: 'Bell', urgent: 'Urgent' };

  /* every generator receives (ctx, when) and schedules its own voices */
  const SOUNDS = {
    beep(c, t) { /* the original sine ping (kept as the default) */
      const o = c.createOscillator(), g = c.createGain();
      o.connect(g); g.connect(c.destination);
      o.type = 'sine'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
      o.start(t); o.stop(t + 0.6);
    },
    double(c, t) { /* two short pings */
      for (let i = 0; i < 2; i++) {
        const o = c.createOscillator(), g = c.createGain();
        o.connect(g); g.connect(c.destination);
        o.type = 'sine'; o.frequency.value = i ? 988 : 880;
        const s = t + i * 0.18;
        g.gain.setValueAtTime(0.2, s);
        g.gain.exponentialRampToValueAtTime(0.001, s + 0.14);
        o.start(s); o.stop(s + 0.16);
      }
    },
    chime(c, t) { /* rising two-tone doorbell */
      [660, 990].forEach((f, i) => {
        const o = c.createOscillator(), g = c.createGain();
        o.connect(g); g.connect(c.destination);
        o.type = 'sine'; o.frequency.value = f;
        const s = t + i * 0.16;
        g.gain.setValueAtTime(0.18, s);
        g.gain.exponentialRampToValueAtTime(0.001, s + 0.4);
        o.start(s); o.stop(s + 0.42);
      });
    },
    alarm(c, t) { /* alternating square bursts — classic alarm */
      for (let i = 0; i < 4; i++) {
        const o = c.createOscillator(), g = c.createGain();
        o.connect(g); g.connect(c.destination);
        o.type = 'square'; o.frequency.value = i % 2 ? 620 : 880;
        const s = t + i * 0.16;
        g.gain.setValueAtTime(0.09, s);
        g.gain.exponentialRampToValueAtTime(0.001, s + 0.12);
        o.start(s); o.stop(s + 0.13);
      }
    },
    bell(c, t) { /* struck bell: fundamental + harmonic, long decay */
      [[1320, 0.16], [1980, 0.06]].forEach(([f, v]) => {
        const o = c.createOscillator(), g = c.createGain();
        o.connect(g); g.connect(c.destination);
        o.type = 'triangle'; o.frequency.value = f;
        g.gain.setValueAtTime(v, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
        o.start(t); o.stop(t + 0.85);
      });
    },
    urgent(c, t) { /* two fast rising sweeps */
      for (let i = 0; i < 2; i++) {
        const o = c.createOscillator(), g = c.createGain();
        o.connect(g); g.connect(c.destination);
        o.type = 'sawtooth';
        const s = t + i * 0.22;
        o.frequency.setValueAtTime(900, s);
        o.frequency.linearRampToValueAtTime(1500, s + 0.16);
        g.gain.setValueAtTime(0.12, s);
        g.gain.exponentialRampToValueAtTime(0.001, s + 0.18);
        o.start(s); o.stop(s + 0.2);
      }
    },
  };
  Alerts.SOUNDS = SOUNDS; /* test/introspection facade */

  function playOnce() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.resume) audioCtx.resume().catch(() => {});
      const t0 = audioCtx.currentTime + 0.02;
      (SOUNDS[Alerts.cfg.sound] || SOUNDS.beep)(audioCtx, t0);
    } catch (e) {}
  }

  Alerts._sndTimers = [];
  function syncStopBtn() {
    const b = document.getElementById('alert-sound-stop');
    if (b) b.style.display = Alerts._sndTimers.length ? '' : 'none';
    /* ROUND130: a live dot rides the card header while a repeat chain runs —
       visible even when the body is collapsed */
    const head = document.querySelector('#alert-sound-settings .al-head');
    if (head) head.classList.toggle('al-playing', Alerts._sndTimers.length > 0);
  }

  /* stop a running repeat chain (Stop button / re-tick master off / a new
     alert event replacing the previous chain) */
  Alerts.stopSound = function () {
    for (const t of Alerts._sndTimers) clearTimeout(t);
    Alerts._sndTimers = [];
    syncStopBtn();
  };
  Alerts.playing = function () { return Alerts._sndTimers.length > 0; };

  function playSound() {
    Alerts.stopSound(); /* a new event replaces any running chain */
    if (Alerts.cfg.enabled === false) return; /* master mute */
    /* 'inf' loops until stopped — capped at ~500 plays (~10 min) so a
       forgotten loop can never run forever */
    const times = Alerts.cfg.loop === 'inf' ? 500 : Math.max(1, parseInt(Alerts.cfg.loop, 10) || 1);
    const gap = (SND_LEN[Alerts.cfg.sound] || 700) + 120;
    playOnce();
    for (let i = 1; i < times; i++) {
      const id = setTimeout(() => {
        const k = Alerts._sndTimers.indexOf(id);
        if (k >= 0) Alerts._sndTimers.splice(k, 1); /* fired: no longer pending */
        playOnce();
        syncStopBtn();
      }, i * gap);
      Alerts._sndTimers.push(id);
    }
    syncStopBtn();
  }

  /* one-shot preview when the user picks a different sound in the panel */
  Alerts.previewSound = function () { if (Alerts.cfg.enabled !== false) playOnce(); };

  /* the settings block inside the Alerts panel (right panel) — master mute,
     sound picker (with a preview on change), repeat/loop count, Stop button
     ROUND119 (user request): the old two plain selects became rounded cards
     with a SEGMENTED Repeat control (×1 ×2 ×3 ×5 ∞ Loop) — same cfg keys,
     same behavior, far easier to read and tap.
     ROUND130 (user request): the block is now a tidy accordion CARD — one
     unified header (icon + title + the mute switch + chevron) and a
     collapsible body with the picker / repeat / stop controls. The open
     state persists (mt5_as_open); every id and cfg key is unchanged. */
  let asOpen = U.lsGet('mt5_as_open', false) === true;
  function setAsOpen(v) { asOpen = !!v; try { U.lsSet('mt5_as_open', asOpen); } catch (e) {} }

  /* ===== ROUND131 (user request): soft, formal open/close animation =====
     The three accordion cards no longer snap. OPENING re-renders with the
     body present and plays a grid-rows 0fr -> 1fr expand keyframe plus a
     gentle fade; CLOSING plays a live collapse transition on the rendered
     body FIRST and only then swaps the DOM to the closed card. The persisted
     state flags flip immediately either way, so a reload mid-animation can
     never resurrect a card the user just closed. */
  const ACC_MS = 260;
  function accToggle(boxId, get, set, renderFn) {
    const box = document.getElementById(boxId);
    if (!box) return;
    if (!get()) {
      set(true); renderFn();
      const card = box.querySelector('.al-card');
      if (card) {
        card.classList.add('al-anim');
        setTimeout(() => { try { card.classList.remove('al-anim'); } catch (e) {} }, ACC_MS + 80);
      }
    } else {
      const card = box.querySelector('.al-card');
      if (!card || !card.querySelector('.al-body')) { set(false); renderFn(); return; }
      set(false);                       /* the persisted flag flips IMMEDIATELY */
      card.classList.add('al-closing'); /* collapse transition on the live body */
      setTimeout(() => { if (!get()) renderFn(); }, ACC_MS + 40);
    }
  }
  Alerts.accToggle = accToggle; /* test/introspection facade */
  function renderSoundSettings() {
    const box = document.getElementById('alert-sound-settings');
    if (!box) return;
    box.innerHTML = `
      <div class="al-card${asOpen ? ' al-open' : ''}">
        <div class="al-head" title="Notification sound">
          <span class="al-ico">${icon('volume')}</span>
          <span class="al-t">Sound &amp; repeat</span>
          <label class="sw-mini al-sw" title="Play alert sound">
            <input type="checkbox" id="alert-sound-on"><i></i>
          </label>
          <span class="al-chev">${icon('chevdown')}</span>
        </div>
        ${!asOpen ? '' : `
        <div class="al-collapse"><div class="al-collapse-in">
        <div class="al-body">
          <div class="alert-snd-row"><span>Sound</span><select id="alert-sound-select"></select></div>
          <div class="alert-snd-row"><span>Repeat</span>
            <span class="al-seg" id="alert-loop-seg">
              <button type="button" data-v="1" title="Play once">×1</button>
              <button type="button" data-v="2" title="Play twice">×2</button>
              <button type="button" data-v="3" title="Play three times">×3</button>
              <button type="button" data-v="5" title="Play five times">×5</button>
              <button type="button" data-v="inf" title="Loop until stopped">∞ Loop</button>
            </span>
          </div>
          <button class="mini-btn" id="alert-sound-stop">■ Stop sound</button>
        </div></div></div>`}
      </div>`;
    const head = box.querySelector('.al-head');
    head.addEventListener('click', (e) => {
      if (e.target.closest('.al-sw')) return; /* the switch is not the expander */
      accToggle('alert-sound-settings', () => asOpen, setAsOpen, renderSoundSettings);
    });
    const on = box.querySelector('#alert-sound-on');
    on.checked = Alerts.cfg.enabled !== false;
    on.addEventListener('change', () => {
      Alerts.cfg.enabled = on.checked; saveCfg();
      if (!on.checked) Alerts.stopSound(); /* muting also silences a running loop */
    });
    if (!asOpen) return; /* the picker/repeat/stop exist only in the open body */
    const sel = box.querySelector('#alert-sound-select');
    sel.innerHTML = Object.keys(SOUNDS).map((k) => `<option value="${k}">${SND_LABELS[k] || k}</option>`).join('');
    sel.value = SOUNDS[Alerts.cfg.sound] ? Alerts.cfg.sound : 'beep';
    sel.addEventListener('change', () => { Alerts.cfg.sound = sel.value; saveCfg(); Alerts.previewSound(); });
    /* the segmented Repeat control — one active pill, persisted as before */
    const seg = box.querySelector('#alert-loop-seg');
    const paintSeg = () => {
      const v = String(Alerts.cfg.loop == null ? 1 : Alerts.cfg.loop);
      for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === v);
    };
    paintSeg();
    seg.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-v]');
      if (!b) return;
      Alerts.cfg.loop = b.dataset.v === 'inf' ? 'inf' : parseInt(b.dataset.v, 10) || 1;
      saveCfg();
      paintSeg();
    });
    box.querySelector('#alert-sound-stop').addEventListener('click', () => Alerts.stopSound());
    /* hidden until a repeat chain runs — set via CSSOM (an inline style
       attribute would trip the app's CSP: style-src 'self' file:) */
    box.querySelector('#alert-sound-stop').style.display = 'none';
  }
  Alerts.renderSoundSettings = renderSoundSettings;

  Alerts.create = function (symbol, cond, price) {
    const a = { id: Date.now(), kind: 'price', symbol, cond, price, active: true, fired: false, created: Date.now(), firedAt: 0 };
    Alerts.list.push(a);
    save();
    render();
    if (Manager && Manager.applyPriceLines) for (const p of App.panes) if (p.symbol === symbol) Manager.applyPriceLines(p);
    UI.toast(`Alert created: ${symbol} ${cond} ${price}`, 'ok');
  };

  /* ROUND39: time-based alert — fires when the symbol's tick clock reaches
     `timeSec` (a CHART stamp, same base as the bars/axis). Drawn as a
     vertical mark by the overlay painter below. */
  Alerts.createTime = function (symbol, timeSec) {
    const a = { id: Date.now(), kind: 'time', symbol, time: Math.round(timeSec), active: true, fired: false, created: Date.now() };
    Alerts.list.push(a);
    save();
    render();
    UI.toast(`Time alert created: ${symbol} at ${fmtClock(a.time)}`, 'ok');
  };

  function fmtClock(sec) {
    const p = TZ.parts(App.tz, sec);
    return `${p.dow} ${p.day} ${p.monthShort} ${p.hour}:${p.minute}`;
  }
  Alerts.fmtAlertTime = fmtClock;

  /* ROUND128 (user request): the alert DETAILS name the moment the alert
     actually fired. Wall-clock (device) ms -> the app's selected timezone
     through the same TZ.parts funnel the chart axis uses (chart stamps are
     broker-wall seconds = true-UTC + serverOff, so shift the wall stamp by
     the same offset before formatting). */
  function fmtWallTz(ms) {
    if (!(ms > 0)) return '';
    const off = (App.feed && App.feed.serverOff) || 0;
    const p = TZ.parts(App.tz, Math.floor(ms / 1000) + off);
    return p.year + '.' + p.month + '.' + p.day + ' ' + p.hour + ':' + p.minute + ':' + p.second;
  }
  Alerts.fmtWallTz = fmtWallTz;

  /* UX FIX: same class of fix as Watchlist.remove — removal is optimistic
     and reversible via an "Undo" toast for a few seconds instead of being
     instant + permanent on a single click. */
  Alerts.remove = function (id) {
    const a = Alerts.list.find((x) => x.id === id);
    if (!a) return;
    const idx = Alerts.list.indexOf(a);
    if (Alerts.selected === id) Alerts.selected = null; /* ROUND51: gone = deselected */
    Alerts.list = Alerts.list.filter((x) => x.id !== id);
    save();
    render();
    if (Manager && Manager.applyPriceLines) for (const p of App.panes) if (p.symbol === a.symbol) Manager.applyPriceLines(p);
    if (UI && UI.toast) {
      UI.toast(`Alert removed — ${U.esc(a.symbol)}`, null, {
        actionLabel: 'Undo',
        onAction: () => {
          if (Alerts.list.some((x) => x.id === id)) return; /* already restored/duplicated elsewhere */
          Alerts.list.splice(Math.min(idx, Alerts.list.length), 0, a);
          save();
          render();
          if (Manager && Manager.applyPriceLines) for (const p of App.panes) if (p.symbol === a.symbol) Manager.applyPriceLines(p);
        },
      });
    }
  };

  Alerts.toggle = function (id) {
    const a = Alerts.list.find((x) => x.id === id);
    if (a) { a.active = !a.active; if (a.active) a.fired = false; save(); render(); if (Manager && Manager.applyPriceLines) for (const p of App.panes) if (p.symbol === a.symbol) Manager.applyPriceLines(p); }
  };

  /* AUDIT FIX (alerts outliving their chart): an armed alert used to fire only
     while its symbol happened to be on a chart/watchlist, because nothing
     acquired a feed subscription for the alert itself — closing the last tab
     of that symbol silently disarmed it. Every active/unfired alert now holds
     ONE ref-counted subscription (same Manager bookkeeping the Watchlist and
     tab labels use), so it keeps ticking after its chart is gone. */
  const alertSubs = new Set();
  function syncAlertSubs() {
    if (!Manager || !Manager.acquireSub || !Manager.releaseSub) return;
    const wanted = new Set();
    for (const a of Alerts.list) {
      if (a && a.active && !a.fired && typeof a.symbol === 'string' && a.symbol) wanted.add(a.symbol);
    }
    for (const sym of Array.from(alertSubs)) {
      if (wanted.has(sym)) continue;
      alertSubs.delete(sym);
      try { Manager.releaseSub(sym); } catch (e) { Log.debug('alerts', 'alert unsubscribe failed', e) }
    }
    for (const sym of wanted) {
      if (alertSubs.has(sym)) continue;
      alertSubs.add(sym);
      try { Manager.acquireSub(sym); } catch (e) { alertSubs.delete(sym); }
    }
  }
  Alerts.syncSubs = syncAlertSubs;

  function save() { U.lsSet('mt5_alerts', Alerts.list); syncAlertSubs(); }
  Alerts.persist = save; /* ROUND51: alert drag-commit hook (engine.up) */

  function render() {
    const box = document.getElementById('alert-list');
    U.clear(box);
    if (!Alerts.list.length) {
      box.innerHTML = `<div class="alert-empty">${icon('bell')}No alerts yet.<br>Click the bell in the top toolbar, or right-click the chart, to create one.</div>`;
      return;
    }
    /* ROUND119 (user request): card rows — status edge + symbol + condition
       chip + price on one line, a TV-like switch and hover-revealed
       edit/delete actions. Same behaviors: toggle re-arms, edit opens the
       manage dialog, delete has the Undo toast. */
    for (const a of Alerts.list) {
      const armed = a.active && !a.fired;
      const row = U.el('div', 'alert-row' + (a.fired ? ' done' : '') + (armed ? ' armed' : ''), box);
      const main = U.el('div', 'a-main', row);
      const top = U.el('div', 'a-top', main);
      const sym = U.el('span', 'a-sym', top);
      sym.textContent = a.symbol;
      const chip = U.el('span', 'a-chip' + (a.kind === 'time' ? ' a-chip-time' : ''), top);
      const price = U.el('span', 'a-price', top);
      if (a.kind === 'time') {
        chip.textContent = 'Time';
        price.textContent = fmtClock(a.time);
      } else {
        chip.textContent = a.cond;
        price.textContent = U.fmtPrice(a.price, priceDigits(a.symbol));
      }
      const sub = U.el('div', 'a-sub', main);
      if (a.fired) {
        /* ROUND128: "Triggered — switch on to re-arm" now carries the WHEN */
        sub.innerHTML = '<span class="a-fired">Triggered' +
          (a.firedAt ? ' at ' + fmtWallTz(a.firedAt) : '') +
          ' — switch on to re-arm</span>';
        sub.title = a.firedAt ? 'Fired ' + fmtWallTz(a.firedAt) : '';
      }
      else sub.textContent = (a.kind === 'time' ? 'Time alert' : 'Price alert') + (armed ? ' · armed' : ' · off');
      const ctr = U.el('div', 'a-ctr', row);
      const tog = U.el('button', 'a-switch' + (armed ? ' on' : ''), ctr);
      tog.title = a.active ? 'Disable alert' : 'Enable alert (re-arms a triggered one)';
      tog.addEventListener('click', () => Alerts.toggle(a.id));
      const edit = U.el('button', 'mini-btn a-edit', ctr);
      edit.innerHTML = icon('pencil');
      edit.title = 'Edit alert';
      edit.addEventListener('click', () => Alerts.openManageDialog(a));
      const del = U.el('button', 'mini-btn a-del', ctr);
      del.innerHTML = icon('trash');
      del.title = 'Delete';
      del.addEventListener('click', () => Alerts.remove(a.id));
    }
  }
  Alerts.render = render;

  /* price-bar parity fix: route through the central helper — the provider's
     real digit count (feed.digitsBySym) wins over the old regex heuristic,
     so alert rows always print prices with the same digits as the chart. */
  /* priceDigits() comes from core/feed.js (module import) */

  Alerts.onTick = function (symbol, price, tickTime) {
    const prev = Alerts.last[symbol];
    Alerts.last[symbol] = price;
    let changed = false;
    for (const a of Alerts.list) {
      if (a.symbol !== symbol || !a.active || a.fired) continue;
      /* ROUND39: time-based alerts ride the same tick stream — the tick's
         server time (chart stamp, same base as barTimes) reaching the target
         fires the alert, so it works on live charts AND in bar replay. */
      if (a.kind === 'time') {
        if (tickTime != null && tickTime >= a.time) {
          a.fired = true;
          a.active = false;
          a.firedAt = Date.now();   /* ROUND128: shown in the alert details */
          changed = true;
          const msg = `${symbol} time alert — reached ${fmtClock(a.time)}`;
          UI.toast('Alert triggered: ' + msg, 'warn');
          try { window.electronAPI && window.electronAPI.notify('Time Alert', msg); } catch (e) {}
          playSound();
        }
        continue;
      }
      let fire = false;
      const p = a.price;
      switch (a.cond) {
        case 'Crossing Up': fire = prev != null && prev < p && price >= p; break;
        case 'Crossing Down': fire = prev != null && prev > p && price <= p; break;
        case 'Crossing': fire = prev != null && ((prev < p && price >= p) || (prev > p && price <= p)); break;
        case 'Greater Than': fire = price >= p; break;
        case 'Less Than': fire = price <= p; break;
      }
      if (fire) {
        a.fired = true;
        a.active = false;
        a.firedAt = Date.now();     /* ROUND128: shown in the alert details */
        changed = true;
        const msg = `${symbol} ${a.cond} ${U.fmtPrice(p, priceDigits(symbol))} — now ${U.fmtPrice(price, priceDigits(symbol))}`;
        UI.toast('Alert triggered: ' + msg, 'warn');
        try { window.electronAPI && window.electronAPI.notify('Price Alert', msg); } catch (e) {}
        playSound();
        if (Manager && Manager.applyPriceLines) for (const pn of App.panes) if (pn.symbol === symbol) Manager.applyPriceLines(pn);
      }
    }
    pollPineAlerts(); /* ROUND279: drain live Pine alerts on every tick stream */
    if (changed) { save(); render(); }
  };

  /* ================= ROUND85E: Trading alerts (the user's trades) =================
     A self-contained settings block inside the Alerts panel, next to the
     notification-sound settings:
       - master switch (off = totally silent, nothing is armed/fired)
       - three alert-type switches (pending activated / SL hit / TP hit)
         that gate new AND running trades
       - a live per-trade list: each open position gets SL/TP toggles,
         each pending order gets an activation toggle
     Detection lives in trade/alerts.js; this block only renders state and
     routes fired events to the SAME notification path as price alerts
     (toast + OS notification + the configured alert sound). */

  /* ROUND130: the block became a tidy accordion CARD (mt5_ta_open persists
     the open state) — the master switch lives ON the header row, the three
     type switches and the per-trade list live in the collapsible body. */
  let taOpen = U.lsGet('mt5_ta_open', false) === true;
  function setTaOpen(v) { taOpen = !!v; try { U.lsSet('mt5_ta_open', taOpen); } catch (e) {} }
  function renderTradeAlerts() {
    const box = document.getElementById('trade-alert-settings');
    if (!box) return;
    const c = TradeAlerts.cfg;
    const on = c.enabled !== false;
    box.innerHTML = `
      <div class="al-card${taOpen ? ' al-open' : ''}">
        <div class="al-head" title="Trading alerts">
          <span class="al-ico">${icon('shield')}</span>
          <span class="al-t">Trading alerts</span>
          <label class="sw-mini al-sw" title="Notify about my trades">
            <input type="checkbox" id="ta-enabled"><i></i>
          </label>
          <span class="al-chev">${icon('chevdown')}</span>
        </div>
        ${!taOpen ? '' : !on ? `
        <div class="al-collapse"><div class="al-collapse-in">
        <div class="al-body"><div class="ta-dim">Off — no trade notifications. Turn the switch above on to get an alert when a pending order activates or a trade's SL/TP is hit.</div></div>
        </div></div>`
        : `
        <div class="al-collapse"><div class="al-collapse-in">
        <div class="al-body">
          <div class="ta-defs">
            <label class="sw-row"><input type="checkbox" id="ta-fill"><i></i><span>Pending order activated</span></label>
            <label class="sw-row"><input type="checkbox" id="ta-sl"><i></i><span>Stop loss hit</span></label>
            <label class="sw-row"><input type="checkbox" id="ta-tp"><i></i><span>Take profit hit</span></label>
          </div>
          <div id="ta-list"></div>
        </div></div></div>`}
      </div>`;
    const head = box.querySelector('.al-head');
    head.addEventListener('click', (e) => {
      if (e.target.closest('.al-sw')) return; /* the switch is not the expander */
      accToggle('trade-alert-settings', () => taOpen, setTaOpen, renderTradeAlerts);
    });
    const en = box.querySelector('#ta-enabled');
    en.checked = on;
    en.addEventListener('change', () => {
      TradeAlerts.setCfg('enabled', en.checked);
      if (en.checked) { setTaOpen(true); renderTradeAlerts(); }  /* show what just got armed */
    });
    if (!taOpen || !on) return;
    for (const [id, key] of [['ta-fill', 'onFill'], ['ta-sl', 'onSL'], ['ta-tp', 'onTP']]) {
      const el = box.querySelector('#' + id);
      el.checked = c[key] !== false;
      el.addEventListener('change', () => TradeAlerts.setCfg(key, el.checked));
    }
    const list = box.querySelector('#ta-list');
    if (!TradeAlerts.items.length) {
      list.innerHTML = '<div class="ta-dim">No trades yet — alerts arm automatically for each new trade. Use the switches above to change what new trades get.</div>';
      return;
    }
    for (const it of TradeAlerts.items) {
      const row = U.el('div', 'ta-row', list);
      const nm = it.kind === 'pos'
        ? `<b>${it.symbol}</b> ${it.type === 0 ? 'BUY' : 'SELL'} ${it.vol} <span class="ta-t">#${it.ticket}</span>`
        : `<b>${it.symbol}</b> ${OT_NAME[it.type] || 'Order'} ${it.vol} <span class="ta-t">#${it.ticket}</span>`;
      U.el('div', 'ta-name', row).innerHTML = nm;
      const mk = (field, label, checked) => {
        const l = U.el('label', 'sw-mini sw-xs ta-tog', row);
        l.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''}><i></i><em>${label}</em>`;
        l.querySelector('input').addEventListener('change', (e) => TradeAlerts.setItem(it.ticket, field, e.target.checked));
      };
      if (it.kind === 'pos') {
        mk('sl', 'SL', it.sl);
        mk('tp', 'TP', it.tp);
      } else {
        mk('fill', 'FILL', it.fill);
      }
    }
  }
  Alerts.renderTradeAlerts = renderTradeAlerts;

  /* fired trade alerts use the SAME notification path as price alerts */
  TradeAlerts.onFire.push((ev) => {
    UI.toast('Trade alert: ' + ev.msg, ev.type === 'sl' ? 'warn' : 'ok');
    try { window.electronAPI && window.electronAPI.notify('Trade Alert', ev.msg); } catch (e) {}
    playSound();
  });

  /* ============ ROUND128+129+130: Trade notifications (the bell card) ======
     Every trade event the app raises — trade set (market / pending),
     pending activated, SL/TP changed, partial close, position closed,
     SL/TP hit — is listed with its time. ROUND129 (user request) moved
     the list BEHIND a Notification (bell) icon in this same Alerts
     section. ROUND130 (user request) finished the job: the block is now
     the SAME tidy accordion card as its neighbors —
       - one unified header: bell chip (carrying the live count badge) +
         title + the capture master switch + chevron
       - clicking the header (bell / title / chevron) expands the list +
         details right here; clicking again collapses it — the choice
         persists
       - the list self-cleans: the app purges events older than 24 h
         once a day (trade/alerts.js purgeNlog) and the user keeps the
         manual levers — per-row delete + Clear all */
  const NLOG_TAG = {
    open: 'OPEN', place: 'ORDER', fill: 'FILL', slmod: 'SL', tpmod: 'TP',
    partial: 'PARTIAL', close: 'CLOSE', sl: 'SL HIT', tp: 'TP HIT',
  };
  let tnOpen = U.lsGet('mt5_tn_open', false) === true;
  function setTnOpen(v) { tnOpen = !!v; try { U.lsSet('mt5_tn_open', tnOpen); } catch (e) {} }
  function renderNotifyLog() {
    const box = document.getElementById('trade-notify-log');
    if (!box) return;
    const on = TradeAlerts.cfg.notifyLog === true;
    const n = TradeAlerts.nlog.length;
    /* keep the reader's scroll across the 1.2 s re-renders */
    const prevList = box.querySelector('#tn-list');
    const prevScroll = prevList ? prevList.scrollTop : 0;
    /* the next automatic sweep (gated to once per day upstream) */
    const left = TradeAlerts.purgeInMin();
    const nextTxt = !left ? ' — sweep due now'
      : left >= 90 ? ` — next sweep in ~${Math.round(left / 60)} h`
      : ` — next sweep in ~${left} min`;
    box.innerHTML = `
      <div class="al-card al-tn${tnOpen ? ' al-open' : ''}">
        <div class="al-head" title="Trade notifications">
          <button class="tn-bell" id="tn-bell"
            title="${tnOpen ? 'Hide trade notifications' : 'Show trade notifications'}"
            aria-expanded="${tnOpen ? 'true' : 'false'}">${icon('bell')}
            <span class="tn-badge${n ? '' : ' tn-zero'}" id="tn-badge">${n > 99 ? '99+' : n}</span>
          </button>
          <span class="tn-title" id="tn-title">Trade notifications</span>
          <label class="sw-mini al-sw" title="Keep a deletable, time-stamped list of my trade events">
            <input type="checkbox" id="tn-enabled"><i></i>
          </label>
          <span class="al-chev">${icon('chevdown')}</span>
        </div>
        ${!tnOpen ? '' : !on
        ? `<div class="al-collapse"><div class="al-collapse-in"><div class="al-body"><div class="ta-dim">Off — trade events are not listed. Turn the switch above on to keep a deletable list of every trade set, SL/TP change, activation and close with its time.</div></div></div></div>`
        : `
        <div class="al-collapse"><div class="al-collapse-in">
        <div class="al-body">
          <div class="tn-toolbar"><span class="tn-count">${n} event(s)${n ? ' · daily auto-purge' : ''}</span>
            <button class="mini-btn" id="tn-clear">Clear all</button></div>
          <div id="tn-list" class="tn-list"></div>
          <div class="ta-dim tn-hint">Auto-cleanup: events older than 24 h are purged automatically once a day${nextTxt}.</div>
        </div></div></div>`}
      </div>`;
    /* the whole header expands — except the switch (it only toggles capture)
       and the bell/title, which own their tested click handlers below */
    const head = box.querySelector('.al-head');
    head.addEventListener('click', (e) => {
      if (e.target.closest('.al-sw') || e.target.closest('#tn-bell') || e.target.closest('#tn-title')) return;
      accToggle('trade-notify-log', () => tnOpen, setTnOpen, renderNotifyLog);
    });
    const bell = box.querySelector('#tn-bell');
    bell.addEventListener('click', () => accToggle('trade-notify-log', () => tnOpen, setTnOpen, renderNotifyLog));
    box.querySelector('#tn-title').addEventListener('click', () => accToggle('trade-notify-log', () => tnOpen, setTnOpen, renderNotifyLog));
    const en = box.querySelector('#tn-enabled');
    en.checked = on;
    en.addEventListener('change', () => {
      TradeAlerts.setCfg('notifyLog', en.checked);
      if (en.checked) { setTnOpen(true); renderNotifyLog(); }  /* show the list appear */
    });
    if (!tnOpen || !on) return;
    box.querySelector('#tn-clear').addEventListener('click', () => TradeAlerts.clearNlog());
    const list = box.querySelector('#tn-list');
    if (!TradeAlerts.nlog.length) {
      list.innerHTML = '<div class="ta-dim">No events yet — open, modify or close a trade and it will be listed here with its time.</div>';
      return;
    }
    for (const r of TradeAlerts.nlog.slice(0, 80)) {
      const row = U.el('div', 'tn-row', list);
      const tag = U.el('span', 'tn-tag tn-' + (r.type || 'info'), row);
      tag.textContent = NLOG_TAG[r.type] || 'INFO';
      const mid = U.el('div', 'tn-main', row);
      U.el('div', 'tn-msg', mid).textContent = r.msg || '';
      U.el('div', 'tn-time', mid).textContent = fmtWallTz(r.at);
      const del = U.el('button', 'mini-btn tn-del', row);
      del.innerHTML = icon('trash');
      del.title = 'Delete this notification';
      del.addEventListener('click', () => TradeAlerts.removeNlog(r.id));
    }
    if (prevScroll > 0) list.scrollTop = prevScroll;
  }
  Alerts.renderNotifyLog = renderNotifyLog;

  /* ================= ROUND279: Pine script alerts =================
     Pine's alert() / alertcondition() now reach this panel. The engine
     publishes a LIVE-ONLY tape (historical bars never emit, a full pass only
     exposes its final bar and the renderer skips that pass as replay) and
     PineUI.pollAlerts() drains it through the sink registered below.
     Everything routes through the SAME toast + OS notification + sound path
     as price/trade alerts. Per-condition arm switches persist in mt5_pa_cfg. */
  Alerts.pineCfg = Object.assign({ enabled: true, messages: true, conds: {} }, U.lsGet('mt5_pa_cfg', {}));
  if (!Alerts.pineCfg.conds || typeof Alerts.pineCfg.conds !== 'object') Alerts.pineCfg.conds = {};
  function savePineCfg() { U.lsSet('mt5_pa_cfg', Alerts.pineCfg); }
  let paOpen = U.lsGet('mt5_pa_open', false) === true;
  function setPaOpen(v) { paOpen = !!v; try { U.lsSet('mt5_pa_open', paOpen); } catch (e) {} }
  let paSig = '';

  function pineInvSig(items) { return items.map((x) => x.key).join('\n'); }

  function renderPineAlerts(inv) {
    const box = document.getElementById('pine-alert-settings');
    if (!box) return;
    const c = Alerts.pineCfg;
    const enabled = c.enabled !== false;
    const items = inv || PineUI.pineAlertInventory();
    paSig = pineInvSig(items);
    box.innerHTML = `
      <div class="al-card${paOpen ? ' al-open' : ''}">
        <div class="al-head" title="Pine script alerts">
          <span class="al-ico">${icon('bolt')}</span>
          <span class="al-t">Script alerts</span>
          <label class="sw-mini al-sw" title="Notify about Pine script alerts">
            <input type="checkbox" id="pa-enabled"><i></i>
          </label>
          <span class="al-chev">${icon('chevdown')}</span>
        </div>
        ${!paOpen ? '' : !enabled ? `
        <div class="al-collapse"><div class="al-collapse-in">
        <div class="al-body"><div class="ta-dim">Off — alert() and alertcondition() calls from Pine scripts are silent. Turn the switch above on to receive their messages here.</div></div>
        </div></div>`
        : `
        <div class="al-collapse"><div class="al-collapse-in">
        <div class="al-body">
          <div class="ta-defs">
            <label class="sw-row"><input type="checkbox" id="pa-messages"><i></i><span>alert() messages</span></label>
          </div>
          <div class="ta-defs" id="pa-live"></div>
          <div class="ta-dim" id="pa-hint">Live bars only — history replay is silent. Each condition keeps its own arm switch; alert() messages share the switch above.</div>
        </div></div></div>`}
      </div>`;
    const head = box.querySelector('.al-head');
    head.addEventListener('click', (e) => {
      if (e.target.closest('.al-sw')) return; /* the switch is not the expander */
      accToggle('pine-alert-settings', () => paOpen, setPaOpen, renderPineAlerts);
    });
    const en = box.querySelector('#pa-enabled');
    en.checked = enabled;
    en.addEventListener('change', () => {
      c.enabled = en.checked;
      savePineCfg();
      if (en.checked) { setPaOpen(true); renderPineAlerts(); } /* show what just got armed */
    });
    if (!paOpen || !enabled) return;
    const msg = box.querySelector('#pa-messages');
    msg.checked = c.messages !== false;
    msg.addEventListener('change', () => { c.messages = msg.checked; savePineCfg(); });
    const live = box.querySelector('#pa-live');
    if (!items.length) {
      live.innerHTML = '<div class="ta-dim">No alertconditions yet — they appear here once a Pine indicator with alertcondition() loads.</div>';
      return;
    }
    for (const it of items) {
      const row = U.el('div', 'ta-row', live);
      const nm = U.el('div', 'ta-name', row);
      nm.innerHTML = `<b>${U.esc(it.script || 'Pine Script')}</b> <span class="ta-t">${U.esc(it.title || 'Alert condition')}</span>`;
      const l = U.el('label', 'sw-mini sw-xs ta-tog', row);
      l.innerHTML = '<input type="checkbox"><i></i><em>ARM</em>';
      const input = l.querySelector('input');
      input.checked = c.conds[it.key] !== false;
      input.addEventListener('change', () => {
        c.conds[it.key] = input.checked;
        savePineCfg();
      });
    }
  }
  Alerts.renderPineAlerts = renderPineAlerts;

  /* fired Pine alerts use the SAME notification path as price alerts */
  Alerts.onPineAlert = function (ev) {
    if (!ev) return;
    const c = Alerts.pineCfg;
    if (c.enabled === false) return;
    if (ev.kind === 'alert' && c.messages === false) return;
    if (ev.kind === 'condition' && c.conds[ev.key] === false) return;
    const parts = [];
    if (ev.kind === 'condition' && ev.title) parts.push(ev.title);
    if (ev.message) parts.push(ev.message);
    const body = parts.join(' — ') || 'Script alert fired';
    const label = (ev.script ? ev.script + ' · ' : '');
    UI.toast('Pine alert: ' + label + body, 'warn');
    try { window.electronAPI && window.electronAPI.notify('Pine Alert', label + body); } catch (e) {}
    playSound();
  };

  /* drain the live tape; a signature check keeps idle ticks from repainting.
     A fired event never needs a repaint — the card only lists conditions. */
  let paPollAt = 0;
  function pollPineAlerts(force) {
    const now = Date.now();
    if (!force && now - paPollAt < 200) return;
    paPollAt = now;
    PineUI.pollAlerts();
    const items = PineUI.pineAlertInventory();
    const sig = pineInvSig(items);
    if (sig === paSig) return;
    paSig = sig;
    if (paOpen) renderPineAlerts(items); /* collapsed: the next open re-renders */
  }
  Alerts.pollPineAlerts = pollPineAlerts;

  Alerts.init = function () {
    document.getElementById('alert-new-btn').innerHTML = icon('plus');
    document.getElementById('alert-new-btn').addEventListener('click', () => {
      Toolbar.openAlertDialog(App.activePane ? App.activePane.symbol : null);
    });
    renderSoundSettings(); /* ROUND73: notification-sound settings block */
    renderTradeAlerts();   /* ROUND85E: trading-alerts settings block */
    renderNotifyLog();     /* ROUND128: trade-notification list block */
    renderPineAlerts();    /* ROUND279: Pine script alerts block */
    try { PineUI.setAlertSink(Alerts.onPineAlert); } catch (e) {} /* ROUND279 */
    TradeAlerts.onChange.push(renderTradeAlerts);
    TradeAlerts.onChange.push(renderNotifyLog);
    render();
    syncAlertSubs(); /* armed alerts restored from storage keep their symbols live */
  };

  (App.onTickHooks = App.onTickHooks || []).push(Alerts.onTick);

  /* ================= ROUND39: chart↔panel alert management =================
     - right-click chart -> "Add alert at <price>" / "Add time alert at <time>"
       / "Manage alert…" when the click sits on an existing alert mark
     - the Alerts panel rows gain an Edit (pencil) action
     - time alerts paint a full-height amber mark via App.overlayMarkPainters */

  /* chart stamp <-> <input type=datetime-local> wall string in the ACTIVE tz */
  function chartToWall(sec) {
    const tz = App.tz;
    const off = (App.feed && App.feed.serverOff) || 0;
    let d;
    if (tz === 'broker') d = new Date(sec * 1000);
    else if (tz === 'UTC') d = new Date((sec - off) * 1000);
    else {
      const utc = sec - off;
      let zoff = 0;
      try { zoff = TZ.zoneOffsetMinutes(tz, new Date(utc * 1000)) * 60; } catch (e) {}
      d = new Date((utc + zoff) * 1000);
    }
    const p2 = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }
  function wallToChart(wall) {
    const tz = App.tz;
    const off = (App.feed && App.feed.serverOff) || 0;
    const asUTC = Date.parse(wall + ':00Z') / 1000; // wall read as UTC first
    if (!isFinite(asUTC)) return NaN;
    if (tz === 'broker') return Math.round(asUTC);
    if (tz === 'UTC') return Math.round(asUTC + off);
    let zoff = 0;
    try { zoff = TZ.zoneOffsetMinutes(tz, new Date(asUTC * 1000)) * 60; } catch (e) {}
    return Math.round(asUTC - zoff + off);
  }

  /* edit / create dialog for BOTH kinds (manage from panel row or chart) */
  Alerts.openManageDialog = function (a, pane) {
    if (!a) return;
    const layer = document.getElementById('popup-layer');
    layer.classList.remove('hidden');
    U.clear(layer);
    const back = U.el('div', 'dialog-backdrop', layer);
    const dlg = U.el('div', 'dialog', back);
    const isTime = a.kind === 'time';
    const CONDS = ['Crossing Up', 'Crossing Down', 'Crossing', 'Greater Than', 'Less Than'];
    dlg.innerHTML = `<h3>${a.created && Alerts.list.includes(a) ? 'Manage' : 'New'} Alert — ${U.esc(a.symbol)}<button class="mini-btn dlg-x">${icon('x')}</button></h3>` +
      (isTime
        ? `<div class="dlg-row"><label>Trigger at (${App.tz === 'broker' ? 'server time' : App.tz})<input type="datetime-local" id="ma-time" value="${chartToWall(a.time)}" spellcheck="false"></label></div>`
        : `<div class="dlg-row"><label>Condition<select id="ma-cond">${CONDS.map((c) => `<option${c === a.cond ? ' selected' : ''}>${c}</option>`).join('')}</select></label></div>
           <div class="dlg-row"><label>Price<input type="text" id="ma-price" value="${a.price}" spellcheck="false"></label></div>`) +
      `<div class="dlg-row"><label class="u-row-inline">
         <input type="checkbox" id="ma-active" class="u-checkbox-inline" ${a.active ? 'checked' : ''}> <span>Active</span>
       </label></div>
       <div class="dlg-actions">
         <button class="dlg-btn dlg-ghost" id="ma-delete">Delete</button>
         <button class="dlg-btn dlg-ghost" id="ma-cancel">Cancel</button>
         <button class="dlg-btn dlg-primary" id="ma-save">Save</button>
       </div>`;
    const close = () => { layer.classList.add('hidden'); U.clear(layer); };
    dlg.querySelector('.dlg-x').addEventListener('click', close);
    dlg.querySelector('#ma-cancel').addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    ['ma-cond', 'ma-price', 'ma-time'].forEach((id) => {
      const el = dlg.querySelector('#' + id);
      if (el) el.addEventListener('keydown', (e) => e.stopPropagation());
    });
    dlg.querySelector('#ma-delete').addEventListener('click', () => { Alerts.remove(a.id); close(); });
    dlg.querySelector('#ma-save').addEventListener('click', () => {
      if (isTime) {
        const c = wallToChart(dlg.querySelector('#ma-time').value);
        if (!isFinite(c)) { dlg.querySelector('#ma-time').style.borderColor = '#f23645'; return; }
        /* TV: a NEW time alert cannot be placed in the past (it would fire on
           the very next tick). Editing an EXISTING one to a past moment is
           allowed — honest semantics: it fires immediately. */
        if (!Alerts.list.includes(a) && c <= Math.floor(Date.now() / 1000) + ((App.feed && App.feed.serverOff) || 0)) {
          dlg.querySelector('#ma-time').style.borderColor = '#f23645';
          UI.toast('Pick a future time for the alert', 'warn');
          return;
        }
        a.time = c;
      } else {
        const price = parseFloat(dlg.querySelector('#ma-price').value);
        if (!isFinite(price) || price <= 0) { dlg.querySelector('#ma-price').style.borderColor = '#f23645'; return; }
        a.price = price;
        a.cond = dlg.querySelector('#ma-cond').value;
      }
      const wasActive = a.active;
      a.active = dlg.querySelector('#ma-active').checked;
      if (a.active && !wasActive) a.fired = false; // re-arm
      if (!Alerts.list.includes(a)) Alerts.list.push(a); // create-mode object
      save();
      render();
      if (Manager && Manager.applyPriceLines) for (const p of App.panes) if (p.symbol === a.symbol) Manager.applyPriceLines(p);
      UI.toast('Alert updated', 'ok');
      close();
    });
    setTimeout(() => { const el = dlg.querySelector('#ma-time') || dlg.querySelector('#ma-price'); if (el) el.focus(); }, 40);
  };

  /* create-mode time alert (right-click -> "Add time alert at …") */
  Alerts.openTimeDialog = function (pane, presetSec) {
    const symbol = pane ? pane.symbol : (App.activePane ? App.activePane.symbol : 'EURUSD');
    const sec = presetSec != null ? presetSec : Math.floor(Date.now() / 1000) + ((App.feed && App.feed.serverOff) || 0) + 3600;
    Alerts.openManageDialog({ kind: 'time', symbol, time: sec, active: true, fired: false, created: 0 });
  };

  /* -------- overlay painter: full-height mark per active time alert -------- */
  function paintTimeAlerts(pane, v, ctx) {
    const mine = Alerts.list.filter((a) => a.kind === 'time' && a.symbol === pane.symbol && a.active && !a.fired);
    if (!mine.length) return;
    const lanes = v._markLanes || (v._markLanes = []); // shared with the news chips
    ctx.save();
    ctx.setLineDash([]);
    ctx.textBaseline = 'middle';
    for (const a of mine) {
      const x = v.xOf(a.time);
      if (x < -60 || x > v.pw + 60) continue;
      ctx.save();
      ctx.strokeStyle = '#f7c948';
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, v.ph);
      ctx.stroke();
      ctx.restore();
      /* bell chip at the top (TV "alarm" look), lane-stacked under news chips */
      const p = TZ.parts(App.tz, a.time);
      const label = `ALERT  ${p.hour}:${p.minute}`;
      ctx.font = '600 9.5px "Segoe UI", Arial, sans-serif';
      const w = ctx.measureText(label).width + 12;
      let lane = 0;
      while (lane < 4 && lanes.some((b) => b.lane === lane && x < b.x1 + 6 && x + w > b.x0 - 6)) lane++;
      if (lane >= 4) continue;
      const y = 4 + lane * 15;
      lanes.push({ lane, x0: x, x1: x + w });
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = '#f7c948';
      ctx.beginPath();
      (ctx.roundRect ? ctx.roundRect(x, y, w, 13, 3) : ctx.rect(x, y, w, 13));
      ctx.fill();
      ctx.fillStyle = '#1c2030';
      ctx.fillText(label, x + 6, y + 7);
    }
    ctx.restore();
  }
  App.overlayMarkPainters = App.overlayMarkPainters || [];
  if (!App.overlayMarkPainters.includes(paintTimeAlerts)) App.overlayMarkPainters.push(paintTimeAlerts);

  /* proximity probe for the chart context menu: return the alert under the
     cursor (price line ±6px, or time mark ±7px) */
  Alerts.alertAt = function (pane, x, y) {
    const eng = pane && pane.engine;
    const v = eng && eng._view;
    if (!v) return null;
    for (const a of Alerts.list) {
      if (a.symbol !== pane.symbol || !a.active || a.fired) continue;
      if (a.kind === 'time') {
        if (Math.abs(v.xOf(a.time) - x) < 7) return a;
      } else if (a.price != null) {
        if (Math.abs(v.yOf(a.price) - y) < 6) return a;
      }
    }
    return null;
  };

  /* ================= drawing alerts (TV "Add alert on drawing", round 21) =================
     A rectangle/ellipse turns into a price ZONE: Crossing Up/Down (through the
     lower/upper edge), Inside, Outside. Line tools alert on their first point
     (level crossing). Everything is local + display-only: toast + beep. */

  const dPrev = {}; // symbol -> last checked price (independent from level alerts)

  function bandOf(d) {
    const ps = d.points.map((p) => p.p).filter((v) => isFinite(v));
    if (!ps.length) return null;
    return { top: Math.max(...ps), bottom: Math.min(...ps) };
  }

  function checkDrawingAlerts(symbol, price) {
    const b = App.drawings.data[symbol];
    if (!b || !b.items.length) { dPrev[symbol] = price; return; }
    const prev = dPrev[symbol];
    dPrev[symbol] = price;
    if (prev == null) return;
    for (const d of b.items) {
      const al = d.alert;
      if (!al || !al.active || d.hidden) continue;
      const band = bandOf(d);
      if (!band) continue;
      const { top, bottom } = band;
      const insideNow = price >= bottom && price <= top;
      const insideBefore = prev >= bottom && prev <= top;
      let fire = false;
      switch (al.cond) {
        case 'cross_up': fire = prev < bottom && price >= bottom; break;
        case 'cross_dn': fire = prev > top && price <= top; break;
        case 'inside': fire = !insideBefore && insideNow; break;
        case 'outside': fire = insideBefore && !insideNow; break;
      }
      if (!fire) continue;
      const name = (TOOLS && TOOLS[d.type] ? TOOLS[d.type].name : d.type);
      const fmt = (v) => U.fmtPrice(v, priceDigits(symbol));
      const zone = top === bottom ? fmt(top)
        : `${fmt(bottom)} – ${fmt(top)}`;
      const COND = { cross_up: 'Crossing Up', cross_dn: 'Crossing Down', inside: 'Inside', outside: 'Outside' };
      const msg = `${symbol} ${name} ${COND[al.cond] || al.cond} (${zone}) — now ${fmt(price)}`;
      UI.toast('Alert triggered: ' + msg, 'warn');
      try { window.electronAPI && window.electronAPI.notify('Drawing Alert', msg); } catch (e) {}
      playSound();
      if (al.once) { al.active = false; App.drawings.save(); }
      if (ObjectTree && ObjectTree.refresh) ObjectTree.refresh();
    }
  }

  (App.onTickHooks = App.onTickHooks || []).push(checkDrawingAlerts);

  /* the bell on the drawing's floating toolbar */
  Alerts.openDrawingDialog = function (pane, d) {
    const isBand = d.points.length >= 2 && (d.type === 'rect' || d.type === 'ellipse');
    const CONDS = isBand
      ? [['cross_up', 'Crossing Up'], ['cross_dn', 'Crossing Down'], ['inside', 'Inside the zone'], ['outside', 'Outside the zone']]
      : [['cross_up', 'Crossing Up'], ['cross_dn', 'Crossing Down']];
    const layer2 = document.getElementById('popup-layer');
    layer2.classList.remove('hidden');
    const back2 = U.el('div', 'dialog-backdrop ds-tpl-back', layer2);
    const dlg2 = U.el('div', 'dialog ds-tpl-dialog', back2);
    const toolName = (TOOLS && TOOLS[d.type] ? TOOLS[d.type].name : d.type);
    const band = bandOf(d);
    const fmt = (v) => U.fmtPrice(v, pane ? pane.digits : 2);
    const sub = isBand && band ? `${fmt(band.bottom)} – ${fmt(band.top)}` : band ? fmt(band.top) : '';
    dlg2.innerHTML = `<h3>${d.alert ? 'Edit' : 'Create'} Alert — ${toolName}</h3>
      <div class="dlg-row u-dlg-note">
        <span>${U.esc(d.symbol || (pane && pane.symbol) || '')} ${sub ? '· zone ' + sub : ''}</span>
      </div>
      <div class="dlg-row"><label>Condition<select id="da-cond">
        ${CONDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
      </select></label></div>
      <div class="dlg-row"><label class="u-row-inline">
        <input type="checkbox" id="da-once" checked class="u-checkbox-inline"> <span>Trigger only once</span>
      </label></div>
      <div class="dlg-actions">
        ${d.alert ? '<button class="dlg-btn dlg-ghost" id="da-remove">Remove alert</button>' : ''}
        <button class="dlg-btn dlg-ghost" id="da-cancel">Cancel</button>
        <button class="dlg-btn dlg-primary" id="da-create">${d.alert ? 'Save' : 'Create'}</button>
      </div>`;
    const sel = dlg2.querySelector('#da-cond');
    if (d.alert) sel.value = d.alert.cond;
    sel.addEventListener('keydown', (e) => e.stopPropagation());
    const close2 = () => { back2.remove(); layer2.classList.add('hidden'); };
    const rm = dlg2.querySelector('#da-remove');
    if (rm) rm.addEventListener('click', () => { delete d.alert; App.drawings.save(); UI.toast('Drawing alert removed'); close2(); });
    dlg2.querySelector('#da-cancel').addEventListener('click', close2);
    back2.addEventListener('mousedown', (ev) => { if (ev.target === back2) close2(); });
    dlg2.querySelector('#da-create').addEventListener('click', () => {
      d.alert = { cond: sel.value, once: dlg2.querySelector('#da-once').checked, active: true };
      App.drawings.save();
      UI.toast(`Alert on ${toolName}: ${sel.options[sel.selectedIndex].text}${d.alert.once ? ' (once)' : ' (every time)'}`, 'ok');
      if (ObjectTree && ObjectTree.refresh) ObjectTree.refresh();
      close2();
    });
  };

export { Alerts };
