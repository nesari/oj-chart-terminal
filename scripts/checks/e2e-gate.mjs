#!/usr/bin/env node
/**
 * Curated browser E2E gate (ROUND283).
 *
 * `tests/archive/e2e/` holds ~136 Playwright suites covering rounds 31..256.
 * They are NOT part of `verify`: each one boots a static server, the demo
 * provider and Chromium, so running all of them would blow the gate's time
 * budget and re-test stable areas on every push.
 *
 * This gate runs a small, high-value set that exercises the paths a unit
 * suite cannot reach — a real browser, real canvas paints and the real
 * module graph:
 *
 *   round205  deleted drawing objects + forming-bar rollback
 *   round196  matrix/map engine surface through the live runtime
 *   round201  session.* on the live chart (both states, not degenerate)
 *   round203  table styling (version-correct palette)
 *   round205  deleted drawing objects + forming-bar rollback
 *   round252  Style-tab rendering controls
 *   round283  Pine -> Alerts bridge + ROUND282 pivot rendering  (new)
 *   round284  drawing-tool settings parity (dialog controls + fills)  (new)
 *   round285  drawing parity wave 2 (callout/measure/profiles/labels)  (new)
 *   round286  stale-interval crash hardening                          (new)
 *   round287  settings that had no control now work                     (new)
 *   round288  no setting may be a placebo (removed + wired)             (new)
 *   round288b session breaks (day-gap whitespace on the time axis)     (new)
 *   round289  drawing leftovers (profile scopes / band / dragged levels) (new)
 *   round290  version row + auto-update degraded mode in a browser build  (new)
 *   round294  About/version popup on the toolbar: version + manual check  (new)
 *   round299  every built-in indicator runs as a Pine script           (new)
 *   round300  Pine drawings sit exactly on their bar (pan/zoom/TF)     (new)
 *   round301  TF/symbol switch leaves no stale series rows             (new)
 *   round302  separate-pane indicators really paint + row in own pane  (new)
 *   audit_r303_indicator_math  every built-in's NUMBER, not just its DOM (new)
 *   audit_left_toolbar  every drawing tool paints, no orphans             (new)
 *   audit_core_chart_tv  chart API surface, styles, context menus          (new)
 *   audit_app_sweep     every panel/toolbar entry opens real content       (new)
 *   audit_app_deep      user flows end-to-end (alert, drawing, pine, trade) (new)
 *
 * ROUND297: the four discovery harnesses that found the R286/R287 bugs are now
 * part of the gate. They were "runnable at any time" but nothing ran them, so a
 * regression could only be found by a human remembering to look. They cost
 * ~30s on a cold runner and cover the two areas a unit suite cannot: the real
 * drawing toolbar and the real app shell.
 *
 * History: until ROUND283 every archived suite was silently broken — the move
 * into `tests/archive/e2e/` added a directory level, so `ROOT` (three
 * dirname() calls) resolved to `tests/` and the scripts could not find `src/`
 * or `provider/demo.py`. Fixing ROOT made 126 suites runnable again; this
 * gate keeps a representative sample honest on every push.
 *
 * Usage:
 *   node scripts/checks/e2e-gate.mjs              # curated set
 *   node scripts/checks/e2e-gate.mjs --all        # every archived suite
 *   node scripts/checks/e2e-gate.mjs round252     # name substring filter
 *   node scripts/checks/e2e-gate.mjs --shard 1/2  # deterministic half
 *   node scripts/checks/e2e-gate.mjs --shard 2/2 --list   # show the split
 *
 * ROUND305: `--shard N/M` exists because the curated list was at the edge of
 * its 20-minute CI budget and the roadmap adds ~13 more suites. The suites are
 * sorted by a stable hash of the file name and dealt out round-robin, so every
 * shard gets the same number of suites (±1), the union of all shards is exactly
 * the full list, and no suite runs twice. Add `--list` to see the assignment
 * without booting anything.
 *
 * The roadmap's panel suites live in PANEL_SUITES and are gated by
 * `check:e2e:panels` (a separate CI job), so `check:e2e` keeps its own budget
 * even after all 13 phases land. A suite listed there but not written yet is
 * skipped with a notice; `--require-panels` turns that notice into a failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'tests', 'archive', 'e2e');

const CURATED = [
  'e2e_round196_matrix_map.py',
  'e2e_round201_session.py',
  'e2e_round203_table_style.py',
  'e2e_round205_deleted.py',
  'e2e_round252_style1.py',
  'e2e_round283_alerts_pivots.py',
  'e2e_round284_drawing_settings.py',
  'e2e_round285_drawing_parity2.py',
  'e2e_round286_chart_hardening.py',
  'e2e_round287_settings_controls.py',
  'e2e_round288_effective_settings.py',
  'e2e_round288b_session_breaks.py',
  'e2e_round289_drawing_leftovers.py',
  'e2e_round290_autoupdate.py',
  'e2e_round294_about_version.py',
  /* ROUND297: the discovery harnesses are now a permanent part of the gate. */
  'audit_left_toolbar.py',
  'audit_core_chart_tv.py',
  'audit_app_sweep.py',
  'audit_app_deep.py',
  /* ROUND298: channel band fills + histogram color modes must really paint. */
  'e2e_round299_builtin_pine.py',
  /* ROUND300: a Pine drawing must sit exactly on its bar (pan/zoom/timeframes). */
  'e2e_round300_pine_alignment.py',
  /* ROUND301: switching TF/symbol must never leave stale rows in the series. */
  'e2e_round301_tf_switch.py',
  /* ROUND302: every separate-pane indicator must really paint inside its own
     pane (the shared pine canvas made a paint cycle all-or-nothing) and its
     legend row must live in that pane, not in the price legend. */
  'e2e_round302_subpane_paint.py',
  /* ROUND303: differential NUMERIC audit — every built-in's printed number is
     checked against an independent recomputation, plus the identity invariant
     (records == instances == sub-panes) that caught the instance-id collision.
     The other four harnesses only ask "does this open without throwing". */
  'audit_r303_indicator_math.py',
];

