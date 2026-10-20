# FEATURE-ROUND74 — موتور Pine Script v6 محلی + پنل Pine Editor + اجرای 786 Zones

> نسخهٔ ۱.۹.۲۵ — سپتامبر ۲۰۲۶ — مستند دقیق راند ۷۴ (ویژگی)

## ۰. درخواست و هدف

کاربر دو فایل تحویل داد: **`PINE-ENGINE-ROADMAP.md`** (نقشه‌راهٔ ۱۱ فازی افزودن یک Pine Editor + Pine Script v6 Runtime کاملاً محلی به `mt5-chart-terminal`، بدون هیچ وابستگی به سرور/اکانت TradingView) و **اندیکاتور واقعی خودش «786 Zones» v5.5** (۵۸۹ خط Pine v6). معیار پذیرش نهایی نقشه‌راه: همین اندیکاتور باید روی چارت همین اپ، روی دیتای دمو/MT5، درست مثل پیش‌نمایش تریدینگ‌ویو رندر شود.

محدودهٔ این راند (طبق توافق در کارگو): دامنهٔ کامل تا اجرای 786 Zones — هستهٔ زبان (فاز ۱-۴)، لایهٔ نمایش (فاز ۵)، ادیتور صفر-وابستگی (فاز ۶)، اتصال Alert به‌صورت stub ثبت‌شده (فاز ۷)، اجرای افزایشی (فاز ۸)، تست Node + e2e هدلس (فاز ۱۰)، مستندسازی (فاز ۱۱). `strategy.*` (فاز ۹) خارج از محدوده است اما در کامپایلر tolerated است تا مسیر آینده بسته نماند.

## ۱. معماری پیاده‌سازی‌شده

### ۱-۱. هستهٔ خالص — `src/core/pine/` (۱۵ فایل جدید، صفر ارجاع به window/document)

| فایل | نقش |
|---|---|
| `lexer.js` | توکنایزر indentation-aware (بلوک با تورفتگی مثل پایتون)، کامنت `//`، رشته‌های تک/دبل‌کوت، اعداد اعشاری/علمی، جدول کامل عملگرها شامل `?:`، `:=`، `[]` |
| `parser.js` | AST برای `//@version=6`، `indicator()/strategy()/library()`، `var/varip`، `if/else` به‌صورت expression، `for/while/switch`، تابع تک‌خطی و چندخطی با پارامتر تایپ‌شده، فراخوانی با آرگومان نامی، تعریف `[a, b, c] = ...` |
| `types.js` | تفکیک const/input/simple/series، `na` و انتشار آن، رنگ Pine (`PineColor` با مدل rgba + transp) |
| `scope.js` | اسکوپ متغیرها و ماندگاری `var/varip` بین بارها |
| `interpreter.js` (~۱۵۵۰ خط) | اجرای bar-by-bar، عملگر `[]` به گذشته، توابع کاربر بدون recursion (قانون خود Pine)، درج‌به‌درج visual output |
| `errors.js` | خطاها با کد رسمی‌سبک `CE…/RE…` + خط/ستون |
| `compile.js` | نقطهٔ ورود: `source → { ok, errors[], meta{title,overlay}, createInstance(env) → runtime, collectInputs() }` |
| `stdlib/ta.js` (~۷۰۰ خط) | `ta.*` — **kernels ریاضی (sma/ema/wma/stdev/rsi/trueRange/atr) از `core/indicators.js` به اینجا REFACTOR شدند و `indicators.js` از همین‌جا import می‌کند — یک منبع حقیقت**؛ به‌علاوه rma/vwma/macd/supertrend/pivothigh/pivotlow/crossover/crossunder/change/highest/lowest/valuewhen/barssince/roc و… |
| `stdlib/math.js` | `math.*` کامل برای اسکریپت‌های واقعی |
| `stdlib/time.js` | `timestamp()` با همهٔ overloadها (با/بدون timezone، با/بدون ثانیه)، `year/month/dayofmonth/dayofweek/hour/minute` با آرگومان timezone، `timenow` |
| `stdlib/color.js` | `color.new/rgb` + رنگ‌های نام‌دار |
| `stdlib/array.js` | `array.new<T>(size[, default])`/`from/get/set/size/push/pop` — آرایه‌های تایپ‌شدهٔ ماندگار (`var box[]`) که 786 Zones به آن وابسته است |
| `stdlib/objects.js` | `line.*`/`box.*`/`label.*` با مدل «ساخت یک‌بار + آپدیت درجا با set_*» (set_xy1/set_xy2/set_lefttop/set_rightbottom/set_bgcolor/set_text/…) — دقیقاً همان الگوی 786 Zones؛ اشیاء در store تایپ‌دار runtime زندگی می‌کنند |
| `stdlib/inputs.js` | `input.int/float/bool/string/color/source` (با options/minval/maxval) → تولید خودکار تعریف فرم Inputs |
| `stdlib/request.js` | `request.security_lower_tf(syminfo.tickerid, "1", expr)` از دیتای M1 موجود در feed (resample محلی، آفلاین)؛ `request.security` فعلاً با خطای صریح «پشتیبانی‌نشده» رد می‌شود — شکست خاموش ممنوع |

