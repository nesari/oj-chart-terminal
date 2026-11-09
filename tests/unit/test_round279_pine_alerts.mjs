/**
 * test_round279_pine_alerts.mjs — ROUND279 Pine -> Alerts bridge.
 *
 * Engine contract:
 *   - alert() / alertcondition() publish a LIVE-ONLY tape (`out.pineAlerts`)
 *   - historical bars never emit; a full pass exposes only its final bar
 *   - alertcondition() fires once per live bar while true
 *   - alert() de-duplicates identical messages on the same bar (tick re-runs)
 *   - a full recalc clears the tape / re-arms the per-bar guards
 *
 * Renderer contract (source pins):
 *   - PineUI exposes pollAlerts()/pineAlertInventory()/setAlertSink()
 *   - runFull advances the per-instance cursor (history replay is silent)
 *   - the Alerts panel renders the Script alerts card and routes events to
 *     the same toast + OS notification + sound path as price alerts
 *
 * Run: node tests/unit/test_round279_pine_alerts.mjs
 */

import { compile } from '../../src/core/pine/compile.js';
import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

function bars(n, base) {
  const t0 = 1790600400 - (1790600400 % 900);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = (base || 100) + i;
    out.push({ time: t0 + i * 900, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 });
  }
  return out;
}

function runIt(src, n) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', mintick: 1 });
    rt.runAll(bars(n || 10));
    return { c, rt };
  } catch (e) { return { c, error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

const tape = (rt) => (rt && rt.out && rt.out.pineAlerts) || [];

/* ---------- 1. historical bars never emit ---------- */
{
  const r = runIt('//@version=5\nindicator("A")\nalert("every bar", alert.freq_all)\nplot(close)\n', 10);
  ok(!r.error, 'unconditional alert fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const t = tape(r.rt);
    ok(t.length === 1, 'full pass exposes only the final bar (got ' + t.length + ')');
    ok(t.length === 1 && t[0].bar === 9, 'exposed event sits on the last bar (got ' + (t[0] && t[0].bar) + ')');
    ok(t.length === 1 && t[0].kind === 'alert' && t[0].message === 'every bar', 'alert() message carried on the tape');
    ok(t.length === 1 && typeof t[0].seq === 'number' && t[0].seq > 0, 'tape events are sequenced for the renderer cursor');
  }
}

/* ---------- 2. alert() dedupes identical messages on the same bar ---------- */
{
  const r = runIt(`//@version=5
indicator("A")
if barstate.islast
    alert("live once", alert.freq_once_per_bar)
plot(close)
`, 10);
  ok(!r.error, 'live alert fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const n0 = tape(r.rt).length;
    const bb = bars(10);
    bb[9] = Object.assign({}, bb[9], { close: 500, high: 501 });
    r.rt.updateForming(bb);
    const n1 = tape(r.rt).length;
    r.rt.updateForming(bb);
    const n2 = tape(r.rt).length;
    ok(n0 === 1 && n1 === 1 && n2 === 1, 'repeated ticks do not duplicate alert() (got ' + n0 + '/' + n1 + '/' + n2 + ')');
  }
}

/* ---------- 3. a closed live bar emits; a new bar re-arms alert() ---------- */
{
  const r = runIt(`//@version=5
indicator("A")
if barstate.islast
    alert("live once", alert.freq_once_per_bar)
plot(close)
`, 10);
  ok(!r.error, 'new-bar alert fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const before = tape(r.rt).length;
    const bb = bars(11);
    bb[10] = Object.assign({}, bb[10], { close: 777, high: 778 });
    r.rt.pushNewBar(bb);
    const t = tape(r.rt);
    ok(t.length === before + 1, 'pushNewBar emits the next live alert (got ' + (t.length - before) + ')');
    ok(t.length > before && t[t.length - 1].bar === 10, 'new event belongs to the new bar (got ' + (t[t.length - 1] && t[t.length - 1].bar) + ')');
    ok(t.length > before && t[t.length - 1].seq > t[t.length - 2].seq, 'sequence keeps increasing across bars');
  }
}

/* ---------- 4. alertcondition(): once per live bar while true ---------- */
{
  const r = runIt(`//@version=5
indicator("C")
alertcondition(close > open, "Bullish", "close above open")
plot(close)
`, 10);
  ok(!r.error, 'alertcondition fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const inv = r.rt.out.alertconds;
    ok(inv.length === 1 && inv[0].title === 'Bullish' && inv[0].message === 'close above open',
      'alertcondition inventory keeps title + message');
    const t = tape(r.rt);
    ok(t.length === 1 && t[0].kind === 'condition' && t[0].title === 'Bullish',
      'full pass exposes the final condition event only (got ' + t.length + ')');
    ok(inv[0].lastFiredBar === 9, 'per-condition guard points at the fired bar (got ' + inv[0].lastFiredBar + ')');

    const bb = bars(10);
    r.rt.updateForming(bb);
    ok(tape(r.rt).length === 1, 'same-bar tick does not re-fire the condition');

    const nb = bars(11);
    r.rt.pushNewBar(nb);
    const t2 = tape(r.rt);
    ok(t2.length === 2, 'a new live bar fires the condition again (got ' + t2.length + ')');
    ok(t2.length === 2 && t2[1].bar === 10, 'second condition event is on the new bar (got ' + (t2[1] && t2[1].bar) + ')');
  }
}

/* ---------- 5. a false condition is silent ---------- */
{
  const r = runIt(`//@version=5
indicator("C")
alertcondition(close > open * 1000, "Never", "nope")
plot(close)
`, 10);
  ok(!r.error, 'false-condition fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(tape(r.rt).length === 0, 'a false condition emits nothing');
    ok(r.rt.out.alertconds.length === 1 && r.rt.out.alertconds[0].lastCond === false,
      'inventory still lists the condition (it just never fires)');
  }
}

/* ---------- 6. a full recalc re-arms the tape ---------- */
{
  const r = runIt(`//@version=5
indicator("C")
alertcondition(close > open, "Bullish", "m")
alert("bar msg")
plot(close)
`, 10);
  ok(!r.error, 'recalc fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const first = tape(r.rt).slice();
    ok(first.length === 2, 'one alert() + one condition event on the final bar (got ' + first.length + ')');
    r.rt.runAll(bars(12));
    const t = tape(r.rt);
    ok(t.length === 2, 'full recalc replaces the tape (not appends) (got ' + t.length + ')');
    ok(t.every((e) => e.bar === 11), 'recacl events are all on the new final bar');
    ok(r.rt.out.alertconds[0].lastFiredBar === 11, 'recalc re-armed the condition guard');
    /* ROUND279: the sequence must NOT restart — the renderer cursor is a
       high-water mark, so a reset would swallow every later live event. */
    ok(t.length && t[0].seq > first[first.length - 1].seq, 'sequence keeps climbing across a recalc (cursor stays valid)');
  }
}

/* ---------- 7. unnamed alertcondition still gets a panel key ---------- */
{
  const r = runIt('//@version=5\nindicator("C")\nalertcondition(close > open)\nplot(close)\n', 10);
  ok(!r.error, 'unnamed condition fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const inv = r.rt.out.alertconds;
    ok(inv.length === 1 && /^Alert condition \d+$/.test(inv[0].title),
      'generated title keeps the inventory keyable (got "' + (inv[0] && inv[0].title) + '")');
  }
}

/* ---------- 8. alertcondition() stays loud in strategies ---------- */
{
  const r = runIt('//@version=5\nstrategy("S")\nalertcondition(close > open, "X")\nplot(close)\n', 10);
  ok(!!r.error && /cannot be used in strategy/.test(r.error), 'alertcondition still rejected in strategies');
}

/* ---------- 9. renderer wiring: PineUI tape API ---------- */
{
  const src = readSource('src/renderer/js/chart/pine-ui/runtime.js');
  ok(/pineAlertInventory\(\)/.test(src), 'PineUI.pineAlertInventory() exists');
  ok(/pollAlerts\(\)/.test(src) && /setAlertSink/.test(src), 'PineUI.pollAlerts()/setAlertSink() exist');
  ok(/st\._alertCursor/.test(src) && /ev\.seq > cur/.test(src), 'pollAlerts drains past the per-instance cursor');
  ok(/pineAlertSink\(\{/.test(src), 'pollAlerts forwards events to the registered sink');
}

/* ---------- 10. renderer wiring: full pass suppresses replay ---------- */
{
  const src = readSource('src/renderer/js/chart/pine-ui/panel.js');
  ok(/_alertCursor: 0/.test(src), 'instance state seeds the alert cursor');
  ok(/st\._alertCursor = evs\.length \? evs\[evs\.length - 1\]\.seq : 0/.test(src),
    'runFull advances the cursor past the replay tape');
}

/* ---------- 11. renderer wiring: Alerts panel card + notification path ---------- */
{
  const src = readSource('src/renderer/js/panels/alerts.js');
  ok(/mt5_pa_cfg/.test(src), 'Pine alert settings persist in mt5_pa_cfg');
  ok(/function renderPineAlerts\(/.test(src) && /Alerts\.renderPineAlerts/.test(src), 'Script alerts card renderer exists');
  ok(/renderPineAlerts\(\);/.test(src) && /PineUI\.setAlertSink\(Alerts\.onPineAlert\)/.test(src),
    'Alerts.init renders the card and registers the sink');
  ok(/pollPineAlerts\(\);/.test(src) && /PineUI\.pollAlerts\(\)/.test(src), 'Alerts.onTick drains the live tape');
  ok(/Alerts\.onPineAlert = function/.test(src), 'Alerts.onPineAlert handles fired script alerts');
  ok(/c\.conds\[ev\.key\] === false/.test(src) && /c\.messages === false/.test(src),
    'per-condition arm + alert() message switches gate notifications');
  ok(/UI\.toast\('Pine alert: '/.test(src) && /electronAPI\.notify\('Pine Alert'/.test(src) && /playSound\(\)/.test(src),
    'Pine alerts reuse the toast + OS notification + sound path');
}

/* ---------- 12. renderer wiring: the panel mount point ---------- */
{
  const html = readSource('src/renderer/index.html');
  ok(/id="pine-alert-settings"/.test(html), 'index.html mounts #pine-alert-settings inside #al-stack');
}

console.log('\nROUND279: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
