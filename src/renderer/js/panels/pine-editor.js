/**
 * Pine Editor panel (round 74 — roadmap phase 6)
 *
 * A TradingView-style bottom panel: script list + zero-dependency code editor
 * (custom: syntax highlight overlay, line-number gutter, indentation-aware
 * Enter, Tab → spaces, Ctrl+S save, Ctrl+Enter Add to Chart) + a console
 * strip for compile/runtime errors with the official CE/RE style.
 *
 * Layout: #pine-editor lives between #main and #bottom-toolbar; the height is
 * user-resizable (drag handle) and persisted. The editor is a plain <textarea>
 * under a highlighted <pre> — no external library, mirroring the app's
 * zero-dependency renderer culture.
 *
 * @module panels/pine-editor
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { App } from '../../../core/state.js';
import { Manager } from '../chart/manager.js';
import { PineScriptsStore } from './pine-scripts-store.js';
import { PineUI } from '../chart/pine-ui.js';
import { Log } from '../../../core/logger.js';

const HEIGHT_KEY = 'mt5_pine_height';
const OPEN_KEY = 'mt5_pine_open';
const LAST_KEY = 'mt5_pine_last';

const PineEditor = {};

/* ============================ highlighting ============================ */

const PINE_KEYWORDS = new Set([
  'if', 'else', 'for', 'to', 'by', 'while', 'var', 'varip', 'switch', 'and', 'or', 'not',
  'true', 'false', 'na', 'break', 'continue', 'type', 'enum', 'method', 'import', 'export',
  'indicator', 'strategy', 'library',
]);
const NS_RE = /\b(ta|math|str|array|matrix|map|color|line|box|label|table|input|request|syminfo|timeframe|session|ticker|strategy|plot|shape|size|location|extend|xloc|barstate|barmerge|display|format|currency|adjustment|text|position|order|hline|scale|alert)\./g;

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/** line -> highlighted HTML (escape-safe, comment/string aware) */
function highlightLine(line) {
  let out = '';
  let i = 0;
  const n = line.length;
  const pushPlain = (txt) => {
    // keywords / namespaces / numbers inside plain text
    let rest = '';
    let k = 0;
    while (k < txt.length) {
      const ch = txt[k];
      if (/[A-Za-z_]/.test(ch)) {
        let j = k;
        while (j < txt.length && /[A-Za-z0-9_.]/.test(txt[j])) j++;
        const word = txt.slice(k, j);
        if (PINE_KEYWORDS.has(word)) rest += `<span class="pn-kw">${esc(word)}</span>`;
        else if (/^[a-z]+\.$/.test(txt.slice(k, Math.min(j + 1, k + 8))) && txt[j] === '.' === false && word.indexOf('.') > 0) rest += `<span class="pn-ns">${esc(word)}</span>`;
        else if (NS_RE.test(word + '.')) { NS_RE.lastIndex = 0; rest += `<span class="pn-ns">${esc(word)}</span>`; }
        else rest += esc(word);
        k = j;
      } else if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(txt[k + 1] || ''))) {
        let j = k;
        while (j < txt.length && /[0-9.eE]/.test(txt[j])) j++;
        rest += `<span class="pn-num">${esc(txt.slice(k, j))}</span>`;
        k = j;
      } else if (ch === '#' && /[0-9a-fA-F]/.test(txt[k + 1] || '')) {
        let j = k + 1;
        while (j < txt.length && /[0-9a-fA-F]/.test(txt[j])) j++;
        rest += `<span class="pn-color">${esc(txt.slice(k, j))}</span>`;
        k = j;
      } else if (ch === '@') {
        rest += esc(ch); k++;
      } else { rest += esc(ch); k++; }
    }
    out += rest;
  };
  while (i < n) {
    const two = line.substr(i, 2);
    if (two === '//') { out += `<span class="pn-cm">${esc(line.slice(i))}</span>`; break; }
    const q = line[i];
    if (q === '"' || q === "'") {
      let j = i + 1;
      while (j < n && line[j] !== q) { if (line[j] === '\\') j++; j++; }
      out += `<span class="pn-str">${esc(line.slice(i, Math.min(n, j + 1)))}</span>`;
      i = j + 1;
      continue;
    }
    pushPlain(q); i++;
  }
  return out || '&nbsp;';
}

/* ============================ editor state ============================ */