### ۱-۲. انضباط اجرای افزایشی (هم‌کلاس راندهای ۷۰-۷۲)

- اجرای کامل فقط یک‌بار روی تاریخچهٔ لودشده (`runChunked` تکه‌تکه و yield به event loop — چارت هرگز بلاک نمی‌شود).
- تیک بعدی: `updateForming` (rollback بارِ در حال شکل‌گیری + اجرای مجدد فقط همان بار) و `pushNewBar` برای بار تأییدشده جدید. هرگز اجرای مجدد کل تاریخچه در هر تیک.
- شکاف چندباره‌ای (لود تاریخچهٔ عمیق‌تر): یک پاس کامل صادقانه + بازخورانِ سری.

### ۱-۳. لایهٔ نمایش — `pine-render-adapter.js` (۵۷۰ خط)

| Pine | مقصد رندر |
|---|---|
| `plot()` | LWC Line/Histogram series — overlay روی مقیاس قیمت، غیر-overlay در زیرپن اختصاصی |
| `plotshape/plotchar/plotarrow` | کانavas پاین (مجموعهٔ کامل شکل‌ها: triangleup/down/left/right، circle، square، diamond، cross/xcross، flag، arrow*، labelup/down) |
| `bgcolor()` | کانواسِ زیر چارت (پوستهٔ شفاف LWC آن را نشان می‌دهد) |
| `barcolor()` | بازرنگ‌آمیزی بدنه/فیتیلهٔ کندل‌های اصلی (حتی از اسکریپت غیر-overlay — مثل TV) |
| `fill()` | چندضلعی کانواس بین دو plot |
| `hline()` | price line روی سریِ پنِ اسکریپت |
| `line.new/box.new/label.new` | کانواس fg؛ اشیاء script-owned بدون هندل/انتخاب (منبع داده اسکریپت است نه ماوس؛ موتور رسم دستی دست‌نخورده) |

- مختصات Pine بر حسب **میلی‌ثانیه** (`xloc.bar_time`)؛ مهر چارت ثانیه — آداپتور تبدیل می‌کند.
- رندر هر فریم از روی state با culling دید — pan/zoom هرگز پیکسل کهنه نمی‌گذارد.

### ۱-۴. زیرپنِ واقعی برای `overlay=false` (پاریتی راند ۳۲)

اسکریپت غیر-overlay (مثل RSI) یک **زیرپن واقعی** می‌گیرد: چارت LWC مستقل با مقیاس قیمت و برچسب محور خودش، لجند داخل هدرِ همان پن، ثبت در همان `pane._subs` و چینش با همان `Manager.layoutSubPanes` — نه سری له‌شده روی مقیاس قیمت. ارتفاع پن با اسپلیتر درگ قابل تغییر است و سهم (`frac`) آن در لایوت ذخیره/بازیابی می‌شود (`computeSubHeights` و `startSubPaneDrag` حالا `pane.pineScripts` را هم می‌بینند). provider زومِ دستیِ قیمت فقط به اسکریپت‌های overlay وصل است تا اسیلاتور مقیاس خودش را از دست ندهد.

