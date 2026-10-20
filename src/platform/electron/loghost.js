/**
 * Electron renderer host adapter (phase 3)
 *
 * Re-attaches to the core logger everything that was platform-specific and
 * used to live inside it (round 28): the batched IPC transport (file logs
 * via the main process), the global crash net (window 'error' +
 * 'unhandledrejection'), the rate-limited toast for UNEXPECTED errors and
 * the beforeunload flush.
 *
 * This is the ONLY renderer-side piece that knows about electronAPI and
 * the crash DOM toast — the core (src/core/*) stays portable, and the
 * phase-4 web shell will provide its own host adapter with the same
 * installElectronHost() contract (minus the IPC part).
 *
 * Self-installs on first import (idempotent). app.js imports this module
 * FIRST so the crash net is active before any other module evaluates —
 * same timing as the round-28 logger had.
 *
 * @module platform/electron/loghost
 */

import { Log } from '../../core/logger.js';

let installed = false;

/**
 * Wire the Electron renderer host onto the core logger.
 * Safe to call multiple times (guarded) and from any environment that has
 * a window (headless browser tests included — transport simply stays
 * detached when electronAPI is absent).
 */
export function installElectronHost() {
  if (installed) return;
  installed = true;

  /* ---- outbound transport: batched JSONL -> main process ---- */
  try {
    if (window.electronAPI && typeof window.electronAPI.logBatch === 'function') {
      Log.setTransport((batch) => window.electronAPI.logBatch(batch));
    }
  } catch (e) { /* no bridge (browser tests) — ring-only logging */ }

  /* ---- global crash net (captured, never thrown from) ---- */
  const fmtEv = (ev) => {
    if (!ev) return {};
    const err = ev.error || ev.reason;
    return {
      msg: (err && (err.message || String(err))) || ev.message || String(ev),
      src: ev.filename ? (ev.filename.split(/[\\/]/).pop() + ':' + ev.lineno) : undefined,
      stack: err && err.stack ? String(err.stack).slice(0, 2000) : undefined,
    };
  };

  let lastCrashToast = 0;
  const crashToast = (text) => {
    // rate-limited, dependency-free user notice for UNEXPECTED errors
    const now = Date.now();
    if (now - lastCrashToast < 5000) return;
    lastCrashToast = now;
    try {
      const box = document.getElementById('toasts');
      if (!box) return;
      const t = document.createElement('div');
      t.className = 'toast err';
      const body = document.createElement('div');
      body.className = 't-body';
      body.appendChild(document.createTextNode('⚠ ' + String(text).slice(0, 160)));
      body.appendChild(document.createElement('br'));
      const more = document.createElement('span');
      more.style.opacity = '.7';
      more.style.fontSize = '11px';
      more.textContent = 'Details: Diagnostics panel';
      body.appendChild(more);
      t.appendChild(body);
      box.appendChild(t);
      setTimeout(() => { try { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; } catch (e) {} }, 5200);
      setTimeout(() => { try { t.remove(); } catch (e) {} }, 5600);
    } catch (e) {}
  };

  window.addEventListener('error', (ev) => {
    /* round 82 (BUG): 'error' is registered with useCapture=true so it also
       intercepts RESOURCE load failures (img/script/link/audio — anything
       with a src/href that 404s), which fire as a plain Event with no
       .message/.error and bubble the target element, not window. Before
       this fix those fell through fmtEv()'s fallback to String(ev) and
       were logged/toasted as an opaque "[object Event]" JS crash — seen in
       the field as diagnostics entry #3 right at boot, most likely the
       browser's automatic favicon.ico probe (no <link rel="icon"> is
       declared) since it fires before login and nothing else loads that
       early. Resource errors are real but not script crashes: log them at
       'warn' with the failing element/URL and skip the crash toast. */
    if (ev.target && ev.target !== window && ev.target.nodeType === 1) {
      const el = ev.target;
      Log.warn('resource', 'failed to load ' + el.tagName.toLowerCase(), {
        src: el.src || el.href || undefined,
      });
      return;
    }
    const d = fmtEv(ev);
    Log.error('error', d.msg || 'Uncaught error', d);
    crashToast(d.msg || 'Unexpected error');
  }, true);

  window.addEventListener('unhandledrejection', (ev) => {
    const d = fmtEv(ev);
    Log.error('error', 'Unhandled rejection: ' + (d.msg || '?'), d);
    crashToast('Unhandled rejection: ' + (d.msg || '?'));
  });

  window.addEventListener('beforeunload', () => { try { Log.flushNow(); } catch (e) {} });
}

installElectronHost();
