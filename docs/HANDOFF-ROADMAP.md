# نقشه راه پیاده‌سازی — از وضعیت فعلی تا «آماده توسعه»

> این سند برای انتقال کانتکست به یک چت جدید نوشته شده است. در چت جدید فقط کافی است بنویسی:
> «فایل `docs/HANDOFF-ROADMAP.md` را بخوان و از فاز ۰ شروع کن.»
> هر تسک مستقل است: انجام → تست → commit → تسک بعدی.

---

## ۰) کانتکست تأییدشده (وضعیت لحظه‌ی نوشتن این سند)

**پروژه:** `mt5-chart-terminal` — ترمینال چارت‌ینگ سبک TradingView روی Electron + پرووایدر Python (MT5 یا دمو).

| مورد | مقدار |
|---|---|
| مسیر | `C:\Users\amirh\Desktop\test` |
| نسخه | `1.9.212` (package.json) |
| Node | `v26.8.1` |
| Python | `3.14.7` |
| Electron | `33.4.11` (نصب‌شده در node_modules) |
| Git | نصب است (`2.54.0`)، اما **پروژه repo نیست** |
| کد | ۹۲ فایل، ~۵۸٬۵۰۰ خط (بدون node_modules و vendor) |
| scripts/ | ۳۸۲ فایل، بدون ساختار پوشه‌ای |
| docs/ | ۱۰۳ فایل |

**نتایج تست‌های واقعی که قبلاً اجرا شد (baseline):**

- `node --check` روی همه‌ی ۸۲ فایل JS/MJS → ✅ پاس
- `python -m py_compile` روی ۴ فایل پرووایدر → ✅ پاس
- اسکن گراف ایمپورت (۸۲ ماژول) → ✅ ۰ ایمپورت گم‌شده
- اجرای زنده‌ی `provider/demo.py` + کلاینت ws → ✅ `pong` + ۵۰ کندل + ۶ سرور
- بوت UI در مرورگر هدلس (Edge) با ورود دمو → ✅ چارت رندر شد، **۰ خطای کنسول، ۰ درخواست ناموفق**
- بازرسی `assets/app.ico` → ✅ ۱۰ سایز (۱۶…۲۵۶)

**نقشه‌ی فایل‌های کلیدی:**

```
main.js                     main process (IPC، پرووایدر، لاگ، امنیت پنجره)
preload.js                  پل contextBridge
provider/provider_common.py سرور ws مشترک + تقویم خبری
provider/demo.py            پرووایدر دمو
provider/mt5.py             پل MT5
provider/chart_cache.py     کش کندل
src/core/                   لایه‌ی مستقل از پلتفرم (feed, indicators, state, pine/*)
src/renderer/js/app.js      تنها entry رندرر
src/renderer/js/chart/      manager, tabs, toolbar, pine-*
src/renderer/js/drawing/    engine, tools, tools2, settings, ui
src/renderer/js/trade/      dock, ticket, oneclick, overlay, ...
```

---

## ۱) قواعد اجرا (برای چت جدید)

1. **بعد از هر تسک، یک commit** با پیام `F<شماره>: <توضیح>`.
2. اگر تسک تست/معیار پذیرش را پاس نکرد، تسک بعدی شروع نشود.
3. تغییرات «حرکت خالص» (refactor) و «تغییر رفتار» (fix) هرگز در یک commit نباشند.
4. خط‌شماره‌ها بعد از هر تغییر جابه‌جا می‌شوند؛ برای پیدا کردن محل، از **رشته‌ی کد** (search) استفاده کن، نه شماره‌ی خط.
5. هیچ فایلی بدون `git rm`/`git mv` حذف/جابه‌جا نشود (تاریخچه حفظ شود).

---

## ۲) خلاصه‌ی اولویت‌بندی