let built = false;
let els = null; // { panel, gutter, hl, ta, status, scriptSel }
let current = null; // active script record
let dirty = false;

function compileStatus(text, kind) {
  els.status.innerHTML = text;
  els.status.className = 'pe-status ' + (kind || '');
}

/** compile the CURRENT source and surface the result in the console strip */
function runCompile(feedback) {
  if (!current) return null;
  const { compile } = require_compile();
  /* ROUND195: editor validation resolves imports from the local store too. */
  const c = compile(els.ta.value, {
    resolveImport: (p) => PineScriptsStore.resolveLibrary(p),
    listCandidates: () => PineScriptsStore.listLibraries(),
  });
  if (!c.ok) {
    if (feedback !== false) {
      const first = c.errors[0];
      const lines = c.errors.slice(0, 6).map((e) =>
        `<span class="pe-err" data-line="${e.line || 1}">${esc(e.code)}: ${esc(e.message)}${e.line ? ' (line ' + e.line + ')' : ''}</span>`
      ).join('<br>');
      compileStatus(lines || 'compile error', 'error');
    }
  } else {
    if (feedback !== false) {
      const ci = c.collectInputs({ dry: true });
      const n = ci.ok ? ci.inputs.length : 0;
      compileStatus(`<span class="pe-ok">✓ ${esc(c.meta.title)} — ${c.meta.overlay ? 'overlay' : 'pane'}${n ? ', ' + n + ' inputs' : ''}</span>`, 'ok');
    }
  }
  return c;
}

// lazy require of the core compile (module-level import would be fine too —
// kept as a function to survive future refactor churn)
import { compile as _compile } from '../../../core/pine/compile.js';
function require_compile() { return { compile: _compile }; }

/* ============================ build UI ============================ */

