#!/usr/bin/env node
/**
 * E2E port auditor (ROUND305 / roadmap P0-00).
 *
 * Every archived Playwright suite boots its own static server and demo
 * provider, so each one needs a private HTTP port and a private WS port.
 * Historically the numbers were hand-picked and collided: `e2e_round194` and
 * `audit_left_toolbar` both claim 8987, and 20+ suites share a WS port. That is
 * harmless while the gate is strictly serial, but the moment suites run in two
 * shards (the whole point of `--shard`) two colliding suites can start at the
 * same instant and one of them fails to bind — a red gate with no bug behind it.
 *
 * This script makes the collision visible instead of theoretical:
 *
 *   node scripts/checks/e2e-ports.mjs            # report duplicates
 *   node scripts/checks/e2e-ports.mjs --free     # print a free HTTP,WS pair
 *   node scripts/checks/e2e-ports.mjs --json     # machine-readable report
 *
 * `--free` picks the first pair above every port in use, inside the ranges the
 * roadmap documents (HTTP 9080-9120, WS 8930-8990), so a new suite never
 * re-uses a number that a future shard might need.
 *
 * Exit code: 0 when only SERIAL safe duplicates exist (see below), 1 when a
 * pair is duplicated in a way that breaks sharding.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'tests', 'archive', 'e2e');

/* The documented free ranges. A new suite MUST land inside these. */
const HTTP_FLOOR = 9080;
const HTTP_CEIL = 9120;
const WS_FLOOR = 8930;
const WS_CEIL = 8990;
/* Ports with a fixed meaning: the demo provider and the provider's HTTP side.
   A suite may legitimately hard-code them (they are the default), but they are
   never handed out by --free. */
const RESERVED = new Set([8777, 8778]);

function readPair(file) {
  const src = fs.readFileSync(file, 'utf8');
  /* `PORT_HTTP, PORT_WS = 8989, 8817` is the common shape */
  const pair = /PORT_HTTP\s*,\s*PORT_WS\s*=\s*(\d+)\s*,\s*(\d+)/.exec(src);
  if (pair) return { http: Number(pair[1]), ws: Number(pair[2]) };
  const http = /PORT_HTTP\s*=\s*(\d+)/.exec(src);
  const ws = /PORT_WS\s*=\s*(\d+)/.exec(src);
  return {
    http: http ? Number(http[1]) : null,
    ws: ws ? Number(ws[1]) : null,
  };
}

function scan() {
  if (!fs.existsSync(DIR)) {
    console.error('[ports] no archived suites at ' + DIR);
    process.exit(2);
  }
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.py')).sort();
  const byHttp = new Map();
  const byWs = new Map();
  const suites = [];
  for (const f of files) {
    const { http, ws } = readPair(path.join(DIR, f));
    if (http == null && ws == null) continue;
    suites.push({ file: f, http, ws, dynamic: /os\.environ\.get\(\s*['"]MT5_HTTP_PORT/.test(fs.readFileSync(path.join(DIR, f), 'utf8')) });
    if (http != null) {
      if (!byHttp.has(http)) byHttp.set(http, []);
      byHttp.get(http).push(f);
    }
    if (ws != null) {
      if (!byWs.has(ws)) byWs.set(ws, []);
      byWs.get(ws).push(f);
    }
  }
  const dupes = (m) => [...m.entries()].filter(([, v]) => v.length > 1).sort((a, b) => a[0] - b[0]);
  return {
    total: files.length,
    tagged: suites.length,
    byHttp,
    byWs,
    httpDupes: dupes(byHttp),
    wsDupes: dupes(byWs),
    suites,
  };
}

/**
 * A duplicate only breaks sharding when BOTH suites could run at once. Suites
 * whose ports come from the environment are safe by construction. The curated
 * gate runs serially today, so the report is advisory; `--strict` turns every
 * duplicate into a failure for the day sharding lands.
 */
function freePair(report) {
  const usedHttp = new Set([...report.byHttp.keys()].map(Number));
  const usedWs = new Set([...report.byWs.keys()].map(Number));
  let http = null, ws = null;
  for (let p = HTTP_FLOOR; p <= HTTP_CEIL; p++) {
    if (!usedHttp.has(p) && !RESERVED.has(p)) { http = p; break; }
  }
  for (let p = WS_FLOOR; p <= WS_CEIL; p++) {
    if (!usedWs.has(p) && !RESERVED.has(p)) { ws = p; break; }
  }
  return { http, ws };
}

function main(argv) {
  const report = scan();
  const maxHttp = Math.max(...[...report.byHttp.keys()].map(Number));
  const maxWs = Math.max(...[...report.byWs.keys()].map(Number));

  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      total: report.total,
      tagged: report.tagged,
      maxHttp,
      maxWs,
      httpDuplicates: report.httpDupes.map(([port, files]) => ({ port, files })),
      wsDuplicates: report.wsDupes.map(([port, files]) => ({ port, count: files.length })),
      free: freePair(report),
    }, null, 2));
    return 0;
  }

  if (argv.includes('--free')) {
    const { http, ws } = freePair(report);
    if (http == null || ws == null) {
      console.error('[ports] the documented ranges are full — widen them in docs/ROADMAP-PANELS.md §1.3');
      return 1;
    }
    console.log(`PORT_HTTP, PORT_WS = ${http}, ${ws}`);
    return 0;
  }

  console.log(`[ports] ${report.tagged}/${report.total} suites declare a port`);
  console.log(`[ports] highest in use: HTTP ${maxHttp}, WS ${maxWs}`);
  if (report.httpDupes.length) {
    console.log(`[ports] ${report.httpDupes.length} HTTP port(s) shared:`);
    for (const [port, files] of report.httpDupes) {
      console.log(`  ${port}  <- ${files.length} suite(s)`);
    }
  }
  if (report.wsDupes.length) {
    const shared = report.wsDupes.reduce((a, [, v]) => a + v.length, 0);
    console.log(`[ports] ${report.wsDupes.length} WS port(s) shared by ${shared} suites`);
  }
  const { http: fh, ws: fw } = freePair(report);
  console.log(`[ports] next free pair: HTTP ${fh}, WS ${fw}`);

  if (argv.includes('--strict') && (report.httpDupes.length || report.wsDupes.length)) {
    console.error('[ports] --strict: shared ports are not shard-safe');
    return 1;
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
