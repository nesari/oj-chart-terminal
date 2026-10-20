/**
 * renderer util facade — DOM + storage helpers over the platform core
 *
 * Phase 3 split: the PURE helpers (math/time/geometry) moved to the
 * platform-agnostic core (src/core/util.js) and are re-exported here so
 * every existing `U.x` call site in the renderer keeps working unchanged.
 * Presentation-only helpers stayed behind: DOM queries/creation, CSS color
 * conversion and the BUG-005/010 viewport fitter. Persistence routes
 * through the core ENV.storage seam (one implementation everywhere).
 *
 * Renderer-only rule: like its core counterpart, this module must never
 * import a sibling module — it is the leaf of the renderer-side graph.
 *
 * @module core/util
 */

import { ENV } from '../../../core/env.js';
import {
  clamp, fmtPrice, debounce, pointSize,
  timeToLogical, logicalToTime, nearestIndex,
  distSeg, clipLine, dashFor, deepCopy, durHuman,
  firstBadRow,
} from '../../../core/util.js';

const U = {
  /* ---- pure helpers (re-exported from the platform core) ---- */
  clamp, fmtPrice, debounce, pointSize,
  timeToLogical, logicalToTime, nearestIndex,
  distSeg, clipLine, dashFor, deepCopy, durHuman,
  firstBadRow,

  /* ---- DOM helpers (renderer-only) ---- */
  $: (sel, root) => (root || document).querySelector(sel),
  $$: (sel, root) => Array.from((root || document).querySelectorAll(sel)),
  el: function (tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  },
  html: function (node, h) { node.innerHTML = h; return node; },

  /* ---- round 82: in-app prompt dialog ------------------------------
   * Electron's renderer does NOT implement window.prompt() — Chromium
   * silently returns null and logs "prompt() is not supported." (seen in
   * diagnostics: pine-editor.js "New script" / "Rename script" buttons).
   * window.confirm()/alert() ARE implemented by Electron so those are fine
   * as-is; only prompt() needs a replacement. This reuses the same
   * #popup-layer / .dialog-backdrop / .dialog markup+CSS every other
   * dialog in the app already uses, so it matches the existing look.
   * Returns a Promise<string|null> — null means Cancel/Escape, matching
   * window.prompt()'s own contract so call sites barely change. */
  promptDialog: function (message, defaultValue) {
    return new Promise((resolve) => {
      const layer = document.getElementById('popup-layer');
      if (!layer) { resolve(null); return; } // defensive: layer always exists in practice
      U.clear(layer);
      const back = U.el('div', 'dialog-backdrop', layer);
      const dlg = U.el('div', 'dialog u-prompt-dlg', back);
      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        layer.classList.add('hidden');
        U.clear(layer);
        document.removeEventListener('keydown', onKey);
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
        else if (e.key === 'Enter') { e.stopPropagation(); finish(input.value); }
      };
      dlg.innerHTML = `<h3>${U.esc(message)}<button class="mini-btn dlg-x" title="Close">✕</button></h3>
        <input type="text" class="u-prompt-input">
        <div class="dlg-actions">
          <button class="dlg-btn dlg-ghost u-prompt-cancel">Cancel</button>
          <button class="dlg-btn dlg-primary u-prompt-ok">Ok</button>
        </div>`;
      const input = dlg.querySelector('.u-prompt-input');
      input.value = defaultValue == null ? '' : String(defaultValue);
      dlg.querySelector('.dlg-x').addEventListener('click', () => finish(null));
      dlg.querySelector('.u-prompt-cancel').addEventListener('click', () => finish(null));
      dlg.querySelector('.u-prompt-ok').addEventListener('click', () => finish(input.value));
      back.addEventListener('mousedown', (e) => { if (e.target === back) finish(null); });
      document.addEventListener('keydown', onKey);
      layer.classList.remove('hidden');
      input.focus();
      input.select();
    });
  },

  /* HTML-escape untrusted strings before interpolating them into an
     innerHTML template. Any text that ultimately comes from a feed/
     provider payload (news event names, symbol search results, etc.)
     rather than a hardcoded literal in the source MUST be passed through
     this before it is concatenated into an innerHTML string — otherwise
     a provider that returns e.g. `<img src=x onerror=...>` as an event
     name or symbol gets executed as markup inside the app. */
  /* ROUND103: is the event's target a text-entry surface?
     Global chart shortcuts (Delete / Ctrl+Z / Ctrl+Y / Ctrl+S) must never
     fire while the user is typing — see app.js. `contentEditable` is
     included because the Pine editor's gutter and some rich rows use it. */
  isTyping: function (target) {
    if (!target || !target.tagName) return false;
    const tag = String(target.tagName).toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return target.isContentEditable === true;
  },

  esc: function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  },
  /* ROUND 75 (BUG-74-D): pine-ui referenced this helper by the wrong name
     (`U.escape`) and the Pine settings dialog crashed at runtime — the
     call sites are fixed, but the alias stays as a safety net so a stale
     or mistyped name can never crash the UI again (same escaper). */
  escape: function (s) { return U.esc(s); },
  clear: function (node) { while (node.firstChild) node.removeChild(node.firstChild); return node; },

  /* any CSS color -> #rrggbb (for <input type=color>) */
  toHex: function (c) {
    if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) return c;
    if (typeof c === 'string' && /^#[0-9a-f]{3}$/i.test(c)) {
      return '#' + c.slice(1).split('').map((x) => x + x).join('');
    }
    try {
      const d = document.createElement('div');
      d.style.color = c;
      document.body.appendChild(d);
      const m = getComputedStyle(d).color.match(/(\d+),\s*(\d+),\s*(\d+)/);
      d.remove();
      if (m) return '#' + [1, 2, 3].map((i) => (+m[i]).toString(16).padStart(2, '0')).join('');
    } catch (e) {}
    return '#000000';
  },

  /* rAF-coalescing throttle — unlike U.debounce (trailing-edge, waits for
     quiet), this runs `fn` at most once per animation frame while events
     keep firing, so layout stays live/responsive DURING a continuous
     window resize drag instead of freezing until the drag stops, while
     still collapsing a resize storm (many `resize` events per frame) down
     to one recalculation per frame. Intended for resize/scroll layout
     handlers, not for input debouncing (use U.debounce for that). */
  rafThrottle: function (fn) {
    let scheduled = false;
    return function (...args) {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; fn.apply(this, args); });
    };
  },

  /* JSON persistence — routes through the core ENV.storage seam so the
     browser implementation lives in exactly ONE place (core/env). */
  lsGet: function (key, def) { return ENV.storage.get(key, def); },
  lsSet: function (key, val) { ENV.storage.set(key, val); },

  /* BUG-005 / BUG-010 — the ONE viewport-fitting rule for every flyout/popup:
     prefer opening BELOW the anchor (top = anchorTop); when the menu is taller
     than the room below AND more room sits above, flip it up (bottom-aligned
     to anchorBottom); either way cap max-height to the available space so the
     menu NEVER passes the window edges — scrolling lives INSIDE the menu
     (elements carry overflow-y:auto), the page/chart underneath never scrolls.
     Recomputed on EVERY open — no stale caches. Returns the placement used. */
  fitPopup: function (el, anchorTop, anchorBottom, opts) {
    opts = opts || {};
    const margin = opts.margin != null ? opts.margin : 12;
    const topSafe = opts.topSafe != null ? opts.topSafe : 44; // top-bar height
    const vh = window.innerHeight;
    el.style.maxHeight = '';
    const h = el.offsetHeight;
    if (!(h > 0)) { el.style.top = Math.round(anchorTop) + 'px'; return 'below'; }
    const below = vh - margin - anchorTop;
    const above = anchorBottom - topSafe - margin;
    if (h <= below) {
      el.style.top = Math.round(anchorTop) + 'px';
      return 'below';
    }
    if (above > below && above > 140) {
      el.style.maxHeight = Math.round(above) + 'px';
      const h2 = Math.min(h, above);
      el.style.top = Math.round(Math.max(topSafe + margin, anchorBottom - h2)) + 'px';
      return 'above';
    }
    el.style.maxHeight = Math.round(Math.max(140, below)) + 'px';
    el.style.top = Math.round(anchorTop) + 'px';
    return 'below';
  },

  /* Central digit-count helper note: priceDigits() lives in core/feed.js
     (it reads the live feed's digits map); U.priceDigits no longer exists
     since phase 2. */
};

export { U };
