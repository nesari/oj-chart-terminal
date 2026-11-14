# وضعیت پروژه — نقطهٔ شروع چت جدید

> آخرین به‌روزرسانی: ۲۰۲۶-۱۱-۱۴ | نسخه: **1.9.229** | HEAD: `7862952`

---

## ۱. پروژه چیست

اپ دسکتاپ معاملاتی شبیه TradingView (`OJchart`) روی Electron + MT5.
مخزن: `github.com/nesari/oj-chart-terminal` — **public** (از راند ۲۹۳).

```bash
npm run verify      # دروازهٔ کامل: 179/179 unit + mt5 + smoke
npm run check:e2e   # 19 سوئیت Playwright زنده
npm run release -- --version X.Y.Z   # نسخه + changelog + تگ، همه با هم
```

**قاعدهٔ کاری:** تغییر → `npm run verify` سبز → commit → push → تأیید سبز بودن CI.

---

## ۲. کارهایی که تمام شده‌اند

### پاریتی ابزارهای ترسیم با TradingView (راندهای ۲۸۴–۲۸۹)
- schema/کنترل‌های گم‌شده: `zoomin`, `flagmark`, شکل‌های توخالی, باکس «Both»
- موج دوم: دنبالهٔ callout، کارت سه‌خطی measure، Value Area، رنگ‌های ghostfeed/posforecast، چیپ‌های label
- راند ۲۸۹: چیدمان متن callout، scope حجم پروفایل با موتور مشترک، باند آماری ghostfeed، ردیف‌های measure، سطوح کشیدنی posforecast، شعاع‌های sector
- **باگ پیدا شده:** تعریف تکراری `volprofile`/`avolprofile` در جدول `SCHEMAS` نسخهٔ غنی را بی‌صدا override می‌کرد. حالا تست ضدتکرار دارد.

### زیرساخت انتشار و آپدیت (راندهای ۲۹۰–۲۹۶)
- **Release واقعی:** `Package` روی هر تگ `v*` یک GitHub Release با ۹ فایل می‌سازد (سه نصب‌کننده + `latest*.yml` + blockmap)
- **گیت صحت Release:** `npm run check:release -- --tag vX` — ۱۹ چک: فید، نسخه، نام و **حجم** هر asset، blockmap، draft/prerelease. بعد از انتشار در CI اجرا می‌شود.
- **آپدیت داخل اپ:** `electron-updater` + پنل Diagnostics + دکمهٔ About در نوار بالا
- **جریان کاربر:** Check → (آپدیت هست؟) → Download با درصد → Restart & install
- **گیت کانال:** `npm run check:channel` — با کلاینت **ناشناس** تأیید می‌کند نسخهٔ نصب‌شده می‌تواند آپدیت کند
- **زمانی که نصب خودکار ممکن نیست:** از GitHub Releases API می‌پرسد → «آخرین نسخه هستید» یا «vX موجود است»

### پایداری تست و آدیت (راند ۲۹۷)
- **فلیک `round283`:** race با حذف `setTimeout` حل شد — خواندن همگام بعد از `rebuild` و درین دستی بعد از `pushNewBar`؛ دیگر به تیک `onTick` وابسته نیست. اثبات شکستن: با خاموش‌کردن جلوگیری از replay، همان تست سه چک قرمز می‌دهد.
- **`SCHEMAS` یک‌منبعی:** هر ۸۳ schema در یک جدول؛ `SCHEMAS.x = [...]` و `registerSchema` حذف شدند. پارسر مشترک `tests/unit/source-utils.mjs` aliasها (`ARROWMARK_U`) را resolve می‌کند و تکراری‌بودن کلید و تخصیص بیرون از جدول را می‌گیرد.
- **هارنس‌های آدیت در CI:** چهار هارنس (`audit_left_toolbar`، `audit_core_chart_tv`، `audit_app_sweep`، `audit_app_deep`) به `check:e2e` اضافه شدند → **19/19**. قبلاً بدون گیت بودند.

### امنیت و زیرساخت
- **اسکن کل تاریخچهٔ گیت:** `scripts/checks/scan-history.mjs` — ۲٬۶۵۴ blob. رمزی که commit و بعد حذف شده هم پیدا می‌شود.
- **`npm run go-public`:** آدیت → flip → تأیید کانال. در صورت یافته **امتناع** می‌کند.
- **کنترل هزینهٔ CI:** `ci.yml` pushهای فقط‌مستند را رد می‌کند.

---

## ۳. وضعیت فعلی

| مورد | وضعیت |
|---|---|
| `npm run verify` | ✅ 179/179 + mt5 + smoke |
| E2E gate | ✅ 19/19 |
| CI (main + tag) | ✅ Linux · Windows · macOS |
| Release v1.9.229 | ✅ ۱۹/۱۹ |
| کانال آپدیت | ✅ با کلاینت ناشناس |
| visibility | public |

---

## ۴. نکات مهم که فراموش نکن

1. **نسخه سه جا است:** `package.json` + `src/core/logger.js` (`APP_VERSION`) + `CHANGELOG.md`. اسکریپت `release.mjs` هر سه را با هم به‌روز می‌کند — دستی نکن.

2. **`app.getVersion()` در بیلد dev نسخهٔ Electron را می‌دهد** (`33.4.11`)، نه اپ. `appVersion()` در `updater.js` این را حل می‌کند.

3. **`openExternal` باید در `preload.js` باشد** و در `main.js` با allow-list. `window.open(..., '_blank')` در Electron پنجرهٔ سفید می‌دهد.

