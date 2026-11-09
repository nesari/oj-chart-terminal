/**
 * structured logging & monitoring (round 28 / phase 3)
 *
 * Log — the ONE logger used across the app (ES module; test/debug access via the __app facade).
 *
 * Design goals (feature round 28, "three systems"; phase 3 made it portable):
 * 1. Easy bug fixing: every meaningful event lands in a structured entry
 * {t, seq, lvl, cat, msg, ctx} with a session id, so a user can hit
 * Export and hand over a complete, redacted story of what happened.
 * 2. Zero behavior change: logging never throws, never blocks the chart,
 * and degrades silently when no transport is attached (headless tests).
 * 3. Security: contexts are scrubbed (password/token/... keys redacted,
 * depth + size capped) BEFORE anything leaves the process.
 * 4. Platform-agnostic core (phase 3): this module references NO host
 * globals — the only platform seam is ENV (core/env). The Electron host
 * adapter (src/platform/electron/loghost.js) attaches the batched IPC
 * transport (file logs via the main process), the crash net (window
 * 'error' + 'unhandledrejection') and the beforeunload flush at boot.
 *
 * Sinks:
 * - in-memory ring buffer (panel + export),
 * - injected transport (Electron: batched JSONL via IPC; batch window
 *   FLUSH_MS, early flush at FLUSH_MAX, hard cap BATCH_CAP),
 * - live subscription for the Diagnostics panel.
 *
 * Levels: debug < info < warn < error.  Categories are free-form strings;
 * the well-known ones: app provider feed chart indicators drawing panel
 * ipc security error alerts selftest.
 *
 * @module core/logger
 */

import { ENV } from './env.js';

const APP_VERSION = '1.9.216';
const RING_MAX = 3000;          // entries kept in memory
const FLUSH_MS = 1500;          // transport batch window
const FLUSH_MAX = 60;           // flush early when the queue is this long
const BATCH_CAP = 400;          // hard cap per transport batch
const SENSITIVE = /^(password|pass|pwd|token|secret|authorization|auth|cookie|set-cookie|pw)$/i;
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

let seq = 0;
let dropped = 0;                // entries that never reached a sink
let paused = false;
let transport = null;           // injected by the host adapter (loghost.js)
const sessionId = 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
const bootAt = Date.now();
const ring = [];
const subs = [];
const counts = { debug: 0, info: 0, warn: 0, error: 0 };
const catCounts = {};
let ipcQueue = [];
let flushTimer = null;

/* ---------- context scrubbing (defense in depth) ---------- */
function scrub(v, depth) {
  try {
    if (v == null) return v;
    const t = typeof v;
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'string') return v.length > 500 ? v.slice(0, 500) + '…(' + v.length + ')' : v;
    if (t === 'function') return '[fn]';
    if (t === 'symbol' || t === 'bigint') return String(v).slice(0, 64);
    if (v instanceof Error) return { name: v.name, message: String(v.message || '').slice(0, 500), stack: String(v.stack || '').slice(0, 2000) };
    if (depth > 3) return '[depth]';
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrub(x, depth + 1));
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) {
      if (++n > 40) { out['…'] = '[truncated]'; break; }
      out[k] = SENSITIVE.test(k) ? '•••redacted•••' : scrub(v[k], depth + 1);
    }
    return out;
  } catch (e) { return '[scrub-err]'; }
}

function pushIpc(entry) {
  if (paused) return;
  if (!transport) { dropped++; return; }
  ipcQueue.push(entry);
  if (ipcQueue.length >= FLUSH_MAX) flushNow();
  else if (!flushTimer) flushTimer = setTimeout(flushNow, FLUSH_MS);
}

function flushNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!ipcQueue.length || !transport) { ipcQueue = []; return; }
  const batch = ipcQueue.slice(0, BATCH_CAP);
  if (ipcQueue.length > BATCH_CAP) dropped += ipcQueue.length - BATCH_CAP;
  ipcQueue = [];
  try { transport(batch); }
  catch (e) { dropped += batch.length; }
}