| فاز | عنوان | اولویت | چرا این ترتیب |
|---|---|---|---|
| ۰ | تور نجات (git) | **P0** | بدون آن هیچ تغییری قابل بازگشت نیست |
| ۱ | باگ‌های امنیتی/درستی | **P0/P1** | دیف کوچک، اثر واقعی، ریسک کم |
| ۲ | دروازه‌ی کیفیت (CI) | **P1** | قبل از هر refactor باید تست خودکار داشته باشیم |
| ۳ | بهداشت مخزن | **P2** | کاهش نویز؛ بعد از CI امن است |
| ۴ | قابلیت نگهداری | **P3** | بزرگ‌ترین ریسک بلندمدت، ولی پرریسک‌ترین تغییر |
| ۵ | مستندسازی | **P2 موازی** | ارزان، اثر زیاد روی onboarding |
| ۶ | پولیش چندپلتفرمی | **P3** | وابسته به فاز ۱ (آیکون/چرخه‌ی عمر) |
| ۷ | آماده‌ی انتشار | **P3** | آخرین حلقه |

> ترتیب اجرای پیشنهادی: **۰ → ۱ → ۲ → ۵ → ۳ → ۴ → ۶ → ۷**
> (۵ ارزان است و می‌تواند هم‌زمان با ۲ انجام شود.)

---

## ۳) جزئیات تسک‌ها

### فاز ۰ — تور نجات (P0)

#### F0.1 — راه‌اندازی Git + .gitignore
- **چه:** `git init`، ساخت `.gitignore`، اولین commit.
- **محتوی `.gitignore` پیشنهادی:**
  ```gitignore
  node_modules/
  dist/
  __pycache__/
  *.pyc
  *.log
  .DS_Store
  Thumbs.db
  docs/_smoke.png
  ```
- **معیار پذیرش:** `git status` تمیز؛ `git ls-files` هیچ مسیری از `node_modules` یا `__pycache__` ندارد.
- **تست:** `git ls-files | Select-String node_modules` → خروجی خالی.

#### F0.2 — تگ baseline
- **چه:** `git tag v1.9.212-baseline`
- **چرا:** نقطه‌ی بازگشت قبل از هر تغییر.

---

### فاز ۱ — باگ‌های امنیتی و درستی (P0/P1)

#### F1.1 — [P0] منطق `setPermissionCheckHandler` برعکس است
- **فایل:** `main.js` → تابع `hardenPermissions`
- **کد فعلی:**
  ```js
  session.setPermissionCheckHandler((wc, permission) => DENIED_PERMISSIONS.has(String(permission)));
  ```
- **مشکل:** طبق `node_modules/electron/electron.d.ts`: «Returning `true` will allow the permission». یعنی دقیقاً مجوزهای لیست‌شده **granted** می‌شوند.
- **تغییر:** `return false;` (همه‌ی checkها رد شوند). اگر روزی مجوزی لازم شد، لیست allow بساز.
- **معیار پذیرش:** در DevTools (فقط dev build) `navigator.permissions.query({name:'geolocation'})` مقدار `denied` بدهد.

#### F1.2 — [P1] AppUserModelID در بیلد پکیج‌شده
- **فایل:** `main.js` → داخل `app.whenReady()`
- **کد فعلی:**
  ```js
  app.setAppUserModelId(process.platform === 'win32' ? process.execPath : 'OJChart Notification');
  ```
- **تغییر:**
  ```js
  const aumid = app.isPackaged ? 'com.ojchart.terminal' : process.execPath;
  app.setAppUserModelId(process.platform === 'win32' ? aumid : 'OJChart Notification');
  ```
- **معیار پذیرش:** در حالت dev تغییری نباشد؛ در بیلد، آیکون taskbar و توست با شورتکات نصب‌شده گروه شوند.

#### F1.3 — [P1] نسخه‌ی hardcode شده
- **فایل:** `main.js` → `mlogEvent('info', 'app', 'main boot', { version: '1.9.212', ... })`
- **تغییر:** `version: app.getVersion()`
- **معیار پذیرش:** تغییر نسخه در `package.json` بدون لمس `main.js` در لاگ دیده شود.

