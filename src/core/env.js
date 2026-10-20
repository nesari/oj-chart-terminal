/**
 * Platform environment seam (phase 3)
 *
 * THE ONE place in the platform-agnostic core that is allowed to touch
 * host globals (window / navigator / localStorage). Every other core
 * module consumes the ENV object below, so the whole layer stays runnable
 * in Node (tests), any browser (web shell, phase 4) and Electron/Capacitor
 * webviews alike. Every probe is try/caught — a missing host capability
 * degrades to a safe default instead of throwing at import time.
 *
 * Storage seam: core modules never call localStorage directly. In browsers
 * the implementation below persists JSON; in Node (no localStorage) both
 * calls degrade to no-ops with defaults returned.
 *
 * @module core/env
 */

const safe = (fn, d) => {
  try { const v = fn(); return v == null ? d : v; } catch (e) { return d; }
};

const ENV = {
  /** user agent string (Node: its own runner string, unknown hosts: 'unknown') */
  ua: safe(() => navigator.userAgent, 'unknown'),
  /** primary language tag */
  lang: safe(() => navigator.language, ''),
  /** device pixel ratio (headless/Node: 1) */
  dpr: safe(() => window.devicePixelRatio, 1),
  /** IANA zone of the host clock */
  tz: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC'),
  /** true when the Electron preload bridge is present */
  electron: safe(() => !!(window.electronAPI), false),

  /**
   * JSON storage seam — the ONLY sanctioned persistence path for core
   * modules. Browser hosts map this to localStorage; future platforms
   * (web shell, Capacitor) can swap the implementation via ENV.storage
   * re-assignment BEFORE any core module persists.
   */
  storage: {
    get: (key, def) => safe(() => {
      const v = localStorage.getItem(key);
      return v == null ? def : JSON.parse(v);
    }, def),
    set: (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} },
  },
};

export { ENV };
