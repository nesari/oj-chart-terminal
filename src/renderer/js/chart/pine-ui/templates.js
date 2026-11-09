/**
 * Pine instance manager — templates concern.
 *
 * Moved verbatim out of chart/pine-ui.js in F4.3 (no logic changes).
 *
 * @module chart/pine-ui/templates
 */
import { U } from '../../core/util.js';
import { icon } from '../../ui/icons.js';
import { App } from '../../../../core/state.js';
import { Log } from '../../../../core/logger.js';
import { Manager } from '../manager.js';
import { compile } from '../../../../core/pine/compile.js';
import { toColor } from '../../../../core/pine/types.js';
import { drawingCensus } from '../../../../core/pine/stdlib/objects.js';
import { brokerStats, downsample, tradeMarkers } from '../../../../core/pine/stdlib/strategy.js';
import { buildHtfBars, remapOut, lowerWindowForChart } from '../../../../core/pine/mtf.js';
import { tfSeconds } from '../../../../core/pine/stdlib/request.js';
import { PineRenderAdapter } from '../pine-render-adapter.js';
import { PineScriptsStore } from '../../panels/pine-scripts-store.js';
import { compiledFor, fmtOff, state } from './data.js';
import { add, rebuild, remove } from './panel.js';
import { PLOT_STYLE_SET, applyInstanceStyle, effServerOffSec, hexStr, loadDefaultStyle, parseColorValue, rgbaStr, saveDefaultStyle, tfVisible } from './inputs.js';

/* ------------------------------ settings dialog ----------------------- */