#### F1.4 — [P1] حذف `__pycache__` از بیلد
- **فایل:** `package.json` → `build.files`
- **تغییر:** افزودن `"!provider/__pycache__/**"`
- **معیار پذیرش:** `npm run dist:win` و بررسی محتوای `app.asar` → هیچ `.pyc` نباشد.

#### F1.5 — [P1] آیکون macOS/Linux
- **فایل:** `package.json` → `build.mac.icon` و `build.linux.icon`
- **مشکل:** مسیر `assets/logo.png` **وجود ندارد**؛ و `src/renderer/assets/logo.png` فقط ۲۸۲×۲۶۷ است (حداقل ۵۱۲×۵۱۲ لازم است).
- **تغییر:**
  1. ساخت `assets/icon-1024.png` (مربع، ۱۰۲۴×۱۰۲۴) از همان لوگو.
  2. `"icon": "assets/icon-1024.png"` برای mac و linux.
  3. (اختیاری) ساخت `.icns` و `.png` ست‌های سایز برای کیفیت بهتر.
- **معیار پذیرش:** `npm run dist:linux` بدون هشدار آیکون اجرا شود (روی ویندوز فقط تا مرحله‌ی packaging تست شود).

#### F1.6 — [P1] چرخه‌ی عمر پنجره/رندرر
- **فایل:** `main.js` → انتهای فایل
- **تغییرات:**
  ```js
  app.on('render-process-gone', (e, wc, details) => { mlogEvent('error','error','renderer gone', details); });
  app.on('child-process-gone', (e, details) => { mlogEvent('error','error','child gone', details); });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  ```
  و اصلاح:
  ```js
  app.on('window-all-closed', () => {
    stopProvider();
    if (process.platform !== 'darwin') app.quit();
  });
  ```
- **معیار پذیرش:** کشتن رندرر از Task Manager → رکورد `renderer gone` در `%APPDATA%/mt5-chart-terminal/logs/` ثبت شود.

#### F1.7 — [P1] تزریق HTML با symbol بروکر
- **فایل:** `src/renderer/js/chart/compare.js`
- **محل‌ها:** `chip.innerHTML = `<i></i>${c.symbol}`` و `` it.innerHTML = `<span class="ic">■</span><span>${c.symbol}</span>` ``
- **تغییر:** ساخت DOM با `textContent` (الگوی بقیه‌ی فایل که `U.el` + `textContent` است).
- **اضافه:** grep برای `innerHTML.*\$\{` در `panels/` و `trade/` و رفع مواردی که داده‌ی خارجی (symbol/نام حساب/پیام بروکر) تزریق می‌شود.
- **معیار پذیرش:** هیچ `innerHTML` با متغیر داده‌ی خارجی بدون `U.esc` باقی نماند.

#### F1.8 — [P1] تصحیح README (سریع، اثر زیاد)
- **فایل:** `README.md`
- **موارد:**
  - خط «No trading — data and analysis only.» ❌ → استک معامله وجود دارد (`trade/*`, `panels/tester.js`).
  - «Chat and news remain excluded» ❌ → `panels/news.js` وجود دارد.
  - «v1.6.0» → نسخه‌ی واقعی.
  - دو دستور ناموجود: `scripts/check_esm.sh` و `scripts/audit_imports.py`.
- **معیار پذیرش:** هر ادعای README با یک فایل واقعی قابل اثبات باشد.

---

### فاز ۲ — دروازه‌ی کیفیت (P1)

#### F2.1 — اسکریپت‌های npm
- **فایل:** `package.json`
- **افزودن:**
  ```json
  "verify": "npm run check:syntax && npm run check:imports && npm run check:py && npm run smoke",
  "check:syntax": "node scripts/checks/check-syntax.mjs",
  "check:imports": "node scripts/checks/check-imports.mjs",
  "check:py": "node scripts/checks/check-python.mjs",
  "smoke": "node scripts/checks/smoke-boot.mjs",
  "test": "npm run verify"
  ```

