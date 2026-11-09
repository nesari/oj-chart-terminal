# PINE-ENGINE-PLAN — نسخهٔ زندهٔ نقشه‌راه Pine Script v6

> این سند، نسخهٔ نگهداشت‌شوندهٔ `PINE-ENGINE-ROADMAP.md` اصلی است و با پیشرفت فازها به‌روز می‌شود.
> وضعیت تا **راند ۲۷۹ (پس از انتشار v1.9.216)** — نوامبر ۲۰۲۶.

## وضعیت فازها

| فاز | عنوان | وضعیت | محل |
|---|---|---|---|
| ۱ | Lexer + Parser + AST (indentation-aware) | ✅ انجام شد | `src/core/pine/lexer.js`, `parser.js` |
| ۲ | سیستم تایپ + Scope (const/input/simple/series, na, آرایهٔ تایپ‌دار، UDT/enum/method) | ✅ انجام شد | `types.js`, `scope.js`, `stdlib/array.js` |
| ۳ | هستهٔ اجرا (bar-by-bar, `[]`, var/varip واقعی, rollback, بدون recursion) | ✅ انجام شد | `interpreter.js` + `pine-ui/` |
| ۴ | کتابخانهٔ استاندارد (`ta/math/str/time/color/array/matrix/map/objects/inputs/request`) | ✅ انجام شد | `stdlib/*` |
| ۵ | لایهٔ نمایش (plot*/fill/bgcolor/barcolor/hline/line/box/label/table) | ✅ انجام شد — `polyline`/`linefill` هنوز رندر نمی‌شوند | `pine-render-adapter.js` |
| ۶ | پنل Pine Editor (ادیتور صفر-وابستگی، اسکریپت‌استور، Inputs خودکار، کنسول CE/RE، Import/Export) | ✅ انجام شد | `pine-ui/panel.js`, `pine-scripts-store.js` |
| ۷ | اتصال Alert (`alertcondition`/`alert` → موتور Alerts + صدا) | ✅ راند ۲۷۹ — نوار رویداد زنده + کارت «Script alerts» در پنل Alerts | `interpreter/builtins.js`, `pine-ui/runtime.js`, `panels/alerts.js` |
| ۸ | کارایی (chunked run، به‌روزرسانی فقط forming-bar، سقف نرم حلقه) | ✅ انجام شد؛ Web Worker همچنان اختیاری و پیاده‌نشده | `compile.js`, `pine-ui/` |
| ۹ | `strategy.*` + Strategy Tester | ✅ راند ۱۷۱–۱۷۳ (سفارش، حساب، پنل) | `stdlib/strategy.js`, `trade/tester.js` |
| ۱۰ | تست تطبیق (فیکسچرها + پاریتی عددی + e2e هدلس + اسکرین‌شات) | ✅ ۱۵۹ سوئیت unit + corpus + E2E | `tests/unit/`, `tests/archive/e2e/` |
| ۱۱ | مستندسازی و یکپارچگی فرآیند | ✅ همین سند + CHANGELOG + README | `docs/` |

## معیار پذیرش نهایی — تحقق یافت

اندیکاتور واقعی کاربر **«786 Zones» v5.5** (۵۸۹ خط Pine v6 با `request.security_lower_tf`، آرایه‌های تایپ‌دار ماندگار، مدل آپدیت درجای `box/line/label`، محاسبات DST دستی و `timestamp` چند-overload) روی چارت زندهٔ اپ اجرا و رندر می‌شود — اجرای chunked روی ~۵۰۰۰ بار، باکس/لیبل سشن، ثبات اشیاء روی تیک‌ها و بقای identity پس از بار جدید، همه با تست خودکار (`verify_pine74.mjs` بخش ۵).

پس از آن، corpus پنج اندیکاتور سنگین (`fixtures/pine/corpus/`) و مسیرهای کراس‌نماد (راند ۱۶۸–۱۷۰)، بک‌تستر (۱۷۱–۱۷۳) و tick-model (۱۹۸) هم به همین مجموعه اضافه شدند.

## موارد باز / اختیاری

1. ~~**پل Pine → Alerts**~~ — ✅ **راند ۲۷۹ انجام شد.** `alertcondition()` و `alert()` حالا روی نوار رویداد زندهٔ `out.pineAlerts` (با `seq` یکنوا) منتشر می‌شوند؛ بارهای تاریخی هرگز رویداد نمی‌دهند، پاس کامل فقط بار آخر را افشا می‌کند و رندرر همان پاس را به‌عنوان replay تاریخچه حذف می‌کند. `alertcondition()` یک‌بار در هر بار زنده تا وقتی شرط برقرار است فعال می‌شود و `alert()` پیام یکسان را در همان بار de-dupe می‌کند. رندرر با `PineUI.pollAlerts()` (کرسر per-instance) رویدادها را می‌کشد و به همان مسیر `UI.toast` + `electronAPI.notify` + `playSound()` می‌فرستد؛ کارت «Script alerts» در پنل Alerts کلید اصلی، کلید پیام‌های `alert()` و کلید arm هر شرط را دارد (ذخیره در `mt5_pa_cfg`).
2. **Web Worker** برای اسکریپت‌های خیلی سنگین (benchmark واقعی: 786 Zones روی تایم‌فریم بالا) — الان chunked روی main thread است.
3. **رندر `polyline` / `linefill`** در `pine-render-adapter.js` (موتور `new/delete` دارد، نقاشی ندارد).
4. **`math.bitwise_*`** (namespace کم‌کاربرد v6) پیاده نشده است.
5. **`request.dividends/earnings/splits/financial`** عمداً خارج از دامنه‌اند (نیازمند فید بنیادی)؛ خطای صریح می‌دهند.
