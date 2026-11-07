#!/usr/bin/env node
/**
 * Chart / panel render profiling with large datasets (F8.4).
 *
 * Boots the real renderer (same path as the smoke gate), replays synthetic
 * OHLC datasets of increasing size through `Manager.setPaneData` and prints
 * where the time goes:
 *
 *   series write  transformData + series.setData (the blocking part)
 *   fit           timeScale().fitContent()
 *   overlay       drawing/axis overlay repaint (engine.render)
 *   paint         two animation frames after the write (LWC paint)
 *   indicators    Manager.recomputeIndicators
 *
 * Usage:
 *   npm run report:perf                       # 5k / 20k / 50k bars
 *   npm run report:perf -- --sizes 1000,100000
 *   npm run report:perf -- --json             # machine-readable
 *   npm run report:perf -- --out perf.json    # also write the raw result
 *   npm run report:perf -- --budget 250       # exit 1 if the largest
 *                                             # series write + paint exceeds 250ms
 *
 * This is a measurement tool, not part of `verify`: absolute timings depend on
 * the machine and shared CI runners are too noisy for a hard gate.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  ROOT, electronExe, findPython, startStaticServer, waitForPort, killTree,
} from './lib/renderer-boot.mjs';

const WEB_PORT = Number(process.env.PERF_WEB_PORT || 8890);
const WS_PORT = Number(process.env.PERF_WS_PORT || 8891);
const HARNESS = path.join(ROOT, 'scripts', 'checks', 'perf-electron.cjs');
const TIMEOUT_MS = Number(process.env.PERF_TIMEOUT_MS || 180000);

function parseArgs(argv) {
  const out = { sizes: '5000,20000,50000', json: false, out: null, budget: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--sizes') out.sizes = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--budget') out.budget = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('usage: node scripts/checks/perf-profile.mjs [--sizes 5000,20000,50000] [--json] [--out file] [--budget ms]');
      process.exit(0);
    } else {
      console.error('[perf] unknown option: ' + a);
      process.exit(2);
    }
  }
  return out;
}

function pad(s, n) { return String(s).padStart(n); }

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(HARNESS)) throw new Error('missing harness: ' + HARNESS);
  const py = findPython();
  if (!py) throw new Error('no Python interpreter found (tried python, python3, py -3)');

  let server = null;
  let provider = null;
  let electron = null;
  try {
    server = await startStaticServer(WEB_PORT);
    provider = spawn(py.cmd, [...py.prefix, '-u', path.join(ROOT, 'provider', 'demo.py')], {
      cwd: ROOT,
      env: { ...process.env, MT5_WS_PORT: String(WS_PORT), PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let providerErr = '';
    provider.stderr.on('data', (d) => { providerErr += d; });
    provider.stdout.on('data', () => { /* drain */ });
    provider.on('error', (e) => { providerErr += String(e); });

    if (!(await waitForPort(WS_PORT, 15000))) {
      throw new Error(`demo provider did not open port ${WS_PORT}\n${providerErr.slice(-2000)}`);
    }

    const url = `http://127.0.0.1:${WEB_PORT}/renderer/index.html?ws=127.0.0.1:${WS_PORT}`;
    const electronArgs = [HARNESS];
    if (process.platform === 'linux' && process.env.SMOKE_NO_SANDBOX !== '0') {
      electronArgs.unshift('--no-sandbox');
    }
    electron = spawn(electronExe(), electronArgs, {
      cwd: ROOT,
      env: { ...process.env, PERF_URL: url, PERF_SIZES: opts.sizes },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    electron.stdout.on('data', (d) => { out += d; });
    electron.stderr.on('data', (d) => { err += d; });

    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        killTree(electron);
        reject(new Error(`perf harness timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      electron.on('error', (e) => { clearTimeout(timer); reject(e); });
      electron.on('close', (c) => { clearTimeout(timer); resolve(c); });
    });

    const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith('PERF_RESULT='));
    if (!line) {
      throw new Error(`harness produced no result (exit ${code})\n--- stdout ---\n${out.slice(-3000)}\n--- stderr ---\n${err.slice(-3000)}`);
    }
    const result = JSON.parse(line.slice('PERF_RESULT='.length));
    if (!result.ok) throw new Error('harness failed: ' + JSON.stringify(result));

    if (opts.out) {
      fs.writeFileSync(path.resolve(ROOT, opts.out), JSON.stringify(result, null, 2) + '\n');
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[perf] boot ${result.bootMs}ms · canvas ${result.canvas ? result.canvas.join('x') : '?'} @${result.dpr}x · heap ${result.heapMB == null ? 'n/a' : result.heapMB + ' MB'}`);
      console.log('');
      console.log('   bars   write    fit   paint  overlay   indica');
      for (const r of result.rows) {
        console.log(`${pad(r.bars, 7)} ${pad(r.seriesWriteMs, 7)} ${pad(r.fitMs, 6)} ${pad(r.chartPaintMs, 7)} ${pad(r.overlayMs, 8)} ${pad(r.indicatorsMs, 8)}   ms`);
      }
      console.log('');
      console.log(`[perf] pan: ${result.panFrameMs}ms per rendered frame (20 logical-range moves)`);
      if (result.errors && result.errors.length) {
        console.log(`[perf] ${result.errors.length} console error(s) during the run`);
        for (const e of result.errors.slice(0, 5)) console.log('  - ' + e);
      }
    }

    if (opts.budget != null && Number.isFinite(opts.budget)) {
      const last = result.rows[result.rows.length - 1];
      const cost = last ? last.seriesWriteMs + last.chartPaintMs : Infinity;
      if (!(cost <= opts.budget)) {
        console.error(`[perf] FAIL — ${last ? last.bars : '?'} bars cost ${cost.toFixed(1)}ms > budget ${opts.budget}ms`);
        process.exit(1);
      }
      console.log(`[perf] budget OK — ${last.bars} bars write+paint ${cost.toFixed(1)}ms <= ${opts.budget}ms`);
    }
  } finally {
    killTree(electron);
    killTree(provider);
    if (server) await new Promise((r) => server.close(r));
  }
}

main().catch((e) => {
  console.error('[perf] ' + (e.stack || e));
  process.exit(1);
});