#### F2.2 — پیاده‌سازی چهار check
- `check-syntax.mjs`: `node --check` روی همه‌ی `*.js|*.mjs` به‌جز `node_modules` و `vendor`.
- `check-imports.mjs`: پارس `import ... from '...'` و بررسی وجود فایل (منطق آماده است: ۸۲ ماژول، ۰ خطا).
- `check-python.mjs`: `python -m py_compile` روی `provider/*.py` با هندل تفاوت `python`/`python3`.
- `smoke-boot.mjs`: راه‌اندازی `provider/demo.py` روی پورت تست + سرو `src/` + بوت هدلس + کلیک `#card-demo`/`#login-connect` + assert: `#app` visible، `#login-screen` hidden، `canvas > 0`، `console errors == 0`.
  > نکته: Playwright مرورگر نصب ندارد؛ از `channel: "msedge"` استفاده شد و کار کرد. اگر Edge نبود، fallback به Electron.
- **معیار پذیرش:** `npm run verify` روی ویندوز سبز شود.

#### F2.3 — CI
- **فایل جدید:** `.github/workflows/ci.yml`
- **محتوی:** matrix `windows-latest` (اصلی) + `ubuntu-latest` (فقط syntax/imports، بدون smoke).
- **معیار پذیرش:** push → workflow سبز.

#### F2.4 — ثبت harness
- اسکریپت smoke که در بازبینی نوشته شد (پورت ۸۸۸۸/۸۸۹۹، خروجی `docs/_smoke.png`) را با پاکسازی (بدون مسیر مطلق، بدون وابستگی به Edge) داخل `scripts/checks/` کامیت کن.

---

### فاز ۵ — مستندسازی (P2، قابل اجرا به‌موازات فاز ۲)

#### F5.1 — بازنویسی README
- ساختار پیشنهادی: معرفی → پیش‌نیازها → اجرا → قابلیت‌ها (شامل معامله/تستر/ریپلی/اخبار) → معماری → تست و CI → عیب‌یابی → امنیت → بیلد.

#### F5.2 — `docs/ARCHITECTURE.md`
- نقشه‌ی واقعی: لایه‌ی core / renderer / platform، مرزهای مجاز (قاعده‌ی «core بدون DOM»)، جریان داده (provider → feed → state → chart)، قرارداد IPC.

#### F5.3 — آرشیو مستندات راند‌ها
- `docs/FEATURE-ROUND*.md` و `BUGFIX-ROUND*.md` (بیش از ۹۰ فایل) → `docs/archive/rounds/` با `git mv`.
- نگه‌داشتن فقط اسناد زنده در ریشه‌ی `docs/`: `ARCHITECTURE.md`, `SECURITY.md`, `PINE-*`, `PHASE*`.

---

### فاز ۳ — بهداشت مخزن (P2)

#### F3.1 — بازساختاردهی `scripts/`
```
tests/unit/      ← test_*.mjs / test_*.py
tests/e2e/       ← e2e_*.mjs / e2e_*.py
tools/dev/       ← probe_*, diag_*, repro_*, _dbg*, scratch_*, shot_*, shots*
fixtures/pine/   ← pine-fixtures/*
scripts/         ← فقط verify-electron.js, harness, checks/, make_app_icon.py
```
- با `git mv` (نه کپی) و به‌روزرسانی مسیرهای ارجاع‌شده در اسکریپت‌ها.
- **معیار پذیرش:** `npm run verify` همچنان سبز.

#### F3.2 — حذف تکراری‌ها (۶ گروه)
| فایل‌ها | تصمیم |
|---|---|
| `scripts/pine-fixtures/786-zones.pine` = `.../corpus/786-zones.pine` | نگه‌داشتن یکی |
| `sample-SmartMoneyConcepts.pine` (۳ نسخه) | مرجع: `src/renderer/assets/pine-samples/` |
| `sample-CM_MacD_Ult_MTF.pine` (۲ نسخه) | مرجع: renderer |
| `sample-SqueezeMomentum.pine` (۲) | مرجع: renderer |
| `sample-Supertrend.pine` (۲) | مرجع: renderer |
| `test_round40_on44.py` = `test_round40_on45.py` | یکی حذف |

