/**
 * Drawing tools batch 2 — analysis concern.
 *
 * Moved verbatim out of drawing/tools2.js in F4.3; the module registers the
 * same tools on the shared TOOLS registry (no logic changes).
 *
 * @module drawing/tools2/analysis
 */
import { U } from '../../core/util.js';
import { icon } from '../../ui/icons.js';
import { Theme } from '../../core/theme.js';
import { App } from '../../../../core/state.js';
import { TOOLS, segWithExtend } from '../tools.js';
import { applyStroke, chipLabel, distToPath, drawAnnotation, fillAlphaOf, fillColorOf, insidePoly, normRect, polyPts, ptXY } from './common.js';
import { dayStartOf } from '../../../../core/session-math.js';

  function TH(k, fallback) { return (Theme.c) ? Theme.c(k) : fallback; }

  /* ---------------- Regression Trend ---------------- */
  function regress(bars, times, t0, t1, src) {
    /* LSQ over the chosen source (TV Source row; default close) */
    const yOf = src === 'hlc3' ? (b) => (b.high + b.low + b.close) / 3
      : src === 'hl2' ? (b) => (b.high + b.low) / 2
      : src === 'ohlc4' ? (b) => (b.open + b.high + b.low + b.close) / 4
      : (b) => b.close;
    const i0 = Math.max(0, Math.floor(U.timeToLogical(times, Math.min(t0, t1))));
    const i1 = Math.min(bars.length - 1, Math.ceil(U.timeToLogical(times, Math.max(t0, t1))));
    const n = i1 - i0 + 1;
    if (n < 3) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = i0; i <= i1; i++) {
      const x = i, y = yOf(bars[i]);
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    const denom = n * sxx - sx * sx;
    if (!denom) return null;
    const slope = (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    let varSum = 0;
    for (let i = i0; i <= i1; i++) varSum += Math.pow(yOf(bars[i]) - (intercept + slope * i), 2);
    const sd = Math.sqrt(varSum / n);
    return { i0, i1, slope, intercept, sd };
  }
  /* ROUND247: painted spans shared by draw + hit — the base direction in
     pixels with true parallel bands (offset along the pixel normal). Extend
     runs the full viewport span (the old code clamped the index to the edge
     bars, drawing a stub). Fractional indexes ride logicalToTime, which
     extrapolates past the history by bar spacing. */
  function regressSegs(v, d) {
    const r = regress(v.bars, v.times, d.points[0].t, d.points[1].t, d.opts.source);
    if (!r) return null;
    const devs = Array.isArray(d.opts.devs) ? d.opts.devs : [1, 2, 3];
    /* ROUND255 (TV parity): upper/lower bands toggle independently (both on
       for existing drawings). */
    const upOn = d.opts.upShow !== false, dnOn = d.opts.downShow !== false;
    const extend = !!d.opts.extend;
    const Xf = (i) => v.xOf(U.logicalToTime(v.times, i));
    const Y = (i, k) => v.yOf(r.intercept + r.slope * i + k * r.sd);
    const A = [Xf(r.i0), Y(r.i0, 0)], B = [Xf(r.i1), Y(r.i1, 0)];
    const dx = B[0] - A[0], dy = B[1] - A[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    const sdPx = Math.abs(v.yOf(r.intercept) - v.yOf(r.intercept + r.sd));
    const T = (v.w + v.h) * 3;
    const band = (k) => {
      const ox = nx * k * sdPx, oy = ny * k * sdPx;
      const sx = extend ? A[0] + ox - ux * T : A[0] + ox;
      const sy = extend ? A[1] + oy - uy * T : A[1] + oy;
      const ex = extend ? B[0] + ox + ux * T : B[0] + ox;
      const ey = extend ? B[1] + oy + uy * T : B[1] + oy;
      return U.clipLine(sx, sy, ex, ey, v.pw, v.ph) || [sx, sy, ex, ey];
    };
    const segs = [{ k: 0, seg: band(0) }];
    for (const k of devs) {
      if (!isFinite(k) || k === 0) continue;
      if (upOn) segs.push({ k, seg: band(k) });
      if (dnOn) segs.push({ k: -k, seg: band(-k) });
    }
    const ks = segs.map((s) => s.k);
    return { segs, kmax: ks.length ? Math.max(...ks.map((k) => Math.abs(k))) : 0,
      up: upOn, dn: dnOn,
      upColor: d.opts.upColor || null, dnColor: d.opts.downColor || null };
  }
  TOOLS.regression = {
    name: 'Regression Trend', icon: 'regression', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const rs = regressSegs(v, d);
      if (!rs) return;
      ctx.save();
      applyStroke(ctx, d);
      /* round 52: TV Background fill between the OUTER deviation bands
         (default off — existing drawings render unchanged) */
      if (d.opts.fill && rs.kmax > 0) {
        const top = rs.segs.find((s) => s.k === rs.kmax), bot = rs.segs.find((s) => s.k === -rs.kmax);
        if (top && bot) {
          ctx.save();
          ctx.globalAlpha = fillAlphaOf(d);
          ctx.fillStyle = fillColorOf(d);
          ctx.beginPath();
          ctx.moveTo(top.seg[0], top.seg[1]); ctx.lineTo(top.seg[2], top.seg[3]);
          ctx.lineTo(bot.seg[2], bot.seg[3]); ctx.lineTo(bot.seg[0], bot.seg[1]);
          ctx.closePath(); ctx.fill();
          ctx.restore();
        }
      }
      for (const { k, seg } of rs.segs) {
        if (k !== 0) {
          /* ROUND255 (TV parity): upper/lower bands carry their own colors
             (fall back to the base line when unset). */
          ctx.globalAlpha = 0.65;
          ctx.lineWidth = 1;
          ctx.strokeStyle = (k > 0 ? (rs.upColor || d.opts.color) : (rs.dnColor || d.opts.color)) || '#2962ff';
        }
        ctx.beginPath();
        ctx.moveTo(seg[0], seg[1]);
        ctx.lineTo(seg[2], seg[3]);
        ctx.stroke();
        if (k !== 0) {
          ctx.globalAlpha = 1;
          applyStroke(ctx, d);
        }
      }
      ctx.restore();
      drawAnnotation(v, d, v.xOf(d.points[0].t), v.yOf(d.points[0].p) - 16);
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        /* ROUND247: every painted band is grabbable (the old test only knew
           the anchor segment). */
        const rs = regressSegs(v, d);
        if (!rs) return false;
        const m = Math.max(6, 3 + (d.opts.width || 2));
        for (const { seg } of rs.segs) {
          if (U.distSeg(x, y, seg[0], seg[1], seg[2], seg[3]) < m) return true;
        }
        /* ROUND258: Background fills the area between the outer bands. */
        if (d.opts.fill && rs.kmax > 0) {
          const top = rs.segs.find((s) => s.k === rs.kmax);
          const bot = rs.segs.find((s) => s.k === -rs.kmax);
          if (top && bot && insidePoly(x, y, [
            [top.seg[0], top.seg[1]], [top.seg[2], top.seg[3]],
            [bot.seg[2], bot.seg[3]], [bot.seg[0], bot.seg[1]],
          ])) return true;
        }
        return false;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ================= ROUND289: shared volume-profile engine =================
     Both volume profiles painted their own copy of the same histogram code, so
     every new option had to be added twice (and twice as easily forgotten).
     One engine now owns the range resolution, the row build, POC/Value Area
     and the painting; the two tools only decide WHICH bars to feed it.

     `mode` mirrors TV's profile scopes:
       fixed    – the two anchor points (Fixed range profile)
       session  – bars belonging to the anchor bar's trading day
       visible  – the bars currently on screen
       anchor   – from the anchor to the newest bar (Anchored profile)      */
  function profileRange(v, d, mode) {
    const bars = v.bars || [];
    const n = bars.length;
    if (n < 4) return null;
    const idxOf = (t) => U.timeToLogical(v.times, t);
    let i0 = 0, i1 = n - 1;
    if (mode === 'fixed') {
      const a = Math.floor(idxOf(Math.min(d.points[0].t, d.points[1].t)));
      const b = Math.ceil(idxOf(Math.max(d.points[0].t, d.points[1].t)));
      i0 = Math.max(0, a); i1 = Math.min(n - 1, b);
    } else if (mode === 'anchor') {
      i0 = Math.max(0, Math.round(idxOf(d.points[0].t)));
      i1 = n - 1;
    } else if (mode === 'session') {
      /* the trading day that contains the anchor (or the newer anchor) */
      const anchorT = mode === 'session' && d.points[1] ? Math.min(d.points[0].t, d.points[1].t) : d.points[0].t;
      const aIdx = U.clamp(Math.round(idxOf(anchorT)), 0, n - 1);
      const dayOf = (t) => dayStartOf(t + (v.serverOffSec || 0));
      const day = dayOf(bars[aIdx].time);
      i0 = aIdx; i1 = aIdx;
      while (i0 > 0 && dayOf(bars[i0 - 1].time) === day) i0--;
      while (i1 < n - 1 && dayOf(bars[i1 + 1].time) === day) i1++;
    } else if (mode === 'visible') {
      /* logical range -> bar indices; the manager exposes it through v */
      let from = v.visibleFrom, to = v.visibleTo;
      if (from == null || to == null) {
        try {
          const lr = v.chart && v.chart.timeScale().getVisibleLogicalRange();
          if (lr) { from = lr.from; to = lr.to; }
        } catch (e) { /* fall through to the whole range */ }
      }
      if (from == null || to == null) { i0 = 0; i1 = n - 1; }
      else {
        i0 = U.clamp(Math.floor(from), 0, n - 1);
        i1 = U.clamp(Math.ceil(to), 0, n - 1);
      }
    }
    if (i1 - i0 < 2) return null;
    return { i0, i1, bars };
  }

  /* build the histogram rows for [i0..i1] */
  function profileRows(v, d, range) {
    const { i0, i1, bars } = range;
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) { lo = Math.min(lo, bars[i].low); hi = Math.max(hi, bars[i].high); }
    if (!(hi > lo)) return null;
    const NB = U.clamp(Math.round(d.opts.bins || 24), 6, 120);
    const step = (hi - lo) / NB;
    const bins = new Array(NB).fill(0);
    let maxV = 0, totV = 0;
    for (let i = i0; i <= i1; i++) {
      const b = bars[i];
      const vol = (b.volume != null && b.volume > 0) ? b.volume : 1; // fallback: bar count weight
      const mid = (b.high + b.low) / 2;
      const bi = U.clamp(Math.floor((mid - lo) / step), 0, NB - 1);
      bins[bi] += vol; totV += vol;
      maxV = Math.max(maxV, bins[bi]);
    }
    if (!maxV) return null;
    return { NB, step, bins, maxV, totV, lo, hi };
  }

  /* POC + Value Area from the rows */
  function profilePocVa(d, prof) {
    const { NB, bins, totV } = prof;
    let poc = 0;
    for (let i = 1; i < NB; i++) if (bins[i] > bins[poc]) poc = i;
    const vaPct = U.clamp(d.opts.vaPct == null ? 70 : Number(d.opts.vaPct), 1, 100) / 100;
    let acc = bins[poc], a = poc, b2 = poc;
    while (acc < totV * vaPct && (a > 0 || b2 < NB - 1)) {
      const va = a > 0 ? bins[a - 1] : -1;
      const vb = b2 < NB - 1 ? bins[b2 + 1] : -1;
      if (vb >= va) { b2++; acc += Math.max(0, vb); } else { a--; acc += Math.max(0, va); }
    }
    return { poc, vaLo: a, vaHi: b2 };
  }

  /* paint one profile and return its POC price (for the chip) */
  function paintProfile(v, d, prof, va, baseX, maxW, digits) {
    const ctx = v.ctx;
    const { NB, step, bins, maxV, lo } = prof;
    const { poc, vaLo, vaHi } = va;
    const profCol = d.opts.color || '#2962ff';
    const pocCol = d.opts.pocColor || '#f7c948';
    const showPoc = d.opts.showPoc !== false;
    const showVa = d.opts.showVa !== false;
    const width = U.clamp(Number(d.opts.width) || 1, 1, 8);
    ctx.save();
    for (let i = 0; i < NB; i++) {
      if (!bins[i]) continue;
      const y1 = v.yOf(lo + i * step), y2 = v.yOf(lo + (i + 1) * step);
      const w = (bins[i] / maxV) * maxW;
      const inVa = i >= vaLo && i <= vaHi;
      ctx.globalAlpha = showVa && inVa ? 0.55 : 0.28;
      ctx.fillStyle = (showPoc && bins[i] === bins[poc]) ? pocCol : profCol;
      ctx.fillRect(baseX, Math.min(y1, y2), w, Math.max(width, Math.abs(y2 - y1) - 1));
    }
    ctx.globalAlpha = 1;
    if (showVa) {
      ctx.strokeStyle = profCol;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      for (const edge of [lo + vaLo * step, lo + (vaHi + 1) * step]) {
        const yv = v.yOf(edge);
        if (yv == null) continue;
        ctx.beginPath(); ctx.moveTo(baseX, yv); ctx.lineTo(baseX + maxW, yv); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    if (showPoc) {
      chipLabel(ctx, baseX + 24, v.yOf(lo + (poc + 0.5) * step),
        `POC ${U.fmtPrice(lo + (poc + 0.5) * step, digits)}`, 'rgba(24,28,39,.92)');
    }
    return lo + (poc + 0.5) * step;
  }

  /* one call for both tools */
  function drawProfile(v, d, mode, baseX, maxW) {
    const range = profileRange(v, d, mode);
    if (!range) return null;
    const prof = profileRows(v, d, range);
    if (!prof) return null;
    const va = profilePocVa(d, prof);
    paintProfile(v, d, prof, va, baseX, maxW, v.digits);
    return { range, prof, va };
  }

  /* ---------------- Volume Profile (fixed range) — ROUND 62: TV name ---------------- */
  TOOLS.volprofile = {
    name: 'Fixed range volume profile', icon: 'fixedvp', pts: 2,
    draw(v, d) {
      const bars = v.bars;
      if (!bars || bars.length < 4) return;
      const x0 = v.xOf(d.points[0].t), x1 = v.xOf(d.points[1].t);
      const baseX = Math.min(x0, x1);
      const maxW = Math.max(30, Math.abs(x1 - x0) * 0.5);
      /* ROUND289 (TV parity): the profile SCOPE is a setting — fixed range
         (the two anchors), the anchor's trading session, or the visible bars.
         All three share one engine, so POC/Value Area behave identically. */
      const mode = d.opts.scope === 'session' ? 'session'
        : d.opts.scope === 'visible' ? 'visible' : 'fixed';
      drawProfile(v, d, mode, baseX, maxW);
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        /* ROUND258: the painted histogram is a fixed time range but derives
           its price span from the bars inside it. The old endpoint box missed
           the profile whenever the anchors were not placed at its top/bottom. */
        const bars = v.bars;
        if (!bars || bars.length < 4) return false;
        const i0 = Math.max(0, Math.floor(U.timeToLogical(v.times, Math.min(d.points[0].t, d.points[1].t))));
        const i1 = Math.min(bars.length - 1, Math.ceil(U.timeToLogical(v.times, Math.max(d.points[0].t, d.points[1].t))));
        if (i1 - i0 < 2) return false;
        let lo = Infinity, hi = -Infinity;
        for (let i = i0; i <= i1; i++) {
          lo = Math.min(lo, bars[i].low); hi = Math.max(hi, bars[i].high);
        }
        if (!(hi > lo)) return false;
        const x0 = v.xOf(d.points[0].t), x1 = v.xOf(d.points[1].t);
        const baseX = Math.min(x0, x1);
        const maxW = Math.max(30, Math.abs(x1 - x0) * 0.5);
        return x >= baseX - 6 && x <= baseX + maxW + 40 &&
               y >= Math.min(v.yOf(lo), v.yOf(hi)) - 6 &&
               y <= Math.max(v.yOf(lo), v.yOf(hi)) + 6;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ================= ROUND 62: TV Forecasting & Measurement additions =================
     Researched per tool (TV behaviour) and implemented on the same contract:
     - Position forecast  (2 pts): entry A -> forecast target B; stop derived
       from the Risk/Reward coefficient; profit/loss boxes + % chips.
     - Bars pattern       (3 pts): the REAL close path of the bars between
       anchors A..B is copied and projected from anchor C (Mirror setting).
     - Ghost feed         (1 pt) : projects N translucent continuation candles
       from the anchor using the LSQ slope + average range of recent bars.
     - Sector             (3 pts): circular sector around anchor A; B sets
       radius + start angle, C the end angle (pixel-space wedge, TV look).
     - Anchored VWAP      (1 pt) : cumulative hlc3 VWAP from the anchor bar to
       the newest bar, recalculated every frame (works on live ticks).
     - Anchored volume profile (1 pt): the fixed-range histogram, anchored at
       one point and extending to the latest bar.
     - Price range / Date range / Date and price range (2 pts each): TV
       measurers — delta chips for price (+%), time span (+ bars) or both. */

  /* ---------------- Position forecast ---------------- */
  TOOLS.posforecast = {
    name: 'Position forecast', icon: 'posforecast', pts: 2,
    /* ROUND289 (TV parity): TV gives the position forecast a separate grip for
       each of its three levels, so the stop can be placed where the trade
       ACTUALLY risks out instead of only at coeff-many R. A dragged stop is
       stored absolutely in `opts.stop` and the Risk/Reward coefficient is
       rewritten from the new geometry, so the two controls never disagree. */
    _stop(v, d) {
      const [a, b] = d.points;
      if (d.opts.stop != null && isFinite(d.opts.stop)) return Number(d.opts.stop);
      const rr = Number(d.opts.coeff) > 0 ? Number(d.opts.coeff) : 2;
      return a.p - (b.p - a.p) / rr;
    },
    _xSpan(v, d) {
      const x0 = v.xOf(d.points[0].t), x1 = v.xOf(d.points[1].t);
      return { xa: Math.min(x0, x1), xb: Math.max(x0, x1) };
    },
    draw(v, d) {
      const ctx = v.ctx;
      const [a, b] = d.points;
      const dp = b.p - a.p;
      const stop = TOOLS.posforecast._stop(v, d);
      const { xa, xb } = TOOLS.posforecast._xSpan(v, d);
      const yA = v.yOf(a.p), yB = v.yOf(b.p), yS = v.yOf(stop);
      /* ROUND285 (TV parity): TV's position forecast exposes a colour per zone
         (profit / loss) and an entry line. They were hard-coded greens/reds.
         `color` still tints the entry line so the existing Line row matters. */
      const win = d.opts.profitColor || (dp >= 0 ? '#089981' : '#f23645');
      const loss = d.opts.lossColor || (dp >= 0 ? '#f23645' : '#089981');
      const box = (ya, yb, col) => {
        ctx.save();
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = col;
        ctx.fillRect(xa, Math.min(ya, yb), Math.max(1, xb - xa), Math.abs(yb - ya));
        ctx.globalAlpha = 1;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.strokeRect(xa, Math.min(ya, yb), Math.max(1, xb - xa), Math.abs(yb - ya));
        ctx.restore();
      };
      box(yA, yB, win);
      box(yA, yS, loss);
      /* entry line (TV draws it solid in the tool colour) */
      if (d.opts.showEntry !== false) {
        ctx.save();
        ctx.strokeStyle = d.opts.color || '#2962ff';
        ctx.lineWidth = Math.max(1, d.opts.width || 1);
        ctx.beginPath(); ctx.moveTo(xa, yA); ctx.lineTo(xb, yA); ctx.stroke();
        ctx.restore();
      }
      const pct = (dp / a.p) * 100, pctS = ((stop - a.p) / a.p) * 100;
      chipLabel(ctx, (xa + xb) / 2, (yA + yB) / 2, `Target ${dp >= 0 ? '+' : ''}${pct.toFixed(2)}%`, 'rgba(8,153,129,.92)');
      chipLabel(ctx, (xa + xb) / 2, (yA + yS) / 2, `Stop ${pctS.toFixed(2)}%`, 'rgba(242,54,69,.92)');
    },
    handles(v, d) {
      /* three level grips, one at each end of every line: entry, target, stop */
      const { xa, xb } = TOOLS.posforecast._xSpan(v, d);
      const [a, b] = d.points;
      const stop = TOOLS.posforecast._stop(v, d);
      return [
        [xa, v.yOf(a.p)], [xb, v.yOf(a.p)],
        [xa, v.yOf(b.p)], [xb, v.yOf(b.p)],
        [xa, v.yOf(stop)], [xb, v.yOf(stop)],
      ];
    },
    dragHandle(v, d, i, pt) {
      const [a, b] = d.points;
      const grip = Math.floor(i / 2);           // 0 entry, 1 target, 2 stop
      /* even index = the LEFT end of that level (moves the left time),
         odd index = the RIGHT end (moves the right time) */
      if (i % 2 === 0) d.points[0].t = pt.t;
      else d.points[1].t = pt.t;
      if (grip === 0) d.points[0].p = pt.p;
      else if (grip === 1) d.points[1].p = pt.p;
      else {
        d.opts.stop = pt.p;
        /* keep the coefficient honest: it now describes the dragged geometry */
        const risk = a.p - pt.p, reward = b.p - a.p;
        if (Math.abs(risk) > 1e-12) {
          const rr = reward / risk;
          if (rr > 0 && isFinite(rr)) d.opts.coeff = String(Math.round(rr * 100) / 100);
        }
      }
    },
    /* ROUND289: the dragged stop lives in opts (not points), so a body move
       must carry it — otherwise dragging the box would silently re-derive the
       stop from the coefficient and jump the level. */
    bodyDragState(d) { return { stop: d.opts.stop }; },
    onBodyDrag(d, dp, st) {
      if (st && st.stop != null && isFinite(st.stop)) d.opts.stop = st.stop + dp;
    },
    hitBody(v, d) {
      return (x, y) => {
        const { xa, xb } = TOOLS.posforecast._xSpan(v, d);
        const [a, b] = d.points;
        const stop = TOOLS.posforecast._stop(v, d);
        const ys = [v.yOf(a.p), v.yOf(b.p), v.yOf(stop)];
        return x >= xa - 5 && x <= xb + 5 && y >= Math.min(...ys) - 5 && y <= Math.max(...ys) + 5;
      };
    },
  };

  /* ---------------- Bars pattern ---------------- */
  TOOLS.barspattern = {
    name: 'Bars pattern', icon: 'barspattern', pts: 3,
    draw(v, d) {
      const bars = v.bars;
      if (!bars || bars.length < 4) return;
      const ctx = v.ctx;
      const [A, B, C] = d.points;
      const i0 = Math.max(0, Math.round(U.timeToLogical(v.times, Math.min(A.t, B.t))));
      const i1 = Math.min(bars.length - 1, Math.round(U.timeToLogical(v.times, Math.max(A.t, B.t))));
      if (i1 - i0 < 1) return;
      const src = [];
      for (let i = i0; i <= i1; i++) src.push(bars[i].close);
      if (d.opts.mirror) src.reverse();
      const sp = (v.spacing > 0 ? v.spacing : 8);
      const xC = v.xOf(C.t), yC = v.yOf(C.p), base = src[0];
      const P = src.map((c, k) => [xC + k * sp, yC + (v.yOf(C.p + (c - base)) - yC)]);
      ctx.save();
      if (d.opts.fill) {
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = fillColorOf(d);
        ctx.beginPath();
        ctx.moveTo(P[0][0], P[0][1]);
        for (let k = 1; k < P.length; k++) ctx.lineTo(P[k][0], P[k][1]);
        ctx.lineTo(P[P.length - 1][0], yC); ctx.lineTo(P[0][0], yC);
        ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;
      }
      applyStroke(ctx, d);
      ctx.beginPath();
      ctx.moveTo(P[0][0], P[0][1]);
      for (let k = 1; k < P.length; k++) ctx.lineTo(P[k][0], P[k][1]);
      ctx.stroke();
      ctx.restore();
      if (d.opts.showLabel !== false) {
        chipLabel(ctx, P[0][0], P[0][1] - 14, `${src.length} bars${d.opts.mirror ? ' - mirrored' : ''}`, 'rgba(24,28,39,.92)');
      }
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const bars = v.bars;
        if (!bars || bars.length < 4) return false;
        const [A, B, C] = d.points;
        const i0 = Math.max(0, Math.round(U.timeToLogical(v.times, Math.min(A.t, B.t))));
        const i1 = Math.min(bars.length - 1, Math.round(U.timeToLogical(v.times, Math.max(A.t, B.t))));
        if (i1 - i0 < 1) return false;
        const src = [];
        for (let i = i0; i <= i1; i++) src.push(bars[i].close);
        if (d.opts.mirror) src.reverse();
        const sp = (v.spacing > 0 ? v.spacing : 8);
        const xC = v.xOf(C.t), yC = v.yOf(C.p), base = src[0];
        const P = src.map((c, k) => [xC + k * sp, yC + (v.yOf(C.p + (c - base)) - yC)]);
        if (distToPath(x, y, P, 8)) return true;
        if (!d.opts.fill || P.length < 2) return false;
        return insidePoly(x, y, P.concat([[P[P.length - 1][0], yC], [P[0][0], yC]]));
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Ghost feed ---------------- */
  TOOLS.ghostfeed = {
    name: 'Ghost feed', icon: 'ghostfeed', pts: 1,
    draw(v, d) {
      const bars = v.bars;
      if (!bars || bars.length < 10) return;
      const ctx = v.ctx;
      const N = U.clamp(Math.round(d.opts.bars || 20), 1, 300);
      const look = Math.min(bars.length, 20);
      const s0 = bars.length - look;
      let sx = 0, sy = 0, sxx = 0, sxy = 0, rng = 0;
      for (let i = s0; i < bars.length; i++) {
        const y = bars[i].close;
        sx += i; sy += y; sxx += i * i; sxy += i * y;
        rng += bars[i].high - bars[i].low;
      }
      const den = look * sxx - sx * sx;
      const slope = den ? (look * sxy - sx * sy) / den : 0;
      const avgR = rng / look || 0;
      /* ROUND289 (TV parity): a ghost feed is a REGRESSION projection, so it
         should show the uncertainty around that line. TV draws a widening
         band; the honest width is the regression's residual standard error,
         which we compute from the same sample (no invented constant). */
      const meanX = sx / look, meanY = sy / look;
      const icept = meanY - slope * meanX;
      let sse = 0;
      for (let i = s0; i < bars.length; i++) {
        const fit = icept + slope * i;
        const d0 = bars[i].close - fit;
        sse += d0 * d0;
      }
      const resid = look > 2 ? Math.sqrt(sse / (look - 2)) : 0;
      /* `0` is a MEANINGFUL value here (hide the band), so it must not fall
         through the `||` default the way a missing option does. */
      const bandK = d.opts.band == null ? 1 : U.clamp(Number(d.opts.band), 0, 3);
      const x0 = v.xOf(d.points[0].t);
      const sp = (v.spacing > 0 ? v.spacing : 8);
      const w = Math.max(1.5, sp * 0.62);
      /* ROUND285 (TV parity): the ghost candles used to be hard-coded 0.5 alpha
         with fixed green/red. TV exposes an opacity plus the two colours. */
      const ghostAlpha = U.clamp(
        d.opts.fillOpacity != null ? Number(d.opts.fillOpacity) : 0.5, 0.05, 1);
      const upCol = d.opts.color || '#089981';
      const downCol = d.opts.color2 || '#f23645';
      ctx.save();
      /* the widening projection band (drawn UNDER the candles) */
      if (bandK > 0 && resid > 0) {
        const ptsUp = [], ptsDn = [];
        for (let k = 0; k < N; k++) {
          /* uncertainty grows with the distance from the sample's centre */
          const radius = resid * bandK * Math.sqrt(1 + (k / Math.max(1, N - 1)));
          const proj = (d.points[0].p + slope * k);
          const x = x0 + k * sp;
          ptsUp.push([x, v.yOf(proj + radius)]);
          ptsDn.push([x, v.yOf(proj - radius)]);
        }
        ctx.globalAlpha = ghostAlpha * 0.35;
        ctx.fillStyle = d.opts.bandColor || '#2962ff';
        ctx.beginPath();
        ctx.moveTo(ptsUp[0][0], ptsUp[0][1]);
        for (const p of ptsUp) ctx.lineTo(p[0], p[1]);
        for (let k = ptsDn.length - 1; k >= 0; k--) ctx.lineTo(ptsDn[k][0], ptsDn[k][1]);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = ghostAlpha;
      }
      let open = d.points[0].p;
      for (let k = 0; k < N; k++) {
        const close = open + slope;
        const hi = Math.max(open, close) + avgR * 0.35;
        const lo = Math.min(open, close) - avgR * 0.35;
        const x = x0 + k * sp;
        const yO = v.yOf(open), yC = v.yOf(close), yH = v.yOf(hi), yL = v.yOf(lo);
        ctx.strokeStyle = ctx.fillStyle = close >= open ? upCol : downCol;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
        ctx.fillRect(x - w / 2, Math.min(yO, yC), w, Math.max(1, Math.abs(yC - yO)));
        open = close;
      }
      ctx.restore();
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const bars = v.bars;
        if (!bars || bars.length < 10) return false;
        const N = U.clamp(Math.round(d.opts.bars || 20), 1, 300);
        const look = Math.min(bars.length, 20);
        const s0 = bars.length - look;
        let sx = 0, sy = 0, sxx = 0, sxy = 0, rng = 0;
        for (let i = s0; i < bars.length; i++) {
          const c = bars[i].close;
          sx += i; sy += c; sxx += i * i; sxy += i * c;
          rng += bars[i].high - bars[i].low;
        }
        const den = look * sxx - sx * sx;
        const slope = den ? (look * sxy - sx * sy) / den : 0;
        const avgR = rng / look || 0;
        /* ROUND258: the projected candles often travel far beyond the old
           fixed 160px band around the anchor. Derive the painted y-range from
           the same LSQ projection the renderer uses. */
        let open = d.points[0].p, yMin = v.yOf(open), yMax = yMin;
        for (let k = 0; k < N; k++) {
          const close = open + slope;
          const hi = Math.max(open, close) + avgR * 0.35;
          const lo = Math.min(open, close) - avgR * 0.35;
          yMin = Math.min(yMin, v.yOf(hi), v.yOf(lo));
          yMax = Math.max(yMax, v.yOf(hi), v.yOf(lo));
          open = close;
        }
        const px = v.xOf(d.points[0].t);
        const sp = (v.spacing > 0 ? v.spacing : 8);
        return x > px - 6 && x < px + N * sp + 6 && y >= yMin - 6 && y <= yMax + 6;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Sector ---------------- */
  TOOLS.sector = {
    name: 'Sector', icon: 'sector', pts: 3,
    draw(v, d) {
      const ctx = v.ctx;
      const [A, B, C] = polyPts(v, d);
      const r = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (!(r > 2)) return;
      let a0 = Math.atan2(B[1] - A[1], B[0] - A[0]);
      let a1 = Math.atan2(C[1] - A[1], C[0] - A[0]);
      let sweep = a1 - a0;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(A[0], A[1]);
      ctx.arc(A[0], A[1], r, a0, a0 + sweep, sweep < 0);
      ctx.closePath();
      if (d.opts.fill !== false) {
        ctx.globalAlpha = fillAlphaOf(d);
        ctx.fillStyle = fillColorOf(d);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      applyStroke(ctx, d);
      ctx.stroke();
      ctx.restore();
      /* ROUND289 (TV parity): TV's sector shows the two radii as guide lines
         with the price they reach, so the wedge can be read off the scale. The
         chips are placed at the B and C ends (outward from the centre) and stay
         inside the pane. */
      if (d.opts.showRadii !== false) {
        const guide = (P, col) => {
          ctx.save();
          ctx.strokeStyle = col;
          ctx.globalAlpha = 0.7;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(P[0], P[1]); ctx.stroke();
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
          ctx.restore();
          const pAt = v.pOf ? v.pOf(P[1]) : null;
          if (pAt == null || !isFinite(pAt)) return;
          const lx = U.clamp(P[0] + (P[0] >= A[0] ? 6 : -6), 22, Math.max(22, v.pw - 22));
          const ly = U.clamp(P[1] + (P[1] >= A[1] ? -10 : 10), 10, Math.max(10, v.ph - 10));
          chipLabel(ctx, lx, ly, U.fmtPrice(pAt, v.digits), 'rgba(24,28,39,.92)');
        };
        guide(B, d.opts.color || '#2962ff');
        guide(C, d.opts.color || '#2962ff');
      }
      /* ROUND285 (TV parity): the sector shows its sweep angle inside the
         wedge, and the radius can carry the price/time labels TV draws. */
      if (d.opts.showLabel !== false) {
        const deg = Math.abs(sweep) * 180 / Math.PI;
        const midA = a0 + sweep / 2;
        const lx = A[0] + Math.cos(midA) * (r * 0.62);
        const ly = A[1] + Math.sin(midA) * (r * 0.62);
        chipLabel(ctx, lx, ly, `${deg.toFixed(1)}°`, 'rgba(24,28,39,.92)');
      }
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const [A, B, C] = polyPts(v, d);
        const r = Math.hypot(B[0] - A[0], B[1] - A[1]);
        const dx = x - A[0], dy = y - A[1];
        const rr = Math.hypot(dx, dy);
        if (rr > r + 5) return false;
        if (rr < Math.max(2, r - 5)) {
          /* inside the pie: also accept when between the two radii */
        }
        const a = Math.atan2(dy, dx);
        let a0 = Math.atan2(B[1] - A[1], B[0] - A[0]);
        let sweep = Math.atan2(C[1] - A[1], C[0] - A[0]) - a0;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep < -Math.PI) sweep += 2 * Math.PI;
        let rel = a - a0;
        while (rel > Math.PI) rel -= 2 * Math.PI;
        while (rel < -Math.PI) rel += 2 * Math.PI;
        const lo = Math.min(0, sweep), hi = Math.max(0, sweep);
        const inSweep = rel >= lo - 0.05 && rel <= hi + 0.05;
        const onRadius = U.distSeg(x, y, A[0], A[1], B[0], B[1]) < 6 ||
                         U.distSeg(x, y, A[0], A[1], C[0], C[1]) < 6;
        /* ROUND258: when Background is off only the arc and the two radii
           are painted; don't let the invisible pie interior steal clicks. */
        if (d.opts.fill === false) return onRadius || (inSweep && Math.abs(rr - r) < 6);
        if (!inSweep) return onRadius;
        return true;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Anchored VWAP ---------------- */
  /* ROUND246: hit-testing rides the PAINTED line — the old code measured the
     single anchor point (distToPath over one point is always false), so the
     line was grabbable only by its handle. The painted polyline is cached per
     drawing (WeakMap: dies with the drawing, never persisted) and downsampled
     so hover stays cheap on deep histories. */
  const _vwapLines = new WeakMap();
  function _vwapDown(P) {
    if (P.length <= 600) return P;
    const stride = Math.ceil(P.length / 600), out = [];
    for (let i = 0; i < P.length; i += stride) out.push(P[i]);
    if (out[out.length - 1] !== P[P.length - 1]) out.push(P[P.length - 1]);
    return out;
  }
  TOOLS.avwap = {
    name: 'Anchored VWAP', icon: 'avwap', pts: 1,
    draw(v, d) {
      const bars = v.bars;
      if (!bars || bars.length < 2) return;
      const ctx = v.ctx;
      const i0 = Math.max(0, Math.round(U.timeToLogical(v.times, d.points[0].t)));
      if (i0 >= bars.length - 1) return;
      let pv = 0, vv = 0;
      const P = [];
      for (let i = i0; i < bars.length; i++) {
        const b = bars[i];
        const src = d.opts.source === 'close' ? b.close : (b.high + b.low + b.close) / 3;
        const vol = (b.volume != null && b.volume > 0) ? b.volume : 1;
        pv += src * vol; vv += vol;
        P.push([v.xOf(v.times[i]), v.yOf(pv / vv)]);
      }
      if (P.length < 2) return;
      _vwapLines.set(d, _vwapDown(P));
      ctx.save();
      applyStroke(ctx, d);
      ctx.beginPath();
      ctx.moveTo(P[0][0], P[0][1]);
      for (let k = 1; k < P.length; k++) ctx.lineTo(P[k][0], P[k][1]);
      ctx.stroke();
      ctx.restore();
      const last = P[P.length - 1];
      chipLabel(ctx, last[0] - 34, last[1] - 13, `VWAP ${U.fmtPrice(pv / vv, v.digits)}`, 'rgba(24,28,39,.92)');
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const line = _vwapLines.get(d);
        if (line && line.length > 1 && distToPath(x, y, line, Math.max(6, 3 + (d.opts.width || 2)))) return true;
        /* no painted line yet (or a 1-bar stub): the anchor is the fallback */
        const P = polyPts(v, d);
        return P.length === 1 && Math.hypot(x - P[0][0], y - P[0][1]) < 10;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Anchored volume profile ---------------- */
  TOOLS.avolprofile = {
    name: 'Anchored volume profile', icon: 'anchoredvp', pts: 1,
    draw(v, d) {
      const bars = v.bars;
      if (!bars || bars.length < 4) return;
      const baseX = v.xOf(d.points[0].t);
      const maxW = Math.max(30, Math.min(240, (v.pw - baseX) * 0.5));
      /* ROUND289: the anchored tool grows to the newest bar by default, but TV
         also offers "from the anchor's session" and "the visible bars". */
      const mode = d.opts.scope === 'session' ? 'session'
        : d.opts.scope === 'visible' ? 'visible' : 'anchor';
      drawProfile(v, d, mode, baseX, maxW);
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        /* ROUND258: match the painted profile, not a 260x140 guess around the
           anchor. The price span comes from the bars from the anchor to the
           newest one, and the bars grow to the right of the anchor. */
        const bars = v.bars;
        if (!bars || bars.length < 4) return false;
        const i0 = Math.max(0, Math.round(U.timeToLogical(v.times, d.points[0].t)));
        const i1 = bars.length - 1;
        if (i1 - i0 < 2) return false;
        let lo = Infinity, hi = -Infinity;
        for (let i = i0; i <= i1; i++) {
          lo = Math.min(lo, bars[i].low); hi = Math.max(hi, bars[i].high);
        }
        if (!(hi > lo)) return false;
        const baseX = v.xOf(d.points[0].t);
        const maxW = Math.max(30, Math.min(240, (v.pw - baseX) * 0.5));
        return x >= baseX - 6 && x <= baseX + maxW + 40 &&
               y >= Math.min(v.yOf(lo), v.yOf(hi)) - 6 &&
               y <= Math.max(v.yOf(lo), v.yOf(hi)) + 6;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

  /* ---------------- Measurers (TV) ---------------- */
  function measurerHit(v, d) {
    return (x, y) => {
      const n = normRect(d);
      const xL = v.xOf(n.tL), xR = v.xOf(n.tR), yT = v.yOf(n.pT), yB = v.yOf(n.pB);
      return x >= Math.min(xL, xR) - 5 && x <= Math.max(xL, xR) + 5 &&
             y >= Math.min(yT, yB) - 5 && y <= Math.max(yT, yB) + 5;
    };
  }
  TOOLS.pricerange = {
    name: 'Price range', icon: 'pricerange', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const n = normRect(d);
      const xL = v.xOf(n.tL), xR = v.xOf(n.tR), yT = v.yOf(n.pT), yB = v.yOf(n.pB);
      ctx.save();
      ctx.globalAlpha = fillAlphaOf(d) * 0.8;
      ctx.fillStyle = fillColorOf(d);
      ctx.fillRect(Math.min(xL, xR), Math.min(yT, yB), Math.max(1, Math.abs(xR - xL)), Math.max(1, Math.abs(yB - yT)));
      ctx.globalAlpha = 1;
      applyStroke(ctx, d);
      ctx.strokeRect(Math.min(xL, xR), Math.min(yT, yB), Math.max(1, Math.abs(xR - xL)), Math.max(1, Math.abs(yB - yT)));
      ctx.restore();
      if (d.opts.showLabel !== false) {
        const a = d.points[0], b = d.points[1];
        const dp = b.p - a.p;
        const pct = a.p ? (dp / a.p) * 100 : 0;
        const col = dp >= 0 ? '#089981' : '#f23645';
        chipLabel(ctx, (Math.min(xL, xR) + Math.max(xL, xR)) / 2, (yT + yB) / 2,
          `${dp >= 0 ? '+' : ''}${U.fmtPrice(dp, v.digits)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`, col);
      }
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) { return measurerHit(v, d); },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };
  TOOLS.daterange = {
    name: 'Date range', icon: 'daterange', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const n = normRect(d);
      const xL = v.xOf(n.tL), xR = v.xOf(n.tR);
      ctx.save();
      ctx.globalAlpha = fillAlphaOf(d) * 0.8;
      ctx.fillStyle = fillColorOf(d);
      ctx.fillRect(Math.min(xL, xR), 0, Math.max(1, Math.abs(xR - xL)), v.ph);
      ctx.globalAlpha = 1;
      applyStroke(ctx, d);
      ctx.strokeRect(Math.min(xL, xR), 0, Math.max(1, Math.abs(xR - xL)), v.ph);
      ctx.restore();
      if (d.opts.showLabel !== false) {
        const bars = Math.round(Math.abs(U.timeToLogical(v.times, d.points[1].t) - U.timeToLogical(v.times, d.points[0].t)));
        const dur = U.durHuman(Math.abs(d.points[1].t - d.points[0].t));
        chipLabel(ctx, (Math.min(xL, xR) + Math.max(xL, xR)) / 2, v.ph / 2,
          `${bars} bars · ${dur}`, TH('chipBg', 'rgba(24,28,39,.94)'));
      }
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) {
      return (x, y) => {
        const n = normRect(d);
        const xL = v.xOf(n.tL), xR = v.xOf(n.tR);
        return x >= Math.min(xL, xR) - 5 && x <= Math.max(xL, xR) + 5 && y >= 0 && y <= v.ph;
      };
    },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };
  TOOLS.datepricerange = {
    name: 'Date and price range', icon: 'datepricerange', pts: 2,
    draw(v, d) {
      const ctx = v.ctx;
      const n = normRect(d);
      const xL = v.xOf(n.tL), xR = v.xOf(n.tR), yT = v.yOf(n.pT), yB = v.yOf(n.pB);
      ctx.save();
      ctx.globalAlpha = fillAlphaOf(d) * 0.8;
      ctx.fillStyle = fillColorOf(d);
      ctx.fillRect(Math.min(xL, xR), Math.min(yT, yB), Math.max(1, Math.abs(xR - xL)), Math.max(1, Math.abs(yB - yT)));
      ctx.globalAlpha = 1;
      applyStroke(ctx, d);
      ctx.strokeRect(Math.min(xL, xR), Math.min(yT, yB), Math.max(1, Math.abs(xR - xL)), Math.max(1, Math.abs(yB - yT)));
      ctx.restore();
      if (d.opts.showLabel !== false) {
        const a = d.points[0], b = d.points[1];
        const dp = b.p - a.p;
        const pct = a.p ? (dp / a.p) * 100 : 0;
        const bars = Math.round(Math.abs(U.timeToLogical(v.times, b.t) - U.timeToLogical(v.times, a.t)));
        const dur = U.durHuman(Math.abs(b.t - a.t));
        chipLabel(ctx, (Math.min(xL, xR) + Math.max(xL, xR)) / 2, (yT + yB) / 2,
          `${dp >= 0 ? '+' : ''}${U.fmtPrice(dp, v.digits)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)  ·  ${bars} bars · ${dur}`,
          TH('chipBg', 'rgba(24,28,39,.94)'));
      }
    },
    handles(v, d) { return polyPts(v, d); },
    hitBody(v, d) { return measurerHit(v, d); },
    dragHandle(v, d, i, pt) { d.points[i] = { t: pt.t, p: pt.p }; },
  };

export { TH, regress, regressSegs, _vwapLines, _vwapDown, measurerHit };