/**
 * ROUND305: suites produced by `docs/ROADMAP-PANELS.md`.
 *
 * Kept apart from CURATED on purpose. CURATED is what must run on every push in
 * ~10 minutes; this list grows to 13 suites (one per phase) and would double
 * that. `npm run check:e2e:panels` runs it in its own CI job.
 *
 * Entries that do not exist yet are skipped — the phase they belong to is not
 * implemented, so there is nothing to test. Adding a suite requires adding the
 * file here, otherwise it is "runnable but never run", the exact trap ROUND297
 * closed for the audit harnesses.
 */
const PANEL_SUITES = [
  'e2e_round305_command_palette.py',   /* P0-01 */
  'e2e_round307_shortcuts.py',         /* P0-03 */
  'e2e_round306_chart_menu.py',        /* P0-02 */
  'e2e_round306_watchlist.py',         /* P1 */
  'e2e_round307_datawindow_objects.py',/* P2 */
  'e2e_round308_alerts.py',            /* P3 */
  'e2e_round309_trading.py',           /* P4 */
  'e2e_round310_tester.py',            /* P5 */
  'e2e_round311_pine_editor.py',       /* P6 */
  'e2e_round312_ts_news.py',           /* P7 */
  'e2e_round313_chart_core.py',        /* P8 */
  'e2e_round314_drawing_extra.py',     /* P10 */
  'e2e_round315_screener.py',          /* P11 */
  'e2e_round316_nontime.py',           /* P12 */
];

/* Per attempt. A cold Windows runner needs ~30s for a heavy suite; the retry
   path may therefore take up to twice this. */
let TIME_LIMIT_MS = 90_000;

function findPython() {
  for (const cmd of ['python', 'python3', 'py']) {
    const args = cmd === 'py' ? ['-3'] : [];
    const r = spawnSync(cmd, [...args, '-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && String(r.stdout).trim() === '3') return { cmd, prefix: args };
  }
  return null;
}

/* Kill a suite AND everything it spawned.

   ROUND290: this used `child.kill('SIGKILL')`, which on Windows terminates only
   the Python process. Every suite starts a static HTTP server, the demo
   provider and Chromium as children; those survived the timeout and kept
   holding their ports and CPU, so the NEXT suite fought a machine that was
   already saturated and it too timed out. That is exactly the chain seen on CI
   (round287 timed out, then round288 timed out right behind it).

   `kill_proc` in tests/archive/e2e/e2e_teardown.py solves the same problem with
   `taskkill /T /F`; the gate needs its own copy because it owns the process. */
function killTree(child) {
  if (!child || child.killed) return;
  const pid = child.pid;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      /* Signal the whole group first (the child is spawned detached, so it is
         its own leader). If that throws — older Node, a platform without
         groups, or a child that already left the group — fall back to killing
         the direct child AND its descendants discovered via `pkill -P`. */
      let done = false;
      try { process.kill(-pid, 'SIGKILL'); done = true; } catch (e) { done = false; }
      if (!done) {
        try { spawnSync('pkill', ['-P', String(pid)], { stdio: 'ignore' }); } catch (e) {}
        try { child.kill('SIGKILL'); } catch (e) {}
      }
    }
  } catch (e) {
    try { child.kill('SIGKILL'); } catch (e2) {}
  }
}

