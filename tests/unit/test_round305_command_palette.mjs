/**
 * test_round305_command_palette.mjs — the command palette's ENGINE.
 *
 * `src/renderer/js/ui/command.js` is deliberately DOM-light: the registry, the
 * fuzzy scorer, recent-first ordering and the pick/run loop are pure enough to
 * test in Node with a stub `document`. The E2E suite covers the parts that need
 * a real browser (Ctrl+K opens, Enter changes the chart); this suite covers the
 * parts where a bug is silent — a scorer that ranks "Renko" below 40 unrelated
 * symbols still "works", it just makes the palette useless.
 *
 * What is pinned:
 *   A. registration contract (bad commands are rejected, not half-added)
 *   B. fuzzy matcher: exact > prefix > substring > keywords > subsequence
 *   C. search ordering: empty query is recent-first, then registration order
 *   D. run() records recency, survives a throwing command, reports unknown ids
 *   E. recency is capped and de-duplicated, and persists to mt5_cmd_recent
 *
 * Run: node tests/unit/test_round305_command_palette.mjs
 */

/* The module touches `document.getElementById` at init time only, so a minimal
 * stub is enough and keeps this suite free of jsdom. */
const stubEl = () => ({
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: {}, dataset: {}, children: [],
  appendChild(c) { this.children.push(c); return c; },
  addEventListener() {}, setAttribute() {}, removeAttribute() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  focus() {}, blur() {}, select() {}, scrollIntoView() {},
  set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; },
  set textContent(v) { this._txt = v; }, get textContent() { return this._txt || ''; },
  set value(v) { this._val = v; }, get value() { return this._val || ''; },
});
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => stubEl(),
  addEventListener() {},
  body: stubEl(),
};
globalThis.window = { addEventListener() {} };
globalThis.localStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
})();

const { Command, subsequence, fuzzyScore } = await import('../../src/renderer/js/ui/command.js');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

/* every test starts from a clean registry */
const reset = () => {
  Command.list = [];
  Command._byId = new Map();
  Command.resetRecent();
};

/* ---------- A. registration ---------- */
{
  reset();
  let threw = false;
  try { Command.add({ id: 'x', title: 'no run' }); } catch (e) { threw = true; }
  ok(threw, 'a command without run() is rejected');
  threw = false;
  try { Command.add({ title: 'no id', run() {} }); } catch (e) { threw = true; }
  ok(threw, 'a command without id is rejected');

  const c = Command.add({ id: 'a', title: 'Alpha', run() {} });
  ok(c.group === 'General', 'group defaults instead of being undefined');
  ok(c.keywords === '', 'keywords default to an empty string');
  ok(c.keys === '', 'keys default to an empty string');

  /* re-registering replaces rather than duplicates: a boot that runs twice
     (or a test that re-initilises) must not double every row */
  Command.add({ id: 'a', title: 'Alpha v2', run() {} });
  ok(Command.list.filter((x) => x.id === 'a').length === 1, 'same id replaces, never duplicates');
  ok(Command.get('a').title === 'Alpha v2', 'the replacement is the live one');

  ok(Command.addAll([{ id: 'b', title: 'B', run() {} }, { id: 'c', title: 'C', run() {} }]) === 2,
    'addAll reports how many it added');
  ok(Command.list.length === 3, 'all three are registered');
}