### ۱-۵. پنل Pine Editor — `panels/pine-editor.js` (صفر وابستگی، بدون Monaco/CodeMirror)

- ادیتور: `<textarea>` زیر `<pre>` هایلایت‌شده (کلیدواژه/namespace/رشته/کامنت/عدد/رنگ hex)، شماره‌خط (gutter)، Enter با تورفتگی Pine (کپی تورفتگی خط قبل + ۴ فاصله بعد از `=>`/بلوک)، Tab→۴ فاصله، `Ctrl+S` ذخیره، `Ctrl+Enter` Add to Chart؛ `stopPropagation` روی keydown تا شورتکات‌های سراسری اپ داخل ادیتور آتش نزنند.
- ارتفاع پنل درگ‌پذیر و ماندگار؛ پنل بین `#main` و `#bottom-toolbar` می‌نشیند (لایهٔ پایینی TV-استایل).
- کنسول خطا: `CE…/RE…` با شمارهٔ خط؛ وضعیت سبز `✓ title — overlay/pane, N inputs` پس از کامپایل موفق.
- مدیریت اسکریپت: New/Rename/Save/Delete + **Import/Export فایل `.pine`** + ذخیره‌سازی نامحدود از مسیر مجاز (`localStorage` از طریق `U.lsGet/lsSet` — سیم پلتفرم-اگنوستیک قانون «صفر window در core» حفظ شد) + ۴ تمپلیت آماده (EMA/RSI/MACD/Bollinger+fill) که در اولین اجرا seed می‌شوند.
- دکمهٔ نوار بالایی `#pine-btn` (آیکون آکولاد سبک رسمی) در `toolbar.js` — فقط یک‌جا wire شده (مالکیت یکتای toggle).
- دیالوگ Inputs از `input.*()` اسکریپت ساخته می‌شود (هم‌خانوادهٔ دیالوگ اندیکاتورهای built-in) و تغییر مقادیر، runtime را با همان instance بازسازی می‌کند.

### ۱-۶. چرخهٔ عمر instance و ماندگاری

- `PineUI.add(pane, scriptId, inputs)` → instance `{id, scriptId, inputs, visible}` در `pane.pineScripts` → `Manager.persistPanes` آن را با لایوت ذخیره می‌کند (`pineScripts`) و بعد از ری‌استارت/تعویض نماد/لایوت، `restorePine` بازمی‌سازد.
- کامپایل کش می‌شود (`scriptId:updatedAt`)؛ Save در ادیتور، instanceهای همان اسکریپت را زنده بازمحاسبه می‌کند.
- حذف اسکریپت از store، instanceهای روی چارت را بی‌کد نمی‌کند (اخطار در confirm حذف).
- `alertcondition()/alert()` در interpreter ثبت‌اند (منبع چهارم شرط برای فاز ۷؛ سیم نهایی به پنل Alerts در راند بعد).

## ۲. باگ‌های پیدا‌شده و رفع‌شده در همین راند

1. **سری‌های خالی تا ابد (BUG-74-A):** در `attach()` هنوز runtime اجرا نشده و `out.plotsOrder` خالی است؛ سری/`hline`ای که آن لحظه ساخته می‌شود هیچ بود — چارت برای هر اسکریپتی خالی می‌ماند. رفع: `syncStructure()` بعد از اولین پاس کامل ساختار را با خروجی نهایی می‌سازد (idempotent) و سپس `refillAll` بازخوران می‌کند.
2. **دریفت محدودهٔ زیرپن (BUG-74-B):** محدودهٔ اولیهٔ زیرپن قبل از وجود دیتا ست می‌شد و اولین `setData` آن را auto-fit می‌کرد؛ رفع: اعمال مجدد محدودهٔ مرئیِ چارت اصلی بعد از تغذیهٔ دیتا (زیرپن range-slave است؛ اشتراک محدودهٔ اصلی ادامه‌اش می‌دهد).
3. **دم سالمِ خط بعد از شکاف چندباره‌ای (BUG-74-C):** در مسیر تیک، شاخهٔ `runAll` (شکاف چندباره‌ای) سری را بازخوران نمی‌کرد و دمِ خط نسبت به محور زمان عقب می‌ماند؛ رفع: پس از `runAll`، `syncStructure+refillAll`.

