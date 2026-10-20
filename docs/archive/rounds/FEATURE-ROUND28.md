# FEATURE ROUND 28 — سه سیستم زیربنایی: لاگ و مانیتورینگ + خطای ساخت‌یافته + سخت‌سازی امنیتی

نسخه: 1.4.0 — سپتامبر 2026
هدف: تقویت پایهٔ نسخهٔ اول برای توسعه‌های بعدی (وب، اندروید/iOS با Capacitor) بدون تغییر معماری فعلی و بدون build step — طبق تصمیم کاربر (فاز ۱ از نقشهٔ راه «پایهٔ قوی»).

---

## ۱) لاگ و مانیتورینگ

### جریان داده
```
ماژول‌های renderer  ──Log.info/warn/error(cat,msg,ctx)──▶  core/logger.js
   ├── ring buffer (۳۰۰۰ ورودی) ──▶ پنل Diagnostics (نمای زنده + Export)
   └── batch هر ۱.۵s یا ۶۰ ورودی ──IPC 'log-batch'──▶ main.js ──JSONL──▶ userData/logs/app-YYYY-MM-DD.log
main process events (boot/quit/provider/crash) ──mlogEvent──▶ همان فایل (proc:'main')
```

### API لاگر (`window.Log`)
| متد | کار |
|---|---|
| `Log.debug/info/warn/error(cat, msg, ctx?)` | ثبت ورودی؛ خطاها فلاش فوری فایل |
| `Log.fromError(err, cat, ctx?)` | ثبت از روی چیزی که پرتاب شده (message+stack) |
| `Log.entries({lvl?, cat?, search?})` | فیلتر رینگ — search بدون حساسیت به بزرگی/کوچکی |
| `Log.stats()` | session/uptime/counts/cats/dropped/وضعیت فایل‌سینک |
| `Log.exportText() / exportJson()` | خروجی خوانا / ساخت‌یافته برای دکمهٔ Export |
| `Log.onEntry(cb)` | اشتراک زنده (پنل) — خروجی: تابع لغو اشتراک |
| `Log.setPaused(v)` / `flushNow()` | توقف sinkها / فلاش دستی |

- Session ID یکتا در هر اجرا (`s-xxxxxx`) — در فایل لاگ، Export و نوار stats دیده می‌شود.
- هر ورودی scrub می‌شود (بخش امنیت)؛ هیچ مسیری از لاگ به دیسک بدون scrub نیست.

### فایل لاگ سمت main
- مسیر: `<userData>/logs/app-YYYY-MM-DD.log` (در ویندوز: `%APPDATA%/mt5-chart-terminal/logs/`).
- JSONL با فیلد `proc` (`renderer`/`main`) — rotation خودکار ~۲MB، هرس بالای ۷ روز و کپ ۲۰ فایل در بوت.

## ۲) خطای ساخت‌یافته (`window.AppErr`)

- `new AppError(code, {message?, context?, cause?})` — هر کد از کاتالوگ `severity/category/userMessage/hint` می‌گیرد.
- `AppErr.raise(code, opts)` = ساخت + لاگ؛ `AppErr.wrap(err, fallbackCode, ctx?)` = تبدیل idempotent؛ `e.toUser()` برای toast؛ `e.log()` برای لاگ.
- **کاتالوگ باز:** `AppErr.register('MY_CODE', {...})` — لایه‌های آینده بدون تغییر این فایل توسعه می‌یابند (قابلیت توسعهٔ هر لایه).
- کدهای فعلی: PROVIDER_START/EXIT/TIMEOUT/AUTH/MODULE — FEED_CONNECT/CLOSED/TIMEOUT/PROTOCOL — BARS_EMPTY/REJECT — SYMBOL_UNKNOWN — INDICATOR_PARAMS/COMPUTE — STORAGE_WRITE — SNAPSHOT_FAIL — EXPORT_FAIL — IPC_BAD_PAYLOAD — UNKNOWN.
- **Crash net:** از لحظهٔ بوت در logger.js نصب است (`error` + `unhandledrejection`) → لاگ + toast نرخ‌محدود (۱ عدد در ۵ ثانیه)؛ سمت main هم `uncaughtException`/`unhandledRejection` → فایل لاگ.

## ۳) سخت‌سازی امنیتی

| لایه | اقدام |
|---|---|
| CSP | `default-src 'self' file:` — بدون inline script، بدون مبدأ ریموت؛ `connect-src` فقط `ws://127.0.0.1:8777` |
| Electron | `sandbox:true` + `contextIsolation:true` + `nodeIntegration:false`؛ `setWindowOpenHandler` → deny؛ `will-navigate` فقط `file:` |
| IPC | اعتبارسنجی شکل/نوع/طول/سقف روی همهٔ کانال‌ها؛ رد → `[IPC_BAD_PAYLOAD]` در لاگ security |
| Credentials | ذخیره با `safeStorage` (DPAPI) — از قبل موجود، حفظ شد؛ لاگ اتصال هرگز password ندارد |
| Provider | فقط `127.0.0.1:8777` (از قبل موجود) |
| حریم لاگ | scrub خودکار: کلیدهای `password/pass/pwd/token/secret/authorization/auth/cookie/pw` → redacted؛ عمق≤۳، رشته≤۵۰۰ |

## ۴) پنل Diagnostics

- تب جدید ریل راست (آیکون info). فیلتر سطح/دسته/جستجو + pause نما + پاک‌کردن نما + Export + Selftest.
- ردیف‌ها: زمان (ms) | سطح | دسته | پیام — کلیک روی ردیف‌های دارای ctx → نمایش JSON.
- Selftest (دکمهٔ ✓): ۸ چک — رینگ لاگر، کاتالوگ/wrap/raise، اثبات scrub، بازبودن کاتالوگ، localStorage، IPC echo (فقط Electron)، وضعیت feed، خروجی Export. نتیجه: ردیف در پنل + toast + ورود لاگ.

## ۵) قرارداد IPC جدید

| کانال | جهت | ورودی (اعتبارسنجی‌شده) | خروجی |
|---|---|---|---|
| `log-batch` | r→m | آرایه≤۵۰۰ ورودی | — |
| `logs-export` | r→m | text/json ≤۲۰MB + نام≤۸۰ | `{ok, path}` / `{ok:false, canceled}` |
| `diag-ping` | r→m | — | `{ok:true, t}` |

## ۶) تست‌ها

- `tests/unit/test_round28_diag.py` — ۱۰ چک E2E (headless chromium + demo provider): بوت بدون شکستن CSP، پنل، API لاگر، کاتالوگ خطا، scrub، selftest، export، crash net، رگرسیون عمق/digits، صفر خطای کنسول → **10/10 PASS**.
- `tests/unit/test_round27_features.py` → **11/11 PASS** (بدون رگرسیون).
- `node --check` کل js + `py_compile` پرووایدرها — سبز.

## ۷) راهنمای توسعه برای لایه‌های بعدی

- **کد خطای جدید:** `AppErr.register('MY_LAYER_X', { severity, category, userMessage, hint })` در ابتدای ماژول خودت → `AppErr.raise('MY_LAYER_X')`.
- **ابزارگذاری ماژول جدید:** `try { window.Log && Log.info('mycat', '...', {...}) } catch (e) {}` — دستهٔ جدید خودکار در فیلتر پنل ظاهر می‌شود.
- **فاز بعدی (تصمیم کاربر):** ES Modules + JSDoc (حذف window globals)، سپس استخراج core مستقل از پلتفرم، سپس شکل وب و Capacitor.