/* ---------- B. the fuzzy matcher ---------- */
{
  ok(subsequence('renko', 'rnko'), 'subsequence: rnko matches renko');
  ok(subsequence('renko', 'renko'), 'subsequence: an exact string matches');
  ok(!subsequence('renko', 'onkr'), 'subsequence: order matters');
  ok(!subsequence('abc', 'abcd'), 'subsequence: longer query cannot match');

  const mk = (title, keywords = '') => Command.add({ id: 't:' + title, title, keywords, run() {} });

  reset();
  const exact = mk('Renko');
  const prefix = mk('Renko bricks explained');
  const inner = mk('Classic Renko');
  const keyword = mk('Candles', 'includes renko variants');
  const subseq = mk('Range break out');
  const none = mk('Volume profile');

  const sExact = fuzzyScore(exact, 'renko');
  const sPrefix = fuzzyScore(prefix, 'renko');
  const sInner = fuzzyScore(inner, 'renko');
  const sKeyword = fuzzyScore(keyword, 'renko');
  const sSub = fuzzyScore(subseq, 'rnko');
  const sNone = fuzzyScore(none, 'renko');

  ok(sExact > sPrefix, 'exact title beats title prefix', `${sExact} vs ${sPrefix}`);
  ok(sPrefix > sInner, 'prefix beats substring', `${sPrefix} vs ${sInner}`);
  ok(sInner > sKeyword, 'substring beats keyword-only', `${sInner} vs ${sKeyword}`);
  ok(sKeyword > sSub, 'a keyword hit beats a loose subsequence', `${sKeyword} vs ${sSub}`);
  ok(sNone === 0, 'no match scores zero', String(sNone));

  /* The user-visible consequence: typing "renko" must put a Renko command first
     even when 40 other commands exist. */
  reset();
  for (let i = 0; i < 40; i++) Command.add({ id: 'noise:' + i, title: 'Noise ' + i, run() {} });
  Command.add({ id: 'renko-bricks', title: 'Renko bricks explained', run() {} });
  Command.add({ id: 'renko', title: 'Renko', run() {} });
  const hits = Command.search('renko');
  ok(hits[0] && hits[0].id === 'renko', 'searching "renko" ranks the exact command first',
    hits[0] && hits[0].id);
  ok(hits.length === 2, 'only matching commands are returned', String(hits.length));

  /* typos still find it — that is the reason for subsequence matching */
  const typo = Command.search('rnko');
  ok(typo.some((c) => c.id === 'renko'), 'a dropped-vowel typo still finds it');
}

/* ---------- C. empty query = recent first ---------- */
{
  reset();
  Command.addAll([
    { id: 'a', title: 'A', run() {} },
    { id: 'b', title: 'B', run() {} },
    { id: 'c', title: 'C', run() {} },
  ]);
  let list = Command.search('');
  ok(list.map((c) => c.id).join('') === 'abc', 'with no history: registration order', list.map((c) => c.id).join(''));

  Command.run('c');
  Command.run('a');
  list = Command.search('');
  ok(list[0].id === 'a' && list[1].id === 'c', 'most recent first', list.map((c) => c.id).join(''));
  ok(list.length === 3, 'nothing is dropped from the list', String(list.length));
}

/* ---------- D. run() ---------- */
{
  reset();
  let ran = 0;
  Command.add({ id: 'count', title: 'Count', run: () => { ran++; } });
  ok(Command.run('count') === true, 'run() reports success');
  ok(ran === 1, 'the command actually ran');

  ok(Command.run('does-not-exist') === false, 'run() reports an unknown id instead of throwing');

  let threw = false;
  Command.add({ id: 'boom', title: 'Boom', run: () => { throw new Error('nope'); } });
  try { Command.run('boom'); } catch (e) { threw = true; }
  ok(!threw, 'a throwing command does not escape run()');
  ok(Command.recent.includes('boom'), 'a failed command is still remembered (the user tried it)');
}

/* ---------- E. recency bookkeeping ---------- */
{
  reset();
  for (let i = 0; i < 15; i++) Command.add({ id: 'c' + i, title: 'C' + i, run() {} });
  for (let i = 0; i < 15; i++) Command.run('c' + i);

  ok(Command.recent.length === 10, 'recency is capped at 10', String(Command.recent.length));
  ok(Command.recent[0] === 'c14', 'the newest run is first', Command.recent[0]);
  ok(!Command.recent.includes('c0'), 'the oldest runs fall off the end');

  /* re-running an existing entry moves it to the front instead of duplicating */
  Command.run('c14');
  ok(Command.recent.filter((x) => x === 'c14').length === 1, 're-running does not duplicate');
  Command.run('c10');
  ok(Command.recent[0] === 'c10', 're-running moves it to the front', Command.recent[0]);

  const stored = JSON.parse(globalThis.localStorage.getItem('mt5_cmd_recent') || '[]');
  ok(Array.isArray(stored) && stored[0] === 'c10', 'recency is persisted under mt5_cmd_recent', JSON.stringify(stored));
}

console.log(`\nROUND305 palette: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