4. **تست‌ها نباید نسخه را hardcode کنند** — از `package.json` بخوانند. تست واحد برای همین وجود دارد.

5. **`electron-updater` فقط در بیلد بسته‌بندی‌شده کار می‌کند.** برای بررسی نسخه در dev، مسیر API جدا است.

6. **همهٔ تست‌های E2E باید پورت یکتا داشته باشند** (`PORT_HTTP`/`PORT_WS`). هنگام افزودن سوئیت جدید چک کن.

7. **فایل‌های detector در اسکن تاریخچه حذف می‌شوند** — وگرنه الگوی خودشان را پیدا می‌کنند و هر اجرا را بلاک می‌کنند.

---

## ۵. کارهای باقی‌مانده

### مسدودشده (خارج از کد)
- **تست سفارش با حساب واقعی MT5** — نیازمند ویندوز + ترمینال + اعتبارنامه. عمداً دستی (ریسک مالی).
- **امضای کد / notarization** — نیازمند گواهی ویندوز و Apple Developer ID.
- **فیکسچر بروکر دوم** — اختیاری.

### بدهی فنی شناخته‌شده
- ~~**`SCHEMAS` دو منبع دارد**~~ — **راند ۲۹۷ حل شد:** همهٔ schemaهای داخلی در یک جدول واحد‌اند؛ `SCHEMAS.x = [...]` و `registerSchema` حذف شدند. تست ضدتکرار هم کلید تکراری داخل جدول را می‌گیرد و هم هر تخصیص بیرون از آن را.
- **فلیک‌های E2E:** `round196` (اصلاح شده با plot کردن `close`)، `round283` (**راند ۲۹۷:** race با حذف `setTimeout` حل شد — خواندن همگام بعد از `rebuild` و درین دستی بعد از `pushNewBar`؛ دیگر به تیک `onTick` وابسته نیست). الگو: بیشترشان **خود تست** مشکل دارند نه محصول.

---

## ۶. فایل‌های کلیدی

### آپدیت و انتشار
| فایل | نقش |
|---|---|
| `src/platform/electron/updater.js` | پل `electron-updater` + بررسی API + `appVersion()` |
| `src/renderer/js/panels/update-ui.js` | وضعیت مشترک + `checkNow`/`download`/`install`/`onStatus` |
| `src/renderer/js/panels/about-ui.js` | پنجرهٔ About: نسخه + دکمهٔ Check + صفحهٔ دانلود |
| `scripts/checks/check-release.mjs` | گیت صحت Release (۱۹ چک) |
| `scripts/checks/check-channel.mjs` | آیا نسخهٔ نصب‌شده می‌تواند آپدیت کند؟ |
| `scripts/checks/scan-history.mjs` | اسکن کل تاریخچهٔ گیت |
| `scripts/go-public.mjs` | آدیت → flip → تأیید |
| `scripts/checks/probe-update-check.cjs` | بررسی واقعی در Electron |

### ترسیم
| فایل | نقش |
|---|---|
| `src/renderer/js/drawing/settings.js` | `DEFAULTS` + جدول واحد `SCHEMAS` (از راند ۲۹۷) |
| `src/renderer/js/drawing/tools.js` | measure، disjoint، chip label |
| `src/renderer/js/drawing/tools2/analysis.js` | موتور مشترک حجم پروفایل، ghostfeed، posforecast، sector |
| `src/renderer/js/drawing/tools2/marks.js` | callout (چیدمان متن، دنباله) |
| `src/renderer/js/drawing/engine.js` | موتور ترسیم، handleها، snap |

### تست و CI
| فایل | نقش |
|---|---|
| `scripts/checks/run-unit.mjs` | کشف خودکار `tests/unit/*.mjs` (SERIAL: `verify_pine80`, `test_round266`, `test_round281`) |
| `scripts/checks/e2e-gate.mjs` | ۱۹ سوئیت منتخب (۱۵ رگرسیون + ۴ هارنس آدیت)، tree-kill روی timeout |
| `.github/workflows/ci.yml` | سه پلتفرم |
| `.github/workflows/package.yml` | بیلد + Release + گیت صحت |

### مستندات
- `docs/HANDOFF-ROADMAP.md` — نقشهٔ راه کامل با تاریخ راندها
- `docs/APP-VS-TV-AUDIT.md` — آدیت کل اپ
- `docs/DRAWING-TOOLS-VS-TV.md` — مقایسهٔ ابزارهای ترسیم
- `README.md` — بخش «Updates» (وضعیت و محدودیت‌ها)

---

## ۷. قواعدی که در این پروژه جا افتاده

1. **باگ را در اپ واقعی بازتولید کن** — خواندن سورس کافی نیست. چندین باگ فقط در اجرای زنده پیدا شد.
2. **تست باید شکستن را ثابت کند** — گیتی که همیشه سبز است بدتر از نبودنش است. (مثال: تست اسکن تاریخچه با یک کلید AWS کاشته‌شده)
3. **پیام به کاربر باید صادق باشد** — «کانال در دسترس نیست» به‌جای خطای قرمز؛ «قابل نصب نیست» به‌جای دکمهٔ بی‌اثر.
4. **هیچ‌چیز بی‌کلیک دانلود یا نصب نمی‌شود** (`autoDownload` و `autoInstallOnAppQuit` همیشه false).
5. **flake را با حذف race حل کن، نه با retry بیشتر.**
