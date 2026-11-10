# PINE-ENGINE-PLAN — نسخهٔ زندهٔ نقشه‌راه Pine Script v6

> این سند، نسخهٔ نگهداشت‌شوندهٔ `PINE-ENGINE-ROADMAP.md` اصلی است و با پیشرفت فازها به‌روز می‌شود.
> وضعیت تا **راند ۲۸۳ (پس از انتشار v1.9.216)** — نوامبر ۲۰۲۶.

## وضعیت فازها

| فاز | عنوان | وضعیت | محل |
|---|---|---|---|
| ۱ | Lexer + Parser + AST (indentation-aware) | ✅ انجام شد | `src/core/pine/lexer.js`, `parser.js` |
| ۲ | سیستم تایپ + Scope (const/input/simple/series, na, آرایهٔ تایپ‌دار، UDT/enum/method) | ✅ انجام شد | `types.js`, `scope.js`, `stdlib/array.js` |
| ۳ | هستهٔ اجرا (bar-by-bar, `[]`, var/varip واقعی, rollback, بدون recursion) | ✅ انجام شد | `interpreter.js` + `pine-ui/` |
| ۴ | کتابخانهٔ استاندارد (`ta/math/str/time/color/array/matrix/map/objects/inputs/request`) | ✅ انجام شد | `stdlib/*` |
| ۵ | لایهٔ نمایش (plot*/fill/bgcolor/barcolor/hline/line/box/label/polyline/linefill/table) | ✅ انجام شد — هر دو کلید Graphic objects برای polyline/linefill هم در راند ۲۸۰ اضافه شد | `pine-render-adapter.js` |
| ۶ | پنل Pine Editor (ادیتور صفر-وابستگی، اسکریپت‌استور، Inputs خودکار، کنسول CE/RE، Import/Export) | ✅ انجام شد | `pine-ui/panel.js`, `pine-scripts-store.js` |
| ۷ | اتصال Alert (`alertcondition`/`alert` → موتور Alerts + صدا) | ✅ راند ۲۷۹ — نوار رویداد زنده + کارت «Script alerts» در پنل Alerts | `interpreter/builtins.js`, `pine-ui/runtime.js`, `panels/alerts.js` |
| ۸ | کارایی (chunked run، به‌روزرسانی فقط forming-bar، سقف نرم حلقه) | ✅ انجام شد — گیت بودجه‌ی کورپوس در راند ۲۸۱ اضافه شد؛ Web Worker لازم نشد (پاس chunked هر ۱۶–۲۱ms به حلقهٔ رویداد yield می‌دهد) | `compile.js`, `pine-ui/` |
| ۹ | `strategy.*` + Strategy Tester | ✅ راند ۱۷۱–۱۷۳ (سفارش، حساب، پنل) | `stdlib/strategy.js`, `trade/tester.js` |
| ۱۰ | تست تطبیق (فیکسچرها + پاریتی عددی + e2e زنده + اسکرین‌شات) | ✅ ۱۶۳ سوئیت unit + corpus (۶ اسکریپت) + گیت بودجه + گیت E2E مرورگر در CI | `tests/unit/`, `tests/archive/e2e/` |
| ۱۱ | مستندسازی و یکپارچگی فرآیند | ✅ همین سند + CHANGELOG + README | `docs/` |

## معیار پذیرش نهایی — تحقق یافت

اندیکاتور واقعی کاربر **«786 Zones» v5.5** (۵۸۹ خط Pine v6 با `request.security_lower_tf`، آرایه‌های تایپ‌دار ماندگار، مدل آپدیت درجای `box/line/label`، محاسبات DST دستی و `timestamp` چند-overload) روی چارت زندهٔ اپ اجرا و رندر می‌شود — اجرای chunked روی ~۵۰۰۰ بار، باکس/لیبل سشن، ثبات اشیاء روی تیک‌ها و بقای identity پس از بار جدید، همه با تست خودکار (`verify_pine74.mjs` بخش ۵).

پس از آن، corpus پنج اندیکاتور سنگین (`fixtures/pine/corpus/`) و مسیرهای کراس‌نماد (راند ۱۶۸–۱۷۰)، بک‌تستر (۱۷۱–۱۷۳) و tick-model (۱۹۸) هم به همین مجموعه اضافه شدند.

## موارد باز / اختیاری