function runSuite(py, file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(py.cmd, [...py.prefix, path.join(DIR, file)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      /* POSIX: a new process group so a timeout can signal the whole tree */
      detached: process.platform !== 'win32',
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ file, ok: false, ms: Date.now() - started, out, err: err + '\n(timed out)' });
    }, TIME_LIMIT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0, ms: Date.now() - started, out, err });
    });
  });
}

/* A cold CI runner occasionally needs longer than the suites' own boot window
   before the demo provider + WebSocket handshake settle. On a 2-vCPU runner
   running a dozen Electron-free but still browser-heavy suites back to back,
   Chromium itself can stall for tens of seconds. That is environmental, not a
   code defect (ROUND266 made the same call for the liveness probe), so:
     - the suites allow 45s for boot,
     - this gate retries up to THREE times,
     - and it gives the machine a short cooldown between attempts so the OS
       can reap the dead Chromium/provider processes first. A genuine failure
       still fails every attempt. */
function looksLikeBootTimeout(r) {
  /* Only a failure to REACH the app counts. A suite that booted and then
     failed an assertion must never be retried (that would hide a real bug).

     The signature is the app never becoming visible: Playwright's
     "Page.wait_for_selector: Timeout" on '#app:not(.hidden)'. A suite that
     DID reach the app and then failed prints its own "FAIL <name>" lines,
     which is the signal that it must not be retried. */
  const out = (r.out || '') + '\n' + (r.err || '');
  const bootTimeout = /Page\.wait_for_selector: Timeout|wait_for_selector.*Timeout \d+ms exceeded|ERR_CONNECTION_REFUSED|ECONNREFUSED|Target page, context or browser has been closed/i.test(out);
  if (!bootTimeout) return false;
  /* the suite got far enough to run its own assertions -> real failure */
  return !/^\s+(FAIL|  FAIL)/m.test(r.out || '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Deterministic partition key for `--shard N/M` (ROUND305).
 *
 * FNV-1a over the file name. The requirements are unusual for a hash: the
 * mapping must be STABLE (a suite never changes shard because an unrelated
 * suite was added), SPREAD (24 suites over 2 shards must not be 23/1) and
 * CHEAP. FNV-1a satisfies all three and needs no dependency.
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

async function runWithRetry(py, file) {
  let last = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) {
      process.stdout.write(`(boot timeout, retry ${attempt}/3) `);
      /* let the OS reap the previous Chromium/provider before relaunching —
         ROUND290: killTree() above already signalled the tree, this grace
         period is the time those processes need to release their ports. */
      await sleep(3000 * attempt);
    }
    last = await runSuite(py, file);
    if (last.ok) { last.retried = attempt > 0; return last; }
    if (!looksLikeBootTimeout(last)) return last;
  }
  last.retried = true;
  return last;
}

