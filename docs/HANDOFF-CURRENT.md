# وضعیت پروژه — نقطهٔ شروع چت جدید

> آخرین به‌روزرسانی: ۲۰۲۶-۱۱-۱۶ | نسخه: **1.9.231** | HEAD: `814da54`

---

## ۱. پروژه چیست

اپ دسکتاپ معاملاتی شبیه TradingView (`OJchart`) روی Electron + MT5.
مخزن: `github.com/nesari/oj-chart-terminal` — **public** (از راند ۲۹۳).

```bash
npm run verify      # دروازهٔ کامل: 180/180 unit + mt5 + smoke
npm run check:e2e   # ۲۲ سوئیت Playwright زنده
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

### اندیکاتورها — همه Pine (راند ۲۹۹)
- **تصمیم:** هر ۲۷ اندیکاتور داخلی از JS دست‌نویس به **اسکریپت Pine واقعی** تبدیل شدند و پیاده‌سازی JS **حذف** شد. حالا یک پیاده‌سازی از هر فرمول: همان موتور اسکریپت‌های کاربر.
- **معماری:** `src/core/pine/builtins-catalog.js` (۲۷ اسکریپت + نگاشت پارامتر)؛ `src/core/indicators.js` به فاساد ۱۲۶ خطی تبدیل شد؛ `indicators-ui.js` آداپتور نازک روی PineUI. کل دیف **−۱۱۸۳ خط**.
- **سازگاری:** `pane.indicators` شکل قدیمی را نگه می‌دارد تا API عمومی و لی‌اوت‌های ذخیره‌شده نشکنند؛ `syncPine` رکورد قدیمی را به نمونهٔ موتور نگاشت می‌کند (پیشوند `builtin:`).
- **تنظیمات:** همان دیالوگ Pine (Inputs/Style/Visibility + انتخابگر رنگ + plot-style)؛ Ok مستقیم روی `input.*` می‌نشیند و در رکورد قدیمی mirror می‌شود.
- **TV parity:** Momentum اختلاف قیمت، A/D با کندل اول، SAR با کسرهای شتاب و clamp دو‌کندلی، Keltner با پایهٔ EMA، Ichimoku با displacement، MACD بر اساس علامت، Volume بر اساس جهت کندل، باندها با `fill()`.
- **باگ موتور:** `input.int` مقدار کسری را گرد/محدود می‌کند (قبلاً `20.5` به `ta.sma` می‌رسید و پنجرهٔ کسری می‌خواند).
- **گیت:** `test_round298_299_indicator_parity` (۵۷ چک) + `e2e_round299_builtin_pine` (هر ۲۷ زنده + باند + دیالوگ) → **180/180** و **22/22**.
- **تاریخچه (راند ۲۹۸):** آدیت دیفرانسیال همان‌جا ۹ باگ واقعی پیدا کرد (۶ در موتور: `ta.wma`، `ta.stoch`/`ta.wpr`، `ta.mfi`، `ta.vwap`، `ta.supertrend`) و همان آدیت دلیل حذف پیاده‌سازی تکراری شد.
- **فلیک `round283`:** روی `main` کامیت‌شده هم ۳ از ۸ اجرا قرمز می‌شد — باگ محصول بود: (۱) `add()` pass را بدون `await` شروع می‌کرد و `rebuild()` state تازه می‌ساخت → توکن pass؛ (۲) rerun صف‌شده بی‌قید اجرا می‌شد و تیپ هشدار را پاک می‌کرد (`tape=0` با `cursor=2`) → فقط با تغییر واقعی داده؛ (۳) پنجرهٔ ۱۵۰۰ms → امضای داده. نتیجه: ۱۸ اجرای متوالی سبز.

### بازگشت تراز اندیکاتورها (راند ۳۰۰)
- **علامت کاربر:** «کل چارت به‌هم ریخته، کندل‌ها گپ افتاده، تایم‌لاین بهم خورده، با زوم می‌پرد».
- **علت ۱ — تراز افقی:** `_xOf` در Pine adapter (و موتور ترسیم و تاریخچهٔ معاملات) محور زمان را با شرط «Custom Session فعال است» انتخاب می‌کرد. اما **Session breaks** هم محور گپ‌دار می‌سازد (`_sessWithGapTimes`، ۵۰۰۰ کندل → ۵۰۱۲ خانه). نتیجه: هر خط/باند/برچسب **۸۶ پیکسل** چپ‌تر از کندل خودش، و روی H4 تا **۵۳۵۴ پیکسل**. حالا هر سه از خودِ محور سری (`_sessGapIdx`) پیروی می‌کنند.
- **علت ۲ — گپ پیش‌فرض:** راند ۲۸۸ «Session breaks» را با پیش‌فرض **روشن** اضافه کرده بود؛ ۱.۹.۱۹۷ اصلاً چنین چیزی ندارد. اکنون پیش‌فرض `false` است (چارت پیوسته) و یک **مهاجرت یک‌باره** ذخیرهٔ `true` قدیمی را خاموش می‌کند؛ اگر کاربر خودش روشن کند، انتخابش می‌ماند.
- **گیت:** `e2e_round300_pine_alignment` — تراز در پن/زوم، دو حالت محور، و ۵ تایم‌فریم. با برگرداندن باگ ۶ چک قرمز و عدد `86.01` برمی‌گردد.

### تعویض تایم‌فریم/نماد با اندیکاتور (راند ۳۰۱)
- **علامت (از لاگ کاربر):** ۱۲۹ خطا از ۱۴۵ خط، همه `Value is null` از داخل `Candlestick`؛ «چارت می‌پرد، اندیکاتور می‌ماند، بعد از اسکرول کندل‌ها برمی‌گردند».
- **علت:** `applyTf`/`applySymbol` فقط `pane.bars` را خالی می‌کردند، نه **سری** را. حدود ۲۰ فریم چارت ۵۰۰۰ ردیف تایم‌فریم قبلی را نشان می‌داد در حالی که `bars=[]` بود → LWC روی محور ناسازگار رندر می‌کرد (`Value is null`) و رنگ‌آمیز Pine روی مختصات کهنه می‌کشید.
- **رفع:** قبل از خالی‌کردن بارها، `PineUI.dropPane` و `series.setData([])`. چارت صادقانه خالی می‌شود، سپس دادهٔ جدید و اندیکاتور تازه.
- **نتیجه:** لاگ همان سشن از **۱۴۵ خط (۱۲۹ خطا)** به **۱۶ خط (۰ خطا)** رسید.
- **گیت:** `e2e_round301_tf_switch` — تعویض TF و نماد با اندیکاتور. با برگرداندن باگ، `bars=0` با `rows=5000` و `Value is null` بازتولید می‌شود.

### امنیت و زیرساخت
- **اسکن کل تاریخچهٔ گیت:** `scripts/checks/scan-history.mjs` — ۲٬۶۵۴ blob. رمزی که commit و بعد حذف شده هم پیدا می‌شود.
- **`npm run go-public`:** آدیت → flip → تأیید کانال. در صورت یافته **امتناع** می‌کند.
- **کنترل هزینهٔ CI:** `ci.yml` pushهای فقط‌مستند را رد می‌کند.

---

## ۳. وضعیت فعلی

| مورد | وضعیت |
|---|---|
| `npm run verify` | ✅ 180/180 + mt5 + smoke |
| E2E gate | ✅ 22/22 |
| CI (main + tag) | ✅ Linux · Windows · macOS |
| Release v1.9.231 | ✅ ۲۲/۲۲ |
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
| `scripts/checks/e2e-gate.mjs` | ۲۲ سوئیت منتخب (۱۵ رگرسیون + ۴ هارنس آدیت + ۳ e2e اندیکاتور/تراز/تعویض TF)، tree-kill روی timeout |
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