/* ---------- core entry path ---------- */
function add(lvl, cat, msg, ctx) {
  try {
    const e = {
      seq: ++seq,
      t: Date.now(),
      lvl: LEVELS[lvl] != null ? lvl : 'info',
      cat: String(cat || 'app').slice(0, 24),
      msg: String(msg == null ? '' : msg).slice(0, 2000),
    };
    if (ctx !== undefined && ctx !== null) e.ctx = scrub(ctx, 0);
    counts[e.lvl] = (counts[e.lvl] || 0) + 1;
    catCounts[e.cat] = (catCounts[e.cat] || 0) + 1;
    ring.push(e);
    if (ring.length > RING_MAX) { ring.shift(); dropped++; }
    for (const f of subs) { try { f(e); } catch (er) {} }
    pushIpc(e);
    if (e.lvl === 'error') flushNow(); // never sit on errors
    return e;
  } catch (er) { return null; }
}

/* ---------- public API ---------- */
const Log = {
  APP_VERSION,
  sessionId,
  bootAt,
  LEVELS,
  debug: (cat, msg, ctx) => add('debug', cat, msg, ctx),
  info: (cat, msg, ctx) => add('info', cat, msg, ctx),
  warn: (cat, msg, ctx) => add('warn', cat, msg, ctx),
  error: (cat, msg, ctx) => add('error', cat, msg, ctx),
  /** log a thrown thing with wrap-around (uses AppErr when present) */
  fromError: (err, cat, ctx) => {
    let m = '', st;
    try {
      if (err && err.stack) st = String(err.stack).slice(0, 2000);
      m = (err && err.message) || String(err);
    } catch (e) { m = String(err); }
    return add('error', cat || 'error', m, Object.assign({}, ctx, { stack: st }));
  },
  onEntry: (cb) => { subs.push(cb); return () => { const i = subs.indexOf(cb); if (i >= 0) subs.splice(i, 1); }; },
  setPaused: (v) => { paused = !!v; if (paused) flushNow(); },
  isPaused: () => paused,
  /** attach the outbound sink (host adapter calls this once at boot);
      passing a non-function detaches. Queued entries flush immediately. */
  setTransport: (fn) => { transport = typeof fn === 'function' ? fn : null; if (transport) flushNow(); },
  entries: (f) => {
    f = f || {};
    const q = f.search != null ? String(f.search).toLowerCase() : null;
    return ring.filter((e) =>
      (f.lvl == null || LEVELS[e.lvl] >= LEVELS[f.lvl]) &&
      (f.cat == null || e.cat === f.cat) &&
      (q == null || (e.msg.toLowerCase().includes(q) || (e.ctx && JSON.stringify(e.ctx).toLowerCase().includes(q))))
    ).slice();
  },
  all: () => ring.slice(),
  stats: () => ({ sessionId, bootAt, version: APP_VERSION, total: seq, inRing: ring.length, dropped, counts, cats: Object.assign({}, catCounts), uptimeMs: Date.now() - bootAt, paused, ipc: !!transport }),
  clear: () => { ring.length = 0; },
  flushNow,
  /** plain-text dump for the Export button (stable, human-readable) */
  exportText: () => {
    const s = Log.stats();
    const L = ['OJchart — diagnostics log', 'version   : ' + s.version, 'session   : ' + s.sessionId, 'boot (ms) : ' + new Date(s.bootAt).toISOString(), 'exported  : ' + new Date().toISOString(), 'uptime    : ' + Math.round(s.uptimeMs / 1000) + 's', 'entries   : ' + ring.length + ' (in ring), ' + s.total + ' (total), ' + s.dropped + ' dropped', 'levels    : ' + JSON.stringify(s.counts), '', 'seq | time | level | category | message | context', '-'.repeat(100)];
    for (const e of ring) {
      let ctx = '';
      if (e.ctx !== undefined) { try { ctx = JSON.stringify(e.ctx); } catch (er) { ctx = '[unserializable]'; } }
      L.push(e.seq + ' | ' + new Date(e.t).toISOString() + ' | ' + e.lvl.toUpperCase().padEnd(5) + ' | ' + e.cat.padEnd(10) + ' | ' + e.msg + (ctx ? ' | ' + ctx : ''));
    }
    return L.join('\n');
  },
  exportJson: () => JSON.stringify({ meta: Log.stats(), entries: ring }, null, 2),
};

export { Log, scrub, flushNow };

/* boot marker — everything after this point is attributable (all host
   probes go through ENV, so this is safe in Node / web / Electron) */
add('info', 'app', 'boot v' + APP_VERSION, {
  session: sessionId,
  ua: ENV.ua,
  dpr: ENV.dpr,
  lang: ENV.lang,
  tz: ENV.tz,
  electron: ENV.electron,
});