async function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const panels = argv.includes('--panels');
  const requirePanels = argv.includes('--require-panels');
  const wantList = argv.includes('--list');
  const shardArg = (() => {
    const i = argv.indexOf('--shard');
    if (i < 0) return null;
    const raw = argv[i + 1];
    const m = /^(\d+)\/(\d+)$/.exec(String(raw || ''));
    if (!m) {
      console.error('[e2e] --shard needs N/M, e.g. --shard 1/2');
      process.exit(2);
    }
    const index = Number(m[1]), total = Number(m[2]);
    if (index < 1 || total < 1 || index > total) {
      console.error(`[e2e] --shard ${raw}: N must be 1..M`);
      process.exit(2);
    }
    return { index, total };
  })();
  /* `--shard 1/2` also carries positional args; strip the flag and its value so
     the substring filter below does not treat "1/2" as a suite name. */
  const filters = argv.filter((a, i) => !a.startsWith('-') && !(shardArg && i === argv.indexOf('--shard') + 1));

  if (!fs.existsSync(DIR)) {
    console.error('[e2e] no archived suites at ' + DIR);
    process.exit(1);
  }

  let files;
  if (all) files = fs.readdirSync(DIR).filter((f) => f.endsWith('.py')).sort();
  else if (filters.length) files = fs.readdirSync(DIR).filter((f) => f.endsWith('.py') && filters.some((s) => f.includes(s))).sort();
  else if (panels) {
    const present = PANEL_SUITES.filter((f) => fs.existsSync(path.join(DIR, f)));
    const missing = PANEL_SUITES.filter((f) => !fs.existsSync(path.join(DIR, f)));
    if (missing.length) {
      /* An unimplemented phase has nothing to test, so a missing file is a
         notice, not a failure — but silence would let a whole phase ship with
         no gate, which is how the four R297 harnesses went unrun for months. */
      const msg = `[e2e] ${missing.length}/${PANEL_SUITES.length} panel suite(s) not written yet:`;
      if (requirePanels) {
        console.error(msg);
        for (const f of missing) console.error('  ' + f);
        console.error('[e2e] --require-panels: every phase suite must exist');
        process.exit(1);
      }
      console.log(msg);
      for (const f of missing) console.log('  ' + f + '  (pending its roadmap phase)');
    }
    files = present;
    if (!files.length) {
      console.log('[e2e] no panel suites yet — nothing to run (see docs/ROADMAP-PANELS.md)');
      return;
    }
  } else files = CURATED.filter((f) => fs.existsSync(path.join(DIR, f)));

  if (!files.length) {
    console.error('[e2e] no suite matched');
    process.exit(1);
  }

  /* ROUND305 (roadmap P0-00): deterministic sharding.
     Sort the suites by a stable hash of the file name, then hand them out
     round-robin. That gives two properties the CI depends on:
       - the union of every shard is exactly the full list, never a duplicate;
       - the sizes differ by at most one (24 suites over 2 shards is 12/12, not
         23/1 as `hash % M` produced — a 15/9 split spends 70% of the budget in
         one job while the other half idles).
     Hashing first (instead of trusting the alphabetical order) keeps the split
     unrelated to suite names, so a batch of `round3xx` additions does not all
     land in the same shard. */
  if (shardArg) {
    const ranked = files
      .map((f) => ({ f, k: fnv1a(f) }))
      .sort((a, b) => (a.k - b.k) || a.f.localeCompare(b.f))
      .map((x) => x.f);
    files = ranked.filter((_, i) => (i % shardArg.total) === shardArg.index - 1);
    if (!files.length) {
      console.error(`[e2e] shard ${shardArg.index}/${shardArg.total} is empty`);
      process.exit(1);
    }
  }

  if (wantList) {
    console.log(`[e2e] ${files.length} suite(s)${shardArg ? ` in shard ${shardArg.index}/${shardArg.total}` : ''}:`);
    for (const f of files) console.log('  ' + f);
    return;
  }

  const py = findPython();
  if (!py) {
    console.error('[e2e] no Python 3 interpreter found');
    process.exit(1);
  }
  /* Playwright is an optional local dependency: skip (do not fail) when it is
   * not installed, so `verify` and the curated gate stay usable in a plain
   * checkout. CI installs it and therefore runs the real thing. */
  const probe = spawnSync(py.cmd, [...py.prefix, '-c', 'import playwright'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.log('[e2e] Playwright is not installed — skipping the browser gate');
    console.log('[e2e] install with: python -m pip install playwright && python -m playwright install chromium');
    process.exit(0);
  }

  console.log(`[e2e] running ${files.length} suite(s)${shardArg ? ` (shard ${shardArg.index}/${shardArg.total})` : ''}`);
  const results = [];
  for (const f of files) {
    process.stdout.write(`[e2e] ${f} ... `);
    const r = await runWithRetry(py, f);
    results.push(r);
    const summary = (r.out.split(/\r?\n/).reverse().find((l) => /all green|failed|FAIL/.test(l)) || '').trim();
    console.log(r.ok ? 'ok' : 'FAIL', `${r.ms}ms${r.retried ? ' (retried)' : ''}${summary ? ' — ' + summary : ''}`);
    if (!r.ok) {
      const tail = (r.out + '\n' + r.err).split(/\r?\n/).filter((l) => l.includes('FAIL') || l.includes('Error') || l.includes('Traceback')).slice(0, 8);
      for (const l of tail) console.log('      ' + l.trim());
    }
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n[e2e] ${results.length - bad.length}/${results.length} suites green`);
  if (bad.length) {
    console.error('[e2e] FAILED: ' + bad.map((r) => r.file).join(', '));
    process.exit(1);
  }
}

main().catch((e) => { console.error('[e2e] ' + (e.stack || e)); process.exit(1); });
