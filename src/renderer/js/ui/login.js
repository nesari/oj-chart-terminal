/**
 * Login screen + saved accounts + in-app account menu
 *
 * @module ui/login
 */

import { Log } from '../../../core/logger.js';
import { icon } from './icons.js';
import { App } from '../../../core/state.js';
import { Feed } from '../../../core/feed.js';
import { onAppReady } from '../app.js';

let mode = 'demo';
  let ACC = { accounts: [], last: '' }; // persisted via main (safeStorage at rest)
  let cameFromAdd = false; // opened the login screen via "+ Add another account"
  /* ROUND122: detached-window (solo) mode — index.html#solo=<id>. A solo
     window NEVER shows the login screen when it can help it and NEVER
     restarts the provider: it attaches to the identity main.js reports. */
  const SOLO = /solo=[\w-]+/.test(location.hash || '');

  function accId(mode, login, server) {
    return mode + ':' + String(login || '').trim() + ':' + String(server || '').trim();
  }
  function accLabel(a) {
    if (a.mode === 'demo') return 'Demo Server';
    return (a.login || '?') + ' · ' + (a.server || 'no server');
  }
  function hasApi() { return window.electronAPI && window.electronAPI.accountsLoad; }
  async function persist() {
    if (!hasApi()) return;
    try { await window.electronAPI.accountsSave(ACC); } catch (e) { Log.warn('auth', 'account list save failed', e) }
  }

  /* ---------- login screen ---------- */
  function init() {
    const params = new URLSearchParams(location.search);
    if (params.get('mode') === 'mt5') mode = 'mt5';

    // one-shot flag: the user clicked "+ Add another account" from inside the
    // app -> show the login screen WITHOUT killing the session, with a way back
    cameFromAdd = sessionStorage.getItem('mt5ShowLogin') === '1';
    sessionStorage.removeItem('mt5ShowLogin');
    const back = document.getElementById('login-back');
    if (back) {
      back.classList.toggle('hidden', !cameFromAdd);
      back.addEventListener('click', () => { location.reload(); }); // auto-login restores the app
    }

    const cardDemo = document.getElementById('card-demo');
    const cardMt5 = document.getElementById('card-mt5');
    document.getElementById('pc-demo-icon').innerHTML = icon('server');
    document.getElementById('pc-mt5-icon').innerHTML = icon('mt5');

    const apply = () => {
      cardDemo.classList.toggle('selected', mode === 'demo');
      cardMt5.classList.toggle('selected', mode === 'mt5');
      document.getElementById('mt5-fields').classList.toggle('hidden', mode !== 'mt5');
      /* ROUND84 (user request): the login "Chart refresh rate" box was removed.
         The persisted mt5_refresh_rate value is STILL honored — savedRefreshRate()
         feeds it to startProvider below (scan + connect); the knob itself lives
         in the in-app broker-servers menu (toolbar.js). */
    };
    cardDemo.addEventListener('click', () => { mode = 'demo'; apply(); });
    cardMt5.addEventListener('click', () => { mode = 'mt5'; apply(); refreshMt5Status(); });
    apply();
    initMt5Hint(apply);
    if (mode === 'mt5') refreshMt5Status();

    // show / hide password
    const eye = document.getElementById('pw-eye');
    const pw = document.getElementById('mt5-password');
    const drawEye = () => { eye.innerHTML = icon(pw.type === 'password' ? 'eye' : 'eyeoff'); };
    eye.addEventListener('click', () => {
      pw.type = pw.type === 'password' ? 'text' : 'password';
      drawEye();
      pw.focus();
    });
    drawEye();

    /* ROUND56: in-app server switch (bottom-bar popup, toolbar.js) —
       login.js owns the saved accounts, so the re-point lives here.
       ROUND122: blocked in a detached window — re-pointing (and thus
       RESTARTING) the provider would kill the host window's session. */
    window.addEventListener('mt5-switch-server', (e) => {
      if (SOLO) return;
      if (e && e.detail) switchServer(String(e.detail));
    });
    try { /* server picked in-app for a session that isn't remembered */
      const sw = sessionStorage.getItem('mt5_srv_switch');
      if (sw) { document.getElementById('mt5-server').value = sw; sessionStorage.removeItem('mt5_srv_switch'); }
    } catch (e) { Log.warn('auth', 'login init failed', e) }

    document.getElementById('login-connect').addEventListener('click', connect);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !document.getElementById('login-screen').classList.contains('hidden')) {
        if (['input'].includes((e.target.tagName || '').toLowerCase()) && e.target.id !== 'mt5-path') connect();
      }
    });

    if (window.electronAPI && window.electronAPI.onProviderLog) {
      window.electronAPI.onProviderLog((msg) => {
        const line = String(msg).split('\n')[0].slice(0, 140);
        try { Log && Log.error('provider', line); } catch (e) {} // round 28: provider failures reach the diagnostics log
        const st = document.getElementById('login-status');
        if (st && !document.getElementById('login-screen').classList.contains('hidden')) {
          st.classList.add('error');
          st.textContent = line;
        }
      });
    }

    initAccounts();
    initAccMenu();
  }

  /* ---------- MT5 terminal detection (login guidance) ----------
   * The Python provider can only reach a LOCALLY INSTALLED MetaTrader 5
   * terminal. Detection is advisory: a false negative never blocks the
   * manual path field, and Demo mode always works without any terminal. */
  let mt5Status = { installed: false, checked: false, hint: '', path: '', supported: true };

  async function refreshMt5Status() {
    const box = document.getElementById('mt5-hint');
    const text = document.getElementById('mt5-hint-text');
    const api = window.electronAPI;
    if (!box || !text || !api || !api.mt5Status) return mt5Status;
    const pathEl = document.getElementById('mt5-path');
    let st = null;
    try {
      st = await api.mt5Status({ path: (pathEl && pathEl.value.trim()) || '' });
    } catch (e) {
      Log.warn('mt5', 'terminal detection failed', e);
      return mt5Status;
    }
    if (!st) return mt5Status;
    mt5Status = Object.assign({}, st, { checked: true });
    box.classList.toggle('hidden', !!st.installed);
    if (st.installed) {
      /* Remember the detected exe in the placeholder, never as a value: the
         provider falls back to its own default when the field stays empty. */
      if (pathEl && !pathEl.value.trim() && st.path) pathEl.placeholder = st.path;
      return mt5Status;
    }
    text.textContent = st.hint || 'MetaTrader 5 terminal not found. Install it from your broker, '
      + 'pick its terminal64.exe, or keep using the built-in Demo data.';
    /* On non-Windows systems a local terminal cannot exist at all, so the
       download and picker buttons would only send the user in circles. */
    for (const id of ['mt5-download', 'mt5-choose']) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', st.supported === false);
    }
    return mt5Status;
  }

  function initMt5Hint(apply) {
    const dl = document.getElementById('mt5-download');
    const choose = document.getElementById('mt5-choose');
    const recheck = document.getElementById('mt5-recheck');
    const demo = document.getElementById('mt5-demo');
    const pathEl = document.getElementById('mt5-path');

    if (dl) dl.addEventListener('click', () => {
      const api = window.electronAPI;
      if (api && api.mt5OpenDownload) { api.mt5OpenDownload(); return; }
      const st = document.getElementById('login-status');
      if (st) st.textContent = 'Download MetaTrader 5 from your broker or https://www.metatrader5.com/en/download';
    });
    if (choose) choose.addEventListener('click', async () => {
      const api = window.electronAPI;
      if (!api || !api.mt5PickTerminal) return;
      try {
        const r = await api.mt5PickTerminal();
        if (r && r.ok && r.path && pathEl) {
          pathEl.value = r.path;
          await refreshMt5Status();
        }
      } catch (e) { Log.warn('mt5', 'terminal picker failed', e); }
    });
    if (recheck) recheck.addEventListener('click', () => { refreshMt5Status(); });
    if (demo) demo.addEventListener('click', () => { mode = 'demo'; apply(); });
    if (pathEl) pathEl.addEventListener('change', () => { refreshMt5Status(); });
  }

  /* ---------- ROUND97 (user request): login-screen server scan removed ----------
   * The #srv-scan box (Network Rescan + access-server list with pings) was
   * removed from the login form. The SAME feature stays available where it
   * belongs: the in-app broker-servers menu (bottom bar, toolbar.js) owns
   * pings, rescan and switching now. The dead ROUND55 chain (SRV_IC,
   * srvToken/srvManual/srvScanned, srvSavedDemo, srvTier, renderServers,
   * scanServers, applyServerScan) was deleted with the markup.
   * switchServer() and savedRefreshRate() REMAIN: the in-app server switch
   * (mt5-switch-server event) and the connect path still use them. */

  function savedRefreshRate() {
    try {
      const v = parseFloat(localStorage.getItem('mt5_refresh_rate'));
      return isFinite(v) && v > 0 ? v : 0.2;
    } catch (e) { return 0.2; }
  }
  /* ROUND84 (user request): the login refresh-rate UI (applyRefreshRateBox /
     initRefreshRate / saveRefreshRate) was removed with its #refresh-rate-box
     markup — the in-app servers menu (toolbar.js) stays the single owner of
     that setting; savedRefreshRate() above remains the read path for the
     provider spawn arguments. */

  /* ---------- saved accounts ---------- */
  async function initAccounts() {
    if (hasApi()) {
      try { ACC = await window.electronAPI.accountsLoad(); } catch (e) {}
    }
    renderSaved();
    maybeAutoLogin();
  }

  function renderSaved() {
    const box = document.getElementById('saved-accounts');
    if (!box) return;
    box.innerHTML = '';
    if (!ACC.accounts.length) return;
    const t = document.createElement('div');
    t.className = 'sa-title';
    t.textContent = 'SAVED ACCOUNTS';
    box.appendChild(t);
    for (const a of ACC.accounts) {
      const chip = document.createElement('div');
      chip.className = 'acc-chip' + (a.id === ACC.last ? ' active' : '');
      const tag = document.createElement('span');
      tag.className = 'acc-tag' + (a.mode === 'mt5' ? ' mt5' : '');
      tag.textContent = a.mode === 'mt5' ? 'MT5' : 'DEMO';
      const lbl = document.createElement('span');
      lbl.textContent = accLabel(a) + (a.pw ? '' : ' · password required');
      const x = document.createElement('button');
      x.className = 'acc-x'; x.title = 'Forget this account'; x.textContent = '×';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        ACC.accounts = ACC.accounts.filter((z) => z.id !== a.id);
        if (ACC.last === a.id) ACC.last = ACC.accounts.length ? ACC.accounts[0].id : '';
        persist(); renderSaved();
      });
      chip.appendChild(tag); chip.appendChild(lbl); chip.appendChild(x);
      chip.addEventListener('click', () => fillFrom(a));
      box.appendChild(chip);
    }
  }

  function fillFrom(a) {
    mode = a.mode === 'mt5' ? 'mt5' : 'demo';
    document.getElementById('card-demo').classList.toggle('selected', mode === 'demo');
    document.getElementById('card-mt5').classList.toggle('selected', mode === 'mt5');
    document.getElementById('mt5-fields').classList.toggle('hidden', mode !== 'mt5');
    document.getElementById('mt5-login').value = a.login || '';
    document.getElementById('mt5-password').value = a.pw || '';
    document.getElementById('mt5-server').value = a.server || '';
    document.getElementById('mt5-path').value = a.path || '';
    document.getElementById('mt5-remember').checked = true;
    renderSaved();
  }

  function rememberCurrent(creds) {
    const remember = document.getElementById('mt5-remember').checked;
    const id = accId(mode, creds.login, creds.server);
    if (!remember) {
      ACC.accounts = ACC.accounts.filter((z) => z.id !== id);
      if (ACC.last === id) ACC.last = '';
      persist(); renderSaved();
      return;
    }
    const acc = {
      id, mode, login: creds.login || '', server: creds.server || '',
      path: creds.path || '', pw: creds.password || '',
      label: mode === 'demo' ? 'Demo Server' : (creds.login + (creds.server ? ' · ' + creds.server : '')),
      ts: Date.now(),
    };
    const i = ACC.accounts.findIndex((z) => z.id === id);
    if (i >= 0) ACC.accounts[i] = acc; else ACC.accounts.push(acc);
    ACC.last = id;
    persist(); renderSaved();
  }

  async function maybeAutoLogin() {
    if (cameFromAdd) return; // adding an account: stay on the login screen
    if (sessionStorage.getItem('mt5Logout') === '1') return; // explicit logout this session
    /* ROUND122: a detached window attaches to the RUNNING provider identity
       (reported by main) — same account as the host, zero restarts. */
    if (SOLO) { await soloAutoLogin(); return; }
    if (!ACC.last || !hasApi()) return;
    const a = ACC.accounts.find((z) => z.id === ACC.last);
    if (!a) return;
    if (a.mode === 'mt5' && !a.pw) return; // never auto-submit without the saved password
    fillFrom(a);
    connect();
  }

  /* ROUND122 · solo auto-login. Resolution order:
     1. main reports the RUNNING provider identity -> log into THAT (the
        host's session can never be restarted or switched from here);
     2. no provider up (host crashed) -> the saved last account;
     3. nothing resolvable -> the login screen stays (manual login). */
  async function soloAutoLogin() {
    try {
      let id = null;
      try { if (window.mt5Tabs && window.mt5Tabs.providerIdentity) id = await window.mt5Tabs.providerIdentity(); } catch (e) {}
      if (hasApi()) { try { ACC = await window.electronAPI.accountsLoad(); } catch (e) { Log.warn('auth', 'account list load failed', e) } }
      let a = null;
      if (id && id.mode === 'mt5') {
        a = ACC.accounts.find((z) => z.mode === 'mt5' && String(z.login) === String(id.login) &&
          String(z.server || '') === String(id.server || '') && z.pw) || null;
      } else if (id && id.mode === 'demo') {
        a = { mode: 'demo', login: '', server: '', path: '', pw: '' };
      } else {
        a = (ACC.last && ACC.accounts.find((z) => z.id === ACC.last)) || null;
        if (a && a.mode === 'mt5' && !a.pw) a = null;
      }
      if (!a) return; // login screen stays for manual credentials
      fillFrom(a);
      connect();
    } catch (e) {
      try { Log && Log.warn('login', 'solo auto-login failed', { error: String(e && e.message || e) }); } catch (er) {}
    }
  }

  /* ---------- ROUND56: in-app server switch (bottom-bar popup) ----------
   * Re-points the CURRENT MT5 account to the picked access server and lets
   * the boot auto-login reconnect for real: main.js sees a different
   * provider identity (server changed) and restarts the bridge against the
   * new server. A session that isn't remembered falls back to a prefilled
   * Server field on the login screen. */
  async function switchServer(name) {
    const id = (App.currentAcc && App.currentAcc.id) || ACC.last;
    const a = ACC.accounts.find((z) => z.id === id);
    if (a && a.mode === 'mt5') {
      a.server = name;
      a.id = accId(a.mode, a.login, a.server);
      a.label = (a.login || '?') + ' \u00b7 ' + a.server;
      ACC.last = a.id;
      await persist();
    } else {
      try { sessionStorage.setItem('mt5_srv_switch', name); } catch (e) {}
      ACC.last = '';
      await persist();
    }
    location.reload();
  }

  /* ---------- connect ---------- */
  async function connect() {
    const btn = document.getElementById('login-connect');
    const st = document.getElementById('login-status');
    btn.disabled = true;
    st.classList.remove('error');
    st.textContent = 'Starting data provider…';
    const creds = {
      login: document.getElementById('mt5-login').value.trim(),
      password: document.getElementById('mt5-password').value,
      server: document.getElementById('mt5-server').value.trim(),
      path: document.getElementById('mt5-path').value.trim(),
    };
    const prev = App && App.lastMt5;
    const force = mode === 'mt5' && !!(prev && (prev.login !== creds.login || prev.server !== creds.server));
    try {
      /* round 28: connection attempt is logged WITHOUT the password — only
         non-secret identity fields are included */
      try { Log && Log.info('login', 'connect attempt', { mode, login: mode === 'mt5' ? creds.login : undefined, server: creds.server || undefined, force }); } catch (e) {}
      if (window.electronAPI) {
        /* F8.6: do not spawn the Python provider when no Windows MT5 terminal
           exists and the user did not point at one — the provider would only
           fail with an opaque IPC error. Demo mode skips this entirely. */
        if (mode === 'mt5') {
          const mt5st = await refreshMt5Status();
          if (mt5st && mt5st.checked && !mt5st.installed) {
            st.classList.add('error');
            st.textContent = mt5st.hint || 'MetaTrader 5 terminal not found — install it, pick terminal64.exe, or use Demo data.';
            btn.disabled = false;
            return;
          }
        }
        const r = await window.electronAPI.startProvider({ mode, ...creds, force, tickInterval: savedRefreshRate() });
        if (!r || !r.ok) throw new Error((r && r.error) || 'Provider failed to start');
      }
      st.textContent = 'Connecting…';
      if (!App.feed) App.feed = new Feed();
      if (!App.feed.connected) await App.feed.connect();
      await App.feed.login(mode, creds);
      st.textContent = 'Connected';
      sessionStorage.removeItem('mt5Logout');
      sessionStorage.removeItem('mt5ShowLogin');
      if (mode === 'mt5') App.lastMt5 = { login: creds.login, server: creds.server };
      /* AUDIT FIX (reconnect): the reconnect loop needs the ACTUAL MT5
         credentials; the old object only carried mode/label/id, so every
         reconnect sent `login('demo', {})` and an MT5 session stayed dead.
         Password lives in memory only — it is never logged or re-saved
         here (the saved-account store keeps its own copy). */
      App.currentAcc = {
        mode,
        label: mode === 'demo' ? 'Demo Server' : (creds.login + (creds.server ? ' · ' + creds.server : '')),
        id: accId(mode, creds.login, creds.server),
        login: creds.login,
        server: creds.server,
        password: creds.password,
        path: creds.path,
      };
      rememberCurrent(creds);
      document.getElementById('login-screen').classList.add('hidden');
      bootApp();
    } catch (e) {
      try { Log && Log.fromError(e, 'login', { mode, stage: 'connect' }); } catch (er) {}
      st.classList.add('error');
      st.textContent = e.message || 'Connection failed';
      btn.disabled = false;
    }
  }

  function bootApp() {
    document.getElementById('app').classList.remove('hidden');
    const lbl = (App.currentAcc && App.currentAcc.label) || 'Connected';
    document.getElementById('conn-label').textContent = lbl;
    document.querySelector('#conn-status .dot').className = 'dot green';
    if (onAppReady) onAppReady();
  }

  /* ---------- in-app account menu (switch / logout / forget) ---------- */
  function initAccMenu() {
    const menu = document.getElementById('acc-menu');
    const chip = document.getElementById('conn-status');
    if (!menu || !chip) return;
    let open = false;

    function close() { menu.classList.remove('open'); open = false; }
    document.addEventListener('mousedown', (e) => { if (open && !menu.contains(e.target)) close(); });

    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (open) { close(); return; }
      const cur = (App && App.currentAcc) || { mode: 'demo', label: 'Demo Server' };
      menu.innerHTML = '';

      const head = document.createElement('div');
      head.className = 'am-cur';
      head.innerHTML = '<b>' + (cur.label || 'Connected') + '</b><div class="am-sub">' +
        (cur.mode === 'mt5' ? 'MetaTrader 5 account' : 'Simulated demo data') + '</div>';
      menu.appendChild(head);

      for (const a of ACC.accounts) {
        if (a.id === cur.id) continue;
        const b = document.createElement('button');
        b.className = 'am-item';
        b.innerHTML = '<span class="acc-tag' + (a.mode === 'mt5' ? ' mt5' : '') + '">' +
          (a.mode === 'mt5' ? 'MT5' : 'DEMO') + '</span> ' + accLabel(a) + (a.pw ? '' : ' · password');
        b.addEventListener('click', () => {
          ACC.last = a.id;
          // switching accounts must always auto-login on boot, even if this
          // session had an explicit logout earlier
          sessionStorage.removeItem('mt5Logout');
          persist().then(() => location.reload()); // boot auto-logs into the chosen account
        });
        menu.appendChild(b);
      }

      const add = document.createElement('button');
      add.className = 'am-item am-add';
      add.textContent = '+ Add another account';
      add.addEventListener('click', () => {
        // first time: enter the new account's credentials on the login
        // screen (with Back to chart); afterwards it joins the list above
        sessionStorage.setItem('mt5ShowLogin', '1');
        location.reload();
      });
      /* ROUND122: a detached window manages no accounts — no add/logout rows */
      if (!SOLO) menu.appendChild(add);

      const sep = document.createElement('div');
      sep.className = 'am-sep';
      if (!SOLO) menu.appendChild(sep);

      const logout = document.createElement('button');
      logout.className = 'am-item';
      logout.textContent = 'Log out';
      logout.addEventListener('click', () => {
        sessionStorage.setItem('mt5Logout', '1');
        location.reload(); // back to the login screen, no auto-login
      });
      if (!SOLO) menu.appendChild(logout);

      const forget = document.createElement('button');
      forget.className = 'am-item danger';
      forget.textContent = 'Log out & forget this account';
      forget.addEventListener('click', () => {
        ACC.accounts = ACC.accounts.filter((z) => z.id !== cur.id);
        ACC.last = ACC.accounts.length ? ACC.accounts[0].id : '';
        sessionStorage.setItem('mt5Logout', '1');
        persist().then(() => location.reload());
      });
      if (!SOLO) menu.appendChild(forget);

      const r = chip.getBoundingClientRect();
      menu.style.top = (r.bottom + 8) + 'px';
      menu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
      menu.classList.add('open');
      open = true;
    });
  }

  /* AUDIT FIX (reconnect, frozen provider): Feed's stall watchdog closes a
     socket whose provider loop stopped answering, but reconnecting cannot
     heal a wedged Python process — the port is still open, so every handshake
     times out and the app sits Offline forever. A detached window never does
     this (the host owns the provider). */
  async function restartProvider(acc) {
    if (SOLO || !acc) return false;
    if (!window.electronAPI || !window.electronAPI.startProvider) return false;
    try {
      const r = await window.electronAPI.startProvider({
        mode: acc.mode === 'mt5' ? 'mt5' : 'demo',
        login: acc.login || '',
        password: acc.password || '',
        server: acc.server || '',
        path: acc.path || '',
        force: true,
        tickInterval: savedRefreshRate(),
      });
      return !!(r && r.ok);
    } catch (e) {
      try { Log.warn('feed', 'provider restart failed', { error: String(e && e.message || e) }); } catch (er) {}
      return false;
    }
  }

const LoginUI = { init, bootApp, switchServer, restartProvider };
export { LoginUI };
