# PINE-ENGINE-PLAN — نسخهٔ زندهٔ نقشه‌راه Pine Script v6

> این سند، نسخهٔ نگهداشت‌شوندهٔ `PINE-ENGINE-ROADMAP.md` اصلی است و با پیشرفت فازها به‌روز می‌شود.
> وضعیت تا **راند ۷۴ (v1.9.25)** — سپتامبر ۲۰۲۶.

## وضعیت فازها

| فاز | عنوان | وضعیت | محل |
|---|---|---|---|
| ۱ | Lexer + Parser + AST (indentation-aware) | ✅ انجام شد | `src/core/pine/lexer.js`, `parser.js` |
| ۲ | سیستم تایپ + Scope (const/input/simple/series, na, آرایهٔ تایپ‌دار) | ✅ انجام شد (UDT/enum/method → فاز بعدی) | `types.js`, `scope.js`, `stdlib/array.js` |
| ۳ | هستهٔ اجرا (bar-by-bar, `[]`, var/varip, بدون recursion) + افزایشی ۷۰-۷۲ | ✅ انجام شد | `interpreter.js` + `pine-ui.js` |
| ۴ | کتابخانهٔ استاندارد (`ta.*` بازاستفاده از kernels، `math/str/time/color/array/objects/inputs/request`) | ✅ MVP انجام شد؛ `request.security` (TF بالاتر) → نسخهٔ بعد | `stdlib/*` |
| ۵ | لایهٔ نمایش (plot/plotshape/bgcolor/barcolor/fill/hline/line/box/label + زیرپن overlay=false) | ✅ انجام شد | `pine-render-adapter.js` |
| ۶ | پنل Pine Editor (ادیتور صفر-وابستگی، اسکریپت‌استور، Inputs خودکار، کنسول CE/RE، Import/Export) | ✅ انجام شد | `pine-editor.js`, `pine-scripts-store.js` |
| ۷ | اتصال Alert (`alertcondition`/`alert` → موتور Alerts + صدای راند ۷۳) | 🔶 stub ثبت‌شده در interpreter؛ سیم نهایی به `panels/alerts.js` → راند بعد | `interpreter.js` |
| ۸ | کارایی (chunked run، به‌روزرسانی فقط forming-bar، سقف نرم حلقه) | ✅ انجام شد (Web Worker → اختیاری آینده) | `compile.js`, `pine-ui.js` |
| ۹ | `strategy.*` + Strategy Tester | ⬜ نسخهٔ بعدی (کامپایلر فعلاً tolerated است) | — |
| ۱۰ | تست تطبیق (فیکسچرها + پاریتی عددی + e2e هدلس + اسکرین‌شات) | ✅ انجام شد — ۴۷ چک Node + e2e مرورگر + پذیرش 786 Zones | `scripts/verify_pine74.mjs` |
| ۱۱ | مستندسازی و یکپارچگی فرآیند | ✅ همین سند + `FEATURE-ROUND74.md` + به‌روزرسانی README/CHANGELOG | `docs/` |

## معیار پذیرش نهایی — تحقق یافت

اندیکاتور واقعی کاربر **«786 Zones» v5.5** (۵۸۹ خط Pine v6 با `request.security_lower_tf`، آرایه‌های تایپ‌دار ماندگار، مدل آپدیت درجای `box/line/label`، محاسبات DST دستی و `timestamp` چند-overload) روی چارت زندهٔ اپ اجرا و رندر می‌شود — اجرای chunked روی ~۵۰۰۰ بار، باکس/لیبل سشن، ثبات اشیاء روی تیک‌ها و بقای identity پس از بار جدید، همه با تست خودکار (`verify_pine74.mjs` بخش ۵).

## اولویت‌های راند بعدی

1. **فاز ۷ کامل:** اتصال `alertcondition`/`alert` به پنل Alerts به‌عنوان «منبع چهارم» شرط (ارث صدا/Loop/Mute راند ۷۳).
2. **`request.security`:** همان نماد، تایم‌فریم بالاتر با resample محلیِ کندل‌های موجود (آفلاین)؛ نماد دیگر فعلاً خطای صریح.
3. **UDT/enum/method** (فاز ۲ پیشرفته) و `matrix/map` کامل.
4. **Web Worker** برای اسکریپت‌های خیلی سنگین (benchmark واقعی: 786 Zones روی تایم‌فریم بالا).
5. غنی‌سازی `str.*` و `plotcandle/plotbar`.