function openSettingsDialog(pane, inst) {
  const st = state(pane, inst.id);
  const script = PineScriptsStore.get(inst.scriptId);
  if (!st || !script) return;
  const defs = (st.inputDefs && st.inputDefs.length) ? st.inputDefs : (() => {
    const ci = compiledFor(script).collectInputs({ tfSec: (App.tfById[pane.tf] || {}).sec || 60, symbol: pane.symbol, mintick: 0.00001 });
    if (ci.ok) { st.inputDefs = ci.inputs; return ci.inputs; }
    return [];
  })();
  const title = st.rt ? st.rt.meta.title : script.name;
  /* ROUND175: strategy identity — a 4th Properties tab (TV parity) holds
     the broker-emulator settings; plain indicators keep 3 tabs. */
  const isStratDlg = !!(st.rt && st.rt.meta && st.rt.meta.isStrategy);
  const stratDefaults = (st.rt && st.rt.meta && st.rt.meta.strategy) || {};
  const layer = document.getElementById('popup-layer');
  U.clear(layer);
  const back = U.el('div', 'dialog-backdrop', layer);
  const dlg = U.el('div', 'dialog ind-settings', back);
  /* ROUND 75 (BUG): the layer used to be un-hidden BEFORE the dialog body was
     built — any throw mid-build left an EMPTY dialog floating over a live
     backdrop that swallowed every click on the chart (the UI felt frozen
     until restart; BUG-74-D "U.escape is not a function" shipped exactly
     that way). Now everything is built while still hidden and the layer is
     revealed only after success; the catch path restores a clean hidden
     layer + removes the key handler, so a broken build can never lock the
     UI again — the error still reaches the global handler via re-throw. */
  const close = () => { layer.classList.add('hidden'); U.clear(layer); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  try {
    dlg.innerHTML = `<h3>${U.esc(title)} <span class="pine-dlg-src">(${U.esc(script.name)})</span>${isStratDlg ? ' <span class="pine-strat-tag">STRATEGY</span>' : ''}<button class="mini-btn dlg-x" title="Close">${icon('x')}</button></h3>
      <div class="pine-tabs"><button class="pine-tab on" data-tab="inputs">Inputs</button>${isStratDlg ? '<button class="pine-tab" data-tab="props">Properties</button>' : ''}<button class="pine-tab" data-tab="style">Style</button><button class="pine-tab" data-tab="vis">Visibility</button></div>
      <div class="ist-body pine-inputs"></div>
      ${isStratDlg ? '<div class="ist-body pine-props hidden"></div>' : ''}
      <div class="ist-body pine-style hidden"></div>
      <div class="ist-body pine-vis hidden"></div>
      <div class="dlg-actions">
        <button class="dlg-btn dlg-ghost ist-remove">Remove</button>
        <button class="dlg-btn dlg-ghost ist-defaults">Defaults</button>
        <span class="dlg-spacer"></span>
        <button class="dlg-btn dlg-primary ist-ok">Ok</button>
      </div>`;
    const body = dlg.querySelector('.pine-inputs');
    const propsBody = dlg.querySelector('.pine-props');
    const styleBody = dlg.querySelector('.pine-style');
    const visBody = dlg.querySelector('.pine-vis');
    /* ROUND143: TV tab switching (Inputs / Style / Visibility).
       ROUND143b: visibility rides the .hidden class, NEVER an inline
       style="display:none" — the round-81 CSP blocks inline style
       attributes (present in DOM, never applied), which stranded every
       tab's content in Inputs until the first click (CSSOM) fixed it. */
    dlg.querySelectorAll('.pine-tab').forEach((t) => {
      t.addEventListener('click', () => {
        dlg.querySelectorAll('.pine-tab').forEach((x) => x.classList.toggle('on', x === t));
        const k = t.dataset.tab;
        body.classList.toggle('hidden', k !== 'inputs');
        if (propsBody) propsBody.classList.toggle('hidden', k !== 'props');
        styleBody.classList.toggle('hidden', k !== 'style');
        visBody.classList.toggle('hidden', k !== 'vis');
        closePal();
      });
    });
    document.addEventListener('keydown', onKey);
    dlg.querySelector('.dlg-x').addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });

    const values = {};
    /* ROUND145 (Defaults Reset): when armed, controls render script
       defvals instead of the saved inst.inputs (TV: Reset shows factory
       values; Ok commits them). */
    let showDefaults = false;
    const getVal = (d) => {
      if (showDefaults) return d.defval;
      return (inst.inputs && inst.inputs[d.id] != null) ? inst.inputs[d.id] : d.defval;
    };
    /* ------------------------------------------------------------------ */
    /* ROUND78 — TV-style color picker (user request + reference shot):     */
    /* every color input gets a swatch that opens a palette panel with a    */
    /* preset grid, a custom-swatch row (+ exact-color eyedropper) and an   */
    /* OPACITY slider + percent box. The old native <input type=color>      */
    /* silently DROPPED the alpha of defaults like color.new(#4169E1, 65).  */
    /* Values flow as 'rgba(r,g,b,a)' strings — lossless in the engine.     */
    /* ------------------------------------------------------------------ */
    const PAL_ROWS = [
      ['#FFFFFF', '#D1D4DC', '#A3A6AD', '#787B86', '#4F535E', '#363A45', '#1E222D', '#131722', '#0C0E15', '#000000'],
      ['#F23645', '#FF9800', '#FDD835', '#8BC34A', '#4CAF50', '#00BCD4', '#2962FF', '#311B92', '#9C27B0', '#E040FB'],
      ['#FFCDD2', '#FFE0B2', '#FFF9C4', '#DCEDC8', '#C8E6C9', '#B2DFDB', '#B3E5FC', '#BBDEFB', '#E1BEE7', '#F8BBD0'],
      ['#E57373', '#FFB74D', '#FFF176', '#AED581', '#81C784', '#4DB6AC', '#4FC3F7', '#64B5F6', '#BA68C8', '#F48FB1'],
      ['#B71C1C', '#E65100', '#F9A825', '#33691E', '#1B5E20', '#006064', '#01579B', '#1A237E', '#4A148C', '#880E4F'],
    ];
    if (!dlg._pineCustomColors) dlg._pineCustomColors = [];
    let openPal = null;
    const closePal = () => { if (openPal) { openPal.remove(); openPal = null; } };
    dlg.addEventListener('scroll', closePal, true); // .ist-body scroll closes it

    /* ROUND143: generalized from an input-bound picker to (initialCss,
       onPick) so the Style tab reuses the same palette for plot/shape/fill
       swatches. Colors flow as 'rgba(r,g,b,a)' strings (lossless). */
    const buildColorPicker = (row, getCss, setCss, btnCls) => {
      const cur = parseColorValue(typeof getCss === 'function' ? getCss() : getCss);
      const swatch = U.el('button', btnCls || 'pine-swatch-btn', row);
      swatch.type = 'button';
      const fill = U.el('span', 'pine-swatch-fill', swatch);
      const paint = () => { fill.style.background = rgbaStr(cur); swatch.title = hexStr(cur) + ' — ' + Math.round(cur.a * 100) + '% opacity'; };
      paint();
      setCss(rgbaStr(cur));

      const commit = () => { paint(); setCss(rgbaStr(cur)); };
      const open = () => {
        if (openPal) { closePal(); return; }
        const pal = U.el('div', 'pine-palette');
        openPal = pal;
        const grid = U.el('div', 'pine-pal-grid', pal);
        for (const r of PAL_ROWS) for (const hx of r) {
          const sw = U.el('button', 'pine-pal-sw', grid);
          sw.type = 'button';
          sw.style.background = hx;
          sw.title = hx;
          sw.addEventListener('click', () => {
            const p = parseColorValue(hx);
            cur.r = p.r; cur.g = p.g; cur.b = p.b; commit();
          });
        }
        // custom row (+ = exact color via the native eyedropper dialog)
        const cust = U.el('div', 'pine-pal-custom', pal);
        const renderCustom = () => {
          U.clear(cust);
          for (const hx of dlg._pineCustomColors.slice(0, 8)) {
            const sw = U.el('button', 'pine-pal-sw pine-pal-csw', cust);
            sw.type = 'button'; sw.style.background = hx; sw.title = hx;
            sw.addEventListener('click', () => {
              const p = parseColorValue(hx);
              cur.r = p.r; cur.g = p.g; cur.b = p.b; commit();
            });
          }
          const plus = U.el('button', 'pine-pal-plus', cust);
          plus.type = 'button'; plus.textContent = '+'; plus.title = 'Custom color';
          const eye = document.createElement('input');
          eye.type = 'color'; eye.style.position = 'absolute'; eye.style.width = '0'; eye.style.height = '0'; eye.style.opacity = '0'; eye.style.pointerEvents = 'none';
          cust.appendChild(eye);
          plus.addEventListener('click', () => eye.click());
          eye.addEventListener('input', () => {
            const hx = eye.value.toUpperCase();
            const arr = dlg._pineCustomColors;
            const i = arr.indexOf(hx);
            if (i >= 0) arr.splice(i, 1);
            arr.unshift(hx);
            if (arr.length > 8) arr.length = 8;
            const p = parseColorValue(hx);
            cur.r = p.r; cur.g = p.g; cur.b = p.b; commit();
            renderCustom();
          });
        };
        renderCustom();
        // opacity slider + percent box (0% = invisible, TV parity)
        const opa = U.el('div', 'pine-pal-opacity', pal);
        U.el('span', 'pine-pal-olabel', opa).textContent = 'Opacity';
        const slider = U.el('input', 'pine-pal-slider', opa);
        slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
        const num = U.el('input', 'pine-pal-num', opa);
        num.type = 'number'; num.min = '0'; num.max = '100'; num.step = '1';
        const syncOpa = () => { slider.value = String(Math.round(cur.a * 100)); num.value = String(Math.round(cur.a * 100)); };
        syncOpa();
        const setOpa = (v) => {
          const n = Math.min(100, Math.max(0, Math.round(+v || 0)));
          cur.a = n / 100; syncOpa(); commit();
        };
        slider.addEventListener('input', () => setOpa(slider.value));
        num.addEventListener('keydown', (e) => e.stopPropagation());
        num.addEventListener('change', () => setOpa(num.value));

        dlg.appendChild(pal); // position: fixed — placed from the viewport rect
        const sr = swatch.getBoundingClientRect();
        const pw = pal.offsetWidth || 236, ph = pal.offsetHeight || 190;
        let x = Math.min(sr.left, window.innerWidth - pw - 10);
        let y = sr.bottom + 6;
        if (y + ph > window.innerHeight - 8) y = Math.max(8, sr.top - ph - 6);
        pal.style.left = x + 'px'; pal.style.top = y + 'px';
        setTimeout(() => {
          const outside = (ev) => {
            if (!openPal) { document.removeEventListener('mousedown', outside, true); return; }
            if (!openPal.contains(ev.target) && !swatch.contains(ev.target)) {
              closePal();
              document.removeEventListener('mousedown', outside, true);
            }
          };
          document.addEventListener('mousedown', outside, true);
        }, 0);
      };
      swatch.addEventListener('click', (e) => { e.stopPropagation(); open(); });
    };

    /* ROUND143: TV "Indicator Timeframe" row (first row, like TV). '' =
       chart TF. ROUND144: higher TFs run on HTF buckets; ROUND146: lower
       TFs run on fetched lower history. ROUND145: extracted into
       renderInputsTab so Defaults Reset can rebuild the whole body.
       ROUND226: defaults to the declaration timeframe= (untouched). */
    let tfPick = inst.timeframe || (!inst._tfTouched && inst._declTimeframe) || '';
    let tfSel = null;
    const renderInputsTab = () => {
      U.clear(body);
      for (const k of Object.keys(values)) delete values[k];
      {
        const tfRow = U.el('label', 'pine-inp pine-tf-row', body);
        U.el('span', '', tfRow).textContent = 'Indicator Timeframe';
        tfSel = U.el('select', '', tfRow);
        const addOpt = (v, label) => { const o = U.el('option', '', tfSel); o.value = v; o.textContent = label; };
        addOpt('', 'Chart');
        for (const t of (App.tf || [])) {
          if (t && t.id && t.id !== pane.tf) addOpt(t.id, t.label || t.id);
        }
        tfSel.value = [...tfSel.options].some((o) => o.value === tfPick) ? tfPick : '';
        tfPick = tfSel.value;
        tfSel.addEventListener('change', () => { tfPick = tfSel.value; });
      }
    // group sections, TV order: group name headers, inputs in registration order
    const groups = [];
    const byGroup = {};
    for (const d of defs) {
      const g = d.group || '';
      if (!byGroup[g]) { byGroup[g] = []; groups.push(g); }
      byGroup[g].push(d);
    }

    const buildInput = (container, d) => {
      const row = U.el('label', 'pine-inp', container);
      if (d.title) U.el('span', '', row).textContent = d.title;
      if (d.tooltip) row.title = d.tooltip;
      if (d.kind === 'bool') {
        const inp = U.el('input', '', row);
        inp.type = 'checkbox';
        inp.checked = !!getVal(d);
        inp.addEventListener('change', () => { values[d.id] = inp.checked; });
        values[d.id] = inp.checked;
      } else if (d.kind === 'int' || d.kind === 'float') {
        const inp = U.el('input', '', row);
        inp.type = 'number';
        inp.step = d.kind === 'int' ? '1' : 'any';
        if (d.min != null) inp.min = d.min;
        if (d.max != null) inp.max = d.max;
        inp.value = String(getVal(d));
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        inp.addEventListener('change', () => {
          const v = parseFloat(inp.value);
          values[d.id] = isFinite(v) ? (d.kind === 'int' ? Math.round(v) : v) : d.defval;
        });
        values[d.id] = parseFloat(inp.value);
      } else if (d.kind === 'string' || d.kind === 'textarea') {
        /* ROUND220 (TV parity): input.text_area renders a multiline box, not
           a single-line input (KZP one-per-line lists were unviewable). */
        const isArea = d.kind === 'textarea';
        /* ROUND 76 (BUG): two traps here. (1) options could arrive as a
           Pine array proxy ({__pineArray, items}) with no .length — the
           dialog then misread it as "no options" (BUG-74-E, from the
           user's 786 Zones log). (2) a free-text string was built as a
           <select> and "switched" via `select.type = 'text'` — but
           HTMLSelectElement.type is read-only, so that line THREW and the
           whole dialog failed. Now: read options proxy-safely; a list
           renders a real <select>, free text renders a real text <input>. */
        const raw = d.options;
        const optList = Array.isArray(raw) ? raw
          : (raw && raw.__pineArray && Array.isArray(raw.items)) ? raw.items : [];
        /* ROUND165: an enum-object value (input.string(size.tiny,...) defval)
           must display as its payload, never "[object Object]". */
        const dispVal = (v) => (v && v.__pineEnum && v.payload != null) ? String(v.payload)
          : String(v == null ? '' : v);
        let inp;
        if (isArea) {
          inp = U.el('textarea', 'pine-textarea', row);
          inp.rows = 4;
          inp.spellcheck = false;
        } else if (optList.length) {
          inp = U.el('select', '', row);
          for (const o of optList) {
            const op = U.el('option', '', inp);
            op.value = dispVal(o); op.textContent = dispVal(o);
          }
        } else {
          inp = U.el('input', '', row);
          inp.type = 'text';
          inp.spellcheck = false;
          inp.autocomplete = 'off';
        }
        inp.value = dispVal(getVal(d));
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        inp.addEventListener('change', () => { values[d.id] = inp.value; });
        values[d.id] = inp.value;
      } else if (d.kind === 'enum') {
        /* ROUND154: input.enum dropdown — options are member NAMES, but the
           script value is the member VALUE (number), mapped via d.enumMap. */
        const inp = U.el('select', '', row);
        const names = Array.isArray(d.options) ? d.options : [];
        const map = (d.enumMap && typeof d.enumMap === 'object') ? d.enumMap : {};
        for (const n of names) {
          const op = U.el('option', '', inp);
          op.value = String(n); op.textContent = String(n);
        }
        const cur = getVal(d);
        const curName = names.find((n) => map[n] === cur) || names.find((n) => String(map[n]) === String(cur));
        inp.value = curName != null ? String(curName) : (names[0] != null ? String(names[0]) : '');
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        inp.addEventListener('change', () => {
          values[d.id] = (inp.value in map) ? map[inp.value] : inp.value;
        });
        values[d.id] = (inp.value in map) ? map[inp.value] : inp.value;
      } else if (d.kind === 'color') {
        /* ROUND78: TV-style picker (palette + custom + opacity) replaces the
           native color input that discarded transparency */
        buildColorPicker(row, () => getVal(d), (css) => { values[d.id] = css; });
      } else if (d.kind === 'source') {
        /* ROUND142: TV display labels + the full source set (hlcc4 was
           missing from the hardcoded list). Engine defvals are canonical
           names (see BUILTIN_SOURCES); the dropdown shows TV's labels. */
        const SRC_OPTS = [['open', 'Open'], ['high', 'High'], ['low', 'Low'], ['close', 'Close'],
          ['hl2', '(H + L)/2'], ['hlc3', '(H + L + C)/3'], ['ohlc4', '(O + H + L + C)/4'],
          ['hlcc4', '(H + L + C + C)/4'], ['volume', 'Volume']];
        const inp = U.el('select', '', row);
        for (const [v, label] of SRC_OPTS) {
          const op = U.el('option', '', inp);
          op.value = v; op.textContent = label;
        }
        const cur = String(getVal(d) || 'close');
        inp.value = SRC_OPTS.some(([v]) => v === cur) ? cur : 'close';
        inp.addEventListener('change', () => { values[d.id] = inp.value; });
        values[d.id] = inp.value;
      }
    };
    for (const g of groups) {
      if (g) U.el('div', 'ist-sec', body).textContent = g;
      const defs = byGroup[g];
      for (let i = 0; i < defs.length; i++) {
        const d = defs[i];
        if (d.inline) {
          // consecutive run with the same inline key -> one horizontal row
          let j = i;
          while (j < defs.length && defs[j].inline === d.inline) j++;
          const runRow = U.el('div', 'pine-inline-row', body);
          runRow.dataset.inline = d.inline;
          for (let k = i; k < j; k++) buildInput(runRow, defs[k]);
          i = j - 1;
        } else {
          buildInput(body, d);
        }
      }
    }
    };
    renderInputsTab();

    /* ------------------------------------------------------------------ */
    /* ROUND175 — TV Properties tab (strategies only): the broker-emulator */
    /* settings. Values persist on inst.strategyProps and override the    */
    /* static strategy() literals at rebuild (strategy.js brokerInit).    */
    /* ------------------------------------------------------------------ */
    const numOr = (v, fb) => (typeof v === 'number' && isFinite(v) ? v : fb);
    const freshProps = () => ({
      initial_capital: numOr(inst.strategyProps && inst.strategyProps.initial_capital,
        numOr(stratDefaults.initial_capital, 100000)),
      currency: (inst.strategyProps && inst.strategyProps.currency) || stratDefaults.currency || 'USD',
      default_qty_value: numOr(inst.strategyProps && inst.strategyProps.default_qty_value,
        numOr(stratDefaults.default_qty_value, 1)),
      default_qty_type: (inst.strategyProps && inst.strategyProps.default_qty_type)
        || stratDefaults.default_qty_type || 'fixed',
      pyramiding: Math.max(0, Math.round(numOr(inst.strategyProps && inst.strategyProps.pyramiding,
        numOr(stratDefaults.pyramiding, 0)))), /* ROUND225: TV default 0 */
      commission_value: Math.max(0, numOr(inst.strategyProps && inst.strategyProps.commission_value,
        numOr(stratDefaults.commission_value, 0))),
      commission_type: (inst.strategyProps && inst.strategyProps.commission_type)
        || stratDefaults.commission_type || 'percent',
      /* ROUND213: margin requirements, % of notional (TV Properties). */
      margin_long: Math.max(0, numOr(inst.strategyProps && inst.strategyProps.margin_long,
        numOr(stratDefaults.margin_long, 100))),
      margin_short: Math.max(0, numOr(inst.strategyProps && inst.strategyProps.margin_short,
        numOr(stratDefaults.margin_short, 100))),
      slippage_ticks: Math.max(0, Math.round(numOr(inst.strategyProps && inst.strategyProps.slippage_ticks, 0))),
      /* ROUND192: Bar Magnifier opt-in (dialog wins when set, else the
         declaration literal). */
      use_bar_magnifier: !!((inst.strategyProps && inst.strategyProps.use_bar_magnifier) ||
        stratDefaults.use_bar_magnifier),
      /* ROUND212: process_orders_on_close (same precedence). */
      process_orders_on_close: !!((inst.strategyProps && inst.strategyProps.process_orders_on_close) ||
        stratDefaults.process_orders_on_close),
    });
    let propsVals = (isStratDlg && propsBody) ? freshProps() : null;
    /* ROUND175: Reset shows factory (declaration) values, committed on Ok. */
    const factoryProps = () => ({
      initial_capital: numOr(stratDefaults.initial_capital, 100000),
      currency: stratDefaults.currency || 'USD',
      default_qty_value: numOr(stratDefaults.default_qty_value, 1),
      default_qty_type: stratDefaults.default_qty_type || 'fixed',
      pyramiding: Math.max(0, Math.round(numOr(stratDefaults.pyramiding, 0))), /* ROUND225: TV default 0 */
      commission_value: Math.max(0, numOr(stratDefaults.commission_value, 0)),
      commission_type: stratDefaults.commission_type || 'percent',
      margin_long: Math.max(0, numOr(stratDefaults.margin_long, 100)),
      margin_short: Math.max(0, numOr(stratDefaults.margin_short, 100)),
      slippage_ticks: 0,
      use_bar_magnifier: false,
      process_orders_on_close: false,
    });
    const renderPropsTab = () => {
      if (!propsBody || !propsVals) return;
      U.clear(propsBody);
      const sec = (t) => { U.el('div', 'ist-sec', propsBody).textContent = t; };
      const numRow = (label, key, opt) => {
        const row = U.el('label', 'pine-inp', propsBody);
        U.el('span', '', row).textContent = label;
        const inp = U.el('input', '', row);
        inp.type = 'number';
        inp.step = (opt && opt.step) || 'any';
        if (opt && opt.min != null) inp.min = opt.min;
        inp.value = String(propsVals[key]);
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        inp.addEventListener('change', () => {
          const v = parseFloat(inp.value);
          propsVals[key] = isFinite(v) ? v : propsVals[key];
          if (opt && opt.int) propsVals[key] = Math.max(opt.min || 0, Math.round(propsVals[key]));
        });
      };
      const selRow = (label, key, opts) => {
        const row = U.el('label', 'pine-inp', propsBody);
        U.el('span', '', row).textContent = label;
        const sel = U.el('select', '', row);
        for (const [v, text] of opts) {
          const o = U.el('option', '', sel);
          o.value = v; o.textContent = text;
        }
        sel.value = opts.some(([vv]) => vv === propsVals[key]) ? propsVals[key] : opts[0][0];
        propsVals[key] = sel.value;
        sel.addEventListener('change', () => { propsVals[key] = sel.value; });
      };
      sec('General');
      numRow('Initial capital', 'initial_capital', { min: 1 });
      selRow('Currency', 'currency', [['USD', 'USD'], ['EUR', 'EUR'], ['GBP', 'GBP'], ['JPY', 'JPY'], ['CHF', 'CHF'], ['AUD', 'AUD'], ['CAD', 'CAD']]);
      numRow('Default order size', 'default_qty_value', { min: 0 });
      selRow('Order size unit', 'default_qty_type', [['fixed', 'Contracts'], ['cash', 'Cash'], ['percent', '% of equity']]);
      numRow('Pyramiding', 'pyramiding', { min: 0, step: '1', int: true });
      /* ROUND192: Bar Magnifier (intrabar fills from lower-TF data). */
      {
        const row = U.el('label', 'pine-inp pine-check', propsBody);
        const inp = U.el('input', '', row);
        inp.type = 'checkbox';
        inp.checked = !!propsVals.use_bar_magnifier;
        U.el('span', '', row).textContent = 'Use bar magnifier';
        row.title = 'Fill stop/limit orders against lower-timeframe ranges when available';
        inp.addEventListener('change', () => { propsVals.use_bar_magnifier = inp.checked; });
      }
      sec('Broker emulator');
      numRow('Commission', 'commission_value', { min: 0 });
      selRow('Commission unit', 'commission_type', [['percent', 'Percent'], ['cash_per_contract', 'Cash per contract'], ['cash_per_order', 'Cash per order']]);
      numRow('Slippage (ticks)', 'slippage_ticks', { min: 0, step: '1', int: true });
      /* ROUND213: margin requirements (% of notional per side). */
      numRow('Margin long (%)', 'margin_long', { min: 0 });
      numRow('Margin short (%)', 'margin_short', { min: 0 });
      /* ROUND212: process_orders_on_close (market fills at the bar close). */
      {
        const row = U.el('label', 'pine-inp pine-check', propsBody);
        const inp = U.el('input', '', row);
        inp.type = 'checkbox';
        inp.checked = !!propsVals.process_orders_on_close;
        U.el('span', '', row).textContent = 'Process orders on close';
        row.title = 'Fill market orders at the signal bar close instead of the next bar open';
        inp.addEventListener('change', () => { propsVals.process_orders_on_close = inp.checked; });
      }
    };
    if (isStratDlg && propsBody) renderPropsTab();

    /* ------------------------------------------------------------------ */
    /* ROUND143 — TV Style tab: per-output eye + color + width/style,      */
    /* fills with Color 0/1, OUTPUT VALUES (precision, price-scale labels, */
    /* status-line values) and a Defaults menu. Overrides collect into     */
    /* styleVals and apply on Ok (rebuild); the engine post-pass           */
    /* (applyInstanceStyle) paints them onto every output path.            */
    /* ------------------------------------------------------------------ */
    const styleValsInit = () => {
      const o = Object.assign({ plots: {}, shapes: {}, fills: {}, candles: {}, hlines: {}, objects: {},
        precision: 'default', priceLabels: true, statusValues: true, statusInputs: true },
        JSON.parse(JSON.stringify(inst.style || {})));
      o.plots = o.plots || {};
      o.shapes = o.shapes || {};
      o.fills = o.fills || {};
      return o;
    };
    /* ROUND145: let-bound — Defaults Reset replaces the whole object */
    let styleVals = styleValsInit();
    const rtOut = st.rt ? st.rt.out : null;
    const firstCss = (arr) => {
      for (const c of (arr || [])) {
        if (c && c.css && !(c.a === 0)) { try { return c.css(); } catch (e) { return null; } }
      }
      return null;
    };
    const plotTitleOf = (key) => {
      try {
        const p = rtOut && rtOut.plots.get(key);
        return (p && p.title) || key;
      } catch (e) { return key; }
    };
    const eyeBtn = (row, isOn, onFlip) => {
      const b = U.el('button', 'pine-eye-btn', row);
      b.type = 'button';
      const paintEye = () => { b.innerHTML = icon(isOn() ? 'eye' : 'eyeoff'); b.classList.toggle('off', !isOn()); };
      paintEye();
      b.addEventListener('click', (e) => { e.stopPropagation(); onFlip(); paintEye(); });
      return b;
    };
    const renderStyleTab = () => {
      U.clear(styleBody);
      /* ROUND145: persisted/saved styles may lack sections — normalize */
      for (const k of ['plots', 'shapes', 'fills', 'candles', 'hlines', 'objects']) {
        if (!styleVals[k] || typeof styleVals[k] !== 'object') styleVals[k] = {};
      }
      if (!rtOut) {
        U.el('div', 'pine-style-empty', styleBody).textContent = 'No visual outputs yet — add data first.';
        return;
      }
      const LINE_LIKES = ['line', 'linebr', 'stepline', 'steplinebr', 'stepline_diamond', 'area', 'areabr'];
      for (const key of (rtOut.plotsOrder || [])) {
        const p = rtOut.plots.get(key);
        if (!p || p.display === 'none') continue;
        if (!styleVals.plots[key]) styleVals.plots[key] = {};
        const ov = styleVals.plots[key];
        const row = U.el('div', 'pine-style-row', styleBody);
        eyeBtn(row, () => ov.visible !== false, () => { ov.visible = ov.visible !== false ? false : true; });
        buildColorPicker(row, () => (ov.color || firstCss(p.colors) || '#2962ff'), (css) => { ov.color = css; }, 'pine-swatch-btn pine-sw-sm');
        const nm = U.el('span', 'pine-style-name', row);
        nm.textContent = p.title || key;
        nm.title = key;
        /* ROUND167: TV plot-style menu (Line … Circles). Native select —
           same values as plot.style_*. Changing line↔histogram re-births the
           native series (apply lands pre-syncStructure). */
        {
          const ySel = U.el('select', 'pine-style-sel', row);
          ySel.title = 'Plot style';
          for (const [v, label] of [['line', 'Line'], ['linebr', 'Line with breaks'], ['stepline', 'Step line'], ['steplinebr', 'Step line with breaks'], ['stepline_diamond', 'Step line with diamonds'], ['histogram', 'Histogram'], ['cross', 'Cross'], ['area', 'Area'], ['areabr', 'Area with breaks'], ['columns', 'Columns'], ['circles', 'Circles']]) {
            const o = U.el('option', '', ySel);
            o.value = v; o.textContent = label;
          }
          /* ROUND167: steplinebr = step base + linebr break rule (engine +
             adapter both know it — see PLOT_STYLE_SET). */
          const curStyle = ov.plotstyle || p.style || 'line';
          ySel.value = [...ySel.options].some((o) => o.value === curStyle) ? curStyle : 'line';
          ySel.addEventListener('change', () => {
            ov.plotstyle = (ySel.value === (p.style || 'line')) ? undefined : ySel.value;
            if (ov.plotstyle === undefined) delete ov.plotstyle;
          });
          const plLbl = U.el('label', 'pine-style-pl', row);
          plLbl.title = 'Price line';
          const plInp = U.el('input', '', plLbl);
          plInp.type = 'checkbox';
          plInp.checked = ov.trackprice != null ? !!ov.trackprice : !!p.trackprice;
          const plTx = U.el('span', '', plLbl);
          plTx.textContent = 'Price line';
          plInp.addEventListener('change', () => {
            ov.trackprice = plInp.checked === !!p.trackprice ? undefined : plInp.checked;
            if (ov.trackprice === undefined) delete ov.trackprice;
          });
        }
        if (LINE_LIKES.includes(p.style)) {
          const wSel = U.el('select', 'pine-style-sel', row);
          wSel.title = 'Line width';
          for (let wNum = 1; wNum <= 4; wNum++) {
            const o = U.el('option', '', wSel);
            o.value = String(wNum); o.textContent = String(wNum);
          }
          wSel.value = String(ov.width != null ? ov.width : (p.linewidth > 0 ? p.linewidth : 1));
          wSel.addEventListener('change', () => { ov.width = +wSel.value; });
          const sSel = U.el('select', 'pine-style-sel', row);
          sSel.title = 'Line style';
          for (const [v, label] of [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']]) {
            const o = U.el('option', '', sSel);
            o.value = v; o.textContent = label;
          }
          sSel.value = ov.style || p.linestyle || 'solid';
          sSel.addEventListener('change', () => { ov.style = sSel.value; });
        }
      }
      const SIZE_IDS = ['tiny', 'small', 'normal', 'large', 'huge'];
      for (const [key, sh] of (rtOut.shapes || new Map())) {
        if (!styleVals.shapes[key]) styleVals.shapes[key] = {};
        const ov = styleVals.shapes[key];
        const row = U.el('div', 'pine-style-row', styleBody);
        eyeBtn(row, () => ov.visible !== false, () => { ov.visible = ov.visible !== false ? false : true; });
        buildColorPicker(row, () => (ov.color || firstCss(sh.colors) || '#2962ff'), (css) => { ov.color = css; }, 'pine-swatch-btn pine-sw-sm');
        const nm = U.el('span', 'pine-style-name', row);
        let label = sh.title;
        if (!label) {
          for (const t of (sh.texts || [])) { if (t) { label = String(t); break; } }
        }
        nm.textContent = label || key;
        nm.title = (sh.style || '') + ' · ' + key;
        const glyph = U.el('span', 'pine-style-glyph', row);
        glyph.textContent = sh.style || '';
        const zSel = U.el('select', 'pine-style-sel', row);
        zSel.title = 'Size';
        for (const z of SIZE_IDS) {
          const o = U.el('option', '', zSel);
          o.value = z; o.textContent = z[0].toUpperCase() + z.slice(1);
        }
        zSel.value = SIZE_IDS.includes(ov.size || sh.size) ? (ov.size || sh.size) : 'small';
        zSel.addEventListener('change', () => { ov.size = zSel.value; });
        /* ROUND146: TV location dropdown (plotshape/plotchar only —
           plotarrow has no location param, same as TV). Reinterpreted at
           paint time: bar-anchored modes read the live bar high/low. */
        if (sh.hasLoc) {
          const lSel = U.el('select', 'pine-style-sel', row);
          lSel.title = 'Location';
          for (const [v, label] of [['absolute', 'Absolute'], ['abovebar', 'Above bar'], ['belowbar', 'Below bar'], ['top', 'Top'], ['bottom', 'Bottom']]) {
            const o = U.el('option', '', lSel);
            o.value = v; o.textContent = label;
          }
          const curLoc = ov.loc || sh.loc || 'absolute';
          lSel.value = ['absolute', 'abovebar', 'belowbar', 'top', 'bottom'].includes(curLoc) ? curLoc : 'absolute';
          lSel.addEventListener('change', () => {
            if (lSel.value === (sh.loc || 'absolute')) delete ov.loc;
            else ov.loc = lSel.value;
          });
        }
      }
      (rtOut.fills || []).forEach((f, idx) => {
        if (!styleVals.fills[idx]) styleVals.fills[idx] = {};
        const ov = styleVals.fills[idx];
        const row = U.el('div', 'pine-style-row', styleBody);
        eyeBtn(row, () => ov.visible !== false, () => { ov.visible = ov.visible !== false ? false : true; });
        const distinct = [];
        for (const c of (f.colors || [])) {
          if (!c || !c.css || c.a === 0) continue;
          try {
            const css = c.css();
            if (!distinct.includes(css)) distinct.push(css);
          } catch (e) {}
          if (distinct.length >= 2) break;
        }
        buildColorPicker(row, () => (ov.color0 || distinct[0] || '#2962ff'), (css) => { ov.color0 = css; }, 'pine-swatch-btn pine-sw-sm');
        buildColorPicker(row, () => (ov.color1 || distinct[1] || distinct[0] || '#2962ff'), (css) => { ov.color1 = css; }, 'pine-swatch-btn pine-sw-sm');
        const nm = U.el('span', 'pine-style-name', row);
        nm.textContent = f.title || (plotTitleOf(f.p1) + ' → ' + plotTitleOf(f.p2));
      });
      /* ROUND166 (TV Style-tab sweep): PlotCandle row (eye + up/down/wick/
         border colors) and hline rows (eye + color). The engine records one
         candle descriptor (candleMeta); editable=false outputs get no row,
         like TV. */
      {
        const meta = rtOut.candleMeta;
        if (meta && meta.editable !== false) {
          if (!styleVals.candles) styleVals.candles = {};
          const ov = styleVals.candles;
          const row = U.el('div', 'pine-style-row', styleBody);
          eyeBtn(row, () => ov.visible !== false, () => { ov.visible = ov.visible !== false ? false : true; });
          const firstCol = (pick) => {
            for (const c of (rtOut.candles || [])) {
              if (c && c[pick] && c[pick].css && !(c[pick].a === 0)) { try { return c[pick].css(); } catch (e) { return null; } }
            }
            return null;
          };
          const nm = U.el('span', 'pine-style-name', row);
          nm.textContent = meta.title || 'PlotCandle';
          nm.title = 'plotcandle';
          for (const fld of ['color', 'wickcolor', 'bordercolor']) {
            buildColorPicker(row, () => (ov[fld] || firstCol(fld) || '#2962ff'), (css) => { ov[fld] = css; }, 'pine-swatch-btn pine-sw-sm');
          }
        }
      }
      (rtOut.hlines || []).forEach((h, idx) => {
        if (!styleVals.hlines[idx]) styleVals.hlines[idx] = {};
        const ov = styleVals.hlines[idx];
        const row = U.el('div', 'pine-style-row', styleBody);
        eyeBtn(row, () => ov.visible !== false, () => { ov.visible = ov.visible !== false ? false : true; });
        buildColorPicker(row, () => (ov.color || (h.color && h.color.css ? h.color.css() : null) || '#787B86'), (css) => { ov.color = css; }, 'pine-swatch-btn pine-sw-sm');
        const nm = U.el('span', 'pine-style-name', row);
        nm.textContent = h.title || ('Hline ' + h.price);
        nm.title = String(h.price);
      });
      /* ROUND166: TV GRAPHIC OBJECTS master toggles (all default on) */
      U.el('div', 'ist-sec', styleBody).textContent = 'Graphic objects';
      {
        const mkObjCheck = (label, kind) => {
          const r = U.el('label', 'pine-inp pine-check', styleBody);
          const inp = U.el('input', '', r);
          inp.type = 'checkbox';
          inp.checked = (styleVals.objects && styleVals.objects[kind] === false) ? false : true;
          U.el('span', '', r).textContent = label;
          inp.addEventListener('change', () => {
            if (!styleVals.objects || typeof styleVals.objects !== 'object') styleVals.objects = {};
            styleVals.objects[kind] = inp.checked;
          });
        };
        mkObjCheck('Boxes', 'boxes');
        mkObjCheck('Lines', 'lines');
        mkObjCheck('Pane labels', 'labels');
        /* ROUND280: polylines/linefills were always painted but had no
           Style-tab master toggle; TV lists them as graphic objects. */
        mkObjCheck('Polylines', 'polylines');
        mkObjCheck('Line fills', 'linefills');
      }
      /* OUTPUT VALUES (TV footer of the Style tab) */
      U.el('div', 'ist-sec', styleBody).textContent = 'Output values';
      const prRow = U.el('label', 'pine-inp', styleBody);
      U.el('span', '', prRow).textContent = 'Precision';
      const prSel = U.el('select', '', prRow);
      for (const pv of ['default', '0', '1', '2', '3', '4', '5', '6', '7', '8']) {
        const o = U.el('option', '', prSel);
        o.value = pv; o.textContent = pv === 'default' ? 'Default' : pv;
      }
      prSel.value = styleVals.precision != null ? String(styleVals.precision) : 'default';
      prSel.addEventListener('change', () => { styleVals.precision = prSel.value; });
      const mkCheck = (label, get, set) => {
        const r = U.el('label', 'pine-inp pine-check', styleBody);
        const inp = U.el('input', '', r);
        inp.type = 'checkbox';
        inp.checked = !!get();
        U.el('span', '', r).textContent = label;
        inp.addEventListener('change', () => set(inp.checked));
      };
      mkCheck('Labels on price scale', () => styleVals.priceLabels !== false, (v) => { styleVals.priceLabels = v; });
      mkCheck('Values in status line', () => styleVals.statusValues !== false, (v) => { styleVals.statusValues = v; });
      /* ROUND166: TV INPUT VALUES footer */
      U.el('div', 'ist-sec', styleBody).textContent = 'Input values';
      mkCheck('Inputs in status line', () => styleVals.statusInputs !== false, (v) => { styleVals.statusInputs = v; });
    };
    renderStyleTab();
    /* Defaults menu (TV footer, pinned next to Remove so it is clickable
       from every tab): reset + save-as-default */
    {
      const defBtn = dlg.querySelector('.ist-defaults');
      defBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.pine-def-menu').forEach((m) => m.remove());
        const menu = U.el('div', 'pine-def-menu');
        const item = (label, fn) => {
          const b = U.el('button', 'pine-def-item', menu);
          b.type = 'button'; b.textContent = label;
          b.addEventListener('click', (ev) => { ev.stopPropagation(); menu.remove(); fn(); });
        };
        item('Reset to script defaults', () => {
          /* ROUND145 (user report: Reset left edited settings in place) —
             TV resets the WHOLE dialog: style -> saved default if one was
             stored, else factory; inputs -> script defvals (showDefaults);
             visibility -> all on; timeframe -> Chart. Bodies re-render. */
          const saved = loadDefaultStyle(inst.scriptId);
          /* factory-fresh (NOT merged with the instance style) */
          styleVals = saved ? JSON.parse(JSON.stringify(saved)) : { plots: {}, shapes: {}, fills: {}, candles: {}, hlines: {}, objects: {}, precision: 'default', priceLabels: true, statusValues: true, statusInputs: true };
          for (const k of ['plots', 'shapes', 'fills', 'candles', 'hlines', 'objects']) if (!styleVals[k] || typeof styleVals[k] !== 'object') styleVals[k] = {};
          showDefaults = true;
          visVals = {};
          tfPick = '';
          if (tfSel) tfSel.value = '';
          if (isStratDlg && propsBody) { propsVals = factoryProps(); renderPropsTab(); }
          renderInputsTab();
          renderStyleTab();
          renderVisTab();
        });
        item('Save current as default', () => saveDefaultStyle(inst.scriptId, styleVals));
        dlg.appendChild(menu);
        const r = defBtn.getBoundingClientRect();
        menu.style.left = Math.min(r.left, window.innerWidth - 220) + 'px';
        menu.style.top = Math.max(8, r.top - menu.offsetHeight - 6) + 'px';
        setTimeout(() => {
          const outside = (ev) => {
            if (!menu.isConnected) { document.removeEventListener('mousedown', outside, true); return; }
            if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', outside, true); }
          };
          document.addEventListener('mousedown', outside, true);
        }, 0);
      });
    }

    /* ------------------------------------------------------------------ */
    /* ROUND143 - TV Visibility tab: per-interval eyes (chart TFs). Stored */
    /* as falses-only {tfId:false}; missing = shown (tfVisible helper).    */
    /* ROUND145: extracted into renderVisTab so Defaults Reset rebuilds it. */
    /* ------------------------------------------------------------------ */
    let visVals = Object.assign({}, inst.visTF || {});
    const renderVisTab = () => {
      U.clear(visBody);
      {
        let lastGroup = null;
        for (const t of (App.tf || [])) {
          if (!t || !t.id) continue;
          if (t.group !== lastGroup) {
            lastGroup = t.group;
            if (lastGroup) U.el('div', 'ist-sec', visBody).textContent = lastGroup;
          }
          const r = U.el('label', 'pine-inp pine-check', visBody);
          const inp = U.el('input', '', r);
          inp.type = 'checkbox';
          inp.checked = visVals[t.id] !== false;
          U.el('span', '', r).textContent = t.label || t.id;
          inp.addEventListener('change', () => {
            if (inp.checked) delete visVals[t.id];
            else visVals[t.id] = false;
          });
        }
      }
    };
    renderVisTab();
    /* every Pine settings dialog (before the action buttons). The feed     */
    /* offset (measured by the provider, auto-healed) is the default; a     */
    /* numeric override is for the rare feed that mis-measures. The engine  */
    /* shifts script `time` and the adapter shifts drawing x-times with     */
    /* this same value, so session boxes land on the correct wall-clock     */
    /* hour for EVERY broker.                                               */
    /* ------------------------------------------------------------------ */
    const effOff = effServerOffSec(inst);
    const feedOff = (App.feed && App.feed.serverOff) || 0;
    const dlgActions = dlg.querySelector('.dlg-actions');
    const tzSec = U.el('div', 'ist-sec pine-tz-sec', null);
    tzSec.textContent = 'Data Timezone (broker server)';
    const tzRow = U.el('div', 'pine-tz-row', null);
    const tzInfo = U.el('span', 'pine-tz-info', tzRow);
    tzInfo.textContent = 'Feed offset: ' + fmtOff(feedOff) + (feedOff === effOff ? ' (auto)' : ' (overridden)');
    const tzInp = U.el('input', 'pine-tz-inp', tzRow);
    tzInp.type = 'number'; tzInp.step = '0.5'; tzInp.min = '-14'; tzInp.max = '14';
    tzInp.placeholder = 'auto';
    tzInp.title = 'Broker server UTC offset in hours (empty = follow the feed)';
    if (inst.tzOffH != null && inst.tzOffH !== '') tzInp.value = String(inst.tzOffH);
    tzInp.addEventListener('keydown', (e) => e.stopPropagation());
    const tzHint = U.el('div', 'pine-tz-hint', null);
    tzHint.textContent = 'Pine time runs on true UTC; the broker offset above is applied to session math automatically. Override only if your feed reports the wrong offset.';
    const tzSync = () => { tzInfo.textContent = 'Feed offset: ' + fmtOff(feedOff) + (tzInp.value.trim() === '' ? ' (auto)' : ' (overridden)'); };
    tzInp.addEventListener('input', tzSync);
    const tzAnchor = dlgActions || null;
    if (tzAnchor) { dlg.insertBefore(tzSec, tzAnchor); dlg.insertBefore(tzRow, tzAnchor); dlg.insertBefore(tzHint, tzAnchor); }
    else { dlg.appendChild(tzSec); dlg.appendChild(tzRow); dlg.appendChild(tzHint); }

    dlg.querySelector('.ist-ok').addEventListener('click', () => {
      close();
      /* ROUND78 (timezone): persist the override (empty = follow the feed) */
      const tv = tzInp.value.trim();
      inst.tzOffH = (tv === '' || !isFinite(+tv)) ? null : Math.max(-14, Math.min(14, +tv));
      inst.inputs = values;
      /* ROUND175: strategy broker-emulator settings ride alongside inputs */
      if (isStratDlg && propsVals) inst.strategyProps = Object.assign({}, propsVals);
      /* ROUND143: Style tab + Visibility tab + Indicator Timeframe */
      inst.style = styleVals;
      inst.visTF = Object.keys(visVals).length ? visVals : null;
      /* ROUND144: Indicator Timeframe executes for real (HTF buckets) */
      /* ROUND226: mark explicit picks so '' (Chart) beats a declaration. */
      inst.timeframe = tfPick || '';
      inst._tfTouched = true;
      Manager.persistPanes();
      rebuild(pane, inst);
    });
    dlg.querySelector('.ist-remove').addEventListener('click', () => { close(); remove(pane, inst.id); });
    /* reveal only after a fully-built, fully-wired dialog (ROUND 75 BUG) */
    layer.classList.remove('hidden');
  } catch (e) {
    close();
    throw e; // global handler still reports it (toast + Diagnostics panel)
  }
}

export { openSettingsDialog };