## ۳. تست

- `scripts/verify_pine74.mjs` — **۴۷ چک، همه سبز**:
  - پارس ۴ فیکسچر واقعی (`rsi/macd/bollinger/session-box/786-zones`) + خطای سینتکس → کد CE؛
  - پاریتی عددی بار‌به‌بار `ta.sma/ema/rsi/wma/sd/atr` با kernelهای `core/indicators.js` (خطا ≤ 1.8e-15)؛
  - اجرای افزایشی: `updateForming` خروجی را رشد نمی‌دهد/تاریخچهٔ تأییدشده ثابت می‌ماند/بارِ در حال شکل‌گیری واکنش نشان می‌دهد/`pushNewBar` دقیقاً یک مقدار اضافه می‌کند؛
  - **e2e موتوریِ 786 Zones** (۵۷۶ بار M15 + اینتربار M1): اجرای کامل < ۲.۵s، ۶ باکس سشن + ۶ لیبل، `xloc.bar_time`، مهر epoch-ms، شفافیت رنگ سشن، حالت Extend، ثبات تعداد اشیاء روی تیک‌ها، یکسانی هندسه پس از rollback، بقای identity شیء پس از بار جدید، بازاجرای موفق با override ورودی‌های کاربر؛
  - سطح خطا: `request.security` فریاد می‌زند (نه شکست خاموش)، `strategy.*` در کامپایل tolerated.
- e2e هدلس مرورگر (Playwright/Chromium روی پرووایدر دمو): بوت بدون خطا → باز شدن پنل از دکمهٔ نوار بالا → نمونهٔ seed شده کامپایل سبز → نمایش کد خطای CE در کنسول ادیتور → Add to chart → ردیف لجند → **زیرپن واقعی با کانواس و لجند درون-پنی** → ماندگاری instance پس از reload → صفر خطای صفحه در کل سشن.
- پذیرش نهایی نقشه‌راه: **786 Zones v5.5 واقعی روی چارت زندهٔ اپ** (import از فایل `.pine` کاربر، اجرای chunked روی ~۵۰۰۰ بار، رسم باکس/لیبل سشن) — اسکرین‌شات تأیید بصری ثبت شد.
- رگرسیون: هیچ چک قبلی شکسته نشد؛ آدیت diff پایین.

## ۴. آدیت diff

- **جدید:** `src/core/pine/` (۱۵ فایل)، `chart/pine-ui.js`، `chart/pine-render-adapter.js`، `panels/pine-editor.js`، `panels/pine-scripts-store.js`، `scripts/verify_pine74.mjs`، `scripts/pine-fixtures/*.pine` (۵ فیکسچر)، `docs/PINE-ENGINE-PLAN.md`، `docs/FEATURE-ROUND74.md`
- **تغییر:** `core/indicators.js` (فقط refactor: kernels از `pine/stdlib/ta.js` import می‌شوند — ریاضی دست‌نخورده)، `chart/manager.js` ( delegation pine: recompute/tick/frame/serialize/restore/drop + frac برای pineScripts + فریم رندر کانواس pine)، `chart/toolbar.js` (دکمهٔ pine-btn)، `ui/icons.js` (آیکون pine)، `app.js` (init/فاساد `__app`)، `index.html` (دکمهٔ نوار بالا)، `css/app.css` (ادیتور/زیرپن pine)
- به‌علاوه: `package.json` (۱.۹.۲۵)، CHANGELOG، README (حذف خط «این بیلد عمداً بدون اندیکاتور/ادیتور Pine است»)