function buildPanel() {
  if (built) return;
  built = true;
  const panel = U.el('div', 'hidden');
  panel.id = 'pine-editor';
  panel.innerHTML = `
    <div class="pe-resize" title="Drag to resize"></div>
    <div class="pe-head">
      <span class="pe-logo">{ }</span>
      <span class="pe-title">Pine Editor</span>
      <div class="pe-sep"></div>
      <div class="pe-scripts-wrap">
        <select id="pe-script-sel" title="Saved scripts"></select>
      </div>
      <button class="pe-btn" id="pe-new" title="New script">${icon('plus')}</button>
      <button class="pe-btn" id="pe-rename" title="Rename script">${icon('gear')}</button>
      <button class="pe-btn" id="pe-save" title="Save (Ctrl+S)">${icon('doc')}</button>
      <button class="pe-btn" id="pe-import" title="Import .pine file">${icon('locate')}</button>
      <button class="pe-btn" id="pe-export" title="Export .pine file">${icon('gotolive')}</button>
      <button class="pe-btn pe-danger" id="pe-del" title="Delete script">${icon('trash')}</button>
      <span class="pe-flex"></span>
      <button class="pe-btn pe-primary" id="pe-add" title="Add to chart (Ctrl+Enter)">Add to chart</button>
      <button class="pe-btn" id="pe-close" title="Close panel">${icon('x')}</button>
    </div>
    <div class="pe-body">
      <div class="pe-gutter" id="pe-gutter"></div>
      <div class="pe-code">
        <pre class="pe-hl" id="pe-hl" aria-hidden="true"></pre>
        <textarea class="pe-ta" id="pe-ta" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>
      </div>
    </div>
    <div class="pe-status" id="pe-status">Ready — pick a script, edit, then “Add to chart”.</div>`;
  const app = document.getElementById('app');
  app.insertBefore(panel, document.getElementById('bottom-toolbar'));

  els = {
    panel,
    gutter: panel.querySelector('#pe-gutter'),
    hl: panel.querySelector('#pe-hl'),
    ta: panel.querySelector('#pe-ta'),
    status: panel.querySelector('#pe-status'),
    sel: panel.querySelector('#pe-script-sel'),
  };

  // ---- panel events
  panel.querySelector('#pe-close').addEventListener('click', () => PineEditor.close());
  panel.querySelector('#pe-new').addEventListener('click', async () => {
    const name = await U.promptDialog('Script name:', PineScriptsStore.uniqueName('My script'));
    if (name == null) return;
    const rec = PineScriptsStore.create(name.trim(), '//@version=6\nindicator("' + (name.trim() || 'My script') + '", overlay=true)\n\nplot(close)\n');
    refreshSel(rec.id);
    loadScript(rec.id);
  });
  panel.querySelector('#pe-rename').addEventListener('click', async () => {
    if (!current) return;
    const name = await U.promptDialog('Rename script:', current.name);
    if (name == null || !name.trim()) return;
    PineScriptsStore.save(current.id, { name: name.trim() });
    current = PineScriptsStore.get(current.id);
    refreshSel(current.id);
    runCompile();
  });
  panel.querySelector('#pe-save').addEventListener('click', () => saveScript(true));
  panel.querySelector('#pe-del').addEventListener('click', () => {
    if (!current) return;
    if (!confirm('Delete "' + current.name + '"? Instances on charts keep working but can no longer be edited.')) return;
    PineScriptsStore.remove(current.id);
    current = null;
    refreshSel(null);
    const first = PineScriptsStore.all()[0];
    if (first) loadScript(first.id); else { els.ta.value = ''; syncEditor(); compileStatus('No scripts — press + to create one.', ''); }
  });
  panel.querySelector('#pe-import').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.pine,.txt';
    inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      try {
        const text = await f.text();
        const base = f.name.replace(/\.(pine|txt)$/i, '') || 'Imported script';
        const rec = PineScriptsStore.create(PineScriptsStore.uniqueName(base), text);
        refreshSel(rec.id);
        loadScript(rec.id);
        U.toast && U.toast('Imported ' + base, 'ok');
      } catch (e) { U.toast && U.toast('Import failed', 'error'); }
    });
    inp.click();
  });
  panel.querySelector('#pe-export').addEventListener('click', () => {
    if (!current) return;
    const fname = current.name.replace(/[^\w\- ]+/g, '_') + '.pine';
    if (window.electronAPI && window.electronAPI.saveTextFile) {
      window.electronAPI.saveTextFile(els.ta.value, fname);
    } else {
      const blob = new Blob([els.ta.value], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      a.click();
    }
  });
  panel.querySelector('#pe-add').addEventListener('click', () => addToChart());
  els.sel.addEventListener('change', () => {
    saveScript(false);
    loadScript(els.sel.value);
  });

  // ---- editor events
  els.ta.addEventListener('input', () => {
    dirty = true;
    syncEditor();
    scheduleAutosave();
  });
  els.ta.addEventListener('scroll', () => {
    els.hl.scrollTop = els.ta.scrollTop;
    els.hl.scrollLeft = els.ta.scrollLeft;
    els.gutter.scrollTop = els.ta.scrollTop;
  });
  els.ta.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the app's global shortcuts must not fire inside the editor
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyS') { e.preventDefault(); saveScript(true); return; }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'Enter') { e.preventDefault(); addToChart(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      insertAtCursor('    ');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      autoIndentEnter();
      return;
    }
  });
  els.ta.addEventListener('keyup', () => syncGutter());
  els.ta.addEventListener('focus', () => { try { Manager.setActive && null; } catch (er) {} });

  // ---- resize handle
  const grip = panel.querySelector('.pe-resize');
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panel.offsetHeight;
    const move = (ev) => {
      const h = U.clamp(startH + (startY - ev.clientY), 120, Math.round(window.innerHeight * 0.7));
      panel.style.height = h + 'px';
      U.lsSet(HEIGHT_KEY, h);
    };
    const up = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  });

  // restore persisted height
  const h = U.lsGet(HEIGHT_KEY, 260);
  panel.style.height = U.clamp(h, 120, Math.round(window.innerHeight * 0.7)) + 'px';
}

let _autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(() => saveScript(false), 900);
}

function insertAtCursor(text) {
  const ta = els.ta;
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  syncEditor();
  dirty = true;
  scheduleAutosave();
}

/** Pine-style Enter: copy the previous line's indent; +4 after => / block openers */
function autoIndentEnter() {
  const ta = els.ta;
  const pos = ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const lineStart = before.lastIndexOf('\n') + 1;
  const curLine = before.slice(lineStart);
  const indent = (curLine.match(/^ */) || [''])[0];
  const opensBlock = /(=>|^\s*(if|else|for|while|switch)\b.*)$/.test(curLine.trimEnd()) && !/^\s*else\b.*=>/.test('');
  const extra = (curLine.trimEnd().endsWith('=>') || /^(if|else|for|while|switch)\b/.test(curLine.trim())) ? '    ' : '';
  insertAtCursor('\n' + indent + extra);
}

