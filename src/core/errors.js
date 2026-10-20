/**
 * AppError + error catalog (round 28)
 *
 * AppErr — the ONE error shape used across the app (ES module), ported from the
 * reference architecture (charts-pro core/errors) and adapted to this codebase.
 *
 * Every expected failure path should raise/log an AppError carrying:
 * code        — stable catalog id ('PROVIDER_TIMEOUT', 'FEED_CLOSED', …)
 * severity    — 'info' | 'warning' | 'error' | 'critical'
 * category    — 'provider' | 'feed' | 'data' | 'ui' | 'security' | 'system'
 * userMessage — short, user-facing text (safe to show in a toast)
 * hint        — actionable next step (also user-facing)
 * context     — sanitized debug context (Log.scrub handles redaction)
 *
 * EXTENSIBILITY: future layers register their own codes with
 * AppErr.register('MY_LAYER_CODE', { severity, category, userMessage, hint })
 * without touching this file — the catalog is open by design.
 *
 * @module core/errors
 */

import { Log } from './logger.js';

const CATALOG = {
    /* ---- provider (python MT5/demo process) ---- */
    PROVIDER_START:       { severity: 'error',    category: 'provider', userMessage: 'Data provider failed to start', hint: 'Check that Python 3.8+ is installed and in PATH (pip install websockets).' },
    PROVIDER_EXIT:        { severity: 'error',    category: 'provider', userMessage: 'Data provider exited unexpectedly', hint: 'Reconnect from the login screen; details are in Diagnostics.' },
    PROVIDER_TIMEOUT:     { severity: 'error',    category: 'provider', userMessage: 'Provider did not respond in time', hint: 'Restart the app; if it persists check the broker login.' },
    PROVIDER_AUTH:        { severity: 'error',    category: 'provider', userMessage: 'Broker login rejected', hint: 'Check login / password / server name, or open the MT5 terminal once to memorize this server.' },
    PROVIDER_MODULE:      { severity: 'error',    category: 'provider', userMessage: 'A Python package is missing', hint: 'Run in CMD: python -m pip install websockets MetaTrader5' },

    /* ---- feed (websocket to the local provider) ---- */
    FEED_CONNECT:         { severity: 'error',    category: 'feed',     userMessage: 'Could not reach the data feed', hint: 'The local provider is not running — reconnect from the login screen.' },
    FEED_CLOSED:          { severity: 'warning',  category: 'feed',     userMessage: 'Data feed connection lost', hint: 'Reconnecting automatically; charts resume when the feed is back.' },
    FEED_TIMEOUT:         { severity: 'warning',  category: 'feed',     userMessage: 'Data request timed out', hint: 'The provider may be busy — the request will be retried.' },
    FEED_PROTOCOL:        { severity: 'error',    category: 'feed',     userMessage: 'Invalid data received', hint: 'A response did not match the protocol; the bad payload was dropped.' },

    /* ---- data / chart ---- */
    BARS_EMPTY:           { severity: 'warning',  category: 'data',     userMessage: 'No history available for this symbol', hint: 'Try another timeframe or symbol.' },
    BARS_REJECT:          { severity: 'warning',  category: 'data',     userMessage: 'History rejected by the chart', hint: 'The payload was malformed; a reload may fix it.' },
    SYMBOL_UNKNOWN:       { severity: 'warning',  category: 'data',     userMessage: 'Symbol not found', hint: 'Check the symbol name in the search dialog.' },
    INDICATOR_PARAMS:     { severity: 'warning',  category: 'ui',       userMessage: 'Invalid indicator parameters', hint: 'Open the indicator settings and correct the values.' },
    INDICATOR_COMPUTE:    { severity: 'warning',  category: 'ui',       userMessage: 'Indicator computation failed', hint: 'The indicator was skipped; check its parameters.' },

    /* ---- ui / system ---- */
    STORAGE_WRITE:        { severity: 'warning',  category: 'system',   userMessage: 'Could not save settings', hint: 'Browser storage is full or blocked.' },
    SNAPSHOT_FAIL:        { severity: 'error',    category: 'ui',       userMessage: 'Snapshot could not be saved', hint: 'Try again or check disk permissions.' },
    EXPORT_FAIL:          { severity: 'error',    category: 'ui',       userMessage: 'Export failed', hint: 'Check the chosen location and permissions.' },
    IPC_BAD_PAYLOAD:      { severity: 'error',    category: 'security', userMessage: 'Internal message blocked', hint: 'A malformed internal message was rejected by the security layer.' },

    /* ---- fallback ---- */
    UNKNOWN:              { severity: 'error',    category: 'system',   userMessage: 'Unexpected error', hint: 'See the Diagnostics panel for details and export the log.' },
  };

  const SEV_RANK = { info: 0, warning: 1, error: 2, critical: 3 };

  class AppError extends Error {
    constructor(code, opts) {
      const spec = CATALOG[code] || CATALOG.UNKNOWN;
      opts = opts || {};
      super(opts.message || spec.userMessage);
      this.name = 'AppError';
      this.code = CATALOG[code] ? code : 'UNKNOWN';
      this.severity = opts.severity || spec.severity;
      this.category = spec.category;
      this.userMessage = opts.userMessage || spec.userMessage;
      this.hint = opts.hint !== undefined ? opts.hint : spec.hint;
      this.context = opts.context || null;
      this.cause = opts.cause;
      this.timestamp = Date.now();
      if (AppError._seq == null) AppError._seq = 0;
      this.id = 'e' + (++AppError._seq).toString(36);
    }
    /** one-line user presentation: message + hint */
    toUser() { return this.hint ? (this.userMessage + ' — ' + this.hint) : this.userMessage; }
    /** structured payload for the logger */
    toLog() {
      return {
        code: this.code, severity: this.severity, category: this.category, id: this.id,
        msg: this.message,
        ctx: this.context || undefined,
        stack: this.stack ? String(this.stack).slice(0, 2000) : undefined,
      };
    }
    /** log through the central logger (category is preserved) */
    log() { try { Log && Log.error(this.category, '[' + this.code + '] ' + this.message, this.toLog()); } catch (e) {} return this; }
  }

  /** normalize any thrown thing into an AppError (idempotent) */
  function wrap(err, fallbackCode, context) {
    if (err instanceof AppError) {
      if (context) err.context = Object.assign({}, err.context, context);
      return err;
    }
    const m = err && err.message ? err.message : String(err);
    return new AppError(fallbackCode || 'UNKNOWN', { message: m, cause: err, context });
  }

  const AppErr = {
    AppError,
    SEV_RANK,
    /** raise = create+log+return */
    raise: (code, opts) => { const e = new AppError(code, opts); e.log(); return e; },
    create: (code, opts) => new AppError(code, opts),
    wrap,
    /** register new codes from other layers (open catalog) */
    register: (code, spec) => {
      if (!code || CATALOG[code]) return false;
      CATALOG[code] = {
        severity: spec && spec.severity || 'error',
        category: spec && spec.category || 'system',
        userMessage: spec && spec.userMessage || code,
        hint: spec && spec.hint || '',
      };
      return true;
    },
    codes: () => Object.keys(CATALOG),
    spec: (code) => CATALOG[code] || null,
    /** true when the value is an AppError of severity >= error */
    isHard: (e) => e instanceof AppError && SEV_RANK[e.severity] >= 2,
  };

export { AppErr };
