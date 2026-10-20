import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_helper_round32 import open_app
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    errs = []
    cons = []
    b, page = open_app(pw)
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: cons.append(m.type + ':' + m.text[:120]) if m.type in ('error','warning') else None)
    page.evaluate("sessionStorage.setItem('mt5Logout','1')")
    page.reload()
    page.wait_for_selector('#login-screen:not(.hidden)', timeout=15000)
    page.wait_for_timeout(2500)
    print('SRV-HTML:', page.evaluate("() => document.getElementById('srv-list').innerHTML")[:300])
    print('SCAN-VISIBLE:', page.evaluate("() => !document.getElementById('srv-scan').classList.contains('hidden')"))
    print('PAGEERRORS:', errs[:3])
    print('CONSOLE:', cons[:5])
    # probe the provider directly from the page
    print('WS-PROBE:', page.evaluate("""() => new Promise((res) => {
      try {
        const ws = new WebSocket('ws://127.0.0.1:8777');
        const t = setTimeout(() => { try { ws.close(); } catch(e){}; res('TIMEOUT'); }, 4000);
        ws.onopen = () => ws.send(JSON.stringify({type:'servers',req_id:'d1'}));
        ws.onmessage = (ev) => { clearTimeout(t); res('REPLY:' + ev.data.slice(0,160)); try { ws.close(); } catch(e){} };
        ws.onerror = () => { clearTimeout(t); res('WS-ERROR'); };
      } catch (e) { res('EXC:' + e.message); }
    })"""))
    b.close()
