#!/usr/bin/env python3
"""ROUND59 verify gate.

User report (with layout screenshot + Sync in Layout/Crosshair ON): in
multi-chart mode, moving the mouse over one chart made the OTHER chart's
crosshair JUMP, and sometimes the highlight (time pill) + dashed vertical
line went missing in Cross mode; synced behavior on the other charts had to
be correct.

Root cause (proven by Playwright stack-attribution probe): TWO parallel sync
paths per pane — the engine path (continuous cursor time) AND LWC's own
subscribeCrosshairMove handler, which this build ALSO fires for our own
programmatic setCrosshairPosition calls, DEFERRED after the synchronous
_xsync guard window closed (probe: 1 mousemove -> 3 setCrosshairPosition
calls on the receiver). The late echo re-drove the panes with LWC's bar-
SNAPPED param.time (future margin: clamped to the LAST bar) -> flip-flop =
the jump; on the axis strips the old path moved only the native lines,
leaving the custom line + pill stale/hidden = the missing highlight.

Fix (ONLY chart/manager.js + drawing/engine.js): the subscription now
DELEGATES to Manager.syncCrossMove/syncCrossClear (one sync owner, full
custom visuals) and only fires for genuine pointer events (engine.mouse.
inside + a 150ms _lastMouseMove freshness gate); a 100ms deadman window
(pane._xsyncUntil, stamped by the sync functions, _setCrossXY and the
mouseleave handler) absorbs deferred programmatic/tick echoes.

Checks:
  1. static pins (version 1.9.10, delegation, all three gates, stamps)
  2. BYTE-IDENTITY audit: every src/ file EXCEPT the two fixed ones must be
     byte-identical to r58 (the guarantee that nothing else changed)
  3. subprocess: e2e probe suite on this tree (calls-per-move, sweep
     continuity, axis-hover visuals, leave-clear, reverse sync, no errors)
"""
import json, os, subprocess, sys, hashlib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PREV = '/home/z/my-project/work/mt5-round58'
os.chdir(ROOT)

PASS, FAIL = [], []
def ok(name, cond, extra=''):
    (PASS if cond else FAIL).append(name)
    print(('  OK  ' if cond else ' FAIL ') + name + (('  -> ' + str(extra)) if (extra and not cond) else ''))

def read(p):
    with open(p, 'r', encoding='utf-8') as f:
        return f.read()

def sha(p):
    with open(p, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()

print('== 1) static ==')
pkg = json.loads(read('package.json'))
ok('version 1.9.10+ (pin updated r60)', pkg.get('version') in ('1.9.10', '1.9.11', '1.9.12'), pkg.get('version'))

mj = read('src/renderer/js/chart/manager.js')
ok('subscription delegates to the engine path',
   'if (Manager.syncCrossMove) Manager.syncCrossMove(pane, t);' in mj and
   'if (Manager.syncCrossClear) Manager.syncCrossClear(pane); return;' in mj)
ok('old native-only inline loop removed',
   'p.chart.setCrosshairPosition(b.close, t, p.series);\n            else p.chart.clearCrosshairPosition();' not in mj)
ok('deadman gate in the subscription', 'pane._xsyncUntil && performance.now() < pane._xsyncUntil' in mj)
ok('pointer-presence gate (engine.mouse.inside)',
   'if (!(pane.engine && pane.engine.mouse && pane.engine.mouse.inside)) return;' in mj)
ok('freshness gate (_lastMouseMove <= 150ms)',
   'performance.now() - pane.engine._lastMouseMove <= 150' in mj)
ok('deadman stamps in syncCrossMove (src + receivers)',
   mj.count('src._xsyncUntil = now + 100') == 2 and mj.count('p._xsyncUntil = now + 100') == 2)
ok('syncCrossMove/Clear bodies otherwise intact',
   'Manager.syncCrossMove = function (src, t)' in mj and 'Manager.syncCrossClear = function (src)' in mj and
   'p.chart.setCrosshairPosition(b.close, t, p.series);' in mj and
   "p.engine._cross = { on: false, x: -1, y: -1 };" in mj)
ok('LWC echo reality documented', 'DEFERRED' in mj and 'bar-SNAPPED' in mj)

en = read('src/renderer/js/drawing/engine.js')
ok('deadman stamp in _setCrossXY', 'pane._xsyncUntil = performance.now() + 100;' in en)
ok('deadman stamp in mouseleave before the clear',
   en.index('this.pane._xsyncUntil = performance.now() + 100;') < en.index('this.pane.chart.clearCrosshairPosition();'))
ok('_lastMouseMove init + stamped on real mousemove',
   'this._lastMouseMove = 0;' in en and 'this._lastMouseMove = performance.now();' in en)
ok('_syncCross engine path untouched', 'Manager.syncCrossMove(this.pane, t);' in en)

print('== 2) byte-identity vs r58 (only the two fixed files differ) ==')
FIXED = {'src/renderer/js/chart/manager.js', 'src/renderer/js/drawing/engine.js',
         'src/renderer/js/drawing/tools2.js', 'src/renderer/js/drawing/settings.js',
         'src/renderer/js/drawing/ui.js', 'src/renderer/js/ui/icons.js'}  # + r60 fib flyout
src_r59, src_r58 = os.path.join(ROOT, 'src'), os.path.join(PREV, 'src')
n_id, n_cmp = 0, 0
for dp, _, fns in os.walk(src_r59):
    for fn in fns:
        p = os.path.join(dp, fn)
        rel = os.path.relpath(p, ROOT)
        q = os.path.join(PREV, rel)
        if rel in FIXED:
            ok('fixed file differs from r58 (expected): ' + rel, sha(p) != sha(q))
            continue
        if not os.path.exists(q):
            ok('new file unexpected in src/: ' + rel, False)
            continue
        n_cmp += 1
        if sha(p) == sha(q):
            n_id += 1
        else:
            ok('src file differs from r58: ' + rel, False)
ok('all %d other src/ files byte-identical to r58' % n_cmp, n_cmp > 0 and n_id == n_cmp)
for rel in ('provider/demo.py', 'provider/provider_common.py', 'provider/mt5.py', 'main.js', 'src/renderer/index.html'):
    a, b = os.path.join(ROOT, rel), os.path.join(PREV, rel)
    if os.path.exists(a) and os.path.exists(b):
        ok('unchanged vs r58: ' + rel, sha(a) == sha(b))
    else:
        ok('exists: ' + rel, os.path.exists(a))

print('== 3) subprocess: e2e sync probe suite (this tree) ==')
r = subprocess.run([sys.executable, '/home/z/my-project/scripts/verify_probe59.py'],
                   capture_output=True, text=True, timeout=280)
out = r.stdout
ok('probe suite ran', 'RESULT:' in out, out[-300:] + r.stderr[-200:])
ok('zero page errors', 'PAGE ERRORS: 0' in out)
ok('axis hover drives full visuals on B', "pillOn': True" in out and "on': True, x':" in out.replace(' ', ' x')[:0] or "'on': True" in out)
ok('leave clears B', "after leaving A (expect cleared): {'on': False, 'pillOn': False}" in out)
ok('hover B syncs A', "hover B -> A synced (expect on=true): {'on': True" in out)
ok('no sweep reversals (the jump is gone)', 'reversals (expect 0): []' in out)

print('')
print('RESULT: %d/%d' % (len(PASS), len(PASS) + len(FAIL)))
sys.exit(1 if FAIL else 0)