#### F3.3 — حذف زباله‌ها (پس از F0.1 امن است)
- ۳۴ اسکریپت یک‌بارمصرف: `_dbg9/10/11/12/13`, `diag_*` (۸), `probe_*` (۱۲), `repro_*` (۶), `scratch_lvldump.mjs`, `debug_round116_hover.py`, `bug_repro_offset.py`
- ۸ اسکرین‌شات روت `scripts/`: `round109_*` … `round112_*`
- پوشه‌های `__pycache__`
- **معیار پذیرش:** تعداد فایل‌های `scripts/` از ۳۸۲ به ~۳۰۰ برسد، بدون شکستن `npm run verify`.

#### F3.4 — تفکیک CHANGELOG
- `CHANGELOG.md` (۷۳۲ KB) → فهرست + `changelog/v1.7.md`, `v1.8.md`, `v1.9.md`.

---

### فاز ۴ — قابلیت نگهداری (P3، پرریسک‌ترین)

#### F4.1 — جایگزینی `console.*`
- ۱۶ مورد در `src/renderer/js/chart/manager.js` → `Log.debug/info/warn/error`.
- **معیار پذیرش:** `grep -c "console\." src` → ۰.

#### F4.2 — تریاژ ۴۸۹ `catch {}`
- اولویت به مسیرهای: boot، localStorage، IPC، provider، ذخیره‌سازی چارت/دراوینگ.
- الگو: `catch (e) { Log.warn('chart', 'restore failed', e); }` (بدون تغییر رفتار).
- **معیار پذیرش:** حداکثر ۲۰٪ کاهش؛ هیچ تستی نشکند. هدف شمارش نیست، هدف رؤیت‌پذیری است.

#### F4.3 — شکستن فایل‌های غول (هر کدام یک commit جدا، حرکت خالص)
| فایل | خط | پیشنهاد |
|---|---|---|
| `src/core/pine/interpreter.js` | ۴۴۱۱ | `interpreter/` با `statements.js`, `expressions.js`, `series.js` |
| `src/renderer/js/chart/manager.js` | ۲۹۶۲ | `pane.js`, `layout.js`, `data.js`, `render.js` |
| `src/renderer/js/drawing/tools2.js` | ۲۴۸۲ | `tools/gann.js`, `tools/elliott.js`, `tools/patterns.js`, `tools/fib.js` |
| `src/renderer/js/chart/pine-ui.js` | ۲۲۸۷ | `pine-ui/panel.js`, `pine-ui/inputs.js`, `pine-ui/templates.js` |
- **قاعده:** صفر تغییر منطقی؛ فقط `export`/`import`. بعد از هر فایل: `npm run verify` + یک اسکرین‌شات دستی.

---

### فاز ۶ — پولیش چندپلتفرمی (P3)

#### F6.1 — macOS
- `frame:false` + کنترل‌های سبک ویندوز روی مک کار نمی‌کند.
- گزینه‌ها: (الف) `titleBarStyle: 'hiddenInset'` و حفظ دکمه‌ها، (ب) `frame:true` فقط برای darwin.
- تست: `run.sh` روی مک (در صورت دسترسی).

#### F6.2 — Linux
- تست `./run.sh`؛ بررسی نیاز به `--no-sandbox` در برخی توزیع‌ها (ثبت در README، نه در کد).

#### F6.3 — تشخیص Python در ویندوز
- `pyExe()` فعلی فقط `python` را امتحان می‌کند. افزودن fallback به `py -3` و پیام خطای دقیق‌تر.

---

### فاز ۷ — آماده‌ی انتشار (P3)

#### F7.1 — بیلد واقعی ویندوز
- `npm run dist:win` → نصب → اجرا → ورود دمو → چارت → خروج.
- بررسی: آیکون taskbar، توست، مسیر `logs/`، عدم وجود `.pyc`.

