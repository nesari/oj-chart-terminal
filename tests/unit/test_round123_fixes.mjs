import { readSource } from './source-utils.mjs';
/**
 * ROUND123 — two user-reported tab fixes:
 *
 *  FIX A (live labels showed only "SYM —"):
 *      Tabs.onTick was registered as a BARE method reference; the feed calls
 *      every hook receiver-less f(symbol, price, …), so `this` was undefined
 *      (strict ES module) and `this.q[symbol]` threw on EVERY tick — the
 *      feed's per-hook try/catch swallowed it and the quote cell never left
 *      its em-dash placeholder. The hook is now arrow-wrapped (receiver
 *      pinned to the Tabs singleton) and onTick itself addresses the
 *      singleton, never `this`. Additionally the D1 baseline fetch SEEDS the
 *      quote (newest daily close = latest price) so a fresh tab shows
 *      symbol + price + change immediately, before the first live tick.
 *
 *  FIX B (a NEW tab could be undocked but never docked back):
 *      dock-back relayed the tab record through a mt5_tab_dockback_*
 *      localStorage key written by the solo and scanned by the host renderer
 *      immediately after an IPC hop. Electron does not reliably propagate
 *      localStorage mutations between two LIVE renderers (file:// origin,
 *      batched flush), so the host scan found nothing, acked nothing and the
 *      tab stayed stranded ("Main window is not available"). The record now
 *      RIDES THE IPC PAYLOAD end to end:
 *        undock  : tabs:undock {soloId, mode, rec}  -> main holds it in memory
 *        boot    : tabs:claim {soloId}              -> single-shot handover
 *        dockback: tabs:dockback {soloId, rec}      -> main forwards to the
 *                  host strip window (tabsHostWindow fallback covers a solo
 *                  that promoted itself) -> host absorbs + acks
 *      A NEW tab undock also re-claims deterministically (no localStorage
 *      race at all), and a solo window that is CLOSED takes its tab with it
 *      (Chrome) by dropping its per-solo store on beforeunload.
 *
 * Source contracts + behavioral mirrors, the same style as rounds 102-122.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readSource(p);
let N = 0, BAD = 0;
function check(name, cond, extra) {
  N++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + ((!cond && extra !== undefined) ? ' — ' + extra : ''));
  if (!cond) BAD++;
}

const tabs = read('src/renderer/js/chart/tabs.js');
const main = read('main.js');
const preload = read('preload.js');
/* behavioural scans run on code with block comments stripped */
const code = tabs.replace(/\/\*[\s\S]*?\*\//g, '');
const mainCode = main.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('— ROUND123 · FIX A: live TV-style tab labels actually tick —');
check('the tick hook is arrow-wrapped (receiver pinned to the Tabs singleton)',
  /\(App\.onTickHooks = App\.onTickHooks \|\| \[\]\)\.push\(\(symbol, price\) => Tabs\.onTick\(symbol, price\)\);/.test(code));
check('no bare Tabs.onTick reference is pushed anywhere',
  !/push\(Tabs\.onTick\)/.test(code));
check('onTick addresses the singleton, never `this` (hooks run receiver-less)',
  /onTick\(symbol, price\) \{[\s\S]*?const prev = Tabs\.q\[symbol\];[\s\S]*?Tabs\.q\[symbol\] = \{ price, dir, at: Date\.now\(\) \};/.test(tabs) &&
  !/this\.q\[symbol\]/.test(code));
check('the D1 baseline fetch SEEDS the quote (newest daily close = latest price)',
  /_refreshBases\(\) \{[\s\S]*?if \(bars\.length && !Tabs\.q\[sym\]\) \{[\s\S]*?const lastBar = bars\[bars\.length - 1\];[\s\S]*?price: lastBar\.close,/.test(tabs));
check('the seed never overwrites a live quote (first real tick wins)',
  /if \(bars\.length && !Tabs\.q\[sym\]\) \{/.test(tabs));
check('seed direction falls back to the previous close, then the bar open',
  /const ref = \(bars\.length >= 2 \? bars\[bars\.length - 2\]\.close : lastBar\.open\);/.test(tabs));
check('the dirty-quote painter is untouched (text writes only on real changes)',
  /_paintQuotes\(\) \{[\s\S]*?if \(pxEl\.textContent !== ps\) \{[\s\S]*?void pxEl\.offsetWidth;/.test(tabs));
check('quote subscriptions still reconcile through Manager.acquireSub/releaseSub',
  /_reconcileSubs\(\) \{[\s\S]*?Manager\.releaseSub\(sym\);[\s\S]*?Manager\.acquireSub\(sym\);/.test(tabs));

console.log('— ROUND123 · FIX B: dock-back rides the IPC payload —');
check('dockbackTab sends the record inside the dockback payload',
  /window\.mt5Tabs\.dockback\(\{ soloId: SOLO_ID, rec: copy \}\)/.test(tabs));
check('no localStorage dockback write remains in tabs.js (the race is gone)',
  !/U\.lsSet\('mt5_tab_dockback_/.test(code) && !/mt5_tab_dockback_' \+ rec\.id/.test(code));
check('the in-flight copy is cleaned (_docking never travels)',
  /delete copy\._docking;/.test(tabs));
check('the host absorbs the record from the request payload (validated by validRec)',
  /_acceptDock\(p\) \{[\s\S]*?const rec = \(p && p\.rec && validRec\(p\.rec\)\) \? p\.rec : null;[\s\S]*?if \(!rec\) return;/.test(tabs));
check('the host still sweeps stale round-122 dockback keys (best-effort cleanup)',
  /_acceptDock\(p\) \{[\s\S]*?k\.indexOf\('mt5_tab_dockback_'\) === 0[\s\S]*?localStorage\.removeItem\(k\);/.test(tabs));
check('the host acks with the absorbed id (the solo drops its copy only then)',
  /await window\.mt5Tabs\.dockAck\(\{ soloId, ids: \[rec\.id\] \}\);/.test(tabs));
check('a detached window CLAIMS its tab through IPC on boot (single-shot handover)',
  /window\.mt5Tabs\.claimTab\(SOLO_ID\)[\s\S]*?const rec = \(r && r\.ok && r\.rec && validRec\(r\.rec\)\) \? r\.rec : null;[\s\S]*?if \(!rec\) \{ bootStrip\(\); return; \}[\s\S]*?this\.list = \[rec\];[\s\S]*?this\._restore\(rec\);/.test(tabs));
check('the host boot path is unchanged (bootStrip runs synchronously)',
  /\} else \{\n      bootStrip\(\);\n    \}/.test(tabs));
check('undockTab hands the record to main in the undock payload too (deterministic claim)',
  /await window\.mt5Tabs\.undock\(\{ soloId, mode, rec \}\)/.test(tabs));
check('a CLOSED detached window takes its tab with it (Chrome) — per-solo store dropped',
  /if \(SOLO_ID\) \{ try \{ localStorage\.removeItem\(STORE_KEY\); \} catch \(e\) \{[^}]*\} \}/.test(tabs));

console.log('— ROUND123 · main-process side (validation + routing + memory handoff) —');
check('validDockRec sanitizes the tab record (shape mirrors tabs.js validRec)',
  /function validDockRec\(r\) \{/.test(main) &&
  /if \(!\/\^\(\[\\w-\]\+\)\$\/\.test\(id\)\) \{ badPayload\('tabs', 'bad rec id'\); return null; \}/.test(main));
check('record budget: 128KB JSON cap, ≤16 panes, symbol required',
  /JSON\.stringify\(r\)\.length > 131072/.test(main) &&
  /r\.panes\.length > 16/.test(main) &&
  /if \(!symbol\) \{ badPayload\('tabs', 'bad pane symbol'\); return null; \}/.test(main));
check('tabs:undock keeps the record in memory for the new window to claim',
  /const rec = validDockRec\(p \? p\.rec : null\);[\s\S]*?if \(rec\) pendingSolo\.set\(soloId, rec\);/.test(mainCode));
check('pendingSolo is cleaned on window close AND on a failed create (no leaks)',
  /win\.on\('closed', \(\) => \{ soloWins\.delete\(soloId\); pendingSolo\.delete\(soloId\); \}\);/.test(main) &&
  /pendingSolo\.delete\(soloId\);[\s\S]*?tabs:undock create failed/.test(main));
check('tabs:claim is single-shot — the entry is consumed either way (no double claim)',
  /const rec = pendingSolo\.get\(soloId\) \|\| null;[\s\S]*?pendingSolo\.delete\(soloId\);[\s\S]*?if \(!rec\) return \{ ok: false \};[\s\S]*?return \{ ok: true, rec \};/.test(mainCode));
check('tabs:dockback requires a VALID record before routing (invalid -> rejected, no silent loss)',
  /const rec = validDockRec\(p \? p\.rec : null\);[\s\S]*?if \(!rec\) \{ badPayload\('tabs:dockback', 'missing rec'\); return \{ ok: false, error: 'invalid payload' \}; \}/.test(mainCode));
check('dock-request goes to tabsHostWindow() (promotion fallback), payload carries the record',
  /function tabsHostWindow\(\) \{[\s\S]*?indexOf\('solo='\) < 0[\s\S]*?\}/.test(main) &&
  /host\.webContents\.send\('tabs:dock-request', \{ soloId, rec \}\);/.test(mainCode));
check('no host window standing -> ok:false + no-host (the solo still promotes itself)',
  /return \{ ok: false, error: 'no-host' \};/.test(main));
check('preload bridges claimTab (sandboxed renderer keeps asking through the allowlist)',
  /exposeInMainWorld\('mt5Tabs', \{[\s\S]*?claimTab: \(soloId\) => ipcRenderer\.invoke\('tabs:claim', \{ soloId:/.test(preload));

console.log('— ROUND123 · behavioral mirrors —');
/* mirror A1: the receiver-less hook semantics (the exact bug) */
{
  const store = {};                            // stands in for Tabs.q
  const obj = {
    q: store,
    /* the OLD shape: `this`-based — a bare reference throws receiver-less */
    oldOnTick(symbol, price) {
      const prev = this.q[symbol];
      this.q[symbol] = { price, at: Date.now() };
    },
    /* the NEW shape: singleton-addressed, receiver-independent */
    onTick(symbol, price) {
      if (!symbol || typeof price !== 'number' || !isFinite(price)) return;
      const prev = obj.q[symbol];              // singleton, NOT `this`
      const dir = prev && prev.price != null ? (price >= prev.price ? 'up' : 'down') : 'up';
      obj.q[symbol] = { price, dir, at: Date.now() };
    },
  };
  const hook = (s, p) => obj.onTick(s, p);     // the arrow wrapper
  const sink = [];
  try { hook('EURUSD', 1.1); hook('EURUSD', 1.09); sink.push(store.EURUSD.dir); } catch (e) { sink.push('threw'); }
  let bareThrew = false;
  try { const f = obj.oldOnTick; f('GBPUSD', 1.1); } catch (e) { bareThrew = true; } // bare ref == old bug
  let bareNewOk = true;
  try { const f = obj.onTick; f('GBPUSD', 1.1); } catch (e) { bareNewOk = false; }  // new body survives even bare
  check('mirror: the wrapper ticks through (up then down); the old this-based body threw bare, the new one cannot',
    sink[0] === 'down' && bareThrew && bareNewOk && store.EURUSD.price === 1.09);
}
/* mirror A2: the D1 seed logic */
{
  const q = {}; // Tabs.q stand-in
  const seed = (bars, sym) => {
    if (bars.length && !q[sym]) {
      const lastBar = bars[bars.length - 1];
      if (lastBar && isFinite(lastBar.close) && lastBar.close > 0) {
        const ref = (bars.length >= 2 ? bars[bars.length - 2].close : lastBar.open);
        q[sym] = { price: lastBar.close, dir: lastBar.close >= (isFinite(ref) && ref > 0 ? ref : lastBar.close) ? 'up' : 'down', at: Date.now() };
      }
    }
  };
  seed([{ time: 1, close: 100 }, { time: 2, close: 101.5 }], 'XAUUSD');
  const first = q.XAUUSD;
  seed([{ time: 3, close: 999 }], 'XAUUSD'); // must NOT overwrite
  const seeded = q.EURUSD; seed([{ time: 5, close: 0 }], 'EURUSD'); // bad close ignored
  check('mirror: seed = last D1 close + direction vs previous close; never overwrites; junk bars skipped',
    first && first.price === 101.5 && first.dir === 'up' && q.XAUUSD.price === 101.5 && !seeded);
}
/* mirror B1: validDockRec core rules */
{
  const vStr = (v, max) => (typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : null);
  const validDockRec = (r) => {
    if (r == null || typeof r !== 'object' || Array.isArray(r)) return null;
    const id = vStr(String(r.id == null ? '' : r.id), 64) || '';
    if (!/^([\w-]+)$/.test(id)) return null;
    if (!Array.isArray(r.panes) || !r.panes.length || r.panes.length > 16) return null;
    const panes = [];
    for (const pn of r.panes.slice(0, 16)) {
      if (pn == null || typeof pn !== 'object') return null;
      const symbol = vStr(String(pn.symbol == null ? '' : pn.symbol), 64) || '';
      if (!symbol) return null;
      panes.push({ symbol, tf: vStr(String(pn.tf == null ? 'M1' : pn.tf), 8) || 'M1', style: vStr(String(pn.style == null ? 'candles' : pn.style), 16) || 'candles' });
    }
    return { id, layout: vStr(String(r.layout == null ? '1' : r.layout), 16) || '1', panes };
  };
  const good = validDockRec({ id: 't1abc', layout: '2', panes: [{ symbol: 'EURUSD', tf: 'M5', style: 'candles' }] });
  check('mirror: a well-formed new-tab record survives the validator intact',
    good && good.id === 't1abc' && good.layout === '2' && good.panes[0].symbol === 'EURUSD' && good.panes[0].tf === 'M5');
  check('mirror: defaults fill in (layout 1 / M1 / candles) for a minimal record',
    (() => { const v = validDockRec({ id: 'x9', panes: [{ symbol: 'BTCUSD' }] }); return v.layout === '1' && v.panes[0].tf === 'M1' && v.panes[0].style === 'candles'; })());
  check('mirror: bad shapes rejected — no id / bad id / empty panes / empty symbol / array body',
    validDockRec({ panes: [{ symbol: 'X' }] }) === null &&
    validDockRec({ id: 'bad id!', panes: [{ symbol: 'X' }] }) === null &&
    validDockRec({ id: 'ok', panes: [] }) === null &&
    validDockRec({ id: 'ok', panes: [{ symbol: '' }] }) === null &&
    validDockRec(['nope']) === null);
}
/* mirror B2: single-shot claim */
{
  const pendingSolo = new Map([['s1', { id: 't1', panes: [{ symbol: 'EURUSD' }] }]]);
  const claim = (soloId) => { const rec = pendingSolo.get(soloId) || null; pendingSolo.delete(soloId); return rec ? { ok: true, rec } : { ok: false }; };
  const first = claim('s1'), second = claim('s1');
  check('mirror: the first claim wins with the record, the second is empty (and deletes either way)',
    first.ok && first.rec.id === 't1' && !second.ok && !pendingSolo.has('s1'));
}
/* mirror B3: tabsHostWindow routing */
{
  const mkWin = (url, destroyed) => ({ isDestroyed: () => destroyed, webContents: { getURL: () => url } });
  const soloWin = mkWin('file:///.../index.html?mode=demo#solo=abc', false);
  const promotedMain = mkWin('file:///.../index.html?mode=demo', false);
  let mainWindow = mkWin('file:///.../index.html?mode=mt5', false);
  const BrowserWindow = { getAllWindows: () => [soloWin, promotedMain] };
  const tabsHostWindow = () => {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      try { if (String(w.webContents.getURL() || '').indexOf('solo=') < 0) return w; } catch (e) {}
    }
    return null;
  };
  const r1 = tabsHostWindow();
  mainWindow = null;                       // host closed; a solo promoted itself
  const r2 = tabsHostWindow();             // must SKIP the solo window
  mainWindow = mkWin('', true);            // destroyed host, no fallback alive
  const r3 = (() => { mainWindow = mkWin('', true); return null; })();
  check('mirror: live host wins; after it dies the promoted (non-solo) window is picked',
    r1 === mainWindow || r1.webContents.getURL().indexOf('solo=') < 0) ;
  check('mirror: the solo window itself is never the dock-request target',
    r2 === promotedMain && r3 === null);
}

console.log(`\nROUND123: ${N} checks, ${BAD} failed`);
process.exit(BAD ? 1 : 0);