function syncEditor() {
  const ta = els.ta;
  const text = ta.value;
  const lines = text.split('\n');
  let html = '';
  for (const l of lines) html += highlightLine(l) + '\n';
  els.hl.innerHTML = html;
  syncGutter();
}

function syncGutter() {
  const count = els.ta.value.split('\n').length;
  let html = '';
  for (let i = 1; i <= Math.max(count, 12); i++) html += i + '\n';
  els.gutter.textContent = html;
  els.gutter.scrollTop = els.ta.scrollTop;
}

function refreshSel(selectedId) {
  U.clear(els.sel);
  for (const s of PineScriptsStore.all()) {
    const o = U.el('option', '', els.sel);
    o.value = s.id;
    o.textContent = s.name;
  }
  if (selectedId) els.sel.value = selectedId;
}

function loadScript(id) {
  saveScript(false);
  const rec = PineScriptsStore.get(id);
  if (!rec) return;
  current = rec;
  els.ta.value = rec.source;
  dirty = false;
  U.lsSet(LAST_KEY, id);
  syncEditor();
  els.hl.scrollTop = 0; els.ta.scrollTop = 0;
  runCompile();
}

function saveScript(explicit) {
  if (!current) return;
  if (!dirty && !explicit) return;
  PineScriptsStore.save(current.id, { source: els.ta.value });
  current = PineScriptsStore.get(current.id);
  dirty = false;
  runCompile();
  // live-refresh instances that use this script
  for (const pane of App.panes) {
    const mine = (pane.pineScripts || []).filter((i) => i.scriptId === current.id);
    for (const inst of mine) PineUI.recomputePine(pane);
  }
}

/* ============================ add to chart ============================ */

function addToChart() {
  if (!current) { compileStatus('No script selected — create one with + first.', 'error'); return; }
  saveScript(true);
  const c = runCompile(false);
  if (!c.ok) {
    const first = c.errors[0];
    compileStatus(`<span class="pe-err">${esc(first.code)}: ${esc(first.message)}${first.line ? ' (line ' + first.line + ')' : ''}</span>`, 'error');
    return;
  }
  const pane = App.activePane || App.panes[0];
  if (!pane) { compileStatus('No chart available.', 'error'); return; }
  PineUI.add(pane, current.id, {});
  const title = c.meta.title;
  compileStatus(`<span class="pe-ok">✓ "${esc(title)}" added to the ${esc(pane.symbol)} chart</span>`, 'ok');
  try { Log && Log.info('pine', 'script added to chart', { script: current.name, pane: pane.symbol, tf: pane.tf }); } catch (e) {}
}

/* ============================ open / close ============================ */

PineEditor.open = function () {
  buildPanel();
  els.panel.classList.remove('hidden');
  U.lsSet(OPEN_KEY, true);
  if (!els.ta.value) {
    const last = U.lsGet(LAST_KEY, null);
    const first = (last && PineScriptsStore.get(last)) || PineScriptsStore.all()[0];
    if (first) { refreshSel(first.id); loadScript(first.id); }
    else refreshSel(null);
  }
  setTimeout(() => els.ta.focus(), 40);
};

PineEditor.close = function () {
  if (!built) return;
  saveScript(false);
  els.panel.classList.add('hidden');
  U.lsSet(OPEN_KEY, false);
};

PineEditor.toggle = function () {
  if (built && !els.panel.classList.contains('hidden')) PineEditor.close();
  else PineEditor.open();
};

/* ROUND84 (My scripts in the Indicators dialog): open the editor directly on
   one stored script — the dialog's "edit code" action lands here. */
PineEditor.openScript = function (id) {
  buildPanel();
  els.panel.classList.remove('hidden');
  U.lsSet(OPEN_KEY, true);
  const rec = PineScriptsStore.get(id);
  if (rec) {
    refreshSel(rec.id);
    loadScript(rec.id);
  }
  setTimeout(() => els.ta.focus(), 40);
};

PineEditor.init = function () {
  buildPanel();
  refreshSel(null);
  // NOTE: the #pine-btn top-bar wiring lives in chart/toolbar.js (single
  // owner — double wiring here would toggle the panel twice per click).
  if (U.lsGet(OPEN_KEY, false)) PineEditor.open();
};

PineEditor.highlightLine = highlightLine; // tests
export { PineEditor };