#### F7.2 — امضای کد
- مستندسازی `CSC_LINK` / `CSC_KEY_PASSWORD` در README (بدون commit کردن گواهی).

#### F7.3 — چک‌لیست انتشار
- `scripts/release.mjs`: bump نسخه، به‌روزرسانی CHANGELOG، tag، build.

---

## ۴) معیار «آماده توسعه» (Definition of Done)

پروژه وقتی «آماده توسعه» است که همه‌ی موارد زیر صادق باشند:

- [ ] مخزن Git دارد، `.gitignore` سالم است، `node_modules` ردیابی نمی‌شود.
- [ ] `npm run verify` (syntax + imports + python + smoke) روی ویندوز سبز است.
- [ ] CI روی push اجرا می‌شود و سبز است.
- [ ] هیچ باگ P0/P1 باز نمانده (F1.1 … F1.8 بسته).
- [ ] README و ARCHITECTURE با واقعیت کد مطابق‌اند.
- [ ] `scripts/` ساختارمند است و فایل‌های یک‌بارمصرف/تکراری حذف شده‌اند.
- [ ] بیلد ویندوز (`dist:win`) نصب و اجرا می‌شود.
- [ ] مسیرهای خطای حیاتی (boot، storage، IPC، provider) لاگ می‌شوند.

---

## ۵) چک‌لیست پیشرفت

```
[x] F0.1  git init + .gitignore
[x] F0.2  tag baseline
[x] F1.1  permission check handler            (P0)
[x] F1.2  AppUserModelID packaged             (P1)
[x] F1.3  version از app.getVersion()         (P1)
[x] F1.4  حذف __pycache__ از بیلد             (P1)
[x] F1.5  آیکون mac/linux                     (P1)
[ ] F1.6  چرخه‌ی عمر رندرر/پنجره              (P1)
[ ] F1.7  رفع تزریق HTML در compare/watchlist (P1)
[ ] F1.8  تصحیح README                        (P1)
[ ] F2.1  اسکریپت‌های npm                     (P1)
[ ] F2.2  چهار check اسکریپت                  (P1)
[ ] F2.3  CI workflow                         (P1)
[ ] F2.4  ثبت smoke harness                   (P1)
[ ] F5.1  بازنویسی README                     (P2)
[ ] F5.2  docs/ARCHITECTURE.md                (P2)
[ ] F5.3  آرشیو مستندات راندها                (P2)
[ ] F3.1  بازساختاردهی scripts/               (P2)
[ ] F3.2  حذف ۶ گروه تکراری                   (P2)
[ ] F3.3  حذف فایل‌های یک‌بارمصرف             (P2)
[ ] F3.4  تفکیک CHANGELOG                     (P2)
[ ] F4.1  حذف console.*                       (P3)
[ ] F4.2  تریاژ catchهای خالی                 (P3)
[ ] F4.3  شکستن ۴ فایل غول                    (P3)
[ ] F6.1  macOS                                (P3)
[ ] F6.2  Linux                                (P3)
[ ] F6.3  تشخیص Python در ویندوز              (P3)
[ ] F7.1  بیلد و نصب ویندوز                   (P3)
[ ] F7.2  مستند امضای کد                      (P3)
[ ] F7.3  چک‌لیست انتشار                      (P3)
```

---

## ۶) دستورهای آماده‌ی کپی

```powershell
# وضعیت و تست پایه
cd C:\Users\amirh\Desktop\test
node --version; python --version

# بررسی سینتکس همه‌ی فایل‌ها
Get-ChildItem -Recurse -File -Include *.js,*.mjs |
  Where-Object { $_.FullName -notmatch 'node_modules|vendor' } |
  ForEach-Object { node --check $_.FullName }

# اجرای پرووایدر دمو
$env:MT5_WS_PORT=8777; python provider\demo.py

# اجرای اپ در حالت dev
npm start

# بعد از فاز ۲
npm run verify
```

---

*پایان سند. برای شروع در چت جدید: «فاز ۰ را اجرا کن.»*