1. ~~**پل Pine → Alerts**~~ — ✅ **راند ۲۷۹ انجام شد.** `alertcondition()` و `alert()` حالا روی نوار رویداد زندهٔ `out.pineAlerts` (با `seq` یکنوا) منتشر می‌شوند؛ بارهای تاریخی هرگز رویداد نمی‌دهند، پاس کامل فقط بار آخر را افشا می‌کند و رندرر همان پاس را به‌عنوان replay تاریخچه حذف می‌کند. `alertcondition()` یک‌بار در هر بار زنده تا وقتی شرط برقرار است فعال می‌شود و `alert()` پیام یکسان را در همان بار de-dupe می‌کند. رندرر با `PineUI.pollAlerts()` (کرسر per-instance) رویدادها را می‌کشد و به همان مسیر `UI.toast` + `electronAPI.notify` + `playSound()` می‌فرستد؛ کارت «Script alerts» در پنل Alerts کلید اصلی، کلید پیام‌های `alert()` و کلید arm هر شرط را دارد (ذخیره در `mt5_pa_cfg`).
2. **Web Worker** — 🔶 **ارزیابی شد و فعلاً لازم نیست.** اندازه‌گیری راند ۲۸۱: پاس chunked روی ۵۰۰۰ بار سنگین‌ترین اسکریپت (wyckoff) هر ۱۶–۲۱ms به حلقهٔ رویداد yield می‌دهد (بیشترین برش ۲۱ms، p95 ۱۶ms) و هزینه خطی است (~۲.۵ms/بار)؛ Worker فقط همین بار را به ترد دیگری منتقل می‌کرد، نه کمتر. به‌جای آن گیت بودجه‌ی کورپوس اضافه شد (راند ۲۸۱) که کارِ هر بار و نبودِ O(n²) را قفل می‌کند.
3. ~~**رندر `polyline` / `linefill`**~~ — ✅ **راند ۲۸۰: از قبل رندر می‌شدند.** `_paintPolyline`/`_paintLinefill` از راند ۱۳۶/۱۴۱ در پاس اشیای FG هستند و linefill هر فریم خطوط سازنده را دوباره می‌خواند؛ تنها کمبود واقعی، نبودِ کلید نمایش در تب Style بود که راند ۲۸۰ اضافه کرد (`polylines`/`linefills`).
4. ~~**`math.bitwise_*`**~~ — ❌ **اصلاً وجود ندارد.** رفرنس رسمی v6 هیچ namespace بیت‌وایزی زیر `math` ندارد؛ فهرست کامل `math.*` مرجع (۲۶ تابع + ۶ ثابت) با موتور دقیقاً یکی است. ادعای قبلی این سند غلط بود و تصحیح شد.
5. **`request.dividends/earnings/splits/financial`** عمداً خارج از دامنه‌اند (نیازمند فید بنیادی)؛ خطای صریح می‌دهند.
6. ~~**راند ۲۸۲ (آدیت کامل مرجع):**~~ ✅ سه باگ/گپ واقعی پیدا و بسته شد: (الف) `ta.max` / `ta.min` (اکسترمم‌های تمام‌تاریخ، تک‌آرگومان) وجود نداشتند؛ (ب) `ta.pivot_point_levels` با هر ۶ نوع و ۱۱ سطح و `anchor`/`developing` پیاده شد؛ (ج) متغیرهای سری زمانی خام (`hour`، `year`، `dayofmonth`، `minute`، `second`، `dayofweek`، `weekofyear`) و فرم تک‌آرگومانی `time("D")`/`time_close("D")` بی‌صدا `na` می‌دادند — یعنی لنگرهای روزانه (`ta.change(time("D"))`) هرگز فعال نمی‌شدند. `session.regular`/`session.extended` و یک `case 'basecurrency'` تکراری (کد مرده) هم اصلاح شد.
7. ~~**E2E آرشیو (راند ۲۸۳):**~~ ✅ کل ۱۲۶ سوئیت Playwright آرشیو از زمان انتقال به `tests/archive/e2e/` بی‌صدا خراب بودند (سه `dirname` جای چهار) و حتی `src/` را پیدا نمی‌کردند؛ مسیر اصلاح شد و `npm run check:e2e` (۶ سوئیت منتخب، شامل مسیر زندهٔ Pine → Alerts و پیوت‌های ۲۸۲) به CI اضافه شد. با این تعمیر ۹۳ از ۱۳۶ سوئیت آرشیو سبز می‌شوند.
